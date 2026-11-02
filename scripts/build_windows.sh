#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  build_windows.sh -- cross-compile the node for Windows, from Linux
# ===========================================================================
#
#      bash scripts/fetch-upstream.sh          # fetch and patch Core first
#      bash scripts/build_windows.sh
#
#  WHY THIS EXISTS, AND WHAT IT IS NOT
#
#  Every release so far is x86_64-linux-gnu and nothing else. docs/ROADMAP.md
#  §7 records why that was a mistake rather than an ordering: RandomX was
#  chosen so an ordinary desktop competes, most ordinary desktops run Windows,
#  and in a proof-of-work chain the miners ARE the security. Treating Windows
#  as a convenience to be added once "users arrive" is incoherent -- there is
#  no chain before they arrive.
#
#  This script is the measurement that turns "six days, maybe" into a fact.
#  It is NOT part of release.yml and must not become part of it until it has
#  produced a binary that syncs the test chain on a real Windows machine and
#  reaches the same tip as Linux. Compiling is not the gate. Agreeing with
#  Linux, block for block, is the gate.
#
#  WHAT MADE THIS SMALL
#
#  The thing to fear was RandomX: a custom proof-of-work linked into
#  libbitcoinkernel usually means an autotools macro, a pkg-config file and a
#  week of build-system work. It is two variables passed to configure --
#  install.sh has done it that way since the beginning:
#
#      CPPFLAGS="-I<randomx>/src"  LIBS="<randomx>/build/librandomx.a -lpthread"
#
#  So the same two variables, pointed at a mingw-built librandomx.a, is the
#  whole of the WAM-specific part. Everything else is upstream's own depends
#  system, documented in build/wam-core/doc/build-windows.md.
#
#  ARCH=x86-64, NEVER native
#
#  Same reason as scripts/fetch-upstream.sh, and it is not theoretical here
#  either. On 2026-08-20 a release went out carrying 746 AVX-512 instructions
#  because the runner's CPU had them, and it died with SIGILL on an AMD EPYC
#  that did not. RandomX detects AES-NI and the rest at RUNTIME; ARCH only
#  decides what the compiler may assume unconditionally, and for a binary
#  strangers run that has to be the baseline. A Windows binary makes this
#  worse, not better: the audience is desktops of every age.
# ===========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

log()  { printf '  %s\n' "$*"; }
ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '  %s!!%s    %s\n' "$YLW" "$OFF" "$*"; }
die()  { printf '\n  %sFAIL%s  %s\n\n' "$RED" "$OFF" "$*" >&2; exit 1; }

HOST_TRIPLET=x86_64-w64-mingw32
BUILD_DIR="${BUILD_DIR:-$HERE/build}"
CORE_DIR="$BUILD_DIR/wam-core"
RANDOMX_DIR="$BUILD_DIR/randomx"

# What every release's node must be able to do, for all three platforms, in
# one file. See its header for why it is not three lines in three scripts.
. "$HERE/scripts/lib/release_capabilities.sh"

# A separate build directory, deliberately.
#
# fetch-upstream.sh builds a NATIVE librandomx.a into build/randomx/build, and
# install.sh links the Linux node against it. Cross-compiling into the same
# directory would overwrite a Linux archive with a Windows one and the next
# native build would link it, fail at the last step, and blame the linker.
WIN_RX_BUILD="$RANDOMX_DIR/build-win"

JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
OUT_DIR="${OUT_DIR:-$HERE/out/windows}"

echo
echo "=================================================================="
echo " ${BLD}cross-compiling the WAM node for Windows${OFF}  ($HOST_TRIPLET)"
echo "=================================================================="
echo

# ---------------------------------------------------------------------------
#  The toolchain, and the one flag that is not optional
# ---------------------------------------------------------------------------
#
#  Ubuntu ships two mingw runtimes. The win32-threads one has no std::thread
#  at all, and Bitcoin Core uses it everywhere, so the wrong alternative
#  produces several hundred lines of "'thread' is not a member of 'std'" --
#  which reads like a broken source tree and is a one-line toolchain setting.
#  Upstream's doc/build-windows.md says to install the -posix package for
#  exactly this reason.
command -v "$HOST_TRIPLET-g++" >/dev/null \
    || die "$HOST_TRIPLET-g++ is not installed. On Ubuntu:
          sudo apt install g++-mingw-w64-x86-64-posix"

THREAD_MODEL="$("$HOST_TRIPLET-g++" -v 2>&1 | sed -n 's/^Thread model: //p')"
if [ "$THREAD_MODEL" != "posix" ]; then
    die "$HOST_TRIPLET-g++ is using the '$THREAD_MODEL' thread model.
          Core needs std::thread, which win32 threads do not provide. Select
          the posix alternative:
              sudo update-alternatives --set $HOST_TRIPLET-g++ /usr/bin/$HOST_TRIPLET-g++-posix
              sudo update-alternatives --set $HOST_TRIPLET-gcc /usr/bin/$HOST_TRIPLET-gcc-posix"
fi
ok "$HOST_TRIPLET-g++ present, thread model posix"

# C++20, checked HERE rather than by configure forty minutes from now.
#
# Bitcoin Core v28 requires C++20. Ubuntu 22.04 ships mingw with GCC 10.3,
# which does not have enough of it, and configure says so:
#
#   checking whether ... supports C++20 features with -std=c++20... no
#   configure: error: *** A compiler with support for C++20 language features
#                     is required.
#
# It says it AFTER depends has built boost, bdb, libevent and sqlite for
# Windows -- about forty minutes of work that was never going to be used. The
# first run of this on a 22.04 runner spent 211 seconds to learn one fact
# about a compiler, and the fact was available in the first second.
#
# The build machine's distribution is not the release's problem here, which is
# worth stating because it looks like it should be: the Linux release is built
# on 22.04 deliberately, so its glibc runs on 22.04 and 24.04 alike. A
# cross-compiled Windows binary links against Windows DLLs and carries no
# glibc at all, so the host distribution leaves no trace in it.
# The test is the one Core's own configure runs, not one of my choosing.
#
# The first version of this guard compiled a program using std::integral and
# <concepts>, and GCC 10.3 accepted it -- so the guard passed and configure
# failed anyway, four minutes later. Writing a plausible C++20 program is not
# the same question as the one being asked.
#
# configure.ac line 123 is AX_CXX_COMPILE_STDCXX([20], [noext], [mandatory]),
# and that macro's test body begins by rejecting anything whose __cplusplus is
# below 202002L. GCC 10 with -std=c++20 reports 201709L, the pre-final value,
# which is exactly why it is refused. So that is the test here, verbatim.
#
# And the version is compared against upstream's documented floor rather than
# a number I decided: build/wam-core/doc/dependencies.md says GCC 11.1.
CXX_VER="$("$HOST_TRIPLET-g++" -dumpversion 2>/dev/null || echo 0)"
TESTDIR="$(mktemp -d)"
cat > "$TESTDIR/c20.cpp" <<'CPP'
#if __cplusplus < 202002L
#error "__cplusplus is below 202002L -- this is what Core's configure refuses"
#endif
#include <version>
#include <concepts>
int main() { return 0; }
CPP
if ! "$HOST_TRIPLET-g++" -std=c++20 -c "$TESTDIR/c20.cpp" -o "$TESTDIR/c20.o" 2>"$TESTDIR/err"; then
    rm -f "$TESTDIR/c20.o"
    die "$HOST_TRIPLET-g++ is GCC $CXX_VER, and it does not have C++20.
          build/wam-core/doc/dependencies.md gives the floor as GCC 11.1.

          Bitcoin Core v28 requires C++20, so configure refuses -- but only
          after depends has spent about forty minutes building boost, bdb,
          libevent and sqlite for a compiler that cannot use them.

          Ubuntu 22.04 ships mingw GCC 10.3. Build the Windows target on
          24.04, which ships GCC 13:

              runs-on: ubuntu-24.04        (in the workflow)
              or a 24.04 machine locally

          This does NOT affect the Linux release, which is built on 22.04 on
          purpose so its glibc runs everywhere. A Windows binary carries no
          glibc, so the host distribution leaves no trace in it.

          The compiler said:
$(sed 's/^/            /' "$TESTDIR/err" | head -6)"
fi
rm -rf "$TESTDIR"
ok "$HOST_TRIPLET-g++ is GCC $CXX_VER and compiles C++20"

[ -d "$CORE_DIR" ] || die "$CORE_DIR is not here. Run scripts/fetch-upstream.sh first."
[ -f "$CORE_DIR/configure.ac" ] || die "$CORE_DIR has no configure.ac -- an incomplete fetch"
[ -d "$RANDOMX_DIR" ] || die "$RANDOMX_DIR is not here. Run scripts/fetch-upstream.sh first."
ok "patched Core tree and RandomX source are present"

command -v cmake >/dev/null || die "cmake is not installed (needed for RandomX)"

# ---------------------------------------------------------------------------
#  1. librandomx.a for Windows
# ---------------------------------------------------------------------------
printf '\n%s1. librandomx.a for Windows%s\n' "$BLD" "$OFF"

if [ -f "$WIN_RX_BUILD/librandomx.a" ]; then
    ok "already built at $WIN_RX_BUILD/librandomx.a"
else
    log "cmake, ARCH=x86-64 (never native -- see the header)"
    cmake -S "$RANDOMX_DIR" -B "$WIN_RX_BUILD" \
        -DCMAKE_SYSTEM_NAME=Windows \
        -DCMAKE_C_COMPILER="$HOST_TRIPLET-gcc" \
        -DCMAKE_CXX_COMPILER="$HOST_TRIPLET-g++" \
        -DCMAKE_RC_COMPILER="$HOST_TRIPLET-windres" \
        -DCMAKE_FIND_ROOT_PATH="/usr/$HOST_TRIPLET" \
        -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
        -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
        -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
        -DCMAKE_BUILD_TYPE=Release \
        -DARCH=x86-64 \
        >/dev/null || die "cmake could not configure RandomX for $HOST_TRIPLET"
    cmake --build "$WIN_RX_BUILD" -j"$JOBS" >/dev/null \
        || die "librandomx.a did not build for $HOST_TRIPLET -- rerun without >/dev/null to see why"
fi
[ -f "$WIN_RX_BUILD/librandomx.a" ] || die "librandomx.a was not produced"

# An archive is not proof it is a WINDOWS archive. A silently-native build
# here would fail hundreds of lines later, at the node's link step, with
# undefined references that read like missing source files.
RX_FMT="$(file -b "$WIN_RX_BUILD/librandomx.a" 2>/dev/null || echo unknown)"
case "$RX_FMT" in
    *"current ar archive"*|*archive*) ;;
    *) warn "unexpected archive type: $RX_FMT" ;;
esac
FIRST_OBJ="$(ar t "$WIN_RX_BUILD/librandomx.a" 2>/dev/null | head -1)"
if [ -n "$FIRST_OBJ" ]; then
    ( cd "$WIN_RX_BUILD" && ar x librandomx.a "$FIRST_OBJ" 2>/dev/null )
    OBJ_FMT="$(file -b "$WIN_RX_BUILD/$FIRST_OBJ" 2>/dev/null || echo unknown)"
    rm -f "$WIN_RX_BUILD/$FIRST_OBJ"
    case "$OBJ_FMT" in
        *"for MS Windows"*|*PE32*|*COFF*)
            ok "librandomx.a holds Windows objects ($OBJ_FMT)" ;;
        *)
            die "librandomx.a holds $OBJ_FMT -- this is a NATIVE build, not a
          Windows one. The node would link it and fail with undefined
          references far from here." ;;
    esac
fi

# ---------------------------------------------------------------------------
#  2. Core's dependencies for Windows
# ---------------------------------------------------------------------------
printf '\n%s2. depends for %s%s\n' "$BLD" "$HOST_TRIPLET" "$OFF"
log "boost, libevent, sqlite3 -- 20 to 60 minutes the first time"

# The same features the Linux node leaves out, for the same reasons
# install.sh gives: nothing here uses ZMQ, and there is no GUI. Every package
# not built is an hour not spent and a dependency a downloader does not need.
# THE GRAPHICAL WALLET IS OFF BY DEFAULT, AND THAT IS A TIME DECISION.
#
# Qt has to be cross-compiled by depends before anything can link against it,
# and that is an hour or more on its own -- most of it spent before the first
# line of WAM code is touched. The node, the seed and the miner need none of
# it.
#
# So WAM_WITH_GUI=1 asks for it explicitly, and a release that carries a
# Windows wallet is a release where somebody chose to wait. Everything else
# about this script is unchanged when it is off, which is the point: the node
# build that has worked since v0.1.8 must not become slower or more fragile
# because a wallet now exists.
WITH_GUI="${WAM_WITH_GUI:-0}"

DEPENDS_OPTS=(
    "HOST=$HOST_TRIPLET"
    "NO_UPNP=1"
    "NO_NATPMP=1"
    "NO_USDT=1"
)
if [ "$WITH_GUI" = "1" ]; then
    log "WAM_WITH_GUI=1 -- depends will build Qt for $HOST_TRIPLET as well"
else
    DEPENDS_OPTS+=("NO_QT=1")
fi
make -C "$CORE_DIR/depends" "${DEPENDS_OPTS[@]}" -j"$JOBS" \
    || die "depends failed for $HOST_TRIPLET"

CONFIG_SITE_PATH="$CORE_DIR/depends/$HOST_TRIPLET/share/config.site"
[ -f "$CONFIG_SITE_PATH" ] || die "depends produced no config.site at $CONFIG_SITE_PATH"
ok "depends built, config.site present"

# ---------------------------------------------------------------------------
#  3. configure and build the node
# ---------------------------------------------------------------------------
printf '\n%s3. the node%s\n' "$BLD" "$OFF"

cd "$CORE_DIR"
[ -f ./configure ] || ./autogen.sh >/dev/null || die "autogen.sh failed"

# The whole of the WAM-specific part of this cross-build: the same two
# variables install.sh passes natively, pointed at the Windows archive.
RANDOMX_CFLAGS="-I$RANDOMX_DIR/src"
RANDOMX_LIBS="$WIN_RX_BUILD/librandomx.a"

log "configure --host=$HOST_TRIPLET"
GUI_FLAG="--without-gui"
[ "$WITH_GUI" = "1" ] && GUI_FLAG="--with-gui=qt5"
CONFIG_SITE="$CONFIG_SITE_PATH" ./configure \
    --prefix=/ \
    "$GUI_FLAG" \
    --disable-tests-fuzz-binary \
    CPPFLAGS="$RANDOMX_CFLAGS" \
    LIBS="$RANDOMX_LIBS" \
    > "$BUILD_DIR/configure-windows.log" 2>&1 \
    || die "configure failed. The last 30 lines:
$(tail -30 "$BUILD_DIR/configure-windows.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/configure-windows.log
          Core's own: $CORE_DIR/config.log"
ok "configured"

# The same list every platform is held to. A release is Windows, Linux and
# macOS together, so a capability proved on one of them is proved on none.
assert_release_capabilities windows "$BUILD_DIR/configure-windows.log"

log "compiling with $JOBS jobs"
make -j"$JOBS" > "$BUILD_DIR/make-windows.log" 2>&1 \
    || die "the build failed. The last 40 lines:
$(tail -40 "$BUILD_DIR/make-windows.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/make-windows.log"
ok "compiled"

# ---------------------------------------------------------------------------
#  4. What came out, and whether it is actually for Windows
# ---------------------------------------------------------------------------
printf '\n%swhat came out%s\n' "$BLD" "$OFF"

mkdir -p "$OUT_DIR"
FOUND=0
# wam-qt is built into src/qt, not src, so both are looked in -- and it is
# only expected at all when the GUI was asked for, or its absence would be
# read as a failed build on every node-only run.
GUI_EXES=""
[ "$WITH_GUI" = "1" ] && GUI_EXES="wam-qt bitcoin-qt"

for exe in wamd wam-cli wam-tx wam-util wam-wallet \
           bitcoind bitcoin-cli bitcoin-tx bitcoin-util bitcoin-wallet \
           $GUI_EXES; do
    for p in "src/$exe.exe" "src/$exe" "src/qt/$exe.exe" "src/qt/$exe"; do
        [ -f "$p" ] || continue
        FMT="$(file -b "$p")"
        case "$FMT" in
            *"for MS Windows"*|*PE32*)
                cp "$p" "$OUT_DIR/"
                SZ="$(du -h "$p" | cut -f1)"
                ok "$(basename "$p")  $SZ"
                FOUND=$((FOUND + 1))
                ;;
            *)
                die "$p is $FMT -- not a Windows executable. The build used the
          host compiler somewhere and this binary would not run on Windows." ;;
        esac
        break
    done
done

echo
if [ "$FOUND" -eq 0 ]; then
    die "no Windows executable was produced, and make reported success. Look
          in $CORE_DIR/src for what was actually built."
fi

# ---------------------------------------------------------------------------
#  5. wam-miner.exe
# ---------------------------------------------------------------------------
#
#  This script built the node for six days before anybody noticed it did not
#  build the miner, and a Windows release without one is the wrong half. WAM
#  uses RandomX so that an ordinary desktop can compete for blocks; most
#  ordinary desktops run Windows; so shipping them a wallet and a node while
#  the miner stays Linux-only excludes the exact audience the algorithm was
#  chosen for.
#
#  It costs twenty seconds. The miner is one translation unit against the
#  librandomx.a that step 1 has already cross-compiled, and the only part of
#  it that was not portable was the socket layer -- now in miner/src/platform.h.
printf '\n%s5. wam-miner.exe%s\n' "$BLD" "$OFF"

MINER_EXE="$OUT_DIR/wam-miner.exe"
#   -static, and one file.
#     A miner is the binary people copy to other machines and run by
#     double-clicking. Linked against the mingw DLLs it would need
#     libstdc++-6.dll, libgcc_s_seh-1.dll and libwinpthread-1.dll beside it,
#     and the failure when they are missing is a dialog box naming a DLL, on a
#     machine whose owner did not ask to learn what a DLL is.
#   -lws2_32
#     Winsock. Without it the link fails on every socket call in stratum.h.
#   -mtune=generic, never -march=native
#     Same rule as everywhere else in this project: a published binary must
#     run on a 2012 laptop. check_isa_baseline.sh enforces it afterwards.
if CXX="$HOST_TRIPLET-g++" \
   CXXFLAGS="-O3 -mtune=generic" \
   LDFLAGS="-static -static-libgcc -static-libstdc++" \
   LDLIBS="-lws2_32 -lpthread" \
   RANDOMX_INCLUDE="$RANDOMX_DIR/src" \
   RANDOMX_LIB="$WIN_RX_BUILD/librandomx.a" \
   OUT="$MINER_EXE" \
   RUN_SELF_TEST=0 \
   bash "$HERE/miner/build.sh" > "$BUILD_DIR/make-miner-windows.log" 2>&1
then
    MFMT="$(file -b "$MINER_EXE" 2>/dev/null || echo unknown)"
    case "$MFMT" in
        *"for MS Windows"*|*PE32*)
            ok "wam-miner.exe  $(du -h "$MINER_EXE" | cut -f1)  ($MFMT)"
            FOUND=$((FOUND + 1)) ;;
        *)
            die "wam-miner.exe is $MFMT -- not a Windows executable" ;;
    esac
    # Named here rather than left to the reader: the binary that was just
    # built has not verified its own RandomX, because it cannot run on this
    # machine. The platform-build workflow runs --self-test on a Windows
    # runner, and that is the step that has to be green.
    warn "its self-test has NOT run -- it cannot execute here. A Windows"
    warn "machine must run 'wam-miner.exe --self-test' before this is shipped."
else
    die "the miner did not cross-compile. The last 30 lines:
$(tail -30 "$BUILD_DIR/make-miner-windows.log" | sed 's/^/          /')
          Full log: $BUILD_DIR/make-miner-windows.log"
fi

# ---------------------------------------------------------------------------
#  6. Debug symbols
# ---------------------------------------------------------------------------
#
#  197 MB, measured, for five executables -- which is what platform-build #10
#  uploaded and what made the artifact undownloadable on a slow connection.
#  package_release.sh has stripped the Linux binaries since the first release
#  ("Debug symbols are most of the size and none of the use. 339 MB -> ~30
#  MB"); nothing had ever stripped these.
#
#  Stripping HERE and not at packaging time is deliberate. The consensus gate
#  runs on whatever comes out of this directory, so stripping first means the
#  bytes that synced the chain from genesis are the same bytes that get
#  published. Strip afterwards and the tested file and the shipped file differ,
#  and RELEASE.txt's claim that "these binaries were run against the live test
#  chain" stops being literally true.
printf '\n%s6. debug symbols%s\n' "$BLD" "$OFF"

if command -v "$HOST_TRIPLET-strip" >/dev/null 2>&1; then
    BEFORE=$(du -sk "$OUT_DIR" | cut -f1)
    "$HOST_TRIPLET-strip" "$OUT_DIR"/*.exe 2>/dev/null || true
    AFTER=$(du -sk "$OUT_DIR" | cut -f1)
    ok "stripped  $(( BEFORE / 1024 )) MB -> $(( AFTER / 1024 )) MB"
else
    warn "$HOST_TRIPLET-strip not found -- shipping $(du -sh "$OUT_DIR" | cut -f1)"
    warn "of debug symbols. Install binutils-mingw-w64-x86-64."
fi

echo "=================================================================="
printf ' %s%d Windows executable(s) in %s%s\n' "$GRN" "$FOUND" "$OUT_DIR" "$OFF"
echo "=================================================================="
echo
echo "  ${BLD}This is not the gate.${OFF} Compiling proves the toolchain, not the"
echo "  binary. Before any of this is published it has to sync the test chain"
echo "  from genesis on a real Windows machine and reach the same tip hash"
echo "  Linux reaches:"
echo
echo "      wamd.exe -testnet -datadir=C:\\wam-test"
echo "      wam-cli.exe -testnet -datadir=C:\\wam-test getbestblockhash"
echo
echo "  and that must equal, at the same height:"
echo
echo "      wam-cli -testnet getbestblockhash        # on Linux"
echo
echo "  A Windows node that disagrees with Linux about one block is worse than"
echo "  no Windows node: its owner mines onto a history nobody else has."
echo
