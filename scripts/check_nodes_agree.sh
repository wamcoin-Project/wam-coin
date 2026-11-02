#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_nodes_agree.sh -- do the deployed nodes run the same rules?
# ===========================================================================
#
#      bash scripts/check_nodes_agree.sh HOST [HOST...]
#      bash scripts/check_nodes_agree.sh --network testnet HOST [HOST...]
#
#  IT DEFAULTS TO MAINNET, AND IT USED TO ANSWER ABOUT TESTNET
#
#  Until 18 September 2026 every wam-cli here was bare. On these servers the
#  default datadir is /root/.wam, whose wam.conf says testnet=1, so bare
#  wam-cli is the testnet node. Three days into mainnet this printed
#
#      comparing at height 9964 ... one chain | all 3 nodes agree
#
#  about testnet, while mainnet stood at 2382. Genesis hashes matched --
#  because they were three copies of the same wrong chain -- so nothing in the
#  output looked off. The check that exists to catch a consensus split was
#  looking at a network with nothing at stake, and the sweep scored it green.
#
#  The network is now named on every call, and printed in the header, so the
#  question "which chain did this answer about" always has a visible answer.
#
#  WHY THIS EXISTS
#
#  On 2026-08-19 the two testnet nodes ran different builds. One had been
#  installed before the commit that gave the treasury its own address, so it
#  still demanded the 5% go to the founder address; the other paid the new
#  treasury. The older node rejected every block the newer one mined:
#
#      ConnectBlock ... failed, bad-cb-devfee-amount, coinbase pays
#      0.00000000 WAM to the development treasury but consensus requires
#      at least 2.50000000 WAM ... to be sent to TK34fT...
#
#  The chain split at height 31 and stayed split for hours. Nothing noticed,
#  because every check anyone runs asks a node about itself:
#
#      systemctl is-active wamd     -> active, on both
#      getblockcount                -> a number, on both
#      getnetworkinfo subversion    -> /WAM:0.1.0/, on BOTH
#
#  That last one is the trap. The two binaries differed in a consensus rule
#  and reported an identical version string, so no amount of asking one node
#  how it is could ever reveal it. The only question that finds this is one
#  node compared against another.
#
#  Run this after deploying to any node, and before a launch. The cost of not
#  running it is a chain that silently forks the moment a miner finds a block.
#
#  WHAT IT REFUSES TO CONFUSE
#
#  Lag is not a fork. A node two blocks behind is normal; a node with a
#  different block at a height both have reached is not. So the comparison is
#  made at the lowest height every node has, never at their tips.
# ===========================================================================

set -uo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh"
. "$SCRIPTS_DIR/lib/wamcli.sh"
. "$SCRIPTS_DIR/lib/remote.sh"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
FAIL=0       # nodes were compared and they differ          -> exit 1
UNKNOWN=0    # a node was never read, so nothing compared    -> exit 2

ok()   { printf '  %sok%s     %s\n' "$GRN" "$OFF" "$*"; }
bad()  { printf '  %sFAIL%s   %s\n' "$RED" "$OFF" "$*"; FAIL=$((FAIL + 1)); }
warn() { printf '  %swarn%s   %s\n' "$YLW" "$OFF" "$*"; }

# A question that was never asked. Separate from bad() because the summary of
# this check ends with "do not launch on this", and an ssh timeout is not a
# reason not to launch -- it is a reason to look again. Until 2026-09-14,
# ten hours before mainnet, an unreachable host came out of here in red.
unknown() { printf '  %s??%s     %s\n' "$YLW" "$OFF" "$*"; UNKNOWN=$((UNKNOWN + 1)); }

# Mainnet is the default because mainnet is the chain with coins on it. A
# script that has to be told which network to examine will eventually be run
# without being told, and the harmless default is the one that examines the
# chain that matters.
NETWORK=mainnet
HOSTS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --network) NETWORK="${2:?--network needs a value}"; shift 2 ;;
        -h|--help) sed -n '5,25p' "$0"; exit 0 ;;
        -*) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
        *) HOSTS+=("$1"); shift ;;
    esac
done

if [ "${#HOSTS[@]}" -lt 2 ]; then
    printf 'usage: %s [--network NET] HOST [HOST...]\n\n' "${0##*/}" >&2
    printf 'Two hosts minimum -- agreement is not a property one node has.\n' >&2
    exit 2
fi

# Resolved once, here, so an unknown network stops the run instead of becoming
# an empty flag string -- and an empty flag string is the testnet node.
CLI="wam-cli $(wam_cli_flags "$NETWORK")" || exit 2

# The retry lives in lib/remote.sh now, along with the two statuses that are
# not answers -- ssh's 255 and timeout's 124. The private copy that used to
# be here retried on an EMPTY reply instead, which is the same intent read
# off the wrong signal: a host returning an empty string because wam-cli is
# not installed was asked twice, and a host that dropped the connection
# after printing one line was not asked again at all.
#
# ONE CONNECTION PER HOST, NOT SIX.
#
# This file opened six: reachable, binaries, helper scripts, genesis, height,
# and the block at the common height. On three machines that is eighteen ssh
# handshakes, and on the founder's link a handshake costs five to fifteen
# seconds before any work begins -- so the ops panel gave this check 150
# seconds and watched it spend most of them saying hello, then printed "did
# not finish" about a network that was perfectly healthy.
#
# Five of the six are now one keyed reply. The sixth cannot join them: the
# height to compare at is the lowest every node has reached, which is not
# known until every node has answered. So it stays a second round trip, and
# two is the floor rather than an oversight.

# WHAT THIS FILE CANNOT ANSWER, so nobody reads a green here as more than it is.
#
# It compares the hosts TO EACH OTHER. A fleet that is uniformly wrong is
# therefore the one case it is blind to, and it is not an exotic case -- it is
# what a deploy that silently did nothing produces, on every machine at once.
#
# On 2026-11-01 this printed "byte-identical binaries" about France and
# Singapore while wam-tx, wam-util and wam-wallet on both were pinned at
# v0.1.7, six releases back, since 11 September. They agreed perfectly, so it
# said so, correctly and uselessly.
#
# scripts/check_running_version.py asks the other question: does every machine
# run the version we PUBLISH -- compared against the newest signed release in
# our own download directory, which is outside the fleet. The two are not
# alternatives; neither one covers the other.

# THE FIVE CONSENSUS PROGRAMS, and deliberately not everything named wam*.
#
# Every wam-* executable, not just wamd: a wam-cli that disagrees with its
# daemon is a subtler version of the same problem.
#
# This used to fingerprint /usr/local/bin/wam*, which is also where the
# operational shell scripts live -- wam-backup.sh, wam-concentration-log.sh.
# Those are installed per ROLE: the hourly concentration logger belongs on the
# host that runs the explorer and nowhere else, because there is nothing for it
# to read anywhere else. Installing it produced
#
#     FAIL  <host> and <host> run DIFFERENT binaries -- they may enforce
#           different rules
#     2 disagreement(s) -- do not launch on this
#
# on a network whose five consensus programs were byte-identical. A check that
# says "do not launch" about a log script is a check that gets ignored on the
# day it means something. The helper scripts are still worth a word -- they
# differ for a reason, and a reason someone should be able to state -- so they
# come back under HELPER and are reported as a note, never as a finding.
CONSENSUS_BINARIES='wamd wam-cli wam-tx wam-util wam-wallet'

# LC_ALL=C on the sort is load-bearing, not decoration. Without it each host
# sorts in its own locale: under C the hyphen sorts before a letter, so wamd
# comes last, while a UTF-8 locale ignores punctuation in its first pass and
# puts wamd second. Identical binaries then produce differently ordered lists
# and this reports a disagreement that does not exist -- and a check that
# cries wolf is one nobody reads, which is the failure this file exists to
# prevent.
probe() {
    local cli="$1"
    cat <<PROBE
H=\$($cli getblockcount 2>/dev/null)
case "\$H" in ''|*[!0-9]*) : ;; *) echo "HEIGHT \$H" ;; esac
G=\$($cli getblockhash 0 2>/dev/null)
case "\$G" in '') : ;; *) echo "GENESIS \$G" ;; esac
for f in $CONSENSUS_BINARIES; do
    p=/usr/local/bin/\$f
    [ -f "\$p" ] && printf 'BIN %s %s\n' "\$f" "\$(sha256sum "\$p" | cut -c1-16)"
done | LC_ALL=C sort
ls -1 /usr/local/bin/wam*.sh 2>/dev/null | xargs -r -n1 basename \
    | LC_ALL=C sort | sed 's/^/HELPER /'
PROBE
}

echo "=================================================================="
echo " Do the deployed nodes agree?  [$NETWORK]"
echo "=================================================================="

# ---------------------------------------------------------------------------
printf '\n%sreachable%s\n' "$BLD" "$OFF"

LIVE=()
declare -A FINGERPRINT HELPERS GENESIS HEIGHT

# 60, not the 45 default: this reply carries five sha256sums as well as two
# RPC calls, and a node mid-reindex can take its time over getblockcount.
REMOTE_TIMEOUT=60

for h in "${HOSTS[@]}"; do
    remote_ask "$h" "$(probe "$CLI")"
    reply="$REMOTE_OUT"

    # Unreachable and "answered, but with nothing" are different, and the
    # distinction is the whole reason lib/remote.sh exists. Both end the host
    # here, but only one of them is about the network.
    if [ "$REMOTE_RC" = "$REMOTE_UNREACHABLE" ]; then
        unknown "$h -- ssh could not reach it; it was not compared"
        continue
    fi
    if [ -z "$(remote_field HEIGHT "$reply")" ]; then
        unknown "$h -- answered, but wam-cli gave no height; it was not compared"
        continue
    fi

    ok "$h"
    LIVE+=("$h")
    HEIGHT[$h]="$(remote_field HEIGHT "$reply" | tr -d ' ')"
    GENESIS[$h]="$(remote_field GENESIS "$reply" | tr -d ' ')"
    FINGERPRINT[$h]="$(remote_field BIN "$reply")"
    HELPERS[$h]="$(remote_field HELPER "$reply")"
done

if [ "${#LIVE[@]}" -lt 2 ]; then
    # The line itself says nothing could be compared. Exit 2 says the same
    # thing to the machine reading the exit code, instead of claiming a
    # disagreement between nodes that were never asked.
    printf '\n%sfewer than two nodes answered -- nothing can be compared%s\n' "$YLW" "$OFF"
    exit 2
fi

# ---------------------------------------------------------------------------
printf '\n%sthe same code%s\n' "$BLD" "$OFF"

# The fingerprints and the helper list came back with the height and the
# genesis hash, in the one reply above. See probe() for what was asked and
# why it is asked once.
REF="${LIVE[0]}"
for h in "${LIVE[@]:1}"; do
    if [ "${FINGERPRINT[$h]}" = "${FINGERPRINT[$REF]}" ]; then
        ok "$h runs byte-identical binaries to $REF"
    else
        bad "$h and $REF run DIFFERENT binaries -- they may enforce different rules"
        diff <(printf '%s\n' "${FINGERPRINT[$REF]}") \
             <(printf '%s\n' "${FINGERPRINT[$h]}") 2>/dev/null \
            | grep -E '^[<>]' | sed "s/^/           /"
        printf '           %s is < , %s is >\n' "$REF" "$h"
    fi
done

# The role scripts, reported and never failed on.
for h in "${LIVE[@]:1}"; do
    if [ "${HELPERS[$h]}" != "${HELPERS[$REF]}" ]; then
        printf '  %snote%s   %s and %s carry different helper scripts, which is\n' \
            "$YLW" "$OFF" "$h" "$REF"
        printf '         expected when they run different services:\n'
        diff <(printf '%s\n' "${HELPERS[$REF]}") \
             <(printf '%s\n' "${HELPERS[$h]}") 2>/dev/null \
            | grep -E '^[<>]' | sed "s/^/           /"
    fi
done

# ---------------------------------------------------------------------------
printf '\n%sthe same chain%s\n' "$BLD" "$OFF"

# Both came back with the fingerprints, in the one reply per host above.
for h in "${LIVE[@]:1}"; do
    if [ -n "${GENESIS[$h]}" ] && [ "${GENESIS[$h]}" = "${GENESIS[$REF]}" ]; then
        ok "$h shares the genesis block of $REF"
    else
        bad "$h is on a DIFFERENT NETWORK -- genesis ${GENESIS[$h]:0:16} vs ${GENESIS[$REF]:0:16}"
    fi
done

# ---------------------------------------------------------------------------
printf '\n%sthe same history%s\n' "$BLD" "$OFF"

COMMON=""
for h in "${LIVE[@]}"; do
    n="${HEIGHT[$h]}"
    case "$n" in ''|*[!0-9]*) continue ;; esac
    { [ -z "$COMMON" ] || [ "$n" -lt "$COMMON" ]; } && COMMON="$n"
done

if [ -z "$COMMON" ]; then
    unknown "no node reported a usable height -- no history was compared"
else
    printf '  comparing at height %s, the lowest every node has reached\n' "$COMMON"
    # The second and last round trip. It could not be folded into the first:
    # this height is the lowest any node reached, so it is not known until
    # all of them have answered.
    declare -A ATCOMMON
    REMOTE_TIMEOUT=45
    for h in "${LIVE[@]}"; do
        remote_ask "$h" "$CLI getblockhash $COMMON"
        if [ "$REMOTE_RC" = "$REMOTE_UNREACHABLE" ]; then
            ATCOMMON[$h]=""
        else
            ATCOMMON[$h]="$(printf '%s' "$REMOTE_OUT" | tr -d '\r\n ')"
        fi
        printf '    %-18s tip=%-6s block[%s]=%s\n' \
            "$h" "${HEIGHT[$h]}" "$COMMON" "${ATCOMMON[$h]:0:24}"
    done

    SPLIT=0
    for h in "${LIVE[@]:1}"; do
        [ "${ATCOMMON[$h]}" = "${ATCOMMON[$REF]}" ] || SPLIT=1
    done

    if [ "$SPLIT" -eq 0 ] && [ -n "${ATCOMMON[$REF]}" ]; then
        ok "every node has the same block at height $COMMON -- one chain"
    else
        bad "the nodes have DIFFERENT blocks at height $COMMON -- the chain has forked"
    fi
fi

# A node far behind is not a fork, but it is not serving anyone either.
for h in "${LIVE[@]:1}"; do
    a="${HEIGHT[$REF]}"; b="${HEIGHT[$h]}"
    case "$a$b" in ''|*[!0-9]*) continue ;; esac
    d=$(( a > b ? a - b : b - a ))
    [ "$d" -gt 6 ] && warn "$h is $d blocks from $REF -- lag, or the start of a split"
done

echo
echo "=================================================================="
if [ "$FAIL" -ne 0 ]; then
    printf ' %s%d disagreement(s) -- do not launch on this%s\n' "$RED" "$FAIL" "$OFF"
elif [ "$UNKNOWN" -ne 0 ]; then
    printf ' %sthe %d node(s) that answered agree; %d could not be read%s\n' \
        "$YLW" "${#LIVE[@]}" "$UNKNOWN" "$OFF"
else
    printf ' %sall %d nodes agree%s\n' "$GRN" "${#LIVE[@]}" "$OFF"
fi
echo "=================================================================="

# A real disagreement outranks an unread node: 1 is louder than 2.
if [ "$FAIL" -ne 0 ]; then exit 1; fi
if [ "$UNKNOWN" -ne 0 ]; then exit 2; fi
exit 0
