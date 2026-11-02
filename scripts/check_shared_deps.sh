#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_shared_deps.sh -- what a shipped binary demands from a stranger's
#                          machine, read out of the file
# ===========================================================================
#
#      bash scripts/check_shared_deps.sh [binary|tarball|directory ...]
#
#  WHY THIS EXISTS
#
#  On 2026-10-18, one day after v0.1.12 was published, Jeeves downloaded the
#  Linux node onto an Ubuntu 26 image and it would not start:
#
#      ./wamd: error while loading shared libraries: libevent-2.1.so.7:
#      cannot open shared object file: No such file or directory
#
#  It reproduces on a clean Ubuntu 24.04 with nothing installed, character
#  for character. Every Linux release this project has published asks the
#  user's machine for libraries it does not carry:
#
#      wamd      libevent-2.1.so.7  libevent_pthreads-2.1.so.7  libsqlite3.so.0
#      wam-cli   libevent-2.1.so.7
#      wam-wallet                                               libsqlite3.so.0
#      wam-qt    all of the above, plus five Qt5 libraries and libqrencode
#
#  Debian and Ubuntu split libevent into four packages, and a stock image
#  installs libevent_core alone. So the aggregate libevent-2.1.so.7 that
#  these binaries ask for is absent on an ordinary desktop, and the node
#  fails with a loader error naming a file -- the least helpful failure a
#  program can have, and the first thing a new miner sees.
#
#  WHY NOTHING CAUGHT IT
#
#  package_release.sh HAS a portability gate, it runs over every shipped
#  binary, and it passed. It reads `objdump -T` for GLIBC_ and GLIBCXX_
#  symbol versions and compares them to a baseline -- which is a real check
#  of a different question. DT_NEEDED is not a symbol version, so no amount
#  of running that gate could ever have seen libevent.
#
#  Above it stood this sentence, in the same file:
#
#      "The node and the miner are self-contained: the portability gate
#       below holds them to a bare glibc and that is the whole of their
#       requirement."
#
#  The gate never tested that. A check that answers one question beside a
#  comment that claims a stronger one is worse than no check, because the
#  comment is what people read. The same shape as the executable stack in
#  v0.1.11: this project reads its documents, its claims, its seeds and its
#  tests, and had never read the files people download.
#
#  WHAT IS ALLOWED, AND WHY EACH ONE
#
#  libc, libm, libstdc++, libgcc_s and the loader are present on every Linux
#  system that can run a C++ program at all; their floor is the glibc
#  version, which package_release.sh already checks. Everything else -- the
#  chain libraries, the database, the toolkit -- is ours to carry, because
#  the user did not ask for our dependencies and cannot be expected to guess
#  their package names.
#
#  wam-qt is the one exception and it is a WARNING, never silence. The
#  wallet links the system Qt 5, its README says so and names the packages,
#  and that was a decision rather than an accident. It is still printed on
#  every run so that it stays a decision somebody can revisit, and it
#  disappears by itself the day Qt comes out of depends like everything
#  else. Anything wam-qt asks for beyond Qt and libqrencode fails like the
#  rest.
#
#  EXIT CODES, this project's convention
#
#      0  every shipped binary carries what it needs
#      1  one asks a stranger's machine for something we should have carried
#      2  there was nothing to read, or no readelf -- so nothing was checked
# ===========================================================================

set -u

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d 2>/dev/null || echo /tmp/wam-shared-deps-$$)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0; WARN=0

command -v readelf >/dev/null 2>&1 || {
    printf '\n  %sreadelf is not installed, so nothing was read -- this is not a pass%s\n\n' "$YLW" "$OFF"
    exit 2
}

# The list lives in lib/shared_deps.sh now, with the code that CARRIES
# everything outside it. It was defined here alone, so the thing that judges a
# release held the rule and the thing that builds one had no opinion at all --
# and the two could never disagree out loud, because only one of them knew.
. "$ROOT/scripts/lib/shared_deps.sh"
BASE_ALLOWED="$SHARED_DEPS_BASE"

# ASK THE QUESTION THE LOADER ASKS, NOT A QUESTION THAT RESEMBLES IT.
#
# The first version of "does the archive carry this?" searched the binary's
# own directory. That is nearly right and fails on the one layout we ship:
# wam-qt sits in bin/ and its seventeen libraries in lib/ beside it, so a
# search rooted at bin/ finds none of them and the packaging step failed a
# wallet that was correctly built -- on 2026-10-29, at the very last gate,
# for the third time that afternoon.
#
# The honest question is whether the dynamic loader will find the file, and
# the loader looks in RUNPATH/RPATH with $ORIGIN resolved to the directory
# of the binary being loaded. So this reads that, exactly as ld.so does,
# rather than guessing at a layout. A binary with no RPATH gets no answers
# from it and falls through to the tree scan below, which is right for a
# loose file with no archive around it.
loader_finds() {
    local f="$1" lib="$2" origin d
    origin="$(cd "$(dirname "$f")" 2>/dev/null && pwd)" || return 1
    while IFS= read -r d; do
        [ -n "$d" ] || continue
        d="${d//\$\{ORIGIN\}/$origin}"
        d="${d//\$ORIGIN/$origin}"
        [ -e "$d/$lib" ] && return 0
    done < <(readelf -d "$f" 2>/dev/null \
             | sed -n 's/.*R\(UN\)\?PATH.*\[\(.*\)\].*/\2/p' | tr ':' '\n')
    return 1
}

# Only for wam-qt, only as a warning, and only these. See the header.
#
# This exists for a state that should no longer occur: Qt now comes out of
# depends, so a wam-qt that names libQt5 was built against the system toolkit
# by accident. The warning stays until a release has shipped without it.
QT_ALLOWED='^libQt5[A-Za-z]+\.so\.[0-9]+$|^libqrencode\.so\.[0-9]+$'

# ---------------------------------------------------------------------------
# What to read. Arguments win; otherwise every Linux artefact of the newest
# release this machine holds -- the files strangers actually download.
# ---------------------------------------------------------------------------
TARGETS=()
if [ "$#" -gt 0 ]; then
    TARGETS=("$@")
else
    for d in /var/www/wam-downloads "$ROOT/dist" "$ROOT/release" "$ROOT/out/release"; do
        [ -d "$d" ] || continue
        newest="$(find "$d" -name '*x86_64-linux-gnu.tar.gz' -printf '%T@ %h\n' \
                  2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
        [ -n "$newest" ] || continue
        while IFS= read -r t; do
            [ -n "$t" ] && TARGETS+=("$t")
        done < <(find "$newest" -maxdepth 1 -name '*x86_64-linux-gnu.tar.gz' \
                 2>/dev/null | sort)
    done
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
    printf '\n  %sno published Linux tarball and no path given, so nothing was\n' "$YLW"
    printf '  read -- this is not a pass. Point it at one:%s\n' "$OFF"
    printf '      bash scripts/check_shared_deps.sh path/to/release.tar.gz\n\n'
    exit 2
fi

# ---------------------------------------------------------------------------
# Expand each target into a list of files.
# ---------------------------------------------------------------------------
FILES=()
# Which unpacked tree each file came out of, so the loop below can ask whether
# a library it names travels in the same archive.
declare -A TREE_OF
for t in "${TARGETS[@]}"; do
    if [ -d "$t" ]; then
        while IFS= read -r f; do FILES+=("$f"); TREE_OF["$f"]="$t"; done \
            < <(find "$t" -type f -perm -u+x 2>/dev/null | sort)
    elif [[ "$t" == *.tar.gz || "$t" == *.tgz ]]; then
        sub="$WORK/$(basename "$t" .tar.gz)"
        mkdir -p "$sub"
        tar xzf "$t" -C "$sub" 2>/dev/null || {
            printf '  %sFAIL%s  %s could not be unpacked\n' "$RED" "$OFF" "$t"
            FAIL=$((FAIL+1)); continue; }
        while IFS= read -r f; do FILES+=("$f"); TREE_OF["$f"]="$sub"; done \
            < <(find "$sub" -type f -perm -u+x 2>/dev/null | sort)
    elif [ -f "$t" ]; then
        FILES+=("$t")
        TREE_OF["$t"]="$(dirname "$t")"
    else
        printf '  %sFAIL%s  %s is not here\n' "$RED" "$OFF" "$t"
        FAIL=$((FAIL+1))
    fi
done

printf '\n%swhat the published binaries demand from a stranger'"'"'s machine%s\n\n' "$BLD" "$OFF"

for f in "${FILES[@]}"; do
    # A tarball holds READMEs and licences as well. Only ELF is readable here,
    # and a file that is not ELF is skipped rather than counted as passing.
    head -c 4 "$f" 2>/dev/null | grep -q $'\x7fELF' || continue

    name="$(basename "$f")"
    needed="$(readelf -d "$f" 2>/dev/null \
              | sed -n 's/.*Shared library: \[\(.*\)\].*/\1/p' | sort -u)"

    # A LIBRARY WE SHIP IS NOT ONE A STRANGER IS ASKED FOR.
    #
    # This file's own title is "what a shipped binary demands from a
    # STRANGER'S machine", and it was answering a narrower question: what the
    # binary names at all. The two are the same only while the archive carries
    # nothing but executables.
    #
    # They stopped being the same on 2026-10-29. depends builds the X11 stack
    # shared, by upstream's own --disable-static, so wam-qt names seventeen
    # .so files it links correctly from depends. Carrying them in the archive
    # and pointing the binary at them with an RPATH is the fix -- and this
    # check would still have failed the result, because it never looked in the
    # tarball it had just unpacked.
    #
    # So: anything the archive holds beside the binary is carried. Anything it
    # does not hold, and that is not the base system, is still a failure. No
    # library is allowed by name; the rule has no list to grow.
    sibling_root="${TREE_OF[$f]:-$(dirname "$f")}"
    carried=""; extra=""; toolkit=""
    while IFS= read -r lib; do
        [ -n "$lib" ] || continue
        if printf '%s' "$lib" | grep -qE "$BASE_ALLOWED"; then
            carried="$carried $lib"
        elif loader_finds "$f" "$lib"; then
            carried="$carried $lib"
        elif [ -n "$(find -L "$sibling_root" -name "$lib" -type f 2>/dev/null | head -1)" ]; then
            carried="$carried $lib"
        elif [ "$name" = "wam-qt" ] && printf '%s' "$lib" | grep -qE "$QT_ALLOWED"; then
            toolkit="$toolkit $lib"
        else
            extra="$extra $lib"
        fi
    done <<< "$needed"

    if [ -n "$extra" ]; then
        printf '  %sFAIL%s  %-12s asks for:%s\n' "$RED" "$OFF" "$name" "$extra"
        # Say the toolkit out loud even here. Reporting only the worse fault
        # hides the decision underneath it, and the two are fixed together.
        [ -n "$toolkit" ] && \
            printf '        %s            and the system Qt:%s\n' "$YLW$OFF" "$toolkit"
        FAIL=$((FAIL+1))
    elif [ -n "$toolkit" ]; then
        printf '  %swarn%s  %-12s links the system Qt:%s\n' "$YLW" "$OFF" "$name" "$toolkit"
        WARN=$((WARN+1))
    else
        printf '  %sok%s    %-12s carries everything but the base system\n' "$GRN" "$OFF" "$name"
        PASS=$((PASS+1))
    fi
done

echo
if [ "$((PASS + FAIL + WARN))" -eq 0 ]; then
    printf '  %sno ELF binary was found in what was given, so nothing was\n' "$YLW"
    printf '  checked -- this is not a pass%s\n\n' "$OFF"
    exit 2
fi

if [ "$FAIL" -gt 0 ]; then
    printf '  %s%s%d binary/binaries ask a stranger'"'"'s machine for a library we\n' "$RED" "$BLD" "$FAIL"
    printf '  did not carry%s\n\n' "$OFF"
    printf '  A user who does not have it gets a loader error naming a file and\n'
    printf '  no way to know which package holds it. Build through depends so\n'
    printf '  the binary carries it -- scripts/build_linux.sh does this, the\n'
    printf '  Windows and macOS builds already did.\n\n'
    exit 1
fi

printf '  %s%s%d binary/binaries need nothing but the base system' "$GRN" "$BLD" "$PASS"
[ "$WARN" -gt 0 ] && printf ', %d links the system Qt by decision' "$WARN"
printf '%s\n\n' "$OFF"
exit 0
