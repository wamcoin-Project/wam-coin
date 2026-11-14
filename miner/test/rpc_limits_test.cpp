// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  rpc_limits_test.cpp -- the other end chooses the size, so we choose the
//                         ceiling
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Reported by Martam, 13 November 2026. Two absences that compound:
//
//    RpcClient::Post read the node's reply until EOF with no Content-Length
//    check and no maximum, then buffered, parsed and hex-decoded the whole
//    of it. One getblocktemplate answer could exhaust the miner's memory in
//    a single poll.
//
//    SoloSession::Refresh remembered every distinct template's transactions,
//    capped by COUNT -- 4,096 entries -- and not by bytes. Measured at 3.4 MB
//    to 15.2 MB over a hundred refreshes of a 100 KB template on an unmoving
//    tip, linear, with the count cap nowhere near firing. The same cap is
//    about 400 MB at 100 KB a template and 4 GB at one megabyte.
//
//  The attacker is a hostile or compromised node, or anyone on the path: the
//  solo RPC link carries no TLS unless the build has libssl, which is the
//  same trust class as the fee-overflow finding beside it.
//
//  Both bounds are compiled down here so they can be reached in a test
//  without moving 64 MiB. A bound nobody has watched work is a comment.
// ===========================================================================

#define WAM_MINER_MAX_REPLY_BYTES  (64u * 1024u)

#include "rpc.h"

#include <atomic>
#include <chrono>
#include <cstdio>
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

/** A node that answers with a body of whatever size it was told. */
struct FakeNode {
    wam::sock_t listener = wam::kInvalidSock;
    uint16_t port = 0;
    size_t bodyBytes = 0;
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

        // Read the request, then answer. The body is sent in pieces, which is
        // what a large reply looks like on the wire and is the shape the cap
        // has to stop part-way through.
        char chunk[4096];
        for (int i = 0; i < 40; i++) {
            const long n = wam::RecvSome(peer, chunk, sizeof(chunk));
            if (n > 0) { if (std::string(chunk, size_t(n)).find("\r\n\r\n") != std::string::npos) break; continue; }
            if (n < 0 && wam::SockWouldBlock(wam::SockErr())) continue;
            break;
        }

        const std::string head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                                 "Connection: close\r\n\r\n";
        wam::SendSome(peer, head.data(), head.size());

        const std::string piece(8192, 'x');
        size_t sent = 0;
        while (!stop && sent < bodyBytes) {
            const size_t want = std::min(piece.size(), bodyBytes - sent);
            const long n = wam::SendSome(peer, piece.data(), want);
            if (n <= 0) break;
            sent += size_t(n);
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

/** Ask a fake node for something and report what came back, or the refusal. */
std::string Ask(size_t bodyBytes, size_t& got)
{
    FakeNode node;
    node.bodyBytes = bodyBytes;
    got = 0;
    if (!node.Start()) return "<no node>";

    wam::RpcClient rpc("127.0.0.1", node.port, "u", "p", "");
    std::string err;
    try {
        const wam::json::Value v = rpc.Call("getblocktemplate", "[]");
        (void)v;
        got = bodyBytes;
        return "";
    } catch (const std::exception& e) {
        err = e.what();
    }
    node.Stop();
    return err;
}

} // namespace

int main()
{
    std::printf("\n\033[1m  the other end chooses the size, so we choose the "
                "ceiling\033[0m\n\n");
    wam::SockStartup();

    std::printf("  the cap for this build is %zu KiB\n\n",
                wam::kMaxReplyBytes / 1024);

    // ---- a reply past the ceiling is refused, and says so ----------------
    {
        size_t got = 0;
        const std::string err = Ask(wam::kMaxReplyBytes * 4, got);
        if (err.find("MiB") != std::string::npos ||
            err.find("cut off") != std::string::npos) {
            Ok("a reply past the ceiling is cut off and named");
        } else if (err.empty()) {
            Bad("a reply past the ceiling is cut off and named",
                "it read " + std::to_string(got) + " bytes and asked for more: "
                "a node that never stops sending is a node that exhausts this "
                "process in one poll");
        } else {
            // Any refusal is better than none, but the message is what an
            // operator acts on.
            Bad("a reply past the ceiling is cut off and named",
                "it was refused for another reason: " + err);
        }
    }

    // ---- and an ordinary one is not --------------------------------------
    //
    // A ceiling that refuses honest work is worse than no ceiling: the miner
    // stops mining and nobody can tell why.
    {
        size_t got = 0;
        const std::string err = Ask(1024, got);
        if (err.find("cut off") != std::string::npos) {
            Bad("a small reply is not refused",
                "a 1 KiB reply hit a " + std::to_string(wam::kMaxReplyBytes) +
                " byte ceiling");
        } else {
            // It will fail to parse -- the body is 'x' -- and that is a
            // different error, which is the point.
            Ok("a small reply is not refused by the ceiling");
        }
    }

    std::printf("\n");
    if (!g_fail.empty()) {
        std::printf("\033[31m\033[1m  %zu failed\033[0m, %d passed\n\n",
                    g_fail.size(), g_pass);
        return 1;
    }
    std::printf("  %d passed: a reply the node sizes cannot size this "
                "process\n\n", g_pass);
    return 0;
}
