#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  verify_paper_backup.sh -- check a paper backup, without getpass
# ===========================================================================
#
#      bash verify.sh
#
#  WHY THIS EXISTS
#
#  gen_founder_key.py reads the key with getpass, which hides what is typed.
#  On the ceremony console the input also arrived short, by a different
#  amount every time -- 35, 37, 39, 42 characters out of 52 -- with nothing
#  on screen to show it. The founder spent two days re-checking handwriting
#  that had been correct from the first attempt, twice, with a second person
#  reading each character aloud.
#
#  Hiding the input defends against someone reading the screen. On an
#  air-gapped machine in a locked room there is nobody, so the defence buys
#  nothing, and it removed the only feedback there was. A tool that cannot
#  be used correctly is not secure. It is abandoned, or worked around.
#
#  This reads with the shell instead, shows every character, and counts them
#  before anything else can go wrong. Nothing is written to disk.
# ===========================================================================

set -uo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh" || exit 2

G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; O=$'\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$SCRIPT_DIR/gen_founder_key.py"
[ -f "$GEN" ] || GEN="$SCRIPT_DIR/scripts/gen_founder_key.py"
[ -f "$GEN" ] || { printf '  %sgen_founder_key.py not found%s\n' "$R" "$O"; exit 1; }

NETWORK="${1:-mainnet}"

echo
echo "==============================================================="
echo "  WAM -- verify a paper backup    (network: $NETWORK)"
echo "==============================================================="
echo
echo "  Everything you type is visible. That is deliberate: it is the"
echo "  only way to see a character that did not arrive."
echo

read -rp "  Address (starts with W) : " ADDR
ADDR="$(printf '%s' "$ADDR" | tr -d '[:space:]')"
printf '  -> %d characters' "${#ADDR}"
if [ "${#ADDR}" -eq 34 ]; then printf '  %s(correct)%s\n' "$G" "$O"
else printf '  %s(a WAM address is 34)%s\n' "$R" "$O"; fi
echo

read -rp "  Private key (starts with V) : " WIF
WIF="$(printf '%s' "$WIF" | tr -d '[:space:]')"
printf '  -> %d characters' "${#WIF}"
if [ "${#WIF}" -eq 52 ]; then
    printf '  %s(correct)%s\n' "$G" "$O"
else
    printf '  %s(a WAM key is 52 -- off by %d)%s\n' "$R" "$(( ${#WIF} - 52 ))" "$O"
    echo
    printf '  %sDo not retype the paper yet. The paper is probably fine.%s\n' "$Y" "$O"
    echo "  Look at the line above: is a character missing from what you see?"
    echo "  Type more slowly and run this again."
    echo
    read -rp "  Continue anyway? (y/N) " c
    [ "$c" = "y" ] || { unset WIF; exit 1; }
fi

echo
echo "  ---------------------------------------------------------------"
printf '%s\n' "$WIF" | "$PY" "$GEN" --network "$NETWORK" --verify-backup "$ADDR" 2>&1 \
    | grep -vE "reading from stdin" | sed 's/^/  /'
echo "  ---------------------------------------------------------------"
echo
unset WIF
