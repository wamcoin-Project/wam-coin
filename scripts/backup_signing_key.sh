#!/bin/bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  backup_signing_key.sh -- a second copy of the release signing key, proved
# ===========================================================================
#
#      bash scripts/backup_signing_key.sh /d /e
#                                          ^  ^
#                                          |  the second disk
#                                          the USB that holds it now
#
#  Git Bash, not PowerShell. PowerShell has no gpg on PATH; the one that works
#  is C:\Program Files\Git\usr\bin\gpg.exe, which is what Git Bash runs.
#
#  WHY THIS IS A SCRIPT AND NOT THREE cp COMMANDS
#
#  Everything this project publishes is trusted because of one key. There is
#  one copy of it, on one USB stick, and a USB stick is a consumer flash chip
#  in a plastic shell. If it dies the day after launch, every future release
#  is unsignable, the fingerprint in SECURITY.md becomes a promise nothing can
#  keep, and the only honest recovery is to publish a new key and ask several
#  thousand strangers to believe that the people asking them to trust a new
#  fingerprint are the same people as before. There is no good version of that
#  conversation.
#
#  And a copy is worth what it can be proved to do. `cp` produces a file. What
#  matters is whether GnuPG can still read it and whether it can still sign,
#  and those are different questions with different failure modes: a truncated
#  copy imports and cannot sign; a copy whose passphrase has been misremembered
#  imports, is the right key by fingerprint, and is useless. pull_backups.sh
#  already carries this lesson in its own header -- "a second copy of a file on
#  a disk that is about to fail" -- and the Germany rehearsal on 11 September
#  made the general version of it plain: a safeguard nobody has watched work is
#  a safeguard nobody can vouch for.
#
#  So this copies, compares byte for byte, imports the COPY into a throwaway
#  keyring, checks it against the fingerprint published in SECURITY.md, and
#  then asks it to sign something. The signature is verified against the public
#  SIGNING-KEY.asc from this repository -- which is what a stranger verifying a
#  release actually uses -- so a pass here means the copy can do the job the
#  original does, and not merely that a file arrived.
#
#  WHAT IT WILL NOT DO
#
#  It never writes the secret key, or a keyring holding it, to the internal
#  disk. The throwaway GNUPGHOME is created on the destination disk and
#  destroyed on exit, the same way sign_release.sh puts its keyring on the USB.
#  A secret key that has touched C:\ has touched the disk that leaves the house
#  inside the laptop and the disk that a backup agent, a sync client or a
#  malware scanner uploads.
#
#  It never asks for, prints, stores or logs the passphrase. GnuPG prompts for
#  it directly, once, when the test signature is made.
#
#  It refuses to write to the system drive at all, for the same reason.
# ===========================================================================

set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$*"; }
bad()  { printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$*"; }
warn() { printf '  %s!!%s    %s\n' "$YLW" "$OFF" "$*"; }
say()  { printf '        %s\n' "$*"; }

# The fingerprint published in SECURITY.md and nowhere else. Written out here
# rather than read from the file, so that editing the file cannot make this
# check agree with the edit.
EXPECT="4BD4A8D3AFD43F5CBCB500E23798462FE00ADBA4"

SRC="${1:-}"
DST="${2:-}"

if [ -z "$SRC" ] || [ -z "$DST" ]; then
    printf 'usage: %s SOURCE DEST\n\n' "${0##*/}" >&2
    printf '  SOURCE  the drive that holds the key now, e.g. /d\n' >&2
    printf '  DEST    the drive to put the second copy on, e.g. /e\n\n' >&2
    exit 2
fi

echo
echo "=================================================================="
echo " ${BLD}a second copy of the signing key${OFF}"
echo "=================================================================="
echo

# ---- 1. is gpg the one that works here? ----------------------------------
if ! command -v gpg >/dev/null 2>&1; then
    bad "gpg is not on PATH"
    say "Run this from Git Bash, not PowerShell. PowerShell has no gpg;"
    say "Git Bash runs C:\\Program Files\\Git\\usr\\bin\\gpg.exe."
    echo; exit 2
fi
ok "gpg           $(gpg --version 2>/dev/null | head -1)"

# ---- 2. the two drives, and what must not be one of them -----------------
SRC="${SRC%/}"; DST="${DST%/}"

# A second copy on the internal disk is not a second copy: it dies with the
# machine, and it puts the secret on the one disk that is backed up, synced and
# scanned by things nobody chose.
case "$DST" in
    /c|/c/*|/C|/C/*|c:*|C:*)
        bad "$DST is the system drive"
        say "A second copy has to survive this computer, and the secret key"
        say "must not be written to the disk that leaves the house inside it."
        say "Plug in the external disk and give its letter."
        echo; exit 1 ;;
esac

[ -d "$SRC" ] || { bad "$SRC is not there -- is the USB plugged in?"; echo; exit 1; }
[ -d "$DST" ] || { bad "$DST is not there -- is the disk plugged in?"; echo; exit 1; }

if [ "$(cd "$SRC" && pwd -P)" = "$(cd "$DST" && pwd -P)" ]; then
    bad "the source and the destination are the same drive"
    say "Two copies on one stick both die with the stick."
    echo; exit 1
fi
ok "source        $SRC"
ok "destination   $DST"

# ---- 3. what has to be copied --------------------------------------------
#
# The secret key and the revocation certificate. The revocation certificate is
# not an afterthought: it is the only way to tell the world this key is no
# longer to be trusted, and it is useless on a stick that has been lost or
# stolen along with the key it revokes.
SECRET="wam-secret-BACKUP.asc"
REVOKE="wam-revoke.asc"

[ -f "$SRC/$SECRET" ] || { bad "$SRC/$SECRET is not there"; echo; exit 1; }
ok "$SECRET  $(stat -c%s "$SRC/$SECRET" 2>/dev/null || echo '?') bytes"

HAVE_REVOKE=0
if [ -f "$SRC/$REVOKE" ]; then
    HAVE_REVOKE=1
    ok "$REVOKE        $(stat -c%s "$SRC/$REVOKE" 2>/dev/null || echo '?') bytes"
else
    warn "$SRC/$REVOKE is not there, so it cannot be copied."
    warn "Without it there is no way to announce that this key is dead."
fi

# ---- 4. copy ---------------------------------------------------------------
echo
echo "${BLD}copying${OFF}"

OUTDIR="$DST/wam-signing-key"
if [ -d "$OUTDIR" ]; then
    warn "$OUTDIR already exists -- its files will be replaced"
fi
mkdir -p "$OUTDIR" || { bad "cannot write to $OUTDIR"; echo; exit 1; }

cp -f "$SRC/$SECRET" "$OUTDIR/$SECRET" || { bad "the copy failed"; echo; exit 1; }
[ "$HAVE_REVOKE" = "1" ] && cp -f "$SRC/$REVOKE" "$OUTDIR/$REVOKE"

# The public key too. Verifying anything on a machine with no network needs it,
# and it is public -- there is no cost to having it beside the secret.
[ -f "$ROOT/SIGNING-KEY.asc" ] && cp -f "$ROOT/SIGNING-KEY.asc" "$OUTDIR/"
ok "copied to     $OUTDIR"

# ---- 5. byte for byte ------------------------------------------------------
for f in "$SECRET" $([ "$HAVE_REVOKE" = "1" ] && echo "$REVOKE"); do
    a="$(sha256sum < "$SRC/$f" | cut -d' ' -f1)"
    b="$(sha256sum < "$OUTDIR/$f" | cut -d' ' -f1)"
    if [ "$a" != "$b" ]; then
        bad "$f does not match after copying"
        say "  source : $a"
        say "  copy   : $b"
        say ""
        say "Do not rely on this disk. Try another one."
        echo; exit 1
    fi
    ok "$(printf '%-24s identical, %s' "$f" "${a:0:16}...")"
done

# ---- 6. can GnuPG read the COPY? ------------------------------------------
#
# The copy, not the original. Checking the original would prove nothing about
# the thing being made here, which is the mistake that makes backup
# verification theatre.
echo
echo "${BLD}what the copy can actually do${OFF}"

VHOME="$DST/.wam-keycheck-$$"
cleanup() {
    GNUPGHOME="$VHOME" gpgconf --kill all >/dev/null 2>&1
    rm -rf "$VHOME" "$TESTFILE" "$TESTFILE.asc" 2>/dev/null
}
TESTFILE="$DST/.wam-keycheck-test-$$"
trap cleanup EXIT INT TERM

mkdir -p "$VHOME" && chmod 700 "$VHOME" 2>/dev/null
export GNUPGHOME="$VHOME"

if ! gpg --batch --quiet --import "$OUTDIR/$SECRET" 2>/dev/null; then
    bad "GnuPG would not import the copy"
    say "The file arrived and is not a key GnuPG can read. The stick this"
    say "came from may be failing -- check the original on another machine"
    say "before doing anything else with it."
    echo; exit 1
fi
ok "it imports"

FPR="$(gpg --batch --with-colons --list-secret-keys 2>/dev/null \
       | awk -F: '/^fpr:/ {print $10; exit}')"
if [ "$FPR" != "$EXPECT" ]; then
    bad "this is not the key the project publishes"
    say "  copy      : ${FPR:-nothing}"
    say "  SECURITY.md: $EXPECT"
    echo; exit 1
fi
ok "it is $EXPECT"

# ---- 7. and can it sign? --------------------------------------------------
#
# This is the whole point, and it is the only step that needs the passphrase.
# GnuPG asks for it; this script never sees it, stores it or writes it
# anywhere. A key that imports and cannot sign is the failure that a file
# comparison cannot see.
echo
say "GnuPG will now ask for the passphrase, to prove this copy can sign."
say "It is typed into GnuPG, not into this script. Nothing here records it."
echo

date -u > "$TESTFILE"
if ! gpg --batch --yes --detach-sign --armor \
        --local-user "$EXPECT" \
        --output "$TESTFILE.asc" "$TESTFILE" 2>/dev/null; then
    # --batch means a wrong or absent passphrase fails rather than hanging on
    # a prompt nobody is watching. Retried without it so the prompt appears.
    if ! gpg --yes --detach-sign --armor \
            --local-user "$EXPECT" \
            --output "$TESTFILE.asc" "$TESTFILE"; then
        bad "the copy would not sign"
        say "Either the passphrase was wrong, or this copy is damaged in a"
        say "way that importing did not reveal. The original on $SRC is"
        say "untouched -- try this again, and if it fails again, try the"
        say "original with sign_channels.sh before trusting either."
        echo; exit 1
    fi
fi
ok "it signed"

# Verified against the PUBLIC key from the repository, in a second throwaway
# keyring -- which is what a stranger checking a release actually does. A
# signature verified by the same keyring that made it proves much less.
WHOME="$DST/.wam-keycheck-pub-$$"
mkdir -p "$WHOME" && chmod 700 "$WHOME" 2>/dev/null
if [ -f "$ROOT/SIGNING-KEY.asc" ] \
   && gpg --homedir "$WHOME" --batch --quiet --import "$ROOT/SIGNING-KEY.asc" 2>/dev/null \
   && gpg --homedir "$WHOME" --batch --verify "$TESTFILE.asc" "$TESTFILE" 2>/dev/null; then
    ok "and the public SIGNING-KEY.asc accepts that signature"
else
    warn "could not check the signature against SIGNING-KEY.asc"
    warn "The signing itself worked, which is the important half."
fi
GNUPGHOME="$WHOME" gpgconf --kill all >/dev/null 2>&1
rm -rf "$WHOME" 2>/dev/null

# ---- 8. leave something a stranger could follow in two years -------------
cat > "$OUTDIR/READ-ME-FIRST.txt" <<TXT
WAM Coin -- release signing key, second copy
Made $(date -u '+%Y-%m-%d %H:%M UTC') by scripts/backup_signing_key.sh

WHAT THESE FILES ARE

  $SECRET
      The private key that signs every WAM Coin release and the signed
      channel list. It is encrypted with a passphrase that is NOT written
      down anywhere on this disk, and must not be.

  $REVOKE
      The revocation certificate. Publishing it tells the world that the
      key above must no longer be trusted. Use it if the key is lost,
      copied by somebody else, or if you believe either may have happened.
      It cannot be regenerated without the key.

  SIGNING-KEY.asc
      The PUBLIC half. Not secret. Here so that a release can be verified
      on a machine with no internet.

THE FINGERPRINT, which is the only thing that identifies the real key:

  4BD4 A8D3 AFD4 3F5C BCB5  00E2 3798 462F E00A DBA4

It is published in SECURITY.md at
https://github.com/wamcoin-Project/wam-coin -- and nowhere else. Anything
claiming a different fingerprint for WAM Coin is not WAM Coin.

THE ONE RULE

  This disk does not go into a computer that is connected to the internet,
  except for the moment a release is being signed, and not at all if that
  can be avoided. A secret key is only secret while the number of places
  it has been is small enough to count.

IF YOU ARE READING THIS BECAUSE THE OTHER COPY DIED

  Plug this disk in, and use it exactly as the USB was used:

      bash scripts/sign_release.sh <directory of downloads> <this drive>

  sign_release.sh expects $SECRET at the root of the drive it is
  given, so copy it up one level first, or pass this folder as the drive.
  Then make a third copy before doing anything else, with
  scripts/backup_signing_key.sh -- you are now back to one.
TXT
ok "READ-ME-FIRST.txt written"

echo
echo "=================================================================="
printf ' %s%sthere are now two copies, and this one has been proved%s\n' "$GRN" "$BLD" "$OFF"
echo "=================================================================="
echo
say "Unplug this disk and keep it somewhere the USB is not. Two copies in"
say "one drawer are one fire, one theft and one flood away from none."
echo
