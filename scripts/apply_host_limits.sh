#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  apply_host_limits.sh -- fit the services to the machine they are on
# ===========================================================================
#
#      bash scripts/apply_host_limits.sh                  # the three seeds
#      bash scripts/apply_host_limits.sh HOST [HOST...]
#      bash scripts/apply_host_limits.sh --show HOST      # read, change nothing
#
#  WHY THIS EXISTS
#
#  deploy/systemd carries MemoryMax=2G for the mainnet node and 4G for
#  ElectrumX. Those are sensible on a 12 GB machine and meaningless on the
#  Singapore seed, which has 1914 MB in total: a ceiling above the machine's
#  own memory bounds nothing at all.
#
#  So when memory runs short there, nothing we wrote decides anything. The
#  kernel's OOM killer decides, and it picks by size -- which means it picks
#  `wamd`, the largest process on the box at 580 MB. On launch night that is
#  the mainnet seed, and losing it is losing a third of the network's
#  visibility to anyone syncing from genesis.
#
#  The fix costs nothing and is not an upgrade: bound every service well
#  below total memory, and state the order of sacrifice ourselves.
#
#      testnet ElectrumX    +900   goes first, and nobody notices
#      testnet node         +700   testnet also runs on two other hosts
#      mainnet ElectrumX    +200   wallets lose one of two servers
#      mainnet node         -500   last, and only if nothing else is left
#
#  MEASURED, NOT GUESSED
#
#  The numbers come from what these services actually use:
#
#      wamd, testnet, dbcache=100     580 MB
#      electrumx, either network       50 MB   (its database is 3.2 MB)
#
#  An earlier plan for this file assumed ElectrumX wanted 300-500 MB and
#  concluded the small host needed replacing. It does not. Measuring first
#  turned a server purchase into four drop-in files.
#
#  MemoryHigh throttles and reclaims; MemoryMax kills. Setting High below
#  what a service genuinely needs causes constant reclaim -- slow, not
#  safe -- so each floor here sits above the measured figure with headroom.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

SHOW_ONLY=0
if [ "${1:-}" = "--show" ]; then SHOW_ONLY=1; shift; fi

HOSTS=("$@")
if [ "${#HOSTS[@]}" -eq 0 ]; then
    HOSTS=(169.58.159.165 5.223.52.200 13.140.33.187)
fi

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
FAIL=0

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15
          -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
rsh() { timeout 120 ssh "${SSH_OPTS[@]}" "root@$1" "$2" 2>/dev/null; }

echo "=================================================================="
echo " Which service dies first, decided here rather than by the kernel"
echo "=================================================================="

for h in "${HOSTS[@]}"; do
    printf '\n%s%s%s\n' "$BLD" "$h" "$OFF"

    MEM="$(rsh "$h" "awk '/^MemTotal:/{print int(\$2/1024)}' /proc/meminfo")"
    if ! [ "${MEM:-0}" -gt 0 ] 2>/dev/null; then
        printf '  %sno answer -- nothing changed here%s\n' "$YLW" "$OFF"
        FAIL=1
        continue
    fi
    printf '  %s MB of memory\n' "$MEM"

    # Shares of the machine, with floors from the measured figures above.
    # 35/25/10/10 leaves the operating system, fail2ban, the journal and the
    # watchers about a fifth, which is what they use today.
    hi_main=$((MEM * 35 / 100));  [ "$hi_main" -lt 650 ] && hi_main=650
    hi_test=$((MEM * 25 / 100));  [ "$hi_test" -lt 650 ] && hi_test=650

    # And the floor that matters more than any share: what the node on THIS
    # host is using right now, plus a third. A MemoryHigh below actual usage
    # does not protect anything -- it makes the kernel reclaim continuously
    # from a process that needs the memory, which is a slow node rather than
    # a safe one. Singapore's testnet node sits at 580 MB, so a 650 MB
    # ceiling left it 70 MB of room; measured, it gets 783.
    RSS="$(rsh "$h" "ps -eo rss,comm --no-headers | awk '\$2==\"wamd\"{s+=\$1} END{print int(s/1024)}'")"
    if [ "${RSS:-0}" -gt 0 ] 2>/dev/null; then
        need=$((RSS * 135 / 100))
        [ "$hi_test" -lt "$need" ] && hi_test="$need"
        [ "$hi_main" -lt "$need" ] && hi_main="$need"
        printf '  the node here is using %s MB, so no ceiling goes below %s MB
' "$RSS" "$need"
    fi
    hi_exm=$((MEM * 10 / 100));   [ "$hi_exm"  -lt 200 ] && hi_exm=200
    hi_ext=$((MEM * 10 / 100));   [ "$hi_ext"  -lt 200 ] && hi_ext=200
    cap=$((MEM * 80 / 100))
    mx() { local v=$(( $1 * 14 / 10 )); [ "$v" -gt "$cap" ] && v="$cap"; echo "$v"; }

    if [ "$SHOW_ONLY" -eq 1 ]; then
        for u in wamd.service wamd-mainnet.service \
                 wam-electrumx@testnet.service wam-electrumx@mainnet.service; do
            printf '  %-32s %s\n' "$u" \
                "$(rsh "$h" "systemctl show $u -p MemoryHigh -p MemoryMax -p OOMScoreAdjust 2>/dev/null | tr '\n' ' '")"
        done
        continue
    fi

    OUT="$(rsh "$h" "
set -e
write() {   # unit  high  max  oom
    d=/etc/systemd/system/\$1.d
    mkdir -p \"\$d\"
    cat > \"\$d/20-memory.conf\" <<EOF
# Written by scripts/apply_host_limits.sh from this host's own MemTotal.
# Do not hand-edit: run the script again instead, or the next host to be
# rebuilt gets different numbers for no recorded reason.
[Service]
MemoryHigh=\$2M
MemoryMax=\$3M
OOMScoreAdjust=\$4
EOF
    echo \"wrote \$d/20-memory.conf  high=\$2M max=\$3M oom=\$4\"
}
[ -f /etc/systemd/system/wamd.service ]          && write wamd.service          $hi_test $(mx $hi_test) 700
[ -f /etc/systemd/system/wamd-mainnet.service ]  && write wamd-mainnet.service  $hi_main $(mx $hi_main) -500
if [ -f /etc/systemd/system/wam-electrumx@.service ]; then
    write wam-electrumx@testnet.service $hi_ext $(mx $hi_ext) 900
    write wam-electrumx@mainnet.service $hi_exm $(mx $hi_exm) 200
fi
systemctl daemon-reload
echo reloaded
")"
    if [ -z "$OUT" ]; then
        printf '  %snothing was written -- ssh said nothing%s\n' "$RED" "$OFF"
        FAIL=1
        continue
    fi
    printf '%s\n' "$OUT" | sed 's/^/  /'

    # ------------------------------------------------------------------
    # And the half that systemd cannot do anything about.
    #
    # A MemoryHigh stops one service eating the machine. It does not stop
    # the machine being asked for more work, and the two things on a seed
    # that grow with the number of people running nodes are the number of
    # peers connecting to it -- it is a DNS seed, so everybody's first
    # connection attempt arrives here -- and the size of the mempool they
    # relay. Both are capped by defaults chosen for a desktop: 64 peers and
    # a 300 MB mempool, on a host with 1914 MB.
    #
    # So the caps are sized to the host as well, and the smallest host
    # takes the fewest strangers while the roomy ones take more. The DNS
    # seed rotation spreads the arrivals across all three either way.
    # THE UPPER CLAMP USED TO BE 110, AND IT THREW THE DERIVATION AWAY.
    #
    # MEM/48 gives 249 on the France host, 165 on US-east and 39 on
    # Singapore. The 39 is this formula working: the small host takes the
    # fewest strangers, exactly as the paragraph above says it should. The
    # other two were then flattened to 110 by a fixed number, so the two
    # machines with room to grow were the two that could not use it.
    #
    # On 2026-11-06 that bill came due. The three seeds held 107, 106 and 39
    # connections against 110, 110 and 39 -- seven free slots between the
    # three doors a new node knocks on -- on the morning the hash rate rose
    # 70% and new miners arrived. Nothing was broken. The doors were simply
    # full, and a formula that already knew the answer had been overruled.
    #
    # The clamp that remains is derived rather than chosen. A connection
    # costs one file descriptor; wamd-mainnet.service now sets
    # LimitNOFILE=65536 and Core keeps about 150 for itself, so descriptors
    # stop mattering long before this does. 2000 peers at MEM/48 implies a
    # 96 GB machine, which is not a host this project has -- so the clamp is
    # a guard against an absurd MemTotal reading, not a policy about size.
    # When a bigger seed is bought, the number follows the machine without
    # anyone editing this file.
    conn=$((MEM / 48));   [ "$conn" -lt 24   ] && conn=24
                          [ "$conn" -gt 2000 ] && conn=2000
    mpool=$((MEM / 20));  [ "$mpool" -lt 50  ] && mpool=50
                          [ "$mpool" -gt 300 ] && mpool=300
    mpool=$(( (mpool + 25) / 50 * 50 ))

    # Sent over stdin with the numbers as arguments, rather than pasted into
    # a quoted string. The first attempt at this hand-escaped a nested
    # double-quoted command, one \" came out as a bare " , the argument
    # ended early, and all three hosts reported "no node config was
    # written" -- with the reason swallowed by the 2>/dev/null in rsh().
    # Nothing below needs escaping, so nothing below can be mis-escaped.
    CONF_OUT="$(timeout 120 ssh "${SSH_OPTS[@]}" "root@$h" \
        "bash -s -- $conn $mpool" 2>&1 <<'REMOTE'
set -e
conn="$1"; mpool="$2"
for d in /root/.wam /root/.wam-mainnet; do
    f="$d/wam.conf"
    [ -f "$f" ] || continue
    cp -p "$f" "$f.before-host-limits" 2>/dev/null || true
    # Drop any block this script wrote before, and any hand-set duplicate of
    # the two keys it owns: Bitcoin Core takes the FIRST occurrence of an
    # option, so a leftover line above ours would silently win.
    sed -i '/^# --- host limits, written by apply_host_limits/,/^# --- end host limits/d' "$f"
    sed -i '/^maxconnections=/d;/^maxmempool=/d' "$f"
    {
        echo "# --- host limits, written by apply_host_limits.sh from this MemTotal"
        echo "maxconnections=$conn"
        echo "maxmempool=$mpool"
        echo "# --- end host limits"
    } >> "$f"
    echo "$f  maxconnections=$conn  maxmempool=$mpool"
done
REMOTE
)"
    if printf '%s' "$CONF_OUT" | grep -q "maxconnections="; then
        printf '%s\n' "$CONF_OUT" | sed 's/^/  /'
    else
        printf '  %sno node config was written%s: %s\n' "$RED" "$OFF" \
            "$(printf '%s' "$CONF_OUT" | head -2 | tr '\n' ' ')"
        FAIL=1
    fi

    # What is in effect now, which is not the same as what was written: a
    # running unit keeps its old limits until it restarts.
    for u in wamd.service wamd-mainnet.service; do
        eff="$(rsh "$h" "systemctl show $u -p MemoryHigh -p OOMScoreAdjust -p ActiveState 2>/dev/null | tr '\n' ' '")"
        case "$eff" in
            *"ActiveState=active"*)
                printf '  %sin effect after a restart%s  %s\n' "$YLW" "$OFF" "$u" ;;
            *) printf '  %sin effect at next start%s     %s\n' "$GRN" "$OFF" "$u" ;;
        esac
    done
done

echo
echo "=================================================================="
if [ "$FAIL" -eq 0 ]; then
    printf ' %severy host carries its own numbers now%s\n' "$GRN" "$OFF"
    echo
    echo ' The mainnet units are not running, so their limits apply the moment'
    echo ' they start on launch night. A running testnet node keeps its old'
    echo ' limits until it is restarted, which is not worth doing tonight.'
    echo "=================================================================="
    exit 0
fi
printf ' %sat least one host was not reached -- it has no policy%s\n' "$RED" "$OFF"
echo "=================================================================="
exit 1
