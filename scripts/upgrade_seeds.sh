#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  upgrade_seeds.sh -- our own machines run the release we just published
# ===========================================================================
#
#      bash scripts/upgrade_seeds.sh v0.1.15
#      bash scripts/upgrade_seeds.sh v0.1.15 --hosts "203.0.113.4 203.0.113.9"
#      bash scripts/upgrade_seeds.sh v0.1.15 --dry-run
#
#  WHY THIS EXISTS
#
#  On 2026-11-22, minutes after v0.1.15 was published to the website, the
#  releases page, the three mirrors and both channels, the explorer's version
#  panel read:
#
#      /WAM:0.1.14/ x39  /WAM:0.1.13/ x21  /WAM:0.1.12/ x15
#      /WAM:0.1.11/ x17  /WAM:0.1.8/ x3    /WAM:0.1.10/ x1
#
#  No 0.1.15 anywhere. The founder asked why it does not appear the moment we
#  release, and said he should not have to ask again.
#
#  The panel was right. It counts the version string of every node ON the
#  network, and nothing on the network was running it -- including all three
#  of our own seeds, every one of which reported /WAM:0.1.14/. Publishing
#  moves files. It does not upgrade a node, not even ours.
#
#  So the first machines to run a WAM release were other people's, every
#  time, and the panel a stranger reads to decide whether a release is real
#  showed the authors had not installed it.
#
#  WHAT THIS DOES NOT DO
#
#  It does not copy binaries from here. Each host downloads the PUBLISHED
#  archive from wamcoin.org and install_release.sh verifies the signature
#  against the key in this repository before anything is moved. If the
#  signature does not check, that host is left exactly as it was.
#
#  That matters more than the convenience: it means our own seeds are
#  upgraded by the same path a stranger uses, so the path is exercised by us
#  on every release. A download that cannot be verified stops our upgrade the
#  same way it stops theirs.
#
#  ONE HOST AT A TIME, AND IT STOPS ON THE FIRST ONE THAT DOES NOT COME BACK
#
#  Three seeds restarted together is a chain with no seeds for however long
#  the slowest one takes to reopen its port. Each host is upgraded, restarted
#  and then ASKED what version it is running and whether it is still
#  answering. Only then does the next one start. A host that does not come
#  back stops the run with the others untouched, which is the state a person
#  can reason about at two in the morning.
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"

# The machines this project runs. Kept here rather than discovered, because a
# discovered list is a list that grows a machine nobody meant to upgrade.
HOSTS="169.58.159.165 5.223.52.200 13.140.33.187"

# EVERY NODE SERVICE ON THE HOST, NOT ONLY MAINNET.
#
# The first run of this said `wamd-mainnet` alone. install_release.sh moves
# the symlink, so /usr/local/bin/wamd became v0.1.15 on all three machines --
# and check_running_version.py then failed on all three:
#
#     FAIL  testnet node is on the wire as v0.1.14, and the published
#           release is v0.1.15 -- this is the version every peer and every
#           miner is talking to
#
# A restarted unit and a replaced binary are not the same thing. The testnet
# nodes kept the old inode open and kept announcing the old version, so the
# half of our machines that a tester connects to was advertising a release we
# had stopped publishing. Units that do not exist on a host are skipped
# without complaint; that is why both are named here rather than discovered.
SERVICE="wamd-mainnet,wamd"
DRY=0
V=""

while [ $# -gt 0 ]; do
    case "$1" in
        --hosts)   HOSTS="${2:?}"; shift 2 ;;
        --service) SERVICE="${2:?}"; shift 2 ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) sed -n '5,56p' "$0"; exit 0 ;;
        -*) echo "unknown option: $1" >&2; exit 2 ;;
        *)  V="$1"; shift ;;
    esac
done

[ -n "$V" ] || { echo "usage: $0 vX.Y.Z [--hosts \"a b\"] [--service NAME] [--dry-run]" >&2; exit 2; }
case "$V" in v*) : ;; *) V="v$V" ;; esac
BARE="${V#v}"

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s%s%s    %s\n' "$GRN" "ok" "$OFF" "$*"; }
warn() { printf '  %s%s%s  %s\n' "$YLW" "warn" "$OFF" "$*"; }
bad()  { printf '  %s%s%s  %s\n' "$RED" "FAIL" "$OFF" "$*"; }

SSH="ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o BatchMode=yes"

echo
printf '%s\n' "=================================================================="
printf ' %sour own machines run %s%s\n' "$BLD" "$V" "$OFF"
printf '%s\n' "=================================================================="
echo

# ---------------------------------------------------------------------------
# 0. IS THERE ANYTHING TO INSTALL?
#
# install_release.sh fetches from wamcoin.org, so a release that has not
# reached the download hosts cannot be installed -- and finding that out
# three ssh connections deep, with one seed already restarted, is worse than
# finding it out here. check_release_ready.sh asks the same question against
# every file in the signed list.
if [ "$DRY" = 0 ]; then
    if ! bash "$ROOT/scripts/check_release_ready.sh" "$V" >/dev/null 2>&1; then
        bad "$V is not downloadable from wamcoin.org yet"
        say ""
        say "Nothing was changed. Run this first, and read what it says:"
        say "    bash scripts/check_release_ready.sh $V"
        echo
        exit 1
    fi
    ok "$V answers from wamcoin.org, so a host can fetch and verify it"
fi

# ---------------------------------------------------------------------------
failed=""
done_hosts=""

for h in $HOSTS; do
    echo
    printf '  %s%s%s\n' "$BLD" "$h" "$OFF"

    before="$($SSH "root@$h" \
        "wam-cli -datadir=/root/.wam-mainnet getnetworkinfo 2>/dev/null \
         | sed -n 's/.*\"subversion\": \"\\(.*\\)\",*/\\1/p'" 2>/dev/null | tr -d '\r')"
    say "running now: ${before:-unknown}"

    case "$before" in
        */WAM:$BARE/*|"/WAM:$BARE/")
            ok "already on $V, nothing to do"
            done_hosts="$done_hosts $h"
            continue ;;
    esac

    if [ "$DRY" = 1 ]; then
        say "would run: bash /opt/wam/scripts/install_release.sh $BARE --restart $SERVICE"
        continue
    fi

    # install_release.sh verifies the signature before it moves anything, and
    # refuses with a message rather than installing a download it could not
    # check. Its output is kept and shown only on failure: on success it is
    # forty lines of checksums nobody reads, and on failure it is the only
    # thing worth reading.
    out="$($SSH "root@$h" \
        "bash /opt/wam/scripts/install_release.sh $BARE --restart $SERVICE" 2>&1)"
    rc=$?

    if [ "$rc" -ne 0 ]; then
        bad "install_release.sh failed on $h -- the others were not touched"
        printf '%s\n' "$out" | tail -20 | sed 's/^/        /'
        failed="$failed $h"
        break
    fi
    ok "installed and $SERVICE restarted"

    # AND IT IS ASKED, NOT ASSUMED.
    #
    # A unit that restarts and a node that is answering are different claims,
    # and the gap between them is where a seed sits dead while the next one
    # is taken down. Up to sixty seconds, because a node reopening its port
    # after a restart is not instant and failing at two seconds would be a
    # false alarm that stops a good upgrade.
    after=""
    for _ in $(seq 1 30); do
        after="$($SSH "root@$h" \
            "wam-cli -datadir=/root/.wam-mainnet getnetworkinfo 2>/dev/null \
             | sed -n 's/.*\"subversion\": \"\\(.*\\)\",*/\\1/p'" 2>/dev/null | tr -d '\r')"
        [ -n "$after" ] && break
        sleep 2
    done

    if [ -z "$after" ]; then
        bad "$h did not answer after the restart -- the others were not touched"
        say "    ssh root@$h 'journalctl -u $SERVICE -n 40 --no-pager'"
        failed="$failed $h"
        break
    fi

    case "$after" in
        */WAM:$BARE/*|"/WAM:$BARE/")
            ok "answering as $after" ;;
        *)
            bad "$h came back as $after, not $V -- the others were not touched"
            say "The binary did not move. /usr/local/bin/wamd is a symlink into"
            say "/opt/wam-current-bin; check what it points at."
            failed="$failed $h"
            break ;;
    esac

    done_hosts="$done_hosts $h"
done

echo
printf '%s\n' "=================================================================="
if [ -n "$failed" ]; then
    printf ' %s%supgraded:%s%s   %sstopped at:%s%s\n' \
        "$BLD" "$GRN" "$OFF" "${done_hosts:- none}" "$RED" "$OFF" "$failed"
    printf '%s\n' "=================================================================="
    echo
    exit 1
fi

if [ "$DRY" = 1 ]; then
    printf ' %sdry run -- nothing was changed%s\n' "$BLD" "$OFF"
else
    printf ' %severy one of our machines runs %s%s\n' "$BLD" "$V" "$OFF"
    echo
    say "The explorer's version panel counts nodes, not releases, so it moves"
    say "when they reconnect -- within a minute or two, not instantly."
fi
printf '%s\n' "=================================================================="
echo
