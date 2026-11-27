#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  measure_sync.sh -- what a fresh node pays to catch up, and whether it
#                     answers while it does
# ===========================================================================
#
#      bash scripts/test/measure_sync.sh
#      BLOCKS=5000 bash scripts/test/measure_sync.sh
#
#  WHY THIS EXISTS
#
#  It was written to settle an argument with a number, and it settled it
#  against the person who wrote it.
#
#  The case for moving RandomX verification out from under cs_main rested on
#  arithmetic: a headers message carries up to 2000 headers, the whole batch
#  is validated inside one LOCK(cs_main) in ProcessNewBlockHeaders, and a
#  verification was believed to cost about 50 ms -- so 100 seconds of held
#  lock per message, and a node unresponsive for all of it. That change is
#  the deepest this project could make. It would alter upstream's validation
#  locking and have to be re-reasoned on every rebase.
#
#  Measured instead, on 27 November 2026, against a 2,500-block regtest
#  chain: a fresh node synced the whole thing in 12.2 seconds -- 4.9 ms per
#  block, everything included -- and the simplest RPC answered in 9 ms on
#  average with a worst case of 75 ms while it was doing it. Forty cache
#  initialisations in 2,500 blocks, which is one per epoch and expected.
#
#  So the premise was wrong and the change was not made. The expensive thing
#  is a cache MISS, not a verification, and misses in normal operation are
#  one per epoch. Making them frequent is what the seed-thrash attack does,
#  and the seeds of the chain being followed are pinned against exactly that.
#
#  Keep this. It is the number that says whether that stays true: if a
#  future change pushes per-block validation up, or makes misses common,
#  this is where it shows.
#
#  It mines, so it never runs on a hosted runner -- see the refusal in
#  isolated_network.sh for what that cost this project once. Regtest,
#  loopback, its own directories, removed at the end.
# ===========================================================================
set -uo pipefail

if [ -z "${WAM_ALLOW_CI_MINING:-}" ] \
   && { [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ] \
        || [ -n "${GITLAB_CI:-}" ] || [ -n "${BUILDKITE:-}" ]; }; then
    printf '\n  this harness MINES and is running on a CI runner. Refused.\n'
    printf '  A miner on a hosted runner suspended this project'"'"'s GitHub\n'
    printf '  account on 2026-09-24, on release day.\n\n'
    exit 2
fi
T="${WAM_CORE_DIR:-/mnt/c/wam-blockchain-core/build/wam-core}"
WAMD="$T/src/wamd"; CLI="$T/src/wam-cli"
BLOCKS="${BLOCKS:-2500}"
W=$(mktemp -d /tmp/wam-sync-XXXXXX)
P_SRC=""; P_NEW=""
cleanup() {
    "$CLI" -regtest -datadir="$W/src" -rpcport=21601 stop >/dev/null 2>&1
    "$CLI" -regtest -datadir="$W/new" -rpcport=21603 stop >/dev/null 2>&1
    sleep 2
    [ -n "$P_SRC" ] && kill -9 "$P_SRC" 2>/dev/null
    [ -n "$P_NEW" ] && kill -9 "$P_NEW" 2>/dev/null
    rm -rf "$W"
}
trap cleanup EXIT INT TERM

mkconf() {
    mkdir -p "$W/$1"
    { echo "regtest=1"; echo "[regtest]"; echo "port=$2"; echo "rpcport=$3"
      echo "bind=127.0.0.1"; echo "rpcbind=127.0.0.1"; echo "dnsseed=0"
      [ -n "${4:-}" ] && echo "addnode=127.0.0.1:$4"; } > "$W/$1/wam.conf"
}
wait_rpc() {
    for _ in $(seq 1 120); do
        "$CLI" -regtest -datadir="$W/$1" -rpcport="$2" getblockcount >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

echo "node: $("$WAMD" -version | head -1)"
echo "=== 1. a source chain of $BLOCKS blocks ==="
mkconf src 21600 21601
"$WAMD" -datadir="$W/src" -printtoconsole=0 >"$W/src.out" 2>&1 & P_SRC=$!
wait_rpc src 21601 || { echo "source node did not start"; exit 2; }
"$CLI" -regtest -datadir="$W/src" -rpcport=21601 -named createwallet wallet_name=m >/dev/null 2>&1
A=$("$CLI" -regtest -datadir="$W/src" -rpcport=21601 -rpcwallet=m getnewaddress)
t0=$(date +%s%N)
"$CLI" -regtest -datadir="$W/src" -rpcport=21601 generatetoaddress "$BLOCKS" "$A" >/dev/null 2>&1
echo "mined $BLOCKS in $(( ($(date +%s%N) - t0) / 1000000 )) ms"

echo "=== 2. a fresh node catches up, and we ask it things while it does ==="
mkconf new 21602 21603 21600
"$WAMD" -datadir="$W/new" -printtoconsole=0 >"$W/new.out" 2>&1 & P_NEW=$!
wait_rpc new 21603 || { echo "new node did not start"; exit 2; }

t0=$(date +%s%N)
worst=0; samples=0; total=0
while :; do
    h=$("$CLI" -regtest -datadir="$W/new" -rpcport=21603 getblockcount 2>/dev/null || echo 0)
    [ "${h:-0}" -ge "$BLOCKS" ] && break
    now=$(date +%s%N)
    [ $(( (now - t0) / 1000000000 )) -gt 900 ] && { echo "gave up after 900 s at height $h"; break; }
    # How long does the simplest possible RPC take while it is syncing?
    s=$(date +%s%N)
    "$CLI" -regtest -datadir="$W/new" -rpcport=21603 uptime >/dev/null 2>&1
    d=$(( ($(date +%s%N) - s) / 1000000 ))
    samples=$((samples + 1)); total=$((total + d))
    [ "$d" -gt "$worst" ] && worst=$d
done
sync_ms=$(( ($(date +%s%N) - t0) / 1000000 ))
h=$("$CLI" -regtest -datadir="$W/new" -rpcport=21603 getblockcount 2>/dev/null || echo 0)

echo
echo "================ HEADER/BLOCK SYNC ================"
echo "blocks synced                : $h"
echo "wall clock                   : ${sync_ms} ms"
[ "${h:-0}" -gt 0 ] && echo "per block                    : $(( sync_ms / h )) ms"
echo "uptime RPC during sync       : ${samples} samples, avg $(( samples ? total / samples : 0 )) ms, WORST ${worst} ms"
echo "==================================================="
echo
echo "--- cache initialisations on the new node ---"
grep -c "initialising verification context" "$W/new/regtest/debug.log" 2>/dev/null || echo 0
