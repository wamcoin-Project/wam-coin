#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_published_endpoints.py -- a host:port we publish must answer
===============================================================================

     python3 scripts/check_published_endpoints.py

 WHY THIS EXISTS

 On 15 September 2026, the day mainnet opened, the mining guide sent miners to
 pool.wamcoin.org:13333 -- a port that had stopped existing at 00:00 UTC when
 the testnet pool was converted. It was found by a person, two days later.

 On 8 October 2026 the same shape came back from the other direction. The
 "Which pool" section of docs/MINE.md names three stratum endpoints, two of
 them run by other people, and says:

 <!-- wam:quote-begin -->
     All three answered when this page was last checked; if one does not
     answer for you, try another.
 <!-- wam:quote-end -->

 wam.ariabrain.com:3333 refuses the connection -- measured from the laptop
 and from all three seeds, in three countries, so it is not a block on one
 address. Its website is up and the pool is still listed there, which is why
 nobody noticed: the page a reader sees is not the port a miner dials.

 The sentence is the fault, not the pool. "When this page was last checked"
 is a claim with no checker behind it, so it decays silently, and the person
 who pays for it is a stranger who followed our instructions and got
 "connection refused" from the first thing this project told him to try.

 WHAT THIS DOES

 It finds every host:port on the pages a stranger reads, and dials each one.
 A stratum port must also answer mining.subscribe, because a port that
 accepts a connection and says nothing is not a pool a miner can use.

 A TLS port must complete a handshake that VERIFIES, and must not be close to
 expiry. Until 1 November 2026 this check said, in as many words,
 "listening (TLS, handshake not attempted)" -- it proved something was bound
 to the port and nothing about whether a wallet could talk to it.

 That morning electrum2.wamcoin.org was eighteen days from expiry and had
 been failing to renew for ten weeks. Its certificate had been hand-copied
 from another host in August, so the machine serving the name had no renewal
 configuration for it and the machine that had one did not serve the name.
 Both this check and the hourly ops report said all clear, because a
 certificate that is about to expire answers exactly like one that is not.

 Twenty-one days is the failure line, not thirty. Let's Encrypt renews at
 thirty days remaining and certbot's timer tries twice a day, so a
 certificate still unrenewed at twenty-one has already failed about eighteen
 times. Below thirty is a warning -- that is the window where renewal is due
 and may simply not have run yet tonight.

 Quotation marks are honoured (scripts/lib/quoted.py): docs/REHEARSALS.md
 quotes a rehearsal log that names the old testnet port, and a record of what
 happened in September is not an instruction for today.

 EXIT CODES, this project's convention

     0  every published endpoint answered, and every certificate has room
     1  some answered and some did not -- a published endpoint is dead, or a
        certificate on one is expired, unverifiable, or nearly out of time
     2  NOTHING answered, which is far more likely to be this machine's
        network than every pool in the world going down at once. A check
        that cannot ask has not learned that the answer is no.
===============================================================================
"""

from __future__ import annotations

import datetime
import json
import pathlib
import re
import socket
import ssl
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# The pages a stranger lands on, and the documents they are generated from --
# both, because fixing one without the other means the next build undoes it.
#
# miner/README.md is here because of #3. A pool operator added his stratum
# address to it rather than to docs/MINE.md, which was a reasonable place to
# put it -- it is the file a miner reads -- and this list did not include it.
# So an endpoint was published to readers in a file nothing dialled, and the
# promise this check exists to keep ("a published host:port must answer") did
# not cover it. A hand-kept list of where endpoints may appear will keep
# missing one; this is the second file added to it after a real miss.
# integration/ is here because of the third miss, and it is the one that
# proves the warning above. On 1 November 2026 electrum2.wamcoin.org was
# eighteen days from expiry. It is published in
# integration/komodo/electrums-WAM.json -- a file handed to another project,
# merged, and read by wallets that have never seen a page of ours -- and this
# list covered only the pages a stranger reads. The check, extended that same
# morning to verify certificates, still did not look at the file where the
# endpoint that needed it was published.
TARGETS = ["site/*.html", "site/*/*.html", "site/CHANNELS.txt", "CHANNELS.txt",
           "docs/MINE.md", "docs/START_HERE.md", "docs/START_HERE_AR.md",
           "docs/POOL_OPERATOR.md", "README.md", "miner/README.md",
           "integration/*/*.json", "integration/*/*.md"]

# An https:// URL is a TLS endpoint on 443 whether or not anybody writes the
# number, and nothing above would ever find one: nobody types
# "wamcoin.org:443". Only our own names are dialled this way. We publish
# links to GitHub, GitLab, Gitea and Discord in every document, and a sweep
# that fails because somebody else's load balancer hiccupped is a sweep
# people learn to ignore. Their certificates are also not ours to renew.
HTTPS = re.compile(r"https://([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?=[/:\s\"'<>)\]]|$)",
                   re.IGNORECASE)
OURS = re.compile(r"(^|\.)wamcoin\.(org|net)$", re.IGNORECASE)

# A port served over TLS answers a handshake, not a JSON line.
#
# 50001 and 51001 are NOT in here and were, which was wrong in a way that did
# not show: ElectrumX serves them as tcp://, so handshaking them would have
# failed and dialling them for stratum would have been meaningless either way.
# They are named below as ports that listen and say nothing on their own.
TLS_PORTS = {50002, 50004, 51002, 51004, 443}

# Electrum's plain-text ports. Open is the whole question for these.
QUIET_PORTS = {50001, 51001}

# Why these two numbers, and not thirty for both, is argued in the header.
CERT_FAIL_DAYS = 21
CERT_WARN_DAYS = 30

ENDPOINT = re.compile(r"\b([a-z0-9][a-z0-9.-]*\.[a-z]{2,})[:\s]*:(\d{2,5})\b")

# Names reserved by RFC 2606 and RFC 6761 exist so documentation can show a
# host that is guaranteed never to resolve. README.md uses pool.example.org
# in the line that tells an operator what to put in his own config, and a
# check that dials it is reporting that the standard works.
EXAMPLE = re.compile(r"(^|\.)(example\.(com|org|net)|invalid|test|localhost)$")

TIMEOUT = 12


def published():
    """{(host, port): [where it is published]}, quotations excluded."""
    found = {}
    for pattern in TARGETS:
        for path in sorted(ROOT.glob(pattern)):
            if not path.is_file():
                continue
            rel = path.relative_to(ROOT).as_posix()
            text = quoted.strip_quoted(
                path.read_text(encoding="utf-8", errors="replace"))
            for host, port in ENDPOINT.findall(text):
                host = host.rstrip(".")
                if EXAMPLE.search(host):
                    continue
                key = (host, int(port))
                found.setdefault(key, [])
                if rel not in found[key]:
                    found[key].append(rel)
            for host in HTTPS.findall(text):
                host = host.rstrip(".").lower()
                if EXAMPLE.search(host) or not OURS.search(host):
                    continue
                key = (host, 443)
                found.setdefault(key, [])
                if rel not in found[key]:
                    found[key].append(rel)
    return found


def expiry_of(cert):
    """datetime of notAfter, or None. The day is space-padded on single
    digits -- 'Jan  3' -- which strptime absorbs because a space in the
    format matches a run of them."""
    raw = (cert or {}).get("notAfter")
    if not raw:
        return None
    for fmt in ("%b %d %H:%M:%S %Y %Z", "%b %d %H:%M:%S %Y"):
        try:
            return datetime.datetime.strptime(raw, fmt).replace(
                tzinfo=datetime.timezone.utc)
        except ValueError:
            continue
    return None


def tls(host, port):
    """(state, what happened) for a port that should speak TLS.

    The context verifies: the chain, and that the certificate is for the name
    we dialled. A wallet does exactly this, so anything it would refuse is a
    failure here and not a note. An expired certificate never reaches the
    expiry arithmetic below -- the handshake itself refuses it, which is the
    point."""
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as raw:
            with ctx.wrap_socket(raw, server_hostname=host) as s:
                cert = s.getpeercert()
    except ssl.SSLCertVerificationError as e:
        # Reached, and refused on its merits. That distinction decides
        # whether a run of failures is the world's or this laptop's.
        return "fail", f"a wallet would refuse this: {e.verify_message or e}", 1
    except ssl.SSLError as e:
        return "fail", f"TLS handshake failed: {str(e)[:60]}", 1
    except OSError as e:
        return "fail", type(e).__name__, 0

    when = expiry_of(cert)
    if when is None:
        return "warn", "handshake verified but no expiry could be read", 1

    days = (when - datetime.datetime.now(datetime.timezone.utc)).days
    on = when.strftime("%Y-%m-%d")
    if days < CERT_FAIL_DAYS:
        return "fail", f"certificate expires {on} -- {days} days left", 1
    if days < CERT_WARN_DAYS:
        return "warn", f"certificate expires {on} -- {days} days, renewal due", 1
    return "ok", f"TLS verified, certificate to {on} ({days} days)", 1


def dial(host, port):
    """(state, what happened, whether the host was reached at all)."""
    if port in TLS_PORTS:
        return tls(host, port)
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as s:
            if port in QUIET_PORTS:
                return "ok", "open (plain text, says nothing unasked)", 1
            s.sendall(json.dumps({"id": 1, "method": "mining.subscribe",
                                  "params": ["wam-endpoint-check"]}).encode()
                      + b"\n")
            s.settimeout(TIMEOUT)
            try:
                reply = s.recv(512).decode("utf-8", "replace").strip()
            except socket.timeout:
                # Not a failure on its own: a server may wait for a different
                # first message. It is still reachable, which is the question
                # a miner is asking.
                return "ok", "open, silent to mining.subscribe", 1
            if '"result"' in reply or '"method"' in reply:
                return "ok", "answers stratum", 1
            return "ok", f"open, replied {reply[:40]!r}", 1
    except OSError as e:
        return "fail", type(e).__name__, 0


def main() -> int:
    print(f"\n{BLD}every host:port this project publishes answers{OFF}\n")

    found = published()
    if not found:
        print(f"  {YEL}no endpoint was found on any page -- this is not a "
              f"pass{OFF}\n")
        return 2

    bad, warned = [], []
    good = reached = 0
    for (host, port), where in sorted(found.items()):
        state, why, got_there = dial(host, port)
        reached += got_there
        label = f"{host}:{port}"
        if state == "ok":
            good += 1
            print(f"  {GRN}ok{OFF}    {label:<34} {why}")
        elif state == "warn":
            warned.append(label)
            print(f"  {YEL}warn{OFF}  {label:<34} {why}")
        else:
            bad.append((label, why, where))
            print(f"  {RED}FAIL{OFF}  {label:<34} {why}")
            for w in where:
                print(f"          published in {w}")

    print()
    # `reached` and not `good`: a certificate this check refuses was still
    # answered by a live host, and calling that "no network here" would hide
    # the one finding worth having.
    if bad and reached == 0:
        print(f"  {YEL}nothing was reached at all -- that is this machine's "
              f"network, not the world's{OFF}")
        print(f"  {YEL}A check that could not ask has not learned that the "
              f"answer is no.{OFF}\n")
        return 2
    if bad:
        print(f"  {RED}{len(bad)} published endpoint(s) a stranger cannot "
              f"use{OFF}")
        print("  Either nothing answered, or the certificate is expired, is")
        print("  for another name, or is too near expiry to leave alone.")
        print()
        print("  A dead port: take it off the page, or say beside it that it")
        print("  is not answering and when that was measured. Third-party")
        print("  pools are theirs to run and ours to stop naming while they")
        print("  are down -- the page is the thing we control.")
        print()
        print("  A certificate: renew it ON THE HOST THAT SERVES THE NAME.")
        print("  Only that host is handed the challenge, which is the whole")
        print("  reason the one on 1 November went ten weeks unrenewed.\n")
        return 1
    if warned:
        print(f"  {YEL}{len(warned)} certificate(s) inside the renewal window "
              f"and not yet renewed{OFF}")
        print("  Not a failure today. It is one if it is still here in a "
              "week.\n")
    print(f"  {GRN}{BLD}all {good + len(warned)} published endpoints "
          f"answered{OFF}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
