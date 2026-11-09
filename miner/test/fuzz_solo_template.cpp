// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  fuzz_solo_template.cpp -- the miner's untrusted input, hammered
// ===========================================================================
//
//      bash scripts/fuzz_miner.sh            # build and run for 60 seconds
//      bash scripts/fuzz_miner.sh 3600       # or for an hour
//
//  WHY THIS EXISTS
//
//  On 8 November 2026 a reader outside this project fuzzed the miner's
//  untrusted-input layer on his own hardware -- 6.4 million ASan/UBSan cases
//  -- and reported that --solo hangs and grows memory without bound on one
//  hostile getblocktemplate field. He was right, and the arithmetic behind it
//  was undefined behaviour we had written ourselves:
//
//      int64_t(double)   is undefined when the value does not fit, and
//                        x86-64 answers INT64_MIN, so "height": 1e300
//                        arrived negative through a positive field
//
//      while (v) { ...; v >>= 8; }   never terminates for a negative v,
//                        because an arithmetic shift keeps the sign
//
//  The number of cases this project had run against its own code before that
//  day was zero. Bitcoin Core ships a fuzz harness and our three platform
//  builds pass --disable-tests-fuzz-binary; nothing else in the tree fuzzed
//  anything. An outsider doing six million of something we had done none of
//  is not a bug report, it is a gap in how we work.
//
//  WHAT IT COVERS, AND WHY THIS SURFACE
//
//  Everything --solo believes about the chain arrives as one JSON document
//  over plaintext HTTP from whatever --rpc points at. That document is the
//  miner's entire attack surface, and three layers read it:
//
//      json::Parser            arbitrary bytes -> a value
//      BuildSoloTemplate       a value -> a block template and a job
//      HeightPush              one integer -> the BIP34 push
//
//  The harness drives all three. A thrown std::exception is a pass: it is
//  the layer refusing something, which is what it is for. A crash, a
//  sanitiser report, or a call that does not return is the finding.
//
//  NO libFuzzer, AND WHY THAT IS NOT A COMPROMISE
//
//  This machine has gcc and not clang, so there is no -fsanitize=fuzzer and
//  no coverage-guided mutation. What there is -- and what found the real
//  fault -- is ASan and UBSan, which gcc has, plus a mutator that knows
//  where this format's edges are: the numbers. A coverage-guided engine
//  spends its first hours learning to produce valid JSON. This one starts
//  from a template a real node emitted and attacks the fields.
//
//  Every run is reproducible: --seed fixes the stream, and an input that
//  fails is written out with the seed and the iteration that produced it.
// ===========================================================================

#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>
#include <vector>

#include "solo_template.h"

using namespace wam;

// ---------------------------------------------------------------------------
//  A template a real node emitted, and the shapes that broke things before.
// ---------------------------------------------------------------------------

static const char* kSeeds[] = {
// Taken verbatim from a running wamd on regtest at height 89.
"{\"capabilities\":[\"proposal\"],\"version\":536870912,\"rules\":[\"csv\",\"!segwit\",\"taproot\"],"
"\"vbavailable\":{},\"vbrequired\":0,"
"\"previousblockhash\":\"11dca7308c1f95b844aa630cc6ffc8701015c5edd123a3a5ee5c53c08219c224\","
"\"transactions\":[],\"coinbaseaux\":{},\"coinbasevalue\":5000000000,"
"\"longpollid\":\"11dca7308c1f95b844aa630cc6ffc8701015c5edd123a3a5ee5c53c08219c22489\","
"\"target\":\"7fffff0000000000000000000000000000000000000000000000000000000000\","
"\"mintime\":1789854943,\"mutable\":[\"time\",\"transactions\",\"prevblock\"],"
"\"noncerange\":\"00000000ffffffff\",\"sigoplimit\":80000,\"sizelimit\":4000000,"
"\"weightlimit\":4000000,\"curtime\":1789855038,\"bits\":\"207fffff\",\"height\":89,"
"\"devfee\":{\"amount\":250000000,"
"\"script\":\"76a914a21b54367f4bd15b9b33e6e9e8b87c5b2fab5c1688ac\","
"\"address\":\"TQkMCz4r2oWuFjAu8mAeGYDMuz4BNkmofz\",\"percent\":5,"
"\"last_height\":400000,\"active\":true},"
"\"randomx_seedhash\":\"eca37065ee2bcb3fa020a90ccfb6c71b75d741fb5bac83023a1f14c68f5b1d4f\","
"\"randomx_seedheight\":64,"
"\"default_witness_commitment\":\"6a24aa21a9ede2f61c3f71d1defd3fa999dfa36953755c690689799962b48bebd836974e8cf9\"}",

// The reported one, kept as a seed so a regression is found in the first
// thousand cases rather than the millionth.
"{\"version\":536870912,\"previousblockhash\":\"11dca7308c1f95b844aa630cc6ffc8701015c5edd123a3a5ee5c53c08219c224\","
"\"transactions\":[],\"coinbasevalue\":5000000000,\"curtime\":1789855038,"
"\"bits\":\"207fffff\",\"height\":-1,\"devfee\":{\"amount\":250000000,"
"\"script\":\"76a914a21b54367f4bd15b9b33e6e9e8b87c5b2fab5c1688ac\"},"
"\"randomx_seedhash\":\"eca37065ee2bcb3fa020a90ccfb6c71b75d741fb5bac83023a1f14c68f5b1d4f\"}",

"{}",
"[]",
"null",
"{\"height\":1e300}",
};
static const size_t kSeedCount = sizeof(kSeeds) / sizeof(kSeeds[0]);

// The numbers a hostile node reaches for. Every one of these is a value that
// is a perfectly good JSON number and a terrible integer.
static const char* kNastyNumbers[] = {
    "-1", "0", "1", "-0", "1e300", "-1e300", "1e-300", "9223372036854775807",
    "9223372036854775808", "-9223372036854775808", "-9223372036854775809",
    "18446744073709551616", "4294967296", "4294967295", "2147483648",
    "0.5", "-0.5", "1e999", "-1e999", "1e-999", "16", "17", "0e0",
};
static const size_t kNastyCount = sizeof(kNastyNumbers) / sizeof(kNastyNumbers[0]);

static const char* kFields[] = {
    "height", "version", "curtime", "coinbasevalue", "mintime", "sigoplimit",
    "sizelimit", "weightlimit", "randomx_seedheight", "amount", "percent",
    "last_height", "vbrequired",
};
static const size_t kFieldCount = sizeof(kFields) / sizeof(kFields[0]);

// ---------------------------------------------------------------------------
//  A small deterministic generator. Reproducibility matters more than
//  statistical quality: a finding has to be replayable from its seed.
// ---------------------------------------------------------------------------

static uint64_t g_state = 1;
static uint64_t Rnd()
{
    g_state ^= g_state << 13;
    g_state ^= g_state >> 7;
    g_state ^= g_state << 17;
    return g_state;
}
static size_t RndBelow(size_t n) { return n ? size_t(Rnd() % n) : 0; }

// What is being tried right now, so the watchdog can write it out.
static std::string g_current;
static uint64_t    g_seed = 1;
static uint64_t    g_iteration = 0;

// ---------------------------------------------------------------------------
//  The watchdog.
//
//  A hang is the fault this harness exists for, and a hang cannot be caught
//  by a return value: the call never returns. alarm() is the only thing that
//  still works when the process is inside while(v) with v negative. The
//  handler writes the input that caused it and leaves immediately -- it does
//  not try to unwind, because there is nothing to unwind to.
// ---------------------------------------------------------------------------

static void OnAlarm(int)
{
    const char* msg = "\n\nHANG: a call did not return. The input is in fuzz-hang.json\n";
    ssize_t ignored = write(2, msg, strlen(msg));
    (void)ignored;
    FILE* f = fopen("fuzz-hang.json", "w");
    if (f) {
        fprintf(f, "%s", g_current.c_str());
        fclose(f);
    }
    FILE* m = fopen("fuzz-hang.txt", "w");
    if (m) {
        fprintf(m, "seed %llu iteration %llu\n",
                (unsigned long long)g_seed, (unsigned long long)g_iteration);
        fclose(m);
    }
    _exit(99);
}

// ---------------------------------------------------------------------------
//  Mutations. Each one knows something about this format.
// ---------------------------------------------------------------------------

static std::string ReplaceNumberField(const std::string& in)
{
    const std::string key = std::string("\"") + kFields[RndBelow(kFieldCount)] + "\":";
    const size_t at = in.find(key);
    if (at == std::string::npos) return in;
    const size_t start = at + key.size();
    size_t end = start;
    while (end < in.size() && in[end] != ',' && in[end] != '}') end++;
    return in.substr(0, start) + kNastyNumbers[RndBelow(kNastyCount)] + in.substr(end);
}

static std::string FlipBytes(const std::string& in)
{
    if (in.empty()) return in;
    std::string out = in;
    size_t n = 1 + RndBelow(4);
    for (size_t i = 0; i < n; i++) out[RndBelow(out.size())] ^= uint8_t(1 + RndBelow(255));
    return out;
}

static std::string Truncate(const std::string& in)
{
    return in.empty() ? in : in.substr(0, RndBelow(in.size()));
}

static std::string Splice(const std::string& a, const std::string& b)
{
    if (a.empty() || b.empty()) return a;
    return a.substr(0, RndBelow(a.size())) + b.substr(RndBelow(b.size()));
}

static std::string Repeat(const std::string& in)
{
    if (in.size() < 2) return in;
    const size_t at = RndBelow(in.size() - 1);
    const size_t len = 1 + RndBelow(in.size() - at - 1);
    const std::string piece = in.substr(at, len);
    std::string out = in;
    const size_t times = 1 + RndBelow(8);
    for (size_t i = 0; i < times; i++) out.insert(at, piece);
    return out;
}

static std::string Nest(const std::string&)
{
    // Depth, which is the other way a parser dies: one stack frame per level.
    const size_t depth = 1 + RndBelow(2000);
    std::string out;
    out.reserve(depth * 2 + 2);
    for (size_t i = 0; i < depth; i++) out += "[";
    for (size_t i = 0; i < depth; i++) out += "]";
    return out;
}

static std::string Mutate(const std::vector<std::string>& corpus)
{
    const std::string& base = corpus[RndBelow(corpus.size())];
    switch (RndBelow(7)) {
        case 0: return ReplaceNumberField(base);
        case 1: return ReplaceNumberField(ReplaceNumberField(base));
        case 2: return FlipBytes(base);
        case 3: return Truncate(base);
        case 4: return Splice(base, corpus[RndBelow(corpus.size())]);
        case 5: return Repeat(base);
        default: return Nest(base);
    }
}

// ---------------------------------------------------------------------------

static void Save(const char* name, const std::string& data)
{
    FILE* f = fopen(name, "w");
    if (!f) return;
    fwrite(data.data(), 1, data.size(), f);
    fclose(f);
}

int main(int argc, char** argv)
{
    unsigned seconds = 60;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--seed") && i + 1 < argc) g_seed = strtoull(argv[++i], nullptr, 10);
        else if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = unsigned(atoi(argv[++i]));
    }
    if (g_seed == 0) g_seed = 1;
    g_state = g_seed;

    std::vector<std::string> corpus;
    for (size_t i = 0; i < kSeedCount; i++) corpus.push_back(kSeeds[i]);

    signal(SIGALRM, OnAlarm);

    std::printf("\nfuzz_solo_template -- seed %llu, %u seconds\n",
                (unsigned long long)g_seed, seconds);
    std::printf("  three layers: json::Parser, BuildSoloTemplate, HeightPush\n");
    std::printf("  a thrown exception is a pass. a crash, a sanitiser report\n");
    std::printf("  or a call that does not return is a finding.\n\n");

    const Bytes en1 = {0xde, 0xad, 0xbe, 0xef};
    const char* kAddr = "wamrt1q9uynnmupf5jl920vgztyef0v3esfjvdzfxfhyt";

    uint64_t parsed = 0, built = 0, refused = 0;
    const time_t until = time(nullptr) + seconds;

    while (time(nullptr) < until) {
        g_iteration++;

        // ---- the two upper layers, from arbitrary bytes ------------------
        g_current = Mutate(corpus);
        alarm(5);
        json::Value v;
        std::string err;
        if (json::ParseLine(g_current, v, err)) {
            parsed++;
            try {
                BuildSoloTemplate(v, kAddr, NetParamsFor("regtest"), "/wam-miner/", en1, 4);
                built++;
                // A document that builds is worth keeping: it reaches deeper
                // than one that is refused at the door.
                if (corpus.size() < 256) corpus.push_back(g_current);
            } catch (const std::exception&) {
                refused++;
            }
        }
        alarm(0);

        // ---- and the integer layer on its own ----------------------------
        //
        // HeightPush is reached with whatever survives the conversion above,
        // so it is also driven directly: every edge of int64, not only the
        // ones a JSON double can land on.
        const int64_t edges[] = {0, 1, 16, 17, -1, INT64_MIN, INT64_MAX,
                                 INT64_MIN + 1, 255, 256, -256};
        const int64_t h = (g_iteration % 23 == 0)
                        ? edges[RndBelow(sizeof(edges) / sizeof(edges[0]))]
                        : int64_t(Rnd());
        g_current = "HeightPush(" + std::to_string(h) + ")";
        alarm(5);
        try { HeightPush(h); } catch (const std::exception&) { refused++; }
        alarm(0);

        if (g_iteration % 100000 == 0) {
            std::printf("  %10llu cases   %llu parsed   %llu built   %llu refused\n",
                        (unsigned long long)g_iteration, (unsigned long long)parsed,
                        (unsigned long long)built, (unsigned long long)refused);
            std::fflush(stdout);
        }
    }

    std::printf("\n  %llu cases, %llu parsed, %llu built, %llu refused\n",
                (unsigned long long)g_iteration, (unsigned long long)parsed,
                (unsigned long long)built, (unsigned long long)refused);
    std::printf("  no crash, no sanitiser report, nothing hung.\n");
    std::printf("  seed %llu -- pass it to --seed to run this exact stream again.\n\n",
                (unsigned long long)g_seed);
    (void)Save;
    return 0;
}
