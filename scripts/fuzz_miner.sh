#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  fuzz_miner.sh -- run the miner's untrusted-input layer against itself
# ===========================================================================
#
#      bash scripts/fuzz_miner.sh             # 60 seconds, the sweep's budget
#      bash scripts/fuzz_miner.sh 3600        # an hour
#      bash scripts/fuzz_miner.sh 60 12345    # that many seconds, that seed
#
#  WHY THIS EXISTS
#
#  Until 8 November 2026 this project had fuzzed nothing. Bitcoin Core ships
#  a fuzz harness and all three of our platform builds pass
#  --disable-tests-fuzz-binary; no script in scripts/ ran a fuzzer of any
#  kind. On that day an outsider ran 6.4 million ASan/UBSan cases against
#  miner/ on his own hardware and reported a hang we had written ourselves.
#
#  The gap was not the tool. gcc has had ASan and UBSan all along, and the
#  fault -- int64_t(double) on an out-of-range value -- is exactly what UBSan
#  is for. Nobody had pointed them at anything.
#
#  WHAT IT BUILDS WITH, AND WHY EACH FLAG
#
#      -fsanitize=address          reads and writes outside an allocation
#      -fsanitize=undefined        the class the reported fault belonged to
#      -fno-sanitize-recover=all   UBSan prints and CONTINUES by default,
#                                  which turns a finding into a log line
#                                  nobody reads. This makes it an exit code.
#      -O1 -g                      enough optimisation that the code is the
#                                  code we ship, enough debug info to name
#                                  the line
#
#  EXIT CODES
#
#      0   the budget ran out with nothing found
#      1   the harness would not build
#      2   a crash or a sanitiser report -- the input is in fuzz-crash.json
#      99  a call did not return -- the input is in fuzz-hang.json
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; BLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'

SECONDS_BUDGET="${1:-60}"
SEED="${2:-$(date +%s)}"
OUT="${FUZZ_OUT:-$HERE/out/fuzz}"
BIN="$OUT/fuzz_solo_template"

mkdir -p "$OUT"

command -v g++ >/dev/null 2>&1 || {
    printf '\n  %sno g++ on this machine%s -- this runs where the code is built,\n' "$RED" "$OFF"
    printf '  which on Windows means WSL rather than Git Bash.\n\n'
    exit 1
}

printf '\n%s  the miner'"'"'s untrusted input, against itself%s\n' "$BLD" "$OFF"
printf '%s  %s seconds, seed %s%s\n\n' "$DIM" "$SECONDS_BUDGET" "$SEED" "$OFF"

# The build is a few seconds, so it is not cached. A stale fuzzer that tests
# last week's code is worse than no fuzzer: it reports green about something
# that is no longer there.
if ! g++ -std=c++17 -I miner/src -O1 -g \
         -fsanitize=address,undefined -fno-sanitize-recover=all \
         -o "$BIN" miner/test/fuzz_solo_template.cpp 2> "$OUT/build.log"; then
    printf '  %sthe harness did not build%s\n\n' "$RED" "$OFF"
    sed -n '1,25p' "$OUT/build.log"
    exit 1
fi

cd "$OUT"
export ASAN_OPTIONS="abort_on_error=0:detect_leaks=1:allocator_may_return_null=1"
export UBSAN_OPTIONS="print_stacktrace=1"

"$BIN" --seed "$SEED" --seconds "$SECONDS_BUDGET"
rc=$?

if [ "$rc" -eq 99 ]; then
    printf '\n  %sA CALL DID NOT RETURN%s\n' "$RED" "$OFF"
    printf '  the input is in %s/fuzz-hang.json, the seed in fuzz-hang.txt\n\n' "$OUT"
    exit 99
fi

if [ "$rc" -ne 0 ]; then
    printf '\n  %sa crash or a sanitiser report, exit %s%s\n' "$RED" "$rc" "$OFF"
    printf '  rerun it with the same seed to see it again:\n'
    printf '      bash scripts/fuzz_miner.sh %s %s\n\n' "$SECONDS_BUDGET" "$SEED"
    exit 2
fi

printf '  %snothing found in %s seconds%s\n\n' "$GRN" "$SECONDS_BUDGET" "$OFF"
exit 0
