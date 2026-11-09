#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  test_miner.sh -- compile and run the miner's unit tests
# ===========================================================================
#
#      bash scripts/test_miner.sh
#
#  WHY THIS EXISTS
#
#  miner/test/ held three standalone test programs and NOTHING RAN ANY OF
#  THEM. Not the sweep, not preflight, not a CI job, not install.sh. Even
#  scripts/solo_gate.sh, which builds solo_jobs_test, is called from nowhere.
#
#  That was not discovered by reading the scripts. On 8 November 2026 eleven
#  checks were added to solo_template_test.cpp to hold down a reported and
#  paid fault, and the suite was run by hand, once, and left green -- in a
#  directory no gate opens. The next day the fix those checks guard was found
#  to have created a new fault one file away, and the same green suite would
#  have said nothing either way.
#
#  A test nobody runs is a comment that takes longer to write. The same shape
#  was reported against the node on 7 November: six Boost cases on the founder
#  reserve's time locks, compiled into every binary by name and never invoked,
#  because every command in the repository listed two suites and not that one.
#
#  solo_jobs_test is not here: it takes an RPC port and a cookie and needs a
#  node, so it belongs to solo_gate.sh. Everything in this file runs with
#  nothing but a compiler.
#
#  EXIT CODES
#
#      0   every test passed
#      1   a test failed, or would not build
#      2   no C++ compiler here, so nothing was checked -- which is not a pass
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'

command -v g++ >/dev/null 2>&1 || {
    printf '\n  %sno g++ here, so nothing was compiled and nothing was checked%s\n' \
           "$YLW" "$OFF"
    printf '  On Windows this runs under WSL, where the node is built too.\n\n'
    exit 2
}

OUT="${MINER_TEST_OUT:-$(mktemp -d)}"
mkdir -p "$OUT"

TESTS=(address_test solo_template_test stratum_hostile_test)

printf '\n%s  the miner'"'"'s unit tests%s\n\n' "$BLD" "$OFF"

failed=0
for t in "${TESTS[@]}"; do
    src="miner/test/$t.cpp"
    if [ ! -f "$src" ]; then
        printf '  %sFAIL%s  %s is missing\n' "$RED" "$OFF" "$src"
        failed=$((failed + 1))
        continue
    fi

    if ! g++ -std=c++17 -I miner/src -O1 -pthread \
             -o "$OUT/$t" "$src" 2> "$OUT/$t.build.log"; then
        printf '  %sFAIL%s  %s did not build\n' "$RED" "$OFF" "$t"
        sed -n '1,12p' "$OUT/$t.build.log" | sed 's/^/          /'
        failed=$((failed + 1))
        continue
    fi

    # A test that hangs is a failed test, not a stuck sweep. The socket one
    # talks to itself on the loopback and should be done in seconds.
    if out="$(cd "$OUT" && timeout 120 "./$t" 2>&1)"; then
        printf '  %sok%s    %s\n' "$GRN" "$OFF" "$t"
        printf '%s' "$out" | sed -n 's/^ *\([0-9]\+ passed.*\)$/          \1/p'
    else
        rc=$?
        printf '  %sFAIL%s  %s (exit %s)\n' "$RED" "$OFF" "$t" "$rc"
        printf '%s' "$out" | sed -n '1,25p' | sed 's/^/          /'
        failed=$((failed + 1))
    fi
done

printf '\n'
if [ "$failed" -eq 0 ]; then
    printf '%s%s  all %s miner test program(s) passed%s\n\n' \
           "$GRN" "$BLD" "${#TESTS[@]}" "$OFF"
    exit 0
fi
printf '%s%s  %s of %s miner test program(s) failed%s\n\n' \
       "$RED" "$BLD" "$failed" "${#TESTS[@]}" "$OFF"
exit 1
