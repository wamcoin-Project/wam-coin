#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  package_release.sh -- build portable binaries and checksum them
# ===========================================================================
#
#      bash scripts/package_release.sh [--version v0.1.0]
#
#  Produces, under out/release/:
#
#      wam-coin-<version>-x86_64-linux-gnu.tar.gz   node, cli, tools, wallet
#      wam-miner-<version>-x86_64-linux-gnu.tar.gz  the reference miner
#      SHA256SUMS                                   for both
#
#  PORTABILITY IS THE WHOLE POINT
#  ------------------------------
#  The development build uses `-march=native`, which compiles for exactly the
#  CPU doing the building. That is right for a machine that mines for itself
#  and catastrophic for a release: a binary built on a 2024 laptop with AVX-512
#  dies with SIGILL on anything older, and the miner who downloaded it has no
#  idea why. RandomX is built the same way by default (ARCH=native).
#
#  So the release build compiles RandomX and the miner again, from scratch,
#  against the plain x86-64 baseline. Nothing is lost by this: RandomX detects
#  AES, AVX2 and the rest at *runtime* through randomx_get_flags(), so a
#  generic binary still uses every instruction the host actually has.
#
#  WHAT THIS IS NOT
#  ----------------
#  These are not reproducible builds. Two people running this script will get
#  binaries that differ, and the checksums below prove only that a download
#  arrived intact -- not that it corresponds to this source. Reproducibility
#  needs a pinned toolchain (Guix, as Bitcoin Core does), and until that exists
#  the release notes say so rather than implying a guarantee nobody can check.
# ===========================================================================

set -euo pipefail

# A SCRIPT THAT DIES UNDER set -e MUST SAY WHERE, OR IT SAYS NOTHING AT ALL.
#
# On 2026-10-29 this printed its way happily down to
#
#     ok    wallet        carries 17 library/libraries of its own
#
# and then exited 1 with not one further word, in a release job that had
# already spent twenty-one minutes. `set -e` kills the shell on any
# unchecked non-zero status and prints nothing by design, so the log ends
# mid-sentence and the next move is to guess -- which is how the previous
# hour went.
#
# Every die() in this file explains itself. This is for the failures that
# are not a die(): a cp that found no directory, a test that came out false
# at the end of a && chain, a tool that is not installed. It names the line
# and the command, which is all anybody needs.
trap 'rc=$?; printf "\n  \033[31mFAIL\033[0m  package_release.sh stopped at line %s\n        command: %s\n        exit:    %d\n\n" \
      "$LINENO" "$BASH_COMMAND" "$rc" >&2' ERR

# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh"
. "$SCRIPTS_DIR/lib/shared_deps.sh"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Look in this repository first, then in ~/wam.
#
# HERE and REPO are computed on the two lines above and were then ignored in
# favour of $HOME/wam -- correct on exactly one machine, the laptop this was
# written on. Cloned to /opt/wam on the release server it failed with
#
#     error: missing /root/wam/build/wam-core/src/wamd
#
# naming a path the operator never chose. fetch-upstream.sh builds into
# <repo>/build, so the repository already knows where its own tree is. The
# $HOME fallback stays for anyone with a tree built the old way.
#
# Same defect, same fix, as miner/build.sh. A path written from memory of
# where something lives, in a file that could have asked.
for base in "$REPO/build" "$HOME/wam/build"; do
    if [ -d "$base/wam-core" ]; then
        BUILD_BASE="$base"
        break
    fi
done
BUILD_BASE="${BUILD_BASE:-$REPO/build}"

VERSION="${VERSION:-}"
TREE="${TREE:-$BUILD_BASE/wam-core}"
WORK="${WORK:-$BUILD_BASE/release}"
OUT="${OUT:-$REPO/out/release}"
JOBS="${JOBS:-$(nproc)}"
PLATFORM="x86_64-linux-gnu"

# The baseline every x86-64 CPU made since 2003 supports. RandomX picks up
# AES-NI and AVX2 at runtime regardless.
PORTABLE_FLAGS="-O3 -mtune=generic"

while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

[ -n "$VERSION" ] || VERSION="v0.1.0-$(date -u +%Y%m%d)"

fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

echo "=================================================================="
echo " Packaging WAM Coin $VERSION for $PLATFORM"
echo "=================================================================="

# ---------------------------------------------------------------------------
step "1. the node binaries"

NODE_BINS=(wamd wam-cli wam-tx wam-util wam-wallet)
for b in "${NODE_BINS[@]}"; do
    [ -x "$TREE/src/$b" ] || fail "missing $TREE/src/$b -- run ./install.sh --build-only first"
done
# The GUI is optional, and its absence is not an error.
#
# install.sh builds --without-gui on purpose. Adding Qt would pull X11,
# fontconfig, freetype, harfbuzz, dbus and thirty more shared libraries into a
# package that was just cut from seventeen dependencies to two -- and a person
# reviewing a testnet on a headless VPS has no use for a window.
#
# Refusing to package because a component nobody asked for is missing is the
# script deciding for the operator. It now packages what exists and says what
# did not.
HAVE_GUI=0
if [ -x "$TREE/src/qt/wam-qt" ]; then
    HAVE_GUI=1
    ok "found ${#NODE_BINS[@]} programs, the wallet, and the GUI"
else
    ok "found ${#NODE_BINS[@]} programs and the wallet"
    printf '  \033[33mnote\033[0m  no GUI in this build (--without-gui). The node, CLI and\n'
    printf '        miner are packaged; scripts/build_qt.sh builds the GUI if wanted.\n'
fi

# Bitcoin Core's configure does not add -march, so these are already portable.
# Assert it rather than assume it: a stray CXXFLAGS in someone's environment
# would produce a release that crashes on half the machines that download it.
if grep -qE '^CXXFLAGS.*-march=' "$TREE/config.log" 2>/dev/null; then
    fail "the node was configured with -march=. Reconfigure without it before releasing."
fi
ok "node build carries no -march= flag"

# ---------------------------------------------------------------------------
step "2. RandomX, rebuilt for the baseline"

RX_SRC="${RX_SRC:-$BUILD_BASE/randomx}"
[ -d "$RX_SRC" ] || fail "RandomX sources not found at $RX_SRC"

RX_BUILD="$WORK/randomx"
if [ ! -f "$RX_BUILD/librandomx.a" ]; then
    mkdir -p "$RX_BUILD"
    (
        cd "$RX_BUILD"
        cmake "$RX_SRC" -DARCH=x86-64 -DCMAKE_BUILD_TYPE=Release > /tmp/wam_rx_cmake.log 2>&1 \
            || { tail -20 /tmp/wam_rx_cmake.log; exit 1; }
        make -j"$JOBS" randomx > /tmp/wam_rx_make.log 2>&1 \
            || { tail -20 /tmp/wam_rx_make.log; exit 1; }
    ) || fail "could not build a portable RandomX -- see /tmp/wam_rx_make.log"
fi
[ -f "$RX_BUILD/librandomx.a" ] || fail "the portable RandomX build produced no library"
ok "librandomx.a  ARCH=x86-64, not native"

# ---------------------------------------------------------------------------
step "3. the miner, rebuilt for the baseline"

MINER_OUT="$WORK/wam-miner"
RANDOMX_INCLUDE="$RX_SRC/src" \
RANDOMX_LIB="$RX_BUILD/librandomx.a" \
CXXFLAGS="$PORTABLE_FLAGS" \
OUT="$MINER_OUT" \
    bash "$REPO/miner/build.sh" > /tmp/wam_miner_release.log 2>&1 \
    || { tail -25 /tmp/wam_miner_release.log; fail "the portable miner build failed"; }
ok "wam-miner     built with $PORTABLE_FLAGS"

"$MINER_OUT" --self-test --no-colour > /tmp/wam_miner_selftest.log 2>&1 \
    || { tail -20 /tmp/wam_miner_selftest.log; fail "the release miner fails its own self-test"; }
ok "self-test     passed on the release binary"

# ---------------------------------------------------------------------------
step "4. assembling"

rm -rf "$WORK/stage" && mkdir -p "$WORK/stage"
mkdir -p "$OUT"

NODE_DIR="$WORK/stage/wam-coin-$VERSION/bin"
MINER_DIR="$WORK/stage/wam-miner-$VERSION"

# THE GRAPHICAL WALLET SHIPS ON ITS OWN, AND THE REASON IS THE SIZE.
#
# wam-qt is about 20 MB stripped, against roughly 5 MB for the whole node
# package. Putting it in bin/ beside wamd -- which is what this script used to
# do -- makes every person who wants a node, a seed or a miner download four
# times as much for a window they will never open. The founder asked for it in
# a file of its own before v0.1.10 and it is the first thing he checked when
# the wallet was finally built.
WALLET_DIR="$WORK/stage/wam-qt-$VERSION"
mkdir -p "$NODE_DIR" "$MINER_DIR"

for b in "${NODE_BINS[@]}"; do
    cp "$TREE/src/$b" "$NODE_DIR/"
done
if [ "$HAVE_GUI" = "1" ]; then
    mkdir -p "$WALLET_DIR/bin"
    cp "$TREE/src/qt/wam-qt" "$WALLET_DIR/bin/"
fi
cp "$MINER_OUT" "$MINER_DIR/"

# Debug symbols are most of the size and none of the use. 339 MB -> ~30 MB.
strip "$NODE_DIR"/* "$MINER_DIR"/wam-miner 2>/dev/null || true
[ "$HAVE_GUI" = "1" ] && strip "$WALLET_DIR/bin/wam-qt" 2>/dev/null || true
ok "stripped      symbols removed"

# THE WALLET CARRIES ITS LIBRARIES, THE SAME WAY THE NODE DOES.
#
# The node swallows boost, libevent and sqlite whole, because depends builds
# those as static archives. It cannot do that with the X11 stack: upstream's
# depends/packages/libxcb.mk sets --disable-static, so libxcb, libxkbcommon,
# fontconfig, freetype and the rest are shared objects by that project's own
# decision, and wam-qt links them from depends and then sails without them.
#
# On 2026-10-29 the release build said so, at the last gate, after
# twenty-eight minutes:
#
#     FAIL  wam-qt  asks for: libfontconfig.so.1 libfreetype.so.6
#                   libxcb-icccm.so.4 ... libxkbcommon.so.0     (17 of them)
#
# Allowing those seventeen by name in check_shared_deps.sh was the short
# answer and probably even defensible -- a machine with no libxcb cannot draw
# a window for any program. It is still an exception, and an exception is a
# hole that grows without anybody deciding, which is how --disable-zmq lived
# in three build scripts for a year.
#
# So they travel in the archive, beside the binary, and wam-qt is given an
# RPATH of $ORIGIN/../lib so it finds them wherever the user unpacks it. The
# rule keeps no list of names: ask a stranger for nothing but glibc.
if [ "$HAVE_GUI" = "1" ]; then
    DEPENDS_LIB="$TREE/depends/${HOST_TRIPLET:-x86_64-pc-linux-gnu}/lib"
    if carry_libs "$WALLET_DIR/bin/wam-qt" "$DEPENDS_LIB" "$WALLET_DIR/lib"; then
        CARRIED_N="$(find "$WALLET_DIR/lib" -name '*.so*' -type f 2>/dev/null | wc -l)"
        ok "wallet        carries $CARRIED_N library/libraries of its own"
    else
        die "wam-qt needs libraries that are not in $DEPENDS_LIB, so the
          wallet would ask a stranger's machine for them. Nothing is kept.
          This is the failure v0.1.12 shipped with; see scripts/lib/shared_deps.sh."
    fi
fi

for f in COPYING README.md WHITEPAPER.md SECURITY.md; do
    [ -f "$REPO/$f" ] && cp "$REPO/$f" "$WORK/stage/wam-coin-$VERSION/"
done
cp "$REPO/COPYING" "$REPO/miner/README.md" "$MINER_DIR/" 2>/dev/null || true

# Named in the node's own notes as a SEPARATE download, so a reader who
# wants a window knows where to get one and a reader who does not is not
# made to carry it.
GUI_LINE=""
if [ "$HAVE_GUI" = "1" ]; then
    GUI_LINE="

The graphical wallet is a separate download, so that a node is not four times
larger for people who never open a window:
  wam-qt-$VERSION-$PLATFORM.tar.gz"
    cp "$REPO/COPYING" "$WALLET_DIR/" 2>/dev/null || true

    # WHAT IT NEEDS, READ OUT OF THE BINARY RATHER THAN REMEMBERED.
    #
    # This comment used to say: "The node and the miner are self-contained:
    # the portability gate below holds them to a bare glibc and that is the
    # whole of their requirement." That was not true and the gate below never
    # tested it -- it reads symbol versions, which cannot see a DT_NEEDED. The
    # node loaded libevent and sqlite from the system the whole time, and on
    # 2026-10-18 it failed to start for Jeeves for exactly that reason. The
    # sentence was the most confident thing in the file and the only false one.
    #
    # check_shared_deps.sh asks the question the sentence assumed, and
    # build_linux.sh makes the answer true by running depends. The wallet is
    # still the one that can need Qt -- a user whose machine has none gets a
    # loader error naming a file, which is the least helpful failure a program
    # can have, and it is the failure the whole release just made.
    #
    # The list is taken from the binary with ldd, so it cannot drift away from
    # what was actually built. If Qt is ever linked statically this produces
    # nothing and the sentence disappears with it.
    #
    # AND THAT DAY CAME, AND THIS LINE KILLED THE RELEASE ON IT.
    #
    # grep exits 1 when it matches nothing, pipefail carries that out of the
    # pipeline, and set -e kills the shell. So on 2026-10-29, the first build
    # in which Qt actually came out of depends and wam-qt named no libQt5 at
    # all, packaging died here -- at the moment the sentence above came true.
    # The intent was right and the exit status was never handled: the block
    # below already treats an empty list as "nothing to warn about", which is
    # the correct behaviour it could not reach.
    QT_SONAMES="$(ldd "$WALLET_DIR/bin/wam-qt" 2>/dev/null \
                  | grep -oE 'libQt5[A-Za-z]+\.so\.[0-9]+' | sort -u | tr '\n' ' ' || true)"
    if [ -n "$QT_SONAMES" ]; then
        NEEDS="
WHAT THIS NEEDS ON YOUR MACHINE
-------------------------------
The node and the miner need nothing but a working glibc. The wallet is
different: it uses the Qt libraries your distribution ships, and will not
start without them.

  Debian, Ubuntu:  sudo apt install libqt5gui5 libqt5widgets5 libqt5network5 libqrencode4
  Fedora:          sudo dnf install qt5-qtbase-gui qrencode-libs
  Arch:            sudo pacman -S qt5-base qrencode

Read out of this build, it loads: $QT_SONAMES
If it starts and says a library is missing, that is the line to install.
"
    else
        NEEDS=""
    fi

    cat > "$WALLET_DIR/README.txt" <<WALLETEOF
WAM Coin graphical wallet $VERSION -- $PLATFORM

  bin/wam-qt       the wallet, with a window
$NEEDS

It is the same node underneath: the wallet starts one, keeps the chain in the
same data directory, and can be used instead of wamd, not beside it. Do not
run both against one data directory at the same time.

  ./bin/wam-qt

Nothing else is needed. If you already run wamd, stop it first.

Verify what you downloaded before running it:
  sha256sum --ignore-missing -c SHA256SUMS
  gpg --verify SHA256SUMS.asc SHA256SUMS
The fingerprint to check it against is at https://wamcoin.org/security/
WALLETEOF
fi

cat > "$WORK/stage/wam-coin-$VERSION/RELEASE.txt" <<EOF
WAM Coin $VERSION -- $PLATFORM
=====================================================================

RUN A NODE IN FOUR COMMANDS
---------------------------

  1.  Check what you downloaded is what we built:

          sha256sum --ignore-missing -c SHA256SUMS

      --ignore-missing matters: SHA256SUMS lists both packages, and
      without it a person who took only the node is told the miner
      FAILED and, following this instruction, deletes a good file.

      Every line must say OK. If one does not, delete that file and
      download it again -- do not run it.

  2.  Make sure the two libraries are present. On Ubuntu or Debian:

          sudo apt-get install -y libevent-2.1-7t64 libsqlite3-0

      On Ubuntu 22.04 the first is named libevent-2.1-7 instead. That is
      all this needs; there is no third package.

  3.  Start the node on the test network:

          ./bin/wamd -testnet -daemon

      It finds the network by itself through DNS. Give it a minute.

  4.  Ask it how it is doing:

          ./bin/wam-cli -testnet getblockchaininfo
          ./bin/wam-cli -testnet getsupplyinfo

That is a full node. It validates every block for itself and trusts
nobody, including us.


TO MINE
-------

  Download the miner package beside this one, then:

      ./wam-miner -o stratum+tcp://pool.wamcoin.org:3333 \\
                  -u YOUR_WAM_ADDRESS.rig1

  Get an address first:

      ./bin/wam-cli -testnet createwallet mine
      ./bin/wam-cli -testnet getnewaddress

  TESTNET COINS ARE WORTH NOTHING. They do not carry over to mainnet on
  15 September 2026. This is for testing the software, and that is all.


WHAT IS IN HERE
---------------
  bin/wamd         the node
  bin/wam-cli      talk to a running node$GUI_LINE
  bin/wam-tx       build and inspect raw transactions
  bin/wam-util     miscellaneous utilities
  bin/wam-wallet   wallet maintenance, offline

  DEPENDENCIES.txt what this needs installed, and how to check
  WHITEPAPER.md    the design and its limits
  SECURITY.md      how to report a vulnerability


CHECK OUR CLAIMS RATHER THAN BELIEVING THEM
-------------------------------------------

  ./bin/wam-cli -testnet getsupplyinfo     what the chain says about its money
  ./bin/wam-cli -testnet getdevfeeinfo     the 5% treasury and when it ends
  ./bin/wam-cli -testnet getrandomxinfo    the proof-of-work key schedule

  From the source tree, "$PY" scripts/verify_supply.py replays all 33
  halvings with exact integer arithmetic and asserts the 22,000,000 cap,
  and "$PY" scripts/patch_upstream.py --list prints every difference
  from Bitcoin Core with the reason for each.


THE FINE PRINT, WHICH IS THE IMPORTANT PART
-------------------------------------------

  These binaries are built for the plain x86-64 baseline and run on any
  64-bit Intel or AMD processor.

  They are NOT reproducible builds. The checksums prove your download
  arrived intact; they do not prove it was compiled from this source.
  If that distinction matters to you -- and for a currency it should --
  build it yourself. README.md has the steps and it takes about twenty
  minutes.

  There has been no third-party security audit.

Source:   https://wamcoin.org
Website:  https://wamcoin.org
EOF

# ---------------------------------------------------------------------------
# What will this actually need on a machine that is not this one?
#
# A binary copied to a clean Ubuntu box died with
#
#     error while loading shared libraries: libevent_pthreads-2.1.so.7
#
# which a downloader cannot read as "install one package". The build had been
# linking ZMQ -- a feature nothing here uses -- and that alone pulled in twelve
# libraries including the whole of Kerberos.
#
# So the packager now reads its own output and writes the answer into the
# tarball. Anything appearing here that is not libevent or libsqlite3 is a
# dependency that crept back in, and it is visible at package time rather than
# on a stranger's machine.
step "4b. runtime dependencies"

BASE_LIBS='linux-vdso|ld-linux|libc\.so|libm\.so|libgcc_s|libstdc\+\+|libpthread|libdl|librt|libanl|libresolv'
# `|| true`, and this one is the clearest case of the three. An empty NEEDED
# is the SUCCESS message four lines down -- "no dependencies beyond the C
# library -- this runs anywhere" -- and grep exits 1 when it filters
# everything away, so under pipefail the script died exactly when the answer
# was the one this whole release exists to produce. Third time today: the Qt
# sonames, the glibc symbol floor, and now this. One shape, three places, and
# every one of them fired on good news.
NEEDED="$(ldd "$WORK/stage/wam-coin-$VERSION/bin/wamd" 2>/dev/null \
          | awk '/=>/ {print $1}' | grep -vE "$BASE_LIBS" | sort -u || true)"

if [ -z "$NEEDED" ]; then
    ok "no dependencies beyond the C library -- this runs anywhere"
else
    printf '  needs, beyond a bare glibc system:\n'
    printf '%s\n' "$NEEDED" | sed 's/^/    /'
    # Anything unexpected is loud. Twelve of these were shipping silently.
    UNEXPECTED="$(printf '%s\n' "$NEEDED" | grep -vE 'libevent|libsqlite3' || true)"
    if [ -n "$UNEXPECTED" ]; then
        printf '\n  \033[33mwarn\033[0m  unexpected dependencies, each one a package the\n'
        printf '        downloader must already have:\n'
        printf '%s\n' "$UNEXPECTED" | sed 's/^/          /'
        printf '        Was a feature enabled by accident?\n'
    fi
fi

# ---------------------------------------------------------------------------
step "4c. will it start on the oldest system we promise?"

# The library *names* above are only half the question. A binary can link
# exactly the right libraries and still refuse to start, because it was
# compiled against a newer libstdc++ or glibc than the target has: the loader
# needs specific symbol versions, not just the file.
#
# This is not hypothetical. The first release was built on 24.04 and required
# GLIBCXX_3.4.32, which is GCC 14. Ubuntu 22.04 tops out at 3.4.30, so it did
# not start there at all -- while the file it shipped with cheerfully claimed
# "Ubuntu 22.04 / 24.04". Nobody noticed because it was only ever run on the
# machine that built it and on a server of the same version.
#
# The floor is glibc 2.35 / GLIBCXX_3.4.30: Ubuntu 22.04 LTS, which is what
# most providers still hand you by default. Measured, not asserted, and a
# build that exceeds it stops here rather than on a stranger's machine.
BASELINE_GLIBC="2.35"
BASELINE_GLIBCXX="3.4.30"

vermax() { tr ' ' '\n' | sed 's/^[A-Z_]*_//' | sort -V | tail -1; }

# EVERY BINARY THAT SHIPS, NOT ONE OF THEM.
#
# This read bin/wamd and nothing else. The miner was never examined, and when
# the graphical wallet moved into an archive of its own on 2026-09-27 it left
# the only file this check looked at -- so a wallet that cannot start on the
# oldest system we promise would have shipped without a word. The GUI is the
# likeliest one to fail it: it links Qt, and Qt is where a newer symbol
# requirement comes from.
#
# The worst requirement across all of them decides, because a release is only
# as portable as the file a person happens to run.
PORT_BINS=""
for b in "$WORK/stage/wam-coin-$VERSION/bin"/*; do
    [ -f "$b" ] && PORT_BINS="$PORT_BINS $b"
done
[ -f "$MINER_DIR/wam-miner" ] && PORT_BINS="$PORT_BINS $MINER_DIR/wam-miner"
if [ "$HAVE_GUI" = "1" ] && [ -f "$WALLET_DIR/bin/wam-qt" ]; then
    PORT_BINS="$PORT_BINS $WALLET_DIR/bin/wam-qt"
fi

REQ_GLIBC=0; REQ_GLIBCXX=0
for b in $PORT_BINS; do
    # `|| true` on all three, for the same reason the Qt line above needed it:
    # grep exits 1 on no match, pipefail carries it, set -e kills the shell.
    # The `${bg:-0}` defaults say plainly that the author expected an empty
    # answer to be possible -- a binary with no versioned GLIBCXX symbol is an
    # ordinary thing -- and the script would have died before reaching them.
    # Latent only because every binary here happens to be C++; the first C one
    # would have found it the hard way, in a release.
    bsyms="$(objdump -T "$b" 2>/dev/null \
             | grep -oE 'GLIBCXX_[0-9.]+|GLIBC_[0-9.]+' | sort -u || true)"
    bg="$(printf '%s\n' "$bsyms" | grep '^GLIBC_'   | vermax || true)"; bg="${bg:-0}"
    bx="$(printf '%s\n' "$bsyms" | grep '^GLIBCXX_' | vermax || true)"; bx="${bx:-0}"
    printf '  %-14s glibc %-8s GLIBCXX %s\n' "$(basename "$b")" "$bg" "$bx"
    [ "$(printf '%s\n%s\n' "$bg" "$REQ_GLIBC"   | sort -V | tail -1)" = "$bg" ] && REQ_GLIBC="$bg"
    [ "$(printf '%s\n%s\n' "$bx" "$REQ_GLIBCXX" | sort -V | tail -1)" = "$bx" ] && REQ_GLIBCXX="$bx"
done

# `sort -V | head -1` picking the baseline means the requirement is <= it.
newer_than() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" != "$1" ]; }

PORTABLE=1
if newer_than "$REQ_GLIBC" "$BASELINE_GLIBC"; then
    PORTABLE=0
    printf '  \033[31mfail\033[0m  needs glibc %s; the baseline is %s\n' \
           "$REQ_GLIBC" "$BASELINE_GLIBC"
fi
if newer_than "$REQ_GLIBCXX" "$BASELINE_GLIBCXX"; then
    PORTABLE=0
    printf '  \033[31mfail\033[0m  needs GLIBCXX_%s; the baseline is %s\n' \
           "$REQ_GLIBCXX" "$BASELINE_GLIBCXX"
fi

if [ "$PORTABLE" = "0" ]; then
    printf '\n  This build will not start on Ubuntu 22.04. It is not a flag that\n'
    printf '  can be added -- the compiler on this machine is too new. Build it\n'
    printf '  on 22.04, or let the release workflow do it (it runs there for\n'
    printf '  exactly this reason).\n\n'
    fail "the binary is not portable to the oldest system this release claims"
fi
ok "glibc <= $BASELINE_GLIBC (needs $REQ_GLIBC), GLIBCXX <= $BASELINE_GLIBCXX (needs $REQ_GLIBCXX)"

# THE OTHER HALF OF PORTABILITY, WHICH THIS GATE COULD NEVER HAVE SEEN.
#
# Everything above reads symbol versions out of objdump -T. That is a real
# check and it passed on every release -- including the ones that could not
# start. DT_NEEDED is not a symbol version, so no amount of running the code
# above would ever have noticed that wamd asks a stranger's machine for
# libevent-2.1.so.7, or that wam-qt asks for that and five Qt libraries.
#
# Jeeves found it on 2026-10-18 by downloading v0.1.12 onto Ubuntu 26, which
# is the most expensive way for this project to learn anything.
printf '\n'
if ! bash "$REPO/scripts/check_shared_deps.sh" $PORT_BINS; then
    fail "a shipped binary links a library it does not carry. Build through
      scripts/build_linux.sh, which runs depends the way the Windows and
      macOS builds already do."
fi

# The tarball says what it needs, in the file people open first -- and it says
# it from measurement. A hand-written compatibility line is a claim nobody
# rechecks; this one cannot be wrong without the build failing above.
#
# IT WAS WRONG ANYWAY, UNTIL 2026-10-18. This file listed glibc and libstdc++,
# called itself measured, and was read by people deciding whether the download
# would run -- while wamd also loaded libevent and sqlite from the system. It
# measured one thing honestly and presented it as the whole answer. So the
# sonames are read out too now, and if the gate above ever has to allow one,
# the person opening this file learns it from the same place.
NODE_SONAMES="$(for b in "$WORK/stage/wam-coin-$VERSION/bin"/*; do
                    [ -f "$b" ] && readelf -d "$b" 2>/dev/null
                done | sed -n 's/.*Shared library: \[\(.*\)\].*/\1/p' \
                | sort -u | tr '\n' ' ')"

cat > "$WORK/stage/wam-coin-$VERSION/DEPENDENCIES.txt" <<DEPS
WAM Coin $VERSION -- what this needs to run
===========================================

Measured from this exact binary, not assumed:

    glibc     $REQ_GLIBC or newer
    libstdc++  GLIBCXX_$REQ_GLIBCXX or newer  (GCC 12 and up)

    it loads: $NODE_SONAMES

That is Ubuntu 22.04 LTS or newer, Debian 12 or newer, and anything of a
similar age. If your system is older than that, build from source -- no flag
on this binary will make it start.

The node carries its own libraries. boost, libevent, sqlite and ZeroMQ are
built from source into the binary, so there is nothing to install and no
package name to look up: the list above is the whole of what it loads from
your system, and it is the C library and its companions.

That changed in v0.1.13. Until v0.1.12 this file told you to run

    sudo apt-get install -y libevent-2.1-7t64 libsqlite3-0

because the binary really did ask for them -- and on a clean Ubuntu the
first of those two is not installed, so the node stopped with "error while
loading shared libraries: libevent-2.1.so.7" and named a file rather than a
package. That is the least helpful failure a program can have, and it is
why this build is made differently.

ZeroMQ is compiled in, not left out: a node can publish block and
transaction notifications over it, which is how an indexer learns a block
arrived without polling for it. It is linked statically, so it adds no
library for you to find.

If the node still exits with "error while loading shared libraries", the
missing file is named in the message and something is wrong with this
archive rather than with your machine -- please say so, with the line it
printed.

Verify what your copy actually wants:

    ldd bin/wamd | grep 'not found'

Empty output means the libraries are present. To check the versions too:

    ldd bin/wamd >/dev/null && echo ok

Anything about GLIBCXX or GLIBC there means your system is older than this
build; use a newer one or build from source.
DEPS

TARBALL_NODE="wam-coin-$VERSION-$PLATFORM.tar.gz"
TARBALL_MINER="wam-miner-$VERSION-$PLATFORM.tar.gz"
TARBALL_WALLET="wam-qt-$VERSION-$PLATFORM.tar.gz"

tar -czf "$OUT/$TARBALL_NODE"  -C "$WORK/stage" "wam-coin-$VERSION"
tar -czf "$OUT/$TARBALL_MINER" -C "$WORK/stage" "wam-miner-$VERSION"
ok "$TARBALL_NODE  ($(( $(stat -c%s "$OUT/$TARBALL_NODE") / 1024 / 1024 )) MB)"
ok "$TARBALL_MINER  ($(( $(stat -c%s "$OUT/$TARBALL_MINER") / 1024 )) KB)"
if [ "$HAVE_GUI" = "1" ]; then
    tar -czf "$OUT/$TARBALL_WALLET" -C "$WORK/stage" "wam-qt-$VERSION"
    ok "$TARBALL_WALLET  ($(( $(stat -c%s "$OUT/$TARBALL_WALLET") / 1024 / 1024 )) MB)"
fi

# ---------------------------------------------------------------------------
step "4d. instructions the machine downloading this may not have"

# 4c asks whether the loader will accept the binary. This asks whether the CPU
# will accept its instructions, and it is a separate question that was answered
# wrongly for a whole release.
#
# v0.1.2 passed every check in this file. Step 1 confirmed the node carried no
# -march= flag, which was true. Step 2 rebuilt RandomX for the baseline -- and
# gave that copy to the miner, while the node kept the ARCH=native library it
# had been linked against during the build. So a release went out with 746
# AVX-512 instructions inside wamd, and died with SIGILL on the first machine
# that lacked them:
#
#     wamd.service: Main process exited, code=dumped, status=4/ILL
#
# Flags describe intent. This reads the file.
if bash "$REPO/scripts/check_isa_baseline.sh" \
        "$WORK/stage/wam-coin-$VERSION/bin/"* \
        "$WORK/stage/wam-miner-$VERSION/"* >/tmp/wam_isa.log 2>&1; then
    ok "every packaged binary stays within the x86-64 baseline"
else
    sed 's/^/  /' /tmp/wam_isa.log
    fail "a packaged binary carries instructions the baseline does not have"
fi

# ---------------------------------------------------------------------------
step "5. checksums"

# The wallet is listed only when it was built. A SHA256SUMS naming a file
# that is not published is the same lie as a published file named nowhere:
# verify_release.sh would report a missing download about a release that is
# whole.
if [ "$HAVE_GUI" = "1" ]; then
    ( cd "$OUT" && sha256sum "$TARBALL_NODE" "$TARBALL_MINER" "$TARBALL_WALLET" > SHA256SUMS )
else
    ( cd "$OUT" && sha256sum "$TARBALL_NODE" "$TARBALL_MINER" > SHA256SUMS )
fi
cat "$OUT/SHA256SUMS" | sed 's/^/  /'

# ---------------------------------------------------------------------------
step "6. signature"

# The fingerprint published in SECURITY.md, and nowhere else.
SIGNING_KEY="4BD4A8D3AFD43F5CBCB500E23798462FE00ADBA4"

# Until 3 September 2026 this script ended by printing "sign it" as advice.
# Advice at the end of a script is a step that gets skipped on the night it
# matters, and an unsigned release is one a stranger cannot tell from a
# substituted one. It signs, or it says loudly that it did not.
if ! command -v gpg >/dev/null 2>&1; then
    echo "  ${YLW:-}gpg is not installed -- THIS RELEASE IS UNSIGNED${OFF:-}"
elif ! gpg --list-secret-keys "$SIGNING_KEY" >/dev/null 2>&1; then
    echo "  the signing key $SIGNING_KEY is not on this machine."
    echo "  THIS RELEASE IS UNSIGNED. Do not publish it."
else
    ( cd "$OUT" && gpg --batch --yes --local-user "$SIGNING_KEY" \
        --detach-sign --armor --output SHA256SUMS.asc SHA256SUMS )
    if [ -s "$OUT/SHA256SUMS.asc" ]; then
        echo "  SHA256SUMS.asc written"
        # Verified here, not assumed. A signature that does not verify is
        # worse than none: it is published, it looks like protection, and it
        # fails in the hands of the first person who checks it.
        if gpg --verify "$OUT/SHA256SUMS.asc" "$OUT/SHA256SUMS" 2>&1 \
             | grep -q "Good signature"; then
            echo "  and it verifies against the published key"
        else
            fail "the signature was written but does not verify"
        fi
    else
        fail "signing produced nothing -- do not publish this release"
    fi
fi

echo
echo "=================================================================="
echo " Release staged in $OUT"
echo
echo " Publish them together:"
echo "   $TARBALL_NODE"
echo "   $TARBALL_MINER"
[ "$HAVE_GUI" = "1" ] && echo "   $TARBALL_WALLET"
echo "   SHA256SUMS"
echo "   SHA256SUMS.asc     <- without this the other three prove nothing"
echo
echo " Anyone can then check the download with one command:"
echo "   bash scripts/verify_release.sh <the directory they downloaded into>"
echo "=================================================================="
