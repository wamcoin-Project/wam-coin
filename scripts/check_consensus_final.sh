#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_consensus_final.sh -- is anything still going to change?
# ===========================================================================
#
#      bash scripts/check_consensus_final.sh [mainnet|testnet|all]
#
#  WHY THIS EXISTS
#
#  A consensus rule that changes after block 1 does not update the chain. It
#  invalidates every block mined under the old rule, and the only nodes that
#  cannot see this are the ones already running -- they never re-validate what
#  they have already accepted. The chain looks healthy from the inside and
#  cannot be joined from the outside.
#
#  The testnet was reset twice for exactly that. The second time, the treasury
#  was given its own address while blocks were being mined: 1 to 30 paid the
#  old address, 31 onward paid the new one, and no fresh node could get past
#  height 1. Nothing was wrong with the change. It was made at the wrong time.
#
#  So before a chain is started, this asks the only question that prevents a
#  third reset: is every value the rules depend on final, or is one of them
#  still a placeholder someone means to replace later?
#
#  "Later" is the whole problem. After block 1 there is no later.
# ===========================================================================

set -uo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh" || exit 2
. "$SCRIPTS_DIR/lib/quoted.sh"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
CHAINPARAMS="src/wam/chainparams.cpp"
PARAMS="src/wam/wam-params.h"
TARGET="${1:-all}"

case "$TARGET" in
    mainnet|testnet|all) ;;
    *) printf 'usage: %s [mainnet|testnet|all]\n' "${0##*/}" >&2; exit 2 ;;
esac

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
BLOCKING=0

ok()    { printf '  %sok%s      %s\n' "$GRN" "$OFF" "$*"; }
block() { printf '  %sBLOCKS%s  %s\n' "$RED" "$OFF" "$*"; BLOCKING=$((BLOCKING + 1)); }
note()  { printf '  %snote%s    %s\n' "$YLW" "$OFF" "$*"; }

[ -f "$CHAINPARAMS" ] || { echo "no $CHAINPARAMS" >&2; exit 2; }

echo "=================================================================="
echo " Is every consensus input final?"
echo "=================================================================="

# ---------------------------------------------------------------------------
# The addresses the rules pay to.
#
# A placeholder is recognised by what it is, not by matching a string: the burn
# address is base58check over twenty zero bytes, so this still finds it if the
# prefix or the network changes.
# ---------------------------------------------------------------------------
printf '\n%sthe addresses consensus depends on%s\n' "$BLD" "$OFF"

"$PY" - "$CHAINPARAMS" "$TARGET" <<'PY'
import re, sys, hashlib

ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def b58decode(s):
    n = 0
    for ch in s:
        n = n * 58 + ALPHABET.index(ch)
    raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    pad = len(s) - len(s.lstrip('1'))
    return b'\x00' * pad + raw


src = open(sys.argv[1], encoding='utf-8').read()
target = sys.argv[2]
found = dict(re.findall(
    r'(WAM_(?:TREASURY|FOUNDER)_ADDRESS_(?:MAINNET|TESTNET))\s*=\s*"([^"]+)"', src))

bad = 0
for name, addr in sorted(found.items()):
    net = 'mainnet' if name.endswith('MAINNET') else 'testnet'
    if target != 'all' and net != target:
        continue
    try:
        payload = b58decode(addr)
        h160 = payload[1:-4]
        burn = (h160 == b'\x00' * 20)
    except Exception:
        print('  \033[31mBLOCKS\033[0m  %s is not decodable base58: %s' % (name, addr))
        bad += 1
        continue
    if burn:
        print('  \033[31mBLOCKS\033[0m  %s is the burn placeholder (%s)' % (name, addr))
        print('          Every 5%% fee on this network would be destroyed, and')
        print('          replacing it after block 1 splits the chain.')
        bad += 1
    else:
        print('  \033[32mok\033[0m      %-30s %s' % (name, addr))

sys.exit(1 if bad else 0)
PY
[ $? -eq 0 ] || BLOCKING=$((BLOCKING + 1))

# ---------------------------------------------------------------------------
printf '\n%sunfinished work in the consensus sources%s\n' "$BLD" "$OFF"

# Only src/wam/ -- upstream's own TODOs are not ours to answer, and counting
# them would bury the ones that are.
#
# Work tags only. This once also matched PLACEHOLDER and "temporary", and its
# first run flagged the comment header that *explains* why placeholders were
# removed -- prose about a solved problem, reported as the problem.
#
# That was answered by narrowing the pattern, which is a patch: it moved the
# blind spot rather than closing it, and left TODO/FIXME/XXX able to fire on a
# comment that merely says "no TODO markers remain in this file". The same
# fault then turned up in the release workflow, in set_version.py and in a
# unit-install guard, all within a day.
#
# So it honours the project's quotation marks now, like every other check that
# matches text: scripts/lib/quoted.sh, the shell twin of quoted.py. A file is
# listed by grep and then read with its quotations blanked, and line numbers
# survive the blanking so what is reported is still where it is.
MARKS=""
while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in *.wam-orig*) continue ;; esac
    hits="$(unquoted "$f" | grep -nE '\b(TODO|FIXME|XXX)\b' || true)"
    [ -n "$hits" ] && MARKS="${MARKS}$(printf '%s\n' "$hits" | sed "s|^|$f:|")
"
done <<EOF
$(grep -rlE '\b(TODO|FIXME|XXX)\b' src/wam/ 2>/dev/null || true)
EOF
MARKS="$(printf '%s' "$MARKS" | grep -v '^$' || true)"
if [ -z "$MARKS" ]; then
    ok "nothing in src/wam/ is marked unfinished"
else
    printf '%s\n' "$MARKS" | head -8 | sed 's/^/          /'
    block "$(printf '%s\n' "$MARKS" | wc -l) unfinished marker(s) in src/wam/"
fi

# ---------------------------------------------------------------------------
printf '\n%sthe genesis blocks are mined, not guessed%s\n' "$BLD" "$OFF"

for net in mainnet testnet regtest; do
    [ "$TARGET" = "all" ] || [ "$TARGET" = "$net" ] || continue
done
NONCES="$(grep -cE '/\*nNonce=\*/ +[0-9]+' "$CHAINPARAMS" 2>/dev/null || echo 0)"
ASSERTS="$(grep -cE 'hashGenesisBlock == uint256S\("0x[0-9a-f]{64}"\)' "$CHAINPARAMS" 2>/dev/null || echo 0)"
if [ "$ASSERTS" -ge 3 ] && [ "$NONCES" -ge 3 ]; then
    ok "$ASSERTS genesis hashes asserted, $NONCES nonces recorded"
else
    block "only $ASSERTS genesis assertion(s) and $NONCES nonce(s) -- a chain is missing one"
fi

if grep -qE 'nNonce=\*/ +(0|1),? +//.*placeholder' "$CHAINPARAMS" 2>/dev/null; then
    block "a genesis nonce is still the placeholder"
fi

# ---------------------------------------------------------------------------
printf '\n%sthe premine schedule%s\n' "$BLD" "$OFF"

if [ -f "$PARAMS" ]; then
    if "$PY" scripts/check_vesting_sync.py >/dev/null 2>&1; then
        ok "the unlock tables agree with each other"
    else
        block "the unlock tables disagree -- run scripts/check_vesting_sync.py"
    fi
    # `grep -c ... || echo 0` appends a second line when grep finds nothing and
    # exits 1, so the variable becomes "0\n0" and every numeric test after it
    # dies. Let grep's own zero stand.
    LIQUID="$(grep -cE 'WAM_PREMINE_UNLOCK_TIMES\[[0-9]+\] *= *0' "$PARAMS" 2>/dev/null)"
    LIQUID="${LIQUID:-0}"
    if [ "$LIQUID" -eq 0 ]; then
        ok "no tranche unlocks at height zero"
    else
        note "$LIQUID tranche(s) unlock immediately -- deliberate?"
    fi
fi

# ---------------------------------------------------------------------------
printf '\n%sports and prefixes, which split a network just as hard%s\n' "$BLD" "$OFF"

DUPPORT="$(grep -oE 'nDefaultPort = [0-9]+' "$CHAINPARAMS" 2>/dev/null \
    | awk '{print $3}' | sort | uniq -d)"
if [ -z "$DUPPORT" ]; then
    ok "each network has its own p2p port"
else
    block "two networks share port $DUPPORT -- their nodes will find each other"
fi

MAGIC="$(grep -oE 'pchMessageStart\[0\] = 0x[0-9a-fA-F]+' "$CHAINPARAMS" 2>/dev/null | wc -l)"
[ "$MAGIC" -ge 3 ] && ok "$MAGIC networks define their own message magic" \
                   || note "only $MAGIC message magic definitions found"

# ---------------------------------------------------------------------------
echo
echo "=================================================================="
if [ "$BLOCKING" -eq 0 ]; then
    printf ' %severy consensus input is final -- a chain started now can stand%s\n' "$GRN" "$OFF"
else
    printf ' %s%d thing(s) would still change. Starting a chain now buys a reset.%s\n' \
        "$RED" "$BLOCKING" "$OFF"
fi
echo "=================================================================="
[ "$BLOCKING" -eq 0 ]
