#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  preflight.sh -- is this actually ready to launch?
# ===========================================================================
#
#      bash scripts/preflight.sh                     # local checks only
#      bash scripts/preflight.sh --host IP           # also check a server
#      bash scripts/preflight.sh --nodes "IP1 IP2"   # also compare nodes
#                                                     against each other
#
#  WHY THIS EXISTS
#
#  Every "full system check" up to now reported that things were running, and
#  running is not the same as correct. `systemctl is-active wamd` said active
#  while the executable was still called bitcoind and wamd was a symlink
#  beside it. A check that asks "is the service up" cannot see that.
#
#  So this asks the questions whose answers only appear when you try to use
#  the thing: can a release be packaged, is the binary named ours, does the
#  config the node reads exist under our name, would a stranger's first
#  command work. Each check names what breaks if it fails, because a red line
#  with no consequence attached gets ignored.
#
#  It is meant to fail. Items 1 and 2 below cannot pass before the key
#  ceremony, and that is correct -- they are the gate, not a defect.
# ===========================================================================

set -uo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh" || exit 2

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

HOST=""
NODES=""
while [ $# -gt 0 ]; do
    case "$1" in
        --host)  HOST="$2";  shift 2 ;;
        # Commas accepted, for the reason written at the same place in
        # sweep.sh: every use of $NODES here word-splits, so one comma makes
        # three hosts into a single hostname nobody can reach, and the failure
        # is a red line about the nodes rather than about the argument.
        --nodes) NODES="$(printf '%s' "$2" | tr ',' ' ')"; shift 2 ;;
        -h|--help) sed -n '5,28p' "$0"; exit 0 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
PASS=0; FAIL=0; GATE=0; UNCHECKED=0

ok()   { printf '  %sok%s     %s\n' "$GRN" "$OFF" "$*"; PASS=$((PASS+1)); }
bad()  { printf '  %sFAIL%s   %s\n' "$RED" "$OFF" "$*"; FAIL=$((FAIL+1)); }
gate() { printf '  %sgate%s   %s\n' "$YLW" "$OFF" "$*"; GATE=$((GATE+1)); }
# A missing tool is not a finding about the thing the tool would have looked at.
#
# Two of these were reported as failures: a missing dig became "seeding could
# not be checked at all" counted as red, and a release check that had exited 2
# -- this project's word for "could not run" -- became "the published download
# is NOT this network". The download was fine, the binaries were fine, and the
# report said otherwise on both counts, every run, on the machine the founder
# uses. Red lines that are always there are red lines nobody reads.
unchecked() { printf '  %swarn%s   %s\n' "$YLW" "$OFF" "$*"; UNCHECKED=$((UNCHECKED+1)); }
sect() { printf '\n%s%s%s\n' "$BLD" "$*" "$OFF"; }

rsh() { timeout 40 ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o ConnectTimeout=12 "root@$HOST" "$@" 2>/dev/null; }

echo "=================================================================="
echo " WAM preflight"
echo "=================================================================="

# ---------------------------------------------------------------------------
sect "The launch gate -- these cannot pass before the key ceremony"

FOUNDER="$(awk '/^static const std::string WAM_FOUNDER_ADDRESS_MAINNET/{
    if (match($0, /"[^"]*"/)) print substr($0, RSTART+1, RLENGTH-2)}' src/wam/chainparams.cpp)"
TREASURY="$(awk '/^static const std::string WAM_TREASURY_ADDRESS_MAINNET/{
    if (match($0, /"[^"]*"/)) print substr($0, RSTART+1, RLENGTH-2)}' src/wam/chainparams.cpp)"

if [ "$FOUNDER" = "WNg2svm2qApxheBKndKGQ9sRwporvRgRpT" ]; then
    gate "mainnet founder address is still the burn placeholder"
    gate "mainnet genesis cannot be mined until that address exists"
else
    ok "mainnet founder address is set: $FOUNDER"
fi

# The treasury is a separate gate because it fails differently and later. A
# burn address here does not stop the chain or show up in any test: blocks are
# valid, the rule is satisfied, and 750,000 WAM of operating income is
# destroyed one block at a time for eighteen months before anyone notices the
# balance never moved.
if [ "$TREASURY" = "WNg2svm2qApxheBKndKGQ9sRwporvRgRpT" ]; then
    gate "mainnet treasury address is still the burn placeholder"
    gate "every 5% fee would be destroyed -- 750,000 WAM, silently, over 400,000 blocks"
elif [ "$TREASURY" = "$FOUNDER" ]; then
    gate "mainnet treasury and founder are the same address"
    gate "treasury spending would be indistinguishable from the founder selling"
else
    ok "mainnet treasury address is set and separate: $TREASURY"
fi

# ---------------------------------------------------------------------------
sect "Identity -- would anyone mistake this for Bitcoin?"

# The check that a service-status sweep cannot make. wamd being a symlink to
# bitcoind passes every "is it running" test ever written.
if [ -n "$HOST" ]; then
    REAL="$(rsh 'readlink -f /usr/local/bin/wamd 2>/dev/null')"
    case "$REAL" in
        */wamd) ok "the installed node really is wamd, not a symlink to bitcoind" ;;
        */bitcoind) bad "wamd is a symlink to bitcoind -- collides with a real Bitcoin
           install, and package_release.sh cannot find src/wamd" ;;
        '') bad "no wamd on $HOST" ;;
        *)  bad "wamd resolves to $REAL" ;;
    esac
fi

# EXIT 2 IS "I COULD NOT LOOK", AND IT IS NOT A FAILURE.
#
# This file already knew that -- the seeding check at the bottom reads 2 and 3
# and calls unchecked() -- and three checks here did not. They asked "did it
# exit zero" and called everything else a failure.
#
# What that cost: make_icons.py exits 2 when Pillow is absent, which it is on
# every seed. So preflight on a seed has been reporting "the GUI icons are
# missing or malformed -- Windows and macOS would ship Bitcoin's logo", every
# single run, about four icon files that were present and correct. Found by
# the sweep on 2026-10-12.
#
# A launch-readiness check that is permanently red about one thing is a check
# an operator learns to scroll past, and the next one it goes red about is the
# real one.
judge() {
    local label="$1" fail_msg="$2" unchecked_msg="$3"; shift 3
    "$@" >/dev/null 2>&1
    case $? in
        0) ok "$label" ;;
        2) unchecked "$unchecked_msg" ;;
        *) bad "$fail_msg" ;;
    esac
}

# The GUI ships four icon files and patch_upstream.py replaced one of them
# until 2026-09-24. A build whose brand/generated icons are missing does not
# fail loudly -- patch_upstream cannot find a source file and stops, which is
# a confusing way to learn that a release was blocked by an icon.
judge "the Windows and macOS icons are generated and well formed"     "the GUI icons are missing or malformed -- Windows and macOS would ship
           Bitcoin's logo on a WAM wallet. Run: $PY scripts/make_icons.py"     "Pillow is not installed here, so the icons were NOT read -- this is not a
           pass. Install it, or read them where it is: $PY -m pip install Pillow"     "$PY" scripts/make_icons.py --check

# THE WALLET'S OWN WORDS, IN EVERY LANGUAGE IT SHIPS.
#
# On 2026-09-26 the first graphical wallet this project ever built was opened
# and read. Its welcome screen offered to download "the full Bitcoin block
# chain (4 GB) starting with the earliest transactions in 2009", its Pay To
# field gave a Bitcoin mainnet address as the example of a WAM one, and all
# 123 translation catalogues inside it said Bitcoin -- the Spanish one told a
# man who has run a node here since August that encrypting his wallet risked
# TODOS TUS BITCOINS.
#
# None of it was reachable from the node, so no check had ever seen it: every
# release until then was built --without-gui. This is the check that would
# have, and it runs on the tree rather than on a built binary, so it answers
# before an hour of compiling rather than after.
if [ -d build/wam-core/src/qt ] || [ -d "$HOME/wam/build/wam-core/src/qt" ]; then
    QT_T="build/wam-core"; [ -d "$QT_T/src/qt" ] || QT_T="$HOME/wam/build/wam-core"
    judge "the wallet's text, in every language it ships, says WAM"         "the GUI still names another coin in text a person reads.
           Run: $PY scripts/rebrand_qt.py --tree $QT_T"         "there is no src/qt under $QT_T, so the wallet's wording was NOT read"         "$PY" scripts/rebrand_qt.py --tree "$QT_T" --check
else
    unchecked "no build tree with src/qt here, so the wallet's wording was not read"
fi

if [ -d build/wam-core/src ] || [ -d "$HOME/wam/build/wam-core/src" ]; then
    T="build/wam-core"; [ -d "$T/src" ] || T="$HOME/wam/build/wam-core"
    judge "the build tree builds wamd / wam-cli / wam-tx / wam-util / wam-wallet"         "the build tree still builds Bitcoin's binary names
           run: $PY scripts/rename_binaries.py --tree $T"         "there is no src/Makefile.am under $T, so the binary names were NOT read"         "$PY" scripts/rename_binaries.py --tree "$T" --check
fi

if [ -n "$HOST" ]; then
    # An unstripped wamd is 267 MB of debug symbols against 14 MB stripped.
    # Nobody downloading a currency wants a quarter of a gigabyte of symbols,
    # and it is large enough to make copying the node to a second machine over
    # an ordinary connection time out halfway.
    SZ="$(rsh 'stat -c%s /usr/local/bin/wamd 2>/dev/null')"
    if [ -n "$SZ" ] && [ "$SZ" -gt 62914560 ]; then
        bad "the installed wamd is $((SZ / 1048576)) MB -- debug symbols were not
           stripped. make install-strip, not make install"
    elif [ -n "$SZ" ]; then
        ok "the installed wamd is $((SZ / 1048576)) MB, stripped"
    fi

    # Twelve of these shipped silently for weeks.
    DEPS="$(rsh "ldd /usr/local/bin/wamd 2>/dev/null | awk '/=>/{print \$1}' \
            | grep -vE 'linux-vdso|ld-linux|libc\.so|libm\.so|libgcc_s|libstdc|libpthread|libdl|librt|libresolv' \
            | grep -vE 'libevent|libsqlite3' | sort -u")"
    if [ -z "$DEPS" ]; then
        ok "no runtime dependency beyond libevent and libsqlite3"
    else
        bad "extra runtime dependencies a downloader must already have:
           $(printf '%s' "$DEPS" | tr '\n' ' ')"
    fi
fi

# ---------------------------------------------------------------------------
sect "A stranger's first five minutes"

if [ "$(git ls-files -s -- install.sh | awk '{print $1}')" = "100755" ]; then
    ok "./install.sh is executable for anyone who clones"
else
    bad "./install.sh is not executable -- the first line of the README fails"
fi

bash scripts/test/test_exec_bits.sh >/dev/null 2>&1 \
    && ok "every shebang file is executable in the index" \
    || bad "some scripts are not executable in the index"

# The pool is the only part of this project with npm dependencies, and it is
# the part that holds the balances. Its lockfile is what makes `npm ci`
# install the same nine packages on every machine instead of whatever the
# registry serves that afternoon -- and that is worth nothing if the lockfile
# and package.json have drifted apart. npm would refuse too, on the
# operator's machine, at the moment they are bringing a pool up. This refuses
# here, where it can be fixed in one command.
if LOCK_OUT="$("$PY" scripts/check_pool_lockfile.py 2>&1)"; then
    ok "the pool's lockfile agrees with package.json, and install.sh uses it"
else
    bad "the pool's dependency lockfile does not hold:
           $(printf '%s' "$LOCK_OUT" | grep -m2 'FAIL\|error' | sed 's/^ *//' | tr '\n' ' ')"
fi

# One call, and the status is read rather than reinterpreted. This used to try
# a `--offline` flag first and fall back with `||`. That flag never existed:
# check_dns_seeds.sh took it as an unknown target, matched no branch, queried
# no seed and exited 0 -- so the fallback was never reached and this printed a
# green line for a check that had not run. Both ends are fixed; the script now
# refuses an argument it does not know and fails outright if it checked
# nothing, and nothing here converts a non-zero status into a pass.
DNS_OUT="$(bash scripts/check_dns_seeds.sh 2>&1)"
case $? in
    0) ok "every DNS seed answers the prefixed query Core actually sends" ;;
    # 2 is this project's code for "the check could not run", and that is what
    # check_dns_seeds.sh returns when it has no dig locally AND no host it is
    # willing to borrow one from -- it refuses a host running different source,
    # which is correct. This line used to read "rejected its argument -- this
    # call is wrong", a meaning that was true when the script only used 2 for a
    # usage error, and became a confident accusation against a call that is
    # fine. It sent the reader to fix the wrong thing.
    #
    # The reason was also being discarded to /dev/null, so there was nothing to
    # correct it with. It is printed now: whichever of the two situations it is,
    # the script already says which.
    2) unchecked "seeding was NOT checked -- this is not a pass. The check said:
$(printf '%s\n' "$DNS_OUT" | grep -v '^[[:space:]]*$' | tail -2 | sed 's/^[[:space:]]*/           /')" ;;
    3) unchecked "dig is missing, so seeding was NOT checked -- this is not a
           pass:  sudo apt-get install -y dnsutils" ;;
    *) bad "a DNS seed does not answer x9.<name> -- new nodes find nobody,
           silently, with no error" ;;
esac

# ---------------------------------------------------------------------------
sect "Can a release actually be built?"

# Not "do old tarballs exist" -- they did, from four weeks and 28 commits ago.
if grep -q 'BUILD_BASE' scripts/package_release.sh 2>/dev/null; then
    ok "package_release.sh finds the build tree from the repository"
else
    bad "package_release.sh hardcodes a home directory and fails on any other machine"
fi

# What people download is the published release, not a tarball on the machine
# that happens to be running this. That distinction was invisible while both
# were built by hand; it stopped being invisible when CI took over publishing,
# and this check went on failing for a stale local file nobody would ever
# receive -- red every run, for a fact about nothing, which is how a report
# teaches people to skim past its red lines.
#
# check_release_matches.sh asks the question that has consequences: it
# downloads the published artifact and looks inside it for the constants this
# source declares.
bash scripts/check_release_matches.sh >/dev/null 2>&1
case $? in
    0) ok "the published download carries this source's chains and addresses" ;;
    2) unchecked "part of the published download was NOT examined -- run:
           bash scripts/check_release_matches.sh" ;;
    *) bad "the published download is NOT this network -- run:
           bash scripts/check_release_matches.sh --source" ;;
esac

# A local tarball is a build artifact, so it is reported and never graded.
if [ -d out/release ]; then
    NEWEST=$(find out/release -name '*.tar.gz' -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
    if [ -n "$NEWEST" ]; then
        BEHIND=$(git log --since="@${NEWEST%.*}" --oneline 2>/dev/null | wc -l)
        [ "$BEHIND" -gt 0 ] && printf '  %sinfo%s   out/release holds a local build %s commits old; it is\n         nobody'"'"'s download\n' "$YLW" "$OFF" "$BEHIND"
    fi
fi

# ---------------------------------------------------------------------------
sect "Money"

"$PY" scripts/verify_supply.py >/dev/null 2>&1 \
    && ok "the 22,000,000 cap is enforced by the arithmetic" \
    || bad "the supply audit fails"

# Is there a JavaScript runtime at all, before any of this is called a result?
#
# On 12 September the sweep was run from seed3, which has no node -- it does
# not run the pool, so it was never given one. Every one of these tests
# "FAILED", and the sweep reported, in red, four lines of the form
#
#     FAIL   payment-safety.test.js FAILS -- this is payout code
#
# about a machine whose only problem was the absence of an interpreter. That
# is the worst sentence this file can produce: on launch night somebody reads
# "payout code fails" and stops the launch, and the tests were never run.
#
# Exit 2 is this project's convention for "the check could not run", and
# sweep.sh prints it in yellow as NOT RUN rather than as a finding. A missing
# runtime is that, and a passing verdict issued over zero executed tests would
# be worse than either.
if ! command -v node >/dev/null 2>&1; then
    unchecked "the pool's payout tests were NOT RUN: this host has no node.
           They are JavaScript, and node is installed on the host that runs
           the pool. Run this there, or install node here. It is not a pass,
           and it is not a failure of the payout code."
fi

# The adversarial one, which needs binaries and takes minutes, so it is here
# at the release gate rather than in the sweep. Every other solo test mines
# alone on regtest and always wins -- losing a race was unreachable by any gate
# we owned, which is why both of the solo miner's shipped faults were found by
# miners on mainnet rather than here.
if [ -n "${WAM_RELEASE_BINARIES:-}" ]; then
    run "a solo miner that loses a race is not told to stop" \
        bash scripts/test/test_solo_race.sh "$WAM_RELEASE_BINARIES"
else
    gate "the solo race is unchecked -- set WAM_RELEASE_BINARIES to the directory holding wamd, wam-cli and wam-miner"
fi

for t in pool/test/*.test.js; do
    [ -f "$t" ] || continue
    command -v node >/dev/null 2>&1 || continue
    node "$t" >/dev/null 2>&1 \
        && ok "$(basename "$t") passes" \
        || bad "$(basename "$t") FAILS -- this is payout code"
done

# AND THE EXPLORER'S, WHICH NOTHING RAN.
#
# explorer/test/ has held tests since mainnet opened and no script in this
# repository executed them, so they passed or failed to nobody. They cover the
# published concentration share -- the number a reader uses to decide whether
# this chain can be rewritten -- which is not a smaller thing than payout code.
for t in explorer/test/*.test.js; do
    [ -f "$t" ] || continue
    command -v node >/dev/null 2>&1 || continue
    node "$t" >/dev/null 2>&1 \
        && ok "$(basename "$t") passes" \
        || bad "$(basename "$t") FAILS -- this is the published share"
done

# ---------------------------------------------------------------------------
if [ -n "$HOST" ]; then
    sect "The running network"

    # What is this machine for?
    #
    # A seed node runs wamd and nothing else -- no pool, no dashboard, no
    # nginx -- and reporting six failures for services it was never meant to
    # have is a false alarm. This script says elsewhere that an operator shown
    # false alarms stops reading the real ones, so it has to know the
    # difference. The role is read from what is installed, not configured
    # anywhere, so a machine cannot drift from its own description.
    ROLE="seed"
    [ -n "$(rsh 'ls /etc/systemd/system/wam-pool.service 2>/dev/null')" ] && ROLE="full"
    printf '  %s%s%s node\n\n' "$BLD" "$ROLE" "$OFF"

    SERVICES="wamd"
    [ "$ROLE" = "full" ] && SERVICES="wamd wam-pool wam-dashboard wam-telegram nginx redis-server"

    for u in $SERVICES; do
        [ "$(rsh "systemctl is-active $u")" = "active" ] \
            && ok "$u is running" || bad "$u is not running"
    done

    # Reachability from outside, not a firewall rule that claims it.
    check_open() {
        if timeout 8 bash -c "exec 3<>/dev/tcp/$HOST/$1" 2>/dev/null; then
            ok "port $1 reachable from the internet -- $2"
        else
            bad "port $1 NOT reachable -- $2"
        fi
    }

    check_open 19555 "peer-to-peer, how the network is found"
    [ "$ROLE" = "full" ] && check_open 3333 "stratum"

    for spec in "19554 RPC, this is the wallet" "6379 redis, every miner balance"; do
        set -- $spec
        P="$1"; shift
        if timeout 8 bash -c "exec 3<>/dev/tcp/$HOST/$P" 2>/dev/null; then
            bad "port $P IS REACHABLE from the internet -- $*"
        else
            ok "port $P closed to the internet -- $*"
        fi
    done

    SEEDS=$(rsh 'wam-cli -conf=/root/.wam/wam.conf -datadir=/root/.wam getconnectioncount')
    [ "${SEEDS:-0}" -ge 1 ] 2>/dev/null \
        && ok "the node has $SEEDS peer(s)" \
        || bad "the node has no peers"
fi

# ---------------------------------------------------------------------------
sect "Single points of failure"

# Two nodes that disagree are worse than one node: the chain forks the moment
# either mines. On 2026-08-19 exactly that happened -- one node still enforced
# the pre-separation treasury address and rejected every block the other made,
# for hours, while both reported active and both reported /WAM:0.1.0/. Nothing
# a node says about itself can find this, so it is checked between nodes or
# not at all. Not passing --nodes is reported, never assumed harmless.
if [ -n "$NODES" ]; then
    bash scripts/check_nodes_agree.sh $NODES >/dev/null 2>&1
    AGREE_RC=$?
    # 0 agree, 1 they differ, 2 they were never compared. Collapsing 2 into
    # the else branch printed "the deployed nodes DISAGREE" for an ssh that
    # timed out -- and for a host list this script itself had mangled. Every
    # layer has to carry the distinction or the bottom one keeping it is
    # pointless.
    if [ "$AGREE_RC" -eq 0 ]; then
        ok "every deployed node runs the same binaries and the same chain"
    elif [ "$AGREE_RC" -eq 2 ]; then
        unchecked "the deployed nodes could not be compared -- run and read it:
           bash scripts/check_nodes_agree.sh $NODES"
    else
        bad "the deployed nodes DISAGREE -- run:
           bash scripts/check_nodes_agree.sh $NODES"
    fi
else
    gate "node agreement unchecked -- pass --nodes \"ip1 ip2\" to compare the
           deployed nodes against each other"
fi

if [ -n "$HOST" ]; then
    NSEEDS=$(dig +short x9.seed1.wamcoin.org A 2>/dev/null | sort -u | wc -l)
    if [ "$NSEEDS" -le 1 ]; then
        bad "only $NSEEDS seed address. If that machine stops, nobody new can
           join the network at all -- existing nodes survive on cached peers"
    else
        ok "$NSEEDS independent seed addresses"
    fi
fi

echo
echo "=================================================================="
printf ' %s%d passed%s   %s%d failed%s   %s%d NOT checked%s   %s%d gated on the key ceremony%s\n' \
    "$GRN" "$PASS" "$OFF" "$RED" "$FAIL" "$OFF" \
    "$YLW" "$UNCHECKED" "$OFF" "$YLW" "$GATE" "$OFF"
if [ "$UNCHECKED" -gt 0 ]; then
    echo
    echo ' The lines marked warn were not measured. They are not passes, and'
    echo ' launch day is not the moment to discover what they would have said.'
fi
echo "=================================================================="
[ "$FAIL" -eq 0 ] || exit 1
[ "$UNCHECKED" -eq 0 ] || exit 2
exit 0
