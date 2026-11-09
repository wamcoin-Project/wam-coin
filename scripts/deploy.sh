#!/bin/bash
# ===========================================================================
#  deploy.sh -- put origin/main on the servers, and prove it landed
# ===========================================================================
#
#      bash scripts/deploy.sh                       # both seeds
#      bash scripts/deploy.sh 169.58.159.165        # one of them
#
#  WHY THIS EXISTS
#
#  This is the operation performed more often than any other here, and until
#  now it was a line typed by hand into a throwaway script:
#
#      git -C /opt/wam fetch -q origin && git -C /opt/wam reset -q --hard origin/main
#
#  On 2 September 2026 that line failed on Germany with "could not read
#  Username for 'https://github.com'" -- git's unhelpful way of saying the ref
#  listing came back malformed. GitHub was having a bad few minutes; the same
#  command worked perfectly a quarter of an hour later.
#
#  The failure was not the problem. The problem was that the && chain stopped
#  there, the script printed "4fb9fda -> 4fb9fda", and that reads as "nothing
#  to do" rather than "this did not happen". Germany stayed two commits behind
#  and the only thing that noticed was check_deployed_code.sh going red on the
#  panel an hour later -- which is the safety net working, and is not a
#  substitute for the deploy telling the truth at the time.
#
#  So: retries, because the failure is transient. And the commit is READ BACK
#  from each host afterwards and compared, because a deploy that reports
#  success without checking is a deploy that will one day be wrong quietly.
# ===========================================================================

set -uo pipefail
cd "$(dirname "$0")/.."

GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

HOSTS=("$@")
[ ${#HOSTS[@]} -gt 0 ] || HOSTS=(169.58.159.165 5.223.52.200 13.140.33.187)

TRIES=4

WANT="$(git rev-parse HEAD)"
SHORT="${WANT:0:7}"
echo
echo "${BLD}deploying $SHORT$OFF -- $(git log -1 --format=%s | cut -c1-60)"

# Refuse to deploy what has not been pushed. Otherwise the servers are reset
# to an origin/main that does not contain the change just made here, and the
# result looks like a successful deploy of the wrong thing.
if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    git fetch -q origin 2>/dev/null
    if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
        echo "  ${RED}HEAD is not on origin/main -- push first${OFF}"
        echo "  (the servers reset to origin/main; deploying now would deploy"
        echo "   something older than what is in this working tree)"
        echo
        exit 2
    fi
fi

# Refuse to deploy a CHANNELS.txt whose signature does not cover it.
#
# DEPLOYING IS PUBLISHING NOW, AND IT DID NOT USE TO BE. nginx serves
# /opt/wam/site straight from this checkout -- see deploy/nginx/
# wam-site-locations.conf -- so the moment a host is updated, whatever
# CHANNELS.txt this commit holds is live at wamcoin.org/CHANNELS.txt. While
# the site was published from a separate branch, "deploying is not
# publishing" was true and was written down as a rule. It stopped being true
# when the site moved onto our own hardware and nobody rewrote the rule.
#
# The file tells its reader to run `gpg --verify CHANNELS.txt.asc
# CHANNELS.txt`. Publishing revision N beside revision N-1's signature hands
# that reader BAD signature -- and BAD signature is the one outcome that
# reads as an attack. He cannot tell our carelessness from somebody having
# replaced the list that says which accounts are ours. That is worse than
# having no signature at all, which is why this refuses rather than warns.
#
# WAM_DEPLOY_UNSIGNED=1 is the way past it, for the case where a host needs
# an urgent fix and the USB key is not in the room. It is deliberately
# awkward to type and it says what it is doing.
if [ -x scripts/check_channels_signed.sh ] || [ -f scripts/check_channels_signed.sh ]; then
    if ! bash scripts/check_channels_signed.sh >/dev/null 2>&1; then
        if [ "${WAM_DEPLOY_UNSIGNED:-0}" = "1" ]; then
            echo "  ${YEL}!!${OFF}    CHANNELS.txt is not signed for these bytes --"
            echo "        deploying anyway because WAM_DEPLOY_UNSIGNED=1."
            echo "        wamcoin.org/CHANNELS.txt will fail verification until"
            echo "        scripts/sign_channels.sh is run."
        else
            echo "  ${RED}CHANNELS.txt is not signed for the bytes in this commit${OFF}"
            echo "  nginx serves site/ from the checkout, so deploying publishes it,"
            echo "  and a reader following our own instructions would get"
            echo "  BAD signature -- which is indistinguishable from an attack."
            echo
            echo "      bash scripts/sign_channels.sh        # with the USB key"
            echo "      WAM_DEPLOY_UNSIGNED=1 bash scripts/deploy.sh   # if urgent"
            echo
            exit 2
        fi
    fi
fi

bad=0
for h in "${HOSTS[@]}"; do
    before="$(ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o ConnectTimeout=15 "root@$h" \
        'git -C /opt/wam rev-parse --short HEAD' 2>/dev/null)"
    # The default protocol first, then v0. Measured on 2 September 2026:
    # git 2.43.0 on Ubuntu 24.04 fails protocol v2 against the remote six times in
    # eight, on both servers, with "expected flush after ref listing"; v0
    # failed none in eight. The laptop's newer git passes both, which is why
    # this only ever bit the servers.
    #
    # The default is tried first on purpose. Pinning v0 outright would work
    # today and go on working silently after the underlying bug is fixed,
    # which is how a machine ends up years behind on a protocol nobody
    # remembers choosing. This way the fallback announces itself every time
    # it is needed, and stops being needed on its own.
    got=""
    for try in $(seq 1 $TRIES); do
        proto=""
        [ $try -gt 1 ] && proto="-c protocol.version=0"
        err="$(ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o ConnectTimeout=15 "root@$h" \
            "git $proto -C /opt/wam fetch -q origin && git -C /opt/wam reset -q --hard origin/main" 2>&1)"
        rc=$?
        if [ $rc -eq 0 ]; then
            [ $try -gt 1 ] && printf '  %s!!%s    %s needed protocol v0 (v2 is broken on this git)\n' \
                "$YEL" "$OFF" "$h"
            break
        fi
        printf '  %s!!%s    %s attempt %d: %s\n' "$YEL" "$OFF" "$h" "$try" \
            "$(printf '%s' "$err" | tail -1 | cut -c1-80)"
        sleep 3
    done

    # Read it back. Not "the command exited 0" -- what the machine now holds.
    got="$(ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o ConnectTimeout=15 "root@$h" \
        'git -C /opt/wam rev-parse HEAD' 2>/dev/null)"

    if [ "$got" = "$WANT" ]; then
        # Scripts that run from outside the checkout have to be copied out of
        # it, or the machine runs the new code everywhere except where it
        # matters most -- wam-facts is the forced command on the reporting key.
        ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes "root@$h" '
            install -m 755 /opt/wam/scripts/wam-facts.sh /usr/local/bin/wam-facts
            install -m 755 /opt/wam/scripts/wam-maint.sh /usr/local/bin/wam-maint
        ' >/dev/null 2>&1
        if [ "$before" = "$SHORT" ]; then
            printf '  %sok%s    %-16s already on %s\n' "$GRN" "$OFF" "$h" "$SHORT"
        else
            printf '  %sok%s    %-16s %s -> %s\n' "$GRN" "$OFF" "$h" "${before:-?}" "$SHORT"
        fi
    else
        printf '  %sFAIL%s  %-16s is on %s, wanted %s\n' "$RED" "$OFF" "$h" \
            "${got:0:7}" "$SHORT"
        bad=1
    fi
done

echo
if [ $bad -eq 0 ]; then
    echo "  ${GRN}every host is running $SHORT${OFF}"
else
    echo "  ${RED}a host is not running this code -- it is not deployed${OFF}"
fi
echo
exit $bad
