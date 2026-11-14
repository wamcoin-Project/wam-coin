// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  seed_flap_test.cpp -- a key that rotates every three days, announced
//                        every three seconds
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Reported by Martam, 13 November 2026. Stratum is a link the pool controls
//  -- and on a plaintext port, so is anyone standing in it -- and the RandomX
//  key comes down that link. PublishJob re-keyed on any seed change at all,
//  with no interval check, and a re-key in the default full-memory mode
//  rebuilds a 2 GiB dataset. Measured: 339.6 H/s on a stable seed, and
//  0 H/s for seven minutes against a pool alternating two seeds every three
//  seconds. SIGTERM did nothing either, because Poll() drained the whole
//  backlog before the main loop looked at `running` again.
//
//  The key rotates once per epoch -- 2048 blocks, about three days. So
//  every one of those seed changes was a lie the miner had no reason to
//  believe, and two defences follow from that:
//
//    a seed height never moves backwards   stratum.h, HandleLine
//    one rebuild per cooldown, last wins   main.cpp, PublishJob
//
//  This file tests the first, because it is the one that lives in a header a
//  test can drive: the alternating attack is A, B, A, B, and every return to
//  A is a seed for a height already seen.
//
//  It also checks the shutdown hook, because a defence that leaves the
//  process unkillable has moved the problem rather than fixed it.
// ===========================================================================

#include "stratum.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#ifndef _WIN32
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#endif

namespace {

int g_pass = 0;
std::vector<std::string> g_fail;

void Ok(const char* n) { ++g_pass; std::printf("  \033[32mok\033[0m    %s\n", n); }
void Bad(const char* n, const std::string& w)
{
    g_fail.push_back(n);
    std::printf("  \033[31mFAIL\033[0m  %s\n        %s\n", n, w.c_str());
}

const char* SEED_A = "aa";
const char* SEED_B = "bb";

std::string Seed(const char* two) { std::string s; for (int i=0;i<32;i++) s += two; return s; }

/** set_seedhash, as the pool sends it: [seed, seedHeight, height]. */
std::string SetSeed(const std::string& hex, long long seedHeight, long long height)
{
    return "{\"id\":null,\"method\":\"mining.set_seedhash\",\"params\":[\""
           + hex + "\"," + std::to_string(seedHeight) + ","
           + std::to_string(height) + "]}";
}

/** A pool on the loopback that says whatever it is told to say. */
struct FakePool {
    wam::sock_t listener = wam::kInvalidSock;
    uint16_t port = 0;
    std::vector<std::string> script;
    std::atomic<bool> stop{false};
    std::thread worker;

    bool Start()
    {
        listener = ::socket(AF_INET, SOCK_STREAM, 0);
        if (listener == wam::kInvalidSock) return false;
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (::bind(listener, reinterpret_cast<sockaddr*>(&a), sizeof(a)) != 0) return false;
        if (::listen(listener, 1) != 0) return false;
        socklen_t len = sizeof(a);
        if (::getsockname(listener, reinterpret_cast<sockaddr*>(&a), &len) != 0) return false;
        port = ntohs(a.sin_port);
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
            const long n = wam::RecvSome(peer, chunk, sizeof(chunk));
            if (n <= 0) {
                if (n < 0 && wam::SockWouldBlock(wam::SockErr())) continue;
                break;
            }
            buf.append(chunk, size_t(n));
            size_t nl;
            while ((nl = buf.find('\n')) != std::string::npos) {
                const std::string msg = buf.substr(0, nl);
                buf.erase(0, nl + 1);
                auto Send = [&](const std::string& s) {
                    const std::string out = s + "\n";
                    wam::SendSome(peer, out.data(), out.size());
                };
                if (msg.find("mining.subscribe") != std::string::npos) {
                    Send("{\"id\":1,\"error\":null,\"result\":[[[\"mining.set_difficulty\""
                         ",\"sd1\"],[\"mining.notify\",\"nt1\"]],\"a1b2c3d4\",4]}");
                } else if (msg.find("mining.authorize") != std::string::npos) {
                    Send("{\"id\":2,\"result\":true,\"error\":null}");
                    if (!sent) {
                        for (const auto& line : script) Send(line);
                        sent = true;
                    }
                }
            }
        }
        wam::CloseSock(peer);
    }

    void Stop()
    {
        stop = true;
        if (listener != wam::kInvalidSock) { wam::CloseSock(listener); listener = wam::kInvalidSock; }
        if (worker.joinable()) worker.join();
    }
};

/** Run the real client against a scripted pool and report the seed it ends on. */
std::string DriveAndReadSeed(const std::vector<std::string>& script,
                             std::atomic<bool>* stopFlag = nullptr)
{
    FakePool pool;
    pool.script = script;
    if (!pool.Start()) return "<no pool>";

    wam::StratumClient client("127.0.0.1", pool.port, "Waddr", "x");
    if (stopFlag) client.StopOn(*stopFlag);

    std::string err;
    if (!client.Connect(err)) { pool.Stop(); return "<no connect>"; }

    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (std::chrono::steady_clock::now() < until) {
        client.Poll();
        if (stopFlag && !stopFlag->load()) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    const std::string seed = wam::ToHex(client.LastSeed());
    client.Close();
    pool.Stop();
    return seed;
}

} // namespace

int main()
{
    std::printf("\n\033[1m  a key that rotates every three days, announced "
                "every three seconds\033[0m\n\n");
    wam::SockStartup();

    const std::string a = Seed(SEED_A), b = Seed(SEED_B);

    // ---- the first key is always taken -----------------------------------
    {
        const std::string got = DriveAndReadSeed({ SetSeed(a, 40960, 41000) });
        if (got == a) Ok("the first key a pool announces is taken");
        else Bad("the first key a pool announces is taken", "ended on " + got);
    }

    // ---- a real rotation is taken ----------------------------------------
    {
        const std::string got = DriveAndReadSeed({
            SetSeed(a, 40960, 41000),
            SetSeed(b, 43008, 43050),      // one epoch on: 2048 blocks later
        });
        if (got == b) Ok("a key for a later height replaces it");
        else Bad("a key for a later height replaces it", "ended on " + got);
    }

    // ---- THE ATTACK: A, B, A, B ------------------------------------------
    //
    // Every return to A is a key for a height already announced. One of them
    // is enough to make the point; the flap sends dozens a minute.
    {
        const std::string got = DriveAndReadSeed({
            SetSeed(a, 40960, 41000),
            SetSeed(b, 43008, 43050),
            SetSeed(a, 40960, 41000),      // backwards
            SetSeed(b, 43008, 43050),
            SetSeed(a, 40960, 41000),      // backwards
        });
        if (got == b) {
            Ok("a key announced for a height already seen is refused");
        } else {
            Bad("a key announced for a height already seen is refused",
                "the client ended on " + got + ", so every one of those "
                "changes would have rebuilt a 2 GiB dataset");
        }
    }

    // ---- and the same height, same key, is not a change ------------------
    {
        const std::string got = DriveAndReadSeed({
            SetSeed(a, 40960, 41000),
            SetSeed(a, 40960, 41000),
            SetSeed(a, 40960, 41000),
        });
        if (got == a) Ok("repeating the same key changes nothing");
        else Bad("repeating the same key changes nothing", "ended on " + got);
    }

    // ---- a shutdown lands inside the drain, not after it -----------------
    {
        std::vector<std::string> flood;
        for (int i = 0; i < 400; i++) {
            flood.push_back(SetSeed(a, 40960 + i, 41000 + i));
        }
        std::atomic<bool> running{true};
        FakePool pool;
        pool.script = flood;
        if (!pool.Start()) {
            Bad("a shutdown lands inside the line drain", "no pool");
        } else {
            wam::StratumClient client("127.0.0.1", pool.port, "Waddr", "x");
            client.StopOn(running);
            std::string err;
            int handled = 0;
            if (client.Connect(err)) {
                            client.onSeed = [&](const wam::Bytes&) {
                    if (++handled == 3) running.store(false);
                };
                const auto until = std::chrono::steady_clock::now()
                                   + std::chrono::seconds(3);
                while (std::chrono::steady_clock::now() < until && running.load()) {
                    client.Poll();
                    std::this_thread::sleep_for(std::chrono::milliseconds(5));
                }
                client.Poll();      // one more, which must return at once
            }
            client.Close();
            pool.Stop();
            // Three lines set the flag. One more may be in flight, so the
            // honest bound is a handful -- not "fewer than everything",
            // which a buffer boundary would satisfy on its own. Without the
            // break, one recv's worth of lines is drained whatever the flag
            // says, and one recv is 8 KiB of these: about ninety.
            if (handled >= 3 && handled <= 8) {
                Ok("a shutdown lands inside the line drain");
            } else {
                Bad("a shutdown lands inside the line drain",
                    "handled " + std::to_string(handled) + " lines; three "
                    "cleared the flag, so everything after that was work the "
                    "process did while being asked to stop");
            }
        }
    }

    std::printf("\n");
    if (!g_fail.empty()) {
        std::printf("\033[31m\033[1m  %zu failed\033[0m, %d passed\n\n",
                    g_fail.size(), g_pass);
        return 1;
    }
    std::printf("  %d passed: a key does not move backwards, and a shutdown "
                "is not queued\n\n", g_pass);
    return 0;
}
