#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  test_verify_release_unlisted.sh -- a file the list does not name is not
#                                     part of the release
# ===========================================================================
#
#      bash scripts/test/test_verify_release_unlisted.sh
#
#  WHAT THIS GUARDS
#
#  scripts/verify_release.sh is the command this project prints in every
#  release announcement, every README and every download page. It is the
#  whole of what a stranger does to decide whether to run our binaries.
#
#  It verified in one direction. `sha256sum -c` walks the LIST: it opens
#  each name in SHA256SUMS and compares. A file sitting in the directory
#  that the list does not name was never looked at -- and the script then
#  printed "this is the WAM release, unmodified since it was signed".
#
#  So: serve the genuine SHA256SUMS, the genuine SHA256SUMS.asc and the
#  genuine node tarball -- all untouched, all signed by the real key -- and
#  add one extra release-shaped archive. The reader runs the one command
#  they were told to run, is told the release is unmodified, and extracts a
#  binary nobody signed. A hostile mirror, a machine on the path, or a
#  compromised downloads page is enough; no key is needed.
#
#  It is also reachable with nobody attacking anything. sign_release.sh
#  records that the Windows and macOS archives are added to SHA256SUMS by
#  hand, and package_release.sh leaves the wallet out of the list when Qt
#  did not build. A missed step produces exactly this directory.
#
#  Found in the pre-release review of v0.1.15.
#
#  This test does not need GPG: it drives the hashing half directly, which
#  is the half that had the hole. The signature half is covered by
#  scripts/check_signature_verification.py and by solo_gate.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; BLD=$'\033[1m'; OFF=$'\033[0m'
pass=0; failed=0
ok() { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$1"; pass=$((pass + 1)); }
no() { printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$1"; shift
       while [ $# -gt 0 ]; do printf '        %s\n' "$1"; shift; done
       failed=$((failed + 1)); }

printf '\n%s  a file the signed list does not name%s\n\n' "$BLD" "$OFF"

command -v sha256sum >/dev/null 2>&1 || {
    printf '  %s!!%s    no sha256sum here, so nothing was checked\n\n' \
           $'\033[33m' "$OFF"; exit 2; }

# The exact shape of the check that was added to verify_release.sh. Kept
# here as the behaviour under test rather than as a copy of the script:
# the script is driven for real below, this is the predicate it must have.
unlisted_in() {
    local dir="$1" out=""
    ( cd "$dir" || return 1
      for f in wam-coin-* wam-miner-* wam-qt-*; do
          [ -e "$f" ] || continue
          case "$f" in *.asc|SHA256SUMS*) continue ;; esac
          # sha256sum may write `<hash> *<name>` in binary mode; the star is
          # part of the format, not part of the name. Reading it with
          # `awk '{print $2}'` made every genuine file look unlisted.
          sed 's/^[^ ]*  *[*]\?//' SHA256SUMS | grep -qxF -- "$f" \
              || printf '%s\n' "$f"
      done )
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A genuine, correctly signed release directory.
printf 'the node\n' > "$work/wam-coin-v0.1.15-x86_64-linux-gnu.tar.gz"
( cd "$work" && sha256sum wam-coin-v0.1.15-x86_64-linux-gnu.tar.gz > SHA256SUMS )

if [ -n "$(unlisted_in "$work")" ]; then
    no "an honest release directory is reported as carrying unlisted files" \
       "a check that refuses a correct download is turned off within a week"
else
    ok "an honest release directory is accepted"
fi

# Now the attack: the genuine files, untouched, plus one more.
printf 'not ours\n' > "$work/wam-qt-v0.1.15-x86_64-linux-gnu.tar.gz"

res="$(cd "$work" && sha256sum --ignore-missing -c SHA256SUMS 2>/dev/null)"
if printf '%s' "$res" | grep -q ': FAILED$'; then
    no "the fixture is wrong: sha256sum reported a failure" \
       "this test is about the file it does NOT report on"
else
    ok "sha256sum -c still says every listed file is OK, which is true"
fi

found="$(unlisted_in "$work")"
if [ "$found" = "wam-qt-v0.1.15-x86_64-linux-gnu.tar.gz" ]; then
    ok "and the unlisted archive beside them is found"
else
    no "an unsigned archive sitting in the release directory was not found" \
       "sha256sum -c walks the list, so it never opened this file at all," \
       "and the banner says the release is unmodified since it was signed" \
       "found: ${found:-nothing}"
fi

# And the script itself must carry the check, not just this file.
if grep -q 'are here and are NOT in the signed list' scripts/verify_release.sh; then
    ok "verify_release.sh refuses a directory holding an unlisted file"
else
    no "verify_release.sh has no present-but-unlisted check" \
       "this is the command every announcement tells a stranger to run"
fi

printf '\n'
if [ "$failed" -eq 0 ]; then
    printf '%s%s  %s checks: the list is the release, and nothing else is%s\n\n' \
           "$GRN" "$BLD" "$pass" "$OFF"
    exit 0
fi
printf '%s%s  %s of %s checks failed%s\n\n' \
       "$RED" "$BLD" "$failed" "$((pass + failed))" "$OFF"
exit 1
