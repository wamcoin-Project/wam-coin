#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_checkout_current.sh -- is this clone still the software we publish?
# ===========================================================================
#
#      bash scripts/check_checkout_current.sh
#      bash scripts/check_checkout_current.sh --quiet
#
#  exit 0  this checkout builds the newest release, or the check could not
#          be made (no network, GitHub not answering) and said so
#  exit 1  this checkout is behind, and nothing in between changed consensus
#  exit 2  this checkout is behind a release that changed a consensus rule,
#          so the node it builds will be rejected by the network
#
#  WHY THIS EXISTS
#
#  install.sh builds whatever is in the clone it is run from, and never
#  asked whether that was still current. The explorer invites strangers with
#  one line -- "Run one yourself: ./install.sh --network testnet" -- so a
#  person who cloned the repository last week and ran it today silently got
#  last week's node.
#
#  On 26 August someone did exactly that and joined on v0.1.5, two releases
#  behind, stayed briefly and left. Nothing had gone wrong from their side.
#  We handed them a tool that builds the past without saying so.
#
#  The founder put the cost plainly: somebody running a withdrawn release
#  does not conclude "my copy is old". They conclude the system is broken,
#  and they do not come back. At the beginning, that is the whole cost.
#
#  And on 15 September it stops being about impressions. A clone taken
#  before the consensus release builds a node that is rejected at height 1
#  and is never told why -- the protocol carries blocks, not notices.
#
#  HOW IT DECIDES A RELEASE CHANGED CONSENSUS
#
#  By the MANDATORY: line in its notes. That marker is not decoration: the
#  release workflow refuses to publish a tag whose consensus values differ
#  from the previous tag unless it carries one. So "is there a MANDATORY
#  release newer than mine" is a question with a reliable answer, asked of
#  the server rather than of this clone -- which is the point, since a stale
#  clone's own tags are stale too.
# ===========================================================================

set -uo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh" || exit 2

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="wamcoin-Project/wam-coin"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
say()  { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
ok()   { say "  ${GRN}ok${OFF}    $*"; }
warn() { say "  ${YLW}!!${OFF}    $*"; }
bad()  { printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$*"; }

# --- what this clone would build ------------------------------------------
MINE="$(grep -oE 'WAM_CLIENT_VERSION[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' \
        "$HERE/scripts/patch_upstream.py" 2>/dev/null \
        | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

if [ -z "$MINE" ]; then
    warn "could not read WAM_CLIENT_VERSION from scripts/patch_upstream.py"
    exit 0
fi
say "  this checkout builds ${BLD}v${MINE}${OFF}"

# --- what is published ----------------------------------------------------
#
# The list endpoint, not /releases/latest: everything below 1.0 is published
# as a pre-release and that endpoint excludes them, answering 404 for the
# whole pre-1.0 life of this project. That mistake has been made twice here
# already, once in the announcement bot.
JSON="$(curl -fsS --max-time 20 -H 'User-Agent: wam-install-check' \
        "https://api.github.com/repos/$REPO/releases?per_page=20" 2>/dev/null)"

if [ -z "$JSON" ]; then
    warn "could not reach GitHub to check for a newer release -- continuing"
    warn "if this machine has no internet, that is expected"
    exit 0
fi

READ="$(printf '%s' "$JSON" | "$PY" -c '
import sys; sys.stdout.reconfigure(newline='\n')  # no \r on Windows
import json, re, sys
try:
    rels = json.load(sys.stdin)
except Exception:
    sys.exit(1)

def tup(t):
    m = re.findall(r"\d+", t or "")
    return tuple(int(x) for x in m) if m else (0,)

mine = tup(sys.argv[1])
published = [r for r in rels if not r.get("draft")]
if not published:
    sys.exit(1)

newest = max(published, key=lambda r: tup(r["tag_name"]))

# Any release newer than this checkout whose notes declare a consensus
# change. The workflow will not publish one without the marker.
mand = [r["tag_name"] for r in published
        if tup(r["tag_name"]) > mine
        and re.search(r"^[ \t>*_]*MANDATORY:", r.get("body") or "", re.I | re.M)]

print(newest["tag_name"])
print(",".join(sorted(mand, key=tup)))
' "$MINE" 2>/dev/null)"

NEWEST="$(printf '%s' "$READ" | sed -n 1p)"
MANDS="$(printf '%s'  "$READ" | sed -n 2p)"

if [ -z "$NEWEST" ]; then
    warn "GitHub answered, but no published release could be read -- continuing"
    exit 0
fi

NEWEST_V="${NEWEST#v}"

if [ "$NEWEST_V" = "$MINE" ]; then
    ok "that is the newest published release"
    exit 0
fi

# Newer locally than anything published: a maintainer mid-release. Not a
# problem, and saying nothing about it would be the confusing outcome.
if [ "$(printf '%s\n%s\n' "$MINE" "$NEWEST_V" | sort -V | tail -1)" = "$MINE" ]; then
    ok "newer than the newest published release (v$NEWEST_V) -- building unreleased code"
    exit 0
fi

echo
bad "this checkout is v${MINE}. The newest release is ${NEWEST}."

# The marker is the fast answer and it is enforced going forward -- the
# release workflow refuses to publish a tag whose consensus values moved
# without one. It was not enforced when v0.1.5 was published, and v0.1.5 is
# the one release in this project's history that did move them. So when no
# marker is found, the question is put to the files themselves rather than
# trusted to have been answered by somebody at the time.
if [ -z "$MANDS" ]; then
    DERIVED="$("$PY" "$HERE/scripts/consensus_floor.py" \
                 --compare-remote "v${MINE}" "$NEWEST" 2>/dev/null | head -1)"
    if [ "$DERIVED" = "differs" ]; then
        MANDS="derived"
    fi
fi

if [ -n "$MANDS" ]; then
    printf '        %sA consensus rule changed between v%s and %s.%s\n' \
        "$BLD" "$MINE" "$NEWEST" "$OFF"
    printf '        A node built from this checkout will reject every valid block\n'
    printf '        and fork itself off the network -- and nothing will tell it,\n'
    printf '        because the protocol carries blocks and not notices.\n'
    if [ "$MANDS" = "derived" ]; then
        printf '        (No release in between declares it; this was read out of the\n'
        printf '         source at both tags, which is the answer that cannot go stale.)\n'
    else
        printf '        Declared by: %s\n' "$MANDS"
    fi
else
    printf '        Nothing in between changed a consensus rule, so a node built\n'
    printf '        from it would still follow the chain. It would carry whatever\n'
    printf '        every release since v%s fixed, and someone meeting WAM through\n' "$MINE"
    printf '        it would meet the old faults and think they were ours.\n'
fi

echo
printf '        %sFix it in one command:%s\n\n' "$BLD" "$OFF"
printf '            git pull --ff-only origin main\n\n'

[ -n "$MANDS" ] && exit 2
exit 1
