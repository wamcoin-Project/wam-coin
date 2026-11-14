#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  build.sh -- compile wam-miner
# ===========================================================================
#
#      bash miner/build.sh
#
#  One translation unit, one g++ invocation, one static library. No autotools,
#  no cmake, no package manager. Somebody who has just downloaded the source
#  should be able to read this script in full before running it.
#
#  Environment:
#      RANDOMX_INCLUDE   default ~/wam/build/randomx/src
#      RANDOMX_LIB       default ~/wam/build/randomx/build/librandomx.a
#      CXX               default g++
#      OUT               default miner/wam-miner
#      LDFLAGS           default empty
#      LDLIBS            default -lpthread
#      RUN_SELF_TEST     default 1; set 0 when cross-compiling
#
#  CROSS-COMPILING
#
#  scripts/build_windows.sh drives this script with the mingw compiler to
#  produce wam-miner.exe, which is why LDFLAGS, LDLIBS and RUN_SELF_TEST are
#  knobs rather than constants: Windows needs -lws2_32 for sockets, a static
#  link so the result is one file somebody can double-click, and it cannot run
#  its own self-test on the Linux machine that built it.
#
#  Skipping that self-test is only acceptable because it is not skipped: the
#  platform-build workflow runs --self-test on a real Windows runner, and the
#  SHA-256, byte-order, target and RandomX vectors all have to pass there
#  before the binary is packaged. A cross-built miner whose RandomX disagreed
#  would hash all day and find nothing.
# ===========================================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Look in this repository first, then in ~/wam.
#
# HERE was already computed from the script's own location and then ignored in
# favour of $HOME/wam -- which is correct on exactly one machine, the laptop
# this was written on. Cloned to /opt/wam on a server it failed with "randomx.h
# not found at /root/wam/build/randomx/src", naming a path the operator never
# chose and cannot see the origin of.
#
# fetch-upstream.sh builds RandomX into <repo>/build/randomx, so the repository
# already knows where its own artefacts are. The $HOME fallback stays for
# anyone with an existing tree built the old way.
for base in "$REPO/build/randomx" "$HOME/wam/build/randomx"; do
    if [ -f "$base/src/randomx.h" ]; then
        RANDOMX_DEFAULT_BASE="$base"
        break
    fi
done
RANDOMX_DEFAULT_BASE="${RANDOMX_DEFAULT_BASE:-$REPO/build/randomx}"

RANDOMX_INCLUDE="${RANDOMX_INCLUDE:-$RANDOMX_DEFAULT_BASE/src}"
RANDOMX_LIB="${RANDOMX_LIB:-$RANDOMX_DEFAULT_BASE/build/librandomx.a}"
CXX="${CXX:-g++}"
OUT="${OUT:-$HERE/wam-miner}"
LDFLAGS="${LDFLAGS:-}"
LDLIBS="${LDLIBS:--lpthread}"
RUN_SELF_TEST="${RUN_SELF_TEST:-1}"

# The Windows resource compiler, when we are producing a .exe.
#
# Derived from $CXX rather than asked for separately: whoever sets CXX to
# x86_64-w64-mingw32-g++ has already said what they are building for, and a
# second variable that has to agree with the first is a variable that will one
# day disagree.
WINDRES="${WINDRES:-}"
case "$CXX" in
    *mingw32-g++|*mingw32-c++|*-w64-mingw32*)
        [ -n "$WINDRES" ] || WINDRES="${CXX%-*}-windres" ;;
esac

fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33m!!\033[0m    %s\n' "$*"; }

echo "=================================================================="
echo " Building wam-miner"
echo "=================================================================="

command -v "$CXX" >/dev/null 2>&1 \
    || fail "no C++ compiler. Install one with:  sudo apt-get install -y g++"
ok "compiler          $($CXX --version | head -1)"

[ -f "$RANDOMX_INCLUDE/randomx.h" ] \
    || fail "randomx.h not found at $RANDOMX_INCLUDE.
     Build RandomX first (scripts/fetch-upstream.sh), or set RANDOMX_INCLUDE."
ok "randomx headers   $RANDOMX_INCLUDE"

[ -f "$RANDOMX_LIB" ] \
    || fail "librandomx.a not found at $RANDOMX_LIB.
     Build RandomX first, or set RANDOMX_LIB."
ok "librandomx        $RANDOMX_LIB"

# The batched hashing entry points are what make a miner fast rather than
# merely correct. Checking for them here turns a wall of template errors into
# one sentence.
grep -q 'randomx_calculate_hash_next' "$RANDOMX_INCLUDE/randomx.h" \
    || fail "this librandomx predates randomx_calculate_hash_next().
     Update RandomX to 1.1.0 or newer."
ok "batched hashing   available"

echo
# ---------------------------------------------------------------------------
#  The Windows version resource
# ---------------------------------------------------------------------------
#
#  Only when building a .exe, and it is not optional there. An executable that
#  states no company, no product and no description is the profile Defender's
#  classifier flagged as Trojan:Win32/Bearfoos.A!ml on the first Windows build
#  of this miner -- see the header of miner/wam-miner.rc. It is also what
#  somebody sees in Task Manager when they wonder what is using their CPU.
RES_OBJ=""
if [ -n "$WINDRES" ]; then
    if command -v "$WINDRES" >/dev/null 2>&1; then
        RES_OBJ="${OUT%.exe}-res.o"
        "$WINDRES" -I"$HERE" "$HERE/wam-miner.rc" -O coff -o "$RES_OBJ" \
            || fail "the version resource did not compile: $HERE/wam-miner.rc"
        ok "version resource  $(basename "$RES_OBJ")"
    else
        # Not fatal, because a miner that mines is worth more than a miner
        # that describes itself. Said out loud, because shipping it anonymous
        # is a choice and not an accident.
        printf '  \033[33m!!\033[0m    %s not found -- the .exe will carry no\n' "$WINDRES"
        printf '        publisher, product name or description, which makes an\n'
        printf '        antivirus warning considerably more likely. Install\n'
        printf '        binutils-mingw-w64-x86-64.\n'
    fi
fi

echo "  compiling..."

# -O3 and -march=native: this is the hot loop of the whole program, and a
# miner is always built on the machine that will run it. Distributors who need
# a portable binary should override with CXXFLAGS='-O3 -mtune=generic'.
: "${CXXFLAGS:=-O3 -march=native}"

# ---------------------------------------------------------------------------
#  TLS, when this machine has it
# ---------------------------------------------------------------------------
#
#  This miner spoke no TLS at all until 13 November 2026, so a man in the path
#  could replace the block template and take the whole hashrate while every
#  share still reported accepted. The fix is in src/tls.h, and it is OPTIONAL
#  on purpose.
#
#  build.sh is one g++ call, one translation unit and one static library,
#  which is what lets a stranger build this on a machine with nothing
#  installed. Making libssl mandatory would take that away from Linux,
#  Windows, macOS and Android at once to add encryption on one of them.
#
#  So the headers decide. Found: -DWAM_MINER_TLS and -lssl -lcrypto, and
#  stratum+ssl:// works. Not found: the binary is exactly what it was, and it
#  says so -- the scheme is refused with the stunnel line rather than
#  downgraded, and a plaintext pool is warned about on every start.
#
#  Set WAM_MINER_TLS=0 to build without it deliberately, or =1 to insist and
#  have this fail loudly rather than quietly produce the smaller binary.
TLS_FLAGS=""
TLS_LIBS=""
want_tls="${WAM_MINER_TLS:-auto}"

if [ "$want_tls" != "0" ]; then
    tls_probe="$(mktemp -t wamtlsXXXXXX.cpp 2>/dev/null || echo /tmp/wamtls.cpp)"
    {
        echo '#include <openssl/ssl.h>'
        echo '#include <openssl/x509v3.h>'
        echo 'int main(){ SSL_CTX_new(TLS_client_method()); return 0; }'
    } > "$tls_probe"
    tls_bin="${tls_probe%.cpp}.bin"
    if "$CXX" -std=c++17 "$tls_probe" -lssl -lcrypto -o "$tls_bin" >/dev/null 2>&1; then
        TLS_FLAGS="-DWAM_MINER_TLS"
        TLS_LIBS="-lssl -lcrypto"
        ok "TLS               yes, linking libssl"
    elif [ "$want_tls" = "1" ]; then
        rm -f "$tls_probe" "$tls_bin"
        fail "WAM_MINER_TLS=1 was asked for and libssl could not be linked.
     Install the development package -- libssl-dev, openssl-devel, or
     'brew install openssl@3' -- or unset WAM_MINER_TLS."
    else
        warn "TLS               no libssl here, so stratum+ssl:// is refused"
        warn "                  rather than downgraded. Install libssl-dev to"
        warn "                  build with it."
    fi
    rm -f "$tls_probe" "$tls_bin"
else
    warn "TLS               disabled by WAM_MINER_TLS=0"
fi

echo

# shellcheck disable=SC2086
"$CXX" -std=c++17 $CXXFLAGS $LDFLAGS $TLS_FLAGS \
    -I"$RANDOMX_INCLUDE" \
    -I"$HERE/src" \
    "$HERE/src/main.cpp" \
    $RES_OBJ \
    "$RANDOMX_LIB" \
    $LDLIBS $TLS_LIBS \
    -o "$OUT"

[ -f "$OUT" ] || fail "compilation produced no output"

# An `if`, not `[ -n "$RES_OBJ" ] && rm ...`. This script runs under `set -e`,
# where a trailing && list that evaluates false is a failed command and exits
# the shell -- so the shorter form would have aborted every Linux build, which
# never has a resource object, one line before the self-test.
if [ -n "$RES_OBJ" ]; then
    rm -f "$RES_OBJ"
fi
ok "built             $OUT  ($(( $(stat -c%s "$OUT") / 1024 )) KB)"

echo
if [ "$RUN_SELF_TEST" = "1" ]; then
    # The unit tests first, because they fail with a line number and the
    # self-test fails with a symptom.
    #
    # These existed before and were run by hand, which means they were run on
    # the day they were written. Both of the bugs solo mining shipped with --
    # BIP34's small heights and the reversed RandomX key -- are covered by
    # tests that were sitting in this directory, unbuilt, while a regtest chain
    # was used to find them instead.
    # ONE OF THESE NEEDS A NODE, AND THIS LOOP HAS NONE.
    #
    # solo_jobs_test asks a running wamd for templates: it is the proof that a
    # solved block can still be turned into a block, which is the defect that
    # cost a miner his work on 2026-09-26. It cannot answer without a node,
    # and on 2026-09-27 it stopped package_release.sh dead for exactly that
    # reason -- a test that is right refusing a build that is fine.
    #
    # It is not skipped and it is not weakened. It is run by
    # scripts/solo_gate.sh, which starts a regtest node for it, daily and
    # before a release. Compiling it here anyway keeps the one thing this loop
    # can still prove about it: that it builds.
    for t in "$HERE"/test/*_test.cpp; do
        [ -f "$t" ] || continue
        name=$(basename "$t" .cpp)
        bin="${TMPDIR:-/tmp}/wam-$name.$$"
        if [ "$name" = "solo_jobs_test" ]; then
            echo "  $name... (compiled here; run by scripts/solo_gate.sh, which has a node)"
            "$CXX" -std=c++17 -O1 -I"$HERE/src" "$t" -o "$bin"         || fail "$name did not compile"
            rm -f "$bin"
            continue
        fi
        echo "  $name..."
        # tls_test needs the same flags the binary was built with, or it
        # compiles its own not-built-with-TLS path and reports that it
        # checked nothing.
        t_cxx=""
        t_ld=""
        if [ "$name" = "tls_test" ]; then t_cxx="$TLS_FLAGS"; t_ld="$TLS_LIBS"; fi
        # shellcheck disable=SC2086
        "$CXX" -std=c++17 -O1 -I"$HERE/src" $t_cxx "$t" $t_ld -o "$bin"             || fail "$name did not compile"
        # AND 2 IS NOT A FAILURE. It is this project's code for "could not
        # check", and a build without libssl is exactly that for tls_test.
        # Treating it as a failure would mean no machine without libssl-dev
        # could build the miner at all, which is the opposite of why TLS is
        # optional here.
        "$bin"; rc=$?
        rm -f "$bin"
        if [ "$rc" -eq 2 ]; then
            warn "$name could not check everything on this machine (exit 2)"
        elif [ "$rc" -ne 0 ]; then
            fail "$name failed; do not use this build"
        fi
    done

    echo "  self-test..."
    "$OUT" --self-test --no-colour || fail "the self-test failed; do not use this build"
else
    # Said out loud, because "the build passed" and "the binary is correct" are
    # different claims and this is the one place they come apart.
    printf '  \033[33m!!\033[0m    self-test NOT run -- this binary cannot execute here.\n'
    printf '        It must run --self-test on the target platform before it is\n'
    printf '        packaged or published.\n'
fi

echo
echo "=================================================================="
echo " wam-miner is ready."
echo
echo "   $OUT -o stratum+tcp://<pool>:3333 -u <your WAM address>"
echo "=================================================================="
