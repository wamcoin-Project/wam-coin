#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  isolated_network.sh -- run a candidate build as its own network, for real
# ===========================================================================
#
#      bash scripts/test/isolated_network.sh
#      bash scripts/test/isolated_network.sh --tree /path/to/built/tree
#      bash scripts/test/isolated_network.sh --nodes 4 --keep
#
#  WHY THIS EXISTS, AND WHY IT IS NOT stranger.sh
#
#  stranger.sh asks whether a PUBLISHED release installs and runs. It is the
#  right question and it is the wrong moment: by the time there is something
#  to download, the decision has been made.
#
#  This is the other half. It takes a build nobody has released, stands up a
#  small network of it on the loopback, and makes that network do the things
#  the real one does -- mine, propagate, rotate the RandomX key, fork,
#  reorganise, answer while it is busy -- and measures each one. A change
#  that cannot survive this does not reach a tag, and nothing that happens
#  here can reach anybody: regtest, 127.0.0.1, its own datadirs and its own
#  ports, torn down at the end.
#
#  That isolation is the whole point and it is why the risky changes belong
#  here first. A node's verification work runs with cs_main held; moving it
#  is the deepest change this project could make, and it is not a change to
#  attempt against a network with people on it. It is a change to attempt
#  here, as many times as it takes, where failing costs a directory in /tmp.
#
#  WHAT IT REFUSES TO DO
#
#  It never contacts a mainnet or testnet host, never reads an operator's
#  wam.conf, never uses a wallet that holds anything, and never writes
#  outside its own working directory. Every node is started with
#  -regtest -dnsseed=0 and bound to the loopback, and the only addresses any
#  of them is told about are the others in this run.
#
#  It does not mine on anybody else's machine. Regtest proof of work is the
#  chain's own floor; that is arithmetic on a laptop, not a miner on a
#  runner.
#
#      exit 0  the network did everything asked of it
#      exit 1  it did not, and the candidate does not go out
#      exit 2  there was nothing to test -- no build, no tools
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; DIM=$'\033[2m'
BLD=$'\033[1m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then GRN=; RED=; YLW=; DIM=; BLD=; OFF=; fi

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
TREE="${WAM_CORE_DIR:-$ROOT/build/wam-core}"
NODES=3
KEEP=0
BASE_PORT=21000
BASE_RPC=21100

while [ $# -gt 0 ]; do
    case "$1" in
        --tree)  TREE="${2:?--tree needs a path}"; shift 2 ;;
        --nodes) NODES="${2:?--nodes needs a number}"; shift 2 ;;
        --keep)  KEEP=1; shift ;;
        -h|--help) sed -n '5,50p' "$0"; exit 0 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

PASS=0
FAILED=()
ok()   { PASS=$((PASS+1)); printf '  %sok%s    %s\n' "$GRN" "$OFF" "$*"; }
bad()  { FAILED+=("$1"); printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$1"
         shift || true; for l in "$@"; do printf '        %s\n' "$l"; done; }
note() { printf '  %s..%s    %s\n' "$DIM" "$OFF" "$*"; }
step() { printf '\n%s%s%s\n\n' "$BLD" "$*" "$OFF"; }

WAMD="$TREE/src/wamd"
CLI="$TREE/src/wam-cli"
[ -x "$WAMD" ] && [ -x "$CLI" ] || {
    printf '\n  %s!!%s    no built node at %s\n' "$YLW" "$OFF" "$TREE"
    printf '        There is nothing to test. bash install.sh builds one,\n'
    printf '        or --tree names a tree that is already built.\n\n'
    exit 2
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wam-isolated-XXXXXX")" || exit 2
PIDS=()

cleanup() {
    for i in $(seq 0 $((NODES - 1))); do
        "$CLI" -regtest -datadir="$WORK/node$i" -rpcport=$((BASE_RPC + i)) \
               stop >/dev/null 2>&1
    done
    sleep 2
    for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null; done
    if [ "$KEEP" = 1 ]; then
        printf '\n%skept: %s%s\n' "$DIM" "$WORK" "$OFF"
    else
        rm -rf -- "$WORK"
    fi
}
trap cleanup EXIT INT TERM

cli() { local n="$1"; shift
        "$CLI" -regtest -datadir="$WORK/node$n" -rpcport=$((BASE_RPC + n)) "$@"; }

printf '\n=================================================================\n'
printf ' %san isolated network of %d, from %s%s\n' "$BLD" "$NODES" \
       "$("$WAMD" -version 2>/dev/null | head -1)" "$OFF"
printf '=================================================================\n'
printf '%s %s%s\n' "$DIM" "$WORK" "$OFF"

# ---------------------------------------------------------------------------
step "1. the network comes up and finds itself"

for i in $(seq 0 $((NODES - 1))); do
    mkdir -p "$WORK/node$i"
    # Every peer it is told about is one of ours. No DNS seeds, no listening
    # anywhere but the loopback, and no credentials in anybody's argv: with
    # no rpcpassword set the node writes a cookie and wam-cli reads it.
    {
        echo "regtest=1"
        echo "[regtest]"
        echo "port=$((BASE_PORT + i))"
        echo "rpcport=$((BASE_RPC + i))"
        echo "bind=127.0.0.1"
        echo "rpcbind=127.0.0.1"
        echo "dnsseed=0"
        echo "listenonion=0"
        for j in $(seq 0 $((NODES - 1))); do
            [ "$j" = "$i" ] && continue
            echo "addnode=127.0.0.1:$((BASE_PORT + j))"
        done
    } > "$WORK/node$i/wam.conf"

    "$WAMD" -datadir="$WORK/node$i" -printtoconsole=0 \
        >"$WORK/node$i.out" 2>&1 &
    PIDS+=("$!")
done

up=0
for _ in $(seq 1 90); do
    ready=0
    for i in $(seq 0 $((NODES - 1))); do
        cli "$i" getblockcount >/dev/null 2>&1 && ready=$((ready + 1))
    done
    [ "$ready" = "$NODES" ] && { up=1; break; }
    sleep 1
done
if [ "$up" != 1 ]; then
    bad "only $ready of $NODES nodes answered within ninety seconds" \
        "$(tail -3 "$WORK/node0/regtest/debug.log" 2>/dev/null | tr '\n' ' ')"
    printf '\n'; exit 1
fi
ok "$NODES nodes came up from empty datadirs"

peers=0
for _ in $(seq 1 30); do
    peers="$(cli 0 getconnectioncount 2>/dev/null || echo 0)"
    [ "${peers:-0}" -ge 1 ] && break
    sleep 1
done
if [ "${peers:-0}" -ge 1 ]; then
    ok "they found each other (node0 has $peers peer(s))"
else
    bad "the nodes never connected to each other"
fi

# ---------------------------------------------------------------------------
step "2. it mines, and a block reaches everybody"

ADDR="$(cli 0 -named createwallet wallet_name=m >/dev/null 2>&1; \
        cli 0 -rpcwallet=m getnewaddress 2>/dev/null)"
if [ -z "$ADDR" ]; then
    bad "no wallet address on node0 -- is this build made with wallet support?"
    printf '\n'; exit 1
fi

t0=$(date +%s%N)
cli 0 generatetoaddress 10 "$ADDR" >/dev/null 2>&1
t1=$(date +%s%N)
mined_ms=$(( (t1 - t0) / 1000000 ))
h0="$(cli 0 getblockcount 2>/dev/null)"
if [ "${h0:-0}" -ge 10 ]; then
    ok "node0 mined 10 blocks in ${mined_ms} ms"
else
    bad "node0 did not mine: height is ${h0:-?}"
fi

prop_ms=0
agreed=0
t0=$(date +%s%N)
for _ in $(seq 1 60); do
    same=1
    tip0="$(cli 0 getbestblockhash 2>/dev/null)"
    for i in $(seq 1 $((NODES - 1))); do
        [ "$(cli "$i" getbestblockhash 2>/dev/null)" = "$tip0" ] || same=0
    done
    [ "$same" = 1 ] && { agreed=1; break; }
    sleep 1
done
prop_ms=$(( ($(date +%s%N) - t0) / 1000000 ))
if [ "$agreed" = 1 ]; then
    ok "every node agreed on the tip after ${prop_ms} ms"
else
    bad "the nodes did not agree on a tip within sixty seconds" \
        "$(for i in $(seq 0 $((NODES - 1))); do printf 'node%s=%s ' "$i" "$(cli "$i" getblockcount 2>/dev/null)"; done)"
fi

# ---------------------------------------------------------------------------
step "3. the RandomX key rotates, and the network follows"

# ASK THE NODE, DO NOT COMPUTE IT HERE.
#
# getrandomxinfo reports blocks_until_rotation, so the harness mines exactly
# that many and one more rather than guessing a height from an epoch length
# it has hardcoded. A harness that recomputes a consensus rule is a second
# place for that rule to be wrong -- which is the fault that put the mainnet
# constants into GetRandomXSeedHeight and made the test networks silently
# use an epoch they do not have.
#
# The first version of this read "epochBlocks" and "seedHash" with grep. The
# fields are epoch_blocks and seed_hash, so both came back empty, the seed
# compared equal to itself, and this reported that the key never rotated.
# Parsed as JSON now, by the thing that knows what JSON is.
rxfield() {
    cli 0 getrandomxinfo 2>/dev/null | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('$1', ''))
except Exception:
    print('')
"
}

EPOCH="$(rxfield epoch_blocks)"
LAG="$(rxfield epoch_lag)"
if [ -z "${EPOCH:-}" ]; then
    bad "getrandomxinfo did not answer, so the rotation could not be tested" \
        "$(cli 0 getrandomxinfo 2>&1 | head -2)"
    EPOCH=0
else
    note "epoch $EPOCH blocks, lag $LAG"
fi

seed_before="$(rxfield seed_hash)"
until_rot="$(rxfield blocks_until_rotation)"

if [ "${EPOCH:-0}" != 0 ]; then
    NEED=$(( ${until_rot:-0} + 1 ))
    t0=$(date +%s%N)
    cli 0 generatetoaddress "$NEED" "$ADDR" >/dev/null 2>&1
    rot_ms=$(( ($(date +%s%N) - t0) / 1000000 ))
    note "mined $NEED blocks to reach the rotation, in ${rot_ms} ms"
fi

seed_after="$(rxfield seed_hash)"
if [ -n "$seed_after" ] && [ "$seed_after" != "$seed_before" ]; then
    ok "the key rotated (${seed_before:0:12}... -> ${seed_after:0:12}...)"
else
    bad "the RandomX key did not rotate across two epoch boundaries" \
        "before: ${seed_before:-none}  after: ${seed_after:-none}"
fi

agreed=0
for _ in $(seq 1 90); do
    tip0="$(cli 0 getbestblockhash 2>/dev/null)"
    same=1
    for i in $(seq 1 $((NODES - 1))); do
        [ "$(cli "$i" getbestblockhash 2>/dev/null)" = "$tip0" ] || same=0
    done
    [ "$same" = 1 ] && { agreed=1; break; }
    sleep 1
done
if [ "$agreed" = 1 ]; then
    ok "and every node followed it across the rotation"
else
    bad "the network split across the key rotation" \
        "$(for i in $(seq 0 $((NODES - 1))); do printf 'node%s=%s ' "$i" "$(cli "$i" getblockcount 2>/dev/null)"; done)"
fi

# ---------------------------------------------------------------------------
step "4. it survives a fork and converges"

# node1 is cut off, both sides mine, and the shorter side has to come back.
for i in $(seq 1 $((NODES - 1))); do
    cli "$i" setnetworkactive false >/dev/null 2>&1
done
sleep 2

ADDR1="$(cli 1 -named createwallet wallet_name=m >/dev/null 2>&1; \
         cli 1 -rpcwallet=m getnewaddress 2>/dev/null)"
cli 0 generatetoaddress 6 "$ADDR" >/dev/null 2>&1
[ -n "$ADDR1" ] && cli 1 generatetoaddress 2 "$ADDR1" >/dev/null 2>&1

fork0="$(cli 0 getbestblockhash 2>/dev/null)"
fork1="$(cli 1 getbestblockhash 2>/dev/null)"
if [ "$fork0" != "$fork1" ]; then
    ok "the two sides really did diverge while they were apart"
else
    bad "the fixture is wrong: the two sides never diverged"
fi

for i in $(seq 1 $((NODES - 1))); do
    cli "$i" setnetworkactive true >/dev/null 2>&1
    # Reconnect at once rather than waiting out Core's backoff. The first
    # version of this measured 46.9 s and called it convergence; almost all
    # of that was a node deciding when to try its peers again, which is a
    # number about reconnection and not about reorganising. Asking for the
    # connection makes the measurement below mean what it says.
    for j in $(seq 0 $((NODES - 1))); do
        [ "$j" = "$i" ] && continue
        cli "$i" addnode "127.0.0.1:$((BASE_PORT + j))" onetry >/dev/null 2>&1
    done
done

converged=0
t0=$(date +%s%N)
for _ in $(seq 1 120); do
    tip0="$(cli 0 getbestblockhash 2>/dev/null)"
    same=1
    for i in $(seq 1 $((NODES - 1))); do
        [ "$(cli "$i" getbestblockhash 2>/dev/null)" = "$tip0" ] || same=0
    done
    [ "$same" = 1 ] && { converged=1; break; }
    sleep 1
done
conv_ms=$(( ($(date +%s%N) - t0) / 1000000 ))
if [ "$converged" = 1 ]; then
    ok "they reorganised onto one chain in ${conv_ms} ms"
else
    bad "the network did not converge after the fork healed" \
        "$(for i in $(seq 0 $((NODES - 1))); do printf 'node%s=%s ' "$i" "$(cli "$i" getbestblockhash 2>/dev/null | cut -c1-12)"; done)"
fi

# ---------------------------------------------------------------------------
step "5. it answers while it is working"

gbt_idle=0
for _ in 1 2 3; do
    t0=$(date +%s%N)
    cli 0 getblocktemplate '{"rules":["segwit"]}' >/dev/null 2>&1
    gbt_idle=$(( gbt_idle + ($(date +%s%N) - t0) / 1000000 ))
done
gbt_idle=$((gbt_idle / 3))

cli 0 generatetoaddress 20 "$ADDR" >/dev/null 2>&1 &
miner_pid=$!
sleep 1
t0=$(date +%s%N)
cli 0 getblocktemplate '{"rules":["segwit"]}' >/dev/null 2>&1
gbt_busy=$(( ($(date +%s%N) - t0) / 1000000 ))
wait "$miner_pid" 2>/dev/null

note "getblocktemplate: ${gbt_idle} ms idle, ${gbt_busy} ms while mining"
if [ "$gbt_busy" -lt 5000 ]; then
    ok "the RPC stayed responsive under its own load"
else
    bad "getblocktemplate took ${gbt_busy} ms while the node was working"
fi

# ---------------------------------------------------------------------------
step "6. what it cost"

total_rss=0
for i in $(seq 0 $((NODES - 1))); do
    pid="${PIDS[$i]}"
    rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
    rss=$(( ${rss:-0} / 1024 ))
    total_rss=$((total_rss + rss))
    note "node$i resident ${rss} MB, height $(cli "$i" getblockcount 2>/dev/null)"
done
note "all $NODES nodes together: ${total_rss} MB"

# A node has to fit on the machines people actually rent. Each RandomX
# verification context is 256 MiB and the cache holds two, so a node past a
# key rotation is the honest high-water mark -- which is what this is, and
# it is measured here rather than assumed anywhere.
per_node=$((total_rss / NODES))
if [ "$per_node" -lt 1500 ]; then
    ok "each node fits in ${per_node} MB -- a 2 GB machine still runs one"
else
    bad "each node is holding ${per_node} MB after a key rotation" \
        "A 2 GB VPS is the cheapest tier anybody rents, and it is what a" \
        "stranger running a node for us will have."
fi

# ---------------------------------------------------------------------------
printf '\n=================================================================\n'
if [ "${#FAILED[@]}" -gt 0 ]; then
    printf ' %s%d passed, %d FAILED -- this build does not go out%s\n' \
           "$RED$BLD" "$PASS" "${#FAILED[@]}" "$OFF"
    for f in "${FAILED[@]}"; do printf '   %s\n' "$f"; done
    printf '=================================================================\n\n'
    exit 1
fi
printf ' %s%d passed -- the candidate behaved like a network%s\n' \
       "$GRN$BLD" "$PASS" "$OFF"
printf '%s nothing here touched anything live: regtest, loopback, %s%s\n' \
       "$DIM" "$WORK" "$OFF"
printf '=================================================================\n\n'
exit 0
