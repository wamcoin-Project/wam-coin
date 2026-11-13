#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  mainnet_listener.py -- who is already waiting on the mainnet port?
# ===========================================================================
#
#      python3 scripts/mainnet_listener.py --hours 24
#      python3 scripts/mainnet_listener.py --report
#
#  WHY THIS EXISTS
#
#  On 4 September 2026 a mainnet node was started for twenty-one minutes as
#  part of the Phase E rehearsal. Two seconds after port 9555 opened, one node
#  connected, said /WAM:0.1.6/, and stayed until it was disconnected. Its
#  address appears nowhere in the testnet node's journal -- not once, ever.
#  Somebody had read the documentation, configured a node for mainnet only,
#  and left it retrying.
#
#  (The address was written out here until 13 November 2026. It is a stranger
#  who ran a node before we asked anyone to, and this project's own rule is
#  that a list of who runs a node is a list of who can be attacked. The story
#  is the point; the address was never part of it.)
#
#  That is the first real operator waiting for launch, and we only saw them
#  because the port happened to be open for a few minutes. Nothing counts
#  them. How many exist is the number that decides whether the BitcoinTalk
#  announcement is early or late, and it is knowable.
#
#  WHY NOT JUST RUN A NODE FOR A DAY
#
#  Because a mainnet node started before 15 September works once and then
#  fails at every restart, with an error about a block from the future, and
#  its datadir has to be emptied afterwards. An unattended upgrade restarted a
#  service on this very machine two days ago. Leaving that trap armed for a
#  day, to collect a number, is a bad trade -- and it is the exact failure
#  scripts/genesis_gate.sh exists to prevent.
#
#  This holds the port and nothing else. No chain, no datadir, no wallet, no
#  gate, nothing to wipe. It cannot mine, cannot serve a block, and cannot be
#  left in a state that breaks the launch.
#
#  HOW IT TELLS A NODE FROM A PORT SCANNER
#
#  The first four bytes. Every WAM message begins with the network magic
#  0x57 0x41 0x4d 0x21 -- "WAM!" -- which Bitcoin's f9 be b4 d9 is not, and
#  which a scanner never sends because it does not know the protocol. A
#  scanner connects and closes; a node introduces itself. That distinction was
#  learned the hard way in this project, from a French address that looked
#  like an operator and was one second of TCP.
#
#  It reads the version message far enough to take the user agent, so the
#  answer is not "somebody connected" but "a node on v0.1.6 is waiting" -- and
#  a node on a version below the consensus floor is a person who needs telling
#  before launch, not after.
#
#  WHAT IT DOES NOT DO
#
#  It never completes a handshake, so nobody's node believes it found a peer
#  and stops looking for real ones. It replies to nothing and closes at once.
#
#  And it does not publish addresses. Running a node is a favour to this
#  project and a list of who does it is a list of who to attack. The log is
#  local, mode 0600; --report prints counts, versions and countries only.
# ===========================================================================

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import struct
import sys
import time
from collections import Counter

MAGIC = bytes([0x57, 0x41, 0x4D, 0x21])          # "WAM!" -- mainnet
LOG = "/var/lib/wam-mainnet-listener/seen.jsonl"

# The launch. A listener still holding 9555 when the real node wants it is a
# failure of exactly the kind this was written to avoid, so it refuses to
# start inside this margin and stops itself well before.
GENESIS = 1789430400                              # 2026-09-15 00:00:00 UTC
REFUSE_WITHIN_HOURS = 36

GRN = "\033[32m"; RED = "\033[31m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"


def user_agent(sock, header_len_field):
    """Read the version payload far enough to lift the user agent out.

    version(4) services(8) timestamp(8) addr_recv(26) addr_from(26) nonce(8)
    then a varstr. 80 bytes of fixed fields before it.
    """
    try:
        want = min(header_len_field, 512)
        payload = b""
        sock.settimeout(4)
        while len(payload) < want:
            chunk = sock.recv(want - len(payload))
            if not chunk:
                break
            payload += chunk
        if len(payload) < 81:
            return None
        n = payload[80]
        if n >= 0xFD:                              # a longer varint; not worth it
            return None
        ua = payload[81:81 + n].decode("ascii", "replace")
        return ua or None
    except Exception:
        return None


def record(entry):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
        os.chmod(LOG, 0o600)
    except OSError:
        pass


def listen(hours, port, quiet):
    left = (GENESIS - time.time()) / 3600
    if left < REFUSE_WITHIN_HOURS:
        print(f"  {RED}refusing{OFF}: launch is in {left:.0f}h and this holds "
              f"port {port}, which the real node needs.")
        return 2

    end = time.time() + hours * 3600
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind(("0.0.0.0", port))
    except OSError as e:
        print(f"  {RED}cannot bind {port}{OFF}: {e}")
        print(f"  If a mainnet node is running, stop it -- both cannot hold it.")
        return 1
    srv.listen(32)
    srv.settimeout(5)

    print(f"\n{BLD}listening on {port} for {hours}h{OFF}")
    print(f"  it answers nothing and closes at once, so no node believes it")
    print(f"  found a peer. Log: {LOG}\n")

    nodes = scanners = 0
    while time.time() < end:
        try:
            conn, addr = srv.accept()
        except socket.timeout:
            continue
        except Exception:
            continue

        ip = addr[0]
        seen = {"utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "ip": ip, "kind": "unknown", "agent": None}
        try:
            conn.settimeout(4)
            head = conn.recv(24)
            if len(head) >= 4 and head[:4] == MAGIC:
                seen["kind"] = "node"
                cmd = head[4:16].rstrip(b"\x00").decode("ascii", "replace")
                seen["command"] = cmd
                if cmd == "version" and len(head) >= 20:
                    ln = struct.unpack("<I", head[16:20])[0]
                    seen["agent"] = user_agent(conn, ln)
                nodes += 1
            elif len(head) == 0:
                seen["kind"] = "scanner"      # connected and said nothing
                scanners += 1
            else:
                seen["kind"] = "other-protocol"
                seen["first4"] = head[:4].hex()
                scanners += 1
        except Exception as e:
            seen["kind"] = "scanner"
            seen["why"] = type(e).__name__
            scanners += 1
        finally:
            try:
                conn.close()
            except Exception:
                pass

        record(seen)
        if not quiet:
            mark = f"{GRN}NODE{OFF}" if seen["kind"] == "node" else f"{YEL}scan{OFF}"
            print(f"  {seen['utc']}  {mark}  {seen.get('agent') or seen['kind']}")

    srv.close()
    print(f"\n  finished. {nodes} node contact(s), {scanners} scanner(s).\n")
    return 0


def report():
    try:
        rows = [json.loads(l) for l in open(LOG) if l.strip()]
    except OSError:
        print(f"  nothing recorded yet ({LOG})")
        return 1

    nodes = [r for r in rows if r.get("kind") == "node"]
    ips = {r["ip"] for r in nodes}
    print(f"\n{BLD}who has knocked on the mainnet port{OFF}")
    print(f"  window        : {rows[0]['utc']} .. {rows[-1]['utc']}")
    print(f"  contacts      : {len(rows)}")
    print(f"  spoke WAM     : {len(nodes)}")
    print(f"  distinct nodes: {len(ips)}   <- this is the number that matters")
    print(f"  scanners      : {len(rows) - len(nodes)}")

    agents = Counter(r.get("agent") for r in nodes if r.get("agent"))
    if agents:
        print(f"\n  versions waiting:")
        for a, n in agents.most_common():
            print(f"    {a:<18} {n} contact(s)")

    # Addresses are never printed. A count of who runs a node is publishable;
    # a list of them is a list of who to attack.
    print(f"\n  addresses are in {LOG}, mode 0600, and are not printed here.")
    print()
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--port", type=int, default=9555)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    return report() if a.report else listen(a.hours, a.port, a.quiet)


if __name__ == "__main__":
    sys.exit(main())
