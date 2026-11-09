#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  run_functional_tests.sh -- run WAM's four consensus tests against the
#                             binary that is actually deployed
# ===========================================================================
#
#      bash scripts/run_functional_tests.sh --host IP [--test NAME]
#
#  WHY THIS EXISTS
#
#  test/functional/ holds four tests that ask the questions no unit test can:
#  does a real node, running real validation, actually REJECT a block that
#  breaks the rule?
#
#      feature_wam_devfee.py         WAM-1, the 5% treasury output
#      feature_wam_genesis.py        the premine: five locked tranches
#      feature_wam_pow.py            RandomX is what verifies work, not SHA256d
#      feature_wam_randomx_epoch.py  the key rotates on the epoch boundary
#
#  They had NEVER BEEN EXECUTED. Not once, from the day they were written
#  until 2026-09-14, nine hours before mainnet -- because running them takes
#  Core's own test harness, which this repository does not carry, and nobody
#  had written down where to find one.
#
#  The first execution found a real defect, in the test: feature_wam_genesis
#  still expected the first founder tranche to be liquid at genesis. Its prose
#  and its assertions had both been rewritten when that changed; the list of
#  dates had not, so every lock it checked was a year out.
#
#      AssertionError: not(1820966400 == 0)
#
#  A test nobody runs is a comment that costs CPU. So this is the script that
#  runs them, and it runs them against /usr/local/bin/wamd -- the binary the
#  seeds are running -- not against a fresh build of a hopeful tree.
#
#  HOW
#
#  The harness (test/functional/test_framework/) and test/config.ini come from
#  a configured Core build tree, and one exists on the Germany host from the
#  original build. The four test files are copied out of that host's CURRENT
#  checkout each run, so what is tested is this repository's tests, never the
#  copies that were in the build tree when it was configured.
#
#  The binaries are chosen by environment variable -- BITCOIND, BITCOINCLI,
#  BITCOINUTIL, BITCOINWALLET -- which is how Core's harness lets a test run
#  against something other than the tree it was built from.
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

HOST=""
ONLY=""
# 24000 is deliberate, not arbitrary. The harness assigns p2p from
# TEST_RUNNER_PORT_MIN and rpc from that plus 5000, twelve nodes wide. Its
# default base of 11000 puts the rpc range at 16000-21000, which contains the
# testnet node's 19554, and the p2p range contains the pool's 13333-13336. A
# test that cannot bind is a test that fails for a reason that has nothing to
# do with consensus. 24000 -> p2p 24000-24011, rpc 29000-29011, tor 34000+.
PORT_BASE=24000
TESTS="feature_wam_devfee feature_wam_genesis feature_wam_pow feature_wam_randomx_epoch"

while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST="${2:?--host needs an address}"; shift 2 ;;
        --test) ONLY="${2:?--test needs a name}"; shift 2 ;;
        --port-base) PORT_BASE="${2:?--port-base needs a number}"; shift 2 ;;
        -h|--help) sed -n '5,50p' "$0"; exit 0 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

echo "=================================================================="
echo " WAM's four consensus tests, against the deployed binary"
echo "=================================================================="

if [ -z "$HOST" ]; then
    printf '\n  %s??%s      no --host given. These tests need Core'"'"'s test harness,\n' "$YLW" "$OFF"
    printf '          which this repository does not carry; pass the host that\n'
    printf '          has a configured build tree.\n\n'
    exit 2
fi

# Find a harness and a wamd, and say which, before running anything.
PROBE="$(timeout 90 ssh -o BatchMode=yes -o ConnectTimeout=15 "root@$HOST" '
    for b in /opt/wam/build/wam-core /root/wam-core /opt/wam-core; do
        if [ -f "$b/test/functional/test_framework/test_framework.py" ] \
           && [ -f "$b/test/config.ini" ]; then echo "HARNESS=$b"; break; fi
    done
    for r in /opt/wam /root/wam; do
        [ -d "$r/test/functional" ] && { echo "REPO=$r"; break; }
    done
    command -v wamd >/dev/null 2>&1 && echo "WAMD=$(command -v wamd)"
    wamd -version 2>/dev/null | head -1 | sed "s/^/VERSION=/"
    command -v python3 >/dev/null 2>&1 && echo "PY=ok"
' 2>/dev/null)"

for k in HARNESS REPO WAMD PY; do
    case "$PROBE" in
        *"$k="*) ;;
        *)  printf '\n  %s??%s      %s not found on the host -- nothing was run.\n\n' \
                "$YLW" "$OFF" "$k"
            exit 2 ;;
    esac
done

HARNESS="$(printf '%s\n' "$PROBE" | sed -n 's/^HARNESS=//p')"
VERSION="$(printf '%s\n' "$PROBE" | sed -n 's/^VERSION=//p')"
printf '\n  harness  %s\n  binary   %s\n  ports    %s-%s p2p, %s-%s rpc\n' \
    "$HARNESS" "$VERSION" "$PORT_BASE" "$((PORT_BASE + 11))" \
    "$((PORT_BASE + 5000))" "$((PORT_BASE + 5011))"

FAIL=0
PASS=0
SEED=7
for t in $TESTS; do
    [ -z "$ONLY" ] || [ "$ONLY" = "$t" ] || continue
    SEED=$((SEED + 1))
    printf '\n%s%s%s\n' "$BLD" "$t" "$OFF"

    OUT="$(timeout 900 ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 "root@$HOST" "
        set -u
        H='$HARNESS/test/functional'
        R=\"\$(for r in /opt/wam /root/wam; do [ -d \$r/test/functional ] && { echo \$r; break; }; done)\"
        # This repository's tests, not the build tree's copies of them.
        cp \"\$R/test/functional/$t.py\" \"\$H/\" || exit 3
        cd \"\$H\" || exit 3
        export BITCOIND=/usr/local/bin/wamd BITCOINCLI=/usr/local/bin/wam-cli
        export BITCOINUTIL=/usr/local/bin/wam-util BITCOINWALLET=/usr/local/bin/wam-wallet
        export TEST_RUNNER_PORT_MIN=$PORT_BASE
        D=/root/wamtests/$t
        rm -rf \"\$D\"
        mkdir -p /root/wamtests
        nice -n 10 timeout 840 python3 $t.py --tmpdir=\"\$D\" --portseed=$SEED 2>&1 | tail -4
        exit \${PIPESTATUS[0]}
    " 2>&1)"
    RC=$?

    printf '%s\n' "$OUT" | sed 's/^/    /'
    case "$RC" in
        0)   printf '  %sok%s      %s\n' "$GRN" "$OFF" "$t"; PASS=$((PASS + 1)) ;;
        124) printf '  %s??%s      %s did not finish in 14 minutes -- not a\n' "$YLW" "$OFF" "$t"
             printf '          verdict on consensus, a verdict on the clock.\n'
             FAIL=$((FAIL + 1)) ;;
        *)   printf '  %sFAIL%s    %s (rc=%s)\n' "$RED" "$OFF" "$t" "$RC"
             FAIL=$((FAIL + 1)) ;;
    esac
done

echo
echo "=================================================================="
if [ "$FAIL" -eq 0 ]; then
    printf ' %s%d of %d consensus test(s) pass against %s%s\n' \
        "$GRN" "$PASS" "$PASS" "$VERSION" "$OFF"
else
    printf ' %s%d test(s) failed -- a rule this chain claims is not enforced%s\n' \
        "$RED" "$FAIL" "$OFF"
fi
echo "=================================================================="
[ "$FAIL" -eq 0 ]
