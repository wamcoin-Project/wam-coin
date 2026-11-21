#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  build_qt.sh -- reconfigure the tree with the Qt GUI and build it
# ===========================================================================
#
#      bash scripts/build_qt.sh
#
#  The tree is normally configured with --without-gui, because the node, the
#  pool and the miner need nothing from Qt and the GUI roughly doubles the
#  build. This turns it on.
#
#  Prerequisites (one apt-get, needs root):
#      qtbase5-dev qttools5-dev qttools5-dev-tools libqrencode-dev
#
#  Re-running ./configure invalidates every object file, so this is a full
#  rebuild. On 24 cores expect twenty minutes or so.
# ===========================================================================

set -euo pipefail

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh" || exit 2

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# WHERE THE TREE IS, ASKED RATHER THAN REMEMBERED.
#
# This file said $HOME/wam/build and nothing else. fetch-upstream.sh builds
# into <repo>/build, which is where install.sh leaves it and where
# package_release.sh looks -- so on any machine that followed the documented
# path, including the release runner, this script would have stopped at "no
# tree at /home/runner/wam/build/wam-core" while the tree sat in the
# repository beside it.
#
# package_release.sh and miner/build.sh both carried this defect and both were
# fixed the same way. It is the third time, which is why it is written here in
# the same words: a path remembered instead of asked.
for base in "$REPO/build" "$HOME/wam/build"; do
    [ -d "$base/wam-core" ] && BUILD_BASE="$base" && break
done
BUILD_BASE="${BUILD_BASE:-$REPO/build}"

TREE="${TREE:-$BUILD_BASE/wam-core}"
RANDOMX="${RANDOMX:-$BUILD_BASE/randomx}"
JOBS="${JOBS:-$(nproc)}"

fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }

echo "=================================================================="
echo " Building wam-qt"
echo "=================================================================="

[ -d "$TREE" ] || fail "no tree at $TREE -- run scripts/fetch-upstream.sh first"
[ -f "$TREE/configure.ac" ] || fail "$TREE is not a Bitcoin Core tree (no configure.ac)"
ok "tree              $TREE"

# A FRESH TREE HAS NO configure AT ALL, AND THAT IS THE NORMAL CASE.
#
# This required one to exist and failed with "no configure script" otherwise.
# That held for as long as this was only ever run after install.sh had already
# configured the tree once -- and it broke the first time the GUI was built
# the way a release must build it: from fetch-upstream.sh and nothing else, on
# a machine with no previous build on it.
#
# The regeneration below already knew how to run autogen.sh; it just would not
# reach it. So the absence of configure is now a reason to generate it rather
# than a reason to stop.
if [ ! -f "$TREE/configure" ]; then
    command -v autoconf >/dev/null 2>&1 \
        || fail "this tree has never been configured and autoconf is missing:
     sudo apt-get install -y autoconf automake libtool pkg-config"
    echo
    echo "  no configure script yet; generating it..."
    ( cd "$TREE" && ./autogen.sh ) > /tmp/wam_qt_autogen.log 2>&1 \
        || { tail -20 /tmp/wam_qt_autogen.log; fail "autogen.sh failed"; }
    ok "generated         configure"
fi

command -v qmake >/dev/null 2>&1 \
    || fail "qmake not found. Install the Qt development packages first:
     sudo apt-get install -y qtbase5-dev qttools5-dev qttools5-dev-tools libqrencode-dev"
ok "qt                $(pkg-config --modversion Qt5Core 2>/dev/null || echo 'unknown')"

[ -f "$RANDOMX/build/librandomx.a" ] || fail "librandomx.a not found under $RANDOMX"
ok "librandomx        $RANDOMX/build/librandomx.a"

cd "$TREE"

# configure.ac is generated into configure by autoconf. Editing the former
# without re-running autogen leaves the build using the old one, which fails
# silently -- the package keeps its old name and nothing says why.
if [ configure.ac -nt configure ] \
   || [ src/Makefile.am -nt configure ] \
   || [ src/Makefile.qt.include -nt configure ]; then
    command -v autoconf >/dev/null 2>&1 \
        || fail "configure.ac changed but autoconf is missing:
     sudo apt-get install -y autoconf automake libtool pkg-config"
    echo
    echo "  configure.ac changed; regenerating configure..."
    ./autogen.sh > /tmp/wam_qt_autogen.log 2>&1 \
        || { tail -20 /tmp/wam_qt_autogen.log; fail "autogen.sh failed"; }
    ok "regenerated       configure"
fi

# The GUI's wording. Idempotent, so it runs unconditionally: forgetting it once
# ships a wallet that asks the user for a "Bitcoin address".
if [ -f "$REPO/scripts/rebrand_qt.py" ]; then
    echo
    echo "  rebranding the GUI text..."
    "$PY" "$REPO/scripts/rebrand_qt.py" --tree "$TREE" | sed 's/^/  /'
fi

echo
echo "  configuring with the GUI enabled..."
./configure \
    --with-gui=qt5 \
    --disable-bench \
    --disable-fuzz-binary \
    --with-sqlite=yes \
    --without-bdb \
    CPPFLAGS="-I$RANDOMX/src" \
    LIBS="$RANDOMX/build/librandomx.a -lpthread" \
    > /tmp/wam_qt_configure.log 2>&1 \
    || { tail -30 /tmp/wam_qt_configure.log; fail "configure failed"; }

grep -qE '^ *with GUI *= *(qt5|yes)' config.log 2>/dev/null || true
ok "configured        GUI enabled"

echo
echo "  building with $JOBS jobs (this takes a while)..."
make -j"$JOBS" > /tmp/wam_qt_build.log 2>&1 \
    || { tail -40 /tmp/wam_qt_build.log; fail "build failed -- see /tmp/wam_qt_build.log"; }

GUI_BIN=""
for candidate in src/qt/wam-qt src/qt/bitcoin-qt; do
    [ -x "$candidate" ] && GUI_BIN="$candidate" && break
done
[ -n "$GUI_BIN" ] || fail "the build finished but produced no GUI binary"

ok "built             $TREE/$GUI_BIN  ($(( $(stat -c%s "$GUI_BIN") / 1024 / 1024 )) MB)"

for candidate in src/wamd src/bitcoind; do
    [ -x "$candidate" ] && ok "node              $TREE/$candidate" && break
done

echo
echo "=================================================================="
echo " Done. Launch it with:"
echo
echo "   $TREE/$GUI_BIN -regtest -datadir=\$HOME/wam-regtest"
echo "=================================================================="
