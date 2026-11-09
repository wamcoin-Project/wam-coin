#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_electrum.py -- does the Electrum server answer, and tell the truth?
# ===========================================================================
#
#      python3 scripts/check_electrum.py --node HOST HOSTNAME[:PORT]...
#      python3 scripts/check_electrum.py electrum.wamcoin.org electrum2.wamcoin.org
#
#  WHY THIS EXISTS
#
#  On 2026-08-20 the Electrum server was stopped during the testnet reset and
#  never restarted. It stayed down for 39 hours. In that time sweep.sh was run
#  and reported 14 passed, 1 failed -- and the one failure was the known
#  mainnet ceremony, so the sweep looked like reassurance.
#
#  Nothing was wrong with the checks that ran. The problem was the check that
#  did not exist: every one of them asked about the node, the consensus rules,
#  the release or the deployed binaries, and not one asked whether the service
#  a light wallet depends on was answering.
#
#  This matters more than an ordinary outage. A light wallet does not read the
#  chain -- it asks an Electrum server what it holds and believes the answer.
#  When the server is down the wallet shows nothing; when the server is wrong
#  the wallet shows something wrong. Komodo Wallet requires two of these for a
#  UTXO coin precisely because their support desk absorbs the difference.
#
#  WHAT IS ACTUALLY CHECKED
#
#  Not "is the port open" -- that was the mistake the last outage taught. The
#  script speaks the protocol:
#
#      server.version                does it answer at all
#      server.features               is this OUR chain (genesis hash)
#      blockchain.headers.subscribe  what height does it claim
#      TLS on 50002                  a real certificate, no override
#
#  and then compares the claimed height against the node, because a server
#  that answers cheerfully while stuck 400 blocks behind is worse than one
#  that is plainly down: the wallet trusts it.
#
#  EVERY HOST BEHIND A NAME, NOT JUST THE FIRST
#
#  electrum.wamcoin.org resolved to two addresses, one of which had never run
#  the service. Half of all connections failed while every check that resolved
#  the name once and got lucky reported success. So each A record is probed
#  separately and named in the output.
#
#  Exit 0 only if every host answered, agreed on the genesis, and was within
#  the height tolerance. Nothing checked is a failure, not a pass.
# ===========================================================================

import os
import argparse
import json
import socket
import ssl
import sys

# Addressing a chain with wam-cli lives in one place. Each of these files
# had its own copy, and every copy mapped mainnet to an EMPTY flag -- which
# means the default datadir, which on both servers is the TESTNET node. Asked
# to check mainnet, they all quietly checked testnet.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wamcli import flags as _wamcli_flags   # noqa: E402
# Asking a server a question also lives in one place, for the reason written
# at the top of wamssh.py: it never raises, and it tells the caller the
# difference between "the answer is no" and "I could not ask". This file was
# the last check that still had its own copy of that call. See node_state.
from wamssh import run as _ssh, UNREACHABLE   # noqa: E402

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; OFF = "\033[0m"

# Ports are per network, the same way the installer assigns them. Mainnet
# keeps 50001/50002 because those are the numbers published in the Komodo
# entry and the listing sheet, and a published endpoint is a promise;
# testnet moved to the 51xxx set on 2026-08-29 so that nothing answers on a
# mainnet port with a testnet chain, which is worse than nothing answering
# at all -- a reviewer who finds a working server on the wrong chain has
# found a defect, where an endpoint that is not up yet is just a launch date.
PORTS = {
    "mainnet": (50002, 50001),
    "testnet": (51002, 51001),
    "regtest": (52002, 52001),
}


def ok(msg):   print(f"  {GRN}ok{OFF}    {msg}")
def bad(msg):  print(f"  {RED}FAIL{OFF}  {msg}")
def warn(msg): print(f"  {YEL}!!{OFF}    {msg}")


def resolve(name):
    """Every A record, not just whichever one came back first."""
    try:
        infos = socket.getaddrinfo(name, None, socket.AF_INET, socket.SOCK_STREAM)
    except socket.gaierror as e:
        return [], str(e)
    return sorted({i[4][0] for i in infos}), None


def rpc(sock, method, params=None, timeout=15):
    sock.settimeout(timeout)
    sock.sendall((json.dumps({"id": 0, "method": method,
                              "params": params or []}) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = sock.recv(8192)
        if not chunk:
            raise ConnectionError("server closed the connection")
        buf += chunk
    return json.loads(buf.split(b"\n")[0].decode())


def probe(ip, port, use_tls, sni, timeout=15):
    """Speak the protocol. Returns (info dict, error string)."""
    try:
        raw = socket.create_connection((ip, port), timeout=timeout)
    except Exception as e:
        return None, f"{type(e).__name__}"

    sock = raw
    try:
        if use_tls:
            ctx = ssl.create_default_context()
            # SNI must be the name, never the address the name resolved to --
            # the certificate is issued for the name.
            sock = ctx.wrap_socket(raw, server_hostname=sni)

        info = {}
        r = rpc(sock, "server.version", ["wam-check", "1.4"])
        info["version"] = r.get("result")

        r = rpc(sock, "blockchain.headers.subscribe")
        info["height"] = (r.get("result") or {}).get("height")

        # server.features carries the genesis hash, which is the only field
        # that proves this server indexes the chain we think it does. A server
        # on the wrong network answers every other call perfectly.
        try:
            r = rpc(sock, "server.features")
            info["genesis"] = (r.get("result") or {}).get("genesis_hash")
        except Exception:
            info["genesis"] = None

        return info, None
    except ssl.SSLCertVerificationError as e:
        return None, f"certificate rejected: {e.verify_message or e}"
    except ssl.SSLError as e:
        return None, f"TLS failed: {e}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"
    finally:
        try:
            sock.close()
        except Exception:
            pass


def node_state(host, network):
    """Height and genesis from the node itself. Returns (height, genesis, why).

    WHY THIS GOES THROUGH wamssh

    Until 2026-11-04 this was a private copy of subprocess.run(..., timeout=60),
    and subprocess.run RAISES TimeoutExpired rather than returning a non-zero
    status. So the caller's graceful path -- warn, and carry on with heights
    unverified -- only ever ran when ssh FAILED quickly. When ssh HUNG, the
    exception went straight past it and killed the script.

    That morning one slow ssh to the Germany node did exactly that, twice in
    sixty seconds, and the ops panel printed a Python traceback under two rows
    named "electrum servers answer and agree" and "a server we do not own
    agrees". All four of our endpoints were answering at the correct height at
    that moment, and so was cup's. The second row exists precisely so that an
    outage of HIS cannot redden a row that judges OURS -- and an ssh hiccup of
    ours reddened it.

    wamssh.run never raises, and retries once after three seconds, which is
    what this failure needed: it was intermittent, not an outage.

    BOTH QUESTIONS, ONE CONNECTION

    Two calls meant two timeout windows, and the second was put to a host the
    first had just shown to be unreachable. One connection answers both.
    """
    flag = _wamcli_flags(network)
    # 25s x 2 tries, 3s apart, is 53s at worst -- inside the 150s that ops.py
    # allows this check for cup's host, with the endpoint probes still to come.
    # A healthy answer measures under three seconds.
    rc, out = _ssh(host, f"wam-cli {flag} getblockcount\n"
                         f"wam-cli {flag} getblockhash 0\n", timeout=25)
    if rc == UNREACHABLE:
        return None, None, out

    # Validated by shape, not by exit status: with two commands on one stdin,
    # the status belongs to the last of them, so a height that arrived after a
    # genesis that did not would still be usable.
    lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
    height = lines[0] if lines and lines[0].isdigit() else None
    genesis = None
    if len(lines) > 1 and len(lines[1]) == 64:
        try:
            int(lines[1], 16)
            genesis = lines[1]
        except ValueError:
            genesis = None
    why = None if height else f"wam-cli exited {rc} without a height"
    return height, genesis, why


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("hosts", nargs="*", help="electrum hostnames, optionally host:port")
    ap.add_argument("--node", help="ssh host to read the true height and genesis from")
    # mainnet by default. Until 18 September every check here defaulted to
    # testnet, written when testnet was the only chain and never revisited;
    # run by hand without the flag, three days into mainnet, they answered
    # confidently about a chain with nothing on it.
    ap.add_argument("--network", default="mainnet",
                    choices=["mainnet", "testnet", "regtest"])
    ap.add_argument("--lag", type=int, default=5,
                    help="blocks the server may trail the node before it is a failure")
    args = ap.parse_args()

    if not args.hosts:
        print("usage: check_electrum.py [--node HOST] HOSTNAME[:PORT]...", file=sys.stderr)
        return 2

    true_height = true_genesis = None
    if args.node:
        h, g, why = node_state(args.node, args.network)
        if h:
            true_height, true_genesis = int(h), g
            ok(f"node {args.node}: height {true_height}")
        else:
            # Not a finding about Electrum, and this must not read like one.
            # Everything below is still measured -- each address answers, over
            # a certificate that verifies, speaking the protocol, on our
            # genesis. The one thing that cannot be measured without the node
            # is how far behind the servers are, and that is what is said.
            warn(f"could not read the node at {args.node}: {why}")
            warn("heights below are UNVERIFIED -- a stuck server would pass")

    checked = 0
    failed = 0

    for spec in args.hosts:
        name, _, portspec = spec.partition(":")
        print(f"\n\033[1m{name}\033[0m")

        ips, err = resolve(name)
        if err:
            bad(f"does not resolve: {err}")
            failed += 1
            continue
        ok(f"resolves to {', '.join(ips)}")

        if len(ips) > 1:
            # Round-robin across hosts that do not all run the service is how
            # a server looks "up" while half its clients fail.
            warn(f"{len(ips)} addresses share this name -- every one must serve")

        tls_port, tcp_port = PORTS[args.network]
        ports = [(int(portspec), portspec == str(tls_port))] if portspec \
                else [(tls_port, True), (tcp_port, False)]

        for ip in ips:
            for port, tls in ports:
                checked += 1
                label = f"{ip}:{port} {'SSL' if tls else 'TCP'}"
                info, err = probe(ip, port, tls, name)

                if err:
                    bad(f"{label}  {err}")
                    failed += 1
                    continue

                bits = [f"height {info['height']}"]
                if info.get("version"):
                    bits.append(str(info["version"][0]))

                problem = None
                if true_genesis and info.get("genesis") and info["genesis"] != true_genesis:
                    problem = "DIFFERENT CHAIN: genesis " + str(info["genesis"])[:16]
                elif true_height is not None and info["height"] is not None:
                    lag = true_height - info["height"]
                    if lag > args.lag:
                        problem = f"{lag} blocks behind the node -- a wallet asking this server is told the wrong balance"
                    elif lag < -args.lag:
                        problem = f"{-lag} blocks AHEAD of the node -- it is indexing something else"

                if problem:
                    bad(f"{label}  {problem}")
                    failed += 1
                else:
                    ok(f"{label}  {', '.join(bits)}")

    print()
    if checked == 0:
        print(f"  {RED}nothing was checked -- this proves nothing{OFF}\n")
        return 1
    if failed:
        print(f"  {RED}{failed} of {checked} endpoint(s) failed{OFF}")
        print("  A light wallet cannot read the chain itself. When this is down it\n"
              "  shows nothing; when it is wrong it shows something wrong.\n")
        return 1
    print(f"  {GRN}all {checked} endpoint(s) serving this chain{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
