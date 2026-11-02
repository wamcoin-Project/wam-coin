#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  build_macos.sh -- build the node on macOS, natively
# ===========================================================================
#
#      bash scripts/fetch-upstream.sh          # fetch and patch Core first
#      bash scripts/build_macos.sh
#
#  WHY NATIVE AND NOT CROSS-COMPILED
#
#  Upstream supports cross-compiling for macOS from Linux, and it needs the
#  macOS SDK extracted from Xcode 15, downloaded with an Apple account, under
#  a licence that lets nobody redistribute it. That is a real cost and it was
#  the reason macOS was put behind Windows in docs/ROADMAP.md §7.
#
#  The second reason given there was worse and was wrong: that nobody here has
#  a Mac to test on. GitHub's hosted runners include real macOS machines, free
#  for public repositories, and this repository is public. So the build is
#  native -- Xcode is already there, no SDK is extracted and no licence
#  question arises -- and the same runner can RUN what it built and sync the
#  chain. The test that was called impossible is the cheaper half.
#
#  TWO MACS, NOT ONE
#
#  Every Mac sold since 2020 is arm64 and everything before it is x86_64, and
#  a binary for one does not run on the other. This script builds for whatever
#  it is running on and says which, so the two runners produce two artifacts
#  that are labelled rather than two files with the same name.
#
#  ARCH FOR RANDOMX, WHICH IS NOT THE SAME QUESTION ON ARM
#
#  scripts/fetch-upstream.sh passes ARCH=x86-64 to RandomX, never native,
#  because a release built with native carried 746 AVX-512 instructions and
#  died with SIGILL on a CPU without them.
#
#  ARCH is an x86 option. Passing x86-64 on Apple Silicon is meaningless at
#  best, so this passes it only on an Intel Mac and lets RandomX decide on
#  arm64 -- and never passes native anywhere. The Apple Silicon baseline is a
#  real question that this does not answer: check_isa_baseline.sh now says so
#  out loud instead of reporting an arm64 binary as within an x86-64 baseline.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

log()  { printf '  %s\n' "$*"; }
ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '  %s!!%s    %s\n' "$YLW" "$OFF" "$*"; }
die()  { printf '\n  %sFAIL%s  %s\n\n' "$RED" "$OFF" "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this builds natively and must run on macOS.
          For Windows use scripts/build_windows.sh, which cross-compiles."

MACH="$(uname -m)"          # arm64 or x86_64
BUILD_DIR="${BUILD_DIR:-$HERE/build}"
CORE_DIR="$BUILD_DIR/wam-core"
RANDOMX_DIR="$BUILD_DIR/randomx"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

# What every release's node must be able to do, for all three platforms, in
# one file. See its header for why it is not three lines in three scripts.
. "$HERE/scripts/lib/release_capabilities.sh"
OUT_DIR="${OUT_DIR:-$HERE/out/macos-$MACH}"

echo
echo "=================================================================="
echo " ${BLD}building the WAM node for macOS${OFF}  ($MACH)"
echo "=================================================================="
echo

for t in cmake autoconf automake libtool pkg-config; do
    command -v "$t" >/dev/null || die "$t is not installed. On macOS:
          brew install automake libtool pkg-config cmake
          (boost, libevent and sqlite come from depends, not brew --
           see the comment above section 2)"
done
ok "build tools present"

[ -d "$CORE_DIR" ] || die "$CORE_DIR is not here. Run scripts/fetch-upstream.sh first."
[ -d "$RANDOMX_DIR" ] || die "$RANDOMX_DIR is not here. Run scripts/fetch-upstream.sh first."
ok "patched Core tree and RandomX source are present"

# ---------------------------------------------------------------------------
printf '\n%s1. librandomx.a%s\n' "$BLD" "$OFF"

RX_BUILD="$RANDOMX_DIR/build"
if [ -f "$RX_BUILD/librandomx.a" ]; then
    ok "already built"
else
    RX_ARGS=(-DCMAKE_BUILD_TYPE=Release)
    if [ "$MACH" = "x86_64" ]; then
        # Never native. See the header.
        RX_ARGS+=(-DARCH=x86-64)
        log "cmake, ARCH=x86-64"
    else
        log "cmake, arm64 (ARCH is an x86 option and is not passed)"
    fi
    cmake -S "$RANDOMX_DIR" -B "$RX_BUILD" "${RX_ARGS[@]}" >/dev/null \
        || die "cmake could not configure RandomX"
    cmake --build "$RX_BUILD" -j"$JOBS" >/dev/null \
        || die "librandomx.a did not build"
fi
[ -f "$RX_BUILD/librandomx.a" ] || die "librandomx.a was not produced"

if [ -x "$RX_BUILD/randomx-tests" ]; then
    "$RX_BUILD/randomx-tests" >/dev/null 2>&1 \
        && ok "librandomx passes RandomX's own reference vectors" \
        || die "librandomx FAILS the reference test vectors on $MACH.
          A node built on this would compute a different proof-of-work from
          every other node and could not stay on the chain. This is the one
          failure here that must never be worked around."
else
    warn "randomx-tests was not built -- the reference vectors were not run"
fi


cd "$CORE_DIR"
[ -f ./configure ] || ./autogen.sh >/dev/null || die "autogen.sh failed"

RANDOMX_CFLAGS="-I$RANDOMX_DIR/src"
RANDOMX_LIBS="$RX_BUILD/librandomx.a"

# depends, not Homebrew.
#
# The first version of this pointed configure at Homebrew's boost, libevent
# and sqlite, and it failed on the macos-14 runner with twenty errors starting
# here:
#
#     boost/multi_index_container.hpp:354  mp11::mp_at_c<index_type_list,N>
#     ./txmempool.h:396: error: use of undeclared identifier 'txiter'
#
# Homebrew installs the NEWEST boost. Bitcoin Core v28 does not build against
# it -- multi_index fails to instantiate, txiter never gets declared, and half
# the header collapses after it. Nothing about that is macOS, or arm64, or
# WAM. It is the same shape as the mingw finding on Windows: a dependency
# version, discovered by building against whatever a package manager happened
# to have that day.
#
# depends is upstream's answer and it is already how the Windows build here
# works: it fetches and builds the versions Core expects -- boost 1.81.0 --
# so the result does not depend on what Homebrew shipped this week. That makes
# the two platforms consistent rather than each carrying its own accident.
#
# No SDK question arises. depends/README.md lists the macOS SDK under "For
# macOS CROSS compilation", which is building for darwin from Linux. This runs
# on macOS, so the system toolchain is the toolchain.
HOST_TRIPLET="$MACH-apple-darwin"
printf '\n%s2. depends for %s%s\n' "$BLD" "$HOST_TRIPLET" "$OFF"
log "boost 1.81, libevent, sqlite3 -- 20 to 60 minutes the first time"

# THE GRAPHICAL WALLET IS OFF BY DEFAULT HERE TOO, AND FOR THE SAME REASON
# build_windows.sh gives: depends has to cross-build Qt before anything can
# link against it, and that is an hour or more spent before a line of WAM
# code is reached. The node, the seed and the miner want none of it.
#
# WAM_WITH_GUI=1 asks for it. Nothing else about this script changes when it
# is off: the build that produced every macOS release so far must not become
# slower or more fragile because a wallet now exists.
WITH_GUI="${WAM_WITH_GUI:-0}"
QT_OPT="NO_QT=1"
if [ "$WITH_GUI" = "1" ]; then
    QT_OPT=""
    log "WAM_WITH_GUI=1 -- depends will build Qt for $HOST_TRIPLET as well"
fi

make -C "$CORE_DIR/depends" \
    "HOST=$HOST_TRIPLET" $QT_OPT NO_UPNP=1 NO_NATPMP=1 NO_USDT=1 \
    -j"$JOBS" > "$BUILD_DIR/depends-macos.log" 2>&1 \
    || die "depends failed for $HOST_TRIPLET. The last 30 lines:
$(tail -30 "$BUILD_DIR/depends-macos.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/depends-macos.log"

CONFIG_SITE_PATH="$CORE_DIR/depends/$HOST_TRIPLET/share/config.site"
[ -f "$CONFIG_SITE_PATH" ] || die "depends produced no config.site at $CONFIG_SITE_PATH"
ok "depends built, config.site present"

printf '\n%s3. the node%s\n' "$BLD" "$OFF"
log "configure --host=$HOST_TRIPLET"
GUI_FLAG="--without-gui"
[ "$WITH_GUI" = "1" ] && GUI_FLAG="--with-gui=qt5"
CONFIG_SITE="$CONFIG_SITE_PATH" ./configure \
    --prefix=/ \
    "$GUI_FLAG" \
    --disable-tests-fuzz-binary \
    CPPFLAGS="$RANDOMX_CFLAGS" \
    LIBS="$RANDOMX_LIBS" \
    > "$BUILD_DIR/configure-macos.log" 2>&1 \
    || die "configure failed. The last 30 lines:
$(tail -30 "$BUILD_DIR/configure-macos.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/configure-macos.log
          Core's own: $CORE_DIR/config.log"
ok "configured"

# The same list every platform is held to. A release is Windows, Linux and
# macOS together, so a capability proved on one of them is proved on none.
assert_release_capabilities macos "$BUILD_DIR/configure-macos.log"

log "compiling with $JOBS jobs"
make -j"$JOBS" > "$BUILD_DIR/make-macos.log" 2>&1 \
    || die "the build failed. The last 40 lines:
$(tail -40 "$BUILD_DIR/make-macos.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/make-macos.log"
ok "compiled"

# ---------------------------------------------------------------------------
printf '\n%s4. the consensus tests, before anything is kept%s\n' "$BLD" "$OFF"

# install.sh refuses to install a Linux binary that fails these. A binary for
# a new platform has more reason to run them, not less: the monetary schedule
# and the 5% treasury rule are the two things a different compiler on a
# different architecture could quietly get wrong, and a node that gets either
# wrong forks itself off the chain at block 1.
if [ -x ./src/test/test_bitcoin ]; then
    ./src/test/test_bitcoin --run_test=wam_monetary_tests,wam_devfee_tests \
        > "$BUILD_DIR/tests-macos.log" 2>&1 \
        || die "the WAM consensus tests FAIL on $MACH. Refusing to keep this
          binary. The last 20 lines:
$(tail -20 "$BUILD_DIR/tests-macos.log" | sed 's/^/          /')"
    ok "wam_monetary_tests and wam_devfee_tests pass on $MACH"
else
    warn "test_bitcoin was not built -- the consensus tests did not run"
fi

# ---------------------------------------------------------------------------
printf '\n%swhat came out%s\n' "$BLD" "$OFF"

mkdir -p "$OUT_DIR"
FOUND=0
# wam-qt is built into src/qt, and only when the GUI was asked for -- its
# absence on a node-only build is not a failure.
GUI_EXES=""
[ "$WITH_GUI" = "1" ] && GUI_EXES="qt/wam-qt qt/bitcoin-qt"

for exe in wamd wam-cli wam-tx wam-util wam-wallet $GUI_EXES; do
    p="src/$exe"
    [ -f "$p" ] || continue
    FMT="$(file -bL "$p")"
    case "$FMT" in
        *Mach-O*)
            cp "$p" "$OUT_DIR/"
            ok "$exe  $(du -h "$p" | cut -f1)  ($FMT)"
            FOUND=$((FOUND + 1)) ;;
        *)
            die "$p is $FMT, not Mach-O" ;;
    esac
done

echo
[ "$FOUND" -gt 0 ] || die "no macOS executable was produced and make reported
          success. Look in $CORE_DIR/src for what was actually built."

# ---------------------------------------------------------------------------
#  wam-miner
# ---------------------------------------------------------------------------
#
#  The same omission Windows had, found the same way: this script built five
#  node binaries and stopped, so a Mac owner would have got a wallet and no
#  way to take part in the proof of work. WAM uses RandomX precisely so that
#  an ordinary desktop processor competes, and a Mac is an ordinary desktop.
#
#  Cheaper here than it was for Windows, in two ways. Nothing needed porting:
#  miner/src/platform.h exists because Winsock disagrees with Berkeley
#  sockets, and macOS does not -- it compiles as written. And the self-test
#  RUNS, because this script is executing on the machine the binary is for,
#  so the two RandomX reference vectors are checked here rather than deferred
#  to a later job. Step 1 above has already run RandomX's own test suite
#  against this librandomx.a.
printf '\n%swam-miner%s\n' "$BLD" "$OFF"

MINER_OUT="$OUT_DIR/wam-miner"

# -mtune=generic is an x86 option. Passing it to clang on Apple Silicon is
# either an error or a warning that hides a real one, so the portable-baseline
# flag is chosen by architecture rather than copied from the Linux path. On
# arm64 there is nothing to choose: every Mac with that chip has the same
# baseline, which is why check_isa_baseline.sh reports "does not apply" here
# instead of inventing an answer.
case "$MACH" in
    x86_64) MINER_CXXFLAGS="-O3 -mtune=generic" ;;
    *)      MINER_CXXFLAGS="-O3" ;;
esac

if CXX="${CXX:-clang++}" \
   CXXFLAGS="$MINER_CXXFLAGS" \
   RANDOMX_INCLUDE="$RANDOMX_DIR/src" \
   RANDOMX_LIB="$RX_BUILD/librandomx.a" \
   OUT="$MINER_OUT" \
   bash "$HERE/miner/build.sh" > "$BUILD_DIR/make-miner-macos.log" 2>&1
then
    MFMT="$(file -bL "$MINER_OUT" 2>/dev/null || echo unknown)"
    case "$MFMT" in
        *Mach-O*)
            ok "wam-miner  $(du -h "$MINER_OUT" | cut -f1)  ($MFMT)"
            ok "its self-test passed here, on the machine it was built for"
            FOUND=$((FOUND + 1)) ;;
        *)  die "wam-miner is $MFMT, not Mach-O" ;;
    esac
else
    die "the miner did not build. The last 30 lines:
$(tail -30 "$BUILD_DIR/make-miner-macos.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/make-miner-macos.log"
fi

# ---------------------------------------------------------------------------
#  Debug symbols
# ---------------------------------------------------------------------------
#
#  Before the Windows path, nothing in this project stripped a binary except
#  package_release.sh, and platform-build #10 uploaded 197 MB of symbols
#  nobody could download on a slow connection. Stripping here rather than at
#  packaging time is deliberate for the same reason it is on Windows: the
#  consensus gate runs on what comes out of this directory, so the bytes that
#  sync the chain from genesis are the bytes that get published.
printf '\n%sdebug symbols%s\n' "$BLD" "$OFF"
if command -v strip >/dev/null 2>&1; then
    BEFORE=$(du -sk "$OUT_DIR" | cut -f1)
    # -S, not -s. A full strip of a Mach-O removes symbols the dynamic linker
    # needs and macOS then refuses to run the file; -S removes debug symbols
    # and leaves the symbol table alone, which is what Apple's own guidance
    # says and what the size is in anyway.
    strip -S "$OUT_DIR"/* 2>/dev/null || true
    AFTER=$(du -sk "$OUT_DIR" | cut -f1)
    ok "stripped  $(( BEFORE / 1024 )) MB -> $(( AFTER / 1024 )) MB"
else
    warn "strip not found -- shipping $(du -sh "$OUT_DIR" | cut -f1) of symbols"
fi

echo "=================================================================="
printf ' %s%d macOS (%s) executable(s) in %s%s\n' "$GRN" "$FOUND" "$MACH" "$OUT_DIR" "$OFF"
echo "=================================================================="
echo
echo "  ${BLD}Compiling is not the gate.${OFF} The gate is agreeing with the chain:"
echo "  scripts/test/test_platform_consensus.sh syncs this binary and compares"
echo "  its block hashes with the ones the Linux nodes already have."
echo
