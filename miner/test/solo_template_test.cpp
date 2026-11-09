// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  solo_template_test.cpp -- the two things a solo block is silently wrong in
// ===========================================================================
//
//      g++ -std=c++17 -I../src -o solo_template_test solo_template_test.cpp
//
//  Both of the bugs tested here were found by mining a throwaway regtest
//  chain, and neither could have been found by reading the code, because in
//  both cases the miner's arithmetic agreed with itself at every step. The
//  node was the only party that disagreed, and it disagreed in three words.
//
//    1. BIP34's height. Consensus does not compare the height as a NUMBER; it
//       builds `CScript() << nHeight` and compares BYTES. Heights 1 to 16 are
//       single opcodes, not data pushes. Written without that case, the miner
//       passed a proposal against mainnet at height 3351 and was refused on a
//       fresh chain at height 1 -- a bug that can only appear in the first
//       sixteen blocks of a chain, which is when nobody is watching.
//
//    2. The RandomX seed. getblocktemplate renders it the way a uint256
//       prints, big-endian; RandomX is keyed with the internal bytes. Keyed
//       with the wire order, the miner hashes against a key nobody else uses
//       and the node answers "high-hash" -- which reads as bad luck. On a real
//       chain it reads as a machine that never finds anything.
//
//  The template below is not invented. It was taken verbatim from a running
//  wamd with `getblocktemplate '{"rules":["segwit"]}'`.
// ===========================================================================

#include <cstdint>
#include <cstdio>
#include <string>

#include "solo_template.h"

using namespace wam;

static int failures = 0;
static int checks   = 0;

static std::string Hex(const Bytes& b)
{
    static const char* d = "0123456789abcdef";
    std::string s;
    for (uint8_t c : b) { s += d[c >> 4]; s += d[c & 15]; }
    return s;
}

static void Eq(const std::string& got, const std::string& want, const char* what)
{
    checks++;
    if (got == want) {
        std::printf("  ok    %s\n", what);
        return;
    }
    failures++;
    std::printf("  FAIL  %s\n          wanted %s\n          got    %s\n",
                what, want.c_str(), got.c_str());
}

// ---------------------------------------------------------------------------

static void HeightVector(int64_t height, const char* wantHex)
{
    char what[80];
    std::snprintf(what, sizeof(what), "height %lld encodes as %s",
                  (long long)height, wantHex);
    Eq(Hex(HeightPush(height)), wantHex, what);
}

static void TestHeights()
{
    std::printf("\nBIP34 height, as CScript::push_int64 writes it\n");

    // OP_0. A coinbase at height 0 cannot exist -- genesis is not mined -- but
    // the encoding is defined and getting it wrong here would hide the shape
    // of the rule.
    HeightVector(0, "00");

    // OP_1 .. OP_16: one opcode, no length byte. This is the case that was
    // missing, and the only one a live chain stops exercising after its first
    // sixteen blocks.
    HeightVector(1,  "51");
    HeightVector(2,  "52");
    HeightVector(15, "5f");
    HeightVector(16, "60");

    // 17 is where data pushes begin: a length byte, then the number.
    HeightVector(17, "0111");

    // Real heights, little-endian. 88 was mined by this miner on regtest; 3351
    // is the mainnet height whose proposal the miner first got accepted.
    HeightVector(88,   "0158");
    HeightVector(3351, "02170d");

    // The sign byte. 128 has its top bit set, so a bare 0x80 would read as a
    // negative script number and the height would not match.
    HeightVector(127, "017f");
    HeightVector(128, "028000");
    HeightVector(255, "02ff00");

    // Three bytes, and a three-byte value whose top bit is clear needs no
    // fourth. 8388608 does need one.
    HeightVector(65535,   "03ffff00");
    HeightVector(8388607, "03ffff7f");
    HeightVector(8388608, "0400008000");
}

// ---------------------------------------------------------------------------

// Taken verbatim from a running wamd on regtest, at height 89, after the
// chain's first key rotation (randomx_seedheight 64) so the seed is a real
// block hash rather than the bootstrap constant.
static const char* kTemplate =
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
"\"default_witness_commitment\":\"6a24aa21a9ede2f61c3f71d1defd3fa999dfa36953755c690689799962b48bebd836974e8cf9\"}";

static void TestTemplate()
{
    std::printf("\nA real getblocktemplate, turned into a job\n");

    json::Value t;
    std::string err;
    checks++;
    if (!json::ParseLine(kTemplate, t, err)) {
        failures++;
        std::printf("  FAIL  the captured template does not parse: %s\n", err.c_str());
        return;
    }
    std::printf("  ok    the captured template parses\n");

    const Bytes en1 = {0xde, 0xad, 0xbe, 0xef};
    SoloTemplate st = BuildSoloTemplate(t, "wamrt1q9uynnmupf5jl920vgztyef0v3esfjvdzfxfhyt",
                                        NetParamsFor("regtest"), "/wam-miner/", en1, 4);

    // THE SEED IS REVERSED. This single line is the whole test: the wire value
    // is big-endian and RandomX takes the internal bytes.
    Eq(Hex(st.job.seed),
       "4f1d5b8fc6141f3a0283ac5bfb41d7751bc7b6cf0ca920a03fcb2bee6570a3ec",
       "the RandomX key is the seed hash reversed");

    // Not the wire order, stated separately so a future change that quietly
    // drops the reversal fails with a message that names the mistake.
    checks++;
    if (Hex(st.job.seed) ==
        "eca37065ee2bcb3fa020a90ccfb6c71b75d741fb5bac83023a1f14c68f5b1d4f") {
        failures++;
        std::printf("  FAIL  the key is the wire order: every hash would be "
                    "computed against a seed nobody else uses\n");
    } else {
        std::printf("  ok    the key is not the wire order\n");
    }

    // The prevhash goes into the header little-endian, the reverse of how the
    // node states it -- the same conversion, on a different field.
    Eq(Hex(Bytes(st.job.prevHash, st.job.prevHash + 32)),
       "24c21982c0535ceea5a323d1edc5151070c8ffc60c63aa44b8951f8c30a7dc11",
       "the previous block hash is reversed into header order");

    Eq(std::to_string(st.job.height), "89", "the height is the template's");
    Eq(std::to_string(st.coinbaseValue), "5000000000", "the coinbase value is the template's");
    Eq(std::to_string(st.devFeeAmount), "250000000", "the treasury is 5% of the subsidy");

    // The height is in the coinbase where consensus looks for it: first byte
    // of the scriptSig, which for 89 is a one-byte data push.
    const Bytes en2 = {0x00, 0x00, 0x00, 0x01};
    const Bytes cb  = SerializeCoinbase(st.job, en2);
    const std::string cbHex = Hex(cb);
    checks++;
    if (cbHex.find("0159") != std::string::npos) {
        std::printf("  ok    the coinbase carries height 89 as a data push\n");
    } else {
        failures++;
        std::printf("  FAIL  the coinbase does not carry height 89\n");
    }
}

// ---------------------------------------------------------------------------

/**
 * Three ways a number in a getblocktemplate reply could end the miner.
 *
 * --solo reads that reply over plaintext HTTP, so the party choosing these
 * values is the node --rpc points at, or anyone on the path to it. None of
 * the three is a crash. Two are a hang with memory climbing until the OOM
 * killer arrives, which is worse than a crash, because a miner that has
 * stopped is noticed and a miner that is spinning is not.
 *
 * Reported by bobbyning, 8 November 2026.
 */
static void Throws(void (*f)(), const char* what)
{
    checks++;
    try { f(); }
    catch (const std::exception&) { std::printf("  ok    %s\n", what); return; }
    failures++;
    std::printf("  FAIL  %s -- it returned instead\n", what);
}

static void PushNegativeOne()  { HeightPush(-1); }
static void PushIntMin()       { HeightPush(INT64_MIN); }

static void TestHostileNumbers()
{
    std::printf("\nNumbers a node should never send, and what they used to do\n");

    // 1. HeightPush ran forever on any negative height. `v >>= 8` on a
    //    negative int64 is an arithmetic shift: -1 >> 8 is -1, so the loop
    //    never reaches zero and appends a byte every turn. This cannot be
    //    written as "it returns the wrong bytes" -- before the fix it did
    //    not return.
    Throws(PushNegativeOne, "HeightPush(-1) is refused, not looped on");
    Throws(PushIntMin,      "HeightPush(INT64_MIN) is refused");

    // and every height that is real still encodes exactly as it did
    HeightVector(0,  "00");
    HeightVector(1,  "51");
    HeightVector(89, "0159");

    // 2. int64_t(double) is undefined when the value does not fit, and
    //    x86-64 resolves it as INT64_MIN. So "height": 1e300 reached
    //    HeightPush as a negative number, through a field that is
    //    arithmetically positive.
    json::Value big;
    std::string err;
    checks++;
    if (json::ParseLine("{\"height\":1e300}", big, err)) {
        std::printf("  ok    1e300 parses as JSON, which it must\n");
    } else {
        failures++;
        std::printf("  FAIL  1e300 did not parse: %s\n", err.c_str());
    }
    checks++;
    try {
        const int64_t got = big["height"].AsInt();
        failures++;
        std::printf("  FAIL  AsInt turned 1e300 into %lld\n", (long long)got);
    } catch (const std::exception&) {
        std::printf("  ok    AsInt refuses 1e300 rather than answering INT64_MIN\n");
    }

    // 3. End to end, on the first-poll path of --solo: the captured template
    //    with one field changed and nothing else.
    const std::string good(kTemplate);
    const Bytes en1 = {0xde, 0xad, 0xbe, 0xef};
    const char* const bad[] = { "\"height\":-1", "\"height\":1e300", "\"height\":0" };
    const char* const says[] = {
        "a template with height -1 is refused",
        "a template with height 1e300 is refused",
        "a template with height 0 is refused",
    };
    for (int i = 0; i < 3; i++) {
        std::string s = good;
        const size_t at = s.find("\"height\":89");
        s.replace(at, std::string("\"height\":89").size(), bad[i]);
        json::Value t2;
        std::string e2;
        checks++;
        if (!json::ParseLine(s, t2, e2)) {
            failures++;
            std::printf("  FAIL  the edited template does not parse: %s\n", e2.c_str());
            continue;
        }
        try {
            BuildSoloTemplate(t2, "wamrt1q9uynnmupf5jl920vgztyef0v3esfjvdzfxfhyt",
                              NetParamsFor("regtest"), "/wam-miner/", en1, 4);
            failures++;
            std::printf("  FAIL  %s -- it built a job\n", says[i]);
        } catch (const std::exception&) {
            std::printf("  ok    %s\n", says[i]);
        }
    }

    // and the real one still builds, so the bound did not eat the chain
    json::Value t3;
    std::string e3;
    checks++;
    if (json::ParseLine(kTemplate, t3, e3)) {
        try {
            SoloTemplate st = BuildSoloTemplate(
                t3, "wamrt1q9uynnmupf5jl920vgztyef0v3esfjvdzfxfhyt",
                NetParamsFor("regtest"), "/wam-miner/", en1, 4);
            if (st.job.height == 89) {
                std::printf("  ok    the real template still builds at height 89\n");
            } else {
                failures++;
                std::printf("  FAIL  the real template built at height %lld\n",
                            (long long)st.job.height);
            }
        } catch (const std::exception& ex) {
            failures++;
            std::printf("  FAIL  the real template now throws: %s\n", ex.what());
        }
    } else {
        failures++;
        std::printf("  FAIL  the captured template does not parse: %s\n", e3.c_str());
    }
}

// ---------------------------------------------------------------------------

static void Is(bool got, bool want, const char* what)
{
    checks++;
    if (got == want) { std::printf("  ok    %s\n", what); return; }
    failures++;
    std::printf("  FAIL  %s (wanted %s)\n", what, want ? "same work" : "new work");
}

/**
 * The same work, or only the same moment?
 *
 * A solo miner polls the node every five seconds and the node answers every
 * time. Before this was distinguished, each answer minted a new job id and
 * the job a worker was still hashing scrolled out of a list bounded by count
 * -- taking its transactions with it, so the block could not be built.
 *
 * On 2026-09-26 a miner solved height 7838 ninety-nine seconds after it
 * started and the block was refused: "job 7838.9 is no longer held". These
 * checks are that failure written down so it cannot come back quietly.
 */
static void TestSameWork()
{
    std::printf("\nthe same work, or only the same moment?\n");

    json::Value t;
    std::string err;
    if (!json::ParseLine(kTemplate, t, err)) {
        checks++; failures++;
        std::printf("  FAIL  the captured template does not parse\n");
        return;
    }
    const Bytes en1 = {0xde, 0xad, 0xbe, 0xef};
    const char* addr = "wamrt1q9uynnmupf5jl920vgztyef0v3esfjvdzfxfhyt";
    SoloTemplate a = BuildSoloTemplate(t, addr, NetParamsFor("regtest"),
                                       "/wam-miner/", en1, 4);

    // The node asked twice with nothing having happened in between. This is
    // the case that was costing blocks: it must be the same work.
    SoloTemplate b = BuildSoloTemplate(t, addr, NetParamsFor("regtest"),
                                       "/wam-miner/", en1, 4);
    Is(SameWork(a, b), true, "two identical templates are one job");

    // curtime advances on every call. It is the one header field a miner may
    // hold or roll on its own, and treating it as new work is exactly the bug.
    SoloTemplate c = b;
    c.job.ntime = b.job.ntime + 7;
    Is(SameWork(a, c), true, "a later ntime alone is still the same job");

    // And the id of the reply is not the work either.
    SoloTemplate d = b;
    d.longPollId = "something-else";
    Is(SameWork(a, d), true, "a different longpollid is still the same job");

    // Everything that reaches the header or the body is new work.
    SoloTemplate e = b; e.prevHashHex = std::string(64, 'a');
    Is(SameWork(a, e), false, "a new chain tip is new work");

    SoloTemplate f = b; f.job.height += 1;
    Is(SameWork(a, f), false, "a new height is new work");

    SoloTemplate g = b; g.job.nbits ^= 1u;
    Is(SameWork(a, g), false, "new nbits is new work");

    SoloTemplate h = b; h.job.version ^= 1u;
    Is(SameWork(a, h), false, "a new version is new work");

    SoloTemplate i = b; i.job.seed.push_back(0x01);
    Is(SameWork(a, i), false, "a new RandomX key is new work");

    SoloTemplate j = b; j.job.coinb2.push_back(0x01);
    Is(SameWork(a, j), false, "a changed coinbase is new work");

    SoloTemplate k = b; k.job.merkleBranch.push_back({});
    Is(SameWork(a, k), false, "a changed merkle branch is new work");

    SoloTemplate l = b; l.txs.push_back(TemplateTx{});
    Is(SameWork(a, l), false, "a changed transaction set is new work");
}

// ---------------------------------------------------------------------------

int main()
{
    std::printf("\nsolo_template_test\n");
    TestHeights();
    TestTemplate();
    TestHostileNumbers();
    TestSameWork();
    std::printf("\n  %d checks, %d failure(s)\n\n", checks, failures);
    return failures ? 1 : 0;
}
