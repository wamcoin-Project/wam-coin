#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  test_verify_release_unlisted.sh -- a file the signed list does not name
# ===========================================================================
#
#  SHA256SUMS.asc signs SHA256SUMS and nothing else. `sha256sum -c` walks the
#  LIST, so a file sitting in the directory that the list does not name is
#  never opened -- and the banner said the release was unmodified anyway.
#  Anyone who can serve HTTP to a downloader can hand over the genuine
#  release plus one extra file and be told it is untouched.
#
#  WHAT THIS FILE CAN AND CANNOT PROVE, SAID PLAINLY
#
#  verify_release.sh checks the GPG signature FIRST and exits before it ever
#  reaches the unlisted walk. A fixture built here cannot carry a valid
#  signature -- the key is not on this machine and must not be -- so this
#  file cannot drive the real script end to end, and it does not pretend to.
#
#  It does two things instead:
#
#    1. Models the predicate, and says so. The model is exercised against
#       every shape that has got through: a name no glob matches, a dotfile,
#       one in a subdirectory, and a name carrying a newline.
#
#    2. Refuses to let the model drift away from the script. The previous
#       version of this file modelled `for f in wam-coin-* wam-miner-*
#       wam-qt-*` -- the predicate from BEFORE the 26 November widening --
#       and "checked" the real script by grepping it for one sentence of its
#       output. So it tested code that no longer existed and asserted the
#       real one by its error message. The drift checks below are what stop
#       that recurring.
#
#  THE END-TO-END PROOF IS scripts/test/stranger.sh. It downloads the real
#  signed release, plants each hostile shape beside it one at a time, and
#  runs the real verify_release.sh. That is where "it refuses" is measured;
#  this is where it is reasoned about offline.
#
#  Both holes in this one check were reported on 26 November 2026: the three
#  globs by Radenlingga, and the newline by mpit, in the fix for the first.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; BLD=$'\033[1m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then GRN=; RED=; BLD=; OFF=; fi
pass=0; failed=0
ok() { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$1"; pass=$((pass + 1)); }
no() { printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$1"; shift
       while [ $# -gt 0 ]; do printf '        %s\n' "$1"; shift; done
       failed=$((failed + 1)); }

printf '\n%s  a file the signed list does not name%s\n\n' "$BLD" "$OFF"

command -v sha256sum >/dev/null 2>&1 || {
    printf '  %s!!%s    no sha256sum here, so nothing was checked\n\n' \
           $'\033[33m' "$OFF"; exit 2; }

SCRIPT=scripts/verify_release.sh

# ---------------------------------------------------------------------------
# 1. The model, which is the predicate the script must have.
# ---------------------------------------------------------------------------
unlisted_in() {
    local dir="$1"
    ( cd "$dir" || return 1
      local listed NL f
      listed="$(sed 's/^[^ ]*  *[*]\?//' SHA256SUMS)"
      NL=$'\n'
      while IFS= read -r -d '' f; do
          f="${f#./}"
          case "$f" in
              SHA256SUMS|SHA256SUMS.asc|SIGNING-KEY.asc) continue ;;
              verify_release.sh|verify_release.ps1) continue ;;
          esac
          # A newline in a name is unlisted by definition: grep -F would
          # split the pattern and match on the second line.
          if [ "${f#*"$NL"}" != "$f" ]; then
              printf '%s\n' "$(printf '%s' "$f" | tr '\n' '?')"
          elif ! printf '%s\n' "$listed" | grep -qxF -- "$f"; then
              printf '%s\n' "$f"
          fi
      done < <(find . -type f -print0 2>/dev/null) )
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

GENUINE=wam-coin-v0.1.15-x86_64-linux-gnu.tar.gz
printf 'the node\n' > "$work/$GENUINE"
( cd "$work" && sha256sum "$GENUINE" > SHA256SUMS )

if [ -n "$(unlisted_in "$work")" ]; then
    no "an honest release directory is reported as carrying unlisted files" \
       "a check that refuses a correct download is turned off within a week" \
       "found: $(unlisted_in "$work" | tr '\n' ' ')"
else
    ok "an honest release directory is accepted"
fi

res="$(cd "$work" && sha256sum --ignore-missing -c SHA256SUMS 2>/dev/null)"
if printf '%s' "$res" | grep -q ': FAILED$'; then
    no "the fixture is wrong: sha256sum reported a failure"
else
    ok "sha256sum -c says every listed file is OK, which is true"
fi

# Each shape on its own. Planting them together proves only that at least
# one was caught.
plant_and_check() {
    local label="$1" path="$2"
    mkdir -p "$(dirname "$work/$path")" 2>/dev/null
    if ! printf 'not ours\n' > "$work/$path" 2>/dev/null; then
        printf '  %s!!%s    %s could not be created on this filesystem\n' \
               $'\033[33m' "$OFF" "$label"
        return
    fi
    if [ -n "$(unlisted_in "$work")" ]; then
        ok "found: $label"
    else
        no "NOT found: $label" \
           "sha256sum -c walks the list, so it never opened this file," \
           "and the banner says the release is unmodified since it was signed"
    fi
    rm -f -- "$work/$path"
    rm -rf -- "$work/sub"
}

plant_and_check "an unsigned archive beside the genuine one" \
                "wam-qt-v0.1.15-x86_64-linux-gnu.tar.gz"
plant_and_check "a name no glob would match" "evil-setup.exe"
plant_and_check "a bare executable" "wamd"
plant_and_check "a dotfile" ".hidden.tar.gz"
plant_and_check "one in a subdirectory" "sub/$GENUINE"
plant_and_check "a name whose second line is a listed name" \
                "$(printf 'evil-payload.exe\n%s' "$GENUINE")"

# ---------------------------------------------------------------------------
# 2. And the script must not have drifted away from the model.
# ---------------------------------------------------------------------------
if grep -q 'find \. -type f -print0' "$SCRIPT"; then
    ok "$SCRIPT walks every file at any depth"
else
    no "$SCRIPT no longer walks with find -print0" \
       "the model above tests a predicate the script does not have"
fi

if grep -qE 'for f in wam-coin-\*|for f in .*wam-qt-\*' "$SCRIPT"; then
    no "$SCRIPT is back to globbing three prefixes in the top directory" \
       "a glob matches none of: another name, a bare executable, a dotfile," \
       "or anything in a subdirectory"
else
    ok "and not by globbing three prefixes"
fi

if grep -q '\${f#\*"\$NL"}' "$SCRIPT"; then
    ok "and it refuses a name carrying a newline before grep is asked"
else
    no "$SCRIPT has no newline rule" \
       "grep -F splits its pattern on newlines, so a two-line name whose" \
       "second line is a listed name reads as listed"
fi

if grep -q 'Get-ChildItem .*-Recurse -Force' scripts/verify_release.ps1; then
    ok "and verify_release.ps1 walks the same way, for the same reason"
else
    no "verify_release.ps1 does not walk recursively with -Force" \
       "the Windows verifier is the one a Windows downloader runs"
fi

printf '\n'
if [ "$failed" -eq 0 ]; then
    printf '%s%s  %s checks: the list is the release, and nothing else is%s\n' \
           "$GRN" "$BLD" "$pass" "$OFF"
    printf '  the end-to-end proof is scripts/test/stranger.sh\n\n'
    exit 0
fi
printf '%s%s  %s of %s checks failed%s\n\n' \
       "$RED" "$BLD" "$failed" "$((pass + failed))" "$OFF"
exit 1
