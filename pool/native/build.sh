#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  build.sh -- compile the RandomX addon without node-gyp
# ===========================================================================
#
#      bash pool/native/build.sh
#
#  node-gyp is the normal way to build a Node addon, and `npm run build:native`
#  still uses it. This exists because node-gyp has to be fetched from the npm
#  registry before it can do anything, and on a connection with a middlebox
#  corrupting TLS records ("decryption failed or bad record mac") that fetch
#  fails while everything else works.
#
#  All node-gyp actually does for a single-source addon is invoke the compiler
#  with the right include paths. Those paths are all available locally:
#
#      node headers      /usr/include/node          (from the nodejs package)
#      N-API C++ wrapper node_modules/node-addon-api
#      librandomx        built by scripts/fetch-upstream.sh
#
#  So this does it directly, and produces a .node at exactly the path
#  pool/native/index.js looks for.
#
#  Environment:
#      RANDOMX_INCLUDE   default ~/wam/build/randomx/src
#      RANDOMX_LIB       default ~/wam/build/randomx/build/librandomx.a
#      NODE_INCLUDE      default /usr/include/node
# ===========================================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POOL="$(cd "$HERE/.." && pwd)"

RANDOMX_INCLUDE="${RANDOMX_INCLUDE:-$HOME/wam/build/randomx/src}"
RANDOMX_LIB="${RANDOMX_LIB:-$HOME/wam/build/randomx/build/librandomx.a}"
NODE_INCLUDE="${NODE_INCLUDE:-/usr/include/node}"
NAPI_INCLUDE="$POOL/node_modules/node-addon-api"

OUT_DIR="$HERE/build/Release"
OUT="$OUT_DIR/wamrandomx.node"

fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }

echo "=================================================================="
echo " Building the WAM RandomX addon (direct, no node-gyp)"
echo "=================================================================="

[ -f "$NODE_INCLUDE/node_api.h" ] \
    || fail "Node headers not found at $NODE_INCLUDE.
     Install them with:  sudo apt-get install -y nodejs-dev libnode-dev"
ok "node headers      $NODE_INCLUDE"

[ -f "$NAPI_INCLUDE/napi.h" ] \
    || fail "node-addon-api not found at $NAPI_INCLUDE.
     Run 'npm ci' in $POOL first."
ok "node-addon-api    $NAPI_INCLUDE"

[ -f "$RANDOMX_INCLUDE/randomx.h" ] \
    || fail "randomx.h not found at $RANDOMX_INCLUDE.
     Run scripts/fetch-upstream.sh first."
ok "randomx headers   $RANDOMX_INCLUDE"

[ -f "$RANDOMX_LIB" ] \
    || fail "librandomx.a not found at $RANDOMX_LIB."
ok "librandomx        $RANDOMX_LIB"

mkdir -p "$OUT_DIR"

echo
echo "  compiling..."

# -fPIC and -shared because this is loaded as a shared object by the Node
# runtime. NAPI_DISABLE_CPP_EXCEPTIONS is off deliberately: the binding throws
# Napi::Error to report a failed RandomX allocation, which is the only sane way
# to surface "the machine does not have 2 GiB free" to JavaScript.
g++ -std=c++17 -O2 -fPIC -shared \
    -DNAPI_VERSION=8 \
    -I"$NODE_INCLUDE" \
    -I"$NAPI_INCLUDE" \
    -I"$RANDOMX_INCLUDE" \
    "$HERE/src/randomx_binding.cc" \
    "$RANDOMX_LIB" \
    -lpthread \
    -o "$OUT"

[ -f "$OUT" ] || fail "compilation produced no output"

SIZE=$(stat -c%s "$OUT")
ok "built             $OUT  ($(( SIZE / 1024 )) KB)"

echo
echo "  self-test..."
node -e "
const rx = require('$HERE/index.js');
const h = rx.selfTest();
console.log('  \x1b[32mok\x1b[0m    addon loads and hashes deterministically');
console.log('        sample digest ' + h.slice(0, 32) + '...');
"

echo
echo "=================================================================="
echo " Addon ready."
echo "=================================================================="
