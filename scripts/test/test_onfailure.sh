#!/bin/bash
# ===========================================================================
#  Every unit that watches something must say so when it stops working
# ===========================================================================
#
#      bash scripts/test/test_onfailure.sh
#
#  Three services in this project have failed and stayed failed while every
#  panel showed green:
#
#    wam-backup            from 23 August 2026, nightly, and there was
#                          nothing to restore from
#    wam-reorg-watch       Germany 03:11 UTC and Singapore 03:47 UTC on
#                          1 September 2026, for ten and a half hours
#
#  Each was found by a person going and looking. The cause was the same each
#  time: the panels read `systemctl is-active` on the TIMER, and a timer
#  stays active however often the service beneath it fails.
#
#  OnFailure=wam-alert@%n.service is what closes that. This test exists so
#  that the next unit added to deploy/systemd cannot quietly be the one that
#  goes back to failing in silence.
# ===========================================================================

set -uo pipefail
cd "$(dirname "$0")/../.."

GRN=$'\033[32m'; RED=$'\033[31m'; BLD=$'\033[1m'; OFF=$'\033[0m'
fails=0
pass() { echo "  ${GRN}ok${OFF}    $1"; }
fail() { echo "  ${RED}FAIL${OFF}  $1"; fails=$((fails + 1)); }

echo
echo "${BLD}every unit reports its own failure${OFF}"

for f in deploy/systemd/*.service; do
    n=$(basename "$f")

    # The alerter must not point at itself: a failure there would loop, and
    # there would be nothing left to tell anyway.
    if [ "$n" = "wam-alert@.service" ]; then
        if grep -q '^OnFailure=' "$f"; then
            fail "$n points at an alerter -- if alerting fails this loops"
        else
            pass "$n has none, correctly -- it is the alerter"
        fi
        continue
    fi

    if grep -q '^OnFailure=wam-alert@%n.service$' "$f"; then
        pass "$n reports its own failure"
    elif grep -q '^OnFailure=' "$f"; then
        fail "$n has an OnFailure= that is not wam-alert@%n.service"
    else
        fail "$n can fail silently -- add OnFailure=wam-alert@%n.service"
    fi
done

# The unit the others name has to exist, or every OnFailure= above is a line
# systemd logs a warning about and nothing more.
if [ -f deploy/systemd/wam-alert@.service ]; then
    pass "the alerter they all name exists"
else
    fail "deploy/systemd/wam-alert@.service is missing -- every OnFailure= above is dead"
fi

echo
if [ "$fails" -eq 0 ]; then
    echo "  ${GRN}nothing here can fail without saying so${OFF}"
else
    echo "  ${RED}$fails unit(s) can fail in silence${OFF}"
fi
echo
exit $(( fails > 0 ))
