#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  test_secret_redaction.sh -- the founder key does not reach the screen
# ===========================================================================
#
#      bash scripts/test/test_secret_redaction.sh
#
#  WHAT THIS HOLDS DOWN
#
#  Two scripts type the founder WIF from paper and hand it to
#  importdescriptors. Core v28.1 builds an import failure by interpolating
#  the descriptor it was given, so the response to a failed import contains
#  the key, and both scripts printed that response.
#
#  Reported by Fahrizal, 18 November 2026, against psbt_rehearsal.sh. The
#  same defect was then found in import_founder_key.sh, in the more
#  dangerous of its two print paths.
#
#  The fixture below is Core's exact error string with an obviously fake
#  key in it. NO REAL KEY IS USED, GENERATED OR READ ANYWHERE IN THIS FILE.
#
#  The WIF in the fixture begins with 'V' because that is what WAM's
#  SECRET_KEY version byte of 190 produces. A redactor written for Bitcoin's
#  [5KL] passes this test's third case and protects nobody on this chain,
#  which is why that case exists.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; BLD=$'\033[1m'; OFF=$'\033[0m'
pass=0; failed=0

ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$1"; pass=$((pass + 1)); }
no()   { printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$1"; shift
         while [ $# -gt 0 ]; do printf '        %s\n' "$1"; shift; done
         failed=$((failed + 1)); }

. "$HERE/scripts/lib/secret.sh"

printf '\n%s  the founder key does not reach the screen%s\n\n' "$BLD" "$OFF"

# A WAM-shaped placeholder. Not a key: 'V' plus a fixed run of base58
# characters, 52 long, which no chain will ever derive anything from.
FAKE_WIF="VQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"

# ---- 1. Core's own failure string, which is the reported path -------------
RESPONSE="error code: -4
error message:
Could not add descriptor: pkh($FAKE_WIF)#8rhhckhu"

SAFE="$(redact_secret RESPONSE FAKE_WIF)"

if printf '%s' "$SAFE" | grep -qF "$FAKE_WIF"; then
    no "the import failure still prints the key" \
       "this is the whole report: an ordinary wallet-state failure puts" \
       "the founder WIF in scrollback on the one machine it is typed on"
else
    ok "an import failure does not print the key it was handed"
fi

if printf '%s' "$SAFE" | grep -q "Could not add descriptor"; then
    ok "and the operator is still told why it failed"
else
    no "the reason was redacted along with the key" \
       "an operator who cannot see the error cannot act on it, and will" \
       "reach for a command that prints the raw response instead"
fi

# ---- 2. a key this shell never saw ---------------------------------------
# Layer 1 cannot help here: nothing holds the value. The descriptor body and
# the shape are what catch it.
OTHER="warning: wallet already contains pkh(VZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ)#aaaaaaaa"
EMPTY=""
SAFE2="$(redact_secret OTHER EMPTY)"
if printf '%s' "$SAFE2" | grep -q "ZZZZZZZZZZ"; then
    no "a descriptor we did not supply is printed in full" \
       "the node can quote back a key from another wallet, or a second" \
       "descriptor, and this shell has no value to match it against"
else
    ok "a descriptor this shell never supplied is redacted too"
fi

# ---- 3. the alphabet, which is the trap ----------------------------------
if printf '%s' "$SAFE" | grep -qE '[5KL][1-9A-HJ-NP-Za-km-z]{50,51}'; then
    no "a Bitcoin-shaped key survived" "unreachable unless the fixture changed"
fi
if printf '%s\n' "$FAKE_WIF" | grep -qE '^[5KL]'; then
    no "the fixture is a Bitcoin WIF, so this file tests the wrong chain" \
       "WAM's SECRET_KEY byte is 190: a mainnet WIF begins V or 7"
else
    ok "the fixture is WAM-shaped, so a [5KL] filter would not have caught it"
fi

# ---- 4. the secret must never become an argument -------------------------
#
# /proc/<pid>/cmdline is world-readable. This repository found that on
# 13 November 2026 for wam-cli and fixed it; the filter that was then
# protecting the key in import_founder_key.sh was `grep -v "$WIF"`, which
# is the same hazard wearing the uniform of the fix.
#
# EXTERNAL commands only. `[`, `printf`, `echo`, `read`, `unset` and `local`
# are bash builtins: they fork nothing, so nothing of theirs appears in the
# process table, and `printf '%s\n' "pkh($WIF)" | cli_stdin ...` is the
# CORRECT pattern -- the key travels down a pipe. The first version of this
# check flagged `if [ -z "$CHK" ]` and was measuring the wrong thing.
EXTERNALS='grep|sed|awk|tr|cut|head|tail|sort|uniq|xargs|curl|wget|python3?|tee|wam-cli|bitcoin-cli|jq|openssl'
for f in scripts/psbt_rehearsal.sh scripts/import_founder_key.sh; do
    hits=$(grep -nE "\b($EXTERNALS)\b[^|]*\"\\\$(WIF|CHK|CHECKSUM)\"" "$f" \
           | grep -vE '^[0-9]+:[[:space:]]*#' || true)
    if [ -n "$hits" ]; then
        no "$(basename "$f") passes a secret to an external command" \
           "/proc/<pid>/cmdline is world-readable for as long as it runs" \
           "$(printf '%s' "$hits" | head -3)"
    else
        ok "$(basename "$f") never passes the key to an external command"
    fi
done

# ---- 5. the raw response is never what gets printed ----------------------
#
# This is the invariant, and it is stronger than any statement about the
# ORDER of two lines: a captured importdescriptors response may be TESTED
# (grep -q, which prints nothing) but never PRINTED. Only the redacted copy
# reaches a terminal.
#
# Ordering was how the defect was described -- psbt_rehearsal.sh unset the
# key one line above the branch that printed, so a filter added later would
# have had nothing to match with -- but a check that compares two line
# numbers reads the wrong `unset WIF` the moment a script has two of them,
# which this one does.
for f in scripts/psbt_rehearsal.sh scripts/import_founder_key.sh; do
    if ! grep -q 'redact_secret' "$f"; then
        no "$(basename "$f") does not redact at all"
        continue
    fi
    # A raw capture on its way TO A TERMINAL.
    #
    # `printf '%s' "$IMP" | grep -q '"success"'` prints nothing: it is a
    # test, and the response must be tested raw or the test is testing the
    # redaction. `grep -oP ... )` captured into a variable prints nothing
    # either. What reaches a screen is a pipeline ending in the display
    # commands -- indenting with sed, trimming with head, splitting with
    # tee -- so those are what this looks for.
    raw=$(grep -nE '"\$(IMP|RESULT|INFO)"' "$f" \
          | grep -E "sed 's/\^/|head -|tee " \
          | grep -vE '^[0-9]+:[[:space:]]*#' || true)
    if [ -n "$raw" ]; then
        no "$(basename "$f") prints a raw node response" \
           "an import failure interpolates the descriptor it was handed" \
           "$(printf '%s' "$raw" | head -3)"
    else
        ok "$(basename "$f") prints only the redacted copy"
    fi
done

printf '\n'
if [ "$failed" -eq 0 ]; then
    printf '%s%s  %s checks: the key stays off the screen and out of argv%s\n\n' \
           "$GRN" "$BLD" "$pass" "$OFF"
    exit 0
fi
printf '%s%s  %s of %s checks failed%s\n\n' \
       "$RED" "$BLD" "$failed" "$((pass + failed))" "$OFF"
exit 1
