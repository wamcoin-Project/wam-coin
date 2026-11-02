# shellcheck shell=bash
# ===========================================================================
#  lib/shared_deps.sh -- what counts as "the base system", and carrying the rest
# ===========================================================================
#
#      . "$SCRIPTS_DIR/lib/shared_deps.sh"
#      carry_libs out/stage/wam-qt-v0.1.13/bin/wam-qt \
#                 build/wam-core/depends/x86_64-pc-linux-gnu/lib \
#                 out/stage/wam-qt-v0.1.13/lib
#
#  ONE DEFINITION OF "BASE SYSTEM", USED BY THE BUILD AND BY THE CHECK
#
#  check_shared_deps.sh kept this list privately and decided, alone, what a
#  stranger's machine may be assumed to have. The packaging step had no
#  opinion at all -- it copied binaries and hoped. So the rule that decides
#  whether a release is shippable lived in the thing that judges the release
#  and not in the thing that builds it, and the two could never disagree out
#  loud because only one of them had the rule.
#
#  WHY wam-qt NEEDED THIS AND wamd DID NOT
#
#  depends builds boost, libevent and sqlite as static archives, so the node
#  swallows them whole and asks a stranger for nothing beyond glibc. The X11
#  stack is different by upstream's own choice: depends/packages/libxcb.mk
#  carries --disable-static, so libxcb, libxkbcommon, fontconfig, freetype
#  and their friends are built as SHARED objects. wam-qt links them
#  correctly, from depends, and then the archive ships without them -- so the
#  binary looks for seventeen .so files on a machine that was never given
#  them.
#
#  That is what the 2026-10-29 release build found, at the last gate, after
#  twenty-eight minutes:
#
#      FAIL  wam-qt  asks for: libfontconfig.so.1 libfreetype.so.6
#                    libxcb-icccm.so.4 ... libxkbcommon.so.0   (17 in all)
#
#  The easy answer was to add them to the allowed list, on the grounds that
#  any machine with a desktop has them. That is probably even true. It is
#  also an exception, and an exception is a hole: the next library to appear
#  in that list arrives without anybody deciding, exactly as --disable-zmq
#  and NO_ZMQ=1 did.
#
#  So they are CARRIED. The archive holds them, wam-qt finds them beside
#  itself, and the rule "ask a stranger for nothing but glibc" stays whole
#  with no names written into it.
#
#  TRANSITIVELY, BECAUSE THEY NEED EACH OTHER
#
#  libxcb-image needs libxcb-shm and libxcb; fontconfig needs freetype and
#  expat; libxkbcommon-x11 needs libxkbcommon and libxcb. Copying only what
#  the binary names directly produces an archive that fails one level down,
#  which is the same failure arriving later and harder to read.
# ===========================================================================

# Present wherever a C++ program runs at all. The glibc floor these imply is a
# separate question, asked by package_release.sh.
#
# Deliberately short. Everything else -- the chain libraries, the database,
# the toolkit, the X11 client stack -- is ours to carry, because the user did
# not ask for our dependencies and cannot be expected to guess their package
# names.
SHARED_DEPS_BASE='^(libc|libm|libdl|librt|libpthread)\.so\.[0-9]+$|^libstdc\+\+\.so\.6$|^libgcc_s\.so\.1$|^ld-linux-.*\.so\.[0-9]+$'

# needed_sonames FILE -- the DT_NEEDED entries of an ELF file, one per line.
needed_sonames() {
    readelf -d "$1" 2>/dev/null \
        | sed -n 's/.*Shared library: \[\(.*\)\].*/\1/p' | sort -u
}

# carry_libs BINARY SEARCH_DIR DEST_DIR
#   Copies every non-base shared library the binary needs -- and everything
#   those need in turn -- out of SEARCH_DIR into DEST_DIR, then points the
#   binary at them with an RPATH relative to itself. Returns non-zero if a
#   library could not be found, because a partial carry is the same failure
#   discovered later.
#
#   $ORIGIN is the directory of the file being loaded, resolved at run time by
#   the loader, so it works wherever the archive is unpacked and whatever the
#   user's LD_LIBRARY_PATH says.
#
#   TWO PATHS, BECAUSE THE BINARY IS CHECKED IN TWO PLACES.
#
#   build_linux.sh gates the freshly built binary where it lies, in
#   src/qt/wam-qt, so the libraries go in src/qt/lib -- $ORIGIN/lib.
#   package_release.sh stages it as bin/wam-qt with the libraries at lib/ --
#   $ORIGIN/../lib. Carrying them at packaging alone was the first attempt and
#   it failed on 2026-10-29: the gate inside build_linux.sh runs before
#   packaging exists, judged the bare binary, and killed the build at minute
#   twenty-eight for asking after libraries that the next step would have
#   given it. One RPATH naming both layouts is true in both, and neither step
#   has to know what the other did.
carry_libs() {
    local binary="$1" search="$2" dest="$3"
    local missing=0 queue=() seen=" " soname src

    command -v readelf >/dev/null 2>&1 || {
        printf 'carry_libs: readelf is not installed\n' >&2; return 2; }
    command -v patchelf >/dev/null 2>&1 || {
        printf 'carry_libs: patchelf is not installed (apt install patchelf)\n' >&2
        return 2; }
    [ -f "$binary" ] || { printf 'carry_libs: no %s\n' "$binary" >&2; return 2; }
    [ -d "$search" ] || { printf 'carry_libs: no %s\n' "$search" >&2; return 2; }

    mkdir -p "$dest"

    while IFS= read -r soname; do
        [ -n "$soname" ] && queue+=("$soname")
    done < <(needed_sonames "$binary")

    while [ "${#queue[@]}" -gt 0 ]; do
        soname="${queue[0]}"
        queue=("${queue[@]:1}")

        case "$seen" in *" $soname "*) continue ;; esac
        seen="$seen$soname "

        printf '%s' "$soname" | grep -qE "$SHARED_DEPS_BASE" && continue

        # -L on find so a symlinked soname copies the file it points at, under
        # the name the loader will ask for.
        src="$(find -L "$search" -maxdepth 2 -name "$soname" -type f 2>/dev/null | head -1)"
        if [ -z "$src" ]; then
            printf 'carry_libs: %s is needed and is not in %s\n' "$soname" "$search" >&2
            missing=$((missing + 1))
            continue
        fi

        cp -f "$src" "$dest/$soname"
        chmod u+w "$dest/$soname"
        patchelf --set-rpath '$ORIGIN' "$dest/$soname" 2>/dev/null || true

        while IFS= read -r dep; do
            [ -n "$dep" ] && queue+=("$dep")
        done < <(needed_sonames "$dest/$soname")
    done

    patchelf --set-rpath '$ORIGIN/lib:$ORIGIN/../lib' "$binary" || return 1
    [ "$missing" -eq 0 ]
}
