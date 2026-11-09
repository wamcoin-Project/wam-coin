#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  sweep.sh -- run every check there is, and say what was not run
# ===========================================================================
#
#      bash scripts/sweep.sh
#      bash scripts/sweep.sh --nodes "1.2.3.4 5.6.7.8"     # also the live ones
#
#  WHY THIS EXISTS
#
#  The checks in this directory were each written after something went wrong,
#  and each of them works. On 2026-08-19 three faults were nevertheless live
#  at the same time:
#
#    - the published v0.1.0 download was a different network entirely, four
#      days after the genesis blocks were re-mined
#    - the two deployed nodes ran different consensus binaries and the chain
#      had been split for six hours
#    - the Electrum server was unreachable from the internet, and so was the
#      mainnet p2p port, which would have failed silently on launch day
#
#  None of them was subtle. All of them would have been caught in under a
#  minute. They survived because running the checks depended on remembering
#  to run the checks, one at a time, and nothing listed what had not been run.
#
#  So this is one command, and its most important column is the one that says
#  SKIPPED. A check that was not run is not a check that passed, and the
#  summary refuses to let those look alike.
#
#  Run it at the start of a working session and before anything is announced.
# ===========================================================================

set -uo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

NODES=""
# WHICH CHAIN THIS SWEEP IS ABOUT.
#
# Every node-facing check below used to say `--network "$NETWORK"`, written when
# testnet was the only chain there was and never revisited. Mainnet opened on
# 15 September 2026; on the 18th this sweep was still asking the testnet node
# whether the pool paid, whether Electrum agreed, whether independent nodes
# could follow, and whether the explorer matched consensus -- and printing
# green for a chain with nothing on it, three days into one that had 2,384
# blocks and real coins.
#
# The default is mainnet, and the header prints it, because the failure was
# never a wrong answer. It was an answer whose subject was invisible.
NETWORK=mainnet
while [ $# -gt 0 ]; do
    case "$1" in
        --network) NETWORK="${2:?--network needs a value}"; shift 2 ;;
        # Commas are accepted and turned into spaces. ops.py, check_backups
        # and half the other entry points in this project take a
        # comma-separated list, so a comma here is the natural mistake -- and
        # it was a silent one: every use of $NODES below relies on word
        # splitting, so "a,b,c" became ONE host named "a,b,c". On 2026-09-14
        # that produced "wam-announce is unreachable | FAIL" and "the deployed
        # nodes DISAGREE | FAIL" out of a sweep against three healthy servers,
        # ten hours before mainnet. Three false reds from one comma.
        --nodes) NODES="$(printf '%s' "${2:?--nodes needs a value}" | tr ',' ' ')"; shift 2 ;;
        -h|--help) sed -n '5,32p' "$0"; exit 0 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
PASSED=(); FAILED=(); SKIPPED=()
LOGDIR="$(mktemp -d)"
trap 'rm -rf "$LOGDIR"' EXIT

# run NAME -- COMMAND...
run() {
    local name="$1"; shift
    # Every character that is not a letter, digit or dash becomes an
    # underscore. This replaced spaces only, so the first check whose name
    # contained a '/' -- "deployed code is origin/main" -- turned into a path
    # through a directory that does not exist, and the runner reported a
    # failure of its own making on top of whatever the check actually said.
    local log="$LOGDIR/$(printf '%s' "$name" | tr -c 'A-Za-z0-9-' '_').log"
    printf '  %-34s ' "$name"

    # A label with no command is a bug in this file, never a passing check.
    #
    # `"$@"` with nothing in it runs nothing and exits 0, so `run "label"` on
    # its own printed ok and counted a pass. That is how "a new node can sync
    # from genesis" stayed green for months: a comment placed after a
    # backslash continuation commented the command out, and the harness
    # reported success for the absence of it. The harness has to be the one
    # thing that cannot do this.
    if [ $# -eq 0 ]; then
        printf '%sHARNESS BUG%s\n' "$RED" "$OFF"
        printf '        run "%s" was called with no command. An empty command\n' "$name"
        printf '        exits 0, so this would have been reported as a pass.\n'
        printf '        Look for a comment after a "\\" continuation above.\n'
        FAILED+=("$name -- run() was called with no command")
        return
    fi

    "$@" >"$log" 2>&1
    local rc=$?
    if [ $rc -eq 0 ]; then
        printf '%sok%s\n' "$GRN" "$OFF"
        PASSED+=("$name")
    elif [ $rc -eq 2 ]; then
        # Exit 2 is this project's convention for "the check could not run" --
        # a host that did not answer, an ssh that timed out. It is not a pass
        # and it is not a finding, and it must be neither: reported as a
        # failure it says something was measured and found wrong, which is how
        # "everyone can follow mainnet: FAILING" came to mean an ssh call took
        # longer than a minute.
        printf '%scould not check%s\n' "$YLW" "$OFF"
        SKIPPED+=("$name -- the check could not run")
        # \?\? is the marker a check prints for a question it could not ask;
        # !! is its older spelling. Escaped because ? quantifies in ERE.
        sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -iE '^ *(\?\?|!!|could not)' | head -2 \
            | sed 's/^/       /'
    else
        printf '%sFAIL%s\n' "$RED" "$OFF"
        FAILED+=("$name")
        sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -iE '^ *(FAIL|error|✗)' | head -4 \
            | sed 's/^/       /'
    fi
}

skip() {
    printf '  %-34s %sSKIPPED%s  %s\n' "$1" "$YLW" "$OFF" "$2"
    SKIPPED+=("$1 -- $2")
}

echo "=================================================================="
echo " WAM sweep -- $(date '+%Y-%m-%d %H:%M')  [$NETWORK]"
echo "=================================================================="

# ---------------------------------------------------------------------------
printf '\n%sthe repository%s\n' "$BLD" "$OFF"

run "repository self-agreement"  bash scripts/audit_repo.sh

# Asked for, done, and then undone by a default that never stopped running.
# The backlog stays until a change that rewrites history anyway; this only
# guarantees the backlog does not grow.
run "no assistant attribution"   "$PY" scripts/check_attribution.py

# The one thing that has actually cost this project an account. On 2026-09-24
# a step in platform-build.yml mined two regtest blocks on a GitHub runner;
# suspended within the hour, and the repository, every download and the whole
# site answered 404 to the public on a release day. The step was fixed the
# same day and nothing has enforced it since. Building on CI is not the
# fault and never was -- the line is between work and PROOF of work.
run "nothing of ours hashes on CI" "$PY" scripts/check_ci_mining.py

# And the second account, on 2026-10-29. GitHub sent no reason; the founder
# watched the cause happen -- a workflow started, failed, and was started
# again, once, twice, three times, with nothing changed between the runs.
# Their fourth Actions term is the words for it: a burden "disproportionate
# to the benefits provided to users". This counts; it cannot stop a click.
run "a failure is read, not repeated" "$PY" scripts/check_ci_reruns.py
run "mention is not use"         "$PY" scripts/check_mentions.py

# And the library those checks lean on. A quotation mark that opens a region
# and never closes it silences the REST of its file, and the symptom is a
# file that has gone quiet -- which nothing notices. On 8 October 2026 one
# docstring sentence naming the convention had been doing that for weeks.
run "a mention is not a mark"    "$PY" scripts/test/test_quoted.py
run "every link resolves"        "$PY" scripts/check_links.py
run "the zone is signed and validates" "$PY" scripts/check_dnssec.py
run "the seeds inside the binary answer" "$PY" scripts/check_fixed_seeds.py
run "a floor under what a node follows" "$PY" scripts/check_min_chain_work.py --network "$NETWORK" ${NODES:+--host ${NODES%% *}}

# The listing entry repeats constants that live in src/wam. Hand-written
# copies drift, and this one is read by software rather than by a person: a
# wrong pubtype does not look wrong, it sends somebody's coins nowhere. The
# dangerous day is not the day it was written but the day a prefix changes
# and nobody remembers that a file in integration/ repeats it.
run "the listing entry matches source" "$PY" scripts/check_listing_entry.py
# Named for what it does, not for what it sounds like. It compares the three
# MACHINE-READABLE copies of the vesting table -- header, genesis miner,
# explorer constants. It reads no document. Called "vesting tables agree", it
# was read as covering the whitepaper, and the whitepaper was wrong for days
# underneath a green line.
run "the 3 code copies of vesting agree"  "$PY" scripts/check_vesting_sync.py

# And the fields nothing copies, because WAM REPLACES upstream's chainparams
# rather than editing it. A field upstream assigns and our replacement does
# not keeps its declaration, keeps the code that reads it, and tells nobody.
# consensus.enforce_BIP94 was exactly that: declared with no default, read in
# validation.cpp, node/miner.cpp and pow.cpp, assigned by no network at all,
# and indeterminate because the params object is heap-allocated. Found from
# outside on 2026-10-11, not by us.
# scripts/lib/components.py is where "what does this project ship, and on
# whose version" is answered once. set_version.py and the announcement check
# read it instead of each knowing the answer by heart. A central file that
# has drifted is wrong everywhere that trusts it, at the same moment, so it
# is asked whether it is still describing this repository.
run "the manifest describes the repository" "$PY" scripts/check_components.py
run "no consensus field is unset" "$PY" scripts/check_consensus_params.py
run "supply arithmetic"          "$PY" scripts/verify_supply.py

# "Which script pays this address" is answered in three places: the pool in
# JavaScript, the miner in C++, and the node, which is consensus. Nothing
# compared them until 2026-10-15, and two of them had drifted -- the pool was
# refusing one valid base58 address in twenty, found from outside after
# twenty-six days, and the miner was refusing every legacy regtest address
# the node hands out, found by this check on its first run.
#
# It compiles a driver against miner/src/address.h, so without a C++ compiler
# it exits 2 and says nothing was compared. --node is passed by the caller
# when a mainnet node is reachable; without it the two copies are still
# checked against each other.
run "pool, miner and node agree on addresses" \
    "$PY" scripts/check_address_agreement.py

# And the phone runs the same miner as the desktop. contrib/ carries its own
# copy of miner/src for the Gradle build, and on 8 November two reported and
# paid JSON faults were fixed in one of the two trees. The announcement was
# true of one copy; the hang it described was still in the sources of the
# app. An outsider found it by diffing, because nothing here was.
run "the phone runs the same miner" \
    "$PY" scripts/check_android_miner.py

# And the miner's own tests are actually run. Until 9 November 2026 nothing
# in this repository opened miner/test/ -- three test programs, one of them
# extended the day before to hold down a paid finding, and no gate that could
# have told us whether any of them still passed.
run "the miner's unit tests" \
    bash scripts/test_miner.sh

# How much has been paid in bounties is stated in four places by hand. On
# 2026-10-13 the front page's footer said 21,000 WAM, which was right and
# counted three payments, while the paragraph directly above it said the
# exchange had happened "twice" and named two. Both sentences were visible at
# once and contradicted each other for two days.
run "the paid bounty total matches the ledger" \
    "$PY" scripts/check_bounty_total.py

# Three times now a sentence denying something has outlived the thing it
# denied. CHANNELS.txt went stale three times in two days in September; the
# front page said WAM was not listed when a venue had merged it; and on
# 2026-10-15 four live documents at once still said there was no market, no
# exchange and -- in the package handed to listing venues -- that the chain
# had not launched, a month after it did.
run "no live page denies what became true" \
    "$PY" scripts/check_stale_denials.py
run "executable bits in index"   bash scripts/test/test_exec_bits.sh

# Its neighbour above checks that a script is marked runnable. This checks
# that it can actually run. A carriage return at the end of a shebang line
# makes the kernel look for an interpreter named "python3\r", and the error
# it prints says nothing about why. gen_founder_key.py -- run once, from a
# live USB, by one person -- sat in this repository that way.
run "line endings are LF"        bash scripts/test/test_line_endings.sh
# An alarm this project sent had SECURITY.md rendered as a hyperlink, because
# .md is Moldova's top-level domain -- so a message about checking signatures
# pointed at a stranger's server. It reached the operator chat rather than the
# public channel, which is the only reason it cost nothing.
run "no alert looks like a link" "$PY" scripts/test/test_alert_text.py
# And the other way an alarm does damage: being sent at all when nothing is
# wrong. On the night of 2026-10-03 the channels were twice told the published
# release DOES NOT VERIFY, recovering ten minutes later each time -- ten
# minutes being the watcher's interval, with nobody touching anything. The
# release was correct throughout; check_release_signed.sh read an nginx error
# page, found no SHA256SUMS link in it, and said SHA256SUMS is not published.
run "a check that cannot ask stays quiet" bash scripts/test/test_release_check_silence.sh
# The same confusion, on the ops panel rather than in the channels. On
# 2026-11-04 two rows read FAILING -- "electrum servers answer and agree" and
# "a server we do not own agrees" -- while all four of our endpoints and cup's
# were answering at the right height. One slow ssh to the Germany node had
# raised TimeoutExpired out of check_electrum.py's own private copy of the ssh
# call, past the caller's graceful path, and the panel printed the traceback
# under those two names. wamssh.py exists so this is written once; this holds
# the panel to using it.
run "a hung ssh is not a failing service" "$PY" scripts/test/test_panel_ssh_silence.py
# The release note inside a platform archive was wrong four times in one
# evening, each time found by downloading the finished artifact. The root was
# that the packaging is parameterised by platform and only one branch was ever
# run -- on Linux. This exercises all three, needing none of them.
run "each platform note is true of it" bash scripts/test/test_release_note.sh
run "embedded python parses"     bash scripts/test/test_embedded_python.sh
    # The wallet's own words. Added after the first GUI build answered
    # `help validateaddress` with "the given bitcoin address" -- in a window
    # one menu away from the balance.
    run "the wallet says WAM to a person" "$PY" scripts/test/test_rename_messages.py
    run "and says it in every alphabet" "$PY" scripts/test/test_rebrand_locales.py
# A comment after a "\" continuation commented out the command it was meant to
# explain, in this very file, and the harness reported the missing command as
# a pass. See the header of the test.
run "no command hides behind a \\" bash scripts/test/test_sweep_calls.sh
run "service hardening"          bash scripts/test/test_harden.sh

# systemd sets no HOME for a service with no User=, so wam-cli looks in
# /.wam and reports missing RPC credentials -- which reads as a node that is
# down while the node is up. It killed the backups for three days in August,
# and then killed the reorg watcher on the day it was written, by the same
# person, hours after he wrote the check that would have caught the first
# one. Knowing about a trap is not a guard rail.
run "units that resolve ~ have a HOME"  bash scripts/test/test_service_home.sh

# And the reason that one had to be found by a person: a timer stays active
# however often the service beneath it fails, so a check that failed every
# time it ran read as healthy on every panel here. wam-backup did it nightly
# from 23 August; wam-reorg-watch did it on both machines on 1 September and
# went ten and a half hours without asking its own question.
run "units report their own failure"  bash scripts/test/test_onfailure.sh

# Every check above this line compares code to code. On 1 September 2026 the
# founder read the whitepaper on his telephone and found a table saying the
# first founder tranche unlocks on launch day; consensus locks all five, and
# the sweep had just reported 28 passed. "vesting tables agree" compares three
# machine-readable copies and reads no document a human reads -- and neither
# did anything else here. This one reads what we publish.
run "published claims match consensus"  "$PY" scripts/check_published_claims.py

# And the claims nothing can check, because they are about the future. Until
# 2026-10-04 the front page said the founder's mining addresses "will be
# published here" and that his share of the hash rate would fall "so you can
# watch it fall". He has never mined and holds no WAM: it was a plan written
# before launch, in the future tense, still standing nineteen days after the
# future arrived. A reader quoted it back at him as a description of today.
run "no page promises and forgets"  "$PY" scripts/check_promises.py

# That one reads wam-params.h, which is consensus, and consensus has no opinion
# about what has been SPENT. On 2 October the founder found "No fee was asked
# and none was paid" on the front page about the venue we had sent 500 WAM to
# on the day it merged us -- true, and it reads as a lie to anybody who opens
# the ledger we tell him to open. The same sentence had been caught in a draft
# six days earlier and written down as a mistake, and then appeared on the
# front page anyway, because nothing compared a claim about money to
# docs/TREASURY_LEDGER.md.
run "treasury claims match the ledger" "$PY" scripts/check_treasury_claims.py

# And two plans cut in one sitting cannot take the same coin. --parts keeps
# the parts of one payment apart; until 9 November nothing kept two separate
# plans apart, and three people were owed that day. The failure would have
# arrived at broadcast, after the key had been used.
run "two plans cannot spend one output" \
    "$PY" scripts/test/test_treasury_exclude.py

# That one reads what we SAY about the money. This reads the LEDGER itself,
# against the chain, and it is the half that was missing. docs/TREASURY_LEDGER.md
# does not merely record the spends: it hands the reader an identity and tells
# him to repeat it -- 2.5 x height minus every amount and every fee is what a
# node will report. On 2026-10-11 that worked example still stood at height
# 4,989 and subtracted one 500 WAM spend, while ten further rows sat in the
# table beneath it. Anybody who did as the file asked would have landed 10,010
# WAM away from the chain, in the file about where the money went, and nothing
# here had noticed for nine days.
#
# It also answers the question the ledger exists for: the identity cannot hold
# if a coin ever left the treasury without a row.
run "the ledger is what the chain says"  "$PY" scripts/check_treasury_ledger.py --node "${NODES%% *}"

# All three of those read the pages. Nothing read the thing that WRITES them.
# scripts/build_pages.py has put five defects on the live site -- an escaped
# quotation mark mid-sentence in the whitepaper, numbered rules rendered
# "1. 1. 1.", a build that hung on one line, three links to pages that never
# existed, and ten indented blocks turned into prose with their whitespace
# collapsed, among them the treasury address on /security/ and the Qt
# filenames on /start/. Every one was found by a person looking at a rendered
# page. The documents were right each time; only the page was wrong.
run "the pages say what the documents say" "$PY" scripts/test/test_build_pages.py

# That one asks whether the generator renders correctly. This asks whether
# anybody ran it. On 8 November 2026 SECURITY.md gained a fifth paid bounty
# and four published figures moved with it; the commit shipped and
# site/security/index.html was not rebuilt, so the page told readers "21,250
# WAM to four people" while the document it is made from said 31,500 to five.
# The live-site check further down passed throughout, because the live site
# and the repository were stale together -- which is what a comparison
# between two copies of the same mistake is worth.
run "every generated page is what its source builds" "$PY" scripts/build_pages.py --check

# And the one document generated from a binary rather than written. An
# operator asked for an example wam.conf on 2026-10-13 and we shipped none:
# the release is binaries and documents, and upstream's bitcoin.conf was
# never renamed, never adapted and never packaged. share/examples/wam.conf
# is generated from `wamd -help` so it cannot become a stale hand-written
# list -- which only holds while somebody regenerates it. This compares the
# committed option list against what the binary accepts today.
run "the example conf matches the binary" "$PY" scripts/check_example_conf.py

# And the script that actually moves it. On 2026-10-04 treasury_spend.py had
# no test of any kind: 490 lines, the treasury's key in memory while it signs,
# a file carried by hand between two machines, and nothing that runs. The pool
# had fourteen test files. Both of its known faults -- selecting outputs an
# unconfirmed transaction had already spent, and accepting a mistyped key --
# were found by a person using it, which is the most expensive way to find
# anything in a money path.
run "the treasury spender refuses what it should" "$PY" scripts/test/test_treasury_spend.py

# And the other half of that question, which had no detector until mainnet's
# second day: the repository can be right while the WEBSITE is wrong. Two
# corrections were committed, pushed and reported as published on 15
# September and neither reached wamcoin.org. The false one stood for two days
# and was found by an outside researcher asking for a transaction id.
#
# The site was on GitHub Pages then, published from a generated branch by a
# script nobody ran. Since 2026-09-24 nginx serves it from the deployed
# checkout on our own machines, so ship.sh publishes it and that script is
# gone -- see check_site_published.py, which went on naming it for eight days
# and sent today's operator to push a branch that serves nothing.
run "the live site is this repository" "$PY" scripts/check_site_published.py

# The same failure, one layer out: not "is what we publish true" but "does
# the list of who we are name everybody who is us". CHANNELS.txt says "There
# are no others", so a channel missing from it is branded an impostor's by
# our own file. That happened to the explorer, the pool and the Electrum
# server in August, was fixed by hand, and happened again to the BitcoinTalk
# thread three weeks later -- because the fix was a person remembering.
run "the channel list names all of us"  "$PY" scripts/check_channels.py

# And that the signature on it still covers the bytes it names. CHANNELS.txt
# tells its reader to run `gpg --verify`, and on 8 September the file was
# edited twice without being re-signed -- so that instruction returned BAD
# signature, which does not read as "they forgot" but as "somebody has taken
# their site and altered the list of which accounts are theirs". Absent is
# careless; BAD is an alarm we would have raised against ourselves.
#
# Needs only the public SIGNING-KEY.asc, so it runs here and in CI, on the
# laptop where the edit happens and which holds no secret key.
run "the channel list's signature is current"  bash scripts/check_channels_signed.sh

# And the same question about the text we post: SECURITY.md is a filename to
# us and a hostname to Telegram, which linked the sentence about verifying
# our fingerprint to a shop in Moldova. Found by the founder pressing it.
run "no filename reads as a domain"  "$PY" scripts/check_post_text.py

# And whether it arrives shaped the way it was written. On 2026-10-30 a
# correction posted to a pool operator's #wam channel came out with its
# sentences broken in half on a phone: it was wrapped at 72 columns, like
# everything here, and Discord keeps a single newline rather than joining it.
# Every fact in that text was right and it still read badly. Found by the
# founder, in the channel, after sending.
run "the text renders as written"   "$PY" scripts/check_wrapping.py

# Asked before a chain is started, not after. A consensus value that changes
# once blocks exist invalidates every block mined under the old one, and the
# running nodes are the last to notice.
run "testnet consensus is final"  bash scripts/check_consensus_final.sh testnet
run "mainnet consensus is final"  bash scripts/check_consensus_final.sh mainnet

# ---------------------------------------------------------------------------
printf '\n%sthe network as strangers meet it%s\n' "$BLD" "$OFF"

# No `command -v dig` guard here any more. The check knows whether it can run
# and says so with exit 3, and since 5 September it does better than that: with
# no dig locally it asks one of our own hosts, which has one, running that
# host's checkout at the same commit. The guard here skipped it before it ever
# got the chance -- so the seeding check, the one that decides whether a
# stranger can find the network at all, was permanently "not run" on the only
# machine the sweep is run from.
run "DNS seeds answer x9."    bash scripts/check_dns_seeds.sh

# Which strings on a page are an address at all. The check below has been
# wrong in both directions -- it read a line of our own source as a host for
# three days, and it never once dialled the bare second port two pools
# publish for farms. Both were in the extraction, which needs no network, so
# it is held here rather than discovered by a stranger.
run "every address on the page, and nothing that only looks like one" \
    "$PY" scripts/test/test_endpoint_extraction.py

# Every host:port on a page a stranger reads. The mining guide sent miners to
# a testnet port that had stopped existing on launch day, and on 8 October
# 2026 it was naming a third-party pool whose stratum port refuses the
# connection from four different countries. The sentence "all three answered
# when this page was last checked" is a claim with no checker behind it.
run "published endpoints answer, and will next month" \
    "$PY" scripts/check_published_endpoints.py

# Every page sends a reader to wamcoin.org/downloads/<newest>/. On
# 2026-10-16 that directory answered 404 for four minutes after v0.1.12 was
# published, because the archives had not been uploaded to our own hosts
# yet. Eight things were verified before publishing, and not the one URL a
# stranger actually follows. release_watch caught it and held the
# announcement; this is so the net is not the thing that catches it.
newest_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -n "$newest_tag" ]; then
    run "the newest release is downloadable" \
        bash scripts/check_release_ready.sh "$newest_tag"
fi

if command -v curl >/dev/null 2>&1; then
    run "published download is this network" bash scripts/check_release_matches.sh

    # Everything else here proves the release is the right software. This
    # proves a stranger can tell that it is ours -- which until 3 September
    # 2026 nobody could, because SHA256SUMS was published unsigned and whoever
    # can replace a binary can replace the list of hashes beside it.
    run "the published release is signed"  bash scripts/check_release_signed.sh

    # Signed, published, mirrored -- and never READ. On 2026-10-12
    # dang150296 ran readelf over the v0.1.11 Linux release and found wamd
    # requesting an executable stack, which is the condition a stack
    # overflow needs in order to run what it wrote. RandomX ships assembly
    # with no .note.GNU-stack section, so the linker assumed the worst and
    # marked the whole binary; nothing we ship needs it.
    #
    # He found one. This check reads every binary in every Linux artefact of
    # the release and found three -- wamd, wam-miner and wam-qt, the three
    # that link librandomx.a. The graphical wallet is the one an ordinary
    # person runs, and nobody had reported that one.
    #
    # Every other property of those files was already right: full RELRO,
    # PIE, stack canaries, FORTIFY. The gap was not the build. It was that
    # this project verified what it SAID about a release and never what the
    # release WAS.
    run "the published binaries are hardened" bash scripts/check_binary_hardening.sh

    # "This project verified what it SAID about a release and never what the
    # release WAS" -- and after that was written, it still only read half of
    # what the release was. Hardening is a property of the file; what the file
    # DEMANDS of the machine running it is another, and v0.1.12 could not
    # start on a clean Ubuntu because of it. Same artefacts, same readelf, one
    # more question, found by Jeeves on 2026-10-18 instead of by this line.
    run "the published binaries carry their libraries" bash scripts/check_shared_deps.sh
else
    skip "published download is this network" "curl is not installed"
fi

# And the three repositories named in every announcement, which a reader is
# told he may clone any of. On 2026-10-06 GitHub had a ruleset requiring main
# to be changed through a pull request and had been silently refusing the
# push. ship.sh is right to report a mirror and carry on -- and it says so in
# one line, once, inside a ship that worked. The only reason it was noticed
# is that somebody read that line, which is luck rather than a check.
if command -v git >/dev/null 2>&1; then
    run "the three homes hold the same project" "$PY" scripts/check_mirrors.py
else
    skip "the three homes hold the same project" "git is not installed"
fi

# ---------------------------------------------------------------------------
printf '\n%sthe deployed machines%s\n' "$BLD" "$OFF"

if [ -z "$NODES" ]; then
    skip "nodes agree with each other" "no --nodes given"
    skip "ports reachable from outside" "no --nodes given"
else
    set -- $NODES
    if [ $# -lt 2 ]; then
        skip "nodes agree with each other" "--nodes needs two or more hosts"
        skip "ports reachable from outside" "--nodes needs two or more hosts"
    else
        run "nodes agree with each other" bash scripts/check_nodes_agree.sh $NODES

        # AND AGREE WITH THE RELEASE, which is a different question.
        #
        # The check above compares the hosts to each other, so the one case it
        # cannot see is a fleet that is uniformly wrong -- which is exactly what
        # a deploy that silently did nothing produces, on every machine at once.
        #
        # On 1 November 2026 it called Germany and Singapore "byte-identical"
        # while wam-tx, wam-util and wam-wallet on both were pinned at v0.1.7,
        # six releases back, since 11 September. They agreed perfectly. The
        # third host had COPIES of the same v0.1.7 tools, and a v0.1.9 wamd its
        # testnet node had been running for seventeen days, through four
        # releases -- while "deployed code is origin/main" said ok about the
        # git checkout beside it, truthfully, because a checkout is not what
        # systemd executes.
        #
        # So this one compares against something outside the fleet: the newest
        # signed release in our own download directory, which is what a
        # stranger gets when he follows our instructions.
        run "machines run the version we publish"             "$PY" scripts/check_running_version.py $NODES

        # A node that cannot say who connected is not unhealthy -- it answers
        # every other question correctly. It simply stops being able to tell
        # an operator from a port scanner, and the founder asks that more
        # often than he asks anything else. It was lost on 2 September by a
        # libevent upgrade restarting the daemon, and nothing noticed.
        run "nodes can still say who connected" bash scripts/check_node_logging.sh $NODES

        # The node binaries are only part of what this repository deploys. The
        # pool, the bot and the dashboard drift the same way and are noticed
        # far later, because the wrong version of working software produces no
        # symptom at all.
        run "deployed code is origin/main" bash scripts/check_deployed_code.sh $NODES

        # And the copies systemd actually runs. deploy.sh updates /opt/wam
        # and stops there, correctly -- but wam-backup.sh and
        # wam-concentration-log.sh are INSTALLED into /usr/local/bin, so a
        # change to either can be committed, pushed, deployed and reported as
        # "every host is running <commit>" while the old code goes on running
        # on a timer that stays green. That happened on 18 September to the
        # logger, an hour after the change that made it record the number the
        # project's public condition is judged on.
        run "installed helpers are the repository"             bash scripts/check_installed_helpers.sh $NODES

        # And who can become root on each of them. On 18 September the panel
        # reported a healthy host unreadable for days, because the shell it
        # spawned came from WSL and offered a key that host did not
        # authorise. Nothing here knew which machine trusted which key.
        run "the same keys get a shell everywhere"             bash scripts/check_admin_keys.sh $NODES

        # WHO IS WRITING THE CHAIN.
        #
        # This existed from 15 September, an hour into mainnet, and lived on
        # the operations panel alone. So on 19 September this sweep printed
        # "47 passed, 0 failed" while one party held 60% of the last 144
        # blocks and the panel was red about it.
        #
        # The sweep is what gets run at the start of a session and before
        # anything is announced. A sweep that reports no failures while the
        # single largest risk to the chain sits unasked is the shape of green
        # this whole file exists to refuse.
        run "no one party writes the chain"             "$PY" scripts/check_concentration.py --node "${NODES%% *}"                   --network "$NETWORK"

        # The one question the nodes themselves cannot answer. They agreed with
        # each other, ran identical binaries, held the same block at the same
        # height -- and the chain could not be validated from genesis by anyone
        # who did not already have it.
        set -- $NODES
        # --timeout 300, not 120. A new node builds a RandomX verification
        # context per seed epoch before it validates anything -- about twelve
        # seconds each -- and only then starts on blocks. At 120 it regularly
        # stopped watching during that phase. The check no longer calls that a
        # failure, but a run that actually reaches the tip is a stronger
        # answer than one that reports steady progress.
        #
        # This comment used to sit between `run ... \` and the command. A
        # backslash continuation joins the next line, and the next line was a
        # comment -- so everything after it was commented out, `run` was
        # called with a label and NO command, and an empty command exits 0.
        # The panel printed "a new node can sync from genesis  ok" for months
        # without the sweep ever evaluating it, while the real script ran
        # underneath as a separate top-level command with its exit status
        # discarded. run() now refuses an empty command, and
        # test_sweep_calls.sh refuses the syntax that caused it.
        #
        # --host, because the machine this sweep is usually run from has no
        # wamd on its PATH, and without one the check cannot start. It runs on
        # the second node and syncs from the first, so the node being built
        # from nothing and the node it learns the chain from are different
        # machines -- which is the only arrangement that answers the question.
        FRESH_HOST=""; for v in $NODES; do [ "$v" != "$1" ] && { FRESH_HOST="$v"; break; }; done
        run "a new node can sync from genesis" \
            bash scripts/check_fresh_sync.sh --network "$NETWORK" --peer "$1" \
                 --timeout 300 ${FRESH_HOST:+--host "$FRESH_HOST"}
        # Each node is probed from the next one round-robin, so every host is
        # examined from a machine that is not itself.
        i=0
        for target in $NODES; do
            i=$((i + 1))
            vantage=""
            for v in $NODES; do [ "$v" != "$target" ] && { vantage="$v"; break; }; done
            run "ports reachable: $target" bash scripts/check_reachable.sh \
                --host "$target" --from "$vantage" 22 19555 '!19554'
        done

        # The service every check here had been ignoring.
        #
        # On 2026-08-20 the Electrum server was stopped during the testnet
        # reset and never restarted. It stayed down 39 hours, and this sweep
        # was run in that window and reported 14 passed -- because nothing in
        # it had ever asked. A light wallet cannot read the chain itself: when
        # this is down it shows nothing, and when it is behind it shows a
        # wrong balance, which is worse.
        #
        # Both names are listed even though electrum2 is not built yet. One
        # Electrum server is a single point of failure and Komodo Wallet
        # requires two for a UTXO coin, so a red line here is the accurate
        # report of where this stands rather than a gap nothing mentions.
        set -- $NODES
        run "electrum servers answer and agree" \
            "$PY" scripts/check_electrum.py --node "$1" --network "$NETWORK" \
            electrum.wamcoin.org electrum2.wamcoin.org

        # And one that is not ours, which is the whole point of it.
        #
        # Two servers run by one operator fail together. That is not a theory
        # on this project: the version drift found on 2026-11-01 put the same
        # wrong binaries on all three of our machines, and check_nodes_agree.sh
        # -- which compares them to each other -- called them agreed, correctly
        # and uselessly. Redundancy that shares an operator shares his
        # mistakes. On 2026-11-02 a second operator stood one up in Seoul on a
        # third provider, built from integration/electrumx/install.sh, and
        # asked to be measured from outside rather than trusted.
        #
        # It gets its own row instead of joining the line above, because a
        # reboot of a machine we do not own must not redden the row that judges
        # the machines we do. It can still fail, and it has to: electrums/WAM
        # advertises this endpoint, so a wallet told a wrong balance by it was
        # sent there by us. The action on a red line here is to tell the
        # operator, or to take the endpoint out of the entry -- not to log in,
        # which we cannot do and should not be able to.
        #
        # --node still reads OUR node because we hold no ssh on his, and that
        # is the question anyway: does his index agree with our chain. It is
        # the one thing "I track your signed releases" cannot prove about
        # itself, and he said so before we did.
        if [ "$NETWORK" = mainnet ]; then
            run "a server we do not own agrees" \
                "$PY" scripts/check_electrum.py --node "$1" --network "$NETWORK" \
                wam.zcd.lol
        else
            skip "a server we do not own agrees" "it serves mainnet only"
        fi

        # The pool had found 150 blocks, owed 16,176 WAM to two miners and had
        # paid nothing since genesis -- every payout failing for the whole life
        # of the chain -- while its page was green, its service active, its
        # ports open and miners happily submitting shares. This sweep was run
        # that morning and said 14 passed. A human found it by opening the
        # pool's own web page for an unrelated reason.
        #
        # So this asks the two questions nothing else did: does every stratum
        # port actually hand out a job, and have miners actually been paid.
        run "pool gives work and pays for it" \
            "$PY" scripts/check_pool.py --node "$1" --network "$NETWORK"

        # The explorer is where a stranger goes to check us without building
        # anything. A node that is wrong is a bug; an explorer that is wrong
        # is a bug everyone reads and believes. Every economic number it
        # publishes is compared against wam-params.h using the same parser
        # verify_supply.py uses, so the page and consensus cannot drift.
        run "explorer publishes what consensus enforces" \
            "$PY" scripts/check_explorer.py --node "$1" --network "$NETWORK"

        # v0.1.5 changed the mainnet treasury address, which is consensus. A
        # node left on v0.1.4 will reject every valid block on 15 September
        # and fork off at height 1. Its operator cannot be messaged -- the
        # protocol carries blocks, not notices -- so the only thing possible
        # is to know how many are still behind while announcing can still
        # help, rather than counting them afterwards.
        #
        # This goes red until they update, and that is the point: it is a
        # launch blocker held by other people, and the only lever is to keep
        # saying so.
        run "every independent node can follow mainnet" \
            "$PY" scripts/check_peer_versions.py --node "$1" --network "$NETWORK"

        # The nightly backup failed on both servers every night from 23 to 26
        # August and this sweep said 21 passed on each of those mornings,
        # because nothing here had ever asked. The timer was green -- it fired
        # correctly; the service died at 03:27 into a journal nobody reads.
        #
        # A backup is the only check whose absence is invisible until the day
        # you need it, and by then asking is too late. So it is asked here,
        # every time, and the question that cannot be fooled is the age of the
        # newest file: a run can succeed and write nothing.
        run "there is something to restore from" \
            "$PY" scripts/check_backups.py $NODES

        # Room, and the direction it is going. The daily report already
        # prints free memory and disk; what it cannot print is that a machine
        # is losing 400 MB a day and has six weeks. A threshold fires on the
        # night it is already a problem; a slope gives time to buy a bigger
        # machine. A chain only grows, so disk is the one that will bite.
        run "room, and which way it is going"             "$PY" scripts/check_headroom.py --nodes "$NODES"

        # Who tried to join, and why they did not stay.
        #
        # A stranger connected three times across three days and left
        # each time, and nothing could say whether he chose to or
        # whether this node dropped him. The founder's reason for
        # wanting to know is the better one: somebody who cannot get a
        # node running does not open an issue, he closes the terminal,
        # and we never hear. If the cause is ours we fix it; if it is
        # not knowing how, it can be answered in the channels; if he
        # simply switched off, there is nothing to answer.
        #
        # It needs net logging on, and says so plainly when it is off
        # rather than reading an empty journal as nobody having come.
        run "why visitors did not stay" \
            "$PY" scripts/check_visitors.py --host "${NODES%% *}" --network "$NETWORK"

        # Has a block that was confirmed stopped being confirmed?
        #
        # Nothing here had ever asked, and it is the one failure that costs
        # other people money rather than costing us time. A young RandomX
        # chain can be out-mined by anyone renting cloud CPUs for an hour.
        # The attack does not touch anybody's wallet: it lets the attacker
        # spend their own coins twice, against whoever accepted them on few
        # confirmations. In practice that is an exchange.
        #
        # It cannot be prevented at this size. It can be seen, and the
        # difference between hearing in four minutes and hearing in four
        # days is the difference between one lost deposit and a delisting.
        #
        # Proved on 2026-08-29 against a throwaway regtest chain rewritten
        # on purpose: seven blocks replaced, reported as seven.
        run "no confirmed block has been un-confirmed" \
            "$PY" scripts/check_reorg.py --network "$NETWORK" \
                --state-dir "${WAM_REORG_STATE:-$HOME/.wam-reorg}" $NODES
    fi
fi

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
printf '\n%show the project looks to someone who has never heard of it%s\n' "$BLD" "$OFF"

# A Bisq maintainer read a submission for this coin and answered "I do not see
# any project related to WAM". The links were in the pull request. What he saw
# was a repository with an empty homepage field, no topics, and a description
# containing no term anyone searches for -- and a site whose links rendered
# anywhere as bare URLs. Five submissions had already gone to five venues
# before anyone looked at the front page they pointed at.
run "the project presents itself as a real one" \
    "$PY" scripts/check_first_impression.py

# START_HERE told beginners to download v0.1.3 for four releases after its
# binaries were deliberately withdrawn -- so the first command on the page
# written to make someone feel capable returned 404 instead. Found by the
# founder reading his own documentation, which is not a mechanism.
run "the documented version still exists" \
    "$PY" scripts/check_docs_version.py

# The bot is how a node operator learns that a release changes a consensus
# rule. There is no other way: the protocol carries blocks, not notices. A
# bot that has quietly stopped is indistinguishable from a quiet week, and
# the day it matters is the day nobody hears.
#
# check_bots.py existed and was not run by this sweep, which is the same
# shape of gap as the backup: a check that works, and nothing calling it.
if [ -n "$NODES" ]; then
    run "the announcer is alive and can be heard" \
        "$PY" scripts/check_bots.py --host "${NODES%% *}" --network "$NETWORK"
else
    skip "the announcer is alive and can be heard" "no --nodes given"
fi

# ---------------------------------------------------------------------------
printf '\n%slaunch readiness%s\n' "$BLD" "$OFF"

if [ -n "$NODES" ]; then
    run "preflight" bash scripts/preflight.sh --nodes "$NODES"
else
    run "preflight" bash scripts/preflight.sh
fi

# ---------------------------------------------------------------------------
echo
echo "=================================================================="
printf ' %s%d passed%s   %s%d failed%s   %s%d NOT RUN%s\n' \
    "$GRN" "${#PASSED[@]}" "$OFF" "$RED" "${#FAILED[@]}" "$OFF" \
    "$YLW" "${#SKIPPED[@]}" "$OFF"

if [ "${#FAILED[@]}" -gt 0 ]; then
    echo
    echo " failed:"
    for f in "${FAILED[@]}"; do printf '   - %s\n' "$f"; done
fi

if [ "${#SKIPPED[@]}" -gt 0 ]; then
    echo
    echo " not run -- these are not passes:"
    for s in "${SKIPPED[@]}"; do printf '   - %s\n' "$s"; done

    # Where you are standing is part of the answer.
    #
    # On 12 September this sweep was run from the founder's Windows laptop and
    # reported four checks it could not run. Three of them could not run THERE
    # and would have run anywhere else:
    #
    #   * "DNS seeds answer x9." needs dig, which Git Bash does not ship
    #   * "published download is this network" downloads 11.7 MB, and that
    #     connection carries about 16 KB/s, so the check times out
    #   * the two GitHub checks had hit the 60-calls-an-hour limit that the
    #     whole household shares through one address
    #
    # All three passed from a seed, immediately, and one of them then found
    # something: the third server had no objdump, so the AVX-512 guard -- which
    # exists because a published release died with SIGILL on an EPYC -- had
    # been reporting "not measured" there rather than a result.
    #
    # So a sweep run on the laptop is not the full sweep, and on 14 September
    # the full sweep is the last thing between this project and launch.
    if ! command -v dig >/dev/null 2>&1 || [ -n "${WINDIR:-}" ]; then
        echo
        echo
        printf ' %sThis is not the full sweep, and neither is a run on a
' "$YLW"
        printf ' server.%s Two machines see different halves of it.
' "$OFF"
        echo
        # Measured on 12 September, after two wrong guesses in one day.
        #
        # First I said "run it from a seed". Seed3 produced twelve red lines,
        # none of them a fault. Then I said "run it from the pool host",
        # because that one has node and dig. It produced ten, and every one
        # said the same thing:
        #
        #     root@169.58.159.165: Permission denied (publickey).
        #
        # No seed holds a key to any other seed, including to itself. That is
        # deliberate and it is the safer arrangement -- daily_report.py says
        # why in its own header: a key on Germany is a key that goes with
        # Germany if Germany is ever taken. peer_watch.py exists precisely so
        # that the seeds can watch each other WITHOUT one.
        #
        # So the cross-host checks can only run where the operator key is,
        # which is the laptop, and the host-local ones run better on a server
        # with dig, a fast link and an unspent GitHub quota. Neither machine
        # can give the whole answer and no amount of choosing between them
        # will change that.
        echo " The cross-host checks need the operator key, which lives on"
        echo " the laptop and nowhere else -- no seed can reach another, by"
        echo " design. The host-local ones need dig, a fast link and an"
        echo " unspent GitHub quota, which the laptop has none of."
        echo
        echo " Run both, and read them together:"
        echo
        echo "   here:      bash scripts/sweep.sh --nodes \\"
        echo "                  \"169.58.159.165 5.223.52.200 13.140.33.187\""
        echo
        echo "   on a seed: ssh root@13.140.33.187 \\"
        echo "                  'cd /opt/wam && bash scripts/sweep.sh'"
        echo
        echo " A check that could not run is not a check that passed, and a"
        echo " check that ran from the wrong place is not one either."
    fi
fi
echo "=================================================================="

[ "${#FAILED[@]}" -eq 0 ]
