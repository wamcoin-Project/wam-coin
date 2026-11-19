# shellcheck shell=bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  secret.sh -- show an operator what the node said, without the key in it
# ===========================================================================
#
#  WHY THIS EXISTS
#
#  importdescriptors is handed `pkh(<WIF>)#<checksum>`, and when it refuses,
#  Bitcoin Core builds the error by interpolating the descriptor it was
#  given -- "Could not add descriptor: pkh(<WIF>)#..." (v28.1,
#  src/wallet/rpc/backup.cpp). So the failure branch of any script that
#  imports a key is holding the key in its error text, and printing that
#  response puts the founder WIF in terminal scrollback, in a tmux log, and
#  in anything capturing the session.
#
#  The operator still needs to know why the import failed. Both things are
#  possible: redact, then print.
#
#  Reported by Fahrizal, 18 November 2026, against psbt_rehearsal.sh.
#
#  THREE LAYERS, BECAUSE THE FIRST ONE CANNOT COVER WHAT WE DO NOT HOLD
#
#  1. The exact value. We have the WIF in a variable, so the surest
#     redaction is the literal one -- and it is done with bash parameter
#     expansion, inside this shell. Not sed, not grep: an argument to either
#     is a command line, and /proc/<pid>/cmdline is world-readable. That is
#     this repository's own finding of 13 November 2026, and the sibling
#     script's existing filter -- `grep -v "$WIF"` -- walks straight into
#     it. A redactor that leaks the secret to the process table while
#     removing it from the screen has moved the problem, not solved it.
#
#  2. The descriptor body. Anything inside pkh(...), wpkh(...), sh(...),
#     tr(...) or combo(...) is replaced wholesale. This is format-driven
#     rather than value-driven, so it holds for a key this shell never saw:
#     a second descriptor quoted back, a key from another wallet, a form
#     upstream adds later.
#
#  3. The shape, as a last net. AND IT IS WAM'S SHAPE, NOT BITCOIN'S.
#     WAM's mainnet SECRET_KEY version byte is 190, so a WAM WIF begins with
#     'V' (compressed) or '7' (uncompressed); testnet and regtest are 239,
#     which is 'c' or '9'. A filter written as [5KL], which is what every
#     example on the internet says, matches a Bitcoin key and NOT A SINGLE
#     ONE OF OURS. Bitcoin's prefixes are kept in the class anyway, because
#     a wallet on the same machine may hold one and this costs nothing.
#
#  Over-redaction is the safe direction and is not apologised for: a base58
#  run that is not a key reads as <REDACTED> and the operator has lost
#  nothing worth having.
# ===========================================================================

# Print $1's text with $2's value, any descriptor body, and anything
# key-shaped removed. BOTH ARGUMENTS ARE VARIABLE NAMES, NOT VALUES --
# passing the secret itself would put it in this function's own argv, which
# is the thing being prevented.
#
#     redact_secret IMP WIF        # correct
#     redact_secret "$IMP" "$WIF"  # WRONG: the key is now in the process table
#
# The second argument may be omitted or name an empty variable; layers 2 and
# 3 still apply.
redact_secret() {
    local _textname="${1:-}" _secretname="${2:-}"
    local _text="" _secret=""

    [ -n "$_textname" ] && _text="${!_textname-}"
    [ -n "$_secretname" ] && _secret="${!_secretname-}"

    # 1. the value we hold -- in-shell, no process, no argv, no temp file
    if [ -n "$_secret" ]; then
        _text="${_text//"$_secret"/<WIF REDACTED>}"
    fi

    # 2 and 3. The patterns are literals, so they are safe as arguments.
    #
    # -E for one portable dialect. No \b: BSD sed does not have it, and
    # without it the class can only match MORE, which is the safe way to be
    # wrong.
    printf '%s\n' "$_text" | sed -E \
        -e 's/(pkh|wpkh|sh|tr|combo|addr|raw|xprv|multi|sortedmulti)\(([^)]*)\)/\1(<REDACTED>)/g' \
        -e 's/[5KLV7c9][1-9A-HJ-NP-Za-km-z]{50,51}/<WIF REDACTED>/g' \
        -e 's/(xprv|tprv)[1-9A-HJ-NP-Za-km-z]{70,120}/<XPRV REDACTED>/g'
}

# A guard for the caller: refuse to print at all if the redactor is missing.
# A script that sources this file and then calls a function that is not
# there would, under `set -u`, fail -- but under a shell without it would
# print nothing and carry on, and "nothing" is indistinguishable from "a
# clean response" to the person reading the screen.
redact_secret_available() { return 0; }
