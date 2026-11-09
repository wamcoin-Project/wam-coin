#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_visitors.py -- who tried to join, and why they did not stay
# ===========================================================================
#
#      python3 scripts/check_visitors.py --host <node> --network testnet
#      python3 scripts/check_visitors.py --host <node> --hours 48
#
#  WHY THIS EXISTS
#
#  A stranger connected to the testnet three times across three days, stayed
#  about a quarter of an hour each time, and left. Nothing anywhere could say
#  whether he chose to go or whether our node dropped him.
#
#  The founder put the reason for caring better than the diagnosis did:
#
#      some of them will not know how to run it, and we would never hear.
#      If we knew why they failed we could guide them in the channels.
#
#  That is the difference between watching for a defect in our software and
#  watching for a person who needed one sentence of help and did not get it.
#  Somebody whose node fails does not open an issue. They close the terminal.
#
#  WHAT IT CANNOT SEE
#
#  Anyone who never reached us at all. A closed port on their side, a wrong
#  address, a build that would not compile -- none of it appears here,
#  because none of it ever touched this node. This shows the ones who got
#  close enough to knock.
#
#  IT NEEDS net LOGGING ON
#
#      wam-cli -testnet logging '["net"]'      # on, no restart needed
#      wam-cli -testnet logging '[]' '["net"]' # off again
#
#  Without it the node records nothing about connections and this reports
#  that it could not answer -- which is not the same as nobody having come.
#
#  NO ADDRESSES ARE PRINTED, EVER
#
#  Peers are named by country when we already know them and "a visitor"
#  otherwise. A list of who runs a node is a list of who to attack, and that
#  rule does not bend because the output is convenient.
# ===========================================================================

import os
import argparse
import re
import subprocess
import sys
from collections import defaultdict

# Addressing a chain with wam-cli lives in one place. Each of these files
# had its own copy, and every copy mapped mainnet to an EMPTY flag -- which
# means the default datadir, which on both servers is the TESTNET node. Asked
# to check mainnet, they all quietly checked testnet.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wamcli import flags as _wamcli_flags   # noqa: E402

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# Ours and the operators we already know, so the report is about strangers.
KNOWN = {
    "71.38.219.3": "United States",
    "91.216.73.201": "Spain",
    "169.58.159.165": "ours (Germany)",
    "5.223.52.200": "ours (Singapore)",
    "13.140.33.187": "ours (US-east)",
    "127.0.0.1": "localhost",
}

IP = re.compile(r"(?:\d{1,3}\.){3}\d{1,3}")

# Every pattern below is a string taken out of net.cpp and net_processing.cpp
# rather than guessed, and each maps to something a person could act on.
ENDINGS = [
    (re.compile(r"socket closed for peer", re.I),
     "they closed it",
     "Normal. The node was stopped or the machine went away. Nobody needs help."),
    (re.compile(r"version handshake timeout|non-version message before version handshake", re.I),
     "the handshake never finished",
     "Their build never introduced itself. Usually an incomplete or wrong "
     "binary, or something between us eating the first message."),
    (re.compile(r"connected to self", re.I),
     "it was us",
     "Our own address dialled back. Nothing to do."),
    (re.compile(r"dropped \(banned\)|dropped \(discouraged\)|Disconnecting and discouraging", re.I),
     "WE refused them",
     "Our node turned them away. This is the one ending that is our fault, "
     "and it is worth reading the lines around it."),
    (re.compile(r"not accepting new connections", re.I),
     "WE had no slot",
     "Connection limit reached. Raise maxconnections."),
    (re.compile(r"socket (recv|send) error", re.I),
     "the link broke",
     "The connection failed mid-flight -- their side or the path between. "
     "Common on a home connection behind a router that drops idle sockets."),
    (re.compile(r"Timeout downloading (block|headers)", re.I),
     "too slow to sync",
     "They connected but could not keep up. A very slow link, or a machine "
     "under load."),
    (re.compile(r"insufficient work|for old chain", re.I),
     "they were on a different chain",
     "Almost always the wrong network flag -- mainnet software pointed at "
     "testnet, or the reverse. One sentence of guidance fixes it."),
]


def rsh(host, cmd, timeout=90):
    try:
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                            f"root@{host}", cmd],
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except Exception as e:
        return 1, str(e)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", required=True)
    # mainnet by default. Until 18 September every check here defaulted to
    # testnet, written when testnet was the only chain and never revisited;
    # run by hand without the flag, three days into mainnet, they answered
    # confidently about a chain with nothing on it.
    ap.add_argument("--network", default="mainnet",
                    choices=["mainnet", "testnet", "regtest"])
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--unit", default="wamd")
    args = ap.parse_args()

    flag = _wamcli_flags(args.network)
    print(f"\n{BLD}who came, and why they did not stay{OFF}")

    rc, log = rsh(args.host, f"journalctl -u {args.unit} --since '{args.hours} hours ago' "
                             f"--no-pager -o short-iso 2>/dev/null")
    if rc != 0 or not log.strip():
        print(f"  {YEL}!!{OFF}    could not read the node's journal on {args.host}")
        return 1

    rc, logging_on = rsh(args.host, f"wam-cli {flag} logging 2>/dev/null")
    if '"net": true' not in logging_on.replace(" ", " "):
        print(f"  {YEL}!!{OFF}    net logging is OFF on this node, so connections are")
        print(f"        not recorded. Turn it on with:")
        print(f"          wam-cli {flag} logging '[\"net\"]'")
        print(f"        This check could not answer, which is not a pass.\n")
        return 1

    # peer id -> address, taken from whichever line first names both.
    peer_addr = {}
    for line in log.split("\n"):
        m = re.search(r"peer=(\d+)", line)
        a = IP.search(line)
        if m and a:
            peer_addr.setdefault(m.group(1), a.group(0))

    # A peer that never sent a version message never introduced itself, and
    # was therefore not a node. Port scanners do this constantly on any
    # public port, and so did our own explorer for forty minutes on the day
    # this was written -- a self-connection every five minutes, opened and
    # closed in the same second, straight into the log we had just turned on
    # to study visitors.
    #
    # Counting those as people would bury the one real visitor in noise, and
    # would keep doing it forever.
    spoke = set()
    for line in log.split("\n"):
        m = re.search(r"peer=(\d+)", line)
        if m and re.search(r"version", line, re.I):
            spoke.add(m.group(1))

    events = defaultdict(list)
    for line in log.split("\n"):
        m = re.search(r"peer=(\d+)", line)
        if not m:
            continue
        pid = m.group(1)
        if pid not in spoke:
            continue
        addr = peer_addr.get(pid)
        if addr in KNOWN:
            continue
        for pat, ending, advice in ENDINGS:
            if pat.search(line):
                when = line.split(" ")[0][:19].replace("T", " ")
                events[(ending, advice)].append(when)
                break

    if not events:
        print(f"  {GRN}ok{OFF}    no stranger connected or left in the last "
              f"{args.hours} h -- only peers we already know")
        print()
        return 0

    for (ending, advice), whens in sorted(events.items(), key=lambda x: -len(x[1])):
        mark = RED if ending.startswith("WE ") else GRN
        print(f"\n  {mark}{ending}{OFF}  -- {len(whens)} time(s)")
        print(f"        last at {whens[-1]}")
        print(f"        {advice}")

    ours = [e for (e, _), w in events.items() if e.startswith("WE ")]
    print()
    if ours:
        print(f"  {RED}some visitors were turned away by this node{OFF}\n")
        return 1
    print(f"  {GRN}nobody was turned away by us{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
