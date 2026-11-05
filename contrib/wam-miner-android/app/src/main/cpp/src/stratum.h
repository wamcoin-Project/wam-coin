// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  Stratum client.
// ===========================================================================
//
//  Newline-delimited JSON-RPC over TCP, speaking the dialect in
//  pool/lib/stratumServer.js:
//
//      -> mining.subscribe            <- [[subscriptions], extranonce1, en2size]
//      -> mining.authorize            <- true / false
//      -> mining.submit               <- true / [code, message, null]
//      <- mining.set_difficulty
//      <- mining.set_seedhash         (WAM extension)
//      <- mining.notify               (10th parameter is the RandomX seed)
//
//  All socket traffic happens on one thread. Workers hand submissions to a
//  queue rather than writing themselves, so two threads can never interleave
//  halves of a JSON line on the wire.

#pragma once

// Every platform difference the socket layer has is in platform.h, which
// brings the system headers with it. Nothing below this line should have to
// know which operating system it was compiled for: the stratum protocol does
// not change between them.
#include "platform.h"
#include "sha256.h"   // BuildHeader folds the merkle branch

#include <array>
#include <deque>
#include <functional>
#include <mutex>
#include <set>
#include <chrono>
#include <cstdlib>
#include <string>
#include <vector>

#include "json.h"
#include "util.h"

namespace wam {

struct StratumJob {
    std::string jobId;
    uint8_t     prevHash[32] = {0};              // already in header order
    Bytes       coinb1;
    Bytes       coinb2;
    std::vector<std::array<uint8_t, 32>> merkleBranch;
    uint32_t    version   = 0;
    uint32_t    nbits     = 0;
    uint32_t    ntime     = 0;
    bool        cleanJobs = false;
    Bytes       seed;                            // RandomX key for this height

    Bytes       extranonce1;
    int         extranonce2Size = 4;

    // Filled in by the worker that adopts this job.
    std::string extranonce2Hex;

    int64_t     height = 0;         // read out of the coinbase, see below
    bool        valid  = false;
};

/**
 * Recover the block height from coinb1.
 *
 * mining.notify does not carry the height, but BIP34 requires it to be the
 * first push of the coinbase scriptSig, so it is already in the bytes we were
 * sent. Miners expect to see it, and it is worth having: a miner watching the
 * height stall knows its pool is stuck long before the pool operator does.
 *
 * Layout of coinb1:
 *     4  txversion
 *     1  input count (always 0x01)
 *    32  null prevout hash
 *     4  prevout index (0xffffffff)
 *     1  scriptSig length (consensus caps the script at 100 bytes, so the
 *        CompactSize is always a single byte here)
 *     1  height push length
 *     n  height, little-endian
 */
inline int64_t ParseCoinbaseHeight(const Bytes& coinb1)
{
    constexpr size_t kPushLenOffset = 4 + 1 + 32 + 4 + 1;
    if (coinb1.size() <= kPushLenOffset) return 0;

    const size_t n = coinb1[kPushLenOffset];
    if (n < 1 || n > 4 || coinb1.size() < kPushLenOffset + 1 + n) return 0;

    int64_t height = 0;
    for (size_t i = 0; i < n; i++) {
        height |= int64_t(coinb1[kPushLenOffset + 1 + i]) << (8 * i);
    }
    return height;
}

// ---------------------------------------------------------------------------
// MOVED HERE FROM main.cpp, UNCHANGED.
//
// Solo mining builds the same StratumJob from getblocktemplate and has to
// produce the same 80 bytes from it. Copying this function would mean two
// versions of the one piece of code whose output must match what a pool
// rebuilds byte for byte -- and any disagreement shows up as "share above
// target" on every share, which reads as bad luck rather than as a bug.
// ---------------------------------------------------------------------------

/**
 * Build the 80-byte header for a job, with the nonce left at zero.
 *
 * This has to reproduce, byte for byte, what the pool will rebuild when it
 * validates the share -- see BlockTemplate.serializeHeader() in
 * pool/lib/blockTemplate.js. Any disagreement shows up as "share above
 * target" for every share, which looks like bad luck rather than a bug.
 */
inline void BuildHeader(const StratumJob& job, const Bytes& extranonce2, uint8_t header[80])
{
    // ---- coinbase = coinb1 | extranonce1 | extranonce2 | coinb2 -----------
    Bytes coinbase;
    coinbase.reserve(job.coinb1.size() + job.extranonce1.size() +
                     extranonce2.size() + job.coinb2.size());
    coinbase.insert(coinbase.end(), job.coinb1.begin(), job.coinb1.end());
    coinbase.insert(coinbase.end(), job.extranonce1.begin(), job.extranonce1.end());
    coinbase.insert(coinbase.end(), extranonce2.begin(), extranonce2.end());
    coinbase.insert(coinbase.end(), job.coinb2.begin(), job.coinb2.end());

    // ---- merkle root: fold the coinbase hash through the branch ----------
    uint8_t root[32];
    SHA256d(coinbase.data(), coinbase.size(), root);
    for (const std::array<uint8_t, 32>& node : job.merkleBranch) {
        uint8_t next[32];
        SHA256dPair(root, node.data(), next);
        std::memcpy(root, next, 32);
    }

    WriteLE32(header + 0, job.version);
    std::memcpy(header + 4, job.prevHash, 32);
    std::memcpy(header + 36, root, 32);
    WriteLE32(header + 68, job.ntime);
    WriteLE32(header + 72, job.nbits);
    WriteLE32(header + 76, 0);                  // nonce, filled per attempt
}

class StratumClient {
public:
    StratumClient(std::string host, uint16_t port, std::string user, std::string pass)
        : m_host(std::move(host)), m_port(port),
          m_user(std::move(user)), m_pass(std::move(pass)) {}

    ~StratumClient() { Close(); }

    // -- callbacks, set before Connect() ------------------------------------
    std::function<void(const StratumJob&)>            onJob;
    std::function<void(double)>                       onDifficulty;
    std::function<void(bool, const std::string&)>     onSubmitResult;
    std::function<void(const std::string&)>           onLog;
    std::function<void(const std::string&)>           onError;

    bool IsConnected() const { return m_fd != kInvalidSock; }
    bool IsAuthorized() const { return m_authorized; }

    /** How many times the pool has refused mining.authorize on this run. */
    int AuthRefusals() const { return m_authRefusals; }

    // -----------------------------------------------------------------------

    // Five block times. A pool sends a job on every block, so this is
    // generous: nothing legitimate is quiet for ten minutes.
    //
    // Overridable so the behaviour can actually be tested. A watchdog that
    // has never been seen to fire is a watchdog nobody knows works, and this
    // one exists precisely because something failed silently for six hours.
    static long SilenceLimitSeconds()
    {
        if (const char* e = std::getenv("WAM_MINER_SILENCE_SECONDS")) {
            const long v = std::atol(e);
            if (v > 0) return v;
        }
        return 600;
    }

    /**
     * How far real time may run ahead of monotonic time before this process
     * concludes it was not running.
     *
     * Sixty seconds is far above any single correction NTP would make, and
     * the cost of being wrong is one reconnection.
     *
     * WAM_MINER_SUSPEND_GRACE_SECONDS overrides it, negative values included.
     * A negative threshold makes the branch fire on an ordinary poll, which
     * is the only way to watch this path run without suspending a machine --
     * and a recovery nobody has seen recover is a recovery nobody can vouch
     * for. The silence watchdog exists because something failed quietly for
     * six hours; this one exists because that watchdog was then blind for
     * three hours and forty-six minutes more.
     */
    static long SuspendGraceSeconds()
    {
        if (const char* e = std::getenv("WAM_MINER_SUSPEND_GRACE_SECONDS")) {
            char* end = nullptr;
            const long v = std::strtol(e, &end, 10);
            if (end && end != e) return v;
        }
        return 60;
    }

    /**
     * Called only from the one place it can be called honestly: straight
     * after a read that returned nothing, so we know the socket was asked
     * and had nothing to give.
     *
     * The first version of this ran at the top of Poll(), before the read,
     * and was wrong in a way a test caught immediately. RandomX builds its
     * dataset on a seed change and that takes 80 seconds on one thread; the
     * whole loop stops for the duration. The pool had sent a job two seconds
     * in and it sat unread in the kernel's buffer the entire time -- so the
     * check woke up, measured "nothing read for 80s", and threw away a live
     * connection carrying a job it had not yet looked at.
     *
     * Silence is a property of the pool, not of how busy we were. Measuring
     * it anywhere but here confuses the two.
     */
    void CheckSilence()
    {
        if (m_lastRx.time_since_epoch().count() == 0) return;

        const auto quiet = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - m_lastRx).count();
        if (quiet <= SilenceLimitSeconds()) return;

        // Closing is the whole action: the main loop reconnects as soon as
        // IsConnected() goes false.
        Report("no job or reply from the pool for " + std::to_string(quiet)
               + "s -- the connection is carrying nothing; reconnecting");
        Close();
    }

    bool Connect(std::string& err)
    {
        Close();

        // On Windows nothing below works until the socket library is running,
        // getaddrinfo included.
        if (!SockStartup()) {
            err = "the system's socket library refused to start";
            return false;
        }

        addrinfo hints{};
        hints.ai_family   = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;

        const std::string portStr = std::to_string(m_port);
        addrinfo* res = nullptr;
        const int rc = getaddrinfo(m_host.c_str(), portStr.c_str(), &hints, &res);
        if (rc != 0 || !res) {
            err = "cannot resolve " + m_host + ": " + gai_strerror(rc);
            return false;
        }

        sock_t fd = kInvalidSock;
        // Captured inside the loop, not after it. freeaddrinfo() is a library
        // call and is entitled to set errno itself, so reading the error after
        // it can report the wrong reason for the failure -- and on Windows the
        // same is true of WSAGetLastError().
        int lastErr = 0;
        for (addrinfo* ai = res; ai; ai = ai->ai_next) {
            fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
            if (fd == kInvalidSock) { lastErr = SockErr(); continue; }

            SetSockTimeout(fd, SO_SNDTIMEO, 10);

            if (ConnectTo(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;

            lastErr = SockErr();
            CloseSock(fd);
            fd = kInvalidSock;
        }
        freeaddrinfo(res);

        if (fd == kInvalidSock) {
            err = "cannot connect to " + m_host + ":" + portStr + ": "
                  + SockErrStr(lastErr);
            return false;
        }

        SetSockFlag(fd, IPPROTO_TCP, TCP_NODELAY, 1);
        SetSockFlag(fd, SOL_SOCKET, SO_KEEPALIVE, 1);

        // Bounded read so Poll() returns to the caller even on a silent link.
        SetSockTimeout(fd, SO_RCVTIMEO, 1);
        m_lastRx = std::chrono::steady_clock::now();

        m_fd = fd;
        m_buffer.clear();
        m_authorized = false;
        m_subscribed = false;

        SendRaw("{\"id\":1,\"method\":\"mining.subscribe\",\"params\":[\"" +
                json::Escape(kUserAgent) + "\"]}");
        return true;
    }

    void Close()
    {
        if (m_fd != kInvalidSock) { CloseSock(m_fd); m_fd = kInvalidSock; }
        m_authorized = false;
        m_subscribed = false;
    }

    /** Queue a share. Safe to call from any worker thread. */
    void QueueSubmit(const std::string& jobId, const std::string& en2Hex,
                     const std::string& nTimeHex, const std::string& nonceHex)
    {
        std::lock_guard<std::mutex> lock(m_queueMutex);
        m_pendingSubmits.push_back({jobId, en2Hex, nTimeHex, nonceHex});
    }

    /**
     * One turn of the I/O loop: flush queued shares, then read whatever has
     * arrived. Blocks for at most the socket's receive timeout (1s).
     */
    void Poll()
    {
        FlushSubmits();

        if (m_fd == kInvalidSock) return;

        // Seconds in which this loop was not listening cannot be charged to
        // the pool.
        //
        // RandomX rebuilds its dataset whenever the seed changes, and that
        // stops the whole loop -- 78 seconds on one thread, measured. The
        // pool has nothing to answer for during it, and we could not have
        // read a byte if it had. Without this the watchdog wakes up, counts
        // the stall as silence, and throws away a healthy connection holding
        // a fresh job. That is not hypothetical: it is what the test showed
        // on the first two attempts at this file.
        //
        // A healthy turn of the loop comes back within the socket's 1s
        // receive timeout, so any gap far past that was time spent elsewhere.
        const auto now = std::chrono::steady_clock::now();
        const auto wall = std::chrono::system_clock::now();

        // A machine that was suspended cannot measure how long it was gone,
        // and the silence watchdog above is blind to it.
        //
        // The founder's miner runs inside WSL on a laptop. On 25 August that
        // laptop slept from 07:19 to 11:05. The VM was paused by Windows
        // without the guest kernel recording a suspend, so steady_clock did
        // not advance -- CLOCK_MONOTONIC and CLOCK_BOOTTIME were still equal
        // afterwards, and the process printed nothing for three hours and
        // forty-six minutes. On waking it solved a job that had gone stale
        // hours earlier and then sat at 0 H/s, because the pool had long
        // since dropped a connection the miner still believed in.
        //
        // The watchdog was right and useless: no monotonic time had passed,
        // so there was no silence to measure, and it would have needed ten
        // further real minutes before saying anything.
        //
        // The wall clock is the one thing that did move -- WSL resynchronises
        // it from Windows on resume. So the two clocks are compared: when
        // real time has run far ahead of monotonic time, this process was
        // not running, and any socket it holds is a socket the far end
        // stopped hearing from long ago. Reconnecting costs a second.
        //
        // The threshold is well above any clock correction NTP would make in
        // one step, and the cost of being wrong is one reconnection.
        if (m_lastPoll.time_since_epoch().count() != 0) {
            const auto monotonic = std::chrono::duration_cast<std::chrono::seconds>(
                now - m_lastPoll).count();
            const auto real = std::chrono::duration_cast<std::chrono::seconds>(
                wall - m_lastWall).count();
            if (real - monotonic > SuspendGraceSeconds()) {
                Report("this machine was suspended for about "
                       + std::to_string(real - monotonic)
                       + "s -- the pool stopped hearing from us long ago; reconnecting");
                Close();
                m_lastPoll = now;
                m_lastWall = wall;
                return;
            }
        }

        // Seconds in which this loop was not listening cannot be charged to
        // the pool.
        //
        // RandomX rebuilds its dataset whenever the seed changes, and that
        // stops the whole loop -- 78 seconds on one thread, measured. The
        // pool has nothing to answer for during it, and we could not have
        // read a byte if it had. Without this the watchdog wakes up, counts
        // the stall as silence, and throws away a healthy connection holding
        // a fresh job. That is not hypothetical: it is what the test showed
        // on the first two attempts at this file.
        //
        // A healthy turn of the loop comes back within the socket's 1s
        // receive timeout, so any gap far past that was time spent elsewhere.
        if (m_lastPoll.time_since_epoch().count() != 0 &&
            m_lastRx.time_since_epoch().count() != 0) {
            const auto gap = now - m_lastPoll;
            if (gap > std::chrono::seconds(5)) m_lastRx += gap;
        }
        m_lastPoll = now;
        m_lastWall = wall;

        char chunk[8192];
        const long n = RecvSome(m_fd, chunk, sizeof(chunk));

        if (n == 0) {
            Report("the pool closed the connection");
            Close();
            return;
        }
        if (n < 0) {
            const int e = SockErr();
            if (SockWouldBlock(e)) {
                // The socket was asked and had nothing to give. That is the
                // only moment at which silence can honestly be measured.
                CheckSilence();
                return;
            }
            Report("read failed: " + SockErrStr(e));
            Close();
            return;
        }

        m_lastRx = std::chrono::steady_clock::now();
        m_buffer.append(chunk, size_t(n));

        // A pool that never sends a newline is either broken or hostile.
        if (m_buffer.size() > 1u << 20) {
            Report("the pool sent an oversized line; disconnecting");
            Close();
            return;
        }

        size_t start = 0;
        for (;;) {
            const size_t nl = m_buffer.find('\n', start);
            if (nl == std::string::npos) break;

            std::string line = m_buffer.substr(start, nl - start);
            start = nl + 1;

            while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
            if (!line.empty()) HandleLine(line);

            if (m_fd == kInvalidSock) return;    // a handler disconnected us
        }
        m_buffer.erase(0, start);
    }

private:
    struct PendingSubmit {
        std::string jobId, en2Hex, nTimeHex, nonceHex;
    };

    static constexpr const char* kUserAgent = "wam-miner-android/1.0.0";

    void Report(const std::string& msg) { if (onError) onError(msg); }
    void Log(const std::string& msg)    { if (onLog)   onLog(msg); }

    bool SendRaw(const std::string& payload)
    {
        if (m_fd == kInvalidSock) return false;
        const std::string line = payload + "\n";

        size_t sent = 0;
        while (sent < line.size()) {
            const long n = SendSome(m_fd, line.data() + sent, line.size() - sent);
            if (n <= 0) {
                const int e = SockErr();
                if (SockInterrupted(e)) continue;
                Report("write failed: " + SockErrStr(e));
                Close();
                return false;
            }
            sent += size_t(n);
        }
        return true;
    }

    void FlushSubmits()
    {
        std::deque<PendingSubmit> batch;
        {
            std::lock_guard<std::mutex> lock(m_queueMutex);
            batch.swap(m_pendingSubmits);
        }

        for (const PendingSubmit& s : batch) {
            if (m_fd == kInvalidSock || !m_authorized) continue;

            const int id = m_nextId++;
            m_submitIds.insert(id);

            SendRaw("{\"id\":" + std::to_string(id) +
                    ",\"method\":\"mining.submit\",\"params\":[\"" +
                    json::Escape(m_user) + "\",\"" + json::Escape(s.jobId) + "\",\"" +
                    s.en2Hex + "\",\"" + s.nTimeHex + "\",\"" + s.nonceHex + "\"]}");
        }
    }

    void HandleLine(const std::string& line)
    {
        json::Value msg;
        std::string parseError;
        if (!json::ParseLine(line, msg, parseError)) {
            Report("the pool sent malformed JSON (" + parseError + ")");
            return;
        }

        const json::Value& method = msg["method"];
        if (method.IsString()) { HandleNotification(method.string, msg["params"]); return; }

        HandleResponse(msg);
    }

    void HandleNotification(const std::string& method, const json::Value& params)
    {
        if (method == "mining.notify") {
            HandleNotify(params);
        } else if (method == "mining.set_difficulty") {
            const double d = params.At(0).AsNumber(0);
            if (d > 0 && onDifficulty) onDifficulty(d);
        } else if (method == "mining.set_seedhash") {
            Bytes seed;
            if (ParseHex(params.At(0).AsString(), seed) && seed.size() == 32) {
                m_lastSeed = seed;
                Log("RandomX key change announced for height " +
                    std::to_string(params.At(2).AsInt()));
            }
        } else if (method == "client.reconnect") {
            Log("the pool asked us to reconnect");
            Close();
        } else if (method == "mining.set_extranonce") {
            Bytes en1;
            if (ParseHex(params.At(0).AsString(), en1) && !en1.empty()) {
                m_extranonce1 = en1;
                const int64_t size = params.At(1).AsInt(m_extranonce2Size);
                if (size >= 1 && size <= 8) m_extranonce2Size = int(size);
                Log("extranonce1 changed to " + ToHex(m_extranonce1));
            }
        }
        // Anything else is a pool extension we do not need.
    }

    void HandleResponse(const json::Value& msg)
    {
        const int64_t id = msg["id"].AsInt(-1);
        const json::Value& result = msg["result"];
        const json::Value& error  = msg["error"];

        if (id == 1) { HandleSubscribeResult(result, error); return; }

        if (id == 2) {
            if (result.AsBool(false)) {
                m_authorized = true;
                Log("authorized as " + m_user);
            } else {
                // Counted, because the reconnect loop must slow down for this.
                //
                // A refusal usually means the address is wrong, and a wrong
                // address does not become right by asking again. Until
                // 2026-09-14 the loop treated the next TCP connect as a
                // success and reset its backoff, so the client reconnected as
                // fast as the network allowed, for ever. Reported by the
                // operator of a 500-miner pool who rehearsed against us and
                // had to throttle his own clients: one typo in one address,
                // multiplied by a community, is a denial of service on the
                // pool's accept path -- delivered by the miner we publish.
                ++m_authRefusals;
                Report("the pool refused to authorize '" + m_user + "'. "
                       "Check that it is a valid address for this network.");
                Close();
            }
            return;
        }

        if (m_submitIds.erase(int(id)) > 0) {
            if (result.AsBool(false)) {
                if (onSubmitResult) onSubmitResult(true, "");
            } else {
                std::string reason = "rejected";
                if (error.IsArray() && error.Size() >= 2) {
                    reason = error.At(1).AsString("rejected");
                } else if (error.IsString()) {
                    reason = error.string;
                }
                if (onSubmitResult) onSubmitResult(false, reason);
            }
        }
    }

    void HandleSubscribeResult(const json::Value& result, const json::Value& error)
    {
        if (!result.IsArray() || result.Size() < 3) {
            std::string why = "mining.subscribe returned something unexpected";
            if (error.IsArray() && error.Size() >= 2) why += ": " + error.At(1).AsString();
            Report(why);
            Close();
            return;
        }

        Bytes en1;
        if (!ParseHex(result.At(1).AsString(), en1) || en1.empty()) {
            Report("the pool sent an unusable extranonce1");
            Close();
            return;
        }

        const int64_t en2size = result.At(2).AsInt(4);
        if (en2size < 1 || en2size > 8) {
            Report("the pool asked for a " + std::to_string(en2size) +
                   "-byte extranonce2, which this miner does not support");
            Close();
            return;
        }

        m_extranonce1     = en1;
        m_extranonce2Size = int(en2size);
        m_subscribed      = true;

        Log("subscribed: extranonce1=" + ToHex(m_extranonce1) +
            " extranonce2 size=" + std::to_string(m_extranonce2Size));

        SendRaw("{\"id\":2,\"method\":\"mining.authorize\",\"params\":[\"" +
                json::Escape(m_user) + "\",\"" + json::Escape(m_pass) + "\"]}");
    }

    void HandleNotify(const json::Value& p)
    {
        if (!p.IsArray() || p.Size() < 9) {
            Report("mining.notify had too few parameters");
            return;
        }

        StratumJob job;
        job.jobId = p.At(0).AsString();

        Bytes prev;
        if (!ParseHex(p.At(1).AsString(), prev) ||
            !StratumPrevHashToHeader(prev, job.prevHash)) {
            Report("mining.notify carried a malformed prevhash");
            return;
        }

        if (!ParseHex(p.At(2).AsString(), job.coinb1) ||
            !ParseHex(p.At(3).AsString(), job.coinb2)) {
            Report("mining.notify carried a malformed coinbase");
            return;
        }

        const json::Value& branch = p.At(4);
        for (size_t i = 0; i < branch.Size(); i++) {
            Bytes node;
            if (!ParseHex(branch.At(i).AsString(), node) || node.size() != 32) {
                Report("mining.notify carried a malformed merkle branch");
                return;
            }
            std::array<uint8_t, 32> a{};
            std::memcpy(a.data(), node.data(), 32);
            job.merkleBranch.push_back(a);
        }

        // version, nbits and ntime all arrive as big-endian hex.
        Bytes v, b, t;
        if (!ParseHex(p.At(5).AsString(), v) || v.size() != 4 ||
            !ParseHex(p.At(6).AsString(), b) || b.size() != 4 ||
            !ParseHex(p.At(7).AsString(), t) || t.size() != 4) {
            Report("mining.notify carried a malformed version, bits or ntime");
            return;
        }
        job.version = ReadBE32(v.data());
        job.nbits   = ReadBE32(b.data());
        job.ntime   = ReadBE32(t.data());

        job.cleanJobs = p.At(8).AsBool(false);

        // The WAM extension. Fall back to the last set_seedhash, because a
        // pool is allowed to announce the key out of band and omit it here.
        Bytes seed;
        if (p.Size() >= 10 && ParseHex(p.At(9).AsString(), seed) && seed.size() == 32) {
            job.seed   = seed;
            m_lastSeed = seed;
        } else if (!m_lastSeed.empty()) {
            job.seed = m_lastSeed;
        } else {
            Report("the pool sent a job with no RandomX seed. This miner cannot "
                   "guess the key; the pool must send it in mining.notify[9] or "
                   "mining.set_seedhash.");
            return;
        }

        job.extranonce1     = m_extranonce1;
        job.extranonce2Size = m_extranonce2Size;
        job.height          = ParseCoinbaseHeight(job.coinb1);
        job.valid           = true;

        if (onJob) onJob(job);
    }

    std::string m_host;
    uint16_t    m_port;
    std::string m_user;
    std::string m_pass;

    sock_t      m_fd = kInvalidSock;
    std::string m_buffer;

    bool  m_subscribed = false;
    bool  m_authorized = false;
    int   m_authRefusals = 0;

    // When anything last arrived from the pool.
    //
    // On 2026-08-24 this miner sat for six hours on a job from height 1370
    // while the chain reached 1430. It was not disconnected: recv() never
    // returned 0 and never returned an error, so nothing here noticed. The
    // socket was half-open -- alive as far as this end could tell, and
    // carrying nothing. SO_KEEPALIVE is set, but Linux waits two hours
    // before its first probe and the machine had been quiet for six.
    //
    // The log said "0.0 H/s" every thirty seconds and systemd reported the
    // service active. Nothing was wrong anywhere except that no work was
    // being done.
    //
    // Rather than diagnose which kind of silence it was -- a dropped NAT
    // entry, a pool that stopped writing, a route that changed -- silence
    // itself past a threshold is treated as failure. The pool sends a job on
    // every block, roughly every two minutes, so several minutes of nothing
    // at all can only mean the connection is no longer carrying anything.
    std::chrono::steady_clock::time_point m_lastRx{};
    std::chrono::steady_clock::time_point m_lastPoll{};
    std::chrono::system_clock::time_point m_lastWall{};
    Bytes m_extranonce1;
    int   m_extranonce2Size = 4;
    Bytes m_lastSeed;

    int             m_nextId = 100;
    std::set<int>   m_submitIds;

    std::mutex               m_queueMutex;
    std::deque<PendingSubmit> m_pendingSubmits;
};

} // namespace wam
