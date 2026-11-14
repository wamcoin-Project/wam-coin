// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  tls_test.cpp -- encryption that does not verify is theatre
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  M-1, reported 13 November 2026: the miner spoke no TLS, so anyone in the
//  path between a miner and its pool could replace the block template and
//  take the victim's whole hashrate while every share still reported as
//  accepted. miner/src/tls.h answers it.
//
//  But the attacker this is about is already IN the path. He can present any
//  certificate he likes, so a TLS session that encrypts and does not verify
//  stops a passive listener and not him -- it would turn a visible problem
//  into an invisible one.
//
//  So the property under test is not "it connects". It is:
//
//    a certificate that does not chain to this machine's trust store is
//    REFUSED, and the connection does not happen
//
//  The test raises a TLS server on loopback with a self-signed certificate
//  it makes itself, which is exactly what an attacker in the path has, and
//  requires Transport::Start to fail. It also checks the plain path still
//  carries bytes, because the same class now owns both and a transport that
//  refused everything would pass the first half of this file.
//
//  Built without TLS, this reports what it could not check and exits 2 --
//  which is this project's convention and is not a pass.
// ===========================================================================

#include "tls.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#ifdef WAM_MINER_TLS
#include <openssl/pem.h>
#include <openssl/rsa.h>
#include <openssl/x509.h>
#endif

namespace {

using wam::sock_t;
using wam::kInvalidSock;
using wam::CloseSock;
using wam::ConnectTo;
using wam::SendSome;
using wam::SockStartup;

int g_pass = 0;
std::vector<std::string> g_fail;

void Ok(const char* name)
{
    ++g_pass;
    std::printf("  \033[32mok\033[0m    %s\n", name);
}

void Fail(const char* name, const std::string& why)
{
    g_fail.push_back(name);
    std::printf("  \033[31mFAIL\033[0m  %s\n        %s\n", name, why.c_str());
}

/** A listening socket on 127.0.0.1, and the port it got. */
sock_t Listen(uint16_t& port)
{
    sock_t fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd == kInvalidSock) return fd;
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = 0;
    if (::bind(fd, reinterpret_cast<sockaddr*>(&a), sizeof(a)) != 0 ||
        ::listen(fd, 1) != 0) {
        CloseSock(fd);
        return kInvalidSock;
    }
    socklen_t len = sizeof(a);
    ::getsockname(fd, reinterpret_cast<sockaddr*>(&a), &len);
    port = ntohs(a.sin_port);
    return fd;
}

sock_t DialLoopback(uint16_t port)
{
    sock_t fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd == kInvalidSock) return fd;
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = htons(port);
    if (ConnectTo(fd, reinterpret_cast<sockaddr*>(&a), sizeof(a)) != 0) {
        CloseSock(fd);
        return kInvalidSock;
    }
    return fd;
}

#ifdef WAM_MINER_TLS
/** A self-signed certificate and its key -- what a man in the path has. */
bool SelfSigned(EVP_PKEY** key_out, X509** cert_out, const char* cn)
{
    EVP_PKEY* key = EVP_RSA_gen(2048);
    if (!key) return false;

    X509* cert = X509_new();
    if (!cert) { EVP_PKEY_free(key); return false; }

    ASN1_INTEGER_set(X509_get_serialNumber(cert), 1);
    X509_gmtime_adj(X509_getm_notBefore(cert), 0);
    X509_gmtime_adj(X509_getm_notAfter(cert), 60 * 60);
    X509_set_pubkey(cert, key);

    X509_NAME* name = X509_get_subject_name(cert);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
                               reinterpret_cast<const unsigned char*>(cn),
                               -1, -1, 0);
    X509_set_issuer_name(cert, name);                 // self-signed
    X509_sign(cert, key, EVP_sha256());

    *key_out = key;
    *cert_out = cert;
    return true;
}

/** Accept one connection and attempt a TLS handshake with that certificate. */
void ServeOnce(sock_t listener, const char* cn, std::atomic<bool>& done)
{
    EVP_PKEY* key = nullptr;
    X509* cert = nullptr;
    if (!SelfSigned(&key, &cert, cn)) { done = true; return; }

    SSL_CTX* ctx = SSL_CTX_new(TLS_server_method());
    if (ctx) {
        SSL_CTX_use_certificate(ctx, cert);
        SSL_CTX_use_PrivateKey(ctx, key);
    }

    sock_t client = ::accept(listener, nullptr, nullptr);
    if (client != kInvalidSock && ctx) {
        SSL* ssl = SSL_new(ctx);
        if (ssl) {
            SSL_set_fd(ssl, static_cast<int>(client));
            SSL_accept(ssl);            // it will fail; the client refuses us
            SSL_free(ssl);
        }
        CloseSock(client);
    }
    if (ctx) SSL_CTX_free(ctx);
    X509_free(cert);
    EVP_PKEY_free(key);
    done = true;
}
#endif

} // namespace

int main()
{
    std::printf("\n\033[1m  encryption that does not verify is theatre\033[0m\n\n");

    SockStartup();

    // ---- the plain path still carries bytes ------------------------------
    {
        uint16_t port = 0;
        sock_t listener = Listen(port);
        if (listener == kInvalidSock) {
            Fail("a plain transport still carries bytes",
                 "could not listen on loopback");
        } else {
            std::atomic<bool> served{false};
            std::thread server([&] {
                sock_t c = ::accept(listener, nullptr, nullptr);
                if (c != kInvalidSock) {
                    const char msg[] = "hello\n";
                    SendSome(c, msg, sizeof(msg) - 1);
                    CloseSock(c);
                }
                served = true;
            });

            sock_t fd = DialLoopback(port);
            wam::Transport t;
            std::string err;
            char buf[16] = {0};
            long n = -1;
            if (fd != kInvalidSock && t.Start(fd, "127.0.0.1", false, err)) {
                n = t.Recv(buf, sizeof(buf) - 1);
            }
            server.join();
            CloseSock(listener);

            if (n == 6 && std::strncmp(buf, "hello\n", 6) == 0) {
                Ok("a plain transport still carries bytes");
            } else {
                Fail("a plain transport still carries bytes",
                     "read " + std::to_string(n) + " byte(s): " + err);
            }
            if (t.Encrypted()) {
                Fail("a plain transport does not claim to be encrypted",
                     "Encrypted() is true on a plain socket");
            } else {
                Ok("a plain transport does not claim to be encrypted");
            }
        }
    }

#ifndef WAM_MINER_TLS
    std::printf("\n  \033[33m!!\033[0m    this binary was built without TLS, so the "
                "verification\n        cases were not checked at all. Build with "
                "libssl present.\n\n");
    return g_fail.empty() ? 2 : 1;
#else
    std::printf("  \033[32mok\033[0m    built with %s\n",
                wam::Transport::Describe().c_str());

    // ---- a certificate nobody signed must be refused ---------------------
    //
    // THE CASE THIS FILE EXISTS FOR. The attacker is in the path; he can
    // present a certificate for any name. If this passes, the encryption has
    // bought nothing at all and has hidden the fact.
    {
        uint16_t port = 0;
        sock_t listener = Listen(port);
        if (listener == kInvalidSock) {
            Fail("a self-signed certificate is refused",
                 "could not listen on loopback");
        } else {
            std::atomic<bool> done{false};
            std::thread server(ServeOnce, listener, "127.0.0.1", std::ref(done));

            sock_t fd = DialLoopback(port);
            wam::Transport t;
            std::string err;
            const bool started = fd != kInvalidSock &&
                                 t.Start(fd, "127.0.0.1", true, err);
            server.join();
            CloseSock(listener);

            if (started) {
                Fail("a self-signed certificate is refused",
                     "the handshake succeeded -- anyone in the path can make "
                     "one of these, so this connection is encrypted to the "
                     "attacker");
            } else if (err.find("certificate") == std::string::npos &&
                       err.find("handshake") == std::string::npos) {
                Fail("a self-signed certificate is refused",
                     "it failed, but not for a reason an operator can act on: "
                     + err);
            } else {
                Ok("a self-signed certificate is refused");
            }
            if (t.Encrypted()) {
                Fail("a refused handshake leaves nothing open",
                     "Encrypted() is true after a refusal");
            } else {
                Ok("a refused handshake leaves nothing open");
            }
        }
    }

    // ---- and the name on it is checked -----------------------------------
    {
        uint16_t port = 0;
        sock_t listener = Listen(port);
        if (listener == kInvalidSock) {
            Fail("a certificate for another name is refused",
                 "could not listen on loopback");
        } else {
            std::atomic<bool> done{false};
            std::thread server(ServeOnce, listener, "pool.example.org",
                               std::ref(done));

            sock_t fd = DialLoopback(port);
            wam::Transport t;
            std::string err;
            const bool started = fd != kInvalidSock &&
                                 t.Start(fd, "127.0.0.1", true, err);
            server.join();
            CloseSock(listener);

            if (started) {
                Fail("a certificate for another name is refused",
                     "a certificate naming pool.example.org was accepted for "
                     "127.0.0.1");
            } else {
                Ok("a certificate for another name is refused");
            }
        }
    }

    std::printf("\n");
    if (!g_fail.empty()) {
        std::printf("\033[31m\033[1m  %zu failed\033[0m, %d passed\n\n",
                    g_fail.size(), g_pass);
        return 1;
    }
    std::printf("  %d passed: the pool has to prove who it is\n\n", g_pass);
    return 0;
#endif
}
