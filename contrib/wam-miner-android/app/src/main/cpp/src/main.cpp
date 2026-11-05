// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  wam-miner -- the reference CPU miner for WAM Coin
// ===========================================================================
//
//      wam-miner -o stratum+tcp://pool.wamcoin.org:3333 -u <your WAM address>
//
//  WHY THIS EXISTS
//  ---------------
//  WAM's proof of work is RandomX over a Bitcoin-style 80-byte header. That
//  combination is deliberate -- RandomX for CPU fairness, Bitcoin's header so
//  the chain inherits twenty years of reviewed consensus code -- but it means
//  no existing miner speaks it. xmrig hashes Monero's blob layout; cpuminer
//  hashes SHA-256. Without this binary, WAM would be a chain nobody could mine.
//
//  It is intentionally small and dependency-free: a stranger should be able to
//  read all of it in an afternoon and build it with one g++ invocation. A
//  miner asks people to run unknown code on their own hardware, and the only
//  honest answer to "why should I trust it" is "here is all of it".
//
//  WHAT IT DOES NOT DO
//  -------------------
//  No GPU, no CUDA, no OpenCL. RandomX is designed to be poor on GPUs; adding
//  half-speed GPU support would only invite people to waste electricity.
//  No developer fee: this binary mines to the address you pass and to nothing
//  else. WAM's 5% treasury is a consensus rule paid by the coinbase itself,
//  visible in every block, and is not something a miner needs to cooperate in.

#include <atomic>
#include <cinttypes>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <ctime>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "json.h"
#include "platform.h"
#include "randomx_engine.h"
#include "sha256.h"
#include "solo.h"
#include "stratum.h"
#include "util.h"

namespace wam {

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

namespace {

bool g_colour = true;

const char* C(const char* code) { return g_colour ? code : ""; }

#define CLR_RESET  C("\033[0m")
#define CLR_DIM    C("\033[90m")
#define CLR_GREEN  C("\033[32m")
#define CLR_YELLOW C("\033[33m")
#define CLR_RED    C("\033[31m")
#define CLR_CYAN   C("\033[36m")
#define CLR_BOLD   C("\033[1m")

std::mutex g_printMutex;

void LogLine(const char* colour, const char* tag, const std::string& msg)
{
    const std::time_t now = std::time(nullptr);
    std::tm tm{};
    LocalTime(now, tm);

    char stamp[16];
    std::strftime(stamp, sizeof(stamp), "%H:%M:%S", &tm);

    std::lock_guard<std::mutex> lock(g_printMutex);
    std::printf("%s%s%s %s%-8s%s %s\n",
                CLR_DIM, stamp, CLR_RESET, colour, tag, CLR_RESET, msg.c_str());
    std::fflush(stdout);
}

void Info(const std::string& m)  { LogLine(CLR_CYAN,   "miner",  m); }
void Good(const std::string& m)  { LogLine(CLR_GREEN,  "accept", m); }
void Warn(const std::string& m)  { LogLine(CLR_YELLOW, "warn",   m); }
void Fail(const std::string& m)  { LogLine(CLR_RED,    "error",  m); }
void Job(const std::string& m)   { LogLine(CLR_BOLD,   "job",    m); }

} // namespace

// ---------------------------------------------------------------------------
// Shared state between the I/O thread and the workers
// ---------------------------------------------------------------------------

struct SharedState {
    std::mutex  jobMutex;
    StratumJob  job;
    std::atomic<uint64_t> jobEpoch{0};       // bumped on every new job
    // Set once a job yields a block, which idles the workers until the next
    // job arrives. Zero means "nothing solved": job epochs start at 1, so the
    // value is free to carry that meaning, and a rejected block restores it
    // rather than leaving every worker asleep on a chain that never moved.
    std::atomic<uint64_t> solvedEpoch{0};
    std::atomic<uint64_t> difficultyBits{0}; // double, bit-cast, for lock-free reads

    std::atomic<bool>     running{true};
    std::atomic<bool>     connected{false};

    std::atomic<uint64_t> hashes{0};
    std::atomic<uint64_t> submitted{0};
    std::atomic<uint64_t> accepted{0};
    std::atomic<uint64_t> rejected{0};
    std::atomic<uint64_t> blocksFound{0};

    // A BLOCK THAT LOST A RACE IS NOT A BLOCK THAT WENT MISSING.
    //
    // Two miners solving the same height within seconds of each other is not
    // a fault in anything; it is what proof of work is. One chain wins and
    // the other block is a side branch. Every solo miner with real hash rate
    // meets it, and at 7% of a network with two-minute blocks, often.
    //
    // It was counted as `rejected`, which fed the alarm below, which told the
    // operator in as many words not to leave the miner running. On 2026-10-03
    // a solo miner running 6 kH/s did exactly that: lost a race, read the
    // alarm repeating every thirty seconds, and shut down a miner that was
    // working perfectly. He was following our instruction. The instruction
    // was wrong.
    std::atomic<uint64_t> stale{0};

    // A BLOCK THE NODE REFUSED AND A BLOCK WE NEVER MANAGED TO SEND ARE NOT
    // THE SAME EVENT, AND WERE COUNTED AS ONE.
    //
    // `rejected` means the node looked at a block and said no -- a reason
    // exists, in its words, and the bytes are written to a file. Failing to
    // build or deliver the block at all was folded into the same counter,
    // with no file and no bytes, so the one case where the evidence is most
    // needed was the one case that produced none.
    //
    // On 2026-09-26 a solo miner solved a real block and this code could not
    // send it. The line he saw said "could not submit the block"; the tally
    // underneath said `rejected`, which is the node's word for something it
    // never saw. Counted apart now, and loud at the end of the run, because a
    // lost block is the only outcome here that costs somebody money.
    std::atomic<uint64_t> lost{0};

    // WHERE A SOLUTION GOES, decided once at startup.
    //
    // A worker that has found something must not know whether this miner is
    // talking to a pool or to a node: those are two destinations for one
    // result, not two kinds of mining. Setting it here keeps the hot loop
    // identical on both paths -- the loop that has produced every share since
    // August is not the place to put a branch.
    /**
     * Called with a solution. `hashedHeader` is the exact eighty bytes that
     * were hashed -- handed over rather than described, so whatever sends the
     * block can prove the bytes it is about to send are the bytes that won.
     *
     * Returns whether this job is finished with. A pool always is: the share
     * is gone and the pool decides what happens next. Alone it is not, if the
     * node refused the block -- the chain did not move, no new job is coming,
     * and the tip is still there to be won.
     */
    std::function<bool(const StratumJob&, const Bytes& extranonce2,
                       uint32_t nonce, bool isBlock,
                       const uint8_t hashedHeader[80])> onSolution;

    void SetDifficulty(double d)
    {
        uint64_t bits;
        std::memcpy(&bits, &d, sizeof(bits));
        difficultyBits.store(bits);
    }

    double GetDifficulty() const
    {
        const uint64_t bits = difficultyBits.load();
        double d;
        std::memcpy(&d, &bits, sizeof(d));
        return d > 0 ? d : 1.0;
    }
};

// ---------------------------------------------------------------------------
// Header assembly
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

void WorkerLoop(int workerId, RandomXEngine& engine, SharedState& state)
{
    // Each worker owns a distinct extranonce2, which gives it a completely
    // separate coinbase and therefore a separate search space. Without this,
    // every thread would hash the same header and find the same shares.
    // A VM cannot exist before the key does, and the key arrives with the
    // first job -- which is not the first message the pool sends. The I/O
    // thread builds every VM in one pass once the key is known; workers just
    // wait for theirs. See RandomXEngine::CreateVms for why they must not
    // build their own.
    while (state.running.load() && !engine.VmsReady()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!state.running.load()) return;

    randomx_vm* vm = engine.Vm(size_t(workerId));
    if (!vm) {
        Fail("worker " + std::to_string(workerId) + " was not given a VM");
        state.running.store(false);
        return;
    }

    std::mt19937 rng(uint32_t(NowMs()) ^ uint32_t(workerId * 2654435761u));

    uint64_t seenEpoch = 0;
    StratumJob job;
    uint8_t   header[80];
    // Hoisted to live as long as `job` and `header` do: a solution is
    // submitted from the hashing loop below, and the block a solo miner
    // builds needs the exact extranonce these eighty bytes were built from.
    Bytes     en2;
    Target    shareTarget{};
    Target    blockTarget{};
    uint32_t  nonce = 0;
    bool      haveWork = false;

    const int kBatch = 64;                      // hashes per shared-lock hold

    while (state.running.load()) {
        const uint64_t epoch = state.jobEpoch.load();

        if (epoch != seenEpoch) {
            {
                std::lock_guard<std::mutex> lock(state.jobMutex);
                job = state.job;
            }
            seenEpoch = epoch;

            if (!job.valid) { haveWork = false; continue; }

            // extranonce2: worker id in the top bytes so no two threads collide.
            en2.assign(size_t(job.extranonce2Size), 0);
            for (int i = 0; i < job.extranonce2Size && i < 4; i++) {
                en2[size_t(i)] = uint8_t(uint32_t(workerId) >> (8 * (job.extranonce2Size - 1 - i)));
            }
            job.extranonce2Hex = ToHex(en2);

            BuildHeader(job, en2, header);

            shareTarget = DifficultyToTarget(state.GetDifficulty());
            blockTarget = BitsToTarget(job.nbits);
            nonce       = rng();                // avoid repeating work on restart
            haveWork    = true;
        }

        if (!haveWork || state.solvedEpoch.load() == seenEpoch) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            continue;
        }

        // ---- one batch, under a shared lock so a re-key can interrupt us --
        {
            RandomXEngine::HashLock lock(engine);

            WriteLE32(header + 76, nonce);
            randomx_calculate_hash_first(vm, header, 80);

            for (int i = 0; i < kBatch; i++) {
                const uint32_t hashedNonce = nonce;
                nonce++;
                WriteLE32(header + 76, nonce);

                uint8_t out[32];
                randomx_calculate_hash_next(vm, header, 80, out);
                state.hashes.fetch_add(1, std::memory_order_relaxed);

                uint8_t be[32];
                PowHashToBigEndian(out, be);

                // The block target and the share target are independent tests.
                // On a chain whose difficulty is below the pool's share
                // difficulty -- regtest, or a network just after launch -- a
                // hash can solve the block without reaching share difficulty,
                // and dropping it would throw away a real block.
                const bool isBlock = MeetsTarget(be, blockTarget);
                const bool isShare = MeetsTarget(be, shareTarget);

                if (isBlock || isShare) {
                    if (isBlock) {
                        state.blocksFound.fetch_add(1);
                        LogLine(CLR_GREEN, "BLOCK",
                                "worker " + std::to_string(workerId) +
                                " solved height " + std::to_string(job.height) +
                                "! hash " + ToHex(be, 32).substr(0, 24) + "...");
                    }

                    // The header currently holds the NEXT nonce, because the
                    // batch writes it before asking RandomX for the previous
                    // one. These are the bytes that actually produced `out`.
                    uint8_t solved[80];
                    std::memcpy(solved, header, 80);
                    WriteLE32(solved + 76, hashedNonce);

                    // Hash the block's own bytes once more, on their own,
                    // before anyone is told about them.
                    //
                    // The batch above uses RandomX's pipelined interface,
                    // where each call returns the hash of the PREVIOUS input
                    // while starting the next -- so the hash in hand and the
                    // nonce in hand are one step apart by design, and getting
                    // that pairing wrong produces a proof of work for a header
                    // that is never sent. The node then answers "high-hash",
                    // which reads as bad luck rather than as a bug.
                    //
                    // One extra hash per block found costs nothing measurable:
                    // it happens once per block, next to a network round trip.
                    if (isBlock) {
                        uint8_t again[32];
                        randomx_calculate_hash(vm, solved, 80, again);
                        if (std::memcmp(again, out, 32) != 0) {
                            uint8_t againBE[32];
                            PowHashToBigEndian(again, againBE);
                            Fail("the work does not belong to this header. The "
                                 "batch reported " + ToHex(be, 32) +
                                 " but hashing the header on its own gives " +
                                 ToHex(againBE, 32) + ". The block is dropped.");
                            state.solvedEpoch.store(0);
                            break;
                        }
                    }

                    state.submitted.fetch_add(1);
                    const bool done = state.onSolution
                                          ? state.onSolution(job, en2, hashedNonce,
                                                             isBlock, solved)
                                          : true;

                    // Once this job is solved there is nothing left in it worth
                    // finding: any further solution is for a block already
                    // submitted, and any further share is against a template
                    // the pool is about to replace. Idle until the next job --
                    // unless the block was refused, in which case the tip has
                    // not moved and giving up would idle against a block that
                    // is still there to be won.
                    // A found block always ends the batch, whatever the node
                    // said: the verification above uses RandomX's one-shot
                    // interface on this VM, which leaves the pipelined state
                    // started by hash_first behind. The next batch begins with
                    // its own hash_first, so ending here is what keeps the two
                    // interfaces from being mixed on the same VM.
                    if (isBlock) {
                        if (done) state.solvedEpoch.store(seenEpoch);
                        break;
                    }
                }

                // A new job, a sibling thread having already solved this one,
                // or a re-key waiting to get in: all of them make everything
                // after this point wasted work.
                if (state.jobEpoch.load() != seenEpoch ||
                    state.solvedEpoch.load() == seenEpoch ||
                    engine.WriterWaiting() ||
                    !state.running.load()) break;
            }
        }
    }

    // The engine owns every VM and frees them in its destructor, so that a
    // worker exiting mid-rotation cannot free a VM another thread is re-keying.
}

/**
 * Make a job current: re-key RandomX if the seed moved, build the VMs on the
 * first job, publish it, and bump the epoch the workers watch.
 *
 * EXTRACTED FROM client.onJob UNCHANGED, so both sources of work go through
 * one path. Solo mining publishes jobs too, and a second copy of this would
 * be a second place for the re-key to be forgotten -- which would make every
 * hash after a seed rotation invalid, silently, on whichever path was missed.
 *
 * Returns false when the failure is fatal and the miner should stop.
 */
bool PublishJob(RandomXEngine& engine, SharedState& state, int threads,
                const StratumJob& incoming)
{
        // Re-key before publishing: a worker must never hash a job against the
        // previous epoch's key, which would make every share invalid.
        std::string seedErr;
        const Bytes previous = engine.CurrentSeed();
        if (previous != incoming.seed) {
            if (!previous.empty()) {
                Warn("RandomX key rotated; rebuilding. Hashing pauses for a moment.");
            } else {
                Info("preparing RandomX (this takes a few seconds)...");
            }
            const int64_t t0 = NowMs();
            if (!engine.SetSeed(incoming.seed, seedErr)) {
                Fail(seedErr);
                state.running.store(false);
                return false;
            }
            Info("RandomX ready in " + std::to_string((NowMs() - t0) / 1000.0) + "s" +
                 " (key " + ToHex(incoming.seed).substr(0, 16) + "...)");
        }

        // One VM per worker, built here rather than by the workers themselves.
        if (!engine.VmsReady()) {
            std::string vmErr;
            if (!engine.CreateVms(threads, vmErr)) {
                Fail(vmErr);
                state.running.store(false);
                return false;
            }
        }

        {
            std::lock_guard<std::mutex> lock(state.jobMutex);
            state.job = incoming;
        }
        state.jobEpoch.fetch_add(1);

        char line[160];
        std::snprintf(line, sizeof(line), "job %s  height %" PRId64 "  diff %.4g%s",
                      incoming.jobId.c_str(), incoming.height, state.GetDifficulty(),
                      incoming.cleanJobs ? "  (new block)" : "");
        Job(line);
    return true;
}


// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

// WHAT THE NODE'S ANSWER MEANS, AS A FUNCTION, SO IT CAN BE TESTED.
//
// This lived inside the solution lambda, where nothing could reach it. It is
// three string comparisons and it decides whether a solo miner is told his
// block was lost or told to shut down, so it is worth more than three string
// comparisons' worth of care.
//
// Every test this project runs for --solo mines on regtest, alone. A miner
// with no competitor cannot lose a race, so the entire class of "what happens
// when somebody beats you" is unreachable by every gate we have -- which is
// why v0.1.10's bug was found by a miner, v0.1.11's by another miner, and the
// fix for the second was written on 2026-10-04 and shipped to nobody with no
// test of the behaviour it changes.
//
// A regtest race is still the real proof and still needs building. This is the
// half that needs no node at all, and it would have failed on v0.1.11.
enum class SubmitOutcome { Accepted, LostRace, Refused };

SubmitOutcome ClassifySubmit(const std::string& reason)
{
    if (reason.empty()) return SubmitOutcome::Accepted;

    // The node's vocabulary for "somebody reached this height first". The
    // block is valid and stored; it is simply not on the active chain.
    //
    // `duplicate-invalid` is deliberately absent: known AND bad is a real
    // fault and must keep its alarm. It begins with "duplicate", so a prefix
    // match here would have swallowed it -- these are whole-string compares
    // for that reason and not for tidiness.
    if (reason == "duplicate" ||
        reason == "inconclusive" ||
        reason == "duplicate-inconclusive") {
        return SubmitOutcome::LostRace;
    }
    return SubmitOutcome::Refused;
}

bool SelfTest()
{
    bool ok = true;

    auto check = [&ok](const char* what, const std::string& got, const std::string& want) {
        if (got == want) {
            std::printf("  %sok%s    %s\n", CLR_GREEN, CLR_RESET, what);
        } else {
            std::printf("  %sFAIL%s  %s\n        got  %s\n        want %s\n",
                        CLR_RED, CLR_RESET, what, got.c_str(), want.c_str());
            ok = false;
        }
    };

    std::printf("\n%sSHA-256%s\n", CLR_BOLD, CLR_RESET);
    {
        uint8_t out[32];
        SHA256Once(reinterpret_cast<const uint8_t*>(""), 0, out);
        check("empty string",
              ToHex(out, 32),
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

        SHA256Once(reinterpret_cast<const uint8_t*>("abc"), 3, out);
        check("\"abc\"",
              ToHex(out, 32),
              "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

        const char* long_msg =
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
        SHA256Once(reinterpret_cast<const uint8_t*>(long_msg), std::strlen(long_msg), out);
        check("two-block message",
              ToHex(out, 32),
              "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");

        // The genesis block of Bitcoin, hashed the way a header is hashed.
        // If SHA256d and our byte order are right, this comes out exactly.
        Bytes hdr = ParseHexOrEmpty(
            "0100000000000000000000000000000000000000000000000000000000000000"
            "000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa"
            "4b1e5e4a29ab5f49ffff001d1dac2b7c");
        SHA256d(hdr.data(), hdr.size(), out);
        uint8_t be[32];
        PowHashToBigEndian(out, be);
        check("SHA256d of a real 80-byte header",
              ToHex(be, 32),
              "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f");
    }

    std::printf("\n%sByte order%s\n", CLR_BOLD, CLR_RESET);
    {
        // Stratum sends prevhash word-swapped. Feeding it a known display
        // hash and checking we recover the header bytes catches the single
        // most common miner bug there is.
        const std::string display =
            "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
        Bytes d = ParseHexOrEmpty(display);

        // What the pool computes: reverseByteOrder(display bytes).
        Bytes wire(32);
        for (int w = 0; w < 8; w++) {
            for (int b = 0; b < 4; b++) wire[size_t(w * 4 + b)] = d[size_t(w * 4 + 3 - b)];
        }

        uint8_t recovered[32];
        StratumPrevHashToHeader(wire, recovered);

        // The header wants the plain reverse of the display bytes.
        Bytes want(d.rbegin(), d.rend());
        check("stratum prevhash -> header bytes", ToHex(recovered, 32), ToHex(want));
    }

    std::printf("\n%sTargets%s\n", CLR_BOLD, CLR_RESET);
    {
        Target t1 = DifficultyToTarget(1.0);
        check("difficulty 1",
              ToHex(t1.bytes, 32),
              "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

        Target t2 = DifficultyToTarget(2.0);
        check("difficulty 2",
              ToHex(t2.bytes, 32),
              "000000007fffffffffffffffffffffffffffffffffffffffffffffffffffffff");

        Target tb = BitsToTarget(0x1d00ffff);
        check("nBits 0x1d00ffff",
              ToHex(tb.bytes, 32),
              "00000000ffff0000000000000000000000000000000000000000000000000000");

        Target tr = BitsToTarget(0x207fffff);      // regtest
        check("nBits 0x207fffff",
              ToHex(tr.bytes, 32),
              "7fffff0000000000000000000000000000000000000000000000000000000000");
    }

    std::printf("\n%sRandomX%s\n", CLR_BOLD, CLR_RESET);
    {
        randomx_flags flags = randomx_get_flags();
        randomx_cache* cache = randomx_alloc_cache(flags);
        if (!cache) {
            std::printf("  %sFAIL%s  could not allocate the cache\n", CLR_RED, CLR_RESET);
            return false;
        }

        const char* key = "test key 000";
        randomx_init_cache(cache, key, std::strlen(key));

        randomx_vm* vm = randomx_create_vm(flags, cache, nullptr);
        if (!vm) {
            randomx_release_cache(cache);
            std::printf("  %sFAIL%s  could not create a VM\n", CLR_RED, CLR_RESET);
            return false;
        }

        uint8_t out[32];
        const char* input = "This is a test";
        randomx_calculate_hash(vm, input, std::strlen(input), out);
        check("official test vector 1a",
              ToHex(out, 32),
              "639183aae1bf4c9a35884cb46b09cad9175f04efd7684e7262a0ac1c2f0b4e3f");

        const char* input2 = "Lorem ipsum dolor sit amet";
        randomx_calculate_hash(vm, input2, std::strlen(input2), out);
        check("official test vector 1b",
              ToHex(out, 32),
              "300a0adb47603dedb42228ccb2b211104f4da45af709cd7547cd049e9489c969");

        randomx_destroy_vm(vm);
        randomx_release_cache(cache);
    }

    std::printf("\n%sWhat the node's answer means%s\n", CLR_BOLD, CLR_RESET);
    {
        auto name = [](SubmitOutcome o) {
            return o == SubmitOutcome::Accepted ? "accepted"
                 : o == SubmitOutcome::LostRace ? "lost a race" : "refused";
        };
        auto says = [&](const char* what, const char* reason, SubmitOutcome want) {
            check(what, name(ClassifySubmit(reason)), name(want));
        };

        says("an empty reason is acceptance",      "",  SubmitOutcome::Accepted);

        // The three that cost a working miner its operator. Before 2026-10-04
        // each of these counted as a refusal, and one of them left the alarm
        // "that is real money; do not leave it running" repeating every thirty
        // seconds for the life of the process. Two miners were shut down on
        // that advice in one day.
        says("inconclusive is a lost race",        "inconclusive",
             SubmitOutcome::LostRace);
        says("duplicate is a lost race",           "duplicate",
             SubmitOutcome::LostRace);
        says("duplicate-inconclusive is a lost race", "duplicate-inconclusive",
             SubmitOutcome::LostRace);

        // And the ones that must still alarm. duplicate-invalid shares a
        // prefix with duplicate and means the opposite: known and bad.
        says("duplicate-invalid is a refusal",     "duplicate-invalid",
             SubmitOutcome::Refused);
        says("high-hash is a refusal",             "high-hash",
             SubmitOutcome::Refused);
        says("bad-txnmrklroot is a refusal",       "bad-txnmrklroot",
             SubmitOutcome::Refused);
        says("an unknown reason is a refusal",     "something new",
             SubmitOutcome::Refused);
    }

    std::printf("\n%s\n", ok ? "All self-tests passed." : "SELF-TEST FAILED.");
    return ok;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

int Benchmark(int threads, bool fullMem, bool largePages, int seconds)
{
    Info("benchmarking with " + std::to_string(threads) + " threads");

    RandomXEngine engine;
    std::string err;
    if (!engine.Init(threads, fullMem, largePages, err)) { Fail(err); return 1; }

    Info("mode: " + engine.Describe());

    // A fixed key, so two machines running --benchmark compare like for like.
    const std::string keyText = "WAM/benchmark";
    Bytes key(keyText.begin(), keyText.end());
    key.resize(32, 0);

    Info("preparing the dataset...");
    const int64_t t0 = NowMs();
    if (!engine.SetSeed(key, err)) { Fail(err); return 1; }
    Info("ready in " + std::to_string((NowMs() - t0) / 1000.0) + "s");

    if (!engine.CreateVms(threads, err)) { Fail(err); return 1; }

    std::atomic<uint64_t> hashes{0};
    std::atomic<bool>     run{true};
    std::vector<std::thread> pool;

    for (int i = 0; i < threads; i++) {
        pool.emplace_back([&, i]() {
            randomx_vm* vm = engine.Vm(size_t(i));
            if (!vm) { Fail("benchmark thread got no VM"); return; }

            uint8_t blob[80];
            std::memset(blob, 0, sizeof(blob));
            WriteLE32(blob, uint32_t(i));

            uint32_t nonce = 0;
            uint8_t out[32];

            WriteLE32(blob + 76, nonce);
            randomx_calculate_hash_first(vm, blob, 80);

            while (run.load(std::memory_order_relaxed)) {
                nonce++;
                WriteLE32(blob + 76, nonce);
                randomx_calculate_hash_next(vm, blob, 80, out);
                hashes.fetch_add(1, std::memory_order_relaxed);
            }
        });
    }

    const int64_t start = NowMs();
    for (int s = 1; s <= seconds; s++) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        const double elapsed = (NowMs() - start) / 1000.0;
        const double rate = elapsed > 0 ? hashes.load() / elapsed : 0;
        std::printf("\r  %s%2ds%s  %s        ", CLR_DIM, s, CLR_RESET,
                    HumanHashrate(rate).c_str());
        std::fflush(stdout);
    }
    std::printf("\n");

    run.store(false);
    for (std::thread& t : pool) t.join();

    const double elapsed = (NowMs() - start) / 1000.0;
    const double rate = hashes.load() / elapsed;
    Info("result: " + HumanHashrate(rate) + " over " +
         std::to_string(int(elapsed)) + "s (" +
         HumanHashrate(rate / threads) + " per thread)");
    return 0;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

struct Options {
    std::string host = "127.0.0.1";
    uint16_t    port = 3333;
    std::string user;
    std::string pass = "x";
    int         threads = 0;                 // 0 -> auto
    bool        fullMem = true;
    bool        largePages = false;
    bool        benchmark = false;
    int         benchmarkSeconds = 30;
    bool        selfTest = false;
    bool        help = false;

    // ---- mining alone, against your own node ----------------------------
    bool        solo = false;
    bool        check = false;   // build one block, ask the node, exit
    std::string rpcHost = "127.0.0.1";
    uint16_t    rpcPort = 9554;
    std::string rpcUser;
    std::string rpcPass;
    std::string rpcCookie;
    bool        rpcPortGiven = false;   // did --rpc name a port explicitly?
    std::string network = "mainnet";
    int         pollSeconds = 5;

    // Stop after this many accepted blocks. 0 means never stop, which is what
    // a person mining wants. A test wants a number: without one, proving that
    // --solo works on a platform means running it for a fixed wall-clock time
    // and guessing, which fails on a slow machine and passes on a fast one
    // whatever the code does.
    uint64_t    stopAfterBlocks = 0;
};

void PrintHelp()
{
    std::printf(
"wam-miner " "1.0.0" " -- the reference CPU miner for WAM Coin\n"
"\n"
"USAGE\n"
"    wam-miner -o <pool> -u <your WAM address>[.<worker>]\n"
"\n"
"OPTIONS\n"
"    -o, --url <host:port>   pool address; a stratum+tcp:// prefix is accepted\n"
"    -u, --user <address>    the WAM address to be paid at, optionally\n"
"                            followed by .<worker> to label this machine\n"
"    -p, --pass <password>   pool password (most pools ignore it; default 'x')\n"
"    -t, --threads <n>       mining threads (default: every core but one)\n"
"        --light             use the 256 MiB cache instead of the 2 GiB\n"
"                            dataset. Roughly four times slower; for machines\n"
"                            with under 4 GiB of RAM.\n"
"        --large-pages       ask for huge pages (needs system configuration;\n"
"                            worth about 5%% when it works)\n"
"        --benchmark [secs]  measure hashrate without connecting to a pool\n"
"        --check             with --solo: build one block from the node's\n"
"                            current template, ask the node whether it is\n"
"                            valid, and exit. Hashes nothing. Answers\n"
"                            \"will my block be accepted\" in a second\n"
"                            instead of after hours of mining.\n"
"        --solo              mine for yourself against your own node, with\n"
"                            no pool at all. Needs -u and a running wamd.\n"
"        --rpc <host:port>   the node RPC address. Left out, the port follows\n"
"                            --network: 9554 mainnet, 19554 testnet,\n"
"                            29554 regtest.\n"
"        --rpcuser <name>    RPC credentials, as in wam.conf. Omit both and\n"
"        --rpcpassword <s>   the miner reads the node .cookie instead.\n"
"        --rpccookie <path>  where that cookie is, if not the default\n"
"        --network <net>     mainnet (default), testnet or regtest\n"
"        --blocks <n>        exit once n blocks have been accepted. Meant for\n"
"                            testing on regtest; without it the miner runs\n"
"                            until stopped, which is what mining is.\n"
"        --self-test         verify SHA-256, byte order, targets and RandomX\n"
"                            against known vectors, then exit\n"
"        --no-colour         plain output, for logs and pipes\n"
"    -h, --help              this text\n"
"\n"
"EXAMPLES\n"
"    Mine to a pool:\n"
"        wam-miner -o stratum+tcp://pool.wamcoin.org:3333 -u wam1qexample...\n"
"\n"
"    Check the binary before trusting it with your electricity:\n"
"        wam-miner --self-test\n"
"        wam-miner --benchmark 60\n"
"\n"
"NOTES\n"
"    This miner takes no developer fee. It mines to the address you give it\n"
"    and to no other. WAM's 5%% treasury is a consensus rule paid by the\n"
"    coinbase, visible in every block, and ends at height 400,000.\n"
"\n"
"    Your address must belong to the network the pool is on: 'W...' or\n"
"    'wam1...' on mainnet. A wrong-network address means the pool refuses to\n"
"    authorize you, which is far better than being paid into a void.\n");
}

bool ParseOptions(int argc, char** argv, Options& opt, std::string& err)
{
    auto needsValue = [&](int& i, const char* flag) -> const char* {
        if (i + 1 >= argc) { err = std::string(flag) + " needs a value"; return nullptr; }
        return argv[++i];
    };

    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];

        if (a == "-h" || a == "--help") { opt.help = true; return true; }
        else if (a == "--self-test")    { opt.selfTest = true; }
        else if (a == "--solo")         { opt.solo = true; }
        else if (a == "--blocks") {
            const char* v = needsValue(i, "--blocks");
            if (!v) return false;
            const long long n = std::atoll(v);
            if (n <= 0) { err = "--blocks needs a positive number"; return false; }
            opt.stopAfterBlocks = (uint64_t)n;
        }
        else if (a == "--check")        { opt.solo = true; opt.check = true; }
        else if (a == "--rpc") {
            const char* v = needsValue(i, "--rpc");
            if (!v) return false;
            const std::string url = v;
            const size_t colon = url.rfind(':');
            if (colon == std::string::npos) { err = "--rpc must be host:port"; return false; }
            opt.rpcHost = url.substr(0, colon);
            const int port = std::atoi(url.c_str() + colon + 1);
            if (port <= 0 || port > 65535) { err = "--rpc has a bad port"; return false; }
            opt.rpcPort = uint16_t(port);
            opt.rpcPortGiven = true;
        }
        else if (a == "--rpcuser")     { const char* v = needsValue(i, "--rpcuser");     if (!v) return false; opt.rpcUser = v; }
        else if (a == "--rpcpassword") { const char* v = needsValue(i, "--rpcpassword"); if (!v) return false; opt.rpcPass = v; }
        else if (a == "--rpccookie")   { const char* v = needsValue(i, "--rpccookie");   if (!v) return false; opt.rpcCookie = v; }
        else if (a == "--network") {
            const char* v = needsValue(i, "--network");
            if (!v) return false;
            opt.network = v;
            if (opt.network != "mainnet" && opt.network != "testnet" &&
                opt.network != "regtest") {
                err = "--network must be mainnet, testnet or regtest";
                return false;
            }
        }
        else if (a == "--light")        { opt.fullMem = false; }
        else if (a == "--large-pages")  { opt.largePages = true; }
        else if (a == "--no-colour" || a == "--no-color") { g_colour = false; }
        else if (a == "--benchmark") {
            opt.benchmark = true;
            if (i + 1 < argc && argv[i + 1][0] != '-') {
                opt.benchmarkSeconds = std::atoi(argv[++i]);
                if (opt.benchmarkSeconds < 1) opt.benchmarkSeconds = 30;
            }
        }
        else if (a == "-o" || a == "--url") {
            const char* v = needsValue(i, "--url");
            if (!v) return false;

            std::string url = v;
            const size_t scheme = url.find("://");
            if (scheme != std::string::npos) url = url.substr(scheme + 3);

            const size_t colon = url.rfind(':');
            if (colon == std::string::npos) {
                err = "--url must be host:port";
                return false;
            }
            opt.host = url.substr(0, colon);
            const int port = std::atoi(url.c_str() + colon + 1);
            if (port <= 0 || port > 65535) { err = "--url has a bad port"; return false; }
            opt.port = uint16_t(port);
        }
        else if (a == "-u" || a == "--user") {
            const char* v = needsValue(i, "--user"); if (!v) return false;
            opt.user = v;
        }
        else if (a == "-p" || a == "--pass") {
            const char* v = needsValue(i, "--pass"); if (!v) return false;
            opt.pass = v;
        }
        else if (a == "-t" || a == "--threads") {
            const char* v = needsValue(i, "--threads"); if (!v) return false;
            opt.threads = std::atoi(v);
            if (opt.threads < 1) { err = "--threads must be at least 1"; return false; }
        }
        else {
            err = "unknown option '" + a + "' (try --help)";
            return false;
        }
    }

    // The RPC port follows the network unless it was named.
    //
    // It defaulted to 9554 whatever --network said, so `--solo --network
    // testnet` reached for the mainnet port and failed with "could not
    // connect" -- which reads as "your node is not running" to somebody whose
    // node is running perfectly, on the other port. Every other tool in this
    // project derives the port from the chain; the miner did not, and it is
    // the tool most likely to be used by somebody who has never seen an RPC
    // port before.
    if (!opt.rpcPortGiven) {
        if (opt.network == "testnet")      opt.rpcPort = 19554;
        else if (opt.network == "regtest") opt.rpcPort = 29554;
        else                               opt.rpcPort = 9554;
    }
    return true;
}

// ---------------------------------------------------------------------------

std::atomic<bool>* g_running = nullptr;

void OnSignal(int)
{
    if (g_running) g_running->store(false);
}

// ---------------------------------------------------------------------------
// Mining alone
// ---------------------------------------------------------------------------

/**
 * The pool's place, taken by a node.
 *
 * Everything below the job is unchanged: the same workers, the same VMs, the
 * same eighty bytes. What differs is only that work comes from
 * getblocktemplate instead of mining.notify, and that a solution becomes a
 * block instead of a share.
 *
 * There is no share difficulty here. A share is a pool's accounting device --
 * proof you were working, so it can pay you a fraction. Alone there is
 * nobody to prove anything to, so the only hash worth anything is one that
 * meets the block target, and the difficulty shown is the chain's own.
 */
int RunSolo(const Options& opt, RandomXEngine& engine, SharedState& state, int cores)
{
    Info("solo     no pool; building blocks against " + opt.rpcHost + ":" +
         std::to_string(opt.rpcPort));
    Info("address  " + opt.user);
    Info("network  " + opt.network);
    Info("threads  " + std::to_string(opt.threads) + " of " + std::to_string(cores) + " cores");
    Info("randomx  " + engine.Describe());

    // No credentials given means "you are on the same machine as the node",
    // which is the ordinary case and should not need to be spelled out.
    std::string cookie = opt.rpcCookie;
    if (opt.rpcUser.empty() && cookie.empty()) {
        cookie = DefaultCookiePath(opt.network);
        if (!cookie.empty()) Info("auth     cookie   " + cookie);
    }

    RpcClient   rpc(opt.rpcHost, opt.rpcPort, opt.rpcUser, opt.rpcPass, cookie,
                    opt.network);
    SoloSession solo(rpc, opt.user, NetParamsFor(opt.network), "/wam-miner/");

    // Fail before hashing, not after. A wrong address, an unreachable node or
    // a daemon with no devfee field are all things a miner should be told
    // immediately rather than after an hour of work that cannot be paid.
    {
        std::string error;
        if (!solo.Refresh(error)) {
            Fail(error);
            return 1;
        }
        Info("node     height " + std::to_string(solo.Current().job.height - 1) +
             ", building " + std::to_string(solo.Current().job.height));
    }

    if (opt.check) {
        const SoloTemplate& t = solo.Current();
        Info("check    building block " + std::to_string(t.job.height) + " with " +
             std::to_string(t.txs.size()) + " transaction(s) from the mempool");
        try {
            const std::string reason = solo.Propose();
            if (!reason.empty()) {
                Fail("the node refused the block: " + reason);
                return 1;
            }
        } catch (const std::exception& e) {
            Fail(std::string("the check could not be made: ") + e.what());
            return 1;
        }
        Good("the node accepts this block. Everything except the proof of work "
             "is correct: the coinbase, the treasury output, the witness "
             "commitment, the merkle root and the transactions.");
        Info("nothing was mined and nothing was submitted.");
        return 0;
    }

    // No share difficulty, because there are no shares.
    //
    // A share is a pool's accounting device: proof you were working, so it
    // can pay you a fraction of what it earns. Alone there is nobody to prove
    // anything to. The workers still compute a share target from this number
    // and still report "shares" they beat, and those are ignored below --
    // setting it absurdly high would only make the miner look idle. It is set
    // to the chain's own difficulty so the line the miner prints means
    // something to the person reading it.
    state.SetDifficulty(ChainDifficulty(solo.Current().job.nbits));

    state.onSolution = [&solo, &state](const StratumJob& job, const Bytes& en2,
                                       uint32_t nonce, bool isBlock,
                                       const uint8_t hashedHeader[80]) -> bool {
        if (!isBlock) return false;    // nothing else is worth sending anywhere
        try {
            std::string hex;
            const std::string reason =
                solo.Submit(job, en2, nonce, hashedHeader, &hex);
            if (reason.empty()) {
                state.accepted.fetch_add(1);
                Good("block " + std::to_string(job.height) + " ACCEPTED by the node");
                return true;
            }

            // ClassifySubmit is above SelfTest, where --self-test reaches it.
            if (ClassifySubmit(reason) == SubmitOutcome::LostRace) {
                state.stale.fetch_add(1);
                Info("block " + std::to_string(job.height) +
                     " lost the race (" + reason + ") -- another miner reached "
                     "this height first. Nothing is wrong; keep mining.");
                // true, not false. False means "the tip has not moved, the
                // block is still there to be won" -- which is right for a
                // node that refused us for its own reasons, and wrong here:
                // somebody else's block holds this height now, so every
                // further solution for this job is a side branch nobody will
                // ever build on. Idle until the next template instead, which
                // arrives within one poll.
                return true;
            }

            state.rejected.fetch_add(1);
            Fail("the node rejected block " + std::to_string(job.height) +
                 ": " + reason);

            // Keep what was sent. A rejected block is work already paid for in
            // electricity and thrown away, and the reason the node gives is
            // three words long; the bytes are the only other evidence there
            // is, and they cannot be reconstructed afterwards.
            //
            // The reason is the node's own words and goes into a filename, so
            // anything that is not plainly a name is replaced rather than
            // trusted.
            std::string tag;
            for (char c : reason) {
                tag += (std::isalnum((unsigned char)c) || c == '-') ? c : '-';
            }
            const std::string path = "wam-miner-rejected-" +
                                     std::to_string(job.height) + "-" + tag + ".hex";
            std::ofstream f(path, std::ios::binary);
            if (f) {
                f << hex << "\n";
                LogLine(CLR_DIM, "miner", "the block as sent is in " + path);
            }
        } catch (const std::exception& e) {
            // NOT `rejected`: the node never saw this one. And the evidence is
            // written here too -- this is the branch where there is no block
            // hex to keep, so what is kept is everything needed to rebuild it
            // by hand: the job, the height, the extranonce2, the nonce and the
            // exact eighty bytes that were hashed.
            state.lost.fetch_add(1);
            Fail(std::string("block ") + std::to_string(job.height) +
                 " was NOT sent: " + e.what());

            const std::string path = "wam-miner-lost-" +
                                     std::to_string(job.height) + "-" +
                                     job.jobId + ".txt";
            std::ofstream f(path, std::ios::binary);
            if (f) {
                f << "height "      << job.height   << "\n"
                  << "job "         << job.jobId    << "\n"
                  << "extranonce2 " << ToHex(en2)   << "\n"
                  << "nonce "       << nonce        << "\n"
                  << "header "
                  << (hashedHeader ? ToHex(hashedHeader, 80) : std::string())
                  << "\n"
                  << "reason "      << e.what()     << "\n";
                LogLine(CLR_DIM, "miner",
                        "what was solved is in " + path +
                        " -- keep it, it is a block nobody can rebuild later");
            }
        }
        return false;              // the tip did not move; keep working on it
    };

    if (!PublishJob(engine, state, opt.threads, solo.Current().job)) return 1;

    std::vector<std::thread> workers;
    workers.reserve(size_t(opt.threads));
    for (int i = 0; i < opt.threads; i++) {
        workers.emplace_back(WorkerLoop, i, std::ref(engine), std::ref(state));
    }

    int64_t nextPoll  = NowMs() + opt.pollSeconds * 1000;
    int64_t nextStats = NowMs() + 30000;
    uint64_t lastHashes = 0;
    int64_t  lastStatsAt = NowMs();
    int      alarms = 0;        // how many times the missing-block alarm has fired

    while (state.running.load()) {
        const int64_t now = NowMs();

        if (now >= nextPoll) {
            nextPoll = now + opt.pollSeconds * 1000;
            std::string error;
            if (!solo.Refresh(error)) {
                // A node that stops answering is not a reason to stop hashing
                // on the job in hand: it may be restarting, and the work
                // already done is still good for this height.
                Warn("the node did not answer: " + error);
            } else if (solo.WasNew()) {
                if (!PublishJob(engine, state, opt.threads, solo.Current().job)) break;
                state.SetDifficulty(ChainDifficulty(solo.Current().job.nbits));
            }
        }

        if (now >= nextStats) {
            const uint64_t hashes = state.hashes.load();
            const double seconds  = double(now - lastStatsAt) / 1000.0;
            const double rate     = seconds > 0 ? double(hashes - lastHashes) / seconds : 0;
            lastHashes  = hashes;
            lastStatsAt = now;
            nextStats   = now + 30000;

            // FOUND AND ACCEPTED MUST BE READ TOGETHER, AND A GAP MUST SHOUT.
            //
            // This line printed "blocks found 1 accepted 0" once every thirty
            // seconds while a man's block sat unsent, and nothing about it
            // looked like an emergency. A block found and not accepted is the
            // most expensive thing this program can produce, so when the two
            // disagree the line says so in as many words.
            const uint64_t found = state.blocksFound.load();
            const uint64_t acc   = state.accepted.load();
            const uint64_t lst   = state.lost.load();
            const uint64_t rej   = state.rejected.load();
            const uint64_t stl   = state.stale.load();

            char line[400];
            if (stl > 0) {
                // Shown only once there is one, so an ordinary run keeps the
                // line it has always had.
                std::snprintf(line, sizeof(line),
                              "%.0f H/s  height %" PRId64 "  blocks found %llu  "
                              "accepted %llu  (%llu lost a race)",
                              rate, solo.Current().job.height,
                              (unsigned long long)found, (unsigned long long)acc,
                              (unsigned long long)stl);
            } else {
                std::snprintf(line, sizeof(line),
                              "%.0f H/s  height %" PRId64 "  blocks found %llu  accepted %llu",
                              rate, solo.Current().job.height,
                              (unsigned long long)found, (unsigned long long)acc);
            }
            Info(line);

            // THE ALARM SHOUTS UNTIL IT IS HEARD, THEN STOPS SHOUTING.
            //
            // It used to fire every thirty seconds for the life of the
            // process, at full volume, ending with "do not leave it running".
            // Two things were wrong with that and both cost blocks.
            //
            // The advice was wrong. Stopping the miner does not recover a
            // block that was already missed, and it guarantees missing every
            // block that would have come after. What the operator must do is
            // keep the evidence file, which is written at the moment of the
            // failure and is the only thing that cannot be reconstructed.
            //
            // And repetition at full volume is not emphasis. After the first
            // few it carries no new information, and a line that screams
            // forever gets obeyed or ignored -- both wrong. On 2026-10-03 a
            // solo miner read it and shut down a miner that was working.
            //
            // `stale` is excluded entirely: a lost race is not a missing
            // block and never belonged in this sum.
            const uint64_t missing = (found > acc + stl) ? found - acc - stl : 0;
            if (missing > 0) {
                char warn[400];
                std::snprintf(warn, sizeof(warn),
                              "%llu block(s) found have NOT been accepted: "
                              "%llu not sent, %llu refused by the node. "
                              "That is real money. Keep the wam-miner-lost-* "
                              "and wam-miner-rejected-* files beside this "
                              "program -- they cannot be rebuilt later.",
                              (unsigned long long)missing,
                              (unsigned long long)lst,
                              (unsigned long long)rej);
                // Loud while it is news, then carried quietly on the status
                // line above, which already shows found and accepted.
                if (alarms < 5) { Warn(warn); alarms++; }
                else if (alarms == 5) {
                    Warn(warn);
                    Warn("this will not be repeated; the counts above carry it "
                         "from here. Do not stop the miner over it.");
                    alarms++;
                }
            }
        }

        // --blocks: stop once the node has accepted that many. `accepted` and
        // not `blocksFound`, because a block the node rejected proves the
        // opposite of what this is asked to prove.
        if (opt.stopAfterBlocks && state.accepted.load() >= opt.stopAfterBlocks) {
            Info("reached --blocks " + std::to_string(opt.stopAfterBlocks) +
                 "; stopping");
            break;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    state.running.store(false);
    for (std::thread& t : workers) if (t.joinable()) t.join();

    // A run asked for n blocks and given fewer has failed, and must say so
    // with an exit code -- a test that reads the log for a phrase is a test
    // that passes when the phrase changes.
    if (opt.stopAfterBlocks && state.accepted.load() < opt.stopAfterBlocks) {
        Fail("stopped with " + std::to_string(state.accepted.load()) +
             " accepted block(s), asked for " +
             std::to_string(opt.stopAfterBlocks));
        return 1;
    }

    // A RUN THAT LOST A BLOCK HAS FAILED, EVEN IF IT ALSO SUCCEEDED.
    //
    // Without this, a gate that asks for two blocks and gets two accepted and
    // one lost exits 0, and the lost one is a line in a log nobody reads. The
    // defect that took a real block on 2026-09-26 would have passed such a
    // gate on any run lucky enough to also land two.
    if (state.lost.load() > 0) {
        Fail(std::to_string(state.lost.load()) +
             " solved block(s) were never sent to the node. Each one is a "
             "block this machine earned and did not get.");
        return 1;
    }
    return 0;
}

int Run(int argc, char** argv)
{
    // Before the first line is printed, and before --no-colour is read, so
    // that the flag can still turn colour off but a console that cannot show
    // it never gets the chance to print escape bytes as text.
    if (!EnableAnsiColour()) g_colour = false;

    Options opt;
    std::string err;

    if (!ParseOptions(argc, argv, opt, err)) {
        std::fprintf(stderr, "error: %s\n", err.c_str());
        return 2;
    }
    if (opt.help) { PrintHelp(); return 0; }

    std::printf("%s wam-miner 1.0.0 -- RandomX CPU miner for WAM Coin%s\n\n",
                CLR_BOLD, CLR_RESET);

    if (opt.selfTest) return SelfTest() ? 0 : 1;

    const unsigned cores = std::max(1u, std::thread::hardware_concurrency());
    if (opt.threads == 0) {
        // Leave one core free so the machine stays usable; a miner that makes
        // a desktop unresponsive gets uninstalled.
        opt.threads = int(cores > 2 ? cores - 1 : 1);
    }

    if (opt.benchmark) {
        return Benchmark(opt.threads, opt.fullMem, opt.largePages, opt.benchmarkSeconds);
    }

    if (opt.user.empty()) {
        std::fprintf(stderr,
            "error: no payout address.\n"
            "       Pass -u <your WAM address>. Without it the pool has no way\n"
            "       to pay you, and will refuse the connection.\n");
        return 2;
    }

    // -----------------------------------------------------------------------

    SharedState state;
    state.SetDifficulty(1.0);
    g_running = &state.running;
    std::signal(SIGINT,  OnSignal);
    std::signal(SIGTERM, OnSignal);
#ifdef SIGPIPE
    // Writing to a socket the pool has closed raises SIGPIPE on Unix, and the
    // default action for it is to kill the process -- so a miner that ignored
    // this would be killed by its pool restarting rather than reconnecting to
    // it. Windows has no SIGPIPE: send() returns an error there, which is the
    // path SendRaw() takes on both systems anyway.
    std::signal(SIGPIPE, SIG_IGN);
#endif

    // --check never hashes, so it must not spend a minute and two gigabytes
    // preparing to. It is meant to answer in about a second.
    if (opt.check) opt.fullMem = false;

    RandomXEngine engine;
    if (!engine.Init(opt.threads, opt.fullMem, opt.largePages, err)) {
        Fail(err);
        return 1;
    }

    if (opt.solo) {
        return RunSolo(opt, engine, state, cores);
    }

    Info("pool     " + opt.host + ":" + std::to_string(opt.port));
    Info("address  " + opt.user);
    Info("threads  " + std::to_string(opt.threads) + " of " + std::to_string(cores) + " cores");
    Info("randomx  " + engine.Describe());

    StratumClient client(opt.host, opt.port, opt.user, opt.pass);

    // The pool path: a solution is a share, named by the job it belongs to.
    state.onSolution = [&client](const StratumJob& job, const Bytes&,
                                 uint32_t nonce, bool,
                                 const uint8_t[80]) -> bool {
        client.QueueSubmit(job.jobId, job.extranonce2Hex,
                           ToHexBE32(job.ntime), ToHexBE32(nonce));
        return true;               // the pool decides what happens next
    };

    client.onLog   = [](const std::string& m) { Info(m); };
    client.onError = [](const std::string& m) { Fail(m); };

    client.onDifficulty = [&state](double d) {
        state.SetDifficulty(d);
        Info("difficulty set to " + std::to_string(d));
        // Re-snapshot so workers pick up the new share target immediately.
        state.jobEpoch.fetch_add(1);
    };

    client.onSubmitResult = [&state](bool accepted, const std::string& reason) {
        if (accepted) {
            state.accepted.fetch_add(1);
            Good("share accepted (" + std::to_string(state.accepted.load()) + " total)");
        } else {
            state.rejected.fetch_add(1);
            Warn("share rejected: " + reason);
        }
    };

    client.onJob = [&](const StratumJob& incoming) {
        if (!PublishJob(engine, state, opt.threads, incoming)) state.running.store(false);
    };

    // ---- workers ----------------------------------------------------------
    std::vector<std::thread> workers;
    workers.reserve(size_t(opt.threads));
    for (int i = 0; i < opt.threads; i++) {
        workers.emplace_back(WorkerLoop, i, std::ref(engine), std::ref(state));
    }

    // ---- I/O loop ---------------------------------------------------------
    int64_t nextStats  = NowMs() + 30000;
    int64_t retryDelay = 1000;
    uint64_t lastHashes = 0;
    int64_t  lastStatsAt = NowMs();

    int lastRefusals = 0;

    while (state.running.load()) {
        if (!client.IsConnected()) {
            std::string connectError;
            if (client.Connect(connectError)) {
                // A connect that succeeds and is then refused at
                // mining.authorize is not a success. Until 2026-09-14 this
                // branch reset the backoff, so a miner with a mistyped
                // address reconnected as fast as TCP allowed, for ever --
                // found by the operator of a 500-miner pool who rehearsed
                // against us and had to throttle his own clients.
                if (client.AuthRefusals() > lastRefusals) {
                    lastRefusals = client.AuthRefusals();
                    Info("the pool refused the address; retrying in "
                         + std::to_string(retryDelay / 1000) + "s");
                    for (int64_t slept = 0;
                         slept < retryDelay && state.running.load(); slept += 200) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(200));
                    }
                    retryDelay = std::min<int64_t>(retryDelay * 2, 60000);
                    continue;
                }
                Info("connected");
                retryDelay = 1000;
            } else {
                Fail(connectError);
                Info("retrying in " + std::to_string(retryDelay / 1000) + "s");
                for (int64_t slept = 0; slept < retryDelay && state.running.load(); slept += 200) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(200));
                }
                retryDelay = std::min<int64_t>(retryDelay * 2, 60000);
                continue;
            }
        }

        client.Poll();

        if (NowMs() >= nextStats) {
            const uint64_t now = state.hashes.load();
            const double window = (NowMs() - lastStatsAt) / 1000.0;
            const double rate = window > 0 ? double(now - lastHashes) / window : 0;

            char line[256];
            std::snprintf(line, sizeof(line),
                          "%s   accepted %" PRIu64 "  rejected %" PRIu64
                          "  blocks %" PRIu64 "  total %" PRIu64 " hashes",
                          HumanHashrate(rate).c_str(),
                          state.accepted.load(), state.rejected.load(),
                          state.blocksFound.load(), now);
            LogLine(CLR_DIM, "stats", line);

            lastHashes  = now;
            lastStatsAt = NowMs();
            nextStats   = NowMs() + 30000;
        }
    }

    Info("shutting down");
    state.running.store(false);
    for (std::thread& t : workers) if (t.joinable()) t.join();
    client.Close();

    Info("accepted " + std::to_string(state.accepted.load()) +
         ", rejected " + std::to_string(state.rejected.load()) +
         ", blocks " + std::to_string(state.blocksFound.load()));
    return 0;
}

} // namespace wam

int main(int argc, char** argv)
{
    return wam::Run(argc, argv);
}
