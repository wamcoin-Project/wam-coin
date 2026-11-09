#!/bin/bash
# ===========================================================================
#  version_watch.sh -- tell the operator, on their own screen, that their
#                      node will be rejected
# ===========================================================================
#
#      bash scripts/version_watch.sh            # check now
#      bash scripts/version_watch.sh --clear    # remove the notice
#
#  WHY THIS EXISTS
#
#  install.sh already refuses to build a checkout that is behind a release
#  which changed a consensus rule. That guard is correct and it fires exactly
#  once -- at install time -- and then never again.
#
#  So the person it cannot reach is precisely the person who needs it: the
#  one who installed in August, built a working node, and has not run
#  anything since. Their node keeps running. The protocol carries blocks, not
#  notices. Nothing anywhere tells them that on 15 September their node will
#  reject every valid block and fork off alone at height 1.
#
#  As of 2026-08-29 one independent operator is in exactly that position, on
#  v0.1.4, and there is no way to reach them. That is not their carelessness.
#  We shipped a warning that only speaks while somebody is listening, and
#  then stopped speaking.
#
#  WHERE THIS WRITES, AND WHY THERE
#
#  Not a log file: nobody reads a log that has nothing wrong in it. Not an
#  email: we do not have their address and would not want it. The one place
#  a node operator reliably looks is the screen they get when they ssh into
#  the machine, so the notice goes in /etc/update-motd.d/ and appears at
#  every login until the version is current, at which point it removes
#  itself.
#
#  It also writes to the journal, so `journalctl -u wam-version-watch` says
#  the same thing to anyone who goes looking.
#
#  A check that cannot be made says nothing at all. GitHub being unreachable
#  is not evidence that a node is out of date, and a warning that cries wolf
#  once is ignored afterwards.
# ===========================================================================

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOTD_DIR=/etc/update-motd.d
MOTD_FILE="$MOTD_DIR/98-wam-version"

clear_notice() {
    [ -f "$MOTD_FILE" ] && rm -f "$MOTD_FILE" && echo "notice removed: this node is current"
    return 0
}

if [ "${1:-}" = "--clear" ]; then
    clear_notice
    exit 0
fi

bash "$REPO/scripts/check_checkout_current.sh" --quiet >/dev/null 2>&1
RC=$?

# 0 is either "current" or "could not ask", and both mean say nothing.
if [ "$RC" = 0 ]; then
    clear_notice
    exit 0
fi

CUR="$(git -C "$REPO" describe --tags --abbrev=0 2>/dev/null || echo unknown)"

if [ "$RC" = 2 ]; then
    HEAD_LINE="YOUR NODE WILL BE REJECTED BY THE NETWORK"
    BODY="This checkout is behind a release that changed a consensus rule.
  On mainnet a node built from it rejects every valid block and forks
  off alone at height 1 -- it will look like it is running perfectly,
  with a chain nobody else has."
    echo "wam-version-watch: behind a consensus release ($CUR)" >&2
else
    HEAD_LINE="A newer WAM release exists"
    BODY="Nothing between your version and the newest one changed a
  consensus rule, so this node still follows the network. It is missing
  fixes."
    echo "wam-version-watch: behind the newest release ($CUR)" >&2
fi

# Minimal Debian and Ubuntu images ship without this directory even though
# pam_motd reads it, and the Germany host is one of them. The first version
# of this script found it missing, said so on stderr, and exited without
# writing anything -- correct behaviour, in the one place where being silent
# defeats the entire point. Create it: it is the documented location, it is
# empty and harmless if nothing reads it, and a notice nobody can see is the
# same as no notice.
if [ ! -d "$MOTD_DIR" ]; then
    if mkdir -p "$MOTD_DIR" 2>/dev/null; then
        echo "wam-version-watch: created $MOTD_DIR" >&2
    else
        echo "wam-version-watch: no $MOTD_DIR and cannot create it; the warning" >&2
        echo "  is in this journal only, where nobody will look for it:" >&2
        echo "  $HEAD_LINE ($CUR)" >&2
        exit "$RC"
    fi
fi

cat > "$MOTD_FILE" <<EOF
#!/bin/sh
# Written by scripts/version_watch.sh. It removes itself once the checkout
# is current -- do not delete it by hand to make the message go away.
cat <<'NOTICE'

  ================================================================
   $HEAD_LINE
  ================================================================

   Installed here: $CUR

  $BODY

   To fix it:

       cd $REPO && git pull && ./install.sh

  ================================================================

NOTICE
EOF
chmod 755 "$MOTD_FILE"
echo "wam-version-watch: notice written to $MOTD_FILE" >&2
exit "$RC"
