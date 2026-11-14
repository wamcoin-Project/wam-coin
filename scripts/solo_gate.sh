#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  solo_gate.sh -- does the miner we ship still deliver a block it solves?
# ===========================================================================
#
#      bash scripts/solo_gate.sh [dir-with-wamd-wam-cli-wam-miner]
#
#  WHY THIS EXISTS, AND WHY IT RUNS BY ITSELF
#
#  v0.1.10 was announced on every channel as the release that lets anybody
#  mine alone. The next morning the first person who tried it solved a real
#  block ninety-nine seconds in, and the miner threw it away: the job he had
#  been hashing had scrolled out of a list bounded by count while he was
#  still on it. Roughly two blocks in three were unsendable.
#
#  Nothing caught it, and the reason is exact. The build gate runs --check,
#  which builds a block and asks the node whether it WOULD be accepted. It
#  proves construction. It cannot prove delivery, and delivery was what broke.
#
#  test_platform_solo.sh has proved delivery since v0.1.10 -- mine two blocks
#  for real and require the node to accept both -- but it was run by hand, on
#  the day somebody remembered. A check that depends on being remembered is
#  not a guard. This is that script on a timer, against the binaries that are
#  actually installed, on hardware this project owns, so that a regression is
#  found by us within a day instead of by a miner losing money.
#
#  IT IS DELIBERATELY NOT RUN IN CI. Mining on a hosted build service is
#  against the terms of every one of them, and this project lost its
#  code-hosting account on 2026-09-24 finding that out.
#
#  WHAT IT LEAVES BEHIND
#
#  On failure, an ALARM file in ITS OWN state directory -- which the ops
#  panel counts alongside the other subsystems' -- and a non-zero exit so
#  systemd records it and wam-alert@ fires.
#  On success it removes its own alarm, because an alarm nobody clears is an
#  alarm everybody learns to ignore.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
BIN="${1:-/opt/wam-current-bin}"
# ITS OWN DIRECTORY, AND NOT THE REORG WATCHER'S.
#
# This wrote its alarm into /var/lib/wam-reorg because the ops panel already
# counted files called ALARM-* there. check_reorg.py reads that same
# directory and treats any ALARM-* in it as "an earlier run recorded a
# reorganisation" -- so the first failure of this gate made the reorg watcher
# fail on both networks and report a reorganisation that never happened.
#
# A subsystem's state directory is its own vocabulary. Borrowing it because
# something else already looks there is how one defect corrupts a part that
# was sound. The panel is taught to look here instead.
ALARM_DIR="/var/lib/wam-solo-gate"
ALARM="$ALARM_DIR/ALARM-solo-gate.txt"
LOG="$(mktemp -t solo-gate-XXXXXX.log)"

trap 'rm -f "$LOG"' EXIT

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# WHICH BINARIES. The ones we publish -- not the ones installed here.
#
# The first run of this gate pointed at /opt/wam-current-bin and failed with
# "unknown option '--solo'". That was true: this project's own servers run
# binaries older than the feature, deliberately, because upgrading a node
# that is serving the chain buys nothing and restarts the pool. So the gate
# was asking a question about a build nobody downloads.
#
# What has to keep working is what a stranger fetches from wamcoin.org. So
# that is what is fetched -- once per version, into a cache -- and its
# signature is checked against the published key before a single byte of it
# is run. A gate that runs unverified binaries to prove they are good has
# already lost the argument it exists to win.
#
# Pass a directory as $1 to override, for testing a local build by hand.
# ---------------------------------------------------------------------------
CACHE="/var/lib/wam-solo-gate"

fetch_release() {
    local ver base dir
    # THE DOWNLOADS INDEX IS THE AUTHORITY, and nothing else is.
    #
    # The first attempt read the newest version out of CHANNELS.txt and got
    # v0.1.6 -- a number that appears there in a sentence about the signing
    # key, not as a release. The gate then asked for a release that is not
    # published any more and called our own site broken.
    #
    # The directory listing is where the files actually are, so it is the
    # only thing asked. `sort -V` and not `tail -1` alone, because v0.1.10
    # sorts before v0.1.9 in every other order.
    ver="$(curl -fsS https://wamcoin.org/downloads/ 2>/dev/null \
        | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -V -u | tail -1)"
    [ -n "$ver" ] || { echo "solo_gate: could not learn the current version" >&2; return 1; }

    base="https://wamcoin.org/downloads/$ver"
    dir="$CACHE/$ver"

    # NO EARLY RETURN ON A CACHE NOBODY RE-VERIFIES.
    #
    # This returned cached binaries without checking them again, so a release
    # that verified once was executed as root every day afterwards on trust.
    # Anything that could write to the cache directory between two runs --
    # and this runs as root, so anything that could write there at all -- got
    # a daily execution for free, with the verification already behind it.
    #
    # The cache stays, because re-downloading 100 MB a day for nothing is its
    # own kind of rudeness. What goes is trusting it: the checksums are
    # re-read from the verified SHA256SUMS on every run, below.
    #
    # Reported by Martam, 13 November 2026, with the gate's own commands
    # replayed against an attacker key.

    local tmp; tmp="$(mktemp -d -t solo-gate-dl-XXXXXX)"
    (
        cd "$tmp" || exit 1
        for f in SHA256SUMS SHA256SUMS.asc \
                 "wam-coin-$ver-x86_64-linux-gnu.tar.gz" \
                 "wam-miner-$ver-x86_64-linux-gnu.tar.gz"; do
            curl -fsSLO "$base/$f" || exit 1
        done
        curl -fsSLO https://wamcoin.org/SIGNING-KEY.asc || exit 1

        # ONE VERIFIER, AND IT IS THE ONE THAT CHECKS THE FINGERPRINT.
        #
        # What used to be here imported SIGNING-KEY.asc -- downloaded from the
        # same website as everything else -- into a fresh keyring and ran
        # `gpg --batch --verify`. That asks whether the signature matches the
        # key just imported, which it always does: an attacker who can replace
        # the tarballs can replace the key beside them, sign his own
        # SHA256SUMS with it, and this said yes. The comment above it claimed
        # the signature was checked "against the published key". Nothing here
        # knew what the published key was. The gate then unpacked and RAN
        # those binaries, as root, daily, on a host carrying a mainnet node
        # and a solo miner.
        #
        # scripts/install_release.sh already says why this must not be
        # reimplemented, in as many words: "verify_release.sh is called rather
        # than reimplemented. Two verifiers drift." They drifted. One of them
        # compares VALIDSIG against 4BD4A8D3AFD43F5CBCB500E23798462FE00ADBA4
        # and the other had no fingerprint in it at all.
        #
        # So this calls the same verifier every other path calls. A key that
        # is not ours fails there, and has nowhere else to be checked.
        #
        # Reported by Martam, 13 November 2026.
        bash "$HERE/scripts/verify_release.sh" "$tmp" >/dev/null 2>&1 || exit 1
        # The two files this gate downloaded, named, and not "everything on
        # this platform".
        #
        # The filter used to be the platform triplet, which worked while a
        # platform meant a node and a miner. v0.1.11 added a third archive --
        # the graphical wallet -- so the grep began selecting three lines
        # while the loop above still fetched two, and sha256sum -c failed on
        # a file that was never asked for. The gate has reported FAILED every
        # night since the release, about a release that is perfectly good.
        #
        # --ignore-missing would have silenced it and been wrong: it would
        # also silence a file that vanished. So the list is exact, and the
        # count is checked -- a rename makes this fail loudly rather than
        # verifying nothing and calling that a pass.
        grep -E "(wam-coin|wam-miner)-$ver-x86_64-linux-gnu\.tar\.gz\$" \
             SHA256SUMS > wanted.txt || exit 1
        [ "$(wc -l < wanted.txt)" -eq 2 ] || exit 1
        sha256sum -c wanted.txt >/dev/null 2>&1 || exit 1

        for t in wam-coin-*.tar.gz wam-miner-*.tar.gz; do tar xzf "$t" || exit 1; done
        mkdir -p "$dir"
        find . -type f \( -name wamd -o -name wam-cli -o -name wam-miner \) \
            -exec cp {} "$dir/" \; || exit 1
        chmod +x "$dir"/* 2>/dev/null
    )
    local rc=$?
    rm -rf "$tmp"
    [ "$rc" -eq 0 ] || { echo "solo_gate: could not fetch or verify $ver" >&2; return 1; }
    echo "$dir"
}

if [ "$#" -eq 0 ]; then
    mkdir -p "$CACHE" 2>/dev/null
    if ! BIN="$(fetch_release)"; then
        echo "solo_gate: the published release could not be fetched and verified."
        echo "           That is not a pass -- it means nobody can check what we"
        echo "           publish, including us."
        exit 1
    fi
    echo "solo_gate: testing the PUBLISHED binaries in $BIN"
fi

if [ ! -x "$BIN/wam-miner" ]; then
    echo "solo_gate: no wam-miner in $BIN -- nothing to prove, and that is"
    echo "           not a pass."
    exit 2
fi

if ! "$BIN/wam-miner" --help 2>&1 | grep -q -- "--solo"; then
    echo "solo_gate: the miner in $BIN has no --solo. It predates the feature,"
    echo "           so this gate can prove nothing about it."
    exit 2
fi

# ---------------------------------------------------------------------------
# TWO QUESTIONS, BECAUSE ONE OF THEM WOULD HAVE MISSED WHAT HAPPENED.
#
# test_platform_solo.sh mines two real blocks and requires the node to accept
# both. It is the end-to-end proof, and it would NOT have caught the defect
# of 2026-09-26: on regtest a block is solved in under a second, so the job
# never grows old enough to be forgotten. A gate that cannot fail on the bug
# it was written for is decoration.
#
# So the job bookkeeping is proved separately and deterministically, against a
# real node but without hashing: poll many times with nothing happening and
# the job must survive; move the tip and the job behind it must still be
# submittable. That is the failure, reproduced in a second, every day.
# ---------------------------------------------------------------------------
rc=0

{
    # WHAT EACH HALF ACTUALLY WATCHES, said plainly so nobody reads more
    # into a green line than it means:
    #
    #   1 is built from THIS CHECKOUT's sources. It stops the defect class
    #     coming back into the code, and it is the half that can fail on it.
    #   2 runs the INSTALLED binaries. It proves what people actually run can
    #     still mine and deliver -- but on regtest a block is solved in under
    #     a second, so it cannot see a job-ageing bug in a shipped build.
    #
    # Neither half can tell you that an already-released binary mishandles an
    # old job. Nothing run on this machine can. What covers that is in the
    # miner itself: it now counts blocks it failed to send apart from blocks
    # the node refused, says so on every status line, and exits non-zero.
    echo "=== 1. the job a worker holds must outlive the polling ==="
    if ! command -v g++ >/dev/null 2>&1; then
        echo "  !!  no g++ here, so the job test could not be built."
        echo "      That is NOT a pass: this is the half that catches the"
        echo "      2026-09-26 defect. Install g++ or run the gate elsewhere."
        rc=1
    else
        JOBDIR="$(mktemp -d -t solo-jobs-XXXXXX)"
        if ! g++ -std=c++17 -O1 -I"$HERE/miner/src" \
                 -o "$JOBDIR/solo_jobs" "$HERE/miner/test/solo_jobs_test.cpp" 2>&1; then
            echo "  FAIL  the job test would not compile"
            rc=1
        else
            # A PORT OF ITS OWN, AND A NODE THAT IS ACTUALLY READY.
            #
            # 29554 is this chain's regtest RPC port and is what the second
            # half's node will take, so this one is moved out of its way --
            # the first run of this gate failed with "the node never answered
            # RPC" because two regtest nodes wanted the same port seconds
            # apart.
            #
            # And readiness is asked of the node, not guessed from a file.
            # The cookie is written early, while wamd is still loading P2P
            # addresses and answering every RPC call with a warm-up error.
            # Waiting for the file gave "getblocktemplate: Loading P2P
            # addresses..." on the first run.
            RTPORT=29654
            RTDIR="$JOBDIR/regtest-home"
            mkdir -p "$RTDIR"
            printf 'regtest=1\n[regtest]\nrpcport=%s\nport=%s\nlisten=0\n' \
                "$RTPORT" "$((RTPORT + 1))" > "$RTDIR/wam.conf"
            "$BIN/wamd" -datadir="$RTDIR" -daemon >/dev/null 2>&1
            ready=0
            for _ in $(seq 1 60); do
                if "$BIN/wam-cli" -datadir="$RTDIR" -regtest getblockcount \
                        >/dev/null 2>&1; then
                    ready=1; break
                fi
                sleep 0.5
            done
            if [ "$ready" -ne 1 ]; then
                echo "  FAIL  the regtest node never became ready"
                rc=1
            elif "$JOBDIR/solo_jobs" "$RTPORT" "$RTDIR/regtest/.cookie"; then
                :
            else
                echo "  FAIL  a solved block could not have been delivered"
                rc=1
            fi
            # Gone before the next half starts, not merely asked to go.
            "$BIN/wam-cli" -datadir="$RTDIR" -regtest stop >/dev/null 2>&1
            for _ in $(seq 1 60); do
                "$BIN/wam-cli" -datadir="$RTDIR" -regtest getblockcount \
                    >/dev/null 2>&1 || break
                sleep 0.5
            done
        fi
        rm -rf "$JOBDIR"
    fi

    echo
    echo "=== 2. mine two real blocks and have the node accept both ==="
    if ! bash "$HERE/scripts/test/test_platform_solo.sh" "$BIN"; then
        rc=1
    fi
} >"$LOG" 2>&1

cat "$LOG"

if [ "$rc" -eq 0 ]; then
    # Clear our own alarm, and only our own.
    [ -f "$ALARM" ] && rm -f "$ALARM"
    echo
    echo "solo_gate: the installed miner solved and DELIVERED blocks at $(stamp)"
    exit 0
fi

mkdir -p "$ALARM_DIR" 2>/dev/null
{
    echo "WAM solo mining gate FAILED at $(stamp)"
    echo
    echo "The installed miner at $BIN could not mine and deliver two blocks"
    echo "on a private regtest chain. Anybody mining alone with this build is"
    echo "burning electricity for blocks that may never reach a node."
    echo
    echo "Binaries: $BIN"
    echo "Checkout: $(git -C "$HERE" rev-parse --short HEAD 2>/dev/null)"
    echo
    echo "--- the run ---"
    cat "$LOG"
} > "$ALARM" 2>/dev/null

echo
echo "solo_gate: FAILED -- alarm written to $ALARM"
exit 1
