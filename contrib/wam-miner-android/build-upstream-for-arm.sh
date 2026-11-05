#!/usr/bin/env bash
# android: copied the working scripts/fetch-upstream.sh whole with Android CMake toolchain added
# android: this is just temporary - will be replaced by a better standalone script
# android: all comments after this belong to the original script mentioned above
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  fetch-upstream.sh -- pull the pinned Bitcoin Core tree and apply the WAM
#                       transformations
# ===========================================================================
#
#  WAM Coin is a fork, not a rewrite. Roughly 250,000 lines of peer-to-peer
#  networking, script interpretation, UTXO management and wallet code are
#  inherited from Bitcoin Core -- code that has been adversarially reviewed for
#  fifteen years. Retyping it would not make WAM more original, it would make
#  it less safe.
#
#  What this repository owns is the ~2,000 lines that actually make WAM
#  different: the emission schedule, the treasury rule, DarkGravityWave and
#  RandomX. Those live in src/wam/ and are applied on top by
#  scripts/patch_upstream.py.
#
#  The upstream tag is PINNED. Never track a branch: a consensus layer that
#  changes underneath you between two builds is not a consensus layer.
# ===========================================================================

set -euo pipefail

#./setup-dependencies.sh

export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_NDK_ROOT="$ANDROID_HOME/ndk/23.1.7779620"
export ANDROID_TOOLCHAIN="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64"
export AR="$ANDROID_TOOLCHAIN/bin/llvm-ar"
export CC="$ANDROID_TOOLCHAIN/bin/aarch64-linux-android28-clang"
export CXX="$ANDROID_TOOLCHAIN/bin/aarch64-linux-android28-clang++"
export RANLIB="$ANDROID_TOOLCHAIN/bin/llvm-ranlib"
export PATH="$ANDROID_NDK_ROOT:$ANDROID_HOME/emulator:$ANDROID_HOME/tools:$ANDROID_HOME/tools/bin:$ANDROID_HOME/platform-tools:$PATH"

#gradle wrapper

cd ../../scripts


# An interpreter that is actually Python: `python3` on Windows is a
# Microsoft Store stub that runs nothing and exits 49.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPTS_DIR/lib/python.sh"

# --- pinned upstream -------------------------------------------------------
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/bitcoin/bitcoin.git}"
UPSTREAM_TAG="${UPSTREAM_TAG:-v28.1}"

RANDOMX_REPO="${RANDOMX_REPO:-https://github.com/tevador/RandomX.git}"
RANDOMX_TAG="${RANDOMX_TAG:-v1.2.1}"

# --- layout ----------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$REPO_ROOT/build}"
CORE_DIR="$BUILD_DIR/wam-core"
RANDOMX_DIR="$BUILD_DIR/randomx"

log()  { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\033[0;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null    || die "git is not installed"
command -v "$PY" >/dev/null || die ""$PY" is not installed"
command -v cmake >/dev/null  || die "cmake is not installed (needed for RandomX)"

mkdir -p "$BUILD_DIR"

# ===========================================================================
log "1/4  RandomX $RANDOMX_TAG"
# ===========================================================================

if [ -d "$RANDOMX_DIR/.git" ]; then
    log "     already cloned; fetching tags"
    git -C "$RANDOMX_DIR" fetch --tags --quiet
else
    git clone --quiet --depth 1 --branch "$RANDOMX_TAG" "$RANDOMX_REPO" "$RANDOMX_DIR"
fi
git -C "$RANDOMX_DIR" checkout --quiet "$RANDOMX_TAG"

# android: ARCH=aarch64
RANDOMX_ARCH="aarch64"

# ===========================================================================
#  THE NOTE THE ASSEMBLER WILL NOT ADD FOR YOU
# ===========================================================================
#
# RandomX ships hand-written assembly -- jit_compiler_x86_static.S and its
# ARM and RISC-V siblings -- and none of the three carries a
# .note.GNU-stack section. When the linker meets one object without that
# note it cannot know whether the code needs an executable stack, so it
# assumes the worst and marks the WHOLE output RWE.
#
# Measured on the published v0.1.11 Linux release:
#
#     wam-cli  wam-tx  wam-util  wam-wallet     GNU_STACK RW
#     wamd                                      GNU_STACK RWE
#
# One binary out of five, and it is the only one that links librandomx.a.
#
# It is not needed. RandomX takes its executable memory from mmap with
# PROT_EXEC -- build/randomx/src/virtual_memory.c -- never from the stack, so
# the permission buys nothing and removes a protection every other program we
# ship has. An executable stack is the condition a stack-overflow exploit
# needs in order to run what it wrote.
#
# Reported by dang150296 (Urriki1502) on 2026-10-12, with readelf output,
# after the pool and the node had both been audited and this had not. Nothing
# in this project read the hardening flags of the binaries it publishes;
# scripts/check_binary_hardening.sh does now.
#
# The note is added here rather than passed at link time because librandomx.a
# is a static archive: the objects inside it carry the answer, and no flag on
# a later link can put a note into an object that has none.
# AND IT IS GUARDED, BECAUSE THE DIRECTIVE IS ELF-ONLY.
#
# The first version of this appended the directive bare. It is correct on
# Linux and it is not a directive at all on Windows: the mingw assembler
# targets PE/COFF, reads the line as text and stops --
#
#     jit_compiler_x86_static.S:235: Error: junk at end of line, first
#     unrecognized character is `-'
#     FAIL librandomx.a did not build for x86_64-w64-mingw32
#
# -- so the Windows build was broken for everybody between that commit and
# this one. Reported as issue #4 by gvsa within hours of the push, from a
# WSL build of scripts/build_windows.sh. Nothing here builds for Windows, so
# nothing here could have caught it; the platform-build workflow would have,
# on the next release, which is after the damage.
#
# The files are .S with a capital S, so the C preprocessor runs over them
# before the assembler does and __ELF__ decides. On Linux the note is
# emitted; on mingw the three lines vanish before the assembler sees them.
# EVERY BLOCK WE EVER WROTE, NOT JUST THE CURRENT ONE.
#
# The first attempt at this upgrade keyed on a marker string the broken
# version had never written -- it says "Added by WAM", not "WAM:note" -- so
# the test tree fell through to "there is already a note here, skip it" and
# stayed broken, silently, which is the exact failure the upgrade exists to
# prevent. Both spellings are matched below because both were shipped.
# Both spellings, because both were shipped: the broken version's block
# begins "/* Added by WAM", the current one "/* WAM:note.GNU-stack".
#
# Cut by LINE NUMBER, not with a sed address. The first attempt used
# sed -E "/($PATTERN)/,\$d" with the pattern in a variable, and the pattern
# contains a slash -- which is sed's own address delimiter, so it died with
# "Unmatched ( or \(" and deleted nothing. The guarded block was then
# appended BELOW the broken one, leaving the file with two directives and
# still unbuildable on Windows. Twice wrong in the same half hour, and both
# times it reported success.
RANDOMX_PATCHED=0
for _s in "$RANDOMX_DIR"/src/*.S; do
    [ -f "$_s" ] || continue
    # `|| true` because this script runs under `set -euo pipefail` and grep
    # returns 1 when it matches nothing -- which is the normal case, on every
    # clean clone, for every file. pipefail made that 1 the status of the
    # whole pipeline, the assignment inherited it, and -e killed the script
    # one line after "1/4 RandomX", printing nothing.
    #
    # So from the commit that added this block until 2026-10-16, fetching
    # upstream from a fresh checkout failed for everybody, and the only trees
    # it worked on were ones that had already been patched once. Both of my
    # tests were upgrades of an existing tree, so neither touched it, and the
    # last platform-build before it was 27 September. The workflow found it in
    # 35 seconds on the first run after.
    _mine="$(grep -nE 'WAM:note\.GNU-stack|Added by WAM' "$_s" | head -1 | cut -d: -f1 || true)"
    if [ -n "$_mine" ]; then
        # Ours. Guarded already means there is nothing to do; unguarded means
        # a tree that cannot build for Windows or macOS and must be rewritten.
        grep -q '__ELF__' "$_s" && continue
        head -n "$((_mine - 1))" "$_s" > "$_s.wamtmp" && mv "$_s.wamtmp" "$_s"
        log "     replaced an unguarded note in $(basename "$_s")"
    elif grep -q 'note\.GNU-stack' "$_s"; then
        continue        # upstream added one of its own: not ours to rewrite
    fi
    cat >> "$_s" <<'NOTE'

/* WAM:note.GNU-stack -- see scripts/fetch-upstream.sh.
   RandomX takes its executable memory from mmap, never from the stack, so
   without this note the linker marks the whole node RWE. ELF only: on
   mingw the directive does not exist and the assembler stops on it. */
#if defined(__ELF__)
.section .note.GNU-stack,"",%progbits
#endif
NOTE
    log "     added a guarded .note.GNU-stack to $(basename "$_s")"
    RANDOMX_PATCHED=1
done

# AND THE ARCHIVE HAS TO BE REBUILT, OR THE PATCH IS A COMMENT.
#
# The build below is skipped when librandomx.a already exists. An archive
# built before the note was added does not have it, and the fix would then
# apply to nothing while this script said it had applied it.
if [ "$RANDOMX_PATCHED" = 1 ] && [ -f "$RANDOMX_DIR/build/librandomx.a" ]; then
    log "     the note changed the sources; discarding the old librandomx.a"
    rm -f "$RANDOMX_DIR/build/librandomx.a"
fi

if [ ! -f "$RANDOMX_DIR/build/librandomx.so" ]; then
    log "     building librandomx (ARCH=$RANDOMX_ARCH)"
	    cmake -S "$RANDOMX_DIR" -B "$RANDOMX_DIR/build" -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release -DARCH="$RANDOMX_ARCH" -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_ROOT/build/cmake/android.toolchain.cmake" -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 >/dev/null
    cmake --build "$RANDOMX_DIR/build" -j"$(nproc 2>/dev/null || echo 4)" >/dev/null
else
    log "     librandomx.so already built"
fi

[ -f "$RANDOMX_DIR/build/librandomx.so" ] || die "librandomx.so was not produced"

# Verify the library against the reference vector before anything depends on it.
log "     verifying librandomx against the reference test vector"
if [ -f "$RANDOMX_DIR/build/randomx-tests" ]; then
    "$RANDOMX_DIR/build/randomx-tests" >/dev/null && log "     reference tests pass"
else
    warn "randomx-tests binary not found; skipping the reference check"
fi

# ===========================================================================
log "2/4  Bitcoin Core $UPSTREAM_TAG"
# ===========================================================================

if [ -d "$CORE_DIR/.git" ]; then
    CURRENT="$(git -C "$CORE_DIR" describe --tags --exact-match 2>/dev/null || echo none)"
    if [ "$CURRENT" != "$UPSTREAM_TAG" ]; then
        die "$CORE_DIR is checked out at '$CURRENT', not '$UPSTREAM_TAG'.
     A tree that has already been patched must not be re-patched at a different
     tag. Remove it and re-run:
         rm -rf $CORE_DIR"
    fi
    if [ -f "$CORE_DIR/.wam-patched" ]; then
        log "     already fetched and patched at $UPSTREAM_TAG"
        PATCHED=1
    else
        PATCHED=0
    fi
else
    log "     cloning (shallow, ~120 MB)"
    git clone --quiet --depth 1 --branch "$UPSTREAM_TAG" "$UPSTREAM_REPO" "$CORE_DIR"
    PATCHED=0
fi

# Record the exact commit so a build is reproducible from the log alone.
UPSTREAM_COMMIT="$(git -C "$CORE_DIR" rev-parse HEAD)"
log "     upstream commit $UPSTREAM_COMMIT"

# ===========================================================================
log "3/4  Applying the WAM transformations"
# ===========================================================================

# RE-RUNNING ON AN ALREADY-PATCHED TREE IS NOT SAFE, AND THIS LINE USED TO
# SAY IT WAS.
#
# It read "the patcher is idempotent". Most of its edits are: each carries a
# marker describing what it produces, finds the marker, and reports "already
# applied". But a marker that describes the OUTPUT is version-specific on
# purpose -- v0.1.1 shipped reporting /WAM:0.1.0/ because a marker named the
# family instead of the result, and that lesson is written into
# patch_upstream.py. The consequence is that a tree patched at one WAM
# version cannot be re-patched at a later one: the marker for the new version
# is absent and the upstream anchor is gone too, so the patcher aborts
# part-way.
#
# On 18 September that cost an hour. France's tree was patched at 0.1.0 in
# August; re-running it for 0.1.9 stopped at configure.ac with
#
#     anchor for 'version 28.1.0 -> 0.1.8' not found
#
# and left the tree partially patched -- which is the one state you must not
# build from.
#
# The release CI clones upstream fresh on every run, so no published binary
# has ever been affected, and the patcher is deliberately left alone: it is
# the machinery behind every release and its version markers are correct.
# What was wrong was this sentence.
if [ "$PATCHED" = "1" ]; then
    log "     tree already patched at $UPSTREAM_TAG -- re-applying"
    log "     if this aborts, the tree was patched at an older WAM version:"
    log "       rm -rf $CORE_DIR   and run this again. Do not build from a"
    log "       tree that stopped part-way through patching."
fi

"$PY" "$SCRIPTS_DIR/patch_upstream.py" --tree "$CORE_DIR" --repo "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Rename the binaries.
#
# rename_binaries.py has existed, complete and tested, since the first week,
# and was never called from anywhere. The result shipped as far as a live
# server: the node's executable was still `bitcoind`, with `wamd` a symlink
# beside it. Every check passed, because the symlink works.
#
# It is not cosmetic. A WAM node and a Bitcoin node cannot coexist on one
# machine when both install /usr/local/bin/bitcoind, and package_release.sh
# looks for src/wamd, which never existed.
#
# Run here rather than in patch_upstream.py because it rewrites automake
# variable names, which the anchored-transformation model is deliberately not
# built for -- it renames identifiers across a file rather than replacing a
# known string at a known anchor.
log "     renaming binaries to wamd / wam-cli / wam-tx / wam-util / wam-wallet"
"$PY" "$REPO_ROOT/scripts/rename_binaries.py" --tree "$CORE_DIR"

# Verify rather than assume. --check re-reads the tree and fails if any
# upstream name survived, so a partial rename cannot pass silently.
"$PY" "$REPO_ROOT/scripts/rename_binaries.py" --tree "$CORE_DIR" --check

# ---------------------------------------------------------------------------
# The GUI's own words, for EVERY tree and not only the one build_qt.sh makes.
#
# rebrand_qt.py was called from build_qt.sh alone, which is the Linux path. So
# the Windows cross-build produced a wallet whose first window told the
# founder, on 2026-09-26, that it would download "the full Bitcoin block chain
# (4 GB) starting with the earliest transactions in 2009". The Linux wallet
# said WAM in the same place, from the same commit, because a different script
# happened to run one more step.
#
# The tree is the WAM tree from the moment it is patched. Its GUI text belongs
# to that, not to whichever build script comes next, so it runs here -- once,
# for all three platforms. build_qt.sh still calls it and that is harmless:
# the script is idempotent by design and says "already rebranded".
"$PY" "$REPO_ROOT/scripts/rebrand_qt.py" --tree "$CORE_DIR" | sed 's/^/  /'

cat > "$CORE_DIR/.wam-patched" <<EOF
upstream_repo=$UPSTREAM_REPO
upstream_tag=$UPSTREAM_TAG
upstream_commit=$UPSTREAM_COMMIT
randomx_tag=$RANDOMX_TAG
patched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

# ===========================================================================
log "4/4  Checking the treasury address"
# ===========================================================================

# This said "founder address" and told you to run gen_founder_key.py and
# re-mine the genesis block. Both were true once and neither is now: the
# founder ceremony happened, the mainnet founder address is real, and the
# mainnet genesis is mined. Following those instructions today would discard
# all three. What is still a placeholder is the *treasury*, which the two were
# separated into so that treasury spending could be told from founder
# spending -- and the warning was never updated to notice.
if grep -q "WNg2svm2qApxheBKndKGQ9sRwporvRgRpT" \
        "$CORE_DIR/src/kernel/chainparams.cpp"; then
    warn "The mainnet TREASURY address is still the burn placeholder"
    warn "(hash160 = 20 zero bytes). Every 5% fee this chain collects would be"
    warn "destroyed -- 750,000 WAM across 400,000 blocks."
    warn ""
    warn "  Before a mainnet binary is usable:"
    warn "    1. "$PY" scripts/gen_founder_key.py --network mainnet   (OFFLINE,"
    warn "       and a DIFFERENT key from the founder's)"
    warn "    2. paste it over WAM_TREASURY_ADDRESS_MAINNET in src/wam/chainparams.cpp"
    warn "    3. re-run this script"
    warn ""
    warn "  The genesis block is NOT re-mined for this. Genesis outputs pay the"
    warn "  founder address, and the treasury rule starts at height 1, so the"
    warn "  genesis hash does not depend on it."
    warn ""
    warn "  It must happen before the first mainnet block and not after: the"
    warn "  rule is consensus, so changing it later invalidates every block"
    warn "  already mined under the old address."
    warn ""
    warn "  Testnet and regtest builds are unaffected."
fi

#pwd
cd ../contrib/wam-miner-android

# Ensure the destination folder structure exists first
mkdir -p "app/src/main/cpp/randomx/lib/arm64-v8a"

# Copy the file using Linux forward slashes
cp "$RANDOMX_DIR/build/librandomx.so" "app/src/main/cpp/randomx/lib/arm64-v8a/"

#echo "gvsdebug ${ANDROID_HOME}"
#gradle assembleDebug

log "done"
log ""
log "  librandomx  copied to : $(pwd)/app/src/main/cpp/randomx/lib/arm64-v8a/"
log ""
log "  Next: Fire up Android Studio and build the apk"
