#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  import_founder_key.sh -- load a founder WIF into a descriptor wallet
# ===========================================================================
#
#      bash scripts/import_founder_key.sh --network testnet
#
#  Bitcoin Core v28 wallets are descriptor wallets, and importprivkey is a
#  legacy-only RPC. The equivalent is importdescriptors with a pkh() descriptor
#  carrying the key -- which needs a checksum, which needs a round trip through
#  getdescriptorinfo. Doing that by hand means the key lands in shell history
#  and in the process list, so this script does it instead.
#
#  Four precautions, none of them optional for a key that matters:
#
#    * read -s     -- the key is never echoed to the terminal
#    * -stdin      -- bitcoin-cli reads it from a pipe, so it never appears in
#                     `ps` output where any other user on the box can see it
#    * HISTIGNORE  -- nothing about this invocation carries the key, because
#                     the key is never an argument
#    * cookie auth, or -stdinrpcpass -- and the same for the node's RPC
#                     password, which this script put in argv for every call
#                     it made until 13 November 2026 while listing the three
#                     above. See the long note further down.
#
#  It prints the derived address and compares it with the one the chain expects,
#  so a mistyped key fails here rather than silently importing a wallet that
#  controls nothing.
# ===========================================================================

set -uo pipefail

# These patterns use grep -P. Where -P is unavailable it prints nothing
# and succeeds, and an empty capture in a signing flow is a silent wrong
# value rather than an error. Refuse instead.
SCRIPTS_DIR="${SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
. "$SCRIPTS_DIR/lib/pcre.sh"


NETWORK="testnet"
WALLET="founder"
CLI="./src/wam-cli"
DATADIR=""
RPCPORT=""
RPCUSER=""
RPCPASS=""
EXPECT_ADDR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --network) NETWORK="$2"; shift ;;
        --wallet)  WALLET="$2"; shift ;;
        --cli)     CLI="$2"; shift ;;
        --datadir) DATADIR="$2"; shift ;;
        --rpcport) RPCPORT="$2"; shift ;;
        --rpcuser) RPCUSER="$2"; shift ;;
        --rpcpassword) RPCPASS="$2"; shift ;;
        --expect-address) EXPECT_ADDR="$2"; shift ;;
        -h|--help) sed -n '5,30p' "$0"; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
    shift
done

case "$NETWORK" in
    mainnet) NETFLAG="";          DEFPORT=9554  ;;
    testnet) NETFLAG="-testnet";  DEFPORT=19554 ;;
    regtest) NETFLAG="-regtest";  DEFPORT=29554 ;;
    *) echo "unknown network $NETWORK" >&2; exit 2 ;;
esac

[ -n "$RPCPORT" ] || RPCPORT="$DEFPORT"
[ -n "$DATADIR" ] || DATADIR="$HOME/wam-$NETWORK"

# THE KEY WAS KEPT OUT OF `ps`. THE RPC PASSWORD WAS NOT.
#
# This script's own header listed three precautions for the WIF -- read -s,
# -stdin, HISTIGNORE -- all three correct, and then put
# the password option in the argv of every single call it made. On Linux
# /proc/<pid>/cmdline is world-readable by default, so any other account on the
# machine could read the node's RPC password by listing processes while this
# ran. The defaults were `t`/`t`, which hid how it would read on the mainnet
# node where the founder key actually goes.
#
# The error path was worse: it printed `${BASE[*]}` to the terminal, password
# included, as a "create the wallet with this command" hint -- into the
# scrollback, into any transcript, and into whatever the operator pastes into a
# chat window to ask what went wrong. A secret in argv is visible while the
# process lives. A secret echoed to a terminal outlives everything.
#
# Two shapes now, and neither puts it in argv:
#
#   no credentials given -- nothing is passed, and wam-cli reads the cookie
#     file the node writes in its own datadir. This is the right default: the
#     cookie is mode 0600, rotates on every restart, and the operator running
#     this script on the node's own machine can already read it.
#
#   credentials given -- the password goes down a pipe with -stdinrpcpass,
#     which wam-cli reads as the first line of standard input. The calls that
#     already send data on stdin keep working: -stdinrpcpass takes the first
#     line and -stdin takes the rest as arguments (bitcoin-cli.cpp, in that
#     order), which is how the WIF and the password travel together without
#     either one touching the command line.
#
# Reported 13 November 2026 with treasury_spend.py, which had the same shape.
BASE=($CLI $NETFLAG "-datadir=$DATADIR" "-rpcport=$RPCPORT")
if [ -n "$RPCUSER" ]; then
    BASE+=("-rpcuser=$RPCUSER")
fi

# Every call goes through these two. cli() for a call whose arguments are
# ordinary; cli_stdin() for one that sends data, which is read from this
# function's own stdin and forwarded after the password line.
cli() {
    if [ -z "$RPCPASS" ]; then
        "${BASE[@]}" "$@"
    else
        printf '%s\n' "$RPCPASS" | "${BASE[@]}" -stdinrpcpass "$@"
    fi
}

cli_stdin() {
    if [ -z "$RPCPASS" ]; then
        "${BASE[@]}" -stdin "$@"
    else
        { printf '%s\n' "$RPCPASS"; cat; } | "${BASE[@]}" -stdinrpcpass -stdin "$@"
    fi
}

echo "======================================================================"
echo " IMPORT FOUNDER KEY -- $NETWORK / wallet '$WALLET'"
echo "======================================================================"
if [ -z "$RPCPASS" ]; then
    echo " authenticating with the node's cookie file in $DATADIR"
else
    echo " authenticating with the password you passed, read from a pipe"
fi

if ! cli getblockcount >/dev/null 2>&1; then
    echo "  error: cannot reach the $NETWORK node at 127.0.0.1:$RPCPORT" >&2
    if [ -z "$RPCPASS" ] && [ ! -r "$DATADIR/.cookie" ]; then
        echo "         there is no readable $DATADIR/.cookie either, so this" >&2
        echo "         could not authenticate. Start the node, or pass" >&2
        echo "         --rpcuser and --rpcpassword." >&2
    fi
    exit 1
fi

if ! cli listwallets 2>/dev/null | grep -q "\"$WALLET\""; then
    echo "  loading wallet '$WALLET'..."
    cli loadwallet "$WALLET" >/dev/null 2>&1 \
        || { echo "  error: wallet '$WALLET' does not exist. Create it with"; \
             echo "         the same options you gave this script, plus"; \
             echo "         createwallet $WALLET"; exit 1; }
fi

echo
echo "  Paste or type the WIF from your paper backup."
echo "  It will NOT be shown, NOT stored in shell history, and NOT passed as a"
echo "  command-line argument (so it never appears in 'ps')."
echo
read -r -s -p "  WIF: " WIF
echo
echo

if [ -z "$WIF" ]; then
    echo "  nothing entered"; exit 2
fi

# ---- checksum, via stdin so the key stays out of the process list ---------
INFO=$(printf '%s\n' "pkh($WIF)" | cli_stdin getdescriptorinfo 2>&1)
CHECKSUM=$(printf '%s' "$INFO" | grep -oP '"checksum"\s*:\s*"\K[^"]+')

if [ -z "$CHECKSUM" ]; then
    echo "  FAILED to build a descriptor from that key."
    echo "  The node said:"
    printf '%s\n' "$INFO" | grep -v "$WIF" | sed 's/^/    /' | head -5
    echo
    echo "  Most likely the WIF has a wrong character. Re-read your paper copy."
    unset WIF
    exit 1
fi

# ---- import ---------------------------------------------------------------
REQ=$(printf '[{"desc":"pkh(%s)#%s","timestamp":0,"internal":false,"active":false,"label":"founder"}]' \
      "$WIF" "$CHECKSUM")

RESULT=$(printf '%s\n' "$REQ" | cli_stdin "-rpcwallet=$WALLET" importdescriptors 2>&1)
unset WIF REQ    # the key leaves this shell here

if printf '%s' "$RESULT" | grep -q '"success": *true'; then
    echo "  import: SUCCESS"
else
    echo "  import: FAILED"
    printf '%s\n' "$RESULT" | sed 's/^/    /' | head -12
    exit 1
fi

# ---- verify the wallet now controls what we expect ------------------------
echo
echo "  addresses this wallet can now sign for:"
ADDRS=$(cli "-rpcwallet=$WALLET" getaddressesbylabel founder 2>/dev/null \
        | grep -oP '"\K[A-Za-z0-9]{25,60}(?=")' | sort -u)

if [ -z "$ADDRS" ]; then
    echo "    (none reported -- import succeeded but no address was labelled)"
else
    printf '    %s\n' $ADDRS
fi

if [ -n "$EXPECT_ADDR" ]; then
    echo
    if printf '%s\n' $ADDRS | grep -qx "$EXPECT_ADDR"; then
        echo "  MATCH -- the wallet controls $EXPECT_ADDR"
    else
        echo "  MISMATCH -- expected $EXPECT_ADDR, which is NOT in the list above."
        echo "  This key does not control the founder address in chainparams."
        exit 1
    fi
fi

echo
echo "  done."
