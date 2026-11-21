#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_release_matches.sh -- is the published download this network?
# ===========================================================================
#
#      bash scripts/check_release_matches.sh            # inspect the binary
#      bash scripts/check_release_matches.sh --source   # tag source only
#
#  WHY THIS EXISTS
#
#  v0.1.0 was tagged and published on 2026-08-15. Over the three days after
#  that, the founder reserve was locked, all three genesis blocks were
#  re-mined, and the treasury was given its own address. The published tarball
#  was never rebuilt. It stayed on the download page describing a different
#  network:
#
#      published mainnet genesis  bbbd737e...    source  d8d3debe...
#      published testnet genesis  b6668514...    source  ce81c20a...
#      published regtest genesis  1fa171c2...    source  b88f3d26...
#
#  A node from that tarball cannot connect to this network at all -- not a
#  version disagreement, a different chain. Someone downloaded it and mined
#  2,208 blocks on a history nobody else shares before anyone noticed.
#
#  WHAT IT CHECKS, AND WHY THAT WAY
#
#  Not the tag. The tag says what someone intended to build; it cannot say
#  what the artifact actually contains, and today's whole lesson is that those
#  differ. So this downloads the published binary and looks inside it for the
#  genesis hashes and treasury addresses that chainparams.cpp declares right
#  now. Those constants appear verbatim in the binary's read-only data, so
#  finding them needs no execution of a downloaded file.
#
#  --source additionally diffs the tagged tree against HEAD, which explains a
#  failure but can never substitute for looking at the artifact.
# ===========================================================================

set -uo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh" || exit 2

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
CHAINPARAMS="src/wam/chainparams.cpp"
REPO="wamcoin-Project/wam-coin"
ALSO_SOURCE=0

case "${1:-}" in
    --source) ALSO_SOURCE=1 ;;
    "") ;;
    *) printf 'usage: %s [--source]\n' "${0##*/}" >&2; exit 2 ;;
esac

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
FAIL=0
# Set when something could not be measured at all. It is deliberately separate
# from FAIL: "I could not look" and "I looked and it is wrong" are different
# answers, and a summary that shows them the same way teaches people to ignore
# both. Exit 2 is this project's word for the first one.
COULD_NOT_CHECK=0
ok()   { printf '  %sok%s     %s\n' "$GRN" "$OFF" "$*"; }
bad()  { printf '  %sFAIL%s   %s\n' "$RED" "$OFF" "$*"; FAIL=$((FAIL + 1)); }
warn() { printf '  %swarn%s   %s\n' "$YLW" "$OFF" "$*"; }

command -v curl >/dev/null 2>&1 || { echo 'curl is required' >&2; exit 2; }

echo "=================================================================="
echo " Does the published download match this source?"
echo "=================================================================="

# ---------------------------------------------------------------------------
# What this source says the chains are. Read from the file, never repeated
# here, so a re-mine cannot leave this script asserting a stale value.
# ---------------------------------------------------------------------------
mapfile -t WANT_GENESIS < <(
    grep -oE 'hashGenesisBlock == uint256S\("0x[0-9a-f]{64}"\)' "$CHAINPARAMS" 2>/dev/null \
        | grep -oE '[0-9a-f]{64}'
)
mapfile -t WANT_ADDR < <(
    grep -oE 'WAM_(TREASURY|FOUNDER)_ADDRESS_(MAINNET|TESTNET) = "[A-Za-z0-9]+"' "$CHAINPARAMS" 2>/dev/null \
        | grep -oE '"[A-Za-z0-9]+"' | tr -d '"'
)

if [ "${#WANT_GENESIS[@]}" -eq 0 ]; then
    bad "could not read a single genesis hash out of $CHAINPARAMS"
    echo; echo " Nothing was compared."; exit 1
fi
printf '\n%swhat this source declares%s\n' "$BLD" "$OFF"
for g in "${WANT_GENESIS[@]}"; do printf '    genesis  %s\n' "$g"; done
for a in "${WANT_ADDR[@]}"; do printf '    address  %s\n' "$a"; done

# ---------------------------------------------------------------------------
printf '\n%sthe published release%s\n' "$BLD" "$OFF"

# THE DOWNLOADS INDEX, NOT THE GITHUB API.
#
# This asked api.github.com and the sweep of 2026-09-26 reported "could not
# check" -- sixty unauthenticated calls an hour is the whole budget and a
# sweep spends them. The one check that asks whether the published download
# is this network was being silenced by somebody else's quota.
#
# Every page and every post sends people to wamcoin.org for the downloads,
# which is served from machines this project owns. That is what is examined,
# because that is what is fetched.
DOWNLOADS="https://wamcoin.org/downloads"
INDEX="$(curl -sSL -m 40 "$DOWNLOADS/" 2>/dev/null)"
if [ -z "$INDEX" ]; then
    bad "could not reach $DOWNLOADS -- the published artifact was NOT checked"
    echo; echo "=================================================================="
    exit 1
fi
NEWEST="$(printf '%s' "$INDEX" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -V -u | tail -1)"
VERINDEX="$(curl -sSL -m 40 "$DOWNLOADS/$NEWEST/" 2>/dev/null)"

# Every published wam-coin archive, not the first one alphabetically.
#
# This used to read one asset: the first whose name starts with wam-coin and
# ends in .tar.gz. That was the Linux tarball for as long as Linux was the
# only platform. On 12 September macOS joined the release and sorts ahead of
# it, so the single artifact this script examined became the arm64 Mac build
# -- and the Linux tarball that every seed and every Linux miner downloads
# stopped being examined at all, silently, by the script whose whole purpose
# is to ask whether the published download is this network.
#
# The order is deliberate: linux, then windows, then macOS, so that a link
# which dies halfway has already answered the question for the platform the
# servers run.
# The order is deliberate: linux, then windows, then macOS, so that a link
# which dies halfway has already answered the question for the platform the
# servers run.
# Exported, because the reader below runs in a process substitution and a
# prefix assignment does not reach a builtin's subshell.
export NEWEST DOWNLOADS
mapfile -t ASSETS < <(printf '%s' "$VERINDEX" | "$PY" -c "
import sys; sys.stdout.reconfigure(newline=chr(10))  # never a CR, on any platform
import re, sys, os
ver  = os.environ.get('NEWEST', '')
base = os.environ.get('DOWNLOADS', '') + '/' + ver
names = re.findall(r'href=\"([^\"/]+)\"', sys.stdin.read())
def rank(n):
    for i, k in enumerate(('linux', 'mingw', 'w64', 'darwin')):
        if k in n:
            return i
    return 9
out = [n for n in names
       if n.startswith('wam-coin') and (n.endswith('.tar.gz') or n.endswith('.zip'))]
# The size is not known from an index, and 0 means 'ask the transfer', which
# is what check_artifact already does when it is not told one.
for n in sorted(set(out), key=rank):
    print(ver, n, base + '/' + n, 0)
" 2>/dev/null)

if [ "${#ASSETS[@]}" -eq 0 ]; then
    warn "no published release carries a wam-coin archive -- nothing to contradict"
    echo; echo "=================================================================="
    [ "$FAIL" -eq 0 ]; exit
fi
TAG="${ASSETS[0]%% *}"
printf '    %s, %d published archive(s)\n' "$TAG" "${#ASSETS[@]}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# One artifact: download it, unpack it, and ask it the two questions -- does
# it carry this network, and will it start on an ordinary CPU.
# ---------------------------------------------------------------------------
check_artifact() {
    local name="$1" url="$2" want_size="${3:-0}"
    local d="$TMP/$name" bin got str isa_rc isa_reason isa_remote h http
    mkdir -p "$d"
    printf '\n%s%s%s\n' "$BLD" "$name" "$OFF"

    # -f matters. Without it curl writes the error PAGE into the file and
    # exits 0, so on 2026-09-14 this check downloaded 92 bytes of
    #
    #     <html><body><h1>504 Gateway Time-out</h1>
    #
    # unpacked nothing from it, found no wamd in nothing, and announced "the
    # published download is NOT this network -- anyone who downloads it gets a
    # node that cannot join" about the macOS archive. That archive is whole:
    # sha256 b0e5561c... matches the published SHA256SUMS and it carries
    # bin/wamd. A gateway between here and GitHub had timed out, and the
    # loudest sentence this script owns was spent on it.
    http="$(curl -fsSL -m 300 -o "$d/$name" -w '%{http_code}' "$url" 2>/dev/null)"
    if [ $? -ne 0 ]; then
        # Not a finding. This file argues the distinction itself further down:
        # exit 2 means the check could not run, and a fault that cannot be
        # measured must not look like a fault that was measured.
        #
        # A download that times out says nothing about the release. On
        # 11 September this went red on a link carrying 16 KB/s -- 963 KB of
        # an 11.7 MB tarball in sixty seconds -- and reported it as though the
        # published download were wrong. A red that appears every time because
        # of somebody's connection is a red that stops being read.
        got="$(wc -c < "$d/$name" 2>/dev/null || echo 0)"
        warn "NOT downloaded: HTTP ${http:-none}, $got byte(s) in 300s -- that
           is this connection or a gateway in front of GitHub, not the
           release. Run this check from one of the servers, or accept that it
           was not measured here."
        COULD_NOT_CHECK=1
        return 0
    fi

    # And an HTTP 200 that stops early is still not the file. GitHub tells us
    # how big each asset is; compare, before any sentence about its contents.
    got="$(wc -c < "$d/$name" 2>/dev/null || echo 0)"
    if [ "$want_size" -gt 0 ] && [ "$got" != "$want_size" ]; then
        warn "NOT examined: $got of $want_size byte(s) arrived. That is this
           connection, not the release."
        COULD_NOT_CHECK=1
        return 0
    fi

    case "$name" in
        *.tar.gz)
            tar -xzf "$d/$name" -C "$d" 2>/dev/null ;;
        *.zip)
            if command -v unzip >/dev/null 2>&1; then
                unzip -qo "$d/$name" -d "$d" 2>/dev/null
            else
                warn "NOT unpacked: unzip is not installed here, so the Windows
           archive was not examined"
                COULD_NOT_CHECK=1
                return 0
            fi ;;
    esac

    bin="$(find "$d" -type f \( -name 'wamd' -o -name 'wamd.exe' \) | head -1)"
    if [ -z "$bin" ]; then
        # With the right number of bytes in hand, ask the release's own
        # SHA256SUMS whether these are the right bytes. If they are, an
        # archive with no wamd is a real, published fault and says so. If
        # they are not, the copy here is damaged and this check has measured
        # nothing about the release.
        if [ -n "${PUBLISHED_SHA:-}" ] && command -v sha256sum >/dev/null 2>&1; then
            h="$(sha256sum "$d/$name" | cut -d' ' -f1)"
            if ! printf '%s' "$PUBLISHED_SHA" | grep -qF "$h"; then
                warn "NOT examined: the copy downloaded here does not match the
           release's own SHA256SUMS, so it is a damaged copy and not evidence
           about what is published."
                COULD_NOT_CHECK=1
                return 0
            fi
        fi
        bad "$name contains no wamd"
        return 0
    fi
    printf '    unpacked %s (%s bytes)\n' "${bin#"$d"/}" "$(stat -c%s "$bin")"

    str="$d/strings.txt"
    strings -n 24 "$bin" > "$str" 2>/dev/null || tr -cd '\11\12\15\40-\176' < "$bin" > "$str"

    for g in "${WANT_GENESIS[@]}"; do
        if grep -qF "$g" "$str"; then
            ok "carries genesis ${g:0:16}..."
        else
            bad "does NOT carry genesis ${g:0:16}... -- a node from this download
           is on a different chain and can never connect"
        fi
    done
    for a in "${WANT_ADDR[@]}"; do
        if grep -qF "$a" "$str"; then
            ok "carries address $a"
        else
            bad "does NOT carry $a -- it enforces a different consensus payout"
        fi
    done

    # Carrying the right chain is not the same as running at all. v0.1.2
    # carried every correct constant and died with SIGILL on the first CPU
    # without AVX-512, because the node links a RandomX that had been built
    # with ARCH=native on the machine that produced the release. The archive
    # is already unpacked here, so the question costs nothing to ask.
    bash "$HERE/scripts/check_isa_baseline.sh" "$(dirname "$bin")"/* >"$d/isa.log" 2>&1
    isa_rc=$?
    # check_isa_baseline.sh prints one `reason:` line whenever it could not
    # run, and that line is the only thing worth quoting. This used to be
    # `head -1 isa.log`, which quoted the box-drawing banner instead --
    # "the CPU baseline was NOT checked: ====================".
    isa_reason="$(sed -n 's/^reason: //p' "$d/isa.log" | head -1)"

    if [ "$isa_rc" -eq 0 ]; then
        ok "no instruction above the x86-64 baseline"
    elif [ "$isa_rc" -eq 1 ]; then
        sed -n '/^  [a-z]/p' "$d/isa.log" | sed 's/^/         /'
        bad "these binaries carry instructions many CPUs do not have"
    elif [ "$isa_reason" != "${isa_reason#*is not installed}" ] \
         && [ "${WAM_ALREADY_REMOTE:-0}" != "1" ] \
         && [ -f "$HERE/scripts/lib/elsewhere.sh" ]; then
        # The tool is not here. This check reads FILES, so it cannot be
        # shipped the way check_dns_seeds.sh is -- but the question can be
        # asked again where the tool lives, by fetching the same published
        # URL there and running that host's own checker against it. Same
        # artifact, same question.
        # shellcheck source=lib/elsewhere.sh
        . "$HERE/scripts/lib/elsewhere.sh"
        isa_remote=""
        for h in $WAM_TOOL_HOSTS; do
            isa_remote="$(timeout 300 ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o ConnectTimeout=20 "root@$h" "
                set -u
                command -v objdump >/dev/null 2>&1 || exit 3
                command -v file    >/dev/null 2>&1 || exit 3
                [ -f $WAM_REMOTE_REPO/scripts/check_isa_baseline.sh ] || exit 3
                D=\$(mktemp -d); trap 'rm -rf \"\$D\"' EXIT; cd \"\$D\"
                # -f for the same reason as the local download above: without
                # it a 504 page is written to disk and curl exits 0, and the
                # question gets answered about an error page.
                curl -fsSL --max-time 180 -O '$url' || exit 3
                case '$name' in
                    *.tar.gz) tar -xzf *.tar.gz || exit 3 ;;
                    *.zip)    command -v unzip >/dev/null 2>&1 || exit 3
                              unzip -qo *.zip   || exit 3 ;;
                esac
                bash $WAM_REMOTE_REPO/scripts/check_isa_baseline.sh \
                    \$(find \"\$D\" -type f -name 'wam*' ! -name '*.tar.gz' \
                       ! -name '*.zip' ! -name '*.md' ! -name '*.txt') >\"\$D/isa.log\" 2>&1
                rc=\$?
                sed -n 's/^reason: //p' \"\$D/isa.log\" | head -1
                exit \$rc
            " 2>/dev/null; echo "rc=$?")"
            # The remote's own reason comes back with it. Without this, a host
            # that answered "arm64, so the x86-64 baseline does not apply" was
            # indistinguishable from a host that could not be reached, and
            # both were reported as "no host could answer it either".
            case "${isa_remote##*rc=}" in
                0) ok "no instruction above the x86-64 baseline (checked on $h)"
                   break ;;
                1) bad "these binaries carry instructions many CPUs do not have
           (measured on $h)"
                   break ;;
                2) warn "the CPU baseline was NOT checked: $(printf '%s\n' "$isa_remote" \
                        | sed '$d' | head -1) (asked on $h)"
                   COULD_NOT_CHECK=1
                   isa_remote="answered"
                   break ;;
                *) isa_remote="" ;;        # this host has no tool: try the next
            esac
        done
        if [ -z "$isa_remote" ]; then
            warn "the CPU baseline was NOT checked: $isa_reason, and no host
           could answer it either"
            COULD_NOT_CHECK=1
        fi
    else
        # Anything that is not 0 and not 1 is the check saying it could not
        # run, and its own reason says why -- most often an arm64 build, for
        # which the x86-64 baseline is not a question at all.
        warn "the CPU baseline was NOT checked: ${isa_reason:-check_isa_baseline.sh exited $isa_rc}"
        COULD_NOT_CHECK=1
    fi
}

printf '\n%sdoes each published archive carry this network?%s\n' "$BLD" "$OFF"

# The checksums a user is told to verify against. Fetched once, and its
# absence is not fatal: it is only used to tell a damaged download from a
# damaged release, above.
PUBLISHED_SHA="$(curl -fsSL -m 60 \
    "https://github.com/$REPO/releases/download/$TAG/SHA256SUMS" 2>/dev/null)"
[ -n "$PUBLISHED_SHA" ] || printf '    (SHA256SUMS was not fetched)\n'

for _row in "${ASSETS[@]}"; do
    check_artifact "$(printf '%s' "$_row" | cut -d' ' -f2)" \
                   "$(printf '%s' "$_row" | cut -d' ' -f3)" \
                   "$(printf '%s' "$_row" | cut -d' ' -f4)"
done

# ---------------------------------------------------------------------------
if [ "$ALSO_SOURCE" -eq 1 ] && [ -n "${TAG:-}" ]; then
    printf '\n%swhat changed since the tag%s\n' "$BLD" "$OFF"
    if git rev-parse -q --verify "$TAG^{commit}" >/dev/null 2>&1; then
        N="$(git log --oneline "$TAG..HEAD" -- src/ 2>/dev/null | wc -l)"
        if [ "$N" -eq 0 ]; then
            ok "no commit has touched src/ since $TAG"
        else
            bad "$N commit(s) changed src/ since $TAG:"
            git log --oneline "$TAG..HEAD" -- src/ 2>/dev/null | sed 's/^/           /'
        fi
    else
        warn "$TAG is not a commit in this clone -- fetch tags to compare"
    fi
fi

echo
echo "=================================================================="
if [ "$FAIL" -ne 0 ]; then
    printf ' %sthe published download is NOT this network%s\n' "$RED" "$OFF"
    echo
    echo ' Anyone who downloads it gets a node that cannot join. Rebuild and'
    echo ' republish from current source before telling anyone to download it.'
    echo "=================================================================="
    exit 1
fi
if [ "$COULD_NOT_CHECK" -ne 0 ]; then
    printf ' %severything asked matched -- but not everything could be asked%s\n' "$YLW" "$OFF"
    echo
    echo ' The lines marked warn above were not measured. They are not passes.'
    echo "=================================================================="
    exit 2
fi
printf ' %sthe published download is this network%s\n' "$GRN" "$OFF"
echo "=================================================================="
exit 0
