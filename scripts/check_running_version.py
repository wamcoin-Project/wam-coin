#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_running_version.py -- do our machines run the version we publish?
# ===========================================================================
#
#      python3 scripts/check_running_version.py 169.58.159.165 5.223.52.200
#
#  WHY THIS EXISTS, AND WHY THE EXISTING CHECKS COULD NOT ANSWER IT
#
#  On 1 November 2026 the ops panel showed "nodes agree: FAILING". US-east was
#  running v0.1.9, four releases behind, and had been since 15 October --
#  seventeen days, through v0.1.10, v0.1.11, v0.1.12 and v0.1.13.
#
#  Two checks had every opportunity to say so and neither did.
#
#    - "deployed code is origin/main" said ok, truthfully: the git checkout on
#      that host WAS current. It reads the repository, and the repository is
#      not what systemd executes. Every deploy updated the checkout, restarted
#      the service, and the service re-executed a binary from October.
#
#    - "nodes agree" compares the hosts TO EACH OTHER. It caught this one only
#      because two of the three happened to be right. In the same reading it
#      also called France and Singapore "byte-identical" while wam-tx,
#      wam-util and wam-wallet on both were pinned to /opt/wam-v0.1.7/ --
#      SIX releases back, since 11 September, on both machines, and therefore
#      in perfect agreement. wam-wallet is the tool that opens and repairs a
#      wallet file; reaching for a six-release-old one is how a wallet gets
#      damaged by the thing meant to rescue it.
#
#  A fleet that is uniformly wrong is the one case host-versus-host cannot
#  see, and it is not a rare case -- it is what a deploy that silently did
#  nothing produces on every machine at once.
#
#  So this check compares against something outside the fleet: the newest
#  signed release in our own download directory, which is what a stranger
#  receives when he follows our instructions. If our machines are not running
#  it, either they are behind or we are telling him to run something we do
#  not ourselves.
#
#  WHAT IT ASKS
#
#    1. Each running node, over RPC: the subversion it puts on the wire. This
#       is the only one the network can see, and the only one that decides
#       which rules are being enforced right now.
#    2. Each node service, from its unit: which binary it executes, and what
#       that file reports. A service can be active, restarted an hour ago, and
#       still be running October -- that is exactly what happened.
#    3. The five programs on PATH. Nothing may be a copy: a copy stops
#       tracking the release the moment it is made, which is how US-east got
#       here. A symlink chain is fine, and is what install_release.sh writes.
#
#  Exit 0 everything runs the published release, 1 something does not,
#  2 the check could not run -- the project's convention, so an ssh that
#  timed out is never shown as a finding.
# ===========================================================================

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "lib"))
from wamssh import run as _run, UNREACHABLE   # noqa: E402
import releases as releases_lib               # noqa: E402

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

_fails = []
_warns = []


def ok(m):   print(f"  {GRN}ok{OFF}    {m}")
def bad(m):  print(f"  {RED}FAIL{OFF}  {m}"); _fails.append(m)
def warn(m): print(f"  {YEL}!!{OFF}    {m}"); _warns.append(m)


# The five consensus programs, the same list and the same reason as
# scripts/check_nodes_agree.sh: a wam-cli that disagrees with its daemon is a
# subtler version of the same problem, and wam-wallet is the one that can do
# damage by itself.
PROGRAMS = ["wamd", "wam-cli", "wam-tx", "wam-util", "wam-wallet"]
PATHDIR = "/usr/local/bin"

# -version prints "WAM Coin version v0.1.13" or "... RPC client version v0.1.13".
VERSION_LINE = re.compile(r"version\s+v([0-9]+(?:\.[0-9]+)+)")
# getnetworkinfo puts "/WAM:0.1.13/" on the wire.
SUBVERSION = re.compile(r'"subversion"\s*:\s*"/WAM:([0-9.]+)/"')


def probe():
    """One shell script, run once per host.

    One ssh connection, not fifteen. The panel runs this beside eight other
    checks that each open their own, and a check that needs a connection per
    question is the check that times out on the day a link is slow -- which
    reports nothing, and reporting nothing is what this file exists to stop.
    """
    return r'''
for u in $(systemctl list-units --type=service --state=running --no-legend 'wamd*' 2>/dev/null | awk '{print $1}'); do
    b=$(systemctl cat "$u" 2>/dev/null | sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' | head -1)
    [ -n "$b" ] || continue
    echo "UNIT $u $b $("$b" -version 2>/dev/null | head -1)"
done
for d in /root/.wam /root/.wam-mainnet; do
    [ -d "$d" ] || continue
    c=/opt/wam-current-bin/wam-cli
    [ -x "$c" ] || c=$(command -v wam-cli 2>/dev/null)
    [ -n "$c" ] || continue
    case "$d" in *mainnet) ch="-chain=main" ;; *) ch="" ;; esac
    s=$("$c" $ch -conf="$d/wam.conf" -datadir="$d" getnetworkinfo 2>/dev/null | grep subversion)
    [ -n "$s" ] && echo "WIRE $d $s"
done
for f in ''' + " ".join(PROGRAMS) + r'''; do
    p=''' + PATHDIR + r'''/$f
    [ -e "$p" ] || { echo "PATH $f MISSING"; continue; }
    if [ -L "$p" ]; then kind=link; else kind=COPY; fi
    echo "PATH $f $kind $(readlink -f "$p") $("$p" -version 2>/dev/null | head -1)"
done
'''


def version_in(text):
    m = VERSION_LINE.search(text)
    return m.group(1) if m else None


def check_host(host, newest):
    print(f"\n{BLD}{host}{OFF}")
    rc, out = _run(host, probe(), timeout=90)
    if rc == UNREACHABLE or rc == 2:
        warn(f"{host} could not be asked -- it was NOT compared ({out.strip()[:80]})")
        return False
    if rc != 0 and not out.strip():
        warn(f"{host} answered nothing -- it was NOT compared")
        return False

    saw_wire = False
    for line in out.splitlines():
        f = line.split()
        if not f:
            continue

        if f[0] == "WIRE" and len(f) >= 3:
            saw_wire = True
            m = SUBVERSION.search(line)
            got = m.group(1) if m else None
            net = "mainnet" if "mainnet" in f[1] else "testnet"
            if got == newest:
                ok(f"{net} node is on the wire as v{got}")
            elif got is None:
                warn(f"{net} node did not report a subversion")
            else:
                # The one the network can see. Said first and said plainly.
                bad(f"{net} node is on the wire as v{got}, and the published "
                    f"release is v{newest} -- this is the version every peer "
                    f"and every miner is talking to")

        elif f[0] == "UNIT" and len(f) >= 3:
            unit, binary = f[1], f[2]
            got = version_in(line)
            if got == newest:
                ok(f"{unit} executes {binary} (v{got})")
            elif got is None:
                warn(f"{unit} executes {binary}, which would not say its version")
            else:
                bad(f"{unit} executes {binary}, which is v{got} and not the "
                    f"published v{newest}. Restarting this service does not "
                    f"change that, and did not")

        elif f[0] == "PATH" and len(f) >= 3:
            name = f[1]
            if f[2] == "MISSING":
                warn(f"{PATHDIR}/{name} is not installed")
                continue
            kind, target = f[2], f[3] if len(f) > 3 else "?"
            got = version_in(line)
            if kind == "COPY":
                # Not a version complaint. A copy can be the right version
                # today and is guaranteed to be wrong eventually, because
                # nothing moves it. US-east's copies were right for one day.
                bad(f"{PATHDIR}/{name} is a COPY, not a link (v{got}). A copy "
                    f"stops tracking the release the moment it is made")
            elif got == newest:
                ok(f"{PATHDIR}/{name} -> v{got}")
            elif got is None:
                warn(f"{PATHDIR}/{name} -> {target}, which would not say its version")
            else:
                bad(f"{PATHDIR}/{name} is v{got}, not the published v{newest} "
                    f"-- it resolves to {target}")

    if not saw_wire:
        warn(f"{host} is not running a node this check could ask over RPC")
    return True


def main():
    hosts = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not hosts:
        print("usage: check_running_version.py <host> [host ...]", file=sys.stderr)
        return 2

    print(f"\n{BLD}does every machine run the version we publish?{OFF}")
    try:
        _, newest = releases_lib.published()
    except Exception as e:
        # 2, not 1. Our download directory being unreachable from this laptop
        # says nothing about what the seeds are running, and a red that means
        # "the check could not look" is how a panel teaches people to stop
        # reading red.
        warn(f"the published releases could not be read, so nothing was "
             f"compared: {type(e).__name__}: {e}")
        print()
        return 2
    if not newest:
        warn("the download directory lists no signed release to compare against")
        print()
        return 2
    print(f"  newest signed release: {BLD}v{newest}{OFF}")

    asked = 0
    for h in hosts:
        if check_host(h, newest):
            asked += 1

    print()
    if asked == 0:
        print(f" {YEL}no host could be asked -- nothing was compared{OFF}\n")
        return 2
    if _fails:
        print(f" {RED}{len(_fails)} program(s) are not the published "
              f"release{OFF}\n")
        return 1
    if _warns:
        print(f" {GRN}everything that answered runs v{newest}{OFF}"
              f" ({len(_warns)} unanswered)\n")
        return 0
    print(f" {GRN}every node, every unit and every program on PATH is "
          f"v{newest}{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
