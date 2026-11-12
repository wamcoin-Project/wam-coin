// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.

#include <wam/crypto/randomx_hash.h>

#include <chain.h>
#include <consensus/params.h>
#include <hash.h>
#include <logging.h>
#include <primitives/block.h>
#include <streams.h>
#include <sync.h>
#include <wam/wam-params.h>

#include <randomx.h>

#include <cstring>
#include <list>
#include <memory>
#include <stdexcept>

namespace wam {

namespace {

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
//
// RANDOMX_FLAG_JIT and RANDOMX_FLAG_HARD_AES are detected at runtime; on a CPU
// without AES-NI or with W^X restrictions RandomX transparently falls back to
// its portable interpreter. The *result* is identical either way -- only the
// speed changes -- so flag differences between nodes can never cause a
// consensus split.

randomx_flags GetVerifyFlags()
{
    // Runtime CPU feature detection. randomx_flags is a C enum, so clearing a
    // bit needs an explicit cast -- librandomx only overloads | and &, not ~.
    const randomx_flags flags = randomx_get_flags();
    return static_cast<randomx_flags>(static_cast<int>(flags) &
                                      ~static_cast<int>(RANDOMX_FLAG_FULL_MEM));
}

// There is no GetMiningFlags() here any more, and no full-dataset path below
// it. See the note in randomx_hash.h: the switch that reached them was
// `-randomxmining`, which is not an option this node has, so the ~2 GiB
// dataset, its parallel initialisation and the mode flag that selected them
// were unreachable from the first commit. A node verifies; wam-miner mines,
// in its own process, with its own RandomX.

// ---------------------------------------------------------------------------
// One initialised RandomX context for a single seed
// ---------------------------------------------------------------------------

struct RandomXContext {
    uint256 seed;
    randomx_cache* cache{nullptr};
    randomx_vm* vm{nullptr};

    explicit RandomXContext(const uint256& seedIn) : seed(seedIn)
    {
        const randomx_flags flags = GetVerifyFlags();

        cache = randomx_alloc_cache(flags);
        if (cache == nullptr) {
            throw std::runtime_error("randomx_alloc_cache failed (out of memory?)");
        }
        randomx_init_cache(cache, seed.begin(), seed.size());

        vm = randomx_create_vm(flags, cache, /*dataset=*/nullptr);
        if (vm == nullptr) {
            randomx_release_cache(cache);
            throw std::runtime_error("randomx_create_vm failed");
        }
    }

    ~RandomXContext()
    {
        if (vm) randomx_destroy_vm(vm);
        if (cache) randomx_release_cache(cache);
    }

    RandomXContext(const RandomXContext&) = delete;
    RandomXContext& operator=(const RandomXContext&) = delete;

    /** Approximate resident bytes, for the `getrandomxinfo` RPC only. */
    size_t MemoryUsage() const
    {
        // One number, because there is one kind of context. This used to add
        // the dataset's size when one was held, and no context ever held
        // one.
        // librandomx's public header exposes only RANDOMX_HASH_SIZE,
        // RANDOMX_DATASET_ITEM_SIZE and randomx_dataset_item_count(). The cache
        // size (RANDOMX_ARGON_MEMORY, 262144 KiB) lives in the library's
        // internal configuration.h and is deliberately not part of the ABI, so
        // it is written out here as a documented constant rather than queried.
        //
        // This figure is reported to operators sizing a machine. Nothing in
        // consensus reads it, so an approximation is acceptable where a wrong
        // #include would not be.
        static constexpr size_t RANDOMX_CACHE_BYTES = 256u * 1024u * 1024u;

        return RANDOMX_CACHE_BYTES;
    }
};

// ---------------------------------------------------------------------------
// Bounded LRU of contexts
// ---------------------------------------------------------------------------
//
// Two entries is the correct size, not a tuning knob: around an epoch boundary
// a node validates blocks from the new epoch while still receiving stragglers
// and reorg candidates from the old one. Holding exactly those two seeds keeps
// steady-state memory bounded while never thrashing.

constexpr size_t MAX_CACHED_CONTEXTS = 2;

Mutex g_randomx_mutex;
std::list<std::shared_ptr<RandomXContext>> g_contexts GUARDED_BY(g_randomx_mutex);

std::shared_ptr<RandomXContext> GetContext(const uint256& seed) EXCLUSIVE_LOCKS_REQUIRED(g_randomx_mutex)
{
    for (auto it = g_contexts.begin(); it != g_contexts.end(); ++it) {
        if ((*it)->seed == seed) {
            // Promote to front (most-recently-used).
            auto ctx = *it;
            g_contexts.erase(it);
            g_contexts.push_front(ctx);
            return ctx;
        }
    }

    LogPrintf("RandomX: initialising verification context for seed %s\n",
              seed.ToString());

    auto ctx = std::make_shared<RandomXContext>(seed);
    g_contexts.push_front(ctx);

    while (g_contexts.size() > MAX_CACHED_CONTEXTS) {
        g_contexts.pop_back();
    }
    return ctx;
}

} // namespace

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

int GetRandomXSeedHeight(int nHeight, const Consensus::Params& params)
{
    // From consensus, not from wam-params.h. chainparams.cpp deliberately sets
    // a shorter epoch on the test networks -- 256/16 on testnet, 64/4 on
    // regtest -- so that a key rotation, the most disruptive scheduled event
    // this chain has, can be reached in minutes instead of days.
    //
    // Reading the mainnet constants here threw that away. Mainnet behaved
    // correctly by coincidence, since its parameters are the constants; the
    // test networks silently used 2048/64, and getrandomxinfo reported an
    // epoch length the node did not use. Exercising a rotation on regtest cost
    // 2,112 blocks instead of the 68 the parameters promised.
    const int nEpoch = params.nRandomXEpochBlocks;
    const int nLag   = params.nRandomXEpochLag;

    // A chain configured with nonsense must stop, not quietly pick another
    // rule. These come from chainparams and can only be wrong at compile time.
    assert(nEpoch > 0 && nLag >= 0 && nLag < nEpoch);

    // Everything inside the first epoch (plus the lag) is seeded by genesis.
    if (nHeight <= nLag) return 0;

    const int nLagged = nHeight - nLag;
    return (nLagged / nEpoch) * nEpoch;
}

uint256 GetRandomXBootstrapSeed()
{
    // Computed once; SHA256 of a compile-time constant cannot change.
    static const uint256 seed = [] {
        HashWriter h{};
        h.write(std::as_bytes(std::span{WAM_RANDOMX_BOOTSTRAP_KEY,
                                        std::strlen(WAM_RANDOMX_BOOTSTRAP_KEY)}));
        return h.GetSHA256();
    }();
    return seed;
}

uint256 GetRandomXSeedHash(const CBlockIndex* pindexPrev, const Consensus::Params& params)
{
    // The block being built sits one above pindexPrev.
    const int nHeight = (pindexPrev == nullptr) ? 0 : pindexPrev->nHeight + 1;
    const int nSeedHeight = GetRandomXSeedHeight(nHeight, params);

    // Bootstrap epoch: no block is buried deeply enough to be a safe seed yet.
    if (pindexPrev == nullptr || nSeedHeight == 0) {
        return GetRandomXBootstrapSeed();
    }

    const CBlockIndex* pindexSeed = pindexPrev->GetAncestor(nSeedHeight);
    if (pindexSeed == nullptr) {
        // Only reachable if the caller handed us an index detached from the
        // active chain. Falling back to the bootstrap seed keeps the function
        // total, and the block will simply fail its PoW check.
        return GetRandomXBootstrapSeed();
    }

    return pindexSeed->GetBlockHash();
}

uint256 GetRandomXHashRaw(const unsigned char* input, size_t len, const uint256& seed)
{
    uint256 result;

    LOCK(g_randomx_mutex);
    auto ctx = GetContext(seed);

    // randomx_calculate_hash writes exactly RANDOMX_HASH_SIZE (32) bytes.
    static_assert(RANDOMX_HASH_SIZE == 32, "WAM assumes a 256-bit RandomX output");
    randomx_calculate_hash(ctx->vm, input, len, result.begin());

    return result;
}

uint256 GetRandomXPoWHash(const CBlockHeader& header, const uint256& seed)
{
    DataStream ss{};
    ss << header;

    // A Bitcoin-shaped header is exactly 80 bytes: version, prev, merkle,
    // time, bits, nonce. If a future soft fork widens it, RandomX still hashes
    // whatever is serialized -- but the pool's stratum layer assumes 80, so we
    // assert rather than let the two drift apart silently.
    assert(ss.size() == RANDOMX_INPUT_SIZE);

    return GetRandomXHashRaw(reinterpret_cast<const unsigned char*>(ss.data()),
                             ss.size(), seed);
}

size_t GetRandomXMemoryUsage()
{
    LOCK(g_randomx_mutex);
    size_t total = 0;
    for (const auto& ctx : g_contexts) total += ctx->MemoryUsage();
    return total;
}

} // namespace wam
