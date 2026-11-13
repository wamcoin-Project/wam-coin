// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  plaintext.h -- where a host sits, and what may cross the wire in the clear
// ===========================================================================

#ifndef WAM_MINER_PLAINTEXT_H
#define WAM_MINER_PLAINTEXT_H

#include <cctype>
#include <cstdio>
#include <string>

namespace wam {

// THIS MINER SPEAKS NO TLS, AND IT USED TO SAY SO ONLY IN COMMENTS.
//
// stratum.h:515 said "speaks no TLS, so every one of its connections is
// plaintext" and rpc.h said "No TLS. The node is on the same machine or the
// same room". Both true, both invisible to whoever runs the binary, and the
// README documented a remote RPC setup -- `--rpc 192.168.1.10:9554 --rpcuser
// USER --rpcpassword PASSWORD` -- which puts the credentials for a node's
// full RPC surface, wallet included, on the wire in base64.
//
// Worse for stratum: `-o stratum+ssl://host:3336` was accepted, the scheme
// silently discarded, and the miner connected in CLEARTEXT to the pool's TLS
// port. Somebody who did the right thing got an obscure failure, and the pool
// does offer 3336.
//
// Reported 13 November 2026 (M-1, M-2). What a man in the middle gets on the
// stratum path is not eavesdropping: it is the block template. Replace it and
// the victim's whole hashrate pays the attacker's address, with every share
// still reported as accepted.
//
// Native TLS means linking libssl into a miner that is deliberately one
// translation unit, one g++ call and one static library, on Linux, Windows
// through mingw, macOS and Android. That is its own release with all four
// builds behind it. What this release does is stop the binary being quiet
// about it: a plaintext connection to anything off this machine says so, a
// password to a public address is refused outright, and stratum+ssl:// gets
// an answer that works instead of a silent downgrade.
enum class HostKind { Loopback, Private, Public };

inline HostKind ClassifyHost(const std::string& host)
{
    // Lower-cased once; a hostname is compared, an address is parsed.
    std::string h;
    h.reserve(host.size());
    for (char c : host) h += (char)std::tolower((unsigned char)c);

    // Strip the brackets an IPv6 literal may arrive in.
    if (h.size() >= 2 && h.front() == '[' && h.back() == ']') {
        h = h.substr(1, h.size() - 2);
    }
    if (h.empty()) return HostKind::Public;

    if (h == "localhost" || h == "::1" || h == "0:0:0:0:0:0:0:1") {
        return HostKind::Loopback;
    }

    // IPv4 literal?
    unsigned a = 0, b = 0, c = 0, d = 0;
    char extra = 0;
    if (std::sscanf(h.c_str(), "%u.%u.%u.%u%c", &a, &b, &c, &d, &extra) == 4 &&
        a < 256 && b < 256 && c < 256 && d < 256) {
        if (a == 127) return HostKind::Loopback;
        if (a == 10) return HostKind::Private;
        if (a == 172 && b >= 16 && b <= 31) return HostKind::Private;
        if (a == 192 && b == 168) return HostKind::Private;
        if (a == 169 && b == 254) return HostKind::Private;   // link-local
        if (a == 100 && b >= 64 && b <= 127) return HostKind::Private; // CGNAT
        return HostKind::Public;
    }

    // IPv6 literal? fc00::/7 is unique-local, fe80::/10 is link-local.
    if (h.find(':') != std::string::npos) {
        if (h.size() >= 2 && (h.compare(0, 2, "fc") == 0 || h.compare(0, 2, "fd") == 0)) {
            return HostKind::Private;
        }
        if (h.size() >= 4 && h.compare(0, 2, "fe") == 0 &&
            (h[2] == '8' || h[2] == '9' || h[2] == 'a' || h[2] == 'b')) {
            return HostKind::Private;
        }
        return HostKind::Public;
    }

    // A name. We cannot resolve it here and must not guess downwards: the
    // documented default, pool.wamcoin.org, is a public name.
    if (h.size() > 6 && h.compare(h.size() - 6, 6, ".local") == 0) {
        return HostKind::Private;
    }
    return HostKind::Public;
}


} // namespace wam

#endif // WAM_MINER_PLAINTEXT_H
