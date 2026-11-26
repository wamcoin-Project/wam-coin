#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  stranger.sh -- install and run the release the way somebody who has never
#                 seen this repository does, and measure what happens
# ===========================================================================
#
#      bash scripts/test/stranger.sh v0.1.15
#      bash scripts/test/stranger.sh v0.1.16 --from ~/wam-release-staging
#      bash scripts/test/stranger.sh v0.1.15 --keep
#
#  WHY THIS EXISTS
#
#  v0.1.15 passed a release gate, a repository sweep, four test suites and a
#  three-agent pre-release review, and then two readers sent twenty-eight
#  defects in the code it had just shipped.
#
#  Every one of their reports carried a number. 502 MB of resident memory on
#  a reply the miner accepted. Zero of three hundred API requests refused.
#  getBlock called zero times on a path whose own comment said it detects
#  reorganisations. A verifier printing "unmodified since it was signed" over
#  four unsigned files, measured with a throwaway key.
#
#  Every one of our own checks carried an argument.
#
#  The difference is not cleverness and it is not care. They RAN it. We read
#  it. This runs it.
#
#  WHAT IT REFUSES TO ASSUME
#
#  Nothing from the working tree is on PATH. The binaries come out of the
#  published archives, the verification is the script the website hands a
#  stranger, and the chain is made from nothing in a directory this script
#  created. Where it cannot avoid the checkout -- the pool and the explorer
#  are JavaScript in this repository and are not in the archives -- it runs
#  them against that node and nothing else.
#
#  Every assertion here is a number or an exit status. Where it cannot
#  measure something it prints `skip` and names what it skipped. A skip is a
#  gap in the evidence and is meant to be read as one.
#
#  WHAT IT DELIBERATELY DOES NOT DO
#
#  It hashes nothing. `wam-miner --check` builds one block from the node's
#  template, asks the node whether it would accept it, and exits -- its help
#  text says "Hashes nothing", which is the whole reason this harness can use
#  it. Proof of work is proved on hardware this project owns, by
#  scripts/test/test_platform_solo.sh. A miner on somebody else's CI is what
#  suspended this project's GitHub account on 2026-09-24 and took the website
#  and every download link with it, on release day.
#
#  It touches no mainnet host, no live pool, no live explorer, and no wallet
#  holding anything. Every service it starts is bound to the loopback against
#  a regtest chain, with credentials generated for this one run, and is shut
#  down on the way out.
# ===========================================================================

set -uo pipefail

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; DIM=$'\033[2m'
BLD=$'\033[1m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then GRN=; RED=; YLW=; DIM=; BLD=; OFF=; fi

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
VERSION=""
FROM=""
KEEP=0
BASE="${WAM_SITE_URL:-https://wamcoin.org}"

while [ $# -gt 0 ]; do
    case "$1" in
        --from) FROM="${2:?--from needs a directory}"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        --site) BASE="${2:?--site needs a URL}"; shift 2 ;;
        -h|--help) sed -n '5,57p' "$0"; exit 0 ;;
        -*) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
        *)  VERSION="$1"; shift ;;
    esac
done
[ -n "$VERSION" ] || { printf 'usage: %s vX.Y.Z [--from DIR] [--keep]\n' "$0" >&2; exit 2; }
case "$VERSION" in v*) : ;; *) VERSION="v$VERSION" ;; esac

PASS=0
FAILED=()
SKIPPED=0

ok()   { PASS=$((PASS+1)); printf '  %sok%s    %s\n' "$GRN" "$OFF" "$*"; }
bad()  { FAILED+=("$1"); printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$1"
         shift || true; for l in "$@"; do printf '        %s\n' "$l"; done; }
skip() { SKIPPED=$((SKIPPED+1)); printf '  %sskip%s  %s\n' "$YLW" "$OFF" "$*"; }
step() { printf '\n%s%s%s\n\n' "$BLD" "$*" "$OFF"; }
last3(){ tail -n 3 "$1" 2>/dev/null | tr '\n' ' ' | cut -c1-240; }

# WHY A CRASH IS REPORTED FROM THE TOP AND NOT THE TAIL.
#
# `the pool did not come up` came back twice with the useless end of a Node
# stack trace -- "at Module._compile ... Node.js v20.20.2" -- and the line
# that said `Cannot find module 'ioredis'` was four lines above the window.
# A diagnostic that truncates the only sentence naming the cause costs
# another full run to recover, every time.
first_error() {
    awk 'NF' "$1" 2>/dev/null \
        | grep -vE '^\s+at |^gyp |^make(\[|:)' \
        | head -n 4 | tr '\n' ' ' | cut -c1-300
}

# DOWNLOAD, AND LEAVE NOTHING BEHIND ON FAILURE.
#
# Two defects of this harness's own, both found by running it:
#
# A flat `--max-time` fails a transfer that is merely slow. The first run cut
# off a 20 MB archive at ten minutes on a 35 kB/s link and called a working
# download page broken. What should fail is a transfer that has STOPPED, so
# the test is a floor on rate over a window -- under 1 kB/s for sixty
# seconds and it is dead -- with an outer cap only so nothing hangs for ever.
#
# And curl -o leaves the partial file where it fell. A truncated archive in
# the directory makes `sha256sum -c` report FAILED, so the next step would
# have blamed verify_release.sh for refusing an honest download. Each file
# lands on a .part and is moved into place only when curl says it is whole.
fetch() {
    local url="$1" out="$2"
    if curl -fsSL --retry 2 --retry-delay 2 \
            --speed-limit 1024 --speed-time 60 --max-time 3600 \
            -o "$out.part" "$url"; then
        mv -- "$out.part" "$out"
        return 0
    fi
    rm -f -- "$out.part"
    return 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wam-stranger-XXXXXX")" || exit 1
NODE_PID=""; POOL_PID=""; EXPLORER_PID=""; REDIS_PID=""

cleanup() {
    # The node first and gently: killing wamd with -9 leaves a dirty leveldb,
    # and a harness that corrupts its own fixture tells you nothing the second
    # time you run it.
    [ -n "$NODE_PID" ] && kill -TERM "$NODE_PID" 2>/dev/null
    for p in "$POOL_PID" "$EXPLORER_PID" "$REDIS_PID"; do
        [ -n "$p" ] && kill -TERM "$p" 2>/dev/null
    done
    for _ in $(seq 1 15); do
        [ -n "$NODE_PID" ] || break
        kill -0 "$NODE_PID" 2>/dev/null || break
        sleep 1
    done
    for p in "$NODE_PID" "$POOL_PID" "$EXPLORER_PID" "$REDIS_PID"; do
        [ -n "$p" ] && kill -9 "$p" 2>/dev/null
    done
    if [ "$KEEP" = 1 ]; then
        printf '\n%skept: %s%s\n' "$DIM" "$WORK" "$OFF"
    else
        rm -rf -- "$WORK"
    fi
}
trap cleanup EXIT INT TERM

printf '\n=================================================================\n'
printf ' %sa stranger installs %s%s\n' "$BLD" "$VERSION" "$OFF"
printf '=================================================================\n'
printf '%s %s%s\n' "$DIM" "$WORK" "$OFF"

for t in curl gpg tar sha256sum awk; do
    command -v "$t" >/dev/null 2>&1 || {
        printf '\n%sthis harness needs %s and it is not here%s\n' "$RED" "$t" "$OFF"
        exit 2
    }
done

# ---------------------------------------------------------------------------
step "1. he gets the files"

DL="$WORK/download"
mkdir -p "$DL"

if [ -n "$FROM" ]; then
    # A candidate that is not published yet. The only use of a local path, and
    # it is named on the command line so nobody reaches for the build tree by
    # accident and then believes they tested a release.
    if [ -d "$FROM" ]; then
        cp -- "$FROM"/* "$DL"/ 2>/dev/null
        n="$(find "$DL" -maxdepth 1 -type f | wc -l)"
        if [ "$n" -gt 0 ]; then ok "took $n files from $FROM"
        else bad "$FROM held nothing"; fi
    else
        bad "--from $FROM is not a directory"
    fi
    cp -- "$ROOT/scripts/verify_release.sh" "$DL/" 2>/dev/null
    cp -- "$ROOT/SIGNING-KEY.asc" "$DL/" 2>/dev/null
    skip "the verifier and the signing key came from the checkout (--from)"
else
    for f in SHA256SUMS SHA256SUMS.asc; do
        if fetch "$BASE/downloads/$VERSION/$f" "$DL/$f"; then
            ok "$f"
        else
            bad "$BASE/downloads/$VERSION/$f did not answer" \
                "A reader following our own announcement gets nothing here."
        fi
    done

    # Where every announcement sends the reader for the two files that make
    # verification possible at all. If these URLs are broken nobody can
    # verify, however good the script in this repository is.
    if fetch "$BASE/verify_release.sh" "$DL/verify_release.sh"
    then ok "verify_release.sh, from the website"
    else bad "$BASE/verify_release.sh does not serve the verifier" \
             "Every announcement tells the reader to fetch it from there."; fi
    if fetch "$BASE/SIGNING-KEY.asc" "$DL/SIGNING-KEY.asc"
    then ok "SIGNING-KEY.asc, from the website"
    else bad "$BASE/SIGNING-KEY.asc does not serve the signing key"; fi

    # WHAT IS PULLED, AND WHAT IS ONLY ASKED ABOUT.
    #
    # The Linux node and miner are downloaded, because this harness runs
    # them. Every other file in the signed list -- the Windows and macOS
    # archives, the Qt wallet -- is asked for with a HEAD and judged on the
    # status and the length, because pulling 60 MB this script cannot
    # execute proves only that the URL works, and `check_release_ready.sh`
    # already pulls every one of them in the step above.
    #
    # A HEAD is still the measurement that belongs here: it is the URL a
    # reader follows, over the same network, with nothing from this
    # repository in the way.
    if [ -s "$DL/SHA256SUMS" ]; then
        while read -r _ name; do
            name="${name#\*}"
            [ -n "$name" ] || continue
            case "$name" in
              wam-coin-*x86_64-linux-gnu.tar.gz|wam-miner-*x86_64-linux-gnu.tar.gz)
                if fetch "$BASE/downloads/$VERSION/$name" "$DL/$name"; then
                    ok "$name"
                else
                    bad "$name is in the signed list and did not download" \
                        "The list is signed, so this is a download page" \
                        "missing a file the signature says is part of the" \
                        "release."
                fi
                ;;
              *)
                head="$(curl -sI --max-time 60 "$BASE/downloads/$VERSION/$name")"
                code="$(printf '%s' "$head" | awk '/^HTTP/ {print $2}' | tail -1)"
                len="$(printf '%s' "$head" \
                       | awk 'BEGIN{IGNORECASE=1} /^content-length:/ {gsub(/\r/,""); print $2}' \
                       | tail -1)"
                if [ "${code:-0}" = 200 ] && [ "${len:-0}" -gt 1000 ] 2>/dev/null; then
                    ok "$name is served ($((len / 1024)) KiB) -- not fetched"
                else
                    bad "$name is in the signed list and the URL is not serving it" \
                        "HTTP ${code:-none}, content-length ${len:-none}."
                fi
                ;;
            esac
        done < "$DL/SHA256SUMS"
    fi
fi

# ---------------------------------------------------------------------------
step "2. he verifies them, and the verifier is awake"

if [ -s "$DL/verify_release.sh" ] && [ -s "$DL/SHA256SUMS" ]; then
    if ( cd "$DL" && bash verify_release.sh . ) >"$WORK/verify.log" 2>&1; then
        # Its own count, not a claim of ours: `sha256sum --ignore-missing`
        # passes a directory holding one file, so "it verified" without a
        # number does not say how much was verified.
        ok "the release verifies -- $(grep -oE '[0-9]+ file\(s\) match' \
             "$WORK/verify.log" | head -1)"
    else
        bad "verify_release.sh refused an honest download" \
            "$(last3 "$WORK/verify.log")"
    fi

    # A verifier that accepts everything is not a verifier, and this has now
    # been missing twice: from the .ps1 entirely, and from the .sh for every
    # name outside three globs in the top directory. So it is re-proved on
    # every run, with the three shapes that got through: a name nobody would
    # glob for, a dotfile, and one in a subdirectory.
    mkdir -p "$DL/sub"
    printf 'not ours\n' > "$DL/evil-setup.exe"
    printf 'not ours\n' > "$DL/.hidden.tar.gz"
    printf 'not ours\n' > "$DL/sub/wam-coin-$VERSION-x86_64-linux-gnu.tar.gz"
    # AND A NAME WITH A NEWLINE IN IT, whose second line is a name the list
    # really does carry. grep -F splits its pattern on newlines, so the
    # widened check still read this as listed and the script printed
    # "unmodified since it was signed" over it. Measured by mpit,
    # 26 November 2026 -- the second hole in the same check, four days after
    # the first. Planted here because the hole was in the fix for the hole.
    NEWLINE_EVIL="$(printf 'evil-payload.exe\nwam-coin-%s-x86_64-linux-gnu.tar.gz' "$VERSION")"
    printf 'not ours\n' > "$DL/$NEWLINE_EVIL" 2>/dev/null || NEWLINE_EVIL=""
    if ( cd "$DL" && bash verify_release.sh . ) >"$WORK/verify-hostile.log" 2>&1; then
        bad "the verifier accepted unsigned files sitting in the release" \
            "evil-setup.exe, a dotfile, one in a subdirectory, and a name" \
            "carrying a newline. SHA256SUMS.asc covers none of them, and it" \
            "said the release was unmodified since it was signed. This is" \
            "the hostile-mirror case."
    else
        ok "it refuses unsigned files beside the release (any name, any depth)"
    fi
    [ -n "$NEWLINE_EVIL" ] && rm -f -- "$DL/$NEWLINE_EVIL"
    rm -rf -- "$DL/evil-setup.exe" "$DL/.hidden.tar.gz" "$DL/sub"

    # ONE AT A TIME, because four planted files prove only that the check
    # caught at least one of them. The first version of this planted three
    # and would have passed with two of the three invisible.
    for shape in "evil-setup.exe" ".hidden.tar.gz" \
                 "sub/wam-coin-$VERSION-x86_64-linux-gnu.tar.gz" \
                 "NEWLINE"; do
        if [ "$shape" = "NEWLINE" ]; then
            [ -n "$NEWLINE_EVIL" ] || { skip "this filesystem refuses a newline in a name"; continue; }
            target="$NEWLINE_EVIL"
            label="a name carrying a newline"
        else
            target="$shape"
            label="$shape"
        fi
        mkdir -p "$(dirname "$DL/$target")" 2>/dev/null
        printf 'not ours\n' > "$DL/$target" 2>/dev/null
        if ( cd "$DL" && bash verify_release.sh . ) >/dev/null 2>&1; then
            bad "the verifier accepted an unsigned file: $label"
        else
            ok "refused on its own: $label"
        fi
        rm -f -- "$DL/$target"
        rm -rf -- "$DL/sub"
    done
else
    skip "there is nothing to verify, so the verifier was not exercised"
fi

# ---------------------------------------------------------------------------
step "3. he unpacks it and asks what it is"

BIN="$WORK/bin"
EXTRACT="$WORK/extract"
mkdir -p "$BIN" "$EXTRACT"
for a in "$DL"/*x86_64-linux-gnu.tar.gz; do
    [ -e "$a" ] || continue
    tar -xzf "$a" -C "$EXTRACT" 2>/dev/null
done
find "$EXTRACT" -type f \( -name 'wamd' -o -name 'wam-cli' -o -name 'wam-miner' \) \
     -exec cp -- {} "$BIN/" \; 2>/dev/null
chmod +x "$BIN"/* 2>/dev/null

if [ -x "$BIN/wamd" ]; then
    said="$("$BIN/wamd" -version 2>/dev/null | head -1)"
    if printf '%s' "$said" | grep -qF "$VERSION"; then
        ok "wamd says $VERSION"
    else
        bad "wamd reports \"$said\", not $VERSION" \
            "This is the failure that is silent in the direction that counts:" \
            "a tree patched before a version bump compiles, passes every" \
            "test, and produces a binary carrying the old number."
    fi
else
    bad "there is no wamd in the archives" "got: $(ls "$DL" | tr '\n' ' ')"
fi
[ -x "$BIN/wam-miner" ] || bad "there is no wam-miner in the archives"

# WHAT IT ASKS OF HIS MACHINE, which is why the Linux miner ships without
# TLS: a binary naming a library he does not have gives him a loader error
# and no way to learn which package holds it.
for b in wamd wam-cli wam-miner; do
    [ -x "$BIN/$b" ] || continue
    out="$(ldd "$BIN/$b" 2>/dev/null)"
    missing="$(printf '%s\n' "$out" | awk '/not found/ {print $1}' | tr '\n' ' ')"
    extra="$(printf '%s\n' "$out" | awk '{print $1}' | grep -E '^lib' \
             | grep -vE '^lib(c|m|dl|pthread|rt|stdc\+\+|gcc_s|atomic)\.so' \
             | tr '\n' ' ')"
    if [ -n "$missing" ]; then
        bad "$b needs a library this machine does not have: $missing"
    elif [ -n "$extra" ]; then
        bad "$b asks a stranger's machine for: $extra" \
            "Build it through depends/ so the binary carries what it needs."
    else
        ok "$b needs nothing but the base system"
    fi
done

# ---------------------------------------------------------------------------
step "4. he starts a node from nothing"

DATADIR="$WORK/data"
mkdir -p "$DATADIR"
RPCUSER="stranger"
RPCPASS="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
# In a file, not on the command line: /proc/<pid>/cmdline is world-readable
# and /proc/<pid>/environ is not. The same reason install.sh stopped passing
# these as arguments.
( umask 077; cat > "$DATADIR/wam.conf" <<CONF
rpcuser=$RPCUSER
rpcpassword=$RPCPASS
CONF
)

NODE_UP=0
if [ -x "$BIN/wamd" ] && [ -x "$BIN/wam-cli" ]; then
    "$BIN/wamd" -regtest -datadir="$DATADIR" -server=1 -listen=0 -dnsseed=0 \
                -printtoconsole=0 >"$WORK/node.log" 2>&1 &
    NODE_PID=$!
    for _ in $(seq 1 90); do
        if "$BIN/wam-cli" -regtest -datadir="$DATADIR" getblockchaininfo \
             >"$WORK/chaininfo.json" 2>/dev/null; then NODE_UP=1; break; fi
        kill -0 "$NODE_PID" 2>/dev/null || break
        sleep 1
    done
    if [ "$NODE_UP" = 1 ]; then
        ok "the node came up from an empty datadir and answers RPC"
    else
        bad "the node did not answer within ninety seconds" \
            "$(last3 "$DATADIR/regtest/debug.log")" \
            "$(last3 "$WORK/node.log")"
    fi
else
    skip "no node binaries, so nothing was started"
fi

# ---------------------------------------------------------------------------
step "5. he points the miner at it"

if [ -x "$BIN/wam-miner" ]; then
    if "$BIN/wam-miner" --self-test --no-colour >"$WORK/selftest.log" 2>&1; then
        ok "the miner's self-test passes on this machine"
    else
        bad "the miner's self-test failed" "$(first_error "$WORK/selftest.log")"
    fi
fi

if [ "$NODE_UP" = 1 ] && [ -x "$BIN/wam-miner" ]; then
    "$BIN/wam-cli" -regtest -datadir="$DATADIR" -named createwallet \
        wallet_name=stranger >/dev/null 2>&1
    MINE_ADDR="$("$BIN/wam-cli" -regtest -datadir="$DATADIR" \
                 -rpcwallet=stranger getnewaddress 2>/dev/null)"
    if [ -n "$MINE_ADDR" ]; then
        # --check implies --solo and hashes nothing: it builds one block from
        # the template and asks the node whether it is valid. See the header.
        if "$BIN/wam-miner" --check -u "$MINE_ADDR" --network regtest \
             --rpcuser "$RPCUSER" --rpcpassword "$RPCPASS" --no-colour \
             >"$WORK/check.log" 2>&1; then
            ok "the block this miner builds is one this node accepts"
        else
            bad "the node rejected the block the miner built" \
                "This is the pair that has to agree and is built separately:" \
                "the node from upstream plus our patches, the miner from" \
                "miner/src. Nothing else in the suite runs them together." \
                "$(first_error "$WORK/check.log")"
        fi
    else
        skip "no wallet address -- is this node built with wallet support?"
    fi

    # THE TEST THAT NEEDS A NODE, RUN WHERE THERE IS ONE.
    #
    # miner/test/solo_jobs_test.cpp holds down a paid finding: a miner that
    # solved height 7838 after ninety-nine seconds could not submit it,
    # because the job it was still hashing had been thrown away. It needs a
    # regtest node, so scripts/test_miner.sh cannot run it and now says so
    # instead of leaving it out -- for weeks it was in neither place, and a
    # test nobody runs is green because nobody asked it.
    #
    # Here there is a node, three steps above, with its credentials to hand.
    if command -v g++ >/dev/null 2>&1 && [ -f "$ROOT/miner/test/solo_jobs_test.cpp" ]
    then
        if g++ -std=c++17 -I "$ROOT/miner/src" -O1 -pthread \
               -o "$WORK/solo_jobs_test" "$ROOT/miner/test/solo_jobs_test.cpp" \
               >"$WORK/solojobs.build.log" 2>&1; then
            # No cookie exists: this node has an rpcpassword, so Core writes
            # none. The user and password go in as arguments 3 and 4.
            if ( cd "$WORK" && timeout 180 ./solo_jobs_test 29554 "" \
                 "$RPCUSER" "$RPCPASS" ) >"$WORK/solojobs.log" 2>&1; then
                ok "a job a worker still holds is still held (solo_jobs_test)"
            else
                bad "solo_jobs_test failed against this node" \
                    "$(first_error "$WORK/solojobs.log")"
            fi
        else
            skip "solo_jobs_test did not build here"
        fi
    else
        skip "no g++, so solo_jobs_test was not run"
    fi
fi

# ---------------------------------------------------------------------------
step "6. the explorer he is sent to"

# Not shipped in the archives -- JavaScript in this repository -- so it runs
# from the checkout, but against the node above and nothing else.
if command -v node >/dev/null 2>&1 && [ "$NODE_UP" = 1 ]; then
    cat > "$WORK/explorer.json" <<JSON
{ "port": 18099, "bind": "127.0.0.1", "pollSeconds": 3600,
  "siteName": "stranger", "logLevel": "error",
  "explorerRequestsPerMinute": 5,
  "seedHostnames": [],
  "rpc": { "host": "127.0.0.1", "port": 29554, "user": "$RPCUSER",
           "password": "$RPCPASS", "ssl": false, "timeout": 5000 } }
JSON
    WAM_SEEN_FILE="$WORK/seen.json" WAM_SEEN_SALT="$WORK/seen.salt" \
        node "$ROOT/explorer/server.js" --config "$WORK/explorer.json" \
        >"$WORK/explorer.log" 2>&1 &
    EXPLORER_PID=$!
    eup=0
    for _ in $(seq 1 30); do
        curl -fs --max-time 5 -o /dev/null "http://127.0.0.1:18099/api/health" \
            && { eup=1; break; }
        kill -0 "$EXPLORER_PID" 2>/dev/null || break
        sleep 1
    done
    if [ "$eup" != 1 ]; then
        bad "the explorer did not come up against a working node" \
            "$(first_error "$WORK/explorer.log")"
    else
        ok "the explorer answers"

        # CONTENT BEFORE THE LIMIT, AND THE ORDER IS THE POINT.
        #
        # This check used to sit after the two rate-limit loops, and once the
        # limiter actually started working it read its own 429 body and
        # reported "/api/status answered without chain data". The harness had
        # spent the bucket proving the limit and then asked a question the
        # limit was bound to refuse. Anything that reads a reply comes first.
        body="$(curl -s --max-time 10 "http://127.0.0.1:18099/api/status")"
        if printf '%s' "$body" | grep -q '"blocks"'; then
            ok "/api/status carries chain data, not an empty envelope"
        else
            bad "/api/status answered without chain data" \
                "$(printf '%s' "$body" | cut -c1-200)"
        fi

        # THE LIMIT, MEASURED. Radenlingga's report was a count -- three
        # hundred requests, none refused -- so this is a count.
        got429=0
        for i in $(seq 1 12); do
            c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
                 "http://127.0.0.1:18099/api/status?n=$i")"
            [ "$c" = 429 ] && got429=$((got429+1))
        done
        if [ "$got429" -gt 0 ]; then
            ok "it refuses a caller who will not stop ($got429 of 12 got 429)"
        else
            bad "twelve requests against a limit of five, none refused" \
                "An unauthenticated caller can keep the node answering" \
                "explorer RPCs at whatever rate they choose."
        fi

        # AND THE OTHER HALF OF THE SAME RULE, which nothing tested: the
        # limiter must NOT refuse /api/health, or it breaks the monitoring
        # that exists to notice the explorer is in trouble. A limiter that
        # refuses the health check turns a slow page into a page everything
        # reports as down.
        health429=0
        for i in $(seq 1 12); do
            c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
                 "http://127.0.0.1:18099/api/health?n=$i")"
            [ "$c" = 429 ] && health429=$((health429+1))
        done
        if [ "$health429" = 0 ]; then
            ok "and it never refuses /api/health, which monitoring polls"
        else
            bad "the limiter refused the health endpoint $health429 times" \
                "Every monitor on a one-minute timer now reports the explorer" \
                "as down, which is the alarm this was supposed to protect."
        fi

    fi
else
    skip "node(1) or the chain is missing, so the explorer was not run"
fi

# ---------------------------------------------------------------------------
step "7. the pool he is sent to"

# THE POOL'S TWO PREREQUISITES, BUILT THE WAY install.sh BUILDS THEM.
#
# The pool is not in the release archives and a fresh checkout cannot run
# it: node_modules is gitignored, and pool/native is a C++ addon that has to
# be compiled against librandomx. Two runs of this harness reported "the
# pool did not come up" for exactly those two reasons, one after the other.
#
# Reporting a missing prerequisite as a product defect is a lie, and
# skipping the pool for ever protects nothing -- the pool is the component
# most of the reports have been about. So it builds them, with install.sh's
# own commands (its lines 509 and 515-518), once; both results are cached in
# the tree where install.sh leaves them, so later runs find them and skip
# straight past.
POOL_DEPS=1

if [ ! -d "$ROOT/pool/node_modules/ioredis" ]; then
    if command -v npm >/dev/null 2>&1; then
        printf '  %s....%s  installing the pool dependencies (first run only)\n' \
               "$DIM" "$OFF"
        # npm ci, which is install.sh's line and is the point: it installs
        # exactly what package-lock.json pins and refuses anything whose
        # integrity hash does not match. It also writes nothing back, so a
        # test run cannot change what the next machine installs -- which an
        # earlier version of this harness did, leaving a lockfile behind
        # generated on one laptop on one afternoon.
        if ( cd "$ROOT/pool" && npm ci --omit=dev --silent ) \
             >"$WORK/npm.log" 2>&1; then
            ok "pool dependencies installed"
        else
            POOL_DEPS=0
            bad "npm ci failed in pool/, so the pool could not be run" \
                "$(first_error "$WORK/npm.log")"
        fi
    else
        POOL_DEPS=0
        skip "npm is missing and pool/node_modules is empty: the pool was not run"
    fi
fi

if [ "$POOL_DEPS" = 1 ] \
   && ! node -e 'require("'"$ROOT"'/pool/native")' >/dev/null 2>&1; then
    RANDOMX_A="$ROOT/build/randomx/build/librandomx.a"
    if [ ! -f "$RANDOMX_A" ]; then
        POOL_DEPS=0
        skip "librandomx.a is not built, so the pool was not run" \
             "bash scripts/fetch-upstream.sh builds it"
    elif ! command -v npx >/dev/null 2>&1; then
        POOL_DEPS=0
        skip "npx is missing, so the pool's native addon was not built"
    else
        printf '  %s....%s  building the pool RandomX addon (first run only)\n' \
               "$DIM" "$OFF"
        if ( cd "$ROOT/pool/native" \
             && RANDOMX_INCLUDE="$ROOT/build/randomx/src" \
                RANDOMX_LIB="$RANDOMX_A" \
                npx node-gyp rebuild --silent ) >"$WORK/gyp.log" 2>&1; then
            ok "pool RandomX addon built"
        else
            POOL_DEPS=0
            bad "the pool's native addon did not build" \
                "$(first_error "$WORK/gyp.log")"
        fi
    fi
fi

if [ "$POOL_DEPS" = 1 ] && command -v node >/dev/null 2>&1 \
   && command -v redis-server >/dev/null 2>&1 && [ "$NODE_UP" = 1 ]; then
    # REDIS GETS A PASSWORD, BECAUSE THE POOL REFUSES TO START WITHOUT ONE.
    #
    # It is right to: redis holds the miner balances, and an unauthenticated
    # redis on the same machine lets anything running there rewrite who is
    # owed what. The pool says so and exits. A throwaway instance for a test
    # is no exception -- a harness that weakened the rule to get past it
    # would be testing a pool nobody runs.
    REDISPASS="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    redis-server --port 16399 --bind 127.0.0.1 --save '' --appendonly no \
                 --requirepass "$REDISPASS" \
                 --dir "$WORK" >"$WORK/redis.log" 2>&1 &
    REDIS_PID=$!
    rup=0
    for _ in $(seq 1 20); do
        REDISCLI_AUTH="$REDISPASS" redis-cli -p 16399 ping >/dev/null 2>&1 \
            && { rup=1; break; }
        sleep 1
    done

    "$BIN/wam-cli" -regtest -datadir="$DATADIR" -named createwallet \
        wallet_name=pool >/dev/null 2>&1
    POOL_ADDR="$("$BIN/wam-cli" -regtest -datadir="$DATADIR" -rpcwallet=pool \
                 getnewaddress 2>/dev/null)"

    if [ "$rup" != 1 ]; then
        skip "redis would not start, so the pool was not run"
    elif [ -z "$POOL_ADDR" ]; then
        skip "no pool wallet address, so the pool was not run"
    else
        cat > "$WORK/pool.json" <<JSON
{ "network": "regtest", "poolAddress": "$POOL_ADDR",
  "coinbaseSignature": "/stranger/", "rewardMode": "pplns",
  "poolFeePercent": 1.0, "minimumPayoutWam": 1.0, "txFeeReserveWam": 0.01,
  "maxPaymentRecipients": 200, "maxWamPerPaymentBatch": 100000,
  "paymentJournal": "$WORK/payments.journal",
  "paymentIntervalSec": 86400, "blockCheckIntervalSec": 86400,
  "coinbaseMaturity": 100, "startDifficulty": 0.00001,
  "varDiff": { "targetTime": 15, "retargetTime": 90, "variancePercent": 30,
               "minDiff": 0.000001, "maxDiff": 1000, "maxJump": 4 },
  "ports": [ { "port": 13333, "difficulty": 0.000005, "description": "test" } ],
  "bindAddress": "127.0.0.1", "publicHost": "127.0.0.1",
  "maxConnections": 50, "maxMessagesPer10s": 240, "banDurationMs": 1000,
  "exposeMinerIps": false, "blockRefreshInterval": 1000,
  "jobRebroadcastTimeout": 55, "maxJobHistory": 4,
  "randomxFullMemory": false, "randomxVmCount": 1,
  "apiPort": 18080, "apiBind": "127.0.0.1", "apiCacheMs": 0,
  "apiCorsOrigin": "", "apiRequestsPerMinute": 5, "apiLookupsPerMinute": 3,
  "apiRateCallers": 4096, "apiTrustProxy": false,
  "apiUntrustedProxyFactor": 1, "hashrateWindowSec": 600,
  "redis": { "host": "127.0.0.1", "port": 16399, "db": 0,
             "password": "$REDISPASS" },
  "redisPrefix": "stranger", "logLevel": "error",
  "logFile": "$WORK/pool-run.log",
  "daemons": [ { "host": "127.0.0.1", "port": 29554, "user": "$RPCUSER",
                 "password": "$RPCPASS", "wallet": "pool",
                 "timeout": 15000 } ] }
JSON
        node "$ROOT/pool/server.js" --config "$WORK/pool.json" \
            >"$WORK/pool.log" 2>&1 &
        POOL_PID=$!
        pup=0
        for _ in $(seq 1 60); do
            curl -fs --max-time 5 -o /dev/null \
                 "http://127.0.0.1:18080/api/health" && { pup=1; break; }
            kill -0 "$POOL_PID" 2>/dev/null || break
            sleep 1
        done
        if [ "$pup" != 1 ]; then
            bad "the pool did not come up against a working node and redis" \
                "$(first_error "$WORK/pool.log")"
        else
            ok "the pool answers"

            got429=0
            for i in $(seq 1 12); do
                c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
                     "http://127.0.0.1:18080/api/stats?n=$i")"
                [ "$c" = 429 ] && got429=$((got429+1))
            done
            if [ "$got429" -gt 0 ]; then
                ok "/api/* refuses a caller who will not stop ($got429 of 12)"
            else
                bad "twelve requests against apiRequestsPerMinute 5, none refused" \
                    "This is the measurement that was sent to us: 300 requests," \
                    "zero refusals, because the limiter read a header instead" \
                    "of the socket."
            fi

            # The address lookup has its own tighter ceiling because it is the
            # endpoint that can be walked. Separate bucket, separate
            # measurement -- one limiter passing does not prove the other.
            look429=0
            for i in $(seq 1 8); do
                c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
                     "http://127.0.0.1:18080/api/miner?address=$POOL_ADDR&n=$i")"
                [ "$c" = 429 ] && look429=$((look429+1))
            done
            if [ "$look429" -gt 0 ]; then
                ok "/api/miner has its own, tighter ceiling ($look429 of 8)"
            else
                bad "eight lookups against apiLookupsPerMinute 3, none refused" \
                    "The address list is public either way; what this buys is" \
                    "that walking it is slow and attributable."
            fi

            # A ROTATING X-Forwarded-For MUST NOT BUY A BUCKET PER VALUE.
            #
            # With apiTrustProxy false and a forwarded header present, the
            # pool cannot tell its callers apart, so it puts all of them in
            # ONE crowd bucket rather than limiting them as a single caller
            # -- otherwise every reader behind an undeclared proxy throttles
            # every other reader. That is the design and it is right.
            #
            # Which is why this config pins apiUntrustedProxyFactor to 1.
            # The crowd budget is normally a hundred times the per-caller
            # one, and the first version of this check fired twelve requests
            # at a budget of five hundred, got twelve 200s, and called the
            # pool broken. It was measuring nothing. At factor 1 the crowd
            # budget is the five above, so a refusal means the twelve shared
            # a bucket and no refusal means each header value bought its own
            # -- which is the bypass this is here to catch.
            hdr429=0
            for i in $(seq 1 12); do
                c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
                     -H "X-Forwarded-For: 10.0.0.$i" \
                     "http://127.0.0.1:18080/api/stats?h=$i")"
                [ "$c" = 429 ] && hdr429=$((hdr429+1))
            done
            if [ "$hdr429" -gt 0 ]; then
                ok "a changing X-Forwarded-For shares one bucket ($hdr429 of 12)"
            else
                bad "twelve requests, each with a different X-Forwarded-For, none refused" \
                    "At apiUntrustedProxyFactor 1 the crowd budget is five," \
                    "so twelve unrefused requests mean each header value got" \
                    "a bucket of its own. A limit anyone can reset with a" \
                    "header they write is not a limit."
            fi
        fi
    fi
else
    skip "node(1) or redis-server is missing, so the pool was not run"
fi

# ---------------------------------------------------------------------------
step "8. what the channels would be told"

TAGFILE="$ROOT/posts/$VERSION/TAG_MESSAGE.txt"
if command -v node >/dev/null 2>&1 && [ -f "$TAGFILE" ]; then
    out="$(node -e '
        const fs = require("fs"), path = require("path");
        const root = process.argv[1], tag = process.argv[2];
        const A = require(path.join(root, "bots", "announce.js"));
        const { toPlain } = require(path.join(root, "bots", "lib", "markup.js"));
        const txt = fs.readFileSync(
            path.join(root, "posts", tag, "TAG_MESSAGE.txt"), "utf8");
        // Exactly what release.yml hands the bot: the tag message without its
        // first line, which is the tag subject.
        const body = txt.split("\n").slice(1).join("\n");
        process.stdout.write(toPlain(A.releaseMessage({
            tag, name: "WAM Coin " + tag, body, prerelease: false,
            url: "https://github.com/wamcoin/wam-blockchain-core/releases/tag/" + tag
        })));
    ' "$ROOT" "$VERSION" 2>"$WORK/announce.err")"
    words="$(printf '%s' "$out" | wc -w)"

    if [ -z "$out" ]; then
        bad "the announcement could not be rendered from the tag message" \
            "$(last3 "$WORK/announce.err")"
    elif printf '%s' "$out" | grep -qiE 'the announcement bot reads|sent automatically|^-{20,}'; then
        bad "the channels would be sent the tag file's own editing instructions" \
            "That is what two releases actually sent."
    elif [ "$words" -lt 60 ]; then
        bad "the whole announcement is $words words" \
            "An empty body still assembles a complete-looking message:" \
            "title, download links, sources, 'Full notes at the link below.'"
    else
        ok "the announcement carries the release ($words words)"
        if printf '%s' "$out" | grep -q 'SHA256SUMS'; then
            ok "and names the signed list the reader is told to check"
        else
            bad "it tells the reader to verify and names no SHA256SUMS"
        fi
        if printf '%s' "$out" | grep -qF "$VERSION"; then
            ok "and says which version it is announcing"
        else
            bad "the announcement does not contain $VERSION"
        fi
    fi
else
    skip "no posts/$VERSION/TAG_MESSAGE.txt in this checkout"
fi

# ---------------------------------------------------------------------------
printf '\n=================================================================\n'
if [ "${#FAILED[@]}" -gt 0 ]; then
    printf ' %s%d passed, %d FAILED, %d skipped%s\n' \
           "$RED$BLD" "$PASS" "${#FAILED[@]}" "$SKIPPED" "$OFF"
    for f in "${FAILED[@]}"; do printf '   %s\n' "$f"; done
    printf '=================================================================\n\n'
    exit 1
fi
printf ' %s%d passed, %d skipped%s\n' "$GRN$BLD" "$PASS" "$SKIPPED" "$OFF"
if [ "$SKIPPED" -gt 0 ]; then
    printf ' %severy skip above is a gap in the evidence, not a pass%s\n' "$DIM" "$OFF"
fi
printf '=================================================================\n\n'
exit 0
