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

if ! command -v g++ >/dev/null 2>&1; then
    # ON WINDOWS, GO AND FIND ONE INSTEAD OF REPORTING THAT NONE WAS FOUND.
    #
    # Git Bash has no compiler and WSL does -- and WSL is where the node is
    # built on this machine, so the compiler was always a command away. The
    # line below used to say "on Windows this runs under WSL" and then exit
    # 2, which is honest and useless: the sweep printed "the miner's unit
    # tests -- could not check" on the one machine where the miner's code is
    # actually written, every single run, and nobody ran these three suites
    # from one month to the next.
    #
    # Exit 2 is still right when there is genuinely no compiler anywhere.
    # What was wrong was calling it that before looking.
    if command -v wsl.exe >/dev/null 2>&1 \
       && wsl.exe -e bash -lc 'command -v g++ >/dev/null' >/dev/null 2>&1; then
        win="$(pwd -W 2>/dev/null || pwd)"
        inside="$(wsl.exe -e wslpath -a "$win" 2>/dev/null | tr -d '\r')"
        if [ -n "$inside" ]; then
            printf '\n  %sno g++ in this shell; running the suites under WSL%s\n' \
                   "$DIM" "$OFF"
            # No recursion: inside WSL g++ exists, so this branch is not
            # taken again.
            exec wsl.exe -e bash -c "cd '$inside' && bash scripts/test_miner.sh"
        fi
    fi

    printf '\n  %sno g++ here, so nothing was compiled and nothing was checked%s\n' \
           "$YLW" "$OFF"
    printf '  On Windows this runs under WSL, where the node is built too.\n\n'
    exit 2
fi

OUT="${MINER_TEST_OUT:-$(mktemp -d)}"
mkdir -p "$OUT"

# EVERY TEST IN miner/test, AND THE TWO THAT WERE NOT IN THIS LIST.
#
# solo_jobs_test and fuzz_solo_template were written, committed, and never
# run by anything: this array named seven of the nine .cpp files beside it.
# That is the defect bobbyning was paid for on 7 November in another
# component -- "the vesting tests are compiled but no gate ever ran them" --
# repeated here, in the gate itself.
#
# stratum_state_test is new on 26 November. stratum_hostile_test asks whether
# a bad line kills the miner; this one asks what the miner is left mining
# afterwards, which is where mpit's seed-capture and share-difficulty
# findings live: both leave the process alive, connected, and wrong.
#
# scripts/test/test_miner_suite_complete.sh now refuses a .cpp in miner/test
# that this array does not name, so the list cannot fall behind again.
TESTS=(address_test fuzz_solo_template plaintext_test rpc_limits_test
       seed_flap_test solo_jobs_test solo_template_test stratum_hostile_test
       stratum_state_test tls_test)

# TLS IS OPTIONAL IN THE BINARY, SO IT IS OPTIONAL HERE -- AND SAID EITHER WAY.
#
# miner/build.sh links libssl when the headers are there and leaves the binary
# exactly as it was when they are not. tls_test follows that: built with TLS it
# raises a server on loopback with a self-signed certificate -- which is what
# somebody in the path has -- and requires the client to refuse it. Built
# without, it reports that the verification cases were not checked at all.
#
# The flags are per test rather than global: adding -lssl to every suite would
# make this whole file need libssl before anything would compile.
TLS_CXXFLAGS=""
TLS_LDLIBS=""
printf '#include <openssl/ssl.h>
int main(){return 0;}
' > "$OUT/tlsprobe.cpp"
if g++ -std=c++17 "$OUT/tlsprobe.cpp" -lssl -lcrypto -o "$OUT/tlsprobe" >/dev/null 2>&1; then
    TLS_CXXFLAGS="-DWAM_MINER_TLS"
    TLS_LDLIBS="-lssl -lcrypto"
fi
rm -f "$OUT/tlsprobe.cpp" "$OUT/tlsprobe"

printf '\n%s  the miner'"'"'s unit tests%s\n\n' "$BLD" "$OFF"

failed=0
for t in "${TESTS[@]}"; do
    src="miner/test/$t.cpp"
    if [ ! -f "$src" ]; then
        printf '  %sFAIL%s  %s is missing\n' "$RED" "$OFF" "$src"
        failed=$((failed + 1))
        continue
    fi

    extra_cxx=""
    extra_ld=""
    if [ "$t" = "tls_test" ]; then
        extra_cxx="$TLS_CXXFLAGS"
        extra_ld="$TLS_LDLIBS"
    fi

    # shellcheck disable=SC2086
    if ! g++ -std=c++17 -I miner/src -O1 -pthread $extra_cxx \
             -o "$OUT/$t" "$src" $extra_ld 2> "$OUT/$t.build.log"; then
        printf '  %sFAIL%s  %s did not build\n' "$RED" "$OFF" "$t"
        sed -n '1,12p' "$OUT/$t.build.log" | sed 's/^/          /'
        failed=$((failed + 1))
        continue
    fi

    # ONE OF THESE IS NOT A UNIT TEST, AND SAYING SO IS THE POINT.
    #
    # solo_jobs_test needs a regtest node: it calls getblocktemplate twenty
    # times and asserts the job a worker still holds is still held. Without
    # one it prints "could not reach the node" and exits 1.
    #
    # It was left out of TESTS entirely rather than written down, so for
    # weeks it was neither run nor missed. Both of those are worse than a
    # line that says what it needs. This project's convention is that a check
    # which COULD NOT RUN is reported as not checked and never as a pass --
    # so that is what this does, and scripts/test/stranger.sh runs it for
    # real against the regtest node that harness already starts.
    if [ "$t" = "solo_jobs_test" ] && [ -z "${WAM_REGTEST_RPCPORT:-}" ]; then
        printf '  %s....%s  %s NOT CHECKED -- it needs a regtest node.\n' \
               "$YLW" "$OFF" "$t"
        printf '          scripts/test/stranger.sh runs it against one.\n'
        printf '          Here: WAM_REGTEST_RPCPORT=29554 WAM_REGTEST_COOKIE=<path>\n'
        unchecked=$((${unchecked:-0} + 1))
        continue
    fi

    args=""
    if [ "$t" = "solo_jobs_test" ]; then
        args="${WAM_REGTEST_RPCPORT} ${WAM_REGTEST_COOKIE:-}"
    fi

    # A test that hangs is a failed test, not a stuck sweep. The socket one
    # talks to itself on the loopback and should be done in seconds.
    # shellcheck disable=SC2086
    if out="$(cd "$OUT" && timeout 120 "./$t" $args 2>&1)"; then
        printf '  %sok%s    %s\n' "$GRN" "$OFF" "$t"
        printf '%s' "$out" | sed -n 's/^ *\([0-9]\+ passed.*\)$/          \1/p'
    else
        rc=$?
        printf '  %sFAIL%s  %s (exit %s)\n' "$RED" "$OFF" "$t" "$rc"
        printf '%s' "$out" | sed -n '1,25p' | sed 's/^/          /'
        failed=$((failed + 1))
    fi
done

# ---------------------------------------------------------------------------
# AND THE POLICY, NOT ONLY THE CLASSIFIER.
#
# plaintext_test covers ClassifyHost exhaustively. What it cannot reach is
# what main() DOES with the answer, and that is the part the report is about:
# stratum+ssl:// must be refused rather than downgraded, and an RPC password
# must not be sent to a public address. Both live in main(), so both are
# checked by running the binary -- and so are the two cases that must only
# WARN, because refusing those would break people mining today.
#
# Reported 13 November 2026 (M-1, M-2).
printf '\n%s  and what the miner does about it%s\n\n' "$BLD" "$OFF"

# A BINARY THAT IS HERE IS NOT A BINARY THAT RUNS HERE.
#
# The first version ran it straight away and read a failure to start as a
# failure of the miner. On Windows this is reached through the re-exec at the
# top, and `wsl.exe -e bash -c` lands in the DEFAULT distribution while the
# node and the miner are built in Ubuntu-24.04. The binary then stops at
#
#     ./miner/wam-miner: /lib/x86_64-linux-gnu/libc.so.6:
#     version `GLIBC_2.38' not found
#
# and all four checks below were reported as defects in the miner. It is this
# project's own rule in the other direction: a check that could not run is not
# a pass, and it is not a failure either. It says which, and exits 2.
policy_unchecked=""
if [ ! -x miner/wam-miner ]; then
    policy_unchecked="miner/wam-miner is not built -- bash miner/build.sh"
elif ! ./miner/wam-miner --help >/dev/null 2>&1; then
    why="$(./miner/wam-miner --help 2>&1 | head -1)"
    policy_unchecked="miner/wam-miner will not run in this shell: ${why:-unknown error}"
fi

if [ -z "$policy_unchecked" ]; then
    ADDR=WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE

    # A TIMEOUT, AND AN EXPECTATION THAT DEPENDS ON THE BUILD.
    #
    # This ran the miner against the live pool with NO TIMEOUT and expected
    # exit 2. On a build without libssl that is right: the miner refuses the
    # scheme and exits. On a build WITH libssl it connects, authorises, and
    # MINES -- and this file hangs until something kills it.
    #
    # It had never been seen, because the whole section was skipped on every
    # machine that ran it. The binary is built in one WSL distribution and
    # this script re-executes in another, where it will not start, so the
    # refusals were reported as "not checked at all" and nothing reached
    # this line. The first run that got here hung for nine minutes.
    #
    # Found while verifying v0.1.15 -- a test nobody had run, guarding a
    # refusal nobody had watched.
    if ./miner/wam-miner --help 2>&1 | grep -q "stratum+ssl:// is available"; then
        tls_built=1
    else
        tls_built=0
    fi

    out="$(timeout 20 ./miner/wam-miner -o stratum+ssl://pool.wamcoin.org:3336 \
                      -u "$ADDR" 2>&1)"
    rc=$?
    if [ "$tls_built" -eq 1 ]; then
        # Built with TLS: it must NOT refuse, and must not fall back to the
        # clear. Reaching the pool is the proof; the timeout ends it.
        if [ "$rc" -eq 2 ]; then
            printf '  %sFAIL%s  stratum+ssl:// was refused by a TLS build\n' "$RED" "$OFF"
            printf '          %s\n' "$(printf '%s' "$out" | head -1)"
            failed=$((failed + 1))
        elif printf '%s' "$out" | grep -qiE "in the clear|downgrad"; then
            printf '  %sFAIL%s  stratum+ssl:// fell back to cleartext\n' "$RED" "$OFF"
            failed=$((failed + 1))
        else
            printf '  %sok%s    stratum+ssl:// is honoured by a TLS build\n' "$GRN" "$OFF"
        fi
    else
        if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "speaks no TLS"; then
            printf '  %sok%s    stratum+ssl:// is refused, not downgraded\n' "$GRN" "$OFF"
        else
            printf '  %sFAIL%s  stratum+ssl:// did not refuse (exit %s)\n' "$RED" "$OFF" "$rc"
            printf '          a scheme asking for TLS was discarded, so the miner\n'
            printf '          opened a cleartext socket to the pool TLS port\n'
            failed=$((failed + 1))
        fi
    fi

    # Timeout for the same reason: if this ever stops refusing, it tries to
    # reach 203.0.113.9 and waits, and the file hangs instead of failing.
    out="$(timeout 20 ./miner/wam-miner --solo --rpc 203.0.113.9:9554 --rpcuser u \
                             --rpcpassword p -u "$ADDR" 2>&1)"
    rc=$?
    if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "in the clear"; then
        printf '  %sok%s    an RPC password is refused to a public address\n' "$GRN" "$OFF"
    else
        printf '  %sFAIL%s  the RPC password was not refused (exit %s)\n' "$RED" "$OFF" "$rc"
        printf '          base64 of user:password, over plain HTTP, to a routable\n'
        printf '          address, opening every wallet RPC on that node\n'
        failed=$((failed + 1))
    fi

    for args in "-o stratum+tcp://pool.wamcoin.org:3333 -u $ADDR" \
                "--solo --rpc 192.168.1.10:9554 --rpcuser u --rpcpassword p -u $ADDR"; do
        # shellcheck disable=SC2086
        out="$(timeout 8 ./miner/wam-miner $args 2>&1)"
        rc=$?
        if [ "$rc" -eq 2 ]; then
            printf '  %sFAIL%s  refused what it must only warn about:\n' "$RED" "$OFF"
            printf '          %s\n' "${args%% -u*}"
            failed=$((failed + 1))
        elif printf '%s' "$out" | grep -qi "warn"; then
            printf '  %sok%s    warns without refusing: %s\n' \
                   "$GRN" "$OFF" "${args%% -u*}"
        else
            printf '  %sFAIL%s  no warning at all for:\n' "$RED" "$OFF"
            printf '          %s\n' "${args%% -u*}"
            failed=$((failed + 1))
        fi
    done
else
    printf '  %s!!%s    the refusals were not checked at all\n' "$YLW" "$OFF"
    printf '          %s\n' "$policy_unchecked"
fi

printf '\n'
if [ "$failed" -eq 0 ] && [ -n "$policy_unchecked" ]; then
    printf '%s%s  %s test program(s) passed; the refusals could not be checked%s\n\n' \
           "$YLW" "$BLD" "${#TESTS[@]}" "$OFF"
    exit 2
fi
if [ "$failed" -eq 0 ] && [ "${unchecked:-0}" -gt 0 ]; then
    # "all N passed" while one of the N was never run is the sentence this
    # project keeps being bitten by. Exit 2 is the convention for a check
    # that could not run; sweep.sh prints it as "could not check" and counts
    # it as neither a pass nor a finding.
    printf '%s%s  %s of %s miner test program(s) passed; %s was NOT CHECKED%s\n\n' \
           "$YLW" "$BLD" "$((${#TESTS[@]} - unchecked))" "${#TESTS[@]}" \
           "$unchecked" "$OFF"
    exit 2
fi
if [ "$failed" -eq 0 ]; then
    printf '%s%s  all %s miner test program(s) passed, and both refusals hold%s\n\n' \
           "$GRN" "$BLD" "${#TESTS[@]}" "$OFF"
    exit 0
fi
printf '%s%s  %s of %s miner test program(s) failed%s\n\n' \
       "$RED" "$BLD" "$failed" "${#TESTS[@]}" "$OFF"
exit 1
