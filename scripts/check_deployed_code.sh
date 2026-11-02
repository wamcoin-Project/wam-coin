#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_deployed_code.sh -- is the running software this software?
# ===========================================================================
#
#      bash scripts/check_deployed_code.sh HOST [HOST...]
#
#  WHY THIS EXISTS
#
#  check_nodes_agree.sh compares the node binaries, because two nodes with
#  different consensus rules split a chain. It says nothing about everything
#  else that is deployed from this repository -- the pool, the announcement
#  bot, the dashboard, the explorer -- and those drift the same way and are
#  noticed even later, because nothing they do stops.
#
#  On 2026-08-20 the checkout on the pool server was seven commits behind. One
#  of those commits fixed a release announcement arriving on Telegram with its
#  code fences showing as literal backticks. The fix was written, committed,
#  pushed and correct; the bot went on posting the old way, because nobody had
#  pulled. There was no error anywhere -- the wrong version of working software
#  produces no symptom a machine can see.
#
#  This compares the deployed checkout against origin/main, which is what a
#  reader of the repository believes is running.
#
#  AND: A HOST IT CANNOT REACH IS NOT A HOST THAT PASSES.
#
#  Until 2026-09-14 an unreachable server printed "note no checkout found" in
#  yellow and the summary under it still said "every deployed checkout is
#  origin/main", exit 0. So did a reachable server whose checkout lives
#  somewhere not listed in PATHS. Both are the same mistake: reporting that
#  nothing is wrong when the truth is that nothing was looked at. The panel
#  which reads this script paints exit 2 amber -- "unknown" -- for precisely
#  this case, so this script now says 2 instead of lying green.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# Where a checkout is expected to live. Extra entries cost one ssh each and
# save the case where someone deploys somewhere new and forgets to say.
PATHS="/opt/wam /root/wam /root/wam-coin /opt/wam-coin"

[ $# -ge 1 ] || { printf 'usage: %s HOST [HOST...]\n' "${0##*/}" >&2; exit 2; }

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
FAIL=0       # a checkout was read and it is not this code  -> exit 1
UNKNOWN=0    # a checkout was never read at all             -> exit 2
READ=0       # checkouts actually compared, so the summary can count them

git fetch origin --quiet 2>/dev/null || true
WANT="$(git rev-parse origin/main 2>/dev/null || git rev-parse HEAD)"
WANT_SHORT="${WANT:0:12}"

echo "=================================================================="
echo " Is the deployed code this code?"
echo "=================================================================="
printf '\n  origin/main  %s  %s\n\n' "$WANT_SHORT" "$(git log -1 --format=%s "$WANT" 2>/dev/null | cut -c1-52)"

. "$HERE/scripts/lib/remote.sh"

# ONE CONNECTION PER HOST, NOT NINE.
#
# It was: one to see whether the host answers (twice on a blip), four to
# probe the candidate paths, and one more per path that existed to read its
# working tree -- up to nine per machine, twenty-seven across three. On the
# founder's link each one costs five to fifteen seconds of handshake before
# any work starts, which is why this check needed its panel budget raised
# from 150 to 300 seconds in September and would have needed it raised
# again.
#
# The liveness probe went with them, and nothing was lost: a host that does
# not answer this reply is a host that does not answer, which is the same
# fact the `true` call was buying a whole connection to learn. The retry it
# wanted lives in lib/remote.sh and applies to every call rather than to one.
probe() {
    cat <<PROBE
for p in $PATHS; do
    [ -d "\$p/.git" ] || continue
    H=\$(git -C "\$p" rev-parse HEAD 2>/dev/null)
    [ -n "\$H" ] || continue
    echo "HEAD \$p \$H"
    git -C "\$p" status --porcelain 2>/dev/null | grep -v '^??' | head -5 \
        | sed "s|^|DIRTY \$p |"
done
PROBE
}

# 60 rather than 45: the reply runs a rev-parse and a status in up to four
# checkouts, and a status on a large working tree is not instant.
REMOTE_TIMEOUT=60

for h in "$@"; do
    printf '%s%s%s\n' "$BLD" "$h" "$OFF"

    remote_ask "$h" "$(probe)"
    if [ "$REMOTE_RC" = "$REMOTE_UNREACHABLE" ]; then
        printf '  %s??%s      unreachable over ssh -- the deployed code was not read,\n' "$YLW" "$OFF"
        printf '          so this is neither a pass nor a failure. It is unknown.\n'
        UNKNOWN=$((UNKNOWN + 1))
        continue
    fi
    REPLY_TEXT="$REMOTE_OUT"

    FOUND=0
    while read -r p HEAD; do
        [ -n "${HEAD:-}" ] || continue
        FOUND=1
        READ=$((READ + 1))
        if [ "$HEAD" = "$WANT" ]; then
            printf '  %sok%s      %-18s %s\n' "$GRN" "$OFF" "$p" "${HEAD:0:12}"
        else
            BEHIND="$(git rev-list --count "$HEAD..$WANT" 2>/dev/null || echo '?')"
            AHEAD="$(git rev-list --count "$WANT..$HEAD" 2>/dev/null || echo '?')"
            printf '  %sFAIL%s    %-18s %s -- %s behind, %s ahead\n' \
                "$RED" "$OFF" "$p" "${HEAD:0:12}" "$BEHIND" "$AHEAD"
            if [ "$BEHIND" != "?" ] && [ "$BEHIND" != "0" ]; then
                git log --oneline "$HEAD..$WANT" 2>/dev/null | head -5 | sed 's/^/            missing: /'
            fi
            FAIL=$((FAIL + 1))
        fi

        DIRTY="$(printf '%s\n' "$REPLY_TEXT" | sed -n "s|^DIRTY $p ||p")"
        if [ -n "$DIRTY" ]; then
            printf '  %swarn%s    %s has uncommitted edits:\n' "$YLW" "$OFF" "$p"
            printf '%s\n' "$DIRTY" | sed 's/^/            /'
        fi
    done < <(printf '%s\n' "$REPLY_TEXT" | sed -n 's/^HEAD //p')
    if [ "$FOUND" != 1 ]; then
        # The host answered, so this is not the network: either the checkout
        # lives somewhere not listed in PATHS, or there is none. Either way
        # nothing was compared, so nothing here may be called ok.
        printf '  %s??%s      no checkout found in: %s\n' "$YLW" "$OFF" "$PATHS"
        printf '          the host answered, so add its real path to PATHS above.\n'
        UNKNOWN=$((UNKNOWN + 1))
    fi
done

echo
echo "=================================================================="
if [ "$FAIL" -ne 0 ]; then
    printf ' %s%d checkout(s) are not running this code%s\n' "$RED" "$FAIL" "$OFF"
elif [ "$UNKNOWN" -ne 0 ]; then
    # Do not say anything about "the others" unless there were others: with
    # every host unreachable the honest summary is that nothing was measured.
    if [ "$READ" -gt 0 ]; then
        printf ' %s%d host(s) not read; the %d checkout(s) read are origin/main%s\n' \
            "$YLW" "$UNKNOWN" "$READ" "$OFF"
    else
        printf ' %sno checkout was read at all -- this is not a pass%s\n' "$YLW" "$OFF"
    fi
else
    printf ' %severy deployed checkout is origin/main%s\n' "$GRN" "$OFF"
fi
echo "=================================================================="

# A real difference outranks an unread host: 1 is louder than 2.
if [ "$FAIL" -ne 0 ]; then exit 1; fi
if [ "$UNKNOWN" -ne 0 ]; then exit 2; fi
exit 0
