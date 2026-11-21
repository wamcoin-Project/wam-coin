// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  tls.h -- one transport, plain or encrypted, for the stratum and RPC paths
// ===========================================================================
//
//  WHY THIS EXISTS
//
//  This miner spoke no TLS. Reported 13 November 2026 as M-1 and M-2: the
//  stratum connection to a pool was cleartext, so anyone on the path could
//  replace the block template and take the victim's whole hashrate while
//  every share still reported as accepted; and the solo RPC sent
//  `Authorization: Basic <base64(user:password)>` in the open, which is the
//  node's entire RPC surface, wallet calls included.
//
//  The first answer was to stop the binary being quiet about it -- refuse
//  stratum+ssl:// rather than downgrade it, refuse a password to a public
//  address, warn on everything else. That is still here and still right: a
//  miner built without TLS says so, loudly, rather than pretending.
//
//  This is the second half: when the build has OpenSSL, the miner speaks TLS
//  itself and needs no stunnel beside it.
//
//  WHY IT IS OPTIONAL AT COMPILE TIME
//
//  miner/build.sh is one g++ call, one translation unit and one static
//  library, deliberately -- it is what lets a stranger build this on a
//  machine with nothing installed. Making libssl mandatory would take that
//  away from every platform at once to add encryption on one.
//
//  So: build.sh looks for the headers. Found, it defines WAM_MINER_TLS and
//  links -lssl -lcrypto; not found, the binary is exactly what it was and
//  says so in --version and when a pool is not local. Nothing silently
//  changes meaning between the two builds -- `stratum+ssl://` works in one
//  and is refused with instructions in the other.
//
//  WHAT IT VERIFIES
//
//  A TLS connection that does not verify is theatre: it stops a passive
//  listener and not the attacker this is about, who is already in the path
//  and can present any certificate. So:
//
//    * the system trust store                 SSL_CTX_set_default_verify_paths
//    * TLS 1.2 at the oldest                  SSL_CTX_set_min_proto_version
//    * the certificate is for THIS host       SSL_set1_host, and the
//                                             handshake fails if it is not
//    * SNI, so a host serving several names   SSL_set_tlsext_host_name
//      hands over the right one
//
//  and after the handshake SSL_get_verify_result is read rather than assumed.
//  An IP literal gets SSL_set1_ip_asc instead: a certificate for a name says
//  nothing about an address.
// ===========================================================================

#ifndef WAM_MINER_TLS_H
#define WAM_MINER_TLS_H

#include "platform.h"

#include <cstring>
#include <string>

#ifdef WAM_MINER_TLS
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#endif

namespace wam {

/**
 * A connected socket, with or without TLS on top of it.
 *
 * Send and Recv keep the semantics the plain path already had, because the
 * stratum loop is built on them: a short read returns what it got, a timeout
 * returns -1 with a would-block error, and a clean close returns 0. OpenSSL
 * reports those differently, so Recv maps them back rather than making every
 * caller learn two dialects.
 */
class Transport {
public:
    Transport() = default;
    ~Transport() { Close(); }
    Transport(const Transport&) = delete;
    Transport& operator=(const Transport&) = delete;

    /** Was this binary built with TLS at all? */
    static bool Available()
    {
#ifdef WAM_MINER_TLS
        return true;
#else
        return false;
#endif
    }

    /** What to print in --version, so a user can tell the two builds apart. */
    static std::string Describe()
    {
#ifdef WAM_MINER_TLS
        return OpenSSL_version(OPENSSL_VERSION);
#else
        return "none (built without TLS)";
#endif
    }

    /**
     * Adopt a connected socket.
     *
     * @param fd     a socket already through ::connect
     * @param host   the name that was dialled -- for SNI and the name check
     * @param tls    false keeps it plain, and nothing below runs
     * @param err    why, when this returns false
     *
     * On failure the socket is closed: a half-started transport is the kind
     * of object whose owner forgets which half it is.
     */
    bool Start(sock_t fd, const std::string& host, bool tls, std::string& err)
    {
        Close();
        m_fd = fd;
        if (!tls) return true;

#ifndef WAM_MINER_TLS
        (void)host;
        err = "this build has no TLS; see miner/README.md";
        Close();
        return false;
#else
        m_ctx = SSL_CTX_new(TLS_client_method());
        if (!m_ctx) { err = Err("could not create a TLS context"); Close(); return false; }

        SSL_CTX_set_min_proto_version(m_ctx, TLS1_2_VERSION);
        SSL_CTX_set_verify(m_ctx, SSL_VERIFY_PEER, nullptr);
        if (SSL_CTX_set_default_verify_paths(m_ctx) != 1) {
            err = Err("no system certificate store could be loaded");
            Close();
            return false;
        }

        m_ssl = SSL_new(m_ctx);
        if (!m_ssl) { err = Err("could not create a TLS session"); Close(); return false; }

        // A CERTIFICATE FOR A NAME SAYS NOTHING ABOUT AN ADDRESS.
        //
        // If the operator dialled an IP literal, checking it against the
        // certificate's names would pass on any certificate whose SAN happens
        // to carry that text. set1_ip_asc checks the iPAddress SAN instead,
        // which is the only thing that means what it says.
        X509_VERIFY_PARAM* param = SSL_get0_param(m_ssl);
        X509_VERIFY_PARAM_set_hostflags(param,
                                        X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
        std::string bare = host;
        if (bare.size() >= 2 && bare.front() == '[' && bare.back() == ']') {
            bare = bare.substr(1, bare.size() - 2);
        }
        if (LooksLikeAddress(bare)) {
            if (X509_VERIFY_PARAM_set1_ip_asc(param, bare.c_str()) != 1) {
                err = "could not check a certificate against the address " + bare;
                Close();
                return false;
            }
        } else {
            if (SSL_set1_host(m_ssl, bare.c_str()) != 1) {
                err = "could not check a certificate against the name " + bare;
                Close();
                return false;
            }
            // SNI. A host serving several names hands over the wrong
            // certificate without it, and the check above then fails for a
            // reason that has nothing to do with the operator.
            SSL_set_tlsext_host_name(m_ssl, bare.c_str());
        }

        if (SSL_set_fd(m_ssl, static_cast<int>(m_fd)) != 1) {
            err = Err("could not attach the socket to the TLS session");
            Close();
            return false;
        }

        // The socket carries a receive timeout, so a handshake on a silent
        // link returns WANT_READ rather than hanging. Retry it: the timeout
        // is one second and a handshake across the world is allowed to take
        // longer than that.
        // A LOOP THAT RUNS OUT IS NOT A HANDSHAKE THAT SUCCEEDED.
        //
        // This broke on rc == 1 and otherwise fell out of the loop after
        // thirty attempts -- straight into the verify check below. For a
        // session where no handshake ever completed, SSL_get_verify_result
        // returns X509_V_OK: the field is initialised to it and means
        // nothing without a peer certificate. So thirty seconds of silence
        // from whoever answered the TCP connect produced m_tls = true, a
        // "connected" log line, a reset reconnect delay, and the message
        // main.cpp prints about the certificate being verified against this
        // machine's trust store -- for a connection that had verified
        // nothing and could carry nothing.
        //
        // This file's own promise, three paragraphs up, is that the result
        // is read rather than assumed. It was assumed on this path.
        //
        // Found in the pre-release review of v0.1.15.
        bool shook = false;
        for (int attempt = 0; attempt < 30; ++attempt) {
            const int rc = SSL_connect(m_ssl);
            if (rc == 1) { shook = true; break; }
            const int reason = SSL_get_error(m_ssl, rc);
            if (reason == SSL_ERROR_WANT_READ || reason == SSL_ERROR_WANT_WRITE) {
                continue;
            }
            err = "TLS handshake failed: " + Err("");
            Close();
            return false;
        }
        if (!shook) {
            err = "the TLS handshake did not finish in 30 seconds. Nothing "
                  "was verified, so this connection is not being used.";
            Close();
            return false;
        }

        // And a verify result is only an answer if there was a certificate
        // to verify. X509_V_OK with no peer certificate is the initial
        // value, not a verdict.
        X509* peer = SSL_get1_peer_certificate(m_ssl);
        if (peer == nullptr) {
            err = "the pool sent no certificate, so nothing could be checked";
            Close();
            return false;
        }
        X509_free(peer);

        const long verified = SSL_get_verify_result(m_ssl);
        if (verified != X509_V_OK) {
            err = std::string("the pool's certificate was refused: ")
                  + X509_verify_cert_error_string(verified);
            Close();
            return false;
        }
        m_tls = true;
        return true;
#endif
    }

    bool IsOpen() const { return m_fd != kInvalidSock; }
    bool Encrypted() const { return m_tls; }

    long Send(const char* buf, size_t len)
    {
#ifdef WAM_MINER_TLS
        if (m_tls) {
            const int n = SSL_write(m_ssl, buf, static_cast<int>(len));
            return n > 0 ? long(n) : MapError(n);
        }
#endif
        return SendSome(m_fd, buf, len);
    }

    long Recv(char* buf, size_t len)
    {
#ifdef WAM_MINER_TLS
        if (m_tls) {
            const int n = SSL_read(m_ssl, buf, static_cast<int>(len));
            if (n > 0) return long(n);
            // A clean shutdown is a close, exactly as recv() reports it.
            if (SSL_get_error(m_ssl, n) == SSL_ERROR_ZERO_RETURN) return 0;
            return MapError(n);
        }
#endif
        return RecvSome(m_fd, buf, len);
    }

    void Close()
    {
#ifdef WAM_MINER_TLS
        if (m_ssl) {
            if (m_tls) SSL_shutdown(m_ssl);     // best effort; the peer may be gone
            SSL_free(m_ssl);
            m_ssl = nullptr;
        }
        if (m_ctx) { SSL_CTX_free(m_ctx); m_ctx = nullptr; }
#endif
        if (m_fd != kInvalidSock) { CloseSock(m_fd); m_fd = kInvalidSock; }
        m_tls = false;
    }

private:
    static bool LooksLikeAddress(const std::string& h)
    {
        if (h.find(':') != std::string::npos) return true;      // IPv6
        unsigned a, b, c, d;
        char extra = 0;
        return std::sscanf(h.c_str(), "%u.%u.%u.%u%c", &a, &b, &c, &d, &extra) == 4
               && a < 256 && b < 256 && c < 256 && d < 256;
    }

#ifdef WAM_MINER_TLS
    /** OpenSSL's reason for the last failure, as one line. */
    std::string Err(const std::string& prefix) const
    {
        char buf[256] = {0};
        const unsigned long code = ERR_get_error();
        if (code) ERR_error_string_n(code, buf, sizeof(buf));
        if (prefix.empty()) return buf[0] ? buf : "no detail from OpenSSL";
        return buf[0] ? prefix + ": " + buf : prefix;
    }

    /**
     * Turn an SSL_read/SSL_write failure into what the plain path returns.
     *
     * The stratum loop reads -1 plus a would-block error as "the socket had
     * nothing to give", which is where it measures silence. A TLS session on
     * a socket with a receive timeout reports that as WANT_READ, so without
     * this the loop would read every quiet second as a dead connection.
     */
    long MapError(int rc) const
    {
        const int reason = SSL_get_error(m_ssl, rc);
        if (reason == SSL_ERROR_WANT_READ || reason == SSL_ERROR_WANT_WRITE) {
            SetWouldBlock();
            return -1;
        }
        if (reason == SSL_ERROR_SYSCALL) return -1;   // errno is already set
        SetGenericError();
        return -1;
    }
#endif

    sock_t m_fd{kInvalidSock};
    bool   m_tls{false};
#ifdef WAM_MINER_TLS
    SSL_CTX* m_ctx{nullptr};
    SSL*     m_ssl{nullptr};
#endif
};

} // namespace wam

#endif // WAM_MINER_TLS_H
