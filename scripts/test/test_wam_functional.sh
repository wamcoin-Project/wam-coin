#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  test_wam_functional.sh -- run the functional tests this project wrote
# ===========================================================================
#
#  WHY THIS EXISTS
#
#  test/functional holds six feature tests this project wrote and ships
#  through scripts/patch_upstream.py -- genesis, the dev fee, proof of work,
#  the RandomX epoch rotation, the header denial of service, and the seed
#  thrash. On 27 November 2026 nothing ran any of them. Not the sweep, not
#  preflight, not either CI workflow: `grep -rn feature_wam` over every .yml
#  and .sh in this repository found the patcher's install list and nothing
#  else.
#
#  So six tests, one of them holding down a paid finding and one of them
#  holding down a finding from the day before, were green on every run
#  because they were on no run. That is the third time this week the same
#  shape has turned up -- the vesting tests bobbyning was paid for, the two
#  miner tests the gate did not name, and now these -- which is why this is
#  a file and not a note.
#
#  WHAT IT NEEDS, AND WHAT IT SAYS WHEN IT HAS NOTHING
#
#  A built node. These drive a real wamd on regtest through upstream's
#  functional test framework, so there is nothing to run them against until
#  somebody has built one. Where there is no build this exits 2 -- this
#  project's convention for a check that could not run, which sweep.sh
#  prints as "could not check" and counts as neither a pass nor a finding.
#  It never prints ok for a test it did not run.
#
#      WAM_CORE_DIR=/path/to/tree   use a tree other than build/wam-core
#      WAM_FUNCTIONAL=name.py,...   run only these
#
#      exit 0  every test ran and passed
#      exit 1  one of them failed
#      exit 2  there is no built node, so nothing was checked
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then GRN=; RED=; YLW=; BLD=; OFF=; fi

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
TREE="${WAM_CORE_DIR:-$ROOT/build/wam-core}"
FUNC="$TREE/test/functional"

printf '\n%s  the functional tests this project wrote%s\n\n' "$BLD" "$OFF"

if [ ! -x "$TREE/src/wamd" ]; then
    printf '  %s!!%s    there is no built node at %s/src/wamd,\n' \
           "$YLW" "$OFF" "$TREE"
    printf '        so none of these were checked. They need a real wamd.\n'
    printf '        bash install.sh builds one; WAM_CORE_DIR names another tree.\n\n'
    exit 2
fi

if [ ! -d "$FUNC" ]; then
    printf '  %s!!%s    %s is not there, so nothing was checked\n\n' \
           "$YLW" "$OFF" "$FUNC"
    exit 2
fi

# EVERY feature_wam_* THE REPOSITORY OWNS, not a list kept here.
#
# A list in this file is a list that falls behind the directory, which is
# the fault this whole file exists because of. The names come from
# test/functional in the repository, and each one must also be present in
# the tree -- a test that the patcher does not install is a test that will
# not run on anybody else's build either, and that is a failure, not a skip.
mapfile -t OWNED < <(cd "$ROOT/test/functional" 2>/dev/null \
                     && ls feature_wam_*.py 2>/dev/null | sort)

if [ "${#OWNED[@]}" -eq 0 ]; then
    printf '  %sFAIL%s  this repository owns no feature_wam_*.py at all\n\n' \
           "$RED" "$OFF"
    exit 1
fi

if [ -n "${WAM_FUNCTIONAL:-}" ]; then
    IFS=',' read -r -a OWNED <<< "$WAM_FUNCTIONAL"
fi

failed=0
missing=0
for t in "${OWNED[@]}"; do
    printf '  %-38s ' "$t"
    if [ ! -f "$FUNC/$t" ]; then
        printf '%sFAIL%s  it is not in the built tree -- scripts/patch_upstream.py\n' \
               "$RED" "$OFF"
        printf '%40s does not install it, so it runs on nobody'"'"'s build\n' ''
        missing=$((missing + 1))
        failed=$((failed + 1))
        continue
    fi
    log="$(mktemp)"
    if ( cd "$FUNC" && timeout 1800 python3 "./$t" ) >"$log" 2>&1; then
        printf '%sPASS%s\n' "$GRN" "$OFF"
    else
        printf '%sFAIL%s\n' "$RED" "$OFF"
        tail -n 12 "$log" | sed 's/^/          /'
        failed=$((failed + 1))
    fi
    rm -f "$log"
done

printf '\n'
if [ "$failed" -eq 0 ]; then
    printf '%s%s  all %d functional test(s) passed against %s%s\n\n' \
           "$GRN" "$BLD" "${#OWNED[@]}" "$TREE" "$OFF"
    exit 0
fi
printf '%s%s  %d of %d failed' "$RED" "$BLD" "$failed" "${#OWNED[@]}"
[ "$missing" -gt 0 ] && printf ' (%d not installed into the tree)' "$missing"
printf '%s\n\n' "$OFF"
exit 1
