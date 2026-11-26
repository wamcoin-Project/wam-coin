// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  RandomX engine: cache, dataset, VMs, and seed rotation.
// ===========================================================================
//
//  WAM rotates the RandomX key every 2048 blocks (with a 64-block lag), which
//  on a two-minute target is about every 68 hours. When it rotates, every VM
//  on the network has to be re-keyed, and in full-memory mode the 2 GiB
//  dataset has to be regenerated.
//
//  The engine therefore owns every VM, so that a rotation can stop the world
//  once, re-key everything, and let the workers back in. The alternative --
//  each thread managing its own VM -- means each thread rebuilds its own
//  dataset, which on a 24-core box would need 50 GiB.
//
//  Locking: workers hold a shared lock while hashing; a rotation takes the
//  unique lock. Hashing a batch takes milliseconds, so the rotation is not
//  starved, and no worker can ever hash against a half-initialised dataset.

#pragma once

#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <thread>
#include <vector>

#include "randomx.h"
#include "util.h"

namespace wam {

class RandomXEngine {
public:
    RandomXEngine() = default;

    ~RandomXEngine()
    {
        for (randomx_vm* vm : m_vms) if (vm) randomx_destroy_vm(vm);
        if (m_dataset) randomx_release_dataset(m_dataset);
        if (m_cache)   randomx_release_cache(m_cache);
    }

    RandomXEngine(const RandomXEngine&) = delete;
    RandomXEngine& operator=(const RandomXEngine&) = delete;

    /**
     * Allocate the cache, the dataset (full mode only), and one VM per thread.
     *
     * @param fullMem     2 GiB dataset. Roughly 4x faster, and what any serious
     *                    miner should use; light mode exists for 4 GiB laptops.
     * @param largePages  Ask the kernel for huge pages. Needs configuration on
     *                    most systems, so a failure here is a warning, not a
     *                    fatal error -- we retry without it.
     */
    bool Init(int threads, bool fullMem, bool largePages, std::string& err)
    {
        m_threads = threads;
        m_fullMem = fullMem;

        m_flags = randomx_get_flags();
        if (fullMem) {
            m_flags = static_cast<randomx_flags>(int(m_flags) | int(RANDOMX_FLAG_FULL_MEM));
        }

        if (largePages) {
            const randomx_flags withPages =
                static_cast<randomx_flags>(int(m_flags) | int(RANDOMX_FLAG_LARGE_PAGES));
            m_cache = randomx_alloc_cache(withPages);
            if (m_cache) {
                m_flags = withPages;
                m_largePages = true;
            }
            // Falling through with m_cache == nullptr means large pages were
            // refused; the plain allocation below is the fallback.
        }

        if (!m_cache) {
            m_cache = randomx_alloc_cache(m_flags);
        }
        if (!m_cache) {
            err = "could not allocate the RandomX cache (256 MiB)";
            return false;
        }

        if (fullMem) {
            m_dataset = randomx_alloc_dataset(m_flags);
            if (!m_dataset && m_largePages) {
                // Large pages can satisfy 256 MiB and still fail at 2 GiB.
                m_flags = static_cast<randomx_flags>(int(m_flags) &
                                                     ~int(RANDOMX_FLAG_LARGE_PAGES));
                m_largePages = false;
                m_dataset = randomx_alloc_dataset(m_flags);
            }
            if (!m_dataset) {
                err = "could not allocate the 2 GiB RandomX dataset. "
                      "Re-run with --light to use 256 MiB instead.";
                return false;
            }
        }

        return true;
    }

    /** Human-readable summary of what the CPU actually gave us. */
    std::string Describe() const
    {
        std::string s = m_fullMem ? "full memory (2 GiB dataset)" : "light (256 MiB cache)";
        if (int(m_flags) & int(RANDOMX_FLAG_JIT))         s += ", JIT";
        if (int(m_flags) & int(RANDOMX_FLAG_HARD_AES))    s += ", hardware AES";
        if (int(m_flags) & int(RANDOMX_FLAG_ARGON2_AVX2)) s += ", Argon2/AVX2";
        else if (int(m_flags) & int(RANDOMX_FLAG_ARGON2_SSSE3)) s += ", Argon2/SSSE3";
        if (m_largePages) s += ", large pages";
        return s;
    }

    /**
     * Re-key everything to `seed`, rebuilding the dataset if needed.
     *
     * Idempotent: calling it with the seed already in use returns immediately,
     * which is what makes it safe to call on every job.
     */
    bool SetSeed(const Bytes& seed, std::string& err)
    {
        if (seed.empty()) {
            err = "the pool sent an empty RandomX seed";
            return false;
        }

        {
            std::shared_lock<std::shared_mutex> read(m_mutex);
            if (m_seed == seed) return true;
        }

        // Announce the write BEFORE asking for the lock. A shared_mutex does
        // not promise writer priority, and hashing threads re-acquire their
        // shared lock the instant they release it -- so without this the
        // re-key waits forever while the workers keep hashing against a key
        // the network has already left behind. Every share they submit from
        // that point on is invalid, and nothing in the miner would say so.
        WriterGate gate(m_writerWaiting);
        std::unique_lock<std::shared_mutex> write(m_mutex);
        if (m_seed == seed) return true;         // another thread won the race

        const int64_t started = NowMs();
        const bool    firstTime = m_seed.empty();

        randomx_init_cache(m_cache, seed.data(), seed.size());

        if (m_dataset) {
            InitDatasetParallel();
        }

        // Existing VMs point at the old key material; re-point them.
        for (randomx_vm* vm : m_vms) {
            if (!vm) continue;
            randomx_vm_set_cache(vm, m_cache);
            if (m_dataset) randomx_vm_set_dataset(vm, m_dataset);
        }

        m_seed = seed;
        m_generation++;
        m_lastRekeyMs = NowMs() - started;
        if (!firstTime) m_rotations++;

        (void)err;
        return true;
    }

    /**
     * Create every worker's VM in one pass.
     *
     * Called once, from the thread that set the first seed, before any worker
     * starts hashing. Doing it per-worker instead looks tidier and is a trap:
     * each call needs the exclusive lock, and by the time the third worker
     * asks for it the first two are already hashing in a tight
     * acquire-release loop on the shared lock. The remaining workers wait for
     * a lock they will never be handed. Measured on a 20-thread run: two
     * threads hashing, eighteen asleep, 16% of the machine's throughput, and
     * no error anywhere -- just a miner that is quietly four times slower than
     * the same binary in --benchmark.
     */
    bool CreateVms(int count, std::string& err)
    {
        WriterGate gate(m_writerWaiting);
        std::unique_lock<std::shared_mutex> write(m_mutex);

        if (m_seed.empty()) {
            err = "internal error: VMs were requested before the seed was set";
            return false;
        }

        for (int i = 0; i < count; i++) {
            randomx_vm* vm = randomx_create_vm(m_flags, m_cache, m_dataset);
            if (!vm && m_largePages) {
                m_flags = static_cast<randomx_flags>(int(m_flags) &
                                                     ~int(RANDOMX_FLAG_LARGE_PAGES));
                m_largePages = false;
                vm = randomx_create_vm(m_flags, m_cache, m_dataset);
            }
            if (!vm) {
                err = "randomx_create_vm failed after " + std::to_string(i) +
                      " VMs (out of memory?)";
                return false;
            }
            m_vms.push_back(vm);
        }

        m_vmsReady.store(true);
        return true;
    }

    bool        VmsReady() const { return m_vmsReady.load(); }
    randomx_vm* Vm(size_t index) const
    {
        // Safe without the lock: the vector is filled once, before any worker
        // runs, and never resized again. SetSeed only re-points the VMs, and
        // it does that while every worker is outside its shared lock.
        return index < m_vms.size() ? m_vms[index] : nullptr;
    }

    /** True while a re-key is waiting to get in; workers must stand aside. */
    bool WriterWaiting() const { return m_writerWaiting.load(std::memory_order_acquire); }

    /** RAII guard a worker holds while hashing, blocking any re-key. */
    class HashLock {
    public:
        explicit HashLock(RandomXEngine& e)
        {
            // Yield to a pending re-key before taking the lock, not after.
            while (e.m_writerWaiting.load(std::memory_order_acquire)) {
                std::this_thread::sleep_for(std::chrono::microseconds(200));
            }
            m_lock = std::shared_lock<std::shared_mutex>(e.m_mutex);
            m_gen  = e.m_generation.load();
        }
        uint64_t Generation() const { return m_gen; }
    private:
        std::shared_lock<std::shared_mutex> m_lock;
        uint64_t m_gen = 0;
    };

    /** False until the first job has told us which key to use. */
    bool HasSeed() const
    {
        std::shared_lock<std::shared_mutex> read(m_mutex);
        return !m_seed.empty();
    }

    uint64_t Generation()   const { return m_generation.load(); }
    uint64_t Rotations()    const { return m_rotations.load(); }
    int64_t  LastRekeyMs()  const { return m_lastRekeyMs.load(); }
    Bytes    CurrentSeed()  const
    {
        std::shared_lock<std::shared_mutex> read(m_mutex);
        return m_seed;
    }

private:
    /**
     * Fill the dataset across every core.
     *
     * Single-threaded this takes well over a minute; on a modern desktop with
     * all cores it is a few seconds. Miners hit this on every key rotation, so
     * it is worth the extra dozen lines.
     */
    void InitDatasetParallel()
    {
        const unsigned long itemCount = randomx_dataset_item_count();
        const int workers = std::max(1, m_threads);

        std::vector<std::thread> pool;
        pool.reserve(workers);

        const unsigned long perThread = itemCount / static_cast<unsigned long>(workers);
        unsigned long start = 0;

        for (int i = 0; i < workers; i++) {
            const unsigned long count = (i == workers - 1) ? (itemCount - start) : perThread;
            pool.emplace_back([this, start, count]() {
                randomx_init_dataset(m_dataset, m_cache, start, count);
            });
            start += count;
        }

        for (std::thread& t : pool) t.join();
    }

    mutable std::shared_mutex m_mutex;

    randomx_flags   m_flags   = RANDOMX_FLAG_DEFAULT;
    randomx_cache*  m_cache   = nullptr;
    randomx_dataset* m_dataset = nullptr;
    std::vector<randomx_vm*> m_vms;

    Bytes m_seed;
    int   m_threads    = 1;
    bool  m_fullMem    = false;
    bool  m_largePages = false;

    std::atomic<uint64_t> m_generation{0};
    std::atomic<uint64_t> m_rotations{0};
    std::atomic<int64_t>  m_lastRekeyMs{0};
    std::atomic<bool>     m_vmsReady{false};

    /** Raised while a thread wants the exclusive lock; readers stand aside. */
    std::atomic<bool>     m_writerWaiting{false};

    struct WriterGate {
        explicit WriterGate(std::atomic<bool>& f) : flag(f) { flag.store(true, std::memory_order_release); }
        ~WriterGate() { flag.store(false, std::memory_order_release); }
        std::atomic<bool>& flag;
    };
};

} // namespace wam
