// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  plaintext_test.cpp -- the miner knows when it is about to shout a secret
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  wam-miner speaks no TLS. That was true, documented in two comments nobody
//  running the binary ever reads, and the README showed the remote setup it
//  makes dangerous:
//
//      --rpc 192.168.1.10:9554 --rpcuser USER --rpcpassword PASSWORD
//
//  The Authorization header is base64 of user:password, so anyone on the path
//  has the node's whole RPC surface, wallet RPCs included. And `-o
//  stratum+ssl://host:3336` was accepted with the scheme discarded, which
//  opened a CLEARTEXT socket to the pool's TLS port -- the operator who did
//  the right thing got the worst outcome.
//
//  Reported 13 November 2026 as M-1 and M-2.
//
//  ClassifyHost is what the two gates in main() decide on, so it is what has
//  to be right. The classification errs upward on purpose: a name that
//  cannot be resolved here reads as public, because the documented default
//  (pool.wamcoin.org) is one, and the cost of guessing "private" wrongly is
//  a password on the open internet.
// ===========================================================================

#include "plaintext.h"

#include <cstdio>
#include <string>
#include <vector>

namespace {

int g_pass = 0;
std::vector<std::string> g_fail;

const char* Name(wam::HostKind k)
{
    switch (k) {
    case wam::HostKind::Loopback: return "loopback";
    case wam::HostKind::Private:  return "private";
    case wam::HostKind::Public:   return "public";
    }
    return "?";
}

void Is(const std::string& host, wam::HostKind want, const char* why)
{
    const wam::HostKind got = wam::ClassifyHost(host);
    if (got == want) {
        ++g_pass;
        std::printf("  \033[32mok\033[0m    %-28s %-9s %s\n",
                    host.c_str(), Name(got), why);
        return;
    }
    g_fail.push_back(host);
    std::printf("  \033[31mFAIL\033[0m  %-28s read as %s, must be %s -- %s\n",
                host.c_str(), Name(got), Name(want), why);
}

} // namespace

int main()
{
    std::printf("\n\033[1m  where a host sits\033[0m\n\n");

    // Nothing leaves this machine, so nothing is at risk.
    Is("127.0.0.1",   wam::HostKind::Loopback, "the default, and the safe case");
    Is("127.1.2.3",   wam::HostKind::Loopback, "all of 127/8 is loopback");
    Is("localhost",   wam::HostKind::Loopback, "the name people actually type");
    Is("LOCALHOST",   wam::HostKind::Loopback, "case cannot change the answer");
    Is("::1",         wam::HostKind::Loopback, "IPv6 loopback");
    Is("[::1]",       wam::HostKind::Loopback, "and in the brackets a URL uses");
    Is("0:0:0:0:0:0:0:1", wam::HostKind::Loopback, "written out in full");

    // A network the operator plausibly owns: warn, do not refuse. Refusing
    // would break the people already mining this way, and the README told
    // them to.
    Is("192.168.1.10", wam::HostKind::Private, "the README's own example");
    Is("10.0.0.5",     wam::HostKind::Private, "10/8");
    Is("172.16.0.1",   wam::HostKind::Private, "172.16/12, the low end");
    Is("172.31.255.254", wam::HostKind::Private, "and the high end");
    Is("169.254.1.1",  wam::HostKind::Private, "link-local");
    Is("100.64.0.1",   wam::HostKind::Private, "carrier NAT: not the open net");
    Is("fd00::1",      wam::HostKind::Private, "IPv6 unique-local");
    Is("fe80::1",      wam::HostKind::Private, "IPv6 link-local");
    Is("wamnode.local", wam::HostKind::Private, "mDNS names are on the LAN");

    // Everything else. A password here is refused outright.
    Is("203.0.113.9",  wam::HostKind::Public, "a routable address");
    Is("172.32.0.1",   wam::HostKind::Public, "just past 172.16/12");
    Is("172.15.0.1",   wam::HostKind::Public, "just before it");
    Is("192.169.0.1",  wam::HostKind::Public, "one off 192.168/16");
    Is("11.0.0.1",     wam::HostKind::Public, "one off 10/8");
    Is("100.128.0.1",  wam::HostKind::Public, "past the CGNAT block");
    Is("2001:db8::1",  wam::HostKind::Public, "a routable IPv6 address");
    Is("pool.wamcoin.org", wam::HostKind::Public, "our own documented default");

    // A NAME IS NOT A PERMISSION. This is the direction that must not be
    // wrong: something unparseable has to read as public, or a typo becomes
    // a password on the open internet.
    Is("",                 wam::HostKind::Public, "empty: no, not loopback");
    Is("not an address",   wam::HostKind::Public, "nonsense is not a LAN");
    Is("127.0.0.1.evil.com", wam::HostKind::Public,
       "a name that merely STARTS like loopback");
    Is("192.168.1.1.attacker.net", wam::HostKind::Public,
       "and one that starts like a LAN");
    Is("999.999.999.999", wam::HostKind::Public, "out of range, so not parsed");
    Is("10.0.0",          wam::HostKind::Public, "three octets is not 10/8");

    std::printf("\n");
    if (!g_fail.empty()) {
        std::printf("\033[31m\033[1m  %zu failed\033[0m, %d passed\n\n",
                    g_fail.size(), g_pass);
        return 1;
    }
    std::printf("  %d passed: the miner knows what is about to cross the wire\n\n",
                g_pass);
    return 0;
}
