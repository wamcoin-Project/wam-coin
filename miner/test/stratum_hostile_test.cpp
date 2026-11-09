// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  stratum_hostile_test.cpp -- one bad line from the pool is one bad line
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  On 8 November 2026 json::Value::AsInt() was made to refuse a number that
//  cannot be an int64_t, because a bare cast was undefined and the miner hung
//  on what it produced. It refused by throwing. The solo path catches; the
//  stratum path caught nothing, and neither did the pool loop in main.cpp.
//
//  So the fix for a hang became a kill. One line from the pool side --
//
//      {"id":1e300,"result":true,"error":null}
//
//  -- reached std::terminate, and the reference miner speaks no TLS, so
//  every connection it makes is plaintext and anyone on the path can send
//  that line. Every miner on a pool, dead together, and dead again on each
//  reconnect.
//
//  Reported by Radenlingga (@stokraden45506) on 9 November 2026 against
//  c10e015, a day after the fix that created it shipped to main. No release
//  carried it: v0.1.13 is from 31 October, and the throw landed on the 8th.
//
//  HOW IT ASKS
//
//  A listening socket on the loopback that speaks the three lines of stratum
//  the client needs -- subscribe, authorize -- and then sends one hostile
//  line. The client is driven exactly as miner/src/main.cpp drives it: Poll()
//  in a loop with NO try/catch around it. If the line escapes, this process
//  dies the way a miner's would, and the test fails by not finishing.
//
//  Run against the 9 November code it passes. Against the code of the 8th it
//  aborts on the first hostile case.
//
//  Build:
//      g++ -std=c++17 -I miner/src -pthread -o stratum_hostile \
//          miner/test/stratum_hostile_test.cpp
// ===========================================================================

#include "stratum.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
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

static void Check(const char* name, bool ok)
{
    if (ok) { ++g_pass; std::printf("  ok    %s\n", name); }
    else    { g_fail.emplace_back(name); std::printf("  FAIL  %s\n", name); }
}

static const char* SEED64 =
    "abababababababababababababababababababababababababababababababab";

// ---------------------------------------------------------------------------
//  A pool that answers the handshake and then says one thing.
// ---------------------------------------------------------------------------
struct FakePool {
    wam::sock_t listener = wam::kInvalidSock;
    uint16_t port = 0;
    std::thread worker;
    std::atomic<bool> stop{false};
    std::string line;          // what it sends after authorize

    bool Start(const std::string& hostileLine)
    {
        line = hostileLine;
        listener = ::socket(AF_INET, SOCK_STREAM, 0);
        if (listener == wam::kInvalidSock) return false;

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;                       // the OS picks one
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
        char chunk[1024];
        bool sent = false;
        auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);

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
                    if (!sent) { Send(line); sent = true; }
                }
            }
        }
        CLOSESOCK(peer);
    }

    void Stop()
    {
        stop = true;
        if (listener != wam::kInvalidSock) { CLOSESOCK(listener); listener = wam::kInvalidSock; }
        if (worker.joinable()) worker.join();
    }
};

// ---------------------------------------------------------------------------
//  Drive the client the way main.cpp drives it: no try/catch anywhere.
// ---------------------------------------------------------------------------
static bool SurvivesLine(const std::string& hostileLine, bool& stillConnected)
{
    FakePool pool;
    if (!pool.Start(hostileLine)) { std::printf("        (no socket)\n"); return false; }

    wam::StratumClient client("127.0.0.1", pool.port,
                              "WSMbshr6iKbzQBEbk1WK5UxDcp2EK5Vszb.test", "");
    std::string err;
    if (!client.Connect(err)) {
        std::printf("        (connect failed: %s)\n", err.c_str());
        pool.Stop();
        return false;
    }

    // miner/src/main.cpp calls client.Poll() bare, inside Run(). Anything
    // that escapes Poll() is what escapes there.
    //
    // Bounded by the clock and not by a count: stratum.h sets SO_RCVTIMEO to
    // one second so that CheckSilence() always gets to run, which means each
    // quiet Poll() costs a second. Two hundred of them is seventeen minutes
    // for a test that needs three seconds, and a test nobody will wait for
    // is a test nobody runs.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (std::chrono::steady_clock::now() < deadline) {
        client.Poll();
    }

    stillConnected = client.IsConnected();
    client.Close();
    pool.Stop();
    return true;      // reaching this line at all is the assertion
}

int main()
{
#ifdef _WIN32
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
    std::printf("\n  a hostile pool line does not kill the miner\n\n");

    // ---- the control: an ordinary line is handled ------------------------
    {
        bool connected = false;
        const std::string benign =
            std::string("{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\"")
            + SEED64 + "\",\"x\",12345]}";
        const bool lived = SurvivesLine(benign, connected);
        Check("an ordinary set_seedhash is handled and the miner keeps mining",
              lived && connected);
    }

    // ---- the height nobody has to make sense of --------------------------
    //
    // This one killed the miner to write a log line. The seed had already
    // parsed; the height was decoration.
    {
        bool connected = false;
        const std::string hostile =
            std::string("{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\"")
            + SEED64 + "\",\"x\",1e300]}";
        const bool lived = SurvivesLine(hostile, connected);
        Check("a set_seedhash height of 1e300 does not abort the process", lived);
        Check("and the connection is kept, so the next notify still arrives",
              connected);
    }

    // ---- the id of any response at all -----------------------------------
    {
        bool connected = false;
        const bool lived = SurvivesLine("{\"id\":1e300,\"result\":true,\"error\":null}",
                                        connected);
        Check("a response id of 1e300 does not abort the process", lived);
        Check("and that connection is kept too", connected);
    }

    // ---- the extranonce the pool asks for --------------------------------
    {
        bool connected = false;
        const bool lived = SurvivesLine(
            "{\"id\":null,\"method\":\"mining.set_extranonce\",\"params\":[\"aabbccdd\",1e300]}",
            connected);
        Check("a set_extranonce size of 1e300 does not abort the process", lived);
    }

    // ---- and the values themselves are still refused ---------------------
    //
    // The point was never to start accepting them. AsInt() with no fallback
    // still throws; AsInt(fallback) gives the caller what the caller asked
    // for. Neither can hand back a garbage integer, which is what the
    // 8 November report was about.
    {
        wam::json::Value v;
        std::string e;
        const bool parsed = wam::json::ParseLine("{\"n\":1e300}", v, e);
        Check("a 1e300 parses as a number", parsed && v["n"].AsNumber(0) > 1e299);

        bool threw = false;
        try { (void)v["n"].AsInt(); } catch (const std::exception&) { threw = true; }
        Check("AsInt() with no fallback still refuses it", threw);

        Check("AsInt(fallback) gives the caller the fallback instead",
              v["n"].AsInt(-7) == -7);

        wam::json::Value absent;
        Check("and a missing field still gives the fallback",
              absent["nope"].AsInt(42) == 42);
    }

    std::printf("\n");
    if (g_fail.empty()) {
        std::printf("  %d passed: a bad line costs a log line, not the miner\n\n", g_pass);
        return 0;
    }
    std::printf("  %zu failed, %d passed\n", g_fail.size(), g_pass);
    for (const auto& f : g_fail) std::printf("    - %s\n", f.c_str());
    std::printf("\n");
    return 1;
}
