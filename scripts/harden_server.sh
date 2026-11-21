#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  harden_server.sh -- prepare a fresh Ubuntu box to hold a pool wallet
# ===========================================================================
#
#      sudo bash scripts/harden_server.sh --network testnet
#
#  install.sh builds and installs WAM. It does nothing about the machine it
#  installs onto, and that machine will eventually hold the private key to a
#  pool wallet with other people's money in it.
#
#  THE TWO THAT MATTER MOST
#
#  Everything below is ordinary hardening except two rules, and those two are
#  the reason this script exists:
#
#      the RPC port must never be reachable from the internet
#      Redis must never be reachable from the internet
#
#  An open RPC port is the wallet. An open Redis is every miner's balance.
#  Both listen on localhost by default and both have been exposed by
#  accident on thousands of machines, always the same way: someone changed a
#  bind address for a second host and did not think about the firewall.
#
#  NOTHING HERE CAN LOCK YOU OUT
#
#  The dangerous step is disabling password logins over SSH. Done in the wrong
#  order it ends with an operator who cannot reach their own server. So it is
#  refused unless a usable key is already installed, and it is verified after
#  the fact rather than assumed. If anything is uncertain the script stops and
#  says what to do, leaving SSH exactly as it found it.
# ===========================================================================

set -euo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh" || exit 2

NETWORK="testnet"
SKIP_SSH=0
SERVICE_USER="${SUDO_USER:-$USER}"

while [ $# -gt 0 ]; do
    case "$1" in
        --network) NETWORK="$2"; shift 2 ;;
        --user)    SERVICE_USER="$2"; shift 2 ;;
        --skip-ssh) SKIP_SSH=1; shift ;;
        -h|--help) sed -n '4,40p' "$0"; exit 0 ;;
        *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

case "$NETWORK" in
    mainnet) P2P_PORT=9555;  RPC_PORT=9554  ;;
    testnet) P2P_PORT=19555; RPC_PORT=19554 ;;
    regtest) P2P_PORT=29555; RPC_PORT=29554 ;;   # was 19555: testnet's port
    *) printf 'unknown network: %s\n' "$NETWORK" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# What sshd will actually run with, for one keyword.
#
# The obvious form is `sshd -T | awk '/^key /{print $2; exit}'`. Do not use it.
# awk's `exit` closes the pipe while sshd is still writing, sshd dies of
# SIGPIPE, and `set -o pipefail` turns the whole pipeline into status 141.
# `set -e` then aborts at the assignment -- with no message, because a failed
# assignment prints nothing.
#
# That is not hypothetical. It is why this script wrote its SSH hardening,
# never verified it, never reloaded, and exited looking successful. And it is a
# race: the same line survives when the producer happens to finish first, so it
# fails on one machine and not the next.
#
# Reading to END cannot race. sshd -T is a few kilobytes; there is nothing to
# save by stopping early.
sshd_effective() {
    sshd -T 2>/dev/null | awk -v k="$1" '$1==k {v=$2} END{print v}'
}

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
ok()   { printf '  %sok%s    %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '  %swarn%s  %s\n' "$YELLOW" "$OFF" "$*"; }
die()  { printf '  %serror%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run this with sudo"

echo "=================================================================="
echo " Hardening this machine for WAM ($NETWORK)"
echo "=================================================================="

# ---------------------------------------------------------------------------
log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades >/dev/null
ok "ufw, fail2ban, unattended-upgrades"

# ---------------------------------------------------------------------------
log "firewall"

# Read the live SSH port rather than assuming 22. Assuming it is how people
# lock themselves out of servers they moved off the default port.
SSH_PORT="$(sshd -T 2>/dev/null | awk '$1=="port"{v=$2} END{print v}')"
SSH_PORT="${SSH_PORT:-22}"

ufw --force reset >/dev/null
ufw default deny incoming  >/dev/null
ufw default allow outgoing >/dev/null

ufw allow "${SSH_PORT}/tcp" comment 'ssh' >/dev/null
ok "ssh on ${SSH_PORT} allowed (read from sshd, not assumed)"

ufw allow "${P2P_PORT}/tcp" comment "wam p2p ${NETWORK}" >/dev/null
ok "peer-to-peer on ${P2P_PORT} allowed -- this is how the network finds you"

# Read the stratum ports from the pool's own config rather than guessing.
# This script hardcoded 3333 and 3334; the pool ships three ports -- 3333,
# 3334 and 3335, for CPUs, servers and farms -- so the largest miners were
# firewalled out of a pool that was listening for them. Neither side was
# wrong on its own, which is why nothing caught it.
POOL_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pool/config.json"
STRATUM_PORTS=""
if [ -f "$POOL_CONF" ] && command -v "$PY" >/dev/null 2>&1; then
    STRATUM_PORTS="$("$PY" -c '
import sys; sys.stdout.reconfigure(newline='\n')  # no \r on Windows
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    sys.exit()
print(" ".join(str(p["port"]) for p in c.get("ports", []) if isinstance(p.get("port"), int)))
' "$POOL_CONF" 2>/dev/null)"
fi

if [ -n "$STRATUM_PORTS" ]; then
    for p in $STRATUM_PORTS; do
        ufw allow "${p}/tcp" comment 'stratum' >/dev/null
    done
    ok "stratum on ${STRATUM_PORTS} allowed (read from pool/config.json)"
else
    ufw allow 3333/tcp comment 'stratum' >/dev/null
    ufw allow 3334/tcp comment 'stratum testnet' >/dev/null
    warn "pool/config.json not readable; allowed the default 3333 and 3334 only"
fi

ufw allow 80/tcp  comment 'http'  >/dev/null
ufw allow 443/tcp comment 'https' >/dev/null
ok "web on 80 and 443 allowed"

# The two that matter. Denied explicitly rather than left to the default,
# so that `ufw status` shows a human that somebody thought about them.
ufw deny "${RPC_PORT}/tcp" comment 'wam RPC -- never public' >/dev/null
ufw deny 6379/tcp          comment 'redis -- never public'   >/dev/null
ok "RPC ${RPC_PORT} and Redis 6379 explicitly denied"

ufw --force enable >/dev/null
ok "firewall active"

# ---------------------------------------------------------------------------
log "checking what is actually listening"

# A firewall rule is a claim. This is the check.
EXPOSED=0
while read -r addr port; do
    case "$port" in
        "$RPC_PORT"|6379)
            case "$addr" in
                127.0.0.1|::1|localhost) ;;
                *) warn "port ${port} is bound to ${addr}, not localhost"
                   warn "the firewall blocks it, but one rule change would expose it"
                   EXPOSED=1 ;;
            esac ;;
    esac
done < <(ss -ltn 2>/dev/null | awk '
    NR>1 {
        addr = $4; port = $4
        sub(/.*:/,    "", port)   # the port is whatever follows the last colon
        sub(/:[^:]*$/, "", addr)  # and the address is everything before it
        gsub(/^\[|\]$/, "", addr) # [::1]:6379 -- unwrap, or "[" reads as the address
        print (addr == "" ? "*" : addr), port
    }')

[ "$EXPOSED" = "0" ] && ok "RPC and Redis are bound to localhost only"

# ---------------------------------------------------------------------------
log "fail2ban"
systemctl enable --now fail2ban >/dev/null 2>&1 || true
ok "fail2ban running -- repeated failed SSH logins get banned"

log "unattended security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
ok "security updates install themselves"

# ---------------------------------------------------------------------------
log "ssh"

if [ "$SKIP_SSH" = "1" ]; then
    warn "skipped by request; password logins are still accepted"
else
    # `grep -c` prints the count AND exits 1 when the count is zero, so the
    # obvious `grep -c ... || echo 0` appends a second zero and yields the
    # string "0\n0". `[ "0\n0" -eq 0 ]` is not false -- it is an *error*, which
    # an `if` treats as false, which sends control to the branch that turns
    # password logins off. On a box whose authorized_keys exists but is empty
    # -- the default on most VPS images -- that is a permanent lockout, caused
    # by the very check written to prevent one.
    #
    # So: take grep's printed count and discard its status. `tr -dc` strips
    # anything that is not a digit, so no stray output can reach the arithmetic
    # test. The trailing `|| true` is load-bearing -- this script runs under
    # `set -euo pipefail`, where grep's exit 1 would otherwise fail the whole
    # pipeline and abort mid-hardening, firewall up and SSH half-configured.
    count_keys() {
        [ -f "$1" ] || { printf '0'; return; }
        grep -cE '(^|[[:space:]])(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp[0-9]+|sk-(ssh|ecdsa))' \
            "$1" 2>/dev/null | head -1 | tr -dc '0-9' || true
    }

    KEYFILE="$(getent passwd "$SERVICE_USER" | cut -d: -f6)/.ssh/authorized_keys"
    KEYCOUNT="$(count_keys "$KEYFILE")"
    ROOTKEYS="$(count_keys /root/.ssh/authorized_keys)"
    KEYCOUNT="${KEYCOUNT:-0}"
    ROOTKEYS="${ROOTKEYS:-0}"

    # If either is still not a plain number, something is wrong that this
    # script does not understand, and the safe reading of "I do not understand"
    # is "do not touch SSH".
    case "$KEYCOUNT$ROOTKEYS" in
        *[!0-9]*|'') die "could not count SSH keys; leaving password logins ON" ;;
    esac

    if [ "$KEYCOUNT" -eq 0 ] && [ "$ROOTKEYS" -eq 0 ]; then
        warn "no SSH key found for ${SERVICE_USER} or root."
        warn "Password logins are being LEFT ON, because turning them off now"
        warn "would lock you out of this machine permanently."
        warn ""
        warn "From your own computer, run:"
        warn "    ssh-copy-id ${SERVICE_USER}@<this server>"
        warn "confirm you can log in without a password, then run this script again."
    else
        ok "found ${KEYCOUNT} key(s) for ${SERVICE_USER}, ${ROOTKEYS} for root"

        cp -n /etc/ssh/sshd_config /etc/ssh/sshd_config.wam-orig 2>/dev/null || true

        # A drop-in only applies if sshd_config includes the directory. Ubuntu
        # has done so since 20.04, but a hand-edited or older config may not,
        # and then this file is inert: the script would report that passwords
        # are off while they are still accepted. A silent false claim of
        # protection is worse than no protection, because it stops anyone
        # looking again.
        DROPIN_DIR=/etc/ssh/sshd_config.d
        if ! grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
            warn "sshd_config does not Include ${DROPIN_DIR}."
            warn "Writing the hardening directly into sshd_config instead."
            DROPIN=/etc/ssh/sshd_config
            printf '\n# --- WAM harden_server.sh ---\n' >> "$DROPIN"
        else
            mkdir -p "$DROPIN_DIR"

            # OpenSSH takes the FIRST value it sees for a keyword, not the
            # last -- the opposite of most config systems, and of what almost
            # everyone assumes. Ubuntu cloud images ship 50-cloud-init.conf
            # containing `PasswordAuthentication yes`, so a file named
            # 60-anything is read afterwards and silently loses that one
            # keyword while winning every other one in the same file. The
            # result is a hardening drop-in that is present, correct, parsed,
            # and ignored.
            #
            # 00- sorts ahead of anything the distribution ships.
            DROPIN="${DROPIN_DIR}/00-wam.conf"
            rm -f "${DROPIN_DIR}/60-wam.conf"   # written before this was understood
            : > "$DROPIN"

            # Name any file that still sorts ahead of us and sets the keyword
            # that matters. sshd -T below is the real check; this says *which
            # file* won, which is the part that costs an hour to find by hand.
            for f in "$DROPIN_DIR"/*.conf; do
                [ -f "$f" ] || continue
                B="$(basename "$f")"
                [ "$B" \< "$(basename "$DROPIN")" ] || continue
                if grep -qiE '^[[:space:]]*PasswordAuthentication[[:space:]]' "$f"; then
                    warn "${B} is read before us and also sets PasswordAuthentication"
                fi
            done
        fi

        cat >> "$DROPIN" <<'EOF'
# Installed by WAM harden_server.sh.
# Password logins are how servers are taken: an attacker needs only time.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
EOF
        undo_ssh() {
            if [ "$DROPIN" = /etc/ssh/sshd_config ]; then
                [ -f /etc/ssh/sshd_config.wam-orig ] && \
                    cp /etc/ssh/sshd_config.wam-orig /etc/ssh/sshd_config
            else
                rm -f "$DROPIN"
            fi
        }

        if ! sshd -t 2>/dev/null; then
            undo_ssh
            die "the new sshd config did not validate; nothing was changed"
        fi

        # `sshd -t` checks syntax. It does not say whether the setting is in
        # effect -- a file in an un-included directory parses perfectly and
        # changes nothing. `sshd -T` prints the configuration sshd will
        # actually run with, which is the only answer that means anything.
        EFFECTIVE="$(sshd_effective passwordauthentication)"
        if [ "$EFFECTIVE" != "no" ]; then
            undo_ssh
            die "sshd still reports passwordauthentication=${EFFECTIVE:-unknown}.
     The hardening did not take effect, so it has been removed rather than
     left in place looking as though it had."
        fi

        # Ubuntu 24.04 enables ssh.socket, which opens port 22 and hands the
        # listening descriptor to ssh.service. Reload still reaches sshd, but
        # `restart` and `stop` no longer mean what they did: stopping the
        # service leaves the socket listening and the next connection starts it
        # again, and stopping the *socket* is what actually closes the port.
        # Reload only, and never touch ssh.socket -- a script that stops the
        # thing holding the port is a script that ends the session running it.
        if systemctl is-active --quiet ssh.socket 2>/dev/null; then
            ok "ssh.socket is active (Ubuntu 24.04 style); reloading the service only"
        fi
        systemctl reload ssh.service 2>/dev/null \
            || systemctl reload ssh 2>/dev/null \
            || systemctl reload sshd 2>/dev/null \
            || warn "could not reload sshd; the config is correct on disk but
     may not be live until the next restart"

        # Re-read after the reload: what sshd parses and what the running
        # daemon serves are two different questions, and the second is the one
        # that locks people out.
        RUNNING="$(sshd_effective passwordauthentication)"
        [ "$RUNNING" = "no" ] || warn "sshd reloaded but now reports ${RUNNING:-unknown}"

        ok "password logins disabled, keys only -- confirmed by sshd -T, not assumed"
        warn "Do not close this session. Open a SECOND terminal and confirm"
        warn "you can still log in. If you cannot, this session can undo it:"
        if [ "$DROPIN" = /etc/ssh/sshd_config ]; then
            warn "    sudo cp /etc/ssh/sshd_config.wam-orig /etc/ssh/sshd_config && sudo systemctl reload ssh"
        else
            warn "    sudo rm ${DROPIN} && sudo systemctl reload ssh"
        fi
    fi
fi

# ---------------------------------------------------------------------------
echo
echo "=================================================================="
ufw status verbose | sed 's/^/  /'
echo "=================================================================="
echo
echo " Still to do, and not done here because each needs a decision:"
echo
echo "   * point ${NETWORK} DNS at this machine, then get a certificate:"
echo "       sudo apt-get install -y certbot"
echo "       sudo certbot certonly --standalone -d explorer.wamcoin.org"
echo
echo "   * set -listen=1 in the wamd unit so peers can reach you."
echo "     A seed node that does not listen is not a seed node."
echo
echo "   * keep the pool wallet small. This machine is on the internet;"
echo "     treat whatever it holds as spendable by whoever takes it."
echo "=================================================================="

# ---------------------------------------------------------------------------
# git over HTTP/1.1, not HTTP/2.
#
# Measured on both seed servers, 2026-09-02. git 2.43.0 with libcurl 8.5.0 and
# nghttp2 1.59.0 -- what Ubuntu 24.04 ships -- fails against GitHub over
# HTTP/2 about one time in three, and six times in eight in a bad spell:
#
#   fatal: expected flush after ref listing
#   fatal: the remote end hung up unexpectedly
#
# The founder's laptop has a newer git and never failed once, which is exactly
# why this went unnoticed: every push succeeded, and the servers quietly
# stayed behind. The ops panel showed "deployed code is origin/main" going red
# a few minutes after every green, over and over, and it was telling the
# truth each time.
#
# HTTP/1.1 rather than protocol.version=0. Both make it work; the broken layer
# is the transport, and pinning git's protocol to its oldest version would go
# on hiding that for years after the transport is fixed.
# ---------------------------------------------------------------------------
log "git fetches over HTTP/1.1 (HTTP/2 is broken in this git+curl pair)"
git config --system http.version HTTP/1.1
ok "git http.version = $(git config --system --get http.version)"
