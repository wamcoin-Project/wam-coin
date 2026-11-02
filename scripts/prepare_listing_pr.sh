#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  prepare_listing_pr.sh -- stage a venue's submission on a branch
# ===========================================================================
#
#      bash scripts/prepare_listing_pr.sh bisq
#      bash scripts/prepare_listing_pr.sh --list
#
#  Clones our fork of the venue's repository, copies this repository's files
#  into the paths that venue actually reads, commits with integration/<venue>/
#  PR.md as the message, and pushes a branch. It prints the URL that opens the
#  pull request and stops there: opening it is a decision, and it is the
#  founder's.
#
#  WHY THIS IS A SCRIPT
#
#  The Bisq submission was done by hand first -- clone, copy three files,
#  insert one line in alphabetical order, commit, push. It worked, and it left
#  nothing behind that anyone could check or repeat. Where each file goes in
#  each venue's tree is a fact about that venue, discovered by reading their
#  repository, and facts like that belong in a file rather than in whoever
#  did it last.
#
#  It also means a corrected file here reaches the venue by running one
#  command again, instead of by remembering which three paths it went to.
#
#  WHAT IT WILL NOT DO
#
#  Fork a repository or open a pull request. Both need a GitHub API token, and
#  a token pasted into a chat is a token that has to be revoked. Fork by hand,
#  once, and open the pull request from the link this prints.
# ===========================================================================

set -uo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

OWNER="wamcoin-Project"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
ok()   { printf '  %sok%s     %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '  %swarn%s   %s\n' "$YLW" "$OFF" "$*"; }
die()  { printf '  %sfail%s   %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
step() { printf '\n%s%s%s\n' "$BLD" "$*" "$OFF"; }

# venue | upstream repo | fork name | branch | the open pull request
#
# The branch is per venue and not one name for all of them, because they are
# not all one branch. On 6 September 2026 this script would have pushed a
# corrected confirmation depth to `add-wam-coin` -- which is the branch behind
# KomodoPlatform/coins#21, the DEAD MIRROR, whose last commit was 2025-12-05.
# The live review is GLEECBTC/coins#1975 and it is built from
# `add-wam-coin-gleec`. The script would have reported success, updated the
# pull request nobody reads, and left the one under review saying 20.
#
# So `komodo` now means the repository that is actually reviewing us, and the
# mirror is a separate target that has to be named.
#
# 2026-11-02: the komodo branch is `add-third-electrum` and its pull request
# column is empty, on purpose. The coin entry is merged -- cipig did it himself
# in GLEECBTC/coins#2034 -- and #1975 is closed. This script updates a branch
# that already exists rather than replacing it, so leaving `add-wam-coin-gleec`
# here would have pushed a new commit onto the head of a closed pull request:
# GitHub shows it there, the dead conversation wakes up, and the change nobody
# is reviewing is the one that matters. A new submission to the same
# repository gets a new branch, and an empty column is honest about a pull
# request that does not exist yet -- verify_target says so and continues,
# rather than checking a number that describes something else.
#
# It was opened the same day as GLEECBTC/coins#2085, so the column is filled
# again and verify_target has something true to check: that #2085 really reads
# wamcoin-Project/coins:add-third-electrum before anything is pushed there. A
# corrected file reaches the review by running this script again, which is the
# whole reason it exists.
venues() {
    cat <<'V'
slips          satoshilabs/slips                          slips                           add-wam-coin  2051
bisq           bisq-network/bisq                          bisq                            add-wam-coin  8030
haveno         haveno-dex/haveno                          haveno                          add-wam-coin  2528
blockdx        blocknetdx/blockchain-configuration-files   blockchain-configuration-files  add-wam-coin  200
basicswap      basicswap/basicswap                        basicswap                       add-wam-coin  701
komodo         GLEECBTC/coins                             coins                           add-third-electrum  2085
komodo-mirror  KomodoPlatform/coins                       coins                           add-wam-coin  23
V
}

# Where each file goes in that venue's tree. "SRC -> DEST", one per line.
# Read out of each repository rather than guessed; see integration/<venue>/NOTES.md.
layout() {
    case "$1" in
    bisq) cat <<'L'
WAMCoin.java      assets/src/main/java/bisq/asset/coins/WAMCoin.java
WAMCoinTest.java  assets/src/test/java/bisq/asset/coins/WAMCoinTest.java
L
        ;;
    haveno) cat <<'L'
WAMCoin.java      assets/src/main/java/haveno/asset/coins/WAMCoin.java
WAMCoinTest.java  assets/src/test/java/haveno/asset/coins/WAMCoinTest.java
L
        ;;
    blockdx) cat <<'L'
xbridge-confs/wam--v0.1.10.conf     xbridge-confs/wam--v0.1.10.conf
wallet-confs/wam--v0.1.10.conf      wallet-confs/wam--v0.1.10.conf
L
        ;;
    basicswap) cat <<'L'
chainparams.py  basicswap/interface/wam/chainparams.py
wam.py          basicswap/interface/wam/wam.py
L
        ;;
    komodo|komodo-mirror) cat <<'L'
electrums-WAM.json  electrums/WAM
L
        ;;
slips) : ;;   # both are edits to existing tables, handled below
    esac
}

if [ "${1:-}" = "--list" ] || [ $# -eq 0 ]; then
    printf 'venues:\n'
    venues | awk '{printf "  %-11s %s\n", $1, $2}'
    printf '\nusage: %s VENUE\n' "${0##*/}"
    exit 0
fi

VENUE="$1"
LINE="$(venues | awk -v v="$VENUE" '$1==v')"
[ -n "$LINE" ] || die "unknown venue '$VENUE' -- try --list"
UPSTREAM="$(printf '%s' "$LINE" | awk '{print $2}')"
FORK="$(printf '%s' "$LINE" | awk '{print $3}')"
BRANCH="$(printf '%s' "$LINE" | awk '{print $4}')"
PRNUM="$(printf '%s' "$LINE" | awk '{print $5}')"

# ---------------------------------------------------------------------------
#  Ask the pull request itself where it is built from, before touching anything
# ---------------------------------------------------------------------------
#
#  The branch used to be one name for every venue, and that name belonged to
#  KomodoPlatform/coins#21 -- a mirror whose last commit was 2025-12-05.
#  Pushing a correction there updates a review nobody is reading and prints a
#  URL that looks like success. The live review is GLEECBTC/coins#1975, built
#  from a different branch entirely.
#
#  A table can be wrong in the same way twice. So the table is checked against
#  the thing it describes: GitHub is asked which repository and which branch
#  the open pull request actually reads, and if that is not exactly where this
#  script is about to push, it stops. No argument, no override -- if they
#  disagree, one of them is wrong and a person has to look.
verify_target() {
    [ -n "${PRNUM:-}" ] || { warn "no pull request recorded for $VENUE -- target not verified"; return 0; }
    local api="https://api.github.com/repos/$UPSTREAM/pulls/$PRNUM"
    local body
    body="$(curl -s --max-time 25 "$api" 2>/dev/null)" || {
        warn "could not reach GitHub to verify the target; not pushing blind"
        die "verification is not optional -- run it again when the network is back"
    }
    local head_repo head_ref state
    head_repo="$(printf '%s' "$body" | "$PY" -c 'import json,sys; d=json.load(sys.stdin); print((d.get("head") or {}).get("repo",{}).get("full_name") or "")' 2>/dev/null)"
    head_ref="$(printf '%s' "$body" | "$PY" -c 'import json,sys; d=json.load(sys.stdin); print((d.get("head") or {}).get("ref") or "")' 2>/dev/null)"
    state="$(printf '%s' "$body" | "$PY" -c 'import json,sys; print(json.load(sys.stdin).get("state") or "")' 2>/dev/null)"

    [ -n "$head_repo" ] || die "$UPSTREAM#$PRNUM did not answer with a head repository.
     Refusing to push to a target that cannot be confirmed."

    printf '  %-16s %s#%s  (%s)
' "pull request" "$UPSTREAM" "$PRNUM" "$state"
    printf '  %-16s %s:%s
' "it reads" "$head_repo" "$head_ref"
    printf '  %-16s %s:%s
' "we would push" "$OWNER/$FORK" "$BRANCH"

    if [ "$head_repo" != "$OWNER/$FORK" ] || [ "$head_ref" != "$BRANCH" ]; then
        die "the open pull request does not read what this script would push.
     Pushing anyway updates a branch nobody is reviewing, and says it worked.
     Fix the row in venues() -- or the pull request -- before running again."
    fi
    ok "the target is the branch that pull request actually reads"
}
verify_target
[ -n "$BRANCH" ] || die "no branch recorded for $VENUE -- refusing to guess.
     Pushing to the wrong branch updates a pull request nobody is reading and
     reports success while doing it."
SRCDIR="$HERE/integration/$VENUE"

[ -d "$SRCDIR" ] || die "no integration/$VENUE"
[ -f "$SRCDIR/PR.md" ] || die "no integration/$VENUE/PR.md -- the message is not optional"

echo "=================================================================="
echo " $VENUE  ->  $UPSTREAM"
echo "=================================================================="

# ---------------------------------------------------------------------------
step "1. our fork"

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
# HTTPS, not SSH. This machine cannot open an SSH connection to GitHub at all
# -- "unsupported KEX method sntrup761x25519-sha512@openssh.com" -- so every
# clone here failed with a message about forking a repository that had been
# forked weeks earlier. The project's own remote was moved to HTTPS on
# 6 September for the same reason.
if ! git -c http.version=HTTP/1.1 clone --quiet --depth 30         "https://github.com/$OWNER/$FORK.git" "$W/repo" 2>/dev/null; then
    die "cannot clone https://github.com/$OWNER/$FORK.git

           Fork it once, by hand, at:
               https://github.com/$UPSTREAM/fork"
fi
cd "$W/repo"
ok "$(git log --oneline -1)"

DEFAULT="$(git symbolic-ref --short HEAD)"

# A branch already there is the normal case on a second run, and pushing over
# it silently would discard whatever is on it -- possibly a submission already
# under review. Start from it instead, so a re-run updates rather than
# replaces, and say which is happening.
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
    # An explicit refspec, because a shallow clone fetches only the default
    # branch and `git fetch origin BRANCH` then lands in FETCH_HEAD without
    # creating origin/BRANCH. Written the short way once, the checkout below
    # failed, the script carried on regardless, and it committed onto the
    # default branch and tried to push a branch that did not exist. The fetch
    # being wrong was the small half; continuing after it failed was the rest.
    git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
        || die "cannot fetch $BRANCH from the fork"
    git checkout -q -b "$BRANCH" "origin/$BRANCH" \
        || die "cannot start from origin/$BRANCH"
    warn "$BRANCH already exists on the fork -- updating it, not replacing it"
    EXISTING=1
else
    git checkout -q -b "$BRANCH" || die "cannot create branch $BRANCH"
    EXISTING=0
fi

# ---------------------------------------------------------------------------
step "2. files"

COPIED=0
DESTS=""
while read -r src dest; do
    [ -n "${src:-}" ] || continue
    [ -f "$SRCDIR/$src" ] || die "integration/$VENUE/$src is missing"
    # A destination directory that does not exist means their layout moved and
    # this script's idea of it is stale. Say so rather than inventing a tree.
    parent="$(dirname "$dest")"
    # A venue whose files go into a new package -- BasicSwap wants
    # basicswap/interface/wam/ -- needs that one directory made. Its parent
    # must already exist: creating one level is adding a package, creating a
    # tree is inventing a layout, and the second is how a patch lands somewhere
    # nobody reads. This check ran before the mkdir that used to sit further
    # down, so the first submission that needed a new directory died on it.
    if [ "$parent" != "." ] && [ ! -d "$parent" ]; then
        if [ -d "$(dirname "$parent")" ]; then
            mkdir -p "$parent"
            ok "created $parent/"
        else
            die "$UPSTREAM has no $(dirname "$parent")/ -- their layout changed; re-read it before guessing"
        fi
    fi
    cp "$SRCDIR/$src" "$dest"
    ok "$src -> $dest"
    # Kept so a venue whose filenames carry a version can retire the ones it
    # has just superseded. Adding a file is not the same as replacing it.
    DESTS="$DESTS $dest"
    COPIED=$((COPIED + 1))
done < <(layout "$VENUE")

# ---- the per-venue edits that are not file copies --------------------------
case "$VENUE" in
bisq|haveno)
    NS="$VENUE"; [ "$VENUE" = "bisq" ] && NS="bisq" || NS="haveno"
    SVC="assets/src/main/resources/META-INF/services/$NS.asset.Asset"
    [ -f "$SVC" ] || die "no $SVC"
    "$PY" - "$SVC" "$NS.asset.coins.WAMCoin" <<'PY'
import sys, pathlib
p, entry = pathlib.Path(sys.argv[1]), sys.argv[2]
raw = p.read_text(encoding="utf-8")
lines = raw.splitlines()
if entry in lines:
    print("  ok     already registered"); raise SystemExit
prefix = entry.rsplit(".", 1)[0] + "."
idx = next((i for i, l in enumerate(lines)
            if l.startswith(prefix) and l.lower() > entry.lower()), None)
if idx is None:
    idx = max(i for i, l in enumerate(lines) if l.startswith(prefix)) + 1
lines.insert(idx, entry)
# Their file ends without a newline. Adding one turns a one-line insertion
# into a diff that also deletes and re-adds the last entry, and a reviewer
# opening a two-line diff to find one of them is unrelated noise learns
# something about the submitter that is not true and not helpful.
p.write_text("\n".join(lines) + ("\n" if raw.endswith("\n") else ""),
             encoding="utf-8")
print("  ok     %s, between %s and %s"
      % (entry.rsplit('.', 1)[1], lines[idx-1].rsplit('.', 1)[1],
         lines[idx+1].rsplit('.', 1)[1] if idx+1 < len(lines) else "the end"))
PY
    COPIED=$((COPIED + 1))
    ;;
basicswap)
    mkdir -p basicswap/interface/wam
    : > basicswap/interface/wam/__init__.py
    ok "basicswap/interface/wam/__init__.py"
    # Three anchored edits in basicswap/chainparams.py. Anchored on lines read
    # out of their file rather than on line numbers, and every one of them must
    # match or this stops: a Python file edited on a guess is how a patch that
    # does not import reaches a reviewer.
    "$PY" - basicswap/chainparams.py <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
t = p.read_text(encoding="utf-8")

edits = [
    # (what must be there, what replaces it, what to call it if it is missing)
    ("from basicswap.interface.bch.chainparams import params as bch_params\n",
     "from basicswap.interface.bch.chainparams import params as bch_params\n"
     "from basicswap.interface.wam.chainparams import params as wam_params\n",
     "the import block"),
    ("    DOGE = 18\n",
     "    DOGE = 18\n    WAM = 19\n",
     "the Coins enum"),
    ("    Coins.DOGE: doge_params,\n",
     "    Coins.DOGE: doge_params,\n    Coins.WAM: wam_params,\n",
     "the chainparams table"),
]

for anchor, replacement, name in edits:
    if replacement.strip() in t and anchor != replacement:
        print("  ok     %s: already there" % name)
        continue
    if anchor not in t:
        print("  fail   %s: anchor not found -- their file changed shape" % name)
        raise SystemExit(1)
    t = t.replace(anchor, replacement, 1)
    print("  ok     %s" % name)

p.write_text(t, encoding="utf-8")

# It has to still parse. A submission that does not import is worse than none.
import ast
ast.parse(t)
print("  ok     chainparams.py still parses")
PY
    [ $? -eq 0 ] || die "the chainparams.py edits failed"
    COPIED=$((COPIED + 1))
    ;;
blockdx)
# Retire the conf files this submission supersedes.
#
# Their names carry a version, so a new release leaves the old ones behind on
# the branch. On 6 September the open pull request showed four conf files:
# wam--v0.1.6.conf, which the manifest points at, and wamcoin--v0.1.3.conf,
# from before the coin's prefix changed, which nothing points at and which a
# reviewer has to work out is dead. Adding files is not the same as replacing
# them, and only one of those was being done.
#
# Anything in these two directories that is ours and is not what we just wrote
# goes. "Ours" is the wam/wamcoin prefix; nobody else's coin is touched.
for d in wallet-confs xbridge-confs; do
    [ -d "$d" ] || continue
    for f in "$d"/wam--*.conf "$d"/wamcoin--*.conf; do
        [ -e "$f" ] || continue
        keep=0
        for k in $DESTS; do [ "$k" = "$f" ] && keep=1; done
        [ "$keep" = 1 ] && continue
        git rm -q "$f" && ok "retired $f (superseded, nothing points at it)"
    done
done

# The two conf files are only two thirds of it: manifest-latest.json is
# what makes Block DX read them at all, and the first run pushed a branch
# without it -- two files that nothing points to.
"$PY" - manifest-latest.json "$SRCDIR/manifest-entry.json" <<'PY'
import json, sys, pathlib
man, entry = pathlib.Path(sys.argv[1]), json.loads(pathlib.Path(sys.argv[2]).read_text())
raw = man.read_text(encoding="utf-8")
data = json.loads(raw)
# Replace ours if it is already there, rather than skipping.
#
# This said "manifest already lists WAM" and stopped, which is right only if
# the entry never changes. It does: the conf filenames moved from
# wamcoin--v0.1.3 to wam--v0.1.6 and the versions list grew to cover v0.1.7,
# and an unchanged manifest points at files the branch no longer carries.
existing = [i for i, x in enumerate(data) if x.get("ticker") == entry["ticker"]]
ref = next((x for x in data if x.get("ticker") == "LTC"), data[0])
missing = set(ref) - set(entry)
if missing:
    print("  fail   the entry lacks %s, which their own rows carry" % sorted(missing))
    raise SystemExit(1)
if existing:
    for i in existing:
        data[i] = entry
    print("  ok     manifest entry for %s replaced" % entry["ticker"])
else:
    data.append(entry)
# Their file's own indentation, measured rather than assumed.
ind = len(raw.split("\n")[1]) - len(raw.split("\n")[1].lstrip()) if "\n" in raw else 2
man.write_text(json.dumps(data, indent=ind or 2) + ("\n" if raw.endswith("\n") else ""),
               encoding="utf-8")
print("  ok     manifest-latest.json: %s appended (%d coins)" % (entry["ticker"], len(data)))
PY
[ $? -eq 0 ] || die "the manifest edit failed"
COPIED=$((COPIED + 1))
;;
slips)
    # Two rows in two existing tables. Not files to add -- the repository's
    # "upload files" page is the wrong door, and a new file there would be
    # closed without comment.
    #
    # Column widths are measured from a neighbouring row rather than written
    # here, so the diff a reviewer sees is one line and not a reformatting.
    COIN_TYPE="$(grep -oE 'WAM_BIP44_COIN_TYPE[[:space:]]*=[[:space:]]*(0x[0-9A-Fa-f]+|[0-9]+)' \
        "$HERE/src/wam/wam-params.h" | grep -oE '(0x[0-9A-Fa-f]+|[0-9]+)$' | tail -1)"
    [ -n "$COIN_TYPE" ] || die "cannot read WAM_BIP44_COIN_TYPE from the source"
    "$PY" - "$COIN_TYPE" <<'PY'
import pathlib, re, sys

coin = int(sys.argv[1], 0)


def widths(line):
    # "| a | b | c |" -> the width of each cell as written
    return [len(c) for c in line.split("|")[1:-1]]


# ---- slip-0044.md : numeric order -----------------------------------------
p = pathlib.Path("slip-0044.md")
raw44 = p.read_text(encoding="utf-8")
lines = raw44.splitlines()
rows = [(i, int(m.group(1))) for i, l in enumerate(lines)
        for m in [re.match(r"^\|\s*(\d+)\s*\|", l)] if m]
if any(n == coin for _, n in rows):
    print("  ok     slip-0044.md already has %d" % coin)
else:
    nxt = min((r for r in rows if r[1] > coin), key=lambda r: r[1])
    w = widths(lines[nxt[0]])
    row = "|" + str(coin).ljust(w[0] - 1).rjust(w[0]) \
        + "|" + " WAM".ljust(w[1]) \
        + "|" + " WAM Coin".ljust(w[2]) + "|"
    # rebuild with a leading space in each cell, matching the file
    row = "| %s| %s| %s|" % (str(coin).ljust(w[0] - 1),
                             "WAM".ljust(w[1] - 1),
                             "WAM Coin".ljust(w[2] - 1))
    lines.insert(nxt[0], row)
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("  ok     slip-0044.md: %d, above %s" % (coin, lines[nxt[0] + 1].strip()[:40]))

# ---- slip-0173.md : alphabetical by coin name ------------------------------
p = pathlib.Path("slip-0173.md")
raw173 = p.read_text(encoding="utf-8")
lines = raw173.splitlines()
if any("WAM Coin" in l for l in lines):
    print("  ok     slip-0173.md already has WAM Coin")
else:
    # Only the table under "Registered human-readable parts". The file holds
    # several -- "Non-Segwit-compatible uses of Bech32 / Bech32m" and "Uses of
    # codex32" follow it -- and an unbounded scan put WAM between Mnemonic Key
    # and Zcash's viewing keys, which is a different table about a different
    # thing entirely.
    start = next(i for i, l in enumerate(lines)
                 if l.startswith("## Registered human-readable parts"))
    end = next((i for i, l in enumerate(lines[start + 1:], start + 1)
                if l.startswith("## ")), len(lines))
    names = [(i, re.match(r"^\|\s*([^|]+?)\s*\|", l).group(1))
             for i, l in enumerate(lines)
             if start < i < end and re.match(r"^\|\s*[^|\s-]", l) and "`" in l]
    # The first name greater than ours is not good enough: their table has
    # stragglers -- "Wormhole Gateway" sits between Galaxy and GenesisL1 --
    # and landing beside one produces a diff that looks careless even though
    # it is one line. Insert where the neighbours are ordered with respect to
    # each other, which is the run a reader would call alphabetical.
    # The LAST position that fits, not the first. Their table has stragglers --
    # "Wormhole Gateway" sits between Galaxy and GenesisL1 -- and every one of
    # them offers a gap that satisfies prev < ours < next while sitting
    # nowhere near the alphabet. The strays are near the top and the long
    # sorted run is below them, so the last candidate is the one inside it: for
    # us that is between VIPSTARCOIN and Wpc rather than above Wormhole.
    key = "wam coin"
    idx = None
    for a, b in zip(names, names[1:]):
        if a[1].lower() < key < b[1].lower():
            idx = b[0]
    if idx is None:
        after = [x for x in names if x[1].lower() > key]
        idx = after[0][0] if after else names[-1][0] + 1
    w = widths(lines[idx])
    row = "| %s| %s| %s| %s|" % ("WAM Coin".ljust(w[0] - 1),
                                 "`wam`".ljust(w[1] - 1),
                                 "`twam`".ljust(w[2] - 1),
                                 "`wamrt`".ljust(w[3] - 1))
    lines.insert(idx, row)
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("  ok     slip-0173.md: wam/twam/wamrt, above %s" % lines[idx + 1].strip()[:40])
PY
    COPIED=$((COPIED + 1))
    ;;
esac

[ "$COPIED" -gt 0 ] || die "nothing was staged"

# ---------------------------------------------------------------------------
step "3. commit"

# Signed, because Bisq blocks a merge on it: "Commits must have verified
# signatures." The first submission was unsigned, sat there red, and had to be
# amended and force-pushed. Signing costs nothing when nobody asks and saves a
# round trip when they do.
#
# The identity is the project, not a person. The founder is not anonymous --
# he is named in the legal brief and answers the project address -- but a
# coin whose submissions carry one man's personal account reads as one man's
# hobby, and the account that happened to own his personal address was named
# with a -bot suffix, so the SLIP registration arrived attributed to a bot.
# Every submission is from WAM Coin.
#
# The address is the project one, not a personal Gmail. GitHub verifies a
# signature only when the signing key AND the committer email both belong
# to the same account: a correctly signed commit under an address the
# account does not own reports "unknown_key" and looks unsigned. The
# signature was right, the key was registered, and it still showed as
# unverified until the email changed -- two force-pushes were spent on the
# key before the cause turned out to be the other half.
#
# SSH rather than GPG: the key that already pushes to these forks can sign as
# well, so there is no new secret to make, hold or lose. GitHub treats
# authentication and signing as separate registrations of the same key, so it
# must also be added at github.com/settings/keys with type "Signing Key" --
# until then a correctly signed commit reports "unknown_key" and looks
# unsigned.
SIGN=()
SSHKEY="$HOME/.ssh/id_ed25519.pub"
if [ -f "$SSHKEY" ]; then
    SIGN=(-c gpg.format=ssh -c "user.signingkey=$SSHKEY")
else
    warn "no $SSHKEY -- committing unsigned; venues that require signatures will block"
fi

git add -A
if git diff --cached --quiet; then
    if [ "$EXISTING" = 1 ]; then
        ok "the branch already carries exactly these files; nothing to do"
        echo
        echo " Open the pull request here:"
        echo "   https://github.com/$UPSTREAM/compare/$DEFAULT...$OWNER:$FORK:$BRANCH?expand=1"
        exit 0
    fi
    die "nothing changed -- the files may already be in their tree"
fi
git -c user.name="WAM Coin" \
    -c user.email="wam.coin.official@proton.me" \
    "${SIGN[@]}" commit -q ${SIGN:+-S} -F "$SRCDIR/PR.md"
git show --stat --oneline HEAD | tail -n +2 | sed 's/^/  /'

# ---------------------------------------------------------------------------
step "4. push"

# Status read from git, not from the end of a pipe. Written as a pipeline
# once, this printed "ok pushed" over "failed to push some refs" -- the exit
# code belonged to sed. That is the same fault this repository has spent a day
# removing from other checks, introduced fresh in the script that stages the
# submissions.
PUSHLOG="$W/push.log"
if git push --set-upstream origin "$BRANCH" >"$PUSHLOG" 2>&1; then
    grep -v '^remote:' "$PUSHLOG" | sed 's/^/  /'
    ok "pushed $OWNER/$FORK:$BRANCH"
else
    sed 's/^/  /' "$PUSHLOG"
    die "the push failed -- nothing is staged on the fork"
fi

echo
echo "=================================================================="
echo " Open the pull request here:"
echo
echo "   https://github.com/$UPSTREAM/compare/$DEFAULT...$OWNER:$FORK:$BRANCH?expand=1"
echo
echo " The title and body are already filled from integration/$VENUE/PR.md."
echo "=================================================================="
