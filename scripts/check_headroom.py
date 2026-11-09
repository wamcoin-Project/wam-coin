#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_headroom.py -- warn while there is still time to do something
===============================================================================

     python3 scripts/check_headroom.py --nodes "ip ip ip"

 WHY THIS EXISTS

 The daily report already prints free memory and free disk for each machine,
 and on 2026-10-11 it read:

 <!-- wam:quote-begin -->
     Germany: 9653/11960 MB free, 173G disk
     Singapore: 1156/1914 MB free, 29G disk
     US-east: 6609/7941 MB free, 75G disk ... US-east has no swap
 <!-- wam:quote-end -->

 All healthy, and the founder asked the right question of it: tell me BEFORE
 it gets tight, with enough warning to buy a bigger machine.

 A threshold alone cannot do that. "Below 10% free" fires on the day it is
 already a problem, in the middle of the night, with a chain that needs to
 stay in sync. What gives warning is the SLOPE: a machine losing 40 MB of
 disk a day has four months; one losing 400 MB a day has twelve days, and
 both of them look fine today.

 A blockchain is the clearest case there is. It only grows. Every two
 minutes it grows again, and nothing ever gives the space back.

 WHAT THIS DOES

 It reads memory and disk on every host, writes one sample per run into
 /var/lib/wam-headroom/samples.json ON THAT HOST -- so the history belongs to
 the machine and survives whichever laptop happens to run the check -- and
 then reports three things for each: where it stands, which way it is going,
 and how long it has at that rate.

 It needs at least two samples a day apart before it can say anything about a
 trend, and it says so plainly until then rather than inventing a slope from
 two readings an hour apart.

 EXIT CODES, this project's convention

     0  every host has room, and nothing is trending into trouble
     1  a host is below the floor, or will cross it within the warning window
     2  a host could not be asked. Nothing was learned about it, which is not
        the same as it being fine.
===============================================================================
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shlex
import subprocess
import sys
import time

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

STATE = "/var/lib/wam-headroom/samples.json"
KEEP = 400                 # samples retained per host; a year of daily runs

# The floor is where it hurts, and the window is how much warning we want
# before reaching it. Crossing the floor is a failure; being on course to
# cross it inside the window is a warning, which is the whole point.
FLOOR_PCT = 12.0
WARN_WINDOW_DAYS = 45

# A machine with no swap has no slack at all: when memory runs out it kills
# a process rather than slowing down. It gets a higher floor.
NOSWAP_FLOOR_PCT = 20.0

PROBE = r"""
set -e
mkdir -p /var/lib/wam-headroom
python3 - <<'PYEOF'
import json, os, subprocess, time
state = "/var/lib/wam-headroom/samples.json"

def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout

mem = {}
for line in sh("free -m").splitlines():
    f = line.split()
    if f and f[0] == "Mem:":
        mem = {"total": int(f[1]), "available": int(f[-1])}
    if f and f[0] == "Swap:":
        mem["swap_total"] = int(f[1])

disk = {}
for line in sh("df -m --output=target,size,avail /").splitlines()[1:]:
    f = line.split()
    if len(f) == 3:
        disk = {"total": int(f[1]), "available": int(f[2])}

big = sh("ps -eo rss,comm --sort=-rss | sed -n 2p").split()
sample = {
    "t": int(time.time()),
    "mem": mem,
    "disk": disk,
    "largest": {"name": big[1] if len(big) > 1 else "?",
                "mb": int(big[0]) // 1024 if big else 0},
}

try:
    with open(state) as fh:
        hist = json.load(fh)
except Exception:
    hist = []
hist.append(sample)
hist = hist[-400:]
tmp = state + ".tmp"
with open(tmp, "w") as fh:
    json.dump(hist, fh)
os.replace(tmp, state)
print(json.dumps({"now": sample, "history": hist}))
PYEOF
"""


def ask(host):
    """Take a sample on the host and get its history back. None if it could
    not be asked -- which is reported as such, never as health."""
    try:
        p = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
             f"root@{host}", PROBE],
            capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        return None, f"{type(e).__name__}"
    if p.returncode != 0:
        why = (p.stderr or "").strip().splitlines()
        return None, (why[-1][:60] if why else f"ssh exit {p.returncode}")
    try:
        return json.loads(p.stdout.strip().splitlines()[-1]), None
    except Exception as e:
        return None, f"unreadable answer ({type(e).__name__})"


def slope_per_day(history, pick):
    """MB per day, from the oldest sample that is at least a day old.

    Two readings an hour apart say nothing about a month, so this refuses to
    answer rather than inventing a line through noise.
    """
    if len(history) < 2:
        return None
    now = history[-1]
    for old in history:
        gap = now["t"] - old["t"]
        if gap >= 20 * 3600:
            a, b = pick(old), pick(now)
            if a is None or b is None:
                return None
            return (b - a) / (gap / 86400.0)
    return None


def report(label, avail, total, floor, rate, out):
    pct = 100.0 * avail / total if total else 0.0
    line = f"{avail:,} of {total:,} MB free ({pct:.0f}%)"
    if rate is None:
        out.append(("ok" if pct >= floor else "fail", f"{label}: {line}, "
                    f"no trend yet -- needs a sample at least a day older"))
        return
    direction = "losing" if rate < 0 else "gaining"
    line += f", {direction} {abs(rate):,.0f} MB/day"
    if pct < floor:
        out.append(("fail", f"{label}: {line} -- already under the {floor:.0f}% floor"))
        return
    if rate >= -0.5:
        out.append(("ok", f"{label}: {line}"))
        return
    room = avail - (total * floor / 100.0)
    days = room / abs(rate)
    if days <= WARN_WINDOW_DAYS:
        out.append(("warn", f"{label}: {line} -- reaches {floor:.0f}% in about "
                            f"{days:.0f} day(s)"))
    else:
        out.append(("ok", f"{label}: {line}, about {days:.0f} day(s) of room"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--nodes", required=True,
                    help="space-separated hosts to ask")
    a = ap.parse_args()

    print(f"\n{BLD}every machine has room, and is not quietly running out{OFF}\n")

    failed, unasked, warned = [], [], []
    for host in shlex.split(a.nodes.replace(",", " ")):
        data, why = ask(host)
        if data is None:
            print(f"  {YEL}??{OFF}    {host:<16} could not be asked ({why})")
            unasked.append(host)
            continue

        now, hist = data["now"], data["history"]
        out = []
        mem, disk = now.get("mem", {}), now.get("disk", {})
        noswap = not mem.get("swap_total")
        mem_floor = NOSWAP_FLOOR_PCT if noswap else FLOOR_PCT

        report("memory", mem.get("available", 0), mem.get("total", 1), mem_floor,
               slope_per_day(hist, lambda s: s.get("mem", {}).get("available")),
               out)
        report("disk  ", disk.get("available", 0), disk.get("total", 1),
               FLOOR_PCT,
               slope_per_day(hist, lambda s: s.get("disk", {}).get("available")),
               out)

        print(f"  {BLD}{host}{OFF}"
              + ("   (no swap -- memory floor is raised)" if noswap else ""))
        for kind, text in out:
            mark = {"ok": f"  {GRN}ok{OFF}  ", "warn": f"  {YEL}!!{OFF}  ",
                    "fail": f"  {RED}FAIL{OFF}"}[kind]
            print(f"    {mark}  {text}")
            if kind == "fail":
                failed.append(f"{host} {text}")
            elif kind == "warn":
                warned.append(f"{host} {text}")
        big = now.get("largest", {})
        print(f"          largest process: {big.get('name','?')} "
              f"{big.get('mb',0):,} MB   ({len(hist)} sample(s) kept)")

    print()
    if failed:
        print(f"  {RED}{len(failed)} machine(s) are past the floor{OFF}")
        for f in failed:
            print(f"    {f}")
        print()
        return 1
    if warned:
        print(f"  {YEL}{len(warned)} machine(s) will reach the floor inside "
              f"{WARN_WINDOW_DAYS} days{OFF}")
        for w in warned:
            print(f"    {w}")
        print("\n  This is the warning, not the emergency: there is time to")
        print("  move, resize, or prune before anything stops.\n")
        return 1
    if unasked:
        print(f"  {YEL}{len(unasked)} machine(s) could not be asked: "
              f"{', '.join(unasked)}{OFF}")
        print(f"  {YEL}A machine nobody could reach is not a machine with "
              f"room.{OFF}\n")
        return 2
    print(f"  {GRN}{BLD}every machine has room, and none of them is losing "
          f"it fast enough to matter{OFF}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
