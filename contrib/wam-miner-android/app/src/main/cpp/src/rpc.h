// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  rpc.h -- ask the node a question, over HTTP, the way bitcoin-cli does
// ===========================================================================
//
//  Mining alone means talking to a node instead of to a pool: getblocktemplate
//  to learn what to build, submitblock to hand back what was built. Both are
//  JSON-RPC over HTTP, and the node answers on 9554.
//
//  WHY THIS IS SMALL AND DELIBERATELY DULL
//
//  It speaks exactly enough HTTP to post a body and read one back: a request
//  line, four headers, Basic auth, and a reply whose length the node always
//  declares. No chunked encoding, no keep-alive, no redirects, no TLS. The
//  node is on the same machine or the same room; a general HTTP client here
//  would be more code to be wrong in.
//
//  HOW IT AUTHENTICATES
//
//  Two ways, and the second is the one most people will use without knowing
//  it exists:
//
//    1. rpcuser / rpcpassword from wam.conf, passed on the command line.
//    2. The cookie. A node with no rpcuser writes <datadir>/.cookie at
//       startup, containing `__cookie__:<random>`, and that is exactly a
//       Basic auth pair. bitcoin-cli reads it and so does this. It means a
//       miner on the same machine needs no credentials at all -- and a node
//       that is restarted writes a new one, so it is read per call rather
//       than once.
//
//  WHAT IT REFUSES TO GUESS
//
//  An HTTP 401 is reported as an authentication failure and not as a network
//  problem, because the two are fixed differently and a miner told "could not
//  reach the node" will spend the evening on the firewall.
// ===========================================================================

#pragma once

#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "json.h"
#include "platform.h"
#include "util.h"

namespace wam {

/** RFC 4648 base64, for the one Authorization header. */
inline std::string Base64(const std::string& in)
{
    static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                           "abcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    size_t i = 0;
    while (i + 2 < in.size()) {
        const uint32_t v = (uint8_t(in[i]) << 16) | (uint8_t(in[i + 1]) << 8) |
                            uint8_t(in[i + 2]);
        out += t[(v >> 18) & 63]; out += t[(v >> 12) & 63];
        out += t[(v >> 6) & 63];  out += t[v & 63];
        i += 3;
    }
    if (i + 1 == in.size()) {
        const uint32_t v = uint32_t(uint8_t(in[i])) << 16;
        out += t[(v >> 18) & 63]; out += t[(v >> 12) & 63];
        out += "==";
    } else if (i + 2 == in.size()) {
        const uint32_t v = (uint32_t(uint8_t(in[i])) << 16) |
                           (uint32_t(uint8_t(in[i + 1])) << 8);
        out += t[(v >> 18) & 63]; out += t[(v >> 12) & 63];
        out += t[(v >> 6) & 63];  out += '=';
    }
    return out;
}

/**
 * Every datadir a wamd on this machine could be using, best guess first.
 *
 * bitcoin-cli finds the cookie without being told, and a miner on the same
 * machine as its node should not be harder to start than that. These are the
 * datadirs wamd itself uses, taken from its GetDefaultDataDir and not from
 * memory.
 *
 * THE NAME CHANGED AND THE DATADIRS DID NOT.
 *
 * Before v0.1.10 a WAM node on Windows and macOS stored its chain in a folder
 * called **Bitcoin** -- `rename_binaries.py` carried the Linux line and not
 * the other two. v0.1.10 fixed the name for new datadirs and deliberately
 * keeps an existing one where it is, so nobody's chain moves under them. The
 * consequence is that most Windows nodes on this network today are running
 * out of `%LOCALAPPDATA%\Bitcoin` and will be for a long time.
 *
 * This function looked only for WAM. So a miner on a perfectly healthy node
 * was told
 *
 *     cannot read the cookie at C:\Users\x\AppData\Local\WAM\.cookie
 *     Is the node running, and is this the right datadir?
 *
 * which reads as "your node is down" to somebody whose node is up. It
 * happened to the first person who tried solo mining after v0.1.10 was
 * announced, on 2026-09-26, and cost him the evening's start.
 *
 * So all of them are tried, in the order wamd itself would have used, and the
 * error names every path that was looked at rather than one. Linux is a
 * single entry: `~/.wam` has been correct since the first build.
 */
inline std::vector<std::string> CookieCandidates(const std::string& network)
{
    std::vector<std::string> dirs;
#ifdef _WIN32
    const char* roaming = std::getenv("APPDATA");
    const char* local   = std::getenv("LOCALAPPDATA");
    // wamd keeps an existing datadir under Roaming if it finds one, and
    // starts new ones under Local. Same order here, same reason -- and the
    // pre-v0.1.10 name is tried after the current one at each location, so a
    // machine that has both prefers the one this release would create.
    if (roaming) dirs.push_back(std::string(roaming) + "\\WAM");
    if (local)   dirs.push_back(std::string(local)   + "\\WAM");
    if (roaming) dirs.push_back(std::string(roaming) + "\\Bitcoin");
    if (local)   dirs.push_back(std::string(local)   + "\\Bitcoin");
    const char sep = '\\';
#else
    const char* home = std::getenv("HOME");
    if (!home) return dirs;
#ifdef __APPLE__
    dirs.push_back(std::string(home) + "/Library/Application Support/WAM");
    dirs.push_back(std::string(home) + "/Library/Application Support/Bitcoin");
#else
    dirs.push_back(std::string(home) + "/.wam");
#endif
    const char sep = '/';
#endif

    // Mainnet lives in the datadir itself; the test chains each get a
    // subdirectory, named by the daemon and not by us.
    std::string sub;
    if (network == "testnet")      sub = std::string(1, sep) + "testnet3";
    else if (network == "regtest") sub = std::string(1, sep) + "regtest";

    std::vector<std::string> out;
    out.reserve(dirs.size());
    for (const std::string& d : dirs) out.push_back(d + sub + sep + ".cookie");
    return out;
}

/** The first candidate that exists, or the first candidate if none do. */
inline std::string DefaultCookiePath(const std::string& network)
{
    const std::vector<std::string> c = CookieCandidates(network);
    if (c.empty()) return std::string();
    for (const std::string& p : c) {
        std::ifstream probe(p, std::ios::binary);
        if (probe) return p;
    }
    return c.front();
}

class RpcClient {
public:
    RpcClient(std::string host, int port, std::string user,
              std::string password, std::string cookiePath,
              std::string network = "mainnet")
        : m_host(std::move(host)), m_port(port), m_user(std::move(user)),
          m_pass(std::move(password)), m_cookie(std::move(cookiePath)),
          m_network(std::move(network)) {}

    /**
     * One call. Returns the `result` member, or throws with what the node
     * said -- its message, not ours, because the node knows why.
     */
    json::Value Call(const std::string& method, const std::string& paramsJson)
    {
        const std::string body =
            "{\"jsonrpc\":\"1.0\",\"id\":\"wam-miner\",\"method\":\"" + method +
            "\",\"params\":" + (paramsJson.empty() ? "[]" : paramsJson) + "}";

        int status = 0;
        const std::string reply = Post(body, status);

        if (status == 401) {
            throw std::runtime_error(
                "the node refused the credentials (HTTP 401). Either pass "
                "--rpcuser and --rpcpassword matching wam.conf, or let the "
                "miner read <datadir>/.cookie -- which only works if the node "
                "has no rpcuser set.");
        }

        json::Value root;
        std::string jsonError;
        if (!json::ParseLine(reply, root, jsonError)) {
            throw std::runtime_error("the node's reply was not JSON (" +
                                     jsonError + "): " + reply.substr(0, 160));
        }

        const json::Value& err = root["error"];
        if (!err.IsNull()) {
            const std::string msg = err["message"].AsString();
            throw std::runtime_error(method + ": " +
                (msg.empty() ? "the node returned an error" : msg));
        }

        // A null result is not an error and must not be treated as one.
        //
        // JSON-RPC answers every successful call with both members present,
        // and `error` above is the one that says whether it went wrong. Null
        // is the SUCCESS value for the two calls this miner cares about most:
        // submitblock answers null when a block is accepted, and
        // getblocktemplate in proposal mode answers null when the block it
        // was shown is valid.
        //
        // Throwing on it cost an evening: the first correctly built block
        // this miner ever proposed was accepted by the node and reported here
        // as "the reply carried no result".
        return root["result"];
    }

private:
    /** Basic auth pair, read fresh: a restarted node writes a new cookie. */
    std::string Credentials() const
    {
        if (!m_user.empty()) return m_user + ":" + m_pass;
        if (m_cookie.empty()) {
            throw std::runtime_error(
                "no RPC credentials. Pass --rpcuser and --rpcpassword, or "
                "--rpccookie pointing at the node's .cookie file.");
        }
        std::ifstream f(m_cookie, std::ios::binary);
        if (!f) {
            // Name every path that was looked at. One path in the message
            // reads as "your node is down" to somebody whose node is up in a
            // folder this miner did not think to open -- which is the whole
            // Windows population that started before v0.1.10.
            std::string tried;
            for (const std::string& p : CookieCandidates(m_network)) {
                tried += "\n    " + p;
            }
            throw std::runtime_error(
                "cannot read the cookie at " + m_cookie +
                ". Is the node running, and is this the right datadir?"
                "\n  Looked in:" + (tried.empty() ? std::string("\n    (nowhere: no HOME or APPDATA)") : tried) +
                "\n  Pass --rpccookie with the path to your node's .cookie if "
                "it is somewhere else.");
        }
        std::string line;
        std::getline(f, line);
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
            line.pop_back();
        }
        if (line.find(':') == std::string::npos) {
            throw std::runtime_error("the cookie at " + m_cookie +
                                     " is not in user:password form");
        }
        return line;
    }

    std::string Post(const std::string& body, int& status)
    {
        // Windows will not do networking until Winsock has been started, and
        // this is the first network call --solo and --check ever make.
        //
        // Without it getaddrinfo fails on Windows for every host, including a
        // plain 127.0.0.1, and the miner reports
        //
        //     error  cannot resolve 127.0.0.1
        //
        // which reads as a wrong address to somebody whose address is right.
        // stratum.h has always called this before connecting, so mining to a
        // pool has worked on Windows since v0.1.8 while mining alone could
        // never have worked there at all. It was never run on Windows until
        // the platform gate ran it on 2026-09-25, and it failed on its first
        // attempt.
        //
        // SockStartup is idempotent -- a function-local static -- so calling
        // it on every request costs one comparison.
        if (!SockStartup()) {
            throw std::runtime_error(
                "the operating system's networking could not be started");
        }

        addrinfo hints{};
        hints.ai_family   = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;

        addrinfo* res = nullptr;
        const std::string portStr = std::to_string(m_port);
        const int rc = getaddrinfo(m_host.c_str(), portStr.c_str(), &hints, &res);
        if (rc != 0 || !res) {
            // Say what the resolver said. "cannot resolve 127.0.0.1" with no
            // reason sent this bug looking in the wrong place for an hour.
            throw std::runtime_error("cannot resolve " + m_host + ": " +
                                     gai_strerror(rc));
        }

        sock_t s = kInvalidSock;
        for (addrinfo* a = res; a; a = a->ai_next) {
            s = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
            if (s == kInvalidSock) continue;
            SetSockTimeout(s, SO_RCVTIMEO, 30);
            SetSockTimeout(s, SO_SNDTIMEO, 30);
            if (ConnectTo(s, a->ai_addr, a->ai_addrlen) == 0) break;
            CloseSock(s);
            s = kInvalidSock;
        }
        freeaddrinfo(res);

        if (s == kInvalidSock) {
            throw std::runtime_error(
                "cannot reach the node at " + m_host + ":" + portStr +
                ". Is wamd running, and does wam.conf have server=1?");
        }

        std::ostringstream req;
        req << "POST / HTTP/1.1\r\n"
            << "Host: " << m_host << ":" << m_port << "\r\n"
            << "Authorization: Basic " << Base64(Credentials()) << "\r\n"
            << "Content-Type: application/json\r\n"
            << "Content-Length: " << body.size() << "\r\n"
            << "Connection: close\r\n\r\n"
            << body;
        const std::string out = req.str();

        size_t sent = 0;
        while (sent < out.size()) {
            const long n = SendSome(s, out.data() + sent, out.size() - sent);
            if (n <= 0) { CloseSock(s); throw std::runtime_error("the node closed the connection while being asked"); }
            sent += size_t(n);
        }

        std::string reply;
        char buf[8192];
        for (;;) {
            const long n = RecvSome(s, buf, sizeof(buf));
            if (n > 0) { reply.append(buf, size_t(n)); continue; }
            break;                      // Connection: close, so EOF ends it
        }
        CloseSock(s);

        // ---- split the reply -------------------------------------------------
        const size_t sep = reply.find("\r\n\r\n");
        if (sep == std::string::npos) {
            throw std::runtime_error("the node's reply had no HTTP headers");
        }
        const std::string head = reply.substr(0, sep);

        status = 0;
        const size_t sp = head.find(' ');
        if (sp != std::string::npos) status = std::atoi(head.c_str() + sp + 1);

        return reply.substr(sep + 4);
    }

    std::string m_host;
    int         m_port;
    std::string m_user;
    std::string m_pass;
    std::string m_cookie;
    std::string m_network;      // only so a failure can name where it looked
};

}   // namespace wam
