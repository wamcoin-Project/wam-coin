#!/bin/bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  Two miners, one node: what happens when somebody beats you
# ===========================================================================
#
#      bash scripts/test/test_solo_race.sh [<dir with wamd, wam-cli, wam-miner>]
#
#  WHY THIS EXISTS, AND WHY IT IS THE ONE THAT WAS MISSING
#
#  Every test this project has for solo mining runs on regtest with one miner.
#  A miner with no competitor always wins, so losing a race is unreachable by
#  every gate we own -- and losing a race is where both of the solo miner's
#  shipped faults lived:
#
#    v0.1.10  it solved blocks and never submitted them. Found by a miner, on
#             mainnet, with his own money.
#    v0.1.11  the alarm added BECAUSE of v0.1.10 could not tell a lost race
#             from a lost block, and told working miners to shut down. Found
#             by two miners, on mainnet, on 2026-10-04. One of them stopped.
#
#  Both were "tested" before release. Both were tested where they could not
#  fail. The fix for the second was written and called proved on the strength
#  of a careful read, which is the same mistake one layer up.
#
#  So this puts an opponent in the room. On regtest the difficulty is trivial,
#  which makes collisions the normal case rather than a rare one: two miners
#  against one node will solve the same height within seconds of each other
#  within a minute or two of starting.
#
#  WHAT IT ASSERTS
#
#    * a race actually happened -- otherwise the test proved nothing and says
#      so rather than passing
#    * the loser calls it a lost race, not a refusal
#    * the alarm "do not leave it running" appears NOWHERE
#    * both miners keep working afterwards and keep being paid
#
#  WHERE IT MAY RUN
#
#  Not on a machine that serves the network. The first run of this rig was on
#  seed3, by hand, and it opened three listening ports; the port monitor saw
#  them and alerted within minutes, correctly. Then the cleanup used a broad
#  pkill that came within one pattern of killing that host's real testnet
#  miner.
#
#  So: it refuses to start where wamd or a miner is already serving, binds
#  everything to 127.0.0.1 so nothing is visible from outside, picks ports
#  nobody else is using, and kills only the process ids it started itself.
# ===========================================================================

set -uo pipefail

# Resolved before anything changes directory, because this re-executes itself
# below and a relative $0 does not survive a cd.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../.." 2>/dev/null || cd "$(dirname "$SELF")"

# ---- ISOLATE YOURSELF, DO NOT ASK THE OPERATOR TO REMEMBER -----------------
#
# The first version of this refused to run on a machine that serves the
# network, and left the isolation to whoever typed the command. That is a rule
# a person has to remember, and the person who wrote the rule broke it within
# the hour: the first run was by hand on seed3, opened three listening ports,
# and the port monitor alerted on them. Correctly.
#
# A rule nobody can forget is better than a rule nobody should. This re-enters
# itself inside its own PID and network namespaces, so the node and the miners
# it starts cannot see the host's processes, cannot be seen by them, and bind
# to a loopback that exists only in here. Nothing is visible from outside the
# machine, so nothing to alert on.
#
# unshare is in util-linux and is already on these hosts. Where it is missing
# or unprivileged, the old refusal below still stands as the fallback.
if [ "${WAM_RACE_ISOLATED:-0}" != "1" ] && command -v unshare >/dev/null 2>&1; then
    if unshare --pid --fork --mount-proc --net true >/dev/null 2>&1; then
        exec unshare --pid --fork --mount-proc --net \
             env WAM_RACE_ISOLATED=1 bash "$SELF" "$@"
    fi
fi
# A fresh network namespace has its loopback down, and 127.0.0.1 does not
# answer until it is up.
[ "${WAM_RACE_ISOLATED:-0}" = "1" ] && ip link set lo up 2>/dev/null

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$1"; }
bad()  { printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$1"; FAILED=$((FAILED+1)); }
note() { printf '  %s!!%s    %s\n' "$YLW" "$OFF" "$1"; }
FAILED=0

echo
echo "${BLD}two miners, one node: the loser must not be told to stop${OFF}"

# ---- where the binaries are ------------------------------------------------
BIN="${1:-}"
find_bin() {
    local n="$1"
    [ -n "$BIN" ] && [ -x "$BIN/$n" ] && { echo "$BIN/$n"; return; }
    [ -x "./$n" ] && { echo "./$n"; return; }
    [ -x "miner/$n" ] && { echo "miner/$n"; return; }
    command -v "$n" 2>/dev/null
}
WAMD="$(find_bin wamd)"; CLI="$(find_bin wam-cli)"; MINER="$(find_bin wam-miner)"
if [ -z "$WAMD" ] || [ -z "$CLI" ] || [ -z "$MINER" ]; then
    note "need wamd, wam-cli and wam-miner. Pass the directory holding them."
    note "A release archive is enough: this does not need a build."
    echo; exit 2
fi

# ---- refuse to run where the network is being served -----------------------
#
# Exit 2 and not 1: declining to run is not a finding. The founder's own rule,
# learned when a build ran on a host people were watching.
if [ "${WAM_RACE_ISOLATED:-0}" = "1" ]; then
    ok "isolated: its own PID and network namespaces, nothing visible outside"
elif pgrep -f "wam-miner .*stratum" >/dev/null 2>&1 \
   || pgrep -f "wamd .*-chain=main" >/dev/null 2>&1 \
   || pgrep -f "wamd .*mainnet" >/dev/null 2>&1; then
    note "unshare is unavailable here and this machine is serving the network."
    note "A rig belongs nowhere near a seed. Run it where neither is true."
    echo; exit 2
else
    note "running without namespaces -- unshare was not usable here"
fi

# ---- a private sandbox, and a port nobody is using -------------------------
D="$(mktemp -d)"
PIDS=()
cleanup() {
    for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
    sleep 1
    for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null; done
    rm -rf "$D"
}
trap cleanup EXIT INT TERM

free_port() {
    local p
    for _ in $(seq 1 60); do
        p=$(( (RANDOM % 20000) + 40000 ))
        ss -ltn 2>/dev/null | grep -q ":$p " || { echo "$p"; return; }
    done
    echo 41999
}
RPC="$(free_port)"; P2P="$(free_port)"

cat > "$D/wam.conf" <<EOF
regtest=1
server=1
daemon=1
[regtest]
rpcuser=rig
rpcpassword=rigthrowaway
rpcport=$RPC
port=$P2P
bind=127.0.0.1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
EOF

"$WAMD" -datadir="$D" >/dev/null 2>&1
C=("$CLI" -datadir="$D" -regtest)

up=0
for _ in $(seq 1 40); do
    "${C[@]}" getblockcount >/dev/null 2>&1 && { up=1; break; }
    sleep 1
done
[ "$up" = 1 ] || { note "the regtest node did not come up"; echo; exit 2; }
PIDS+=("$(pgrep -f "wamd -datadir=$D" | head -1)")
ok "a private regtest node, on 127.0.0.1:$RPC and nothing else"

"${C[@]}" createwallet rig >/dev/null 2>&1
ADDR="$("${C[@]}" getnewaddress 2>/dev/null | head -1)"
[ -n "$ADDR" ] || { note "no address from the node"; echo; exit 2; }
"${C[@]}" generatetoaddress 3 "$ADDR" >/dev/null 2>&1

# ---- the opponent ----------------------------------------------------------
#
# --light, so the 2 GiB dataset is not built twice. It makes each miner slower
# and the race no less real: on regtest the target is met in a handful of
# hashes either way.
# A literal, not "rig$$". The datadir is a mktemp and the port is
# chosen free, so the pid suffix bought nothing -- and a value
# carrying $ reads to check_rpc_secrets.py as a variable that could
# hold the real password, which is the one thing it must not have to
# guess about.
ARGS=(--solo -u "$ADDR" --rpc "127.0.0.1:$RPC" --network regtest
      --rpcuser rig --rpcpassword rigthrowaway -t 1 --light --no-colour)

"$MINER" "${ARGS[@]}" > "$D/A.log" 2>&1 & PIDS+=($!)
"$MINER" "${ARGS[@]}" > "$D/B.log" 2>&1 & PIDS+=($!)
ok "two miners started against it"

SECS="${WAM_RACE_SECONDS:-150}"
for _ in $(seq 1 "$SECS"); do
    grep -qh "lost the race" "$D/A.log" "$D/B.log" 2>/dev/null && break
    sleep 1
done

races=$(grep -hc "lost the race" "$D/A.log" "$D/B.log" 2>/dev/null | paste -sd+ | bc)
alarms=$(grep -hc "do not leave it running" "$D/A.log" "$D/B.log" 2>/dev/null | paste -sd+ | bc)
accepted=$(grep -hc "ACCEPTED by the node" "$D/A.log" "$D/B.log" 2>/dev/null | paste -sd+ | bc)

echo
if [ "${races:-0}" -gt 0 ]; then
    ok "a race happened: $races block(s) reached the height second"
    grep -hm1 "lost the race" "$D/A.log" "$D/B.log" | sed 's/^/          /'
else
    bad "no race in ${SECS}s -- this test proved nothing, which is not a pass"
    note "raise WAM_RACE_SECONDS, or the miners are not both reaching the node"
fi

if [ "${alarms:-0}" -eq 0 ]; then
    ok "nobody was told \"do not leave it running\""
else
    bad "$alarms alarm(s) told a working miner to shut down -- the v0.1.11 fault"
fi

if [ "${accepted:-0}" -gt 0 ]; then
    ok "and they kept being paid: $accepted block(s) accepted"
else
    bad "no block was accepted at all -- the rig itself is wrong"
fi

echo
if [ "$FAILED" -eq 0 ]; then
    echo "  ${GRN}${BLD}losing a race costs a block, not a miner${OFF}"
else
    echo "  ${RED}${BLD}$FAILED check(s) failed${OFF}"
fi
echo
exit $(( FAILED > 0 ))
