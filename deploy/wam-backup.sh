#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  wam-backup.sh -- back up the megabyte that cannot be rebuilt
# ===========================================================================
#
#      bash deploy/wam-backup.sh            take a backup, and verify it
#      bash deploy/wam-backup.sh --verify   re-verify the newest one
#
#  WHAT IS AND IS NOT WORTH SAVING
#  -------------------------------
#  Measured on the live host, not guessed at:
#
#      wallets ............   688 KB   irreplaceable
#      pool share ledger ..   254 KB   irreplaceable -- who is owed what
#      config and certs ...   120 KB   irreplaceable in practice
#      chain data .........    35 MB   REPLACEABLE, re-syncs from any peer
#
#  So this copies about a megabyte and deliberately skips the largest thing
#  on the disk. A whole-machine snapshot spends its size on the one part
#  that is already replicated across every node on the network -- the part a
#  blockchain exists to make disposable.
#
#  WHY NOT THE HOSTING PROVIDER'S SNAPSHOT SERVICE
#  -----------------------------------------------
#  A VM snapshot contains wallet.dat, so it contains private keys, so
#  whoever can restore that snapshot can spend those coins. On testnet that
#  means nothing. On mainnet the pool wallet holds miners' money, and paying
#  monthly to keep a copy of its keys on someone else's storage does not
#  remove a risk; it exchanges it for a worse one. This encrypts before
#  anything is written, with a passphrase the provider never sees.
#
#  WHY backupwallet AND NOT cp
#  ---------------------------
#  A wallet file copied while it is being written yields a file that looks
#  fine and opens corrupt. backupwallet asks the node for a consistent copy
#  and is the only supported way to do this on a running wallet. If the node
#  is down there is no safe copy to take, and this fails loudly rather than
#  writing something that will disappoint someone later.
#
#  WHY THE STAGING DIRECTORY IS NOT UNDER /tmp
#  -------------------------------------------
#  wamd.service runs with PrivateTmp=yes, so the daemon gets its own /tmp
#  and cannot see a directory mktemp made in ours. backupwallet then fails
#  with SQLite error 14, "cannot open file", which reads exactly like a
#  corrupt wallet and is not one. Staging next to the destination keeps the
#  path in the namespace the daemon actually has.
#
#  THE PASSPHRASE
#  --------------
#  Read from a root-only file, never passed as an argument -- arguments are
#  visible to every process on the machine.
#
#      IF THAT FILE IS THE ONLY PLACE THE PASSPHRASE EXISTS, EVERY BACKUP
#      THIS SCRIPT MAKES IS A LOCKED BOX YOU CANNOT OPEN ON THE DAY THE
#      SERVER DIES -- WHICH IS THE ONLY DAY YOU WILL WANT IT.
# ===========================================================================

set -uo pipefail

NETWORK="${WAM_NETWORK:-testnet}"
DEST="${WAM_BACKUP_DIR:-/root/backups}"
PASSFILE="${WAM_BACKUP_PASSFILE:-/root/.wam-backup-pass}"
KEEP="${WAM_BACKUP_KEEP:-14}"
# The datadir follows the network, so a unit only has to say which network.
#
# It used to default to /root/.wam whatever the network was, which is the
# testnet node's directory. A mainnet backup started with only WAM_NETWORK set
# would have read the testnet chain, encrypted it, named it mainnet, and
# reported success -- an archive that says one thing and holds another, which
# is worse than no archive because it stops anybody looking for the real one.
#
# The names come from the node units themselves: wamd uses /root/.wam and
# wamd-mainnet uses /root/.wam-mainnet. Read off the running hosts rather
# than assumed, on 7 September.
case "$NETWORK" in
    mainnet) DATADIR="${WAM_DATADIR:-/root/.wam-mainnet}" ;;
    *)       DATADIR="${WAM_DATADIR:-/root/.wam}" ;;
esac

STAMP="$(date -u +%Y%m%d-%H%M%S)"

# The archive says which chain it holds, and each chain keeps its own set.
#
# Every archive was called wam-backup-<stamp>.tar.gz.gpg, with nothing in the
# name to say which network it came from, and both networks write to the same
# directory. Turning on mainnet backups would then have done two silent things:
# an operator holding a set of archives could not tell which chain any of them
# belonged to without decrypting it, and the rotation below -- which counts
# every wam-backup-*.gpg and keeps the newest fourteen -- would have kept about
# seven of each. Seven days of mainnet retention where fourteen was intended,
# discovered on the day it was needed.
#
# LEGACY: archives written before 7 September 2026 carry no network in the
# name, and every one of them is testnet, because mainnet has never run. The
# testnet glob matches both forms so nothing already on disk is orphaned or
# double-counted; they age out within KEEP days and the ambiguity ends by
# itself, well before mainnet has anything to lose.
PREFIX="wam-backup-$NETWORK-"
case "$NETWORK" in
    testnet) SET_GLOB="$DEST/wam-backup-testnet-*.tar.gz.gpg $DEST/wam-backup-2*.tar.gz.gpg" ;;
    *)       SET_GLOB="$DEST/$PREFIX*.tar.gz.gpg" ;;
esac

# Only names that exist, newest first. A glob that matches nothing expands to
# itself, and `ls` on a literal `*` prints an error and a wrong count.
this_networks_archives() {
    # shellcheck disable=SC2086
    ls -1t $SET_GLOB 2>/dev/null || true
}
RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'

ok()   { printf '  %sok%s    %s\n'  "$GRN" "$OFF" "$*"; }
bad()  { printf '  %sFAIL%s  %s\n'  "$RED" "$OFF" "$*"; }
warn() { printf '  %s!!%s    %s\n'  "$YEL" "$OFF" "$*"; }
die()  { bad "$*"; exit 1; }

# CHAINDIR is the subdirectory the wallet actually lives under, which is what
# wam-wallet needs to find it again on restore. Mainnet has none.
case "$NETWORK" in
    # A BARE wam-cli IS NOT MAINNET. /root/.wam/wam.conf says testnet=1, so
    # `wam-cli backupwallet` on this host asks the TESTNET node -- which has a
    # wallet called "pool" too. On launch night this backed up the testnet
    # pool wallet, labelled it mainnet, and the archive's own verify step then
    # refused to open a BDB file as a descriptor one:
    #
    #   FAIL wallet 'pool' (mainnet) will NOT open: Data is not in recognized
    #        format
    #   FAIL the archive does not restore -- deleted rather than left to be
    #        trusted
    #
    # So the pool wallet that had just started holding miners' money had no
    # backup at all, and the failure looked like corruption rather than like
    # the wrong chain. Same flags as scripts/wamcli.py, which exists because
    # six other scripts made this mistake first.
    mainnet) CLI=(wam-cli -chain=main -conf=/root/.wam-mainnet/wam.conf -datadir=/root/.wam-mainnet)
             NETFLAG=();          CHAINDIR="" ;;
    testnet) CLI=(wam-cli -testnet);   NETFLAG=(-testnet);  CHAINDIR="testnet3" ;;
    regtest) CLI=(wam-cli -regtest);   NETFLAG=(-regtest);  CHAINDIR="regtest" ;;
    *) die "WAM_NETWORK must be mainnet, testnet or regtest (got '$NETWORK')" ;;
esac

if [ ! -f "$PASSFILE" ]; then
    cat >&2 <<EOF
${RED}error${OFF}: $PASSFILE does not exist.

  Create it, readable by root only:

      printf '%s' 'a long passphrase you choose' > $PASSFILE
      chmod 600 $PASSFILE

  ${YEL}Then write that passphrase somewhere that is not this server.${OFF}
  If this machine is the only place it exists, every backup taken here is
  a locked box on the one day you need to open it.
EOF
    exit 1
fi
[ "$(stat -c '%a' "$PASSFILE")" = "600" ] || warn "$PASSFILE is not mode 600"
[ -s "$PASSFILE" ] || die "$PASSFILE is empty"
command -v gpg >/dev/null || die "gpg is not installed"


# ---------------------------------------------------------------------------
verify_archive() {
# ---------------------------------------------------------------------------
#  Decrypt, unpack, and actually open each wallet with wam-wallet. A backup
#  nobody has restored is a belief, not a backup, and the failure mode of the
#  belief is that it holds right up until the moment it matters.
#
#  Proven in both directions before being trusted: a good copy reports its
#  format and descriptor count, and a deliberately corrupted one fails with
#  "Data is not in recognized format".
# ---------------------------------------------------------------------------
    local archive="$1" work rc=0 found=0 w name
    work="$(mktemp -d -p "$DEST")" || return 1

    if ! gpg --quiet --batch --yes --passphrase-file "$PASSFILE" \
             --decrypt "$archive" 2>/dev/null | tar xz -C "$work" 2>/dev/null; then
        bad "cannot decrypt or unpack $(basename "$archive")"
        rm -rf "$work"; return 1
    fi
    ok "decrypts and unpacks"

    local n=0
    while IFS= read -r w; do
        found=1
        n=$((n + 1))
        name="$(basename "$(dirname "$w")")"

        # Each wallet is verified against the network it came from, not the
        # network this host happens to be running.
        #
        # The mainnet pool wallet and the testnet one are both called "pool".
        # Opening one with the other's flags reports "Data is not in
        # recognized format" -- which is what a corrupt wallet reports, so a
        # perfectly good backup was declared unrestorable and deleted.
        # ORIGINAL-PATH.txt, written at backup time, says which is which.
        local orig="" vnet="$NETWORK" vflag=() vchain="$CHAINDIR"
        [ -f "$(dirname "$w")/ORIGINAL-PATH.txt" ] && orig="$(cat "$(dirname "$w")/ORIGINAL-PATH.txt")"
        case "$orig" in
            */testnet3/*) vnet=testnet; vflag=(-testnet); vchain=testnet3 ;;
            */regtest/*)  vnet=regtest; vflag=(-regtest); vchain=regtest ;;
            "")           vnet="$NETWORK"; vflag=("${NETFLAG[@]}"); vchain="$CHAINDIR" ;;
            *)            vnet=mainnet; vflag=();        vchain="" ;;
        esac

        # A unique directory per wallet: two called "pool" must not overwrite
        # each other on the way to being checked.
        local rdir="$work/restore-$n/${vchain:+$vchain/}wallets/$name"
        mkdir -p "$rdir"
        cp "$w" "$rdir/wallet.dat"
        if out="$(wam-wallet "${vflag[@]}" -datadir="$work/restore-$n" -wallet="$name" info 2>&1)"; then
            ok "wallet '$name' ($vnet) opens -- $(printf '%s' "$out" | grep -i '^Format:' | tr -d '\n')"
        else
            bad "wallet '$name' ($vnet) will NOT open: $(printf '%s' "$out" | head -1)"
            rc=1
        fi
    done < <(find "$work/wallets" "$work/wallets-at-rest" -name 'wallet.dat' 2>/dev/null)

    # A host that runs a node and no wallet -- a seed, or the second Electrum
    # server -- has no wallet to copy, and demanding one made this script
    # build a perfectly good archive of that host's config and certificates
    # and then delete it for failing its own check. The note is written at
    # backup time, exactly as for redis, so "this host has no wallet" stays
    # distinguishable from "the wallet silently went missing".
    if [ "$found" != 1 ]; then
        if [ -f "$work/NO-WALLET-ON-THIS-HOST" ]; then
            ok "no wallet on this host (recorded at backup time)"
        else
            bad "no wallet in the archive, and no note saying why"
            rc=1
        fi
    fi

    if [ -f "$work/redis/dump.rdb" ]; then
        # An RDB begins with the ASCII magic "REDIS". Checking the bytes
        # catches a truncated copy; checking that the file exists does not.
        if [ "$(head -c 5 "$work/redis/dump.rdb")" = "REDIS" ]; then
            ok "redis dump valid ($(stat -c%s "$work/redis/dump.rdb") bytes)"
        else
            bad "redis dump is not an RDB file"; rc=1
        fi
    elif [ -f "$work/NO-REDIS-ON-THIS-HOST" ]; then
        ok "no redis on this host (recorded at backup time)"
    else
        bad "no redis dump and no note saying why"; rc=1
    fi

    if [ -d "$work/config" ]; then
        ok "config tree present ($(find "$work/config" -type f | wc -l) files)"
    else
        bad "no config in the archive"; rc=1
    fi

    rm -rf "$work"
    return $rc
}


mkdir -p "$DEST"; chmod 700 "$DEST"

if [ "${1:-}" = "--verify" ] || [ "${1:-}" = "--verify-all" ]; then
    ALL="$(this_networks_archives)"
    [ -n "$ALL" ] || die "no backup found in $DEST"

    # --verify checks the newest in full. But an archive that stops opening
    # is silent: the passphrase was replaced, or the file rotted on disk, and
    # nothing anywhere says so until the day it is needed. So every archive is
    # at least opened, cheaply, on every verify.
    #
    # This was not hypothetical. Replacing a 12-character passphrase with a
    # 30-character one left the archive taken minutes earlier unopenable by
    # anybody, and --verify reported success because it only ever looked at
    # the newest one.
    NEWEST="$(printf '%s\n' "$ALL" | head -1)"
    printf '\n  verifying %s\n\n' "$(basename "$NEWEST")"
    RC=0
    verify_archive "$NEWEST" || RC=1

    OLD="$(printf '%s\n' "$ALL" | tail -n +2)"
    if [ -n "$OLD" ]; then
        printf '\n  every older archive, can it still be opened at all:\n'
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            if [ "${1:-}" = "--verify-all" ]; then
                printf '\n  %s\n' "$(basename "$f")"
                verify_archive "$f" || RC=1
            elif gpg --quiet --batch --yes --passphrase-file "$PASSFILE" \
                     --decrypt "$f" >/dev/null 2>&1; then
                ok "$(basename "$f")"
            else
                bad "$(basename "$f") -- does NOT open with the current
     passphrase. It is a locked box: made before the passphrase was changed,
     or damaged on disk. Nobody can restore it. Move it aside or delete it
     rather than leaving something that looks like a backup and is not."
                RC=1
            fi
        done <<< "$OLD"
    fi

    printf '\n'
    [ "$RC" -eq 0 ] && { printf '  %severy backup here opens%s\n\n' "$GRN" "$OFF"; exit 0; }
    printf '  %sat least one backup here cannot be restored%s\n\n' "$RED" "$OFF"; exit 1
fi


# ===========================================================================
printf '\n  WAM backup -- %s -- %s UTC\n\n' "$NETWORK" "$STAMP"
# ===========================================================================

# Staged beside the destination, NOT in /tmp -- see the header.
STAGE="$(mktemp -d -p "$DEST")" || die "cannot create a staging directory in $DEST"
trap 'rm -rf "$STAGE"' EXIT

# --- wallets ---------------------------------------------------------------
"${CLI[@]}" getblockcount >/dev/null 2>&1 \
    || die "the node is not answering, so no consistent wallet copy can be taken.
     Start it and re-run. Copying wallet.dat behind a running node produces a
     file that opens corrupt, which is worse than no backup at all."

WALLETS="$("${CLI[@]}" listwallets 2>/dev/null | grep -oE '"[^"]+"' | tr -d '"')"
if [ -z "$WALLETS" ]; then
    # Recorded, not merely absent. Without this the verify below rejects the
    # archive and deletes it, and a node-only host ends up with no backup of
    # its config and certificates at all -- which is what happened to the
    # second Electrum server.
    echo "no wallet was loaded on $(hostname) at $STAMP" > "$STAGE/NO-WALLET-ON-THIS-HOST"
    warn "no wallet loaded; recorded a note so a later verify does not read as loss"
fi

for w in $WALLETS; do
    mkdir -p "$STAGE/wallets/$w"
    if "${CLI[@]}" -rpcwallet="$w" backupwallet "$STAGE/wallets/$w/wallet.dat" >/dev/null 2>&1; then
        ok "wallet '$w' ($(stat -c%s "$STAGE/wallets/$w/wallet.dat") bytes)"
    else
        die "backupwallet failed for '$w' -- refusing to write a backup missing a wallet.
     If this says SQLite error 14, the destination is somewhere the daemon
     cannot see; PrivateTmp=yes gives it a different /tmp from this shell."
    fi
done

# --- wallets belonging to nodes that are NOT running -----------------------
#
# The mainnet pool wallet was created on 2026-08-23, months before mainnet
# opens, so its node is stopped and listwallets on the running testnet node
# does not mention it. Everything above would have backed up faithfully and
# missed it entirely -- and it is the wallet that will hold miners' money on
# launch day.
#
# backupwallet cannot be used here: it needs the node that owns the wallet to
# be running. A file at rest can be copied directly, and safely, precisely
# because nothing is writing to it. Each candidate is checked for an open
# handle first, and skipped if anything holds it -- copying a live wallet.dat
# is what produces a file that opens corrupt.
#
# Archived directories from past resets are left alone: they are old chains,
# they are large, and restoring one would be a mistake.
# The label is built from the PATH, not the wallet's name.
#
# Both wallets here are called "pool" -- one on mainnet, one on testnet --
# and the first version of this skipped the mainnet one as already captured
# because the names matched. Two different wallets, holding different money,
# on different chains, are not interchangeable because someone reused a word.
#
# The live capture above is the one under the running chain's directory;
# anything else is at rest by definition.
LIVE_DIR="$DATADIR/${CHAINDIR:+$CHAINDIR/}wallets"
AT_REST=0
while IFS= read -r w; do
    [ -n "$w" ] || continue
    dir="$(dirname "$w")"
    case "$dir" in "$LIVE_DIR"/*) continue ;; esac      # taken live by backupwallet

    # e.g. /root/.wam/pool -> "pool", /root/.wam/other/wallets/x -> "other-wallets-x"
    rel="${dir#"$DATADIR"/}"
    label="$(printf '%s' "$rel" | tr '/' '-')"

    if command -v fuser >/dev/null 2>&1 && fuser "$w" >/dev/null 2>&1; then
        warn "$label is open by a running process -- skipped, a live copy opens corrupt"
        continue
    fi

    mkdir -p "$STAGE/wallets-at-rest/$label"
    cp -a "$w" "$STAGE/wallets-at-rest/$label/wallet.dat"
    printf '%s\n' "$w" > "$STAGE/wallets-at-rest/$label/ORIGINAL-PATH.txt"
    ok "wallet at rest: $label ($(stat -c%s "$w") bytes) -- $dir"
    AT_REST=$((AT_REST + 1))
done < <(find "$DATADIR" -name 'wallet.dat' -not -path '*.old-*' 2>/dev/null)
[ "$AT_REST" -gt 0 ] || true

# --- the pool's share ledger ----------------------------------------------
if command -v redis-cli >/dev/null && systemctl is-active --quiet redis-server 2>/dev/null; then
    RP="$(grep -oP '(?<=^requirepass ).*' /etc/redis/redis.conf 2>/dev/null | head -1 || true)"
    RC=(redis-cli); [ -n "$RP" ] && RC=(redis-cli -a "$RP" --no-auth-warning)

    LAST="$("${RC[@]}" lastsave 2>/dev/null)"
    "${RC[@]}" bgsave >/dev/null 2>&1
    for _ in $(seq 1 30); do
        NOW="$("${RC[@]}" lastsave 2>/dev/null)"
        [ -n "$NOW" ] && [ "$NOW" != "$LAST" ] && break
        sleep 1
    done

    RDBDIR="$("${RC[@]}" config get dir 2>/dev/null | tail -1)"
    RDB="${RDBDIR:-/var/lib/redis}/dump.rdb"
    [ -f "$RDB" ] || RDB=/var/lib/redis/dump.rdb
    if [ -f "$RDB" ]; then
        mkdir -p "$STAGE/redis"; cp "$RDB" "$STAGE/redis/dump.rdb"
        ok "redis ledger ($("${RC[@]}" dbsize 2>/dev/null) keys, $(stat -c%s "$STAGE/redis/dump.rdb") bytes)"
    else
        die "redis is running but its dump was not found -- the share ledger would be lost"
    fi
else
    # Recorded rather than merely absent, so --verify can tell "this host has
    # no pool" apart from "the ledger silently went missing".
    echo "redis was not running on $(hostname) at $STAMP" > "$STAGE/NO-REDIS-ON-THIS-HOST"
    warn "no redis here; recorded a note so a later verify does not read as loss"
fi

# --- configuration, units, certificates ------------------------------------
#
# /opt/wam/pool/config.json is where the pool's configuration actually is,
# and until 2026-11-12 the only pool path in this list was
# /root/wam-pool/config.json, which exists on no host. The header above says
# "config and certs ... irreplaceable in practice" and the one file that is
# irreplaceable in practice -- the RPC and redis credentials, the pool's own
# payout address -- was in no archive at all. The old path stays because a
# path that is merely absent costs nothing, and because being wrong once
# about where a thing lives is a reason to keep both, not to swap one guess
# for another.
#
# pool/state/payments.journal is the record of what the pool has paid, kept
# outside redis precisely because redis comes back from a crash younger than
# it was. Restoring a host without it would restore the rolled-back redis
# and throw away the only thing that could notice -- so it is backed up with
# the ledger it exists to check.
mkdir -p "$STAGE/config"
for pattern in "$DATADIR/wam.conf" /etc/systemd/system/wam*.service \
               /etc/systemd/system/wam*.timer /etc/nginx /etc/letsencrypt \
               /opt/wam/pool/config.json /opt/wam/pool/state/payments.journal \
               /root/wam-pool/config.json; do
    for f in $pattern; do
        [ -e "$f" ] || continue
        d="$STAGE/config/$(dirname "${f#/}")"
        mkdir -p "$d"; cp -a "$f" "$d/" 2>/dev/null
    done
done
ok "config, units and certificates ($(find "$STAGE/config" -type f | wc -l) files)"

# --- a note for whoever opens this in an emergency -------------------------
cat > "$STAGE/RESTORE.txt" <<EOF
WAM Coin backup -- $STAMP UTC -- network: $NETWORK
From $(hostname), running $(wamd -version 2>/dev/null | head -1)

  gpg --decrypt wam-backup-$STAMP.tar.gz.gpg | tar xz

  wallets/<name>/wallet.dat
      -> <datadir>/${CHAINDIR:+$CHAINDIR/}wallets/<name>/wallet.dat
      check it first:  wam-wallet ${NETFLAG[*]} -datadir=<datadir> -wallet=<name> info

  redis/dump.rdb
      -> stop redis, copy to /var/lib/redis/, chown redis:redis, start

  config/
      mirrors absolute paths from /
      including opt/wam/pool/config.json (credentials) and
      opt/wam/pool/state/payments.journal -- restore the journal WITH the
      redis dump above, never one without the other: the journal is what
      notices that redis has come back older than the money.

Chain data is deliberately NOT here. Re-sync it from any peer -- that is what
a blockchain is for. Wallets and the share ledger are the part no peer can
give back to you.
EOF

# --- encrypt ---------------------------------------------------------------
OUT="$DEST/$PREFIX$STAMP.tar.gz.gpg"
if tar cz -C "$STAGE" --exclude='./tmp.*' . \
     | gpg --quiet --batch --yes --symmetric --cipher-algo AES256 \
           --passphrase-file "$PASSFILE" --output "$OUT" 2>/dev/null; then
    chmod 600 "$OUT"
    ok "encrypted: $(basename "$OUT") ($(stat -c%s "$OUT") bytes)"
else
    die "encryption failed -- no backup written"
fi

# --- and prove it restores now, not on the day it is needed ----------------
printf '\n  verifying what was just written:\n'
if ! verify_archive "$OUT"; then
    rm -f "$OUT"
    die "the archive does not restore -- deleted rather than left to be trusted"
fi

# --- rotate ----------------------------------------------------------------
COUNT="$(this_networks_archives | wc -l)"
if [ "$COUNT" -gt "$KEEP" ]; then
    this_networks_archives | tail -n +$((KEEP + 1)) | xargs -r rm -f
    ok "rotated, keeping the newest $KEEP of $COUNT $NETWORK archive(s)"
fi

printf '\n  %s%s%s\n' "$GRN" "$(basename "$OUT")" "$OFF"
printf '  Now pull it off this machine. A backup that exists only here is not one.\n\n'
