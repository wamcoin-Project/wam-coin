#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_no_private_addresses.py -- no address but our own, and ours are declared
===============================================================================

     python3 scripts/check_no_private_addresses.py

 WHY THIS EXISTS

 On 13 November 2026 an outside reader found this, verbatim, in a public file:

     // -- .4, .29, .35, .68, .85, .97 -- and it belongs to the founder.

 with the /24 written out in front of it, in explorer/lib/network.js, in a
 comment explaining why the module counts networks rather than addresses. The
 same range was in the test fixture beside it. It is one identified person's
 home network, in a repository anybody can clone, and it had been there since
 August.

 Fixing those two was not enough. Three more places had it, and the worst was
 not a /24 at all: scripts/check_peer_versions.py carried his full home
 address as the default value of --ours, so every reader of that file had it
 exactly. scripts/login_watch.py named the range in a docstring.

 None of that was carelessness about privacy -- every one of those comments
 was written to explain a privacy measure. The address went in because it was
 the example in front of whoever was writing, and nothing ever asked.

 WHAT THIS DOES

 Refuses any globally routable IP literal in a tracked file unless it is on
 the list below, which is the list of addresses this project has deliberately
 made public: they are in DNS, compiled into every published binary, and
 named on the website. Everything else is either documentation range,
 private, loopback, or a mistake.

 Documentation ranges exist for exactly this and are what a fixture should
 use: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (RFC 5737) and
 2001:db8::/32 (RFC 3849).
===============================================================================
"""

from __future__ import annotations

import ipaddress
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

RED = "\033[31m"; GRN = "\033[32m"; BLD = "\033[1m"; OFF = "\033[0m"

# DECLARED PUBLIC INFRASTRUCTURE, WITH THE REASON EACH ONE IS HERE.
#
# A seed address is not a secret and cannot be: it is in the DNS seed zone and
# compiled into every binary we have published, so withdrawing it from this
# file would withdraw it from nothing. That is the test for this list -- an
# address belongs here when it is already public by our own decision, not when
# it is convenient.
# wam:quote-begin
DECLARED = {
    "169.58.159.165": "seed node, Germany; in DNS and in every published binary",
    "5.223.52.200":   "seed node, Singapore; in DNS and in every published binary",
    "13.140.33.187":  "seed node, Singapore (earlier host); same",
    "8.8.8.8":        "Google public resolver, named in DNS troubleshooting",
    "1.1.1.1":        "Cloudflare public resolver, same",
    "9.9.9.9":        "Quad9 public resolver, same",
}
# wam:quote-end

IPV4 = re.compile(r"(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])")

# GENERATED FROM SOMEBODY ELSE'S TEXT, SO NOT OURS TO REWRITE.
#
# share/examples/wam.conf is produced by scripts/gen_wam_conf.sh out of the
# node's own --help, which is Bitcoin Core's option help with our names in
# it. Its placeholder examples are upstream's, they describe the syntax of
# -whitelist and -rpcallowip, and editing them here would make the file
# disagree with the binary it is generated from -- which
# scripts/check_example_conf.py exists to catch.
EXEMPT_FILES = {
    "share/examples/wam.conf":
        "generated from the node's own help; the examples are upstream's",
}

# Text files only. A binary with an address in it is a different question and
# not one a regular expression should be asked.
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip",
               ".gz", ".xz", ".tar", ".woff", ".woff2", ".ttf", ".asc",
               ".sig", ".bin", ".dat"}


def tracked():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT,
                         capture_output=True, text=True).stdout
    return [p for p in out.split("\0") if p]


def interesting(addr: str):
    """None if this address may appear anywhere, else why it may not."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return None                      # not an address: 0.1.14.2, a version
    if addr in DECLARED:
        return None
    if ip.is_private or ip.is_loopback or ip.is_link_local \
            or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return None
    # RFC 5737, the ranges that exist to be written down.
    for net in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"):
        if ip in ipaddress.ip_network(net):
            return None
    if addr == "255.255.255.255":
        return None
    return "a globally routable address that is not declared public"


def main() -> int:
    files = tracked()
    if not files:
        print(f"\n  {RED}FAIL{OFF}  git listed no files -- nothing was read\n")
        return 2

    found, scanned = [], 0
    for rel in files:
        p = ROOT / rel
        if p.suffix.lower() in SKIP_SUFFIX or not p.is_file():
            continue
        if rel in EXEMPT_FILES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeDecodeError):
            continue                     # binary, or gone
        scanned += 1
        for i, line in enumerate(text.splitlines(), 1):
            for m in IPV4.finditer(line):
                why = interesting(m.group(1))
                if why:
                    found.append((rel, i, m.group(1), why, line.strip()[:100]))

    print()
    print(f"{BLD}no address but our own, and ours are declared{OFF}")
    print(f"  scanned  : {scanned} tracked text file(s)")
    print(f"  declared : {len(DECLARED)} address(es), each with its reason")
    print()

    for rel, i, addr, why, line in found:
        print(f"  {RED}FAIL{OFF}  {rel}:{i} contains {addr} -- {why}")
        print(f"          {line}")
    if found:
        print()
        print("        A fixture belongs in 192.0.2.0/24, 198.51.100.0/24 or")
        print("        203.0.113.0/24 (RFC 5737). A machine we have genuinely")
        print("        published goes in DECLARED above, with the reason it is")
        print("        already public. A person's home line goes in neither.")
        print()
        print(f"  {RED}{len(found)} address(es) nobody decided to publish{OFF}\n")
        return 1

    print(f"  {GRN}{BLD}every address in the repository is one we publish on "
          f"purpose{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
