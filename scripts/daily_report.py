#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  daily_report.py -- the one that comes to you, rather than waiting to be
#                     asked
# ===========================================================================
#
#      python3 scripts/daily_report.py            # gather and send
#      python3 scripts/daily_report.py --dry-run  # print it, send nothing
#
#  WHY THIS EXISTS
#
#  Everything else here writes into a journal or a file on a server. That is
#  fine while somebody is looking, and the failures that hurt are precisely
#  the ones nobody is looking at: the nightly backup died on both machines
#  on 23 August and stayed dead until the 26th, while the timer stayed green
#  and the sweep reported 21 passed.
#
#  A dashboard does not fix that either, because a dashboard also waits to
#  be opened. What was missing is something that arrives.
#
#  WHAT STOPS IT LYING
#
#  The founder's objection, in his words: "the report sometimes lies". A
#  green message over a broken system is worse than none, because it buys
#  calm that was not earned.
#
#    1. A SEQUENCE NUMBER. If #12 arrives and then #14, report #13 never
#       came -- the machine that sends them was down, and the gap is the
#       alarm. Silence is the one failure a monitor cannot report on its
#       own, and numbering is what makes silence visible.
#    2. AGES, NOT ADJECTIVES. Not "backups ok" but "backup 6h". A value
#       whose age is hidden cannot be judged.
#    3. COULD-NOT-CHECK IS ITS OWN WORD, listed separately from passes and
#       failures, because counting it as either is a lie in one direction.
#    4. IT SAYS WHAT IT CANNOT SEE FROM HERE. This runs on one server, and
#       several checks need a workstation with keys to every host. Rather
#       than pretend those passed, it names them and says where they are
#       run.
#
#  HOW IT READS THE OTHER MACHINE
#
#  Not with a general ssh key. Germany holds a key that Singapore accepts
#  only with a forced command -- /usr/local/bin/wam-facts, which prints
#  status and changes nothing. Asked for a shell, or for /etc/shadow, sshd
#  ignores the request and runs the facts script instead; that was tested
#  rather than assumed. If Germany is ever taken, what that key grants on
#  Singapore is the ability to read a status line.
#
#  It goes to one private chat, never to the announcement channel. An
#  operations report names the weakest machine and the unwatched hour, and
#  that is a map for whoever wants to attack this network.
# ===========================================================================

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONF = "/etc/wam/announce.json"
STATE = "/var/lib/wam-report/state.json"
FACTS = "/usr/local/bin/wam-facts"
KEY = "/root/.ssh/id_report"

ME = ("Germany", None)                     # gathered by running facts locally
OTHERS = [("Singapore", "5.223.52.200"),
          # US-east was missing from every daily report since it was added on
          # 16 September: the list was written when there were two machines.
          # The restricted key was authorised on it on 18 September.
          ("US-east", "13.140.33.187")]

# Consensus floor: below this a node is rejected on mainnet. Read from the
# repository rather than written here, so it cannot go stale.
def consensus_floor():
    try:
        out = subprocess.run(
            [sys.executable, "scripts/consensus_floor.py"], cwd=REPO,
            capture_output=True, text=True, timeout=60).stdout
        m = re.search(r"v?(\d+\.\d+\.\d+)", out)
        return m.group(1) if m else None
    except Exception:
        return None


def read_facts(host):
    """Facts from one machine. Locally if it is this one, else through the
    key that can do nothing else."""
    try:
        if host is None:
            p = subprocess.run([FACTS], capture_output=True, text=True, timeout=60)
        else:
            p = subprocess.run(
                ["ssh", "-i", KEY, "-o", "BatchMode=yes",
                 "-o", "ConnectTimeout=10", f"root@{host}", "facts"],
                capture_output=True, text=True, timeout=60)
        if p.returncode != 0 or "###end" not in p.stdout:
            return None, (p.stderr or p.stdout or "no answer").strip()[:120]
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"

    f, key = {}, None
    for line in p.stdout.splitlines():
        if line.startswith("###"):
            key = line[3:]
            f[key] = []
        elif key:
            f[key].append(line.rstrip())

    def one(k):
        v = [x for x in (f.get(k) or []) if x.strip()]
        return v[0].strip() if v else None

    svc = {}
    for line in f.get("x", []):
        p2 = line.split()
        if len(p2) >= 3:
            svc[p2[0]] = (p2[1], p2[2])

    mem = (one("m") or "").split()
    swap = (one("s") or "").split()
    return {
        "height": one("h"), "tip": one("t"), "peers": one("p"),
        "memFree": mem[0] if mem else None,
        "memTotal": mem[1] if len(mem) > 1 else None,
        "swapTotal": swap[0] if swap else None,
        "diskFreeG": one("d"), "uptime": one("u"), "load": one("l"),
        "git": one("g"),
        "backup": int(one("b")) if (one("b") or "").isdigit() else None,
        "alarms": one("a"), "version": one("v"), "services": svc,
        "failed": [x.strip() for x in f.get("f", []) if x.strip()],
        "maint": one("maint"),
    }, None


def ago(ts):
    if not ts:
        return "never"
    d = int(time.time()) - int(ts)
    if d < 3600:
        return f"{d // 60}m"
    if d < 86400:
        return f"{d // 3600}h"
    return f"{d // 86400}d"


def origin_head():
    try:
        subprocess.run(["git", "-C", REPO, "fetch", "-q", "origin"],
                       capture_output=True, timeout=90)
        r = subprocess.run(["git", "-C", REPO, "rev-parse", "--short",
                            "origin/main"], capture_output=True, text=True,
                           timeout=30)
        return r.stdout.strip() or None
    except Exception:
        return None


def local_check(name, argv, timeout):
    """A repository check that needs no ssh to anywhere."""
    try:
        p = subprocess.run(argv, cwd=REPO, capture_output=True, text=True,
                           timeout=timeout)
        rc, out = p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        return name, "unknown", f"did not finish in {timeout}s"
    except Exception as e:
        return name, "unknown", f"{type(e).__name__}: {e}"
    clean = re.sub(r"\x1b\[[0-9;]*m", "", out)
    fails = [l.strip() for l in clean.splitlines() if re.search(r"\bFAIL\b", l)]
    return name, ("ok" if rc == 0 else "bad"), (fails[0][:200] if fails else "")


def next_number(dry):
    try:
        with open(STATE) as f:
            n = json.load(f).get("n", 0)
    except (OSError, ValueError):
        n = 0
    n += 1
    if not dry:
        try:
            os.makedirs(os.path.dirname(STATE), exist_ok=True)
            tmp = STATE + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"n": n, "sent": int(time.time())}, f)
            os.replace(tmp, STATE)
        except OSError:
            pass
    return n


def build(n):
    machines = []
    for name, host in [ME] + OTHERS:
        facts, why = read_facts(host)
        machines.append((name, facts, why))

    problems, notes = [], []

    # --- what the facts themselves prove ------------------------------------
    tips = {name: f["tip"] for name, f, _ in machines if f and f.get("tip")}
    if len(tips) > 1 and len(set(tips.values())) > 1:
        problems.append("the machines DISAGREE about the chain tip")

    floor = consensus_floor()
    head = origin_head()
    for name, f, why in machines:
        if not f:
            problems.append(f"{name} could not be read — {why}")
            continue
        if head and f.get("git") and not head.startswith(f["git"]) \
                and not f["git"].startswith(head):
            problems.append(f"{name} runs {f['git']}, origin/main is {head}")
        if f.get("backup"):
            age = int(time.time()) - f["backup"]
            if age > 36 * 3600:
                problems.append(f"{name}'s newest backup is {ago(f['backup'])} old")
        else:
            problems.append(f"{name} has no backup at all")
        if (f.get("alarms") or "0") != "0":
            problems.append(f"{name} has {f['alarms']} unread reorg alarm(s)")
        # The service, not the timer above it. This report listed services by
        # is-active and a oneshot check is never "active" between runs, so a
        # check that failed every time it ran read as normal here. That is how
        # wam-reorg-watch went ten hours dead on both machines on 1 September
        # 2026 with nothing said.
        for u in f.get("failed", []):
            if u.startswith("wam"):
                problems.append(f"{name}: {u} is in the FAILED state — whatever "
                                f"it watches has not been watched since it "
                                f"started failing")
            else:
                # Ubuntu's own boot units fail on these providers and stay
                # failed for the life of the machine. Naming them as problems
                # every morning is how a person learns to skip the problem
                # list; hiding them is how a real one goes unseen. So: named,
                # not shouted about.
                notes.append(f"{name}: {u} is failed — not ours, failed at boot")
        if f.get("version") == "behind":
            problems.append(f"{name} is running a checkout that is behind")
        for u, (active, enabled) in (f.get("services") or {}).items():
            if enabled == "not-found" or "mainnet" in u:
                continue
            if active == "active":
                continue
            # DISABLED IS A DECISION, NOT A FAULT.
            #
            # systemd already records whether a person meant a unit to run
            # here, and this read only "is it running". So Singapore's testnet
            # ElectrumX -- deliberately off on a 1.9 GB seed, with US-east
            # serving both networks and answering on the published port --
            # was named a problem every morning. A problem list that carries
            # a decision somebody made on purpose is how a person learns to
            # skip the list, which is how a real problem goes unseen.
            #
            # Enabled and not running is still a problem. That is the case
            # where the machine disagrees with the intent.
            if enabled == "disabled":
                notes.append(f"{name}: {u} is switched off here on purpose "
                             f"(disabled), so it is not running")
            else:
                problems.append(f"{name}: {u} is {active}")
        if f.get("swapTotal") in ("0", None):
            notes.append(f"{name} has no swap")
        # Declared work silences nothing -- it only labels. Saying so here
        # means a person reading an alarm from last night can tell at once
        # whether it was expected, without having to remember.
        if f.get("maint"):
            secs, _, why = f["maint"].partition(" ")
            try:
                mins = int(secs) // 60
            except ValueError:
                mins = 0
            notes.append(f"{name}: planned work declared — {why} "
                         f"({mins} min left). Alarms are still being sent.")

    # --- checks that need nothing but this checkout --------------------------
    results = [
        local_check("the repository agrees with itself",
                    ["bash", "scripts/audit_repo.sh"], 200),
        local_check("listing entries match source",
                    [sys.executable, "scripts/check_listing_entry.py"], 150),
        local_check("consensus is final",
                    ["bash", "scripts/check_consensus_final.sh"], 120),
    ]
    for name, status, detail in results:
        if status == "bad":
            problems.append(f"{name} — {detail}")
        elif status == "unknown":
            notes.append(f"{name} could not run — {detail}")

    # --- the message ---------------------------------------------------------
    L = [f"WAM ops #{n} — {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}", ""]
    L.append(f"{len(problems)} problem(s)" if problems else "all clear")
    L.append("")

    for name, f, why in machines:
        if not f:
            L.append(f"{name}: COULD NOT BE READ — {why}")
            continue
        L.append(f"{name}: height {f['height']}, {f['peers']} peers, "
                 f"{f['memFree']}/{f['memTotal']} MB free, {f['diskFreeG']}G disk, "
                 f"backup {ago(f['backup'])}, checkout {f['git']}")
    L.append("")

    if problems:
        L.append("problems:")
        L += [f"  - {p}" for p in problems]
        L.append("")
    if notes:
        L.append("worth knowing, not failing:")
        L += [f"  - {t}" for t in notes]
        L.append("")

    # Rule 4. Naming what this cannot see is the difference between a report
    # and a reassurance.
    L.append("not checked from here (run the sweep on the laptop for these):")
    L.append("  electrum endpoints, the pool's payouts, the explorer's numbers,")
    L.append("  peer versions, and whether a stranger can sync from genesis.")
    if floor:
        L.append(f"  mainnet consensus floor is v{floor}.")
    L.append("")
    L.append("A skipped number means that report never arrived, and the "
             "machine that sends them was down.")
    return "\n".join(L)


def send(text, dry):
    try:
        cfg = json.load(open(CONF))
    except OSError:
        print(text)
        print("\n(no config -- nothing sent)")
        return 0
    chat, token = cfg.get("opsChatId"), cfg.get("telegram", {}).get("token")
    if dry or not chat or not token:
        print(text)
        if not dry:
            print("\n(no opsChatId or token -- nothing sent)")
        return 0
    data = urllib.parse.urlencode({
        "chat_id": chat, "text": text, "disable_web_page_preview": "true",
    }).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            ok = json.load(f).get("ok")
        print("sent" if ok else "telegram refused it")
        return 0 if ok else 1
    except Exception as e:
        print(f"could not send: {type(e).__name__}: {e}")
        return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="print it, send nothing, and do not consume a number")
    a = ap.parse_args()
    return send(build(next_number(a.dry_run)), a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
