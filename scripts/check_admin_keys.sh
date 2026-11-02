#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_admin_keys.sh -- who can become root on each machine?
# ===========================================================================
#
#      bash scripts/check_admin_keys.sh HOST [HOST...]
#
#  WHY THIS EXISTS
#
#  On 18 September 2026 two entries on the operations panel had been yellow
#  for days:
#
#      nodes agree                    unknown   13.140.33.187 could not be read
#      deployed code is origin/main   unknown   13.140.33.187 could not be read
#
#  The host was healthy and answered by hand in three seconds. The cause was
#  one line out of `ssh -v`: the panel spawned its shell checks through the
#  `bash` on the Windows PATH, which is the WSL launcher, and WSL is a
#  separate machine with its own ~/.ssh. It offered
#  wam.coin.official@proton.me. France and Singapore authorise that key.
#  US-east, added on 16 September, does not.
#
#  Nothing could have found that by looking at the host, and nothing in this
#  repository knew which machine trusted which key. On a network that holds
#  money, the question "who can become root here" had no instrument.
#
#  IT COMPARES ONLY THE KEYS THAT GET A SHELL
#
#  The first version of this file compared the whole of authorized_keys and
#  took the commonest set as the baseline. With three hosts holding three
#  different sets there is no commonest set, so it picked the first and
#  reported Singapore as wrong for holding report@france -- a key Singapore
#  is SUPPOSED to hold, because the daily report reads its facts through it.
#  A check that calls a correct configuration a failure is worse than none.
#
#  A key pinned to a forced command cannot become root: it runs one program
#  and exits, so it belongs to its job and lives on exactly the hosts that
#  job touches. Those are listed with the command they are pinned to, and
#  never compared. What is compared is the keys that get a shell.
#
#  WHAT IT DOES NOT DO
#
#  It does not add, remove or copy a key, and it never will: this file reads.
#  Fingerprints and comments only -- no key material is printed, because a
#  check's output ends up in a terminal, a screenshot and a log.
#
#  EXIT CODES, this project's convention
#
#      0  every host gives a shell to the same keys
#      1  they do not agree on who can become root
#      2  fewer than two hosts could be read, so nothing was compared
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

if [ $# -lt 2 ]; then
    printf 'usage: %s HOST [HOST...]\n\n' "${0##*/}" >&2
    printf 'Two hosts minimum -- agreement is not a property one host has.\n' >&2
    exit 2
fi

# The parser goes over stdin, not as an argument.
#
# Every quoting layer between here and the remote shell is a place for this
# to break silently, and this project has been bitten by exactly that twice:
# an inline `python3 -c` that lost its newlines, and a script passed as an
# argv element that Windows re-quoted into an unbalanced quote. `bash -s`
# reads from stdin, so nothing quotes anything.
REMOTE_PARSER='
f=/root/.ssh/authorized_keys
[ -r "$f" ] || exit 0
while IFS= read -r line; do
    case "$line" in ""|\#*) continue ;; esac

    # The key blob is the first field that starts with a key type. Looking
    # for it rather than counting fields means an options list of any length
    # is skipped without this having to understand the options.
    blob=""
    for w in $line; do
        case "$w" in ssh-*|ecdsa-*|sk-*) blob="$w"; break ;; esac
    done
    [ -n "$blob" ] || continue

    opts="${line%%$blob*}"
    rest="${line#*$blob}"

    # A forced command is the thing that stops a key being an admin key.
    case "$opts" in
        *command=*) kind=PINNED
                    cmd="${opts#*command=\"}"; cmd="${cmd%%\"*}" ;;
        *)          kind=SHELL; cmd="" ;;
    esac

    fpline=$(printf "%s%s\n" "$blob" "$rest" | ssh-keygen -l -f - 2>/dev/null)
    [ -n "$fpline" ] || continue
    set -- $fpline
    fp=$2; cm=$3
    printf "%s|%s|%s|%s\n" "$kind" "$fp" "${cm:-(no comment)}" "$cmd"
done < "$f" | LC_ALL=C sort
'

. "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/lib/remote.sh"

echo "=================================================================="
echo " Who can become root on each machine?"
echo "=================================================================="

declare -A SHELLKEYS
LIVE=()
UNREAD=0

for h in "$@"; do
    remote_ask "$h" "$REMOTE_PARSER"
    raw="$REMOTE_OUT"
    printf '\n%s%s%s\n' "$BLD" "$h" "$OFF"

    # These were one line -- "unreachable, or no authorized_keys" -- and they
    # are not the same thing at all. One is a machine nobody could ask. The
    # other is a machine that answered, on the question of who can become
    # root, with nobody. The second deserves to be read twice by a human; the
    # first deserves to be asked again. lib/remote.sh can tell them apart
    # because it keeps ssh's own 255 separate from a status the far end
    # returned, which the private copy here could not.
    if [ "$REMOTE_RC" = "$REMOTE_UNREACHABLE" ]; then
        printf '  %s??%s     unreachable over ssh -- not compared\n' "$YLW" "$OFF"
        UNREAD=$((UNREAD + 1))
        continue
    fi
    if [ -z "$raw" ]; then
        printf '  %s??%s     answered, but listed no authorized_keys at all --\n' \
            "$YLW" "$OFF"
        printf '         either the file is missing or nobody can log in. Not compared.\n'
        UNREAD=$((UNREAD + 1))
        continue
    fi

    SHELLKEYS[$h]="$(printf '%s\n' "$raw" | awk -F'|' '$1=="SHELL"{print $2" "$3}' | LC_ALL=C sort)"
    LIVE+=("$h")

    printf '%s\n' "$raw" | while IFS='|' read -r kind fp cm cmd; do
        [ -n "$fp" ] || continue
        if [ "$kind" = "SHELL" ]; then
            printf '  %-30s %s\n' "$cm" "shell"
        else
            printf '  %-30s %s\n' "$cm" "pinned to ${cmd:-a forced command}"
        fi
    done
done

if [ "${#LIVE[@]}" -lt 2 ]; then
    printf '\n%sfewer than two hosts answered -- nothing can be compared%s\n' \
        "$YLW" "$OFF"
    echo "=================================================================="
    exit 2
fi

# ---------------------------------------------------------------------------
# The baseline is the commonest set of shell keys. With the pinned keys out
# of the comparison, "commonest" is meaningful again: role differences no
# longer masquerade as disagreement.
printf '\n%swho gets a shell%s\n' "$BLD" "$OFF"

BASELINE=""
BEST=0
for h in "${LIVE[@]}"; do
    n=0
    for g in "${LIVE[@]}"; do
        [ "${SHELLKEYS[$g]}" = "${SHELLKEYS[$h]}" ] && n=$((n + 1))
    done
    if [ "$n" -gt "$BEST" ]; then BEST=$n; BASELINE="${SHELLKEYS[$h]}"; fi
done

DIFF=0
for h in "${LIVE[@]}"; do
    if [ "${SHELLKEYS[$h]}" = "$BASELINE" ]; then
        printf '  %sok%s     %s -- the same keys as the rest of the fleet\n' \
            "$GRN" "$OFF" "$h"
    else
        printf '  %sFAIL%s   %s -- a DIFFERENT set of shell keys\n' \
            "$RED" "$OFF" "$h"
        while read -r fp comment; do
            [ -n "$fp" ] || continue
            printf '%s\n' "${SHELLKEYS[$h]}" | grep -qF "$fp" \
                || printf '         missing here: %s\n' "$comment"
        done <<EOF
$BASELINE
EOF
        while read -r fp comment; do
            [ -n "$fp" ] || continue
            printf '%s\n' "$BASELINE" | grep -qF "$fp" \
                || printf '         extra here:   %s\n' "$comment"
        done <<EOF
${SHELLKEYS[$h]}
EOF
        DIFF=$((DIFF + 1))
    fi
done

echo
echo "=================================================================="
if [ "$DIFF" -ne 0 ]; then
    printf ' %s%d host(s) do not agree on who can become root%s\n' \
        "$RED" "$DIFF" "$OFF"
    printf '\n A difference is not automatically wrong. It is wrong when nobody\n'
    printf ' knows about it, which is how a healthy host spent days being\n'
    printf ' reported as unreadable by a panel using a key it did not trust.\n'
    echo "=================================================================="
    exit 1
fi
if [ "$UNREAD" -ne 0 ]; then
    printf ' %sthe %d host(s) read agree; %d could not be read%s\n' \
        "$YLW" "${#LIVE[@]}" "$UNREAD" "$OFF"
    echo "=================================================================="
    exit 2
fi
printf ' %sthe same keys get a shell on all %d hosts%s\n' \
    "$GRN" "${#LIVE[@]}" "$OFF"
echo "=================================================================="
exit 0
