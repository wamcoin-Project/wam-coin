#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  login_watch.py -- know within seconds when somebody gets in
# ===========================================================================
#
#      python3 scripts/login_watch.py            # follow, alert, forever
#      python3 scripts/login_watch.py --backfill 24h --dry-run
#
#  WHY THIS EXISTS
#
#  Everything else this project watches is health: is the node up, is the
#  chain intact, did the backup run. Nothing watched who comes in. A server
#  holding the pool wallet had no answer at all to "did anyone log in
#  today", at any speed.
#
#  WHY IT CANNOT SIMPLY ALERT ON EVERY LOGIN
#
#  There were 103 successful authentications on the pool host today, all of
#  them the founder's own automation. An alarm that fires a hundred times a
#  day is read for two days and ignored for ever after, and then it is worse
#  than nothing, because it is believed to be watching.
#
#  So it alerts on what is NEW, not on what happens:
#
#    * a key fingerprint that has never been seen here          -> ALARM
#    * a known key from an address never seen before            -> notice
#    * a change to authorized_keys                              -> ALARM
#    * a new account that can log in                            -> ALARM
#    * a new listening port                                     -> notice
#
#  The first is the one that matters. Every legitimate login to these
#  machines is made with one of two keys, both the founder's, from his own
#  laptop. A third fingerprint means somebody put a key there.
#
#  WHY THE JOURNAL AND NOT last(1)
#
#  wtmp records interactive sessions only. Every one of those 103 logins was
#  non-interactive -- `ssh host command` allocates no pty -- and last(1)
#  showed the most recent login as ten days ago while automation had been
#  connecting all afternoon. An intruder running commands rather than
#  opening a shell would have been invisible to it.
#
#  sshd's own "Accepted publickey" line records both, and carries the
#  fingerprint, which is what makes the distinction above possible.
# ===========================================================================

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

# Delivery -- Telegram where there is a token, a parked file where there is
# not -- lives in one module, because the second thing that needed to raise an
# alarm (unit_alert.py) would otherwise have copied these rules, and a copy is
# where two versions start to differ.
from wamnotify import send as notify

STATE = "/var/lib/wam-login-watch/state.json"
AUTHKEYS = "/root/.ssh/authorized_keys"

ACCEPTED = re.compile(
    r"Accepted (\S+) for (\S+) from ([0-9a-fA-F:.]+) port \d+ ssh2:"
    r"(?:\s+(\S+)\s+(\S+))?")


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(s):
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(s, f)
        os.replace(tmp, STATE)
    except OSError:
        pass


def network_of(ip):
    """The address's network, not the address.

    Six logins over three days came from six different addresses and a
    single /24 -- one home line changing its last octet. (The range was
    written out here until 13 November 2026, when an outside reader found
    the same thing in explorer/lib/network.js: it is one identified
    person's home network, in a public repository, and naming it taught a
    reader nothing the sentence does not.) Keyed on
    the whole address this watcher would announce a new one most days, and
    an alarm that fires most days is read for a week. Keyed on the /24 it is
    silent for that churn and speaks the moment a login arrives from a
    network that has never been used here, which is the thing worth
    knowing.
    """
    if ":" in ip:                       # IPv6: the /64 is the assignment
        return ":".join(ip.split(":")[:4]) + "::/64"
    parts = ip.split(".")
    return ".".join(parts[:3]) + ".0/24" if len(parts) == 4 else ip


def host():
    try:
        return open("/etc/hostname").read().strip()
    except OSError:
        return "?"


def authkeys_digest():
    """A digest, not the keys. What matters is that it changed."""
    try:
        with open(AUTHKEYS, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:16]
    except OSError:
        return None


def known_fingerprints():
    """Every fingerprint currently authorised, so a login with one that is
    not in this list is a login with a key nobody put there on purpose."""
    fps = set()
    try:
        out = subprocess.run(["ssh-keygen", "-lf", AUTHKEYS],
                             capture_output=True, text=True, timeout=20).stdout
        for line in out.splitlines():
            m = re.search(r"(SHA256:\S+)", line)
            if m:
                fps.add(m.group(1))
    except Exception:
        pass
    return fps


def logins_since(since):
    p = subprocess.run(
        ["journalctl", "-u", "ssh", "--since", since, "--no-pager", "-o", "cat"],
        capture_output=True, text=True, timeout=120)
    out = []
    for line in p.stdout.splitlines():
        m = ACCEPTED.search(line)
        if m:
            out.append({"method": m.group(1), "user": m.group(2),
                        "ip": m.group(3), "fp": m.group(5) or "?"})
    return out


def examine(events, state, dry, quiet_first_run):
    seen_fp = set(state.get("fingerprints", []))
    seen_pairs = set(tuple(x) for x in state.get("pairs", []))
    authorised = known_fingerprints()
    alarms = []

    for e in events:
        fp, ip = e["fp"], e["ip"]
        net = network_of(ip)
        pair = (fp, net)
        if fp not in authorised and fp != "?":
            alarms.append(
                f"ALARM  a login on {host()} used key {fp}, which is NOT in "
                f"authorized_keys. Somebody added a key and removed it again, "
                f"or sshd is reading a file you do not know about.")
        elif fp not in seen_fp and fp != "?":
            alarms.append(
                f"ALARM  first ever login on {host()} with key {fp} "
                f"(user {e['user']}, from {ip}). It is authorised, but it has "
                f"never been used here before.")
        elif pair not in seen_pairs:
            alarms.append(
                f"notice  {host()}: a known key logged in from {net}, a "
                f"network never used here before. If that was not you, "
                f"it is not you.")
        seen_fp.add(fp)
        seen_pairs.add(pair)

    digest = authkeys_digest()
    if state.get("authkeys") and digest and digest != state["authkeys"]:
        alarms.append(
            f"ALARM  {host()}: authorized_keys CHANGED. Somebody added or "
            f"removed a key. Check it now.")
    state["authkeys"] = digest

    logins = set()
    try:
        for line in open("/etc/passwd"):
            f = line.split(":")
            if len(f) > 6 and not f[6].strip().endswith(("nologin", "false")):
                logins.add(f[0])
    except OSError:
        pass
    if state.get("accounts") and logins - set(state["accounts"]):
        alarms.append(
            f"ALARM  {host()}: new account(s) that can log in: "
            f"{', '.join(sorted(logins - set(state['accounts'])))}")
    state["accounts"] = sorted(logins)

    ports = set()
    try:
        out = subprocess.run(["ss", "-lntH"], capture_output=True, text=True,
                             timeout=20).stdout
        for line in out.splitlines():
            f = line.split()
            if len(f) > 3:
                ports.add(f[3].rsplit(":", 1)[-1])
    except Exception:
        pass
    if state.get("ports") and ports - set(state["ports"]):
        alarms.append(
            f"notice  {host()}: now listening on port(s) "
            f"{', '.join(sorted(ports - set(state['ports'])))}, which were "
            f"closed before.")
    state["ports"] = sorted(ports)

    state["fingerprints"] = sorted(seen_fp)
    # Pairs are capped: an address that has not been used in months is not
    # worth remembering, and an unbounded list eventually stops being read.
    state["pairs"] = [list(p) for p in sorted(seen_pairs)][-400:]

    # The first run has nothing to compare against, so everything looks new.
    # Learning quietly is the only honest thing to do, and saying so matters
    # more than the silence.
    if quiet_first_run:
        return [f"login watch started on {host()}. It has learned "
                f"{len(seen_fp)} key(s) and {len(seen_pairs)} network(s) as "
                f"normal, and will speak only when something is not."]
    return alarms


OTHERS = ["5.223.52.200"]
REPORT_KEY = "/root/.ssh/id_report"

# The parked file holds up to two hundred lines, and a machine in a restart
# loop fills it. Forwarding all of them would turn one broken unit on the
# other side of the world into two hundred messages on a telephone -- the
# flood this whole path exists to avoid, arriving by the back door. Six per
# run, and a line saying how many are still queued.
FORWARD_PER_RUN = 6


def collect_parked(state):
    """Forward what the other machine could not send itself.

    It cannot tell us it has already been forwarded -- the key it accepts
    runs one read-only command and cannot write anything back -- so the
    dedupe is kept here, by hash. A line seen once is never sent twice.
    """
    if not os.path.exists(REPORT_KEY):
        return []
    forwarded = set(state.get("forwarded", []))
    out = []
    for ip in OTHERS:
        try:
            p = subprocess.run(
                ["ssh", "-i", REPORT_KEY, "-o", "BatchMode=yes",
                 "-o", "ConnectTimeout=10", f"root@{ip}", "facts"],
                capture_output=True, text=True, timeout=45)
        except Exception:
            continue
        if "###alarm" not in p.stdout:
            continue
        block = p.stdout.split("###alarm", 1)[1].split("###end", 1)[0]
        fresh = []
        for line in block.splitlines():
            line = line.strip()
            if not line:
                continue
            # The parking host stamps each line with the time it was written,
            # so it can drop its own stale ones. Strip it before hashing and
            # before sending: the reader does not need an epoch, and hashing
            # it would make the same alarm look new every time it is parked.
            line = re.sub(r"^\[\d+\]\s*", "", line)
            h = hashlib.sha256(line.encode()).hexdigest()[:16]
            if h in forwarded:
                continue
            fresh.append((h, line))
        # Oldest first: the line that explains why the rest happened is the
        # one at the top, and it is the one worth having.
        for h, line in fresh[:FORWARD_PER_RUN]:
            forwarded.add(h)
            out.append(line)
        if len(fresh) > FORWARD_PER_RUN:
            out.append(f"({len(fresh) - FORWARD_PER_RUN} more line(s) waiting "
                       f"on {ip}; they follow at six per run. Something over "
                       f"there is repeating.)")
    state["forwarded"] = sorted(forwarded)[-500:]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--backfill", default="30min",
                    help="how far back to read on each run")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    state = load()
    first = not state.get("fingerprints")
    events = logins_since("2 days ago" if first else a.backfill)
    alarms = examine(events, state, a.dry_run, first)
    alarms += collect_parked(state)
    if not a.dry_run:
        save(state)

    # THE MACHINE KEEPS WHAT IT SHOUTED.
    #
    # notify() delivers to Telegram or parks the line for another host to
    # forward, and it prints nothing. So an alarm existed only in a chat
    # application: on 8 October 2026 the founder asked about a port notice
    # from this watcher, and the machine that raised it had no record of
    # raising it. `journalctl -u wam-login-watch` held 21 days of "nothing
    # new" and not one alarm. Nothing could say WHEN it fired, and the only
    # copy was a message a person happened to still have on a telephone.
    #
    # Printing costs a line. It gives the host that saw the thing a durable,
    # searchable, local record of what it saw -- which is the first question
    # anybody asks afterwards, and the one this watcher could not answer.
    # Not under --dry-run: send() already prints there, and two copies of an
    # alarm in the output is how a reader learns to skim it.
    for line in alarms:
        if not a.dry_run:
            print(line, flush=True)
        notify(line, a.dry_run)
    if not alarms:
        print("nothing new")
    return 0


if __name__ == "__main__":
    sys.exit(main())
