// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  stratum_state_test.cpp -- surviving a hostile line is not the same as
//                            being right afterwards
// ===========================================================================
//
//  WHY THIS EXISTS, BESIDE stratum_hostile_test.cpp
//
//  That file asks one question, and asks it well: does the miner die? It
//  raises a pool on the loopback, sends one bad line, drives Poll() with no
//  try/catch the way main.cpp does, and the assertion is that the process
//  reaches the end.
//
//  Every finding it was written for killed the miner. The two that arrived
//  on 26 November 2026 did not:
//
//    * mining.set_seedhash with the height left off wedges the miner on a
//      RandomX key the pool has already left, for the rest of the epoch --
//      about three days. The process is alive, connected, and hashing
//      against the wrong key, so every share it finds is rejected.
//
//    * mining.set_difficulty with a value below 2^-32 makes every hash a
//      share. The process is alive and floods the pool until it is banned.
//
//  Both are states, not crashes, and a harness that only asks "did it die?"
//  cannot see either. So this one records what the miner ADOPTS -- the seed
//  it would hash against, the difficulty it would measure shares with -- and
//  asserts that.
//
//  Reported by mpit, 26 November 2026, items 2 and 4.
//
//  Build:
//      g++ -std=c++17 -I miner/src -pthread -o stratum_state \
//          miner/test/stratum_state_test.cpp
// ===========================================================================

#include "stratum.h"
#include "util.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#  define CLOSESOCK closesocket
#else
#  define CLOSESOCK close
#endif

static int g_pass = 0;
static std::vector<std::string> g_fail;

static void Check(const char* name, bool ok, const std::string& detail = "")
{
    if (ok) {
        ++g_pass;
        std::printf("  ok    %s\n", name);
    } else {
        g_fail.emplace_back(name);
        std::printf("  FAIL  %s\n", name);
        if (!detail.empty()) std::printf("        %s\n", detail.c_str());
    }
}

// Two keys, as different as two hex strings can be.
static const char* SEED_A =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static const char* SEED_B =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

static std::string Notify(const char* jobId, const char* seedHex)
{
    // [jobId, prevhash, coinb1, coinb2, merkle[], version, nbits, ntime,
    //  cleanJobs, seed] -- exactly what HandleNotify reads.
    std::string s = "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"";
    s += jobId;
    s += "\",\"";
    s += std::string(64, '1');          // prevhash, 32 bytes
    s += "\",\"00\",\"00\",[],\"20000000\",\"1d00ffff\",\"67000000\",false,\"";
    s += seedHex;
    s += "\"]}";
    return s;
}

// THE SHAPE OUR POOL ACTUALLY SENDS, which is not the shape the older
// hostile test called "ordinary".
//
// pool/lib/stratumServer.js:308 sends
//     mining.set_seedhash [seedHex, job.seedHeight, job.height]
// so the epoch height is parameter ONE and the block height is parameter
// two, which is what miner/src/stratum.h reads.
//
// stratum_hostile_test.cpp builds its benign control as [seed, "x", 12345]
// -- a string at parameter one. That is not an ordinary line, it is the
// attack in this file's second case, and it passed there only because that
// test asks whether the miner died and never what it was left mining.
static std::string SetSeed(const char* seedHex, const char* heightLiteralOrNull)
{
    std::string s = "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\"";
    s += seedHex;
    s += "\"";
    if (heightLiteralOrNull) {
        s += ",";
        s += heightLiteralOrNull;      // parameter 1: the epoch height
        s += ",";
        s += heightLiteralOrNull;      // parameter 2: the block height
    }
    s += "]}";
    return s;
}

static std::string Hex(const wam::Bytes& b)
{
    static const char* digits = "0123456789abcdef";
    std::string out;
    out.reserve(b.size() * 2);
    for (uint8_t c : b) { out += digits[c >> 4]; out += digits[c & 15]; }
    return out;
}

// ---------------------------------------------------------------------------
//  A pool that answers the handshake and then says a SEQUENCE of things.
// ---------------------------------------------------------------------------
struct ScriptedPool {
    wam::sock_t listener = wam::kInvalidSock;
    uint16_t port = 0;
    std::thread worker;
    std::atomic<bool> stop{false};
    std::vector<std::string> script;

    bool Start(std::vector<std::string> lines)
    {
        script = std::move(lines);
        listener = ::socket(AF_INET, SOCK_STREAM, 0);
        if (listener == wam::kInvalidSock) return false;

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;
        if (::bind(listener, (sockaddr*)&addr, sizeof(addr)) != 0) return false;
        if (::listen(listener, 1) != 0) return false;

        socklen_t len = sizeof(addr);
        if (::getsockname(listener, (sockaddr*)&addr, &len) != 0) return false;
        port = ntohs(addr.sin_port);

        worker = std::thread([this] { Serve(); });
        return true;
    }

    void Serve()
    {
        wam::sock_t peer = ::accept(listener, nullptr, nullptr);
        if (peer == wam::kInvalidSock) return;

        std::string buf;
        char chunk[2048];
        bool played = false;
        auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);

        while (!stop && std::chrono::steady_clock::now() < deadline) {
            int n = ::recv(peer, chunk, sizeof(chunk), 0);
            if (n <= 0) break;
            buf.append(chunk, size_t(n));

            size_t nl;
            while ((nl = buf.find('\n')) != std::string::npos) {
                const std::string msg = buf.substr(0, nl);
                buf.erase(0, nl + 1);

                auto Send = [&](const std::string& s) {
                    const std::string out = s + "\n";
                    ::send(peer, out.data(), int(out.size()), 0);
                };

                if (msg.find("mining.subscribe") != std::string::npos) {
                    Send("{\"id\":1,\"error\":null,\"result\":[[[\"mining.set_difficulty\""
                         ",\"sd1\"],[\"mining.notify\",\"nt1\"]],\"a1b2c3d4\",4]}");
                } else if (msg.find("mining.authorize") != std::string::npos) {
                    Send("{\"id\":2,\"result\":true,\"error\":null}");
                    if (!played) {
                        played = true;
                        // In order, with a gap, so the client processes each
                        // before the next arrives -- which is what a pool
                        // sending them seconds apart looks like.
                        for (const auto& line : script) {
                            if (stop) break;
                            Send(line);
                            std::this_thread::sleep_for(
                                std::chrono::milliseconds(120));
                        }
                    }
                }
            }
        }
        CLOSESOCK(peer);
    }

    void Stop()
    {
        stop = true;
        if (listener != wam::kInvalidSock) {
            CLOSESOCK(listener);
            listener = wam::kInvalidSock;
        }
        if (worker.joinable()) worker.join();
    }
};

// What the miner would actually act on.
struct Adopted {
    std::mutex mu;
    std::vector<std::string> jobSeeds;    // hex, in the order onJob saw them
    std::vector<std::string> seedEvents;  // hex, from onSeed
    std::vector<double>      difficulties;
    bool connected = false;
    bool survived = false;
};

static void Play(const std::vector<std::string>& script, Adopted& out,
                 int seconds = 4)
{
    ScriptedPool pool;
    if (!pool.Start(script)) { std::printf("        (no socket)\n"); return; }

    wam::StratumClient client("127.0.0.1", pool.port,
                              "WSMbshr6iKbzQBEbk1WK5UxDcp2EK5Vszb.test", "");

    client.onJob = [&out](const wam::StratumJob& j) {
        std::lock_guard<std::mutex> lk(out.mu);
        out.jobSeeds.push_back(Hex(j.seed));
    };
    client.onSeed = [&out](const wam::Bytes& s) {
        std::lock_guard<std::mutex> lk(out.mu);
        out.seedEvents.push_back(Hex(s));
    };
    client.onDifficulty = [&out](double d) {
        std::lock_guard<std::mutex> lk(out.mu);
        out.difficulties.push_back(d);
    };

    std::string err;
    if (!client.Connect(err)) {
        std::printf("        (connect failed: %s)\n", err.c_str());
        pool.Stop();
        return;
    }

    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
    while (std::chrono::steady_clock::now() < deadline) {
        client.Poll();
    }

    out.connected = client.IsConnected();
    out.survived = true;
    client.Close();
    pool.Stop();
}

static std::string Last(const std::vector<std::string>& v)
{
    return v.empty() ? std::string("(none)") : v.back();
}

int main()
{
#ifdef _WIN32
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
    std::printf("\n  what the miner is left mining after a hostile line\n\n");

    // ---- the control -----------------------------------------------------
    {
        Adopted a;
        Play({ Notify("j1", SEED_B) }, a);
        Check("a plain notify is adopted: the job carries the key it sent",
              a.survived && Last(a.jobSeeds) == std::string(SEED_B),
              "adopted " + Last(a.jobSeeds));
    }

    // ---- mpit #2: the height left off ------------------------------------
    //
    // set_seedhash with no height parses as AsInt(-1), which skips the
    // backwards guard and then writes -1 into m_announcedSeedHeight. From
    // that moment contradictsAnnouncement can never fire again -- it needs
    // m_announcedSeedHeight >= 0 -- and m_previousSeed holds the pool's real
    // key, so the pool's next honest notify carrying it is read as a replay
    // and refused.
    {
        Adopted a;
        Play({ Notify("j1", SEED_B),            // the pool's real key
               SetSeed(SEED_A, nullptr),        // injected, no height
               Notify("j2", SEED_B) },          // the pool, honest again
             a);
        Check("an unheighted set_seedhash does not capture the miner",
              a.survived && Last(a.jobSeeds) == std::string(SEED_B),
              "the pool sent " + std::string(SEED_B) + " and the miner adopted "
              + Last(a.jobSeeds));
    }

    // ---- mpit #2b: and the pool can still correct it ----------------------
    {
        Adopted a;
        Play({ Notify("j1", SEED_B),
               SetSeed(SEED_A, nullptr),
               SetSeed(SEED_B, "43008") },      // the pool re-announces
             a);
        bool recovered = false;
        {
            std::lock_guard<std::mutex> lk(a.mu);
            for (const auto& s : a.seedEvents) {
                if (s == std::string(SEED_B)) recovered = true;
            }
            // The LAST thing it was told to use must be the pool's key.
            recovered = recovered && Last(a.seedEvents) == std::string(SEED_B);
        }
        Check("and the pool's own re-announcement is still accepted after it",
              a.survived && recovered,
              "last key the miner was given: " + Last(a.seedEvents));
    }

    // ---- mpit #4: a difficulty that makes every hash a share --------------
    //
    // No socket needed: this is arithmetic, and the arithmetic is the bug.
    // round(1e-12 * 2^32) is 0, and the zero is clamped UP to 1, which is the
    // largest target the function can return -- every hash beats it.
    {
        const wam::Target tiny   = wam::DifficultyToTarget(1e-12);
        const wam::Target floorD = wam::DifficultyToTarget(1e-9);
        // "Easier" means a numerically larger target, because MeetsTarget is
        // memcmp(hash, target) <= 0.
        const bool easier = std::memcmp(tiny.bytes, floorD.bytes, 32) > 0;
        Check("a difficulty below 2^-32 is not easier than the pool's own floor",
              !easier,
              easier ? "1e-12 yields a strictly larger (easier) target than 1e-9"
                     : "");
    }

    // ---- and the client should not hand one up at all ---------------------
    {
        Adopted a;
        Play({ "{\"id\":null,\"method\":\"mining.set_difficulty\","
               "\"params\":[1e-12]}" }, a);
        bool adopted = false;
        {
            std::lock_guard<std::mutex> lk(a.mu);
            for (double d : a.difficulties) if (d > 0 && d < 1e-9) adopted = true;
        }
        Check("the client refuses a share difficulty below the pool's floor",
              a.survived && !adopted,
              adopted ? "onDifficulty was called with a value under 1e-9" : "");
    }

    // ---- the direction of the clamp, for the values nothing can send ------
    //
    // GetDifficulty() returns `d > 0 ? d : 1.0`, so the live caller never
    // reaches this branch. It is still the wrong way round, and the comment
    // beside it says "impossible to beat" over a target every hash beats. A
    // defensive branch that is wrong is a trap for the next caller.
    {
        const wam::Target zero = wam::DifficultyToTarget(0.0);
        bool allOnes = true;
        for (int i = 0; i < 32; i++) if (zero.bytes[i] != 0xFF) allOnes = false;
        Check("difficulty 0 gives the HARDEST target, not the easiest",
              !allOnes,
              allOnes ? "0 returns 32 bytes of 0xFF, which every hash beats"
                      : "");
    }

    // ---- the sweep: a malformed frame must change nothing -----------------
    //
    // Not one remembered line. For every shape a field can arrive in, the
    // assertion is the same: the miner is still mining the pool's key.
    {
        const std::vector<std::pair<const char*, std::string>> malformed = {
            {"a seed that is not hex",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\"zz\"]}"},
            {"a seed of the wrong length",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\"abcd\"]}"},
            {"a seed that is a number",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[12345]}"},
            {"a seed that is null",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[null]}"},
            {"no params at all",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[]}"},
            {"params that are not an array",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":{}}"},
            {"a height that is a string",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\""
             + std::string(SEED_A) + "\",\"notanumber\",1]}"},
            {"a height that is negative",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\""
             + std::string(SEED_A) + "\",-5,1]}"},
            {"a height larger than any int64",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\""
             + std::string(SEED_A) + "\",1e300,1]}"},
            {"a height that is null",
             "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\""
             + std::string(SEED_A) + "\",null,1]}"},
            {"a notify with too few parameters",
             "{\"id\":null,\"method\":\"mining.notify\",\"params\":[\"j\"]}"},
            {"a method nobody implements",
             "{\"id\":null,\"method\":\"mining.nonsense\",\"params\":[1,2,3]}"},
        };

        for (const auto& kv : malformed) {
            Adopted a;
            Play({ Notify("j1", SEED_B), kv.second, Notify("j2", SEED_B) }, a);
            const bool ok = a.survived && a.connected
                            && Last(a.jobSeeds) == std::string(SEED_B);
            Check(kv.first, ok,
                  "after this frame the miner was on " + Last(a.jobSeeds)
                  + (a.connected ? "" : " and had been disconnected"));
        }
    }

    std::printf("\n");
    if (g_fail.empty()) {
        std::printf("  %d passed: a hostile line leaves the miner where it was\n\n",
                    g_pass);
        return 0;
    }
    std::printf("  %zu failed, %d passed\n", g_fail.size(), g_pass);
    for (const auto& f : g_fail) std::printf("    - %s\n", f.c_str());
    std::printf("\n");
    return 1;
}
