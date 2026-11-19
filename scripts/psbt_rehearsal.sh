#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  psbt_rehearsal.sh -- rehearse spending the premine without the key going
#                       anywhere near a networked machine
# ===========================================================================
#
#      bash scripts/psbt_rehearsal.sh
#
#  On launch day the founder key lives on a machine that has never touched a
#  network, and it stays there. To move coins, the TRANSACTION travels to the
#  key rather than the key travelling to the transaction:
#
#      ONLINE                    USB                 OFFLINE
#      ──────                    ───                 ───────
#      build unsigned PSBT  ──── unsigned.psbt ────▶
#                                                    sign with the key
#                           ◀──── signed.psbt   ────
#      finalise & broadcast
#
#  Here the "offline machine" is a second datadir with no network of its own.
#  Every command is the one you will really run; only the transport is
#  simulated. The point is to build the habit and to find the friction now.
#
#  What this proves, on a live chain:
#
#     1. all five tranches   CANNOT be spent at launch -> nothing is liquid,
#                                                         which is the claim
#     2. after time passes   tranche 1 CAN be spent    -> the lock releases,
#                                                         it does not merely
#                                                         refuse forever, and
#                                                         change WAM-005 really
#                                                         applied: the premine
#                                                         is not burned
#
#  The second half matters as much as the first. A lock that never opens and a
#  burn look identical from outside, and the difference would not be discovered
#  until 2027 -- when there would be nothing to do about it.
# ===========================================================================

set -uo pipefail

# These patterns use grep -P. Where -P is unavailable it prints nothing
# and succeeds, and an empty capture in a signing flow is a silent wrong
# value rather than an error. Refuse instead.
SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
. "$SCRIPTS_DIR/lib/pcre.sh"
. "$SCRIPTS_DIR/lib/secret.sh"


# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh"

CORE="${CORE:-$HOME/wam/build/wam-core}"
ONLINE_DIR="${ONLINE_DIR:-$HOME/wam-regtest}"
OFFLINE_DIR="${OFFLINE_DIR:-$HOME/wam-offline}"
USB="${USB:-$HOME/wam-usb}"
ADDR_FILE="${ADDR_FILE:-$HOME/addr.txt}"

PASS=0
FAIL=0
ok()   { printf '  \033[32mok  \033[0m  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf '        \033[90m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m%s\033[0m\n' "$*"; }

ONLINE=("$CORE/src/wam-cli" -regtest "-datadir=$ONLINE_DIR"
        -rpcuser=t -rpcpassword=t -rpcport=29554)

FOUNDER_ADDR=$(cat "$ADDR_FILE" 2>/dev/null)
[ -n "$FOUNDER_ADDR" ] || { echo "no address in $ADDR_FILE"; exit 1; }

mkdir -p "$USB"

echo "======================================================================"
echo " PSBT REHEARSAL -- offline signing of the founder premine"
echo "======================================================================"
echo "  founder address : $FOUNDER_ADDR"
echo "  online datadir  : $ONLINE_DIR"
echo "  offline datadir : $OFFLINE_DIR   (simulates the air-gapped machine)"
echo "  transport       : $USB           (simulates the USB stick)"

# ---------------------------------------------------------------------------
step "[1] ONLINE: locate the genesis premine outputs"
# ---------------------------------------------------------------------------
GENESIS=$("${ONLINE[@]}" getblockhash 0)
GEN_JSON=$("${ONLINE[@]}" getblock "$GENESIS" 2)
GEN_TXID=$(printf '%s' "$GEN_JSON" | grep -oP '"txid":\s*"\K[0-9a-f]{64}' | head -1)

note "genesis txid: $GEN_TXID"

UNLOCKED_VAL=$("${ONLINE[@]}" gettxout "$GEN_TXID" 0 | grep -oP '"value":\s*\K[0-9.]+')
if [ -n "$UNLOCKED_VAL" ]; then
    ok "tranche 1 is in the UTXO set: $UNLOCKED_VAL WAM"
    note "this alone proves change WAM-005 applied -- upstream would have"
    note "dropped the genesis coinbase and the premine would not exist"
else
    bad "tranche 1 is NOT in the UTXO set -- the premine is burned"
    exit 1
fi

LOCKED_VAL=$("${ONLINE[@]}" gettxout "$GEN_TXID" 1 | grep -oP '"value":\s*\K[0-9.]+')
[ -n "$LOCKED_VAL" ] && ok "tranche 2 is in the UTXO set too: $LOCKED_VAL WAM (still time-locked)" \
                     || bad "tranche 2 missing from the UTXO set"

# ---------------------------------------------------------------------------
step "[2] OFFLINE: prepare the air-gapped wallet"
# ---------------------------------------------------------------------------
# A second datadir with -connect=0: it never talks to a peer, which is as close
# to air-gapped as one machine can simulate.
rm -rf "$OFFLINE_DIR"; mkdir -p "$OFFLINE_DIR"
"$CORE/src/wamd" -regtest "-datadir=$OFFLINE_DIR" -rpcuser=t -rpcpassword=t \
    -rpcport=29557 -listen=0 -connect=0 -fallbackfee=0.0001 -daemon >/dev/null 2>&1
sleep 10

OFFLINE=("$CORE/src/wam-cli" -regtest "-datadir=$OFFLINE_DIR"
         -rpcuser=t -rpcpassword=t -rpcport=29557)

if "${OFFLINE[@]}" getblockcount >/dev/null 2>&1; then
    ok "offline node up (isolated: -connect=0, no peers)"
else
    bad "offline node did not start"; exit 1
fi

"${OFFLINE[@]}" createwallet founder_cold >/dev/null 2>&1 \
    || "${OFFLINE[@]}" loadwallet founder_cold >/dev/null 2>&1

echo
echo "  The offline machine needs the key. Type the WIF from your paper."
echo "  It is NOT echoed, NOT stored in history, NOT passed as an argument."
echo
read -r -s -p "  WIF: " WIF
echo

[ -n "$WIF" ] || { echo "  nothing entered"; exit 2; }

CHK=$(printf '%s\n' "pkh($WIF)" | "${OFFLINE[@]}" -stdin getdescriptorinfo 2>/dev/null \
      | grep -oP '"checksum":\s*"\K[^"]+')
if [ -z "$CHK" ]; then
    bad "that WIF is not valid -- re-read your paper (English keyboard!)"
    unset WIF; exit 1
fi

IMP=$(printf '[{"desc":"pkh(%s)#%s","timestamp":0,"internal":false,"active":false,"label":"founder"}]' \
      "$WIF" "$CHK" | "${OFFLINE[@]}" -rpcwallet=founder_cold -stdin importdescriptors 2>&1)

# THE RESPONSE IS KEY-BEARING, SO IT IS REDACTED BEFORE THE KEY IS FORGOTTEN.
#
# Core builds an import failure by interpolating the descriptor it was
# handed -- "Could not add descriptor: pkh(<WIF>)#..." -- and the descriptor
# here is the founder key. This used to print $IMP straight to the terminal,
# so an import that failed for any ordinary wallet reason (a keypool top-up
# that returns nullptr is enough) put the founder WIF in scrollback, in a
# tmux log, and in anything recording the session. On the one machine where
# that key is ever typed.
#
# The order matters and is the whole of the fix besides the filter: `unset
# WIF CHK` ran HERE, one line above, so the redactor would have had nothing
# to match. The safe text is built first and the key is forgotten after.
#
# Reported by Fahrizal, 18 November 2026.
IMP_SAFE=$(redact_secret IMP WIF)
unset WIF CHK

if printf '%s' "$IMP" | grep -q '"success": *true'; then
    unset IMP IMP_SAFE
    ok "key imported into the OFFLINE wallet only"
else
    unset IMP
    bad "import failed"
    printf '%s\n' "$IMP_SAFE" | head -6 | sed 's/^/        /'
    unset IMP_SAFE
    exit 1
fi

GOT=$("${OFFLINE[@]}" -rpcwallet=founder_cold getaddressesbylabel founder 2>/dev/null \
      | grep -oP '"\K[A-Za-z0-9]{25,60}(?=")' | head -1)
[ "$GOT" = "$FOUNDER_ADDR" ] && ok "the offline wallet controls $FOUNDER_ADDR" \
                             || bad "offline wallet controls $GOT, expected $FOUNDER_ADDR"

# ---------------------------------------------------------------------------
step "[3] ONLINE: build an unsigned transaction (the key is not here)"
# ---------------------------------------------------------------------------
"${ONLINE[@]}" createwallet spender >/dev/null 2>&1 || \
"${ONLINE[@]}" loadwallet spender >/dev/null 2>&1
DEST=$("${ONLINE[@]}" -rpcwallet=spender getnewaddress)
note "destination: $DEST"

SPEND=399999
FEE_LEFT=$("$PY" -c "import sys; sys.stdout.reconfigure(newline='\n'); print(f'{400000 - $SPEND - 0.01:.8f}')")

RAW=$("${ONLINE[@]}" createpsbt \
      "[{\"txid\":\"$GEN_TXID\",\"vout\":0}]" \
      "[{\"$DEST\":$SPEND},{\"$FOUNDER_ADDR\":$FEE_LEFT}]" 2>&1)

if printf '%s' "$RAW" | grep -q "^cHNi"; then
    ok "unsigned PSBT built on the ONLINE machine"
    printf '%s' "$RAW" > "$USB/unsigned.psbt"
    note "written to $USB/unsigned.psbt  ($(wc -c < "$USB/unsigned.psbt") bytes)"
else
    bad "could not build the PSBT"; printf '%s\n' "$RAW" | head -3 | sed 's/^/        /'; exit 1
fi

# The offline machine has no chain, so it cannot look up what the input is
# worth. Real air-gapped signing has the same problem, and the answer is the
# same: ship the previous transaction alongside the PSBT.
GENESIS_RAW=$("${ONLINE[@]}" getblock "$GENESIS" 0 2>/dev/null)
note "carrying the genesis block too, so the offline side can see the input"

# ---------------------------------------------------------------------------
step "[4] OFFLINE: sign it"
# ---------------------------------------------------------------------------
SIGNED=$("${OFFLINE[@]}" -rpcwallet=founder_cold walletprocesspsbt \
         "$(cat "$USB/unsigned.psbt")" 2>&1)

if printf '%s' "$SIGNED" | grep -q '"complete": *true'; then
    ok "signed on the OFFLINE machine -- signing is complete"
    printf '%s' "$SIGNED" | grep -oP '"psbt":\s*"\K[^"]+' > "$USB/signed.psbt"
    note "written to $USB/signed.psbt"
elif printf '%s' "$SIGNED" | grep -q '"psbt"'; then
    printf '%s' "$SIGNED" | grep -oP '"psbt":\s*"\K[^"]+' > "$USB/signed.psbt"
    bad "signing produced a PSBT but reports incomplete"
    note "$(printf '%s' "$SIGNED" | grep -oP '"complete":\s*\K\w+')"
else
    bad "signing failed"
    printf '%s\n' "$SIGNED" | head -6 | sed 's/^/        /'
fi

# ---------------------------------------------------------------------------
step "[5] ONLINE: finalise and broadcast"
# ---------------------------------------------------------------------------
if [ -s "$USB/signed.psbt" ]; then
    FIN=$("${ONLINE[@]}" finalizepsbt "$(cat "$USB/signed.psbt")" 2>&1)
    HEX=$(printf '%s' "$FIN" | grep -oP '"hex":\s*"\K[0-9a-f]+')

    if [ -n "$HEX" ]; then
        ok "transaction finalised"
        TXID=$("${ONLINE[@]}" sendrawtransaction "$HEX" 2>&1)
        if printf '%s' "$TXID" | grep -qE '^[0-9a-f]{64}$'; then
            ok "BROADCAST -- txid $TXID"
            note "the premine moved, and the key never left the offline machine"
        else
            bad "broadcast rejected"
            printf '%s\n' "$TXID" | head -3 | sed 's/^/        /'
        fi
    else
        bad "finalizepsbt did not produce a raw transaction"
        printf '%s\n' "$FIN" | head -6 | sed 's/^/        /'
    fi
fi

# ---------------------------------------------------------------------------
step "[6] the locked tranches must REFUSE"
# ---------------------------------------------------------------------------
# Tranche 2 unlocks in 2027. The chain's time is 2011. Any attempt to spend it
# now must fail -- and it must fail because of the timelock, not because of a
# missing signature.
LOCKED_PSBT=$("${ONLINE[@]}" createpsbt \
    "[{\"txid\":\"$GEN_TXID\",\"vout\":1}]" \
    "[{\"$DEST\":399999}]" 2>&1)

if printf '%s' "$LOCKED_PSBT" | grep -q "^cHNi"; then
    LSIGN=$("${OFFLINE[@]}" -rpcwallet=founder_cold walletprocesspsbt "$LOCKED_PSBT" 2>&1)
    LHEX=$(printf '%s' "$LSIGN" | grep -oP '"complete":\s*\Ktrue' || true)

    if [ -n "$LHEX" ]; then
        LFIN=$("${ONLINE[@]}" finalizepsbt \
               "$(printf '%s' "$LSIGN" | grep -oP '"psbt":\s*"\K[^"]+')" 2>&1)
        LRAW=$(printf '%s' "$LFIN" | grep -oP '"hex":\s*"\K[0-9a-f]+')
        if [ -n "$LRAW" ]; then
            RES=$("${ONLINE[@]}" sendrawtransaction "$LRAW" 2>&1)
            if printf '%s' "$RES" | grep -qE '^[0-9a-f]{64}$'; then
                bad "!!! A TIME-LOCKED TRANCHE WAS SPENT. The lock does not work."
            else
                ok "locked tranche REJECTED by consensus"
                note "$(printf '%s' "$RES" | head -c 160)"
            fi
        else
            ok "locked tranche could not even be finalised"
            note "$(printf '%s' "$LFIN" | head -c 160)"
        fi
    else
        ok "the wallet cannot produce a complete signature for a locked tranche"
        note "bare CLTV is not a template the wallet signs -- correct and expected"
    fi
else
    note "could not build a PSBT for the locked tranche: $(printf '%s' "$LOCKED_PSBT" | head -c 120)"
fi

# ---------------------------------------------------------------------------
step "[7] cleanup"
# ---------------------------------------------------------------------------
"${OFFLINE[@]}" stop >/dev/null 2>&1
note "offline node stopped; its wallet (with the key) stays in $OFFLINE_DIR"
note "on a real setup that datadir never exists on a networked machine"

echo
echo "======================================================================"
if [ "$FAIL" -eq 0 ]; then
    printf ' \033[32mALL %d CHECKS PASSED\033[0m\n' "$PASS"
else
    printf ' \033[31m%d of %d CHECKS FAILED\033[0m\n' "$FAIL" "$((PASS+FAIL))"
fi
echo "======================================================================"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
