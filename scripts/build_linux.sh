#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  build_linux.sh -- build the node for a RELEASE, carrying its libraries
# ===========================================================================
#
#      bash scripts/fetch-upstream.sh          # fetch and patch Core first
#      bash scripts/build_linux.sh
#
#  WHY THIS EXISTS
#
#  Until 2026-10-18 this file did not exist, and that was the whole defect.
#
#  Windows has scripts/build_windows.sh and macOS has scripts/build_macos.sh.
#  Both run upstream's `depends`, which fetches and builds boost, libevent
#  and sqlite at the versions Core expects and links them in. Linux had no
#  release build at all: the release workflow ran
#
#      bash install.sh --build-only --node-only
#
#  which is the script a person runs to compile WAM on their own machine. It
#  installs build dependencies from apt and configures against them. That is
#  exactly right for someone building for the computer in front of them, and
#  wrong for producing a file for strangers, because the result then demands
#  the build machine's libraries from every machine that runs it.
#
#  It shipped that way. On 2026-10-18 Jeeves downloaded v0.1.12 onto Ubuntu
#  26 and got:
#
#      ./wamd: error while loading shared libraries: libevent-2.1.so.7:
#      cannot open shared object file: No such file or directory
#
#  Debian and Ubuntu split libevent across four packages and a stock image
#  installs libevent_core alone, so the aggregate libevent-2.1.so.7 our
#  binaries asked for is missing on an ordinary desktop. The node, the CLI,
#  wam-wallet and wam-qt were all affected; it reproduces on a clean Ubuntu
#  24.04. scripts/check_shared_deps.sh now refuses to let it happen quietly.
#
#  WHAT DEPENDS BUYS, AND WHAT IT DOES NOT
#
#  It buys the chain libraries: boost, libevent and sqlite are built here and
#  linked in, so the tarball carries them. It does not static-link glibc, and
#  nothing short of a pinned toolchain would -- the glibc floor is still the
#  floor of the machine this runs on, which is why package_release.sh checks
#  GLIBC_ and GLIBCXX_ symbol versions against a baseline and why that check
#  stays exactly as it is. The two questions are different and both are
#  asked now; before today only the second one was.
#
#  Nor does it make the build reproducible. Two people running this get
#  different bytes. That needs Guix, it is written down in the release notes
#  rather than implied, and it is not this script's job.
#
#  BERKELEY DB IS NOT DECIDED HERE
#
#  depends can build Berkeley DB. Turning it on would silently give Linux a
#  wallet capability it does not have today -- v0.1.12 refuses legacy BDB
#  wallets on Linux and accepts them on Windows and macOS, because those two
#  configure scripts pass no flag and autodetect against a depends tree that
#  built it, while scripts/build_qt.sh passes --without-bdb outright. Nobody
#  chose that spread; it fell out of three scripts written at different
#  times. It is a real decision and it is open.
#
#  This script therefore keeps Linux exactly as it is today and says so in
#  the line instead of inheriting it by accident. Changing what WAM supports
#  is not something a build script should do on the way past.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

log()  { printf '  %s\n' "$*"; }
ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '  %s!!%s    %s\n' "$YLW" "$OFF" "$*"; }
die()  { printf '\n  %sFAIL%s  %s\n\n' "$RED" "$OFF" "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this builds natively and must run on Linux.
          For Windows use scripts/build_windows.sh, for macOS build_macos.sh."

MACH="$(uname -m)"
[ "$MACH" = "x86_64" ] || die "the published Linux release is x86_64 only.
          This machine is $MACH. docs/ROADMAP.md section 7 records why."

BUILD_DIR="${BUILD_DIR:-$HERE/build}"
CORE_DIR="$BUILD_DIR/wam-core"
RANDOMX_DIR="$BUILD_DIR/randomx"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

# What every release's node must be able to do, for all three platforms, in
# one file. See its header for why it is not three lines in three scripts.
. "$HERE/scripts/lib/release_capabilities.sh"
# What a stranger's machine may be assumed to have, and the code that carries
# everything outside it into the build. Shared with check_shared_deps.sh and
# package_release.sh so the rule has one home.
. "$HERE/scripts/lib/shared_deps.sh"
HOST_TRIPLET="x86_64-pc-linux-gnu"

echo
echo "=================================================================="
echo " ${BLD}building the WAM node for Linux${OFF}  ($HOST_TRIPLET)"
echo "=================================================================="
echo

# libtoolize, and NOT libtool, and the difference is the whole of a failed
# release build.
#
# This list said `libtool`, and the message under it said to run
# `apt install ... libtool`. On Debian and Ubuntu that package installs
# libtoolize and does not install /usr/bin/libtool -- that binary lives in a
# separate package, libtool-bin. So the check demanded a program, named the
# package that does not contain it, and a reader doing exactly what it said
# would watch it fail again.
#
# It got as far as a release run: 2026-10-29, ubuntu-22.04, with release.yml
# installing every package the message asks for. Forty-four seconds, and the
# first thing this file has ever been asked to do, it refused.
#
# libtoolize is also the right question. autogen.sh runs `autoreconf
# --install`, which invokes libtoolize; each depends package generates its
# own libtool script rather than using a system one. Nothing here needs the
# binary that is missing.
#
# build_macos.sh carries the same line with `libtool` and is correct there:
# Homebrew's libtool formula does install the binary, and that path built
# clean on a real Mac runner the same morning. The trap is Debian's packaging
# alone, so the fix is here alone.
# patchelf is in this list although nothing here uses it: package_release.sh
# does, to give the wallet an RPATH for the libraries it carries. Checked at
# second one rather than at minute thirty, because a build that compiles for
# half an hour and then cannot be packaged has wasted the half hour.
for t in cmake autoconf automake libtoolize pkg-config make curl patch python3 patchelf; do
    command -v "$t" >/dev/null || die "$t is not installed. On Debian/Ubuntu:
          sudo apt install build-essential cmake autoconf automake libtool \\
                           pkg-config curl patch python3 patchelf
          (libtoolize comes from the libtool package. boost, libevent and
           sqlite come from depends, not apt -- that is the entire point of
           this script, see the header)"
done
ok "build tools present"

[ -d "$CORE_DIR" ] || die "$CORE_DIR is not here. Run scripts/fetch-upstream.sh first."
[ -d "$RANDOMX_DIR" ] || die "$RANDOMX_DIR is not here. Run scripts/fetch-upstream.sh first."
ok "patched Core tree and RandomX source are present"

# ---------------------------------------------------------------------------
printf '\n%s1. librandomx.a%s\n' "$BLD" "$OFF"

# Never ARCH=native. A release built with it carried 746 AVX-512 instructions
# and died with SIGILL on a CPU without them; RandomX picks up AES and AVX2 at
# runtime through randomx_get_flags(), so a baseline binary loses nothing.
RX_BUILD="$RANDOMX_DIR/build"
if [ -f "$RX_BUILD/librandomx.a" ]; then
    ok "already built"
else
    log "cmake, ARCH=x86-64"
    cmake -S "$RANDOMX_DIR" -B "$RX_BUILD" -DARCH=x86-64 \
        -DCMAKE_BUILD_TYPE=Release >/dev/null \
        || die "cmake could not configure RandomX"
    cmake --build "$RX_BUILD" -j"$JOBS" >/dev/null \
        || die "librandomx.a did not build"
fi
[ -f "$RX_BUILD/librandomx.a" ] || die "librandomx.a was not produced"

if [ -x "$RX_BUILD/randomx-tests" ]; then
    "$RX_BUILD/randomx-tests" >/dev/null 2>&1 \
        && ok "librandomx passes RandomX's own reference vectors" \
        || die "librandomx FAILS the reference test vectors.
          A node built on this would compute a different proof-of-work from
          every other node and could not stay on the chain. This is the one
          failure here that must never be worked around."
else
    warn "randomx-tests was not built -- the reference vectors were not run"
fi

# ---------------------------------------------------------------------------
cd "$CORE_DIR"
[ -f ./configure ] || ./autogen.sh >/dev/null || die "autogen.sh failed"

RANDOMX_CFLAGS="-I$RANDOMX_DIR/src"
RANDOMX_LIBS="$RX_BUILD/librandomx.a"

printf '\n%s2. depends for %s%s\n' "$BLD" "$HOST_TRIPLET" "$OFF"
log "boost, libevent, sqlite -- 20 to 60 minutes the first time"

# The wallet is off by default for the reason the other two scripts give:
# depends must build Qt before anything can link it, which is an hour before a
# line of WAM code is reached, and the node, the seed and the miner want none
# of it. WAM_WITH_GUI=1 asks for it.
WITH_GUI="${WAM_WITH_GUI:-0}"

# NO_BDB=1 is a decision, not a default. See the header.
#
# ZMQ IS BUILT, AND THAT IS ALSO A DECISION.
#
# It was off in all three build scripts, inherited rather than chosen, and
# it closes a door nobody noticed: an indexer takes block notifications over
# ZMQ, and every bitcoin-type coin in Trezor's Blockbook carries a message
# queue port -- checked against Litecoin, Dogecoin, Dash and Vertcoin. A node
# built with /* #undef ENABLE_ZMQ */ cannot drive one, so submitting WAM
# there would have been submitting a coin whose own node fails their backend.
#
# depends/packages/zeromq.mk is upstream's and already here. The cost is the
# minutes depends spends building it; the gain is that the node can tell
# other software a block arrived without being polled.
DEPENDS_COMMON=("HOST=$HOST_TRIPLET" NO_BDB=1 NO_UPNP=1 NO_NATPMP=1 NO_USDT=1)

build_depends() {  # $1 = extra make variables, "" for a Qt build
    make -C "$CORE_DIR/depends" "${DEPENDS_COMMON[@]}" $1 \
        -j"$JOBS" > "$BUILD_DIR/depends-linux.log" 2>&1
}

# THE WALLET MUST NEVER HOLD THE NODE'S RELEASE HOSTAGE.
#
# .github/workflows/release.yml made that a property of the workflow, with
# continue-on-error on the wallet step, because v0.1.11 carried a fix for a
# defect that loses a solo miner about two blocks in three and people were
# waiting for it. Moving the wallet into this script would have thrown that
# away: one configure, one make, and a Qt failure takes the node with it.
#
# So the resilience moves in here instead of being lost. Qt is built first,
# because it is the slow and fragile half, and if it fails the node is still
# built and still released -- as a node release, which is what every release
# before 2026-09-26 was.
if [ "$WITH_GUI" = "1" ]; then
    log "WAM_WITH_GUI=1 -- depends builds Qt first (the long part)"
    if ! build_depends ""; then
        warn "depends could not build Qt. The last 20 lines:"
        tail -20 "$BUILD_DIR/depends-linux.log" | sed 's/^/          /'
        warn "continuing WITHOUT the wallet. The node is not held up by this;"
        warn "SHA256SUMS will list no wallet and the notes will offer none."
        WITH_GUI=0
    fi
fi

if [ "$WITH_GUI" = "0" ]; then
    build_depends "NO_QT=1" \
        || die "depends failed for $HOST_TRIPLET. The last 30 lines:
$(tail -30 "$BUILD_DIR/depends-linux.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/depends-linux.log"
fi

CONFIG_SITE_PATH="$CORE_DIR/depends/$HOST_TRIPLET/share/config.site"
[ -f "$CONFIG_SITE_PATH" ] || die "depends produced no config.site at $CONFIG_SITE_PATH"
ok "depends built, config.site present"

# ---------------------------------------------------------------------------
printf '\n%s3. the node%s\n' "$BLD" "$OFF"
log "configure --host=$HOST_TRIPLET"
GUI_FLAG="--without-gui"
[ "$WITH_GUI" = "1" ] && GUI_FLAG="--with-gui=qt5"

CONFIG_SITE="$CONFIG_SITE_PATH" ./configure \
    --prefix=/ \
    "$GUI_FLAG" \
    --without-bdb \
    --with-sqlite=yes \
    --disable-tests-fuzz-binary \
    CPPFLAGS="$RANDOMX_CFLAGS" \
    LIBS="$RANDOMX_LIBS" \
    > "$BUILD_DIR/configure-linux.log" 2>&1 \
    || die "configure failed. The last 30 lines:
$(tail -30 "$BUILD_DIR/configure-linux.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/configure-linux.log
          Core's own: $CORE_DIR/config.log"
ok "configured"

# A CAPABILITY CAME AND WENT ONCE WITHOUT ANYBODY CHOOSING IT, SO THEY ARE
# ASSERTED NOW -- AND FOR ALL THREE PLATFORMS, NOT THIS ONE.
#
# --disable-zmq sat in all three build scripts, inherited rather than
# decided, and the cost only showed up when an indexer needed block
# notifications the node could not send. The first repair put the assertion
# here alone, which would have let a single release ship ZMQ on Linux and
# not on Windows or macOS. The list lives in one file now and binds all three.
assert_release_capabilities linux "$BUILD_DIR/configure-linux.log"

log "compiling with $JOBS jobs"
make -j"$JOBS" > "$BUILD_DIR/make-linux.log" 2>&1 \
    || die "the build failed. The last 40 lines:
$(tail -40 "$BUILD_DIR/make-linux.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/make-linux.log"
ok "compiled"

# ---------------------------------------------------------------------------
printf '\n%s4. the consensus tests, before anything is kept%s\n' "$BLD" "$OFF"

# The monetary schedule and the 5% treasury rule are the two things a
# different compiler or a different library version could quietly get wrong,
# and a node that gets either wrong forks itself off the chain at block 1.
if [ -x ./src/test/test_bitcoin ]; then
    ./src/test/test_bitcoin --run_test=wam_monetary_tests,wam_devfee_tests \
        > "$BUILD_DIR/tests-linux.log" 2>&1 \
        || die "the WAM consensus tests FAIL. Refusing to keep this binary.
          The last 20 lines:
$(tail -20 "$BUILD_DIR/tests-linux.log" | sed 's/^/          /')"
    ok "wam_monetary_tests and wam_devfee_tests pass"
else
    warn "test_bitcoin was not built -- the consensus tests did not run"
fi

# ---------------------------------------------------------------------------
printf '\n%s5. what it asks of a stranger'"'"'s machine%s\n' "$BLD" "$OFF"

# THE CHECK THAT WOULD HAVE STOPPED v0.1.12, RUN HERE RATHER THAN LATER.
#
# package_release.sh runs it again over the packaged tarballs, which is the
# artefact a person downloads. Running it here as well means a build that
# went wrong says so in the minute it happened instead of forty minutes
# later at packaging time, pointing at a build nobody can still see.
BUILT=()
for exe in wamd wam-cli wam-tx wam-util wam-wallet; do
    [ -f "src/$exe" ] && BUILT+=("src/$exe")
done
[ "$WITH_GUI" = "1" ] && [ -f src/qt/wam-qt ] && BUILT+=(src/qt/wam-qt)

if [ "${#BUILT[@]}" -eq 0 ]; then
    die "no executable was produced and make reported success.
          Look in $CORE_DIR/src for what was actually built."
fi

# CARRY BEFORE JUDGING, OR THE GATE FAILS THE BUILD FOR A LACK THE NEXT STEP
# WOULD HAVE FILLED.
#
# The node binaries need nothing: depends builds boost, libevent and sqlite
# as static archives and they are swallowed whole. The wallet cannot, because
# upstream's depends/packages/libxcb.mk sets --disable-static, so the X11
# stack is shared by that project's decision and wam-qt names seventeen .so
# files it linked from depends.
#
# They were carried at packaging time first. That is the right place for the
# archive and the wrong place for this: the gate below runs here, minutes
# after make, long before any archive exists -- so on 2026-10-29 it judged a
# bare binary and killed a twenty-eight minute build for asking after
# libraries that package_release.sh was about to hand it. Both steps carry
# now, independently, and the RPATH names both layouts.
if [ "$WITH_GUI" = "1" ] && [ -f src/qt/wam-qt ]; then
    if carry_libs src/qt/wam-qt \
                  "$CORE_DIR/depends/$HOST_TRIPLET/lib" \
                  src/qt/lib; then
        ok "wallet carries $(find src/qt/lib -name '*.so*' -type f 2>/dev/null | wc -l) library/libraries of its own"
    else
        die "wam-qt needs shared libraries that are not in
          $CORE_DIR/depends/$HOST_TRIPLET/lib, so the wallet would ask a
          stranger's machine for them -- which is the failure v0.1.12
          shipped with. Nothing is kept. See scripts/lib/shared_deps.sh."
    fi
fi

bash "$HERE/scripts/check_shared_deps.sh" "${BUILT[@]}" \
    || die "this build links libraries it does not carry, so it would fail on
          a machine that does not happen to have them -- which is how
          v0.1.12 reached Jeeves. Nothing is kept. Check that depends really
          produced $CONFIG_SITE_PATH and that configure used it:
          grep -i 'boost\|event\|sqlite' $BUILD_DIR/configure-linux.log"

# ---------------------------------------------------------------------------
printf '\n%swhat came out%s\n' "$BLD" "$OFF"

for b in "${BUILT[@]}"; do
    ok "$(basename "$b")  $(du -h "$b" | cut -f1)"
done

echo
log "scripts/package_release.sh reads these from $CORE_DIR/src"
echo
