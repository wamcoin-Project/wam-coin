#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""peer_watch.py -- notice when one of our own seeds stops being there.

    python3 scripts/peer_watch.py                 # once, from a timer
    python3 scripts/peer_watch.py --dry-run       # print, send nothing
    python3 scripts/peer_watch.py --status        # what it currently believes

WHY THIS EXISTS

On 11 September every WAM service on the Germany host was stopped for eight
minutes, deliberately, to answer a question the schedule had been carrying
since the 9th: does the network survive losing a seed?

The network survived. The telling did not. One alarm arrived and it said

    ALARM  wam-reorg-watch@testnet.service FAILED on vmi3500463

which is a helper script exiting non-zero, not a seed node dying, the
explorer and pool returning 502 to the public, and the chain producing
nothing for four block times. And every part of that alarm -- the watcher
that noticed, the unit that fired, the credentials it sent with -- was
running on the machine that had just died. It arrived because Germany was
alive enough to send it.

A power cut would have been silent. Singapore does not watch Germany. The new
seed watched nothing at all. The only thing looking at all three was the
operations panel on a laptop, which is not always on.

WHAT IT WATCHES, AND WHY IT NEEDS NO NEW ACCESS

Not SSH. Germany already holds a key Singapore accepts, and daily_report.py
says in writing why that is a risk worth naming: if Germany is taken, what
that key reaches goes with it. Adding two more such paths to make a watchdog
would be buying a smaller failure with a larger one.

It watches the peer list the node already has. Our seeds connect to each
other by `addnode`, so if Singapore is up, it is in Germany's getpeerinfo. If
it stops appearing there, Germany knows without asking anybody for anything.

That also makes the check honest about what it can see: it reports "I can no
longer see this host from here", which is true and useful, rather than "that
host is down", which no single machine can know.

WHY IT WILL NOT CRY WOLF

A peer connection drops for ordinary reasons -- a restart, a network blip, a
seed rotating its own connections. Alarming on the first miss would produce
noise, and a watcher that is usually wrong is a watcher nobody reads.

So it needs the same host missing on MISSES_BEFORE_ALARM consecutive runs
before it says anything, and it says it once. When the host comes back it
says that once too, with how long it was gone -- because the thing the Germany
rehearsal proved was missing is not only "something broke" but "it is over".
"""

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from wamnotify import send as notify  # noqa: E402

# The other seeds, by address, as the node itself sees them. A name would need
# DNS to resolve before this check could run, and DNS is one of the things
# that breaks.
SEEDS = {
    "169.58.159.165": "Germany",
    "5.223.52.200": "Singapore",
    "13.140.33.187": "US-east",
}

STATE = pathlib.Path(os.environ.get("WAM_PEER_WATCH_STATE",
                                    "/var/lib/wam-peer-watch/state.json"))

# Three misses on a five-minute timer is fifteen minutes of absence before
# anybody is woken. Long enough that a restart passes unremarked, short
# enough to matter on a launch night.
MISSES_BEFORE_ALARM = 3

CLI = os.environ.get("WAM_CLI", "/opt/wam-current-bin/wam-cli")
NETWORK = os.environ.get("WAM_NETWORK", "testnet")
CONF = os.environ.get("WAM_CONF", "/root/.wam/wam.conf")
DATADIR = os.environ.get("WAM_DATADIR", "/root/.wam")


def me():
    """This host's own address, so it does not watch itself."""
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True,
                             text=True, timeout=10).stdout.split()
        for a in out:
            if a in SEEDS:
                return a
    except Exception:
        pass
    # Falls back to the hostname, which our seeds carry: seed3, vmi..., etc.
    return None


def wamcli(*args):
    cmd = [CLI]
    if NETWORK == "testnet":
        cmd.append("-testnet")
    if os.path.exists(CONF):
        cmd += [f"-conf={CONF}", f"-datadir={DATADIR}"]
    cmd += list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        return r.stdout if r.returncode == 0 else None
    except Exception:
        return None


def visible_peers():
    """Addresses this node currently has a connection to.

    Returns None -- not an empty set -- when the question could not be asked.
    An empty set means "connected to nobody", which is an alarm. None means
    "our own node is not answering", which is a different alarm and not this
    script's business: wamd has OnFailure= for that.
    """
    raw = wamcli("getpeerinfo")
    if raw is None:
        return None
    try:
        peers = json.loads(raw)
    except Exception:
        return None
    return {p.get("addr", "").rsplit(":", 1)[0] for p in peers}


def load():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(state):
    try:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        tmp.replace(STATE)
    except Exception as e:
        print(f"could not write {STATE}: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be sent, send nothing")
    ap.add_argument("--status", action="store_true",
                    help="print what this watcher currently believes, and exit")
    a = ap.parse_args()

    state = load()
    if a.status:
        print(json.dumps(state, indent=2) if state else "no state yet")
        return 0

    self_addr = me()
    watched = {ip: name for ip, name in SEEDS.items() if ip != self_addr}
    if not watched:
        print("this host is not in SEEDS, or is the only one -- nothing to watch")
        return 2

    seen = visible_peers()
    if seen is None:
        # Our own node is silent. Saying "Singapore is gone" from a host whose
        # node is not answering would be a lie about somebody else.
        print("our own node did not answer getpeerinfo -- nothing compared")
        return 2

    first_run = not state
    alarms = []
    now = int(time.time())

    for ip, name in sorted(watched.items()):
        rec = state.setdefault(ip, {"misses": 0, "alarmed": False, "since": now})
        if ip in seen:
            if rec["alarmed"]:
                gone = int((now - rec.get("since", now)) / 60)
                alarms.append(
                    f"RECOVERED  {name} ({ip}) is visible again from "
                    f"{self_addr or 'this host'}, after about {gone} minute(s).")
            rec.update(misses=0, alarmed=False, since=now)
            continue

        rec["misses"] += 1
        if rec["misses"] == 1:
            rec["since"] = now
        if rec["misses"] >= MISSES_BEFORE_ALARM and not rec["alarmed"]:
            rec["alarmed"] = True
            mins = int((now - rec["since"]) / 60)
            alarms.append(
                f"ALARM  {name} ({ip}) has not been a peer of "
                f"{self_addr or 'this host'} for {rec['misses']} checks "
                f"(~{mins} min).\n"
                f"This host can still be reached, so this is about that one: "
                f"either its node is down, or the network between us is.\n"
                f"Nothing here can tell which. Look at the panel, and at "
                f"whether the explorer and the pool answer.")

    save(state)

    if first_run:
        # Learning quietly, and saying so. login_watch settled this argument
        # on its own first run: silence on a first run is indistinguishable
        # from a broken watcher.
        msg = (f"peer watch started on {self_addr or 'this host'}. It is "
               f"watching {', '.join(sorted(watched.values()))} through this "
               f"node's own peer list, and will speak only when one of them "
               f"stops appearing for {MISSES_BEFORE_ALARM} checks.")
        print(msg)
        notify(msg, a.dry_run)
        return 0

    if not alarms:
        print(f"all {len(watched)} other seed(s) visible from "
              f"{self_addr or 'this host'}")
        return 0

    for line in alarms:
        print(line)
        notify(line, a.dry_run)
    return 1


if __name__ == "__main__":
    sys.exit(main())
