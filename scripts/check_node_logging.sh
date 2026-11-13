#!/bin/bash
# ===========================================================================
#  check_node_logging.sh -- can this node still tell us who connected?
# ===========================================================================
#
#      bash scripts/check_node_logging.sh 203.0.113.4 198.51.100.8
#
#  WHY
#
#  On 2 September 2026 unattended-upgrades replaced libevent, which wamd links
#  against, and restarted the node at 06:23 UTC. The restart was correct and
#  the node came back healthy. What did not come back was `debug=net`, because
#  it had been turned on at run time and was never written into wam.conf.
#
#  From that moment the node still knew who was connected THIS SECOND, and had
#  no memory of anyone who connected and left. A French address touched the
#  P2P port at 05:29 -- fifty-four minutes before the blindness -- and the only
#  reason we could say whether it was an operator or a port scanner is that it
#  arrived while the log was still running. An hour later the same event would
#  have left nothing at all.
#
#  The founder asks "who joined, and from which country" more often than he
#  asks anything else. This check exists so that the answer to that question
#  cannot go missing quietly again.
#
#  It asks two things, because either alone is a false pass:
#
#    * is the category on RIGHT NOW        -- run-time state
#    * is it in wam.conf                   -- will it survive the next restart
#
#  A node with it on but not in the conf is exactly the state that produced
#  the blindness, and it looks perfectly healthy from the outside.
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
fails=0
ok()   { echo "  ${GRN}ok${OFF}    $1"; }
bad()  { echo "  ${RED}FAIL${OFF}  $1"; fails=$((fails + 1)); }
warn() { echo "  ${YEL}!!${OFF}    $1"; }

[ $# -gt 0 ] || { echo "usage: ${0##*/} HOST [HOST...]" >&2; exit 2; }

echo
echo "${BLD}can each node still say who connected?${OFF}"

for h in "$@"; do
    out="$(timeout 90 ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o ConnectTimeout=15 "root@$h" '
        C=/opt/wam-current-bin/wam-cli
        live=$($C -testnet logging 2>/dev/null | grep -c "\"net\": true")
        conf=$(grep -cE "^[[:space:]]*debug[[:space:]]*=[[:space:]]*net" /root/.wam/wam.conf 2>/dev/null)
        mainconf=$(grep -cE "^[[:space:]]*debug[[:space:]]*=[[:space:]]*net" /root/.wam-mainnet/wam.conf 2>/dev/null)
        recent=$(journalctl -u wamd --since "30 min ago" --no-pager 2>/dev/null | grep -c "\[net\]")
        echo "$live $conf $mainconf $recent"
    ' 2>/dev/null)"

    if [ -z "$out" ]; then
        bad "$h did not answer"
        continue
    fi
    read -r live conf mainconf recent <<<"$out"

    if [ "${live:-0}" -gt 0 ]; then
        ok "$h is logging connections now"
    else
        bad "$h is NOT logging connections -- who arrives and leaves is invisible"
    fi

    # The one that matters more. On is a state; in the conf is a property.
    if [ "${conf:-0}" -gt 0 ]; then
        ok "$h keeps it across restarts (testnet conf)"
    else
        bad "$h would lose it at the next restart -- debug=net is not in wam.conf"
    fi

    if [ "${mainconf:-0}" -gt 0 ]; then
        ok "$h keeps it across restarts (mainnet conf)"
    else
        warn "$h mainnet conf has no debug=net -- blind from launch day"
    fi

    # Belt to the braces: the category can read as enabled while nothing is
    # actually being written, if the unit's log level filters it out.
    if [ "${recent:-0}" -gt 0 ]; then
        ok "$h wrote $recent net line(s) in the last 30 minutes"
    elif [ "${live:-0}" -gt 0 ]; then
        warn "$h says the category is on but wrote nothing in 30 minutes"
    fi
done

echo
if [ "$fails" -eq 0 ]; then
    echo "  ${GRN}every node can still answer \"who connected\"${OFF}"
else
    echo "  ${RED}$fails problem(s) -- a visitor could arrive unseen${OFF}"
fi
echo
exit $(( fails > 0 ))
