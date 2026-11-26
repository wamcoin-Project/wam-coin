#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  test_miner_suite_complete.sh -- a test that nothing runs is not a test
# ===========================================================================
#
#  scripts/test_miner.sh carries the list of miner tests to compile and run.
#  On 26 November 2026 miner/test held nine .cpp files and that list named
#  seven. solo_jobs_test and fuzz_solo_template had been written, reviewed,
#  committed and never executed by anything -- green on every run, because
#  they were not on any run.
#
#  This is the same defect bobbyning reported on 7 November in another
#  component: the vesting tests compiled and no gate ever ran them. It was
#  fixed there, in that component, which is exactly the habit that lets it
#  come back somewhere else. So the rule is checked rather than remembered:
#  every .cpp in miner/test must be named in TESTS, and every name in TESTS
#  must have a .cpp.
#
#  A file that genuinely should not run on its own belongs in a WAM_TEST_SKIP
#  line below, with the reason beside it, so the exception is a sentence
#  somebody wrote rather than an omission nobody noticed.
#
#      exit 0  the list and the directory agree
#      exit 1  they do not
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then GRN=; RED=; OFF=; fi

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

RUNNER="scripts/test_miner.sh"
DIR="miner/test"

[ -f "$RUNNER" ] || { printf '%s is not here\n' "$RUNNER" >&2; exit 2; }
[ -d "$DIR" ]    || { printf '%s is not here\n' "$DIR" >&2; exit 2; }

# Names that are deliberately not run on their own. Each needs a reason.
# A helper compiled INTO another test, for instance, is not a test.
SKIP=""

listed="$(sed -n '/^TESTS=(/,/)/p' "$RUNNER" \
          | tr '()' '  ' | sed 's/^TESTS=//' | tr -s ' \n' '\n' \
          | sed '/^$/d' | sort -u)"

present="$(find "$DIR" -maxdepth 1 -name '*_test.cpp' -o -maxdepth 1 -name 'fuzz_*.cpp' \
           | sed 's|.*/||; s|\.cpp$||' | sort -u)"

missing="$(comm -23 <(printf '%s\n' "$present") <(printf '%s\n' "$listed"))"
phantom="$(comm -13 <(printf '%s\n' "$present") <(printf '%s\n' "$listed"))"

for s in $SKIP; do
    missing="$(printf '%s\n' "$missing" | grep -vxF "$s" || true)"
done

rc=0
printf '\n'
if [ -n "$(printf '%s' "$missing" | tr -d '[:space:]')" ]; then
    printf '  %sFAIL%s  in %s and not in the list %s runs:\n' \
           "$RED" "$OFF" "$DIR" "$RUNNER"
    printf '%s\n' "$missing" | sed '/^$/d' | sed 's/^/          /'
    printf '        A test nothing runs is green because nobody asked it.\n'
    rc=1
fi
if [ -n "$(printf '%s' "$phantom" | tr -d '[:space:]')" ]; then
    printf '  %sFAIL%s  named in %s and there is no source for it:\n' \
           "$RED" "$OFF" "$RUNNER"
    printf '%s\n' "$phantom" | sed '/^$/d' | sed 's/^/          /'
    rc=1
fi

if [ "$rc" = 0 ]; then
    n="$(printf '%s\n' "$present" | sed '/^$/d' | wc -l)"
    printf '  %sok%s    all %s miner tests are in the list that runs them\n' \
           "$GRN" "$OFF" "$n"
fi
printf '\n'
exit "$rc"
