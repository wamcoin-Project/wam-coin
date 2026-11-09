#!/bin/bash
# ===========================================================================
#  genesis_gate.sh -- refuse to start a node before its network exists
# ===========================================================================
#
#      scripts/genesis_gate.sh mainnet [--datadir /root/.wam-mainnet]
#
#  Meant to be an ExecStartPre in the node unit, where a non-zero exit stops
#  the service before the daemon runs.
#
#  WHAT THIS PREVENTS
#
#  A node started before its genesis timestamp works exactly once. From an
#  empty datadir, genesis is constructed in memory and accepted; the node
#  reports height 0 and looks entirely healthy. Every start after that reads
#  genesis from disk instead, and startup verification refuses a stored block
#  dated ahead of now:
#
#      The block database contains a block which appears to be from the
#      future. Please restart with -reindex or -reindex-chainstate to
#      recover.
#      [error] Aborted block database rebuild. Exiting.
#
#  -reindex does not recover it either, because the block it would rebuild
#  from is the same block. The datadir has to be emptied.
#
#  So the failure is stored, not immediate. `systemctl start wamd-mainnet`
#  succeeds, and the node dies at the next reboot -- which, with
#  Restart=always, is a crash loop that begins at whatever hour the machine
#  happened to restart. Confirmed by doing it on 2026-08-28 and again on
#  2026-08-29.
#
#  The gate exists because "we know not to do that" is not a mechanism. On
#  29 August I started the mainnet node myself, on purpose, to test ElectrumX
#  against it -- and left a poisoned datadir behind. Knowing the rule did not
#  help; there was nothing to stop me.
#
#  EXIT 78, NOT 1
#
#  Restart=always restarts a unit whose ExecStartPre failed, so a plain
#  refusal became a retry every RestartSec seconds -- forty of them in ten
#  minutes on the Germany host, which is the crash loop this gate exists to
#  prevent, arriving by a different door. 78 is EX_CONFIG from sysexits.h,
#  and wamd-mainnet.service names it in RestartPreventExitStatus, so systemd
#  reports the failure once and stops.
#
#  DELIBERATE REHEARSAL
#
#  NOT this, which is what this comment used to say and what does nothing:
#
#      WAM_ALLOW_PRELAUNCH_START=1 systemctl start wamd-mainnet
#
#  systemd does not inherit the caller's environment, so the gate never sees
#  the variable and refuses exactly as it would have anyway. It looks like
#  the override is broken; the override was never reached.
#
#  Run the daemon directly instead:
#
#      /opt/wam-current-bin/wamd -chain=main \
#          -conf=/root/.wam-mainnet/wam.conf -datadir=/root/.wam-mainnet
#
#  which touches no unit, and sets no variable that outlives the run.
#  `systemctl set-environment WAM_ALLOW_PRELAUNCH_START=1` does work and is
#  worse: it stays set, silently disabling this gate for everything until
#  somebody remembers to unset it.
#
#  Either way, empty blocks/, chainstate/ and indexes/ afterwards or the
#  next start fails. Wallets are not in those three and survive -- which is
#  how the mainnet pool wallet came to exist on 2026-08-30, two weeks before
#  the chain it belongs to.
# ===========================================================================

set -uo pipefail

CHAIN="${1:-mainnet}"
DATADIR=""
shift || true
while [ $# -gt 0 ]; do
    case "$1" in
        --datadir) DATADIR="${2:?--datadir needs a value}"; shift ;;
        *) shift ;;
    esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HDR="$REPO/src/wam/wam-params.h"

case "$CHAIN" in
    main|mainnet) NAME=WAM_GENESIS_TIME         ; FALLBACK=1789430400 ;;
    test|testnet) NAME=WAM_TESTNET_GENESIS_TIME ; FALLBACK=1785542400 ;;
    regtest)      exit 0 ;;
    *) echo "genesis_gate: unknown chain '$CHAIN'" >&2; exit 2 ;;
esac

# The header is the authority. The fallback is here only so that a moved or
# unreadable checkout cannot block a legitimate start months from now, and
# check_launch_gate.sh fails if the two ever disagree.
GENESIS=""
if [ -r "$HDR" ]; then
    GENESIS="$(sed -n "s/.*${NAME}[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p" "$HDR" | head -1)"
fi
if [ -z "$GENESIS" ]; then
    GENESIS=$FALLBACK
    echo "genesis_gate: cannot read $NAME from $HDR; using built-in $FALLBACK" >&2
fi

NOW=$(date -u +%s)
[ "$NOW" -ge "$GENESIS" ] && exit 0

WHEN=$(date -u -d "@$GENESIS" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || echo "@$GENESIS")
LEFT=$(( (GENESIS - NOW + 3599) / 3600 ))

# A datadir that already holds blocks is not merely early, it is already
# poisoned: this start will fail no matter what the operator intends, so say
# the thing that actually fixes it.
if [ -n "$DATADIR" ] && [ -d "$DATADIR/blocks" ]; then
    cat >&2 <<EOF

  genesis_gate: $CHAIN opens $WHEN, in ${LEFT}h.

  $DATADIR already contains a block database, and it holds a
  genesis block dated in the future. This node cannot start, with or
  without an override, and -reindex will not help because it would rebuild
  from the same block.

      rm -rf $DATADIR/blocks $DATADIR/chainstate $DATADIR/indexes

  The wallet, the conf and everything else in that directory are untouched
  by those three removals.

EOF
    exit 78
fi

if [ "${WAM_ALLOW_PRELAUNCH_START:-0}" = "1" ]; then
    cat >&2 <<EOF

  genesis_gate: allowing an early $CHAIN start because
  WAM_ALLOW_PRELAUNCH_START=1.

  This node will run once and will NOT survive a restart or a reboot. Empty
  its block database when you are finished:

      rm -rf ${DATADIR:-<datadir>}/blocks ${DATADIR:-<datadir>}/chainstate ${DATADIR:-<datadir>}/indexes

EOF
    exit 0
fi

cat >&2 <<EOF

  genesis_gate: refusing to start $CHAIN. It opens $WHEN,
  in ${LEFT}h.

  A node started now would work once and then fail at every restart, with an
  error about a block from the future -- most likely at a reboot nobody
  planned, on the night it mattered.

  If this is a deliberate rehearsal, run the daemon DIRECTLY:

      /opt/wam-current-bin/wamd -chain=main \\
          -conf=${DATADIR:-/root/.wam-mainnet}/wam.conf \\
          -datadir=${DATADIR:-/root/.wam-mainnet} -printtoconsole=1

  NOT \`WAM_ALLOW_PRELAUNCH_START=1 systemctl start <unit>\`, which this
  message used to print and which does nothing: systemd does not pass the
  caller's environment to a unit, so this gate never sees the variable and
  refuses exactly as it would have anyway. Tested on 2026-09-04 -- the unit
  stayed inactive and looked like a broken override, when the override had
  simply never been reached.

  Afterwards, empty these three or the next start fails. The wallet is not
  among them and survives:

      rm -rf ${DATADIR:-<datadir>}/blocks ${DATADIR:-<datadir>}/chainstate ${DATADIR:-<datadir>}/indexes

EOF
exit 78
