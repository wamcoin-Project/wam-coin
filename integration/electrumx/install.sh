#!/bin/bash
# ===========================================================================
#  install.sh -- an ElectrumX server for WAM
# ===========================================================================
#
#      sudo bash integration/electrumx/install.sh [--network testnet|mainnet]
#                                                 [--domain <hostname>]
#                                                 [--port-base 50000]
#                                                 [--node-unit wamd.service]
#
#  Komodo Wallet cannot list a UTXO coin without ElectrumX servers carrying
#  valid SSL; their repository has an electrums/ directory and an entry there is
#  required, not optional. Separately, this is what lets a light wallet read a
#  balance without downloading the chain.
#
#  WHICH ELECTRUMX, AND WHY
#
#  Three exist and only one fits:
#
#    kyuupichan/electrumx  the original. Now specialised to Bitcoin SV: its
#                          only two coin classes are BSV and BSV testnet. BSV
#                          has no SegWit and a different transaction format.
#    romanz/electrs        maintained and fast, but written in Rust with the
#                          networks compiled in. A fork, not a config.
#    spesmilo/electrumx    maintained, 165 coin classes, SegWit. This one.
#
#  spesmilo's 2.0 targets Bitcoin Core 31 and wants a txospenderindex that Core
#  31 added for Electrum protocol 1.7. WAM is Core v28.1 and has neither, so the
#  WAM coin class lowers both. That was tested, not assumed -- see
#  wam_coins.py.
#
#  This server holds no keys. It reads the node and answers questions.
#
#  ONE INSTANCE PER NETWORK
#
#  Everything below carries the network in its name: the env file, the
#  database, the service instance and the ports. Until 2026-08-29 it did not,
#  and running this for mainnet would have overwritten the testnet
#  configuration in place -- pointing a mainnet server at a database indexed
#  for another chain and taking the testnet servers down in the same move. On
#  launch night, with a testnet still needed for anyone verifying the chain.
#
#  --port-base gives a third set of ports for rehearsal, so a mainnet
#  instance can be proved end to end without touching the ports a live
#  testnet is serving on.
# ===========================================================================

set -euo pipefail

NETWORK="testnet"
DOMAIN="electrum.wamcoin.org"
EX_DIR=/opt/electrumx
EX_USER=electrumx
PORT_BASE=""
NODE_UNIT=""
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --network)   NETWORK="${2:?--network needs a value}"; shift ;;
        --domain)    DOMAIN="${2:?--domain needs a value}"; shift ;;
        --port-base) PORT_BASE="${2:?--port-base needs a value}"; shift ;;
        --node-unit) NODE_UNIT="${2:?--node-unit needs a value}"; shift ;;
        -h|--help) sed -n '3,44p' "$0"; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
    shift
done

# Mainnet keeps 50001/50002/50004 because those are the ports published in
# the Komodo entry and the listing sheet, and a published endpoint is a
# promise. Testnet takes the 51xxx set.
case "$NETWORK" in
    mainnet) RPC_PORT=9554  ; DEFAULT_BASE=50000 ; DEFAULT_UNIT=wamd.service ;;
    testnet) RPC_PORT=19554 ; DEFAULT_BASE=51000 ; DEFAULT_UNIT=wamd.service ;;
    *) echo "network must be mainnet or testnet" >&2; exit 2 ;;
esac

[ -n "$PORT_BASE" ] || PORT_BASE=$DEFAULT_BASE
[ -n "$NODE_UNIT" ] || NODE_UNIT=$DEFAULT_UNIT

case "$PORT_BASE" in
    ''|*[!0-9]*) echo "--port-base must be a number" >&2; exit 2 ;;
esac

TCP_PORT=$((PORT_BASE + 1))
SSL_PORT=$((PORT_BASE + 2))
WSS_PORT=$((PORT_BASE + 4))
# ElectrumX's own local control port. Two instances on one host cannot share
# it, and the clash is not reported as a clash: the second instance simply
# exits at startup.
LOCAL_RPC=$((8000 + PORT_BASE / 1000 - 50))

DB_DIR=/var/lib/electrumx-wam-$NETWORK
ENV_FILE=/etc/wam/electrumx-$NETWORK.env
UNIT=wam-electrumx@$NETWORK

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; OFF=$'\033[0m'
ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '  %swarn%s  %s\n' "$YLW" "$OFF" "$*"; }
fail() { printf '  %sfail%s  %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
step() { printf '\n%s%s%s\n' "$CYN" "$*" "$OFF"; }

[ "$(id -u)" = 0 ] || fail "run this with sudo"

# ---------------------------------------------------------------------------
step "1. dependencies"

DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    git python3-venv python3-dev build-essential libleveldb-dev certbot >/dev/null 2>&1
ok "build tools, leveldb and certbot"

# ---------------------------------------------------------------------------
step "2. the user this runs as"

id -u "$EX_USER" >/dev/null 2>&1 || \
    useradd --system --no-create-home --shell /usr/sbin/nologin "$EX_USER"
ok "$EX_USER (system account, no shell, no home)"

install -d -o "$EX_USER" -g "$EX_USER" -m 0750 "$DB_DIR"
ok "$DB_DIR"

# ---------------------------------------------------------------------------
step "3. ElectrumX"

if [ ! -d "$EX_DIR/.git" ]; then
    git clone -q --depth 1 https://github.com/spesmilo/electrumx.git "$EX_DIR"
fi
ok "$(cd "$EX_DIR" && git log --oneline -1)"

[ -d "$EX_DIR/venv" ] || python3 -m venv "$EX_DIR/venv"
"$EX_DIR/venv/bin/pip" install -q --upgrade pip setuptools wheel

# spesmilo's fork uses pyproject.toml and resolves its own dependencies, so the
# normal isolated build works. The older kyuupichan layout did not: its
# setup.py imported the package to read its version, and the package imported
# aiorpcx, which an isolated build environment cannot resolve. Both paths are
# kept because the failure is silent-looking -- pip reports a build error, not
# a missing dependency, and the first reading sends you after the wrong thing.
if ! "$EX_DIR/venv/bin/pip" install -q "$EX_DIR" 2>/dev/null; then
    warn "isolated build failed; retrying without isolation"
    [ -f "$EX_DIR/requirements.txt" ] && \
        "$EX_DIR/venv/bin/pip" install -q -r "$EX_DIR/requirements.txt"
    "$EX_DIR/venv/bin/pip" install -q --no-build-isolation "$EX_DIR"
fi

# plyvel is the leveldb binding and is an extra rather than a dependency, so it
# is never pulled in by either path above.
"$EX_DIR/venv/bin/pip" install -q plyvel
ok "installed"

python3 "$REPO/integration/electrumx/wam_coins.py" \
    "$EX_DIR/src/electrumx/lib/coins.py" | sed 's/^/  /'

chmod -R a+rX "$EX_DIR"

# ---------------------------------------------------------------------------
step "4. the certificate"

if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    MY_IP="$(curl -s -m 15 https://api.ipify.org || true)"
    DNS_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
    [ -n "$DNS_IP" ] || fail "$DOMAIN does not resolve; add an A record first"
    [ "$MY_IP" = "$DNS_IP" ] || fail "$DOMAIN points at $DNS_IP, not this host ($MY_IP)"

    if ss -lnt | grep -q ':80 '; then
        certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos \
            -m wam.coin.official@proton.me
    else
        certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos \
            -m wam.coin.official@proton.me
    fi
fi
[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] || fail "no certificate"
ok "certificate for $DOMAIN, renewing automatically"

# ElectrumX reads the certificate as its own unprivileged user, so it needs to
# traverse letsencrypt's directories. Group-readable rather than world.
groupadd -f ssl-cert
usermod -aG ssl-cert "$EX_USER"
chgrp -R ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
ok "certificate readable by $EX_USER, and by nobody else"

# THAT WAS A ONE-TIME ACT, AND ONE-TIME TURNED OUT NOT TO BE ENOUGH.
#
# It survives renewals, because certbot preserves a private key's group and
# mode when it renews a lineage it already knows. It does not survive a
# lineage being created anew: the key is then written root:root 0600 and the
# unprivileged user above cannot read it.
#
# And nothing here ever restarted ElectrumX when the files under it changed.
# It reads the certificate once at startup, so a renewed one is served only
# when something restarts the service for its own reasons.
#
# Both failures were paid for on seed3 on 1 November 2026, when
# electrum2.wamcoin.org was issued a real certificate for the first time --
# it had been running on one hand-copied from another host in August. The
# hook closes both, after every renewal, on every host this installs on.
install -m 0755 "$REPO/deploy/cert/wam-reload-electrumx" \
        /usr/local/bin/wam-reload-electrumx
install -d /etc/letsencrypt/renewal-hooks/deploy
ln -sf /usr/local/bin/wam-reload-electrumx \
       /etc/letsencrypt/renewal-hooks/deploy/wam-reload-electrumx
ok "certbot reloads ElectrumX after every renewal"

# ---------------------------------------------------------------------------
step "5. configuration"

# Ask the node unit where its configuration is rather than assuming. The two
# networks keep separate data directories, and an ElectrumX pointed at the
# wrong conf reads credentials that do not open the daemon it was told to
# follow -- which surfaces as an authentication failure at startup and sends
# you looking at the password rather than at the path.
NODE_CONF="$(systemctl show "$NODE_UNIT" -p ExecStart --value 2>/dev/null \
    | tr ' ' '\n' | sed -n 's/^-\{1,2\}conf=//p' | head -1)"
if [ -z "$NODE_CONF" ]; then
    case "$NETWORK" in
        mainnet) NODE_CONF=/root/.wam-mainnet/wam.conf ;;
        testnet) NODE_CONF=/root/.wam/wam.conf ;;
    esac
    warn "$NODE_UNIT names no -conf; assuming $NODE_CONF"
fi
[ -f "$NODE_CONF" ] || fail "$NODE_CONF does not exist"

RPCU="$(grep -m1 '^rpcuser=' "$NODE_CONF" | cut -d= -f2-)"
RPCP="$(grep -m1 '^rpcpassword=' "$NODE_CONF" | cut -d= -f2-)"

# A node with no rpcuser authenticates by cookie, and the cookie is rewritten
# every time the node starts. Baking one into this file produces a server
# that works today and fails silently at the node's next restart -- so refuse
# it here, where the message can still be read, rather than at 3am.
if [ -z "$RPCU" ] || [ -z "$RPCP" ]; then
    fail "$NODE_CONF sets no rpcuser/rpcpassword, so the node authenticates by
        cookie and the cookie changes at every node restart. Add a fixed pair
        to that file and restart the node BEFORE its network opens -- a
        mainnet node started before its genesis date cannot be restarted."
fi
ok "credentials from $NODE_CONF"

mkdir -p /etc/wam
# Written 0600 first, so the credentials are never briefly world-readable
# while the file is being assembled.
umask 077
cat > "$ENV_FILE" <<EOF
COIN=WAMCoin
NET=$NETWORK
DB_ENGINE=leveldb
DB_DIRECTORY=$DB_DIR
DAEMON_URL=http://$RPCU:$RPCP@127.0.0.1:$RPC_PORT/
SERVICES=tcp://:$TCP_PORT,ssl://:$SSL_PORT,wss://:$WSS_PORT,rpc://127.0.0.1:$LOCAL_RPC
REPORT_SERVICES=tcp://$DOMAIN:$TCP_PORT,ssl://$DOMAIN:$SSL_PORT,wss://$DOMAIN:$WSS_PORT
SSL_CERTFILE=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
SSL_KEYFILE=/etc/letsencrypt/live/$DOMAIN/privkey.pem
PEER_DISCOVERY=self
PYTHONPATH=$EX_DIR/src
EOF
chown root:"$EX_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
ok "$ENV_FILE (0640, root:$EX_USER)"

# ---------------------------------------------------------------------------
step "6. the service"

install -m 644 "$REPO/deploy/systemd/wam-electrumx@.service" \
    /etc/systemd/system/wam-electrumx@.service

# Which node this instance follows is per-instance, so it goes in a drop-in
# rather than in the template. Requires, not Wants: an ElectrumX whose node
# has gone away keeps answering from its last state, and a wrong balance is
# worse to a wallet than an error.
install -d -m 755 "/etc/systemd/system/$UNIT.service.d"
cat > "/etc/systemd/system/$UNIT.service.d/10-node.conf" <<EOF
[Unit]
Requires=$NODE_UNIT
After=$NODE_UNIT
EOF

# A memory ceiling above the memory that exists is not a ceiling. Leave the
# kernel a quarter of the machine and let systemd stop ElectrumX before the
# OOM killer picks a victim of its own choosing -- which on these hosts has
# every chance of being the node.
TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "${TOTAL_MB:-0}" -gt 0 ] && [ "$TOTAL_MB" -lt 5461 ]; then
    cat > "/etc/systemd/system/$UNIT.service.d/20-memory.conf" <<EOF
[Service]
MemoryMax=$((TOTAL_MB * 3 / 4))M
EOF
    ok "memory ceiling $((TOTAL_MB * 3 / 4))M of ${TOTAL_MB}M on this host"
fi

systemctl daemon-reload
ok "installed $UNIT (node: $NODE_UNIT)"

printf '\n  Start it with:\n\n      sudo systemctl enable --now %s\n\n' "$UNIT"
printf '  Then open %s, %s and %s -- and open them TWICE. ufw is only\n' \
    "$TCP_PORT" "$SSL_PORT" "$WSS_PORT"
printf '  half of it: Contabo drops inbound TCP to any port that is not on an\n'
printf '  allow-list in their control panel, and a dropped packet is silent, so\n'
printf '  the server looks perfect from the inside while nothing can reach it.\n\n'
printf '      sudo ufw allow %s/tcp && sudo ufw allow %s/tcp && sudo ufw allow %s/tcp\n\n' \
    "$TCP_PORT" "$SSL_PORT" "$WSS_PORT"
printf '  Then prove it from a DIFFERENT machine, never from this one:\n\n'
printf '      bash scripts/check_reachable.sh --host <this ip> --from <other ip> \\\n'
printf '          %s %s %s\n\n' "$TCP_PORT" "$SSL_PORT" "$WSS_PORT"
printf '  %s carries the Electrum protocol over WebSocket, which is how the\n' "$WSS_PORT"
printf '  web build of Komodo Wallet connects. Desktop and mobile use %s.\n\n' "$SSL_PORT"
