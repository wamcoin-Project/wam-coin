#!/bin/bash
# ===========================================================================
#  verify_release.sh -- one command, for someone who has no reason to trust us
# ===========================================================================
#
#      bash scripts/verify_release.sh                  # files in this directory
#      bash scripts/verify_release.sh ~/Downloads
#
#  WHY THIS EXISTS
#
#  Until 3 September 2026 the releases carried SHA256SUMS and nothing else.
#  A checksum file hosted beside the file it describes proves only that both
#  came from the same place: whoever can replace the binary can replace the
#  list, and the two will agree perfectly. It protects against a corrupted
#  download. It does not protect against anybody.
#
#  A signature is what cannot be produced without the key, and the key is not
#  on any machine this project exposes to the internet.
#
#  WHY IT IS A SCRIPT AND NOT THREE LINES IN A README
#
#  The three commands are easy to run and easy to run wrongly. `gpg --verify`
#  exits 0 on a good signature made by a key you have never seen; it also
#  prints a WARNING that reads alarming and is normal. `sha256sum -c` on a
#  file list that does not mention your download prints nothing and exits 0.
#  Someone checking a download for the first time should not have to know
#  either of those.
#
#  This refuses to print ok unless all three hold: the signature is good, it
#  was made by the fingerprint published in SECURITY.md, and the file in front
#  of you is the file that fingerprint signed for.
# ===========================================================================

set -uo pipefail

# The one in SECURITY.md, and nowhere else. Written here without spaces so it
# can be compared; printed with them so it can be read.
EXPECT="4BD4A8D3AFD43F5CBCB500E23798462FE00ADBA4"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

# Where this script itself lives, resolved to an absolute path BEFORE the cd
# below. The order is the whole point.
#
# $0 is whatever the caller typed, and the caller is not standing in the repo:
# the command published in the announcement is
#
#     git clone https://github.com/wamcoin-Project/wam-coin
#     bash wam-coin/scripts/verify_release.sh ~/Downloads
#
# so $0 is the relative path `wam-coin/scripts/verify_release.sh`. Resolving it
# after `cd "$DIR"` resolves it against ~/Downloads, where no such path exists,
# so SIGNING-KEY.asc beside it is never found, the fallback to the reader's own
# keyring is taken, and a reader who has imported nothing is told
#
#     FAIL  the signature over SHA256SUMS is NOT valid
#
# about a release that is perfectly good. That is the worst failure this script
# has: it accuses an honest release, at the exact moment someone is deciding
# whether to trust us, and it does it to every first-time reader.
#
# It was invisible because it only happens when the caller is OUTSIDE the repo.
# Every test run was `bash scripts/verify_release.sh <dir>` from the repo root,
# where dirname $0 is `scripts` and the fallback path happens to resolve. Found
# on 4 September 2026 by running the published command as a stranger would, on
# a clean directory, with an empty keyring.
SELF_DIR="$(cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)"

DIR="${1:-.}"
cd "$DIR" 2>/dev/null || { echo "no such directory: $DIR" >&2; exit 2; }

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$1"; }
bad()  { printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$1"; }

echo
echo "${BLD}is this really the WAM release?${OFF}"
echo "  looking in: $(pwd)"
echo

command -v gpg >/dev/null 2>&1 || {
    bad "gpg is not installed. On Debian or Ubuntu: sudo apt install gnupg"
    echo; exit 2; }

# "Download it from the release page" is true, and it is not help.
#
# On 6 September 2026 an outside tester followed the two commands this project
# publishes -- clone, then verify -- and got exactly that line. He had done
# nothing wrong. The instruction never told him to fetch the release first,
# because whoever wrote it already had the files sitting in front of him. So a
# stranger was sent to a page to work out which of four files to take, at the
# moment he was still deciding whether this software could be trusted.
#
# The message carries the commands now. The version is read from the checkout
# he has just cloned, so they are commands and not a template.
if [ ! -f SHA256SUMS ]; then
    bad "SHA256SUMS is not in $(pwd) -- nothing has been downloaded yet"
    V="$(sed -n 's/^WAM_CLIENT_VERSION *= *"\([0-9.]*\)".*/\1/p' \
         "${SELF_DIR:-.}/patch_upstream.py" 2>/dev/null | head -1)"
    B="https://github.com/wamcoin-Project/wam-coin/releases"
    say ""
    say "Fetch the release into this directory first:"
    say ""
    if [ -n "$V" ]; then
        say "    cd $(pwd)"
        say "    curl -LO $B/download/v$V/SHA256SUMS"
        say "    curl -LO $B/download/v$V/SHA256SUMS.asc"
        say "    curl -LO $B/download/v$V/wam-coin-v$V-x86_64-linux-gnu.tar.gz"
    else
        say "    $B"
        say ""
        say "Take SHA256SUMS, SHA256SUMS.asc and the package you want."
    fi
    say ""
    say "Then run this again. SHA256SUMS.asc is the one that matters: it is the"
    say "signature, and without it nothing here can be proved."
    echo; exit 2
fi
[ -f SHA256SUMS.asc ] || {
    bad "SHA256SUMS.asc is not here -- that file IS the proof."
    say "A release without it cannot be checked. Do not run the binaries."
    echo; exit 1; }

# ---- 1. is the signature good, and whose is it? ---------------------------
#
# Verified in a throwaway keyring, not in yours.
#
# The first version ran `gpg --verify` against the caller's own keyring, which
# meant it failed for everybody who had not already imported the key -- that
# is, everybody running it for the first time, which is the entire audience.
# It printed "the signature is NOT valid" about a perfectly good release.
#
# Importing SIGNING-KEY.asc and verifying against THAT is not circular,
# because the key file is not the trust anchor: the fingerprint below is, and
# it is compared explicitly. A substituted key file changes the fingerprint,
# and the comparison is what catches it. Meanwhile nothing is added to the
# reader's keyring, which is not ours to modify.
KEYFILE=""
for c in SIGNING-KEY.asc \
         "${SELF_DIR:-.}/../SIGNING-KEY.asc" \
         "${SELF_DIR:-.}/SIGNING-KEY.asc"; do
    [ -f "$c" ] && { KEYFILE="$c"; break; }
done

TMPGPG="$(mktemp -d)"
trap 'rm -rf "$TMPGPG"' EXIT
chmod 700 "$TMPGPG"

if [ -n "$KEYFILE" ]; then
    gpg --homedir "$TMPGPG" --batch --quiet --import "$KEYFILE" 2>/dev/null
    G=(gpg --homedir "$TMPGPG")
else
    # No key file beside the download. Fall back to the reader's keyring, and
    # say so, because then they must have imported it themselves.
    say "SIGNING-KEY.asc is not here; using the key already in your keyring"
    G=(gpg)
fi

out="$("${G[@]}" --status-fd 1 --verify SHA256SUMS.asc SHA256SUMS 2>/dev/null)"
if ! printf '%s' "$out" | grep -q "GOODSIG"; then
    bad "the signature over SHA256SUMS is NOT valid"
    if [ -n "$KEYFILE" ]; then
        say "SHA256SUMS was changed after it was signed, or the signature is not ours."
        say "Do not run the binaries."
    else
        say "Either the file was changed after signing, or you have not imported"
        say "the key:    gpg --import SIGNING-KEY.asc"
    fi
    echo; exit 1
fi

got="$(printf '%s' "$out" | grep -m1 "VALIDSIG" | awk '{print $3}')"
if [ "$got" != "$EXPECT" ]; then
    bad "signed by a key this project does not publish"
    say "  signed by : ${got:-unknown}"
    say "  expected  : $EXPECT"
    say ""
    say "This is what a substituted release looks like. Do not run the binaries."
    echo; exit 1
fi
ok "signed by the key published in SECURITY.md"

# ---- 2. do the files in front of you match what was signed? ---------------
#
# --ignore-missing so a person who downloaded only the node package is not
# told the miner package is missing. But it also means a directory with none
# of the files passes silently, so count what was actually checked.
res="$(sha256sum --ignore-missing -c SHA256SUMS 2>/dev/null)"
checked="$(printf '%s' "$res" | grep -c ': OK$' || true)"
failed="$(printf '%s' "$res" | grep -c ': FAILED$' || true)"

if [ "${failed:-0}" -gt 0 ]; then
    bad "$failed file(s) do not match what was signed"
    printf '%s\n' "$res" | grep ': FAILED$' | sed 's/^/       /'
    echo; exit 1
fi
if [ "${checked:-0}" -eq 0 ]; then
    bad "the signature is good, but none of the signed files are here"
    say "SHA256SUMS lists:"
    awk '{print "       " $2}' SHA256SUMS
    say "Nothing was verified. Download the file you want into this directory."
    echo; exit 1
fi
ok "$checked file(s) match the signed list, byte for byte"

# AND THE OTHER DIRECTION, WHICH NOTHING CHECKED.
#
# `sha256sum -c` walks the LIST. A file sitting in this directory that
# SHA256SUMS does not name is never looked at -- and the banner below said
# "this is the WAM release, unmodified since it was signed" anyway.
#
# That is the whole verification for everyone who runs the command this
# project prints in every announcement. Anyone who can serve HTTP to a
# downloader -- a hostile mirror, a machine on the path, a compromised
# downloads page -- serves the genuine SHA256SUMS, the genuine signature and
# the genuine node tarball, all untouched, PLUS one extra release-shaped
# archive. The reader runs this, is told the release is unmodified, and
# extracts a binary nobody signed.
#
# It is reachable with no attacker at all: sign_release.sh records that the
# Windows and macOS archives have to be added to SHA256SUMS by hand, and
# package_release.sh deliberately leaves the wallet out of the list when Qt
# did not build. A missed step produces exactly this directory.
#
# Found in the pre-release review of v0.1.15.
unlisted=""
for f in wam-coin-* wam-miner-* wam-qt-*; do
    [ -e "$f" ] || continue
    case "$f" in *.asc|SHA256SUMS*) continue ;; esac
    # `sed`, not `awk '{print $2}'`. sha256sum writes the name in BINARY
    # mode on some platforms -- `<hash> *<name>` -- and the star made every
    # genuine file read as unlisted, which would have refused every honest
    # download. Caught by scripts/test/test_verify_release_unlisted.sh
    # before it shipped.
    if ! sed 's/^[^ ]*  *[*]\?//' SHA256SUMS | grep -qxF -- "$f"; then
        unlisted="$unlisted $f"
    fi
done
if [ -n "$unlisted" ]; then
    bad "these file(s) are here and are NOT in the signed list:"
    for f in $unlisted; do printf '       %s\n' "$f"; done
    say "SHA256SUMS.asc signs SHA256SUMS and nothing else. A file the list"
    say "does not name is covered by nothing, whoever gave it to you."
    echo; exit 1
fi

echo
echo "  ${GRN}${BLD}this is the WAM release, unmodified since it was signed${OFF}"
echo
echo "  What that does and does not tell you:"
echo "    it does    -- these bytes are the bytes the holder of that key signed"
echo "    it does not -- say the key belongs to anyone you should trust."
echo "                   Check the fingerprint at wamcoin.org/security/, over"
echo "                   HTTPS. Do not take it from an email or a forum post."
echo
