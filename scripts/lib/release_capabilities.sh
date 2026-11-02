# shellcheck shell=bash
# ===========================================================================
#  lib/release_capabilities.sh -- what a node must be able to do, in ONE place
# ===========================================================================
#
#      . "$SCRIPTS_DIR/lib/release_capabilities.sh"
#      assert_release_capabilities linux "$BUILD_DIR/configure-linux.log"
#
#  Called by all three build scripts, right after configure. It reads the
#  config header configure just wrote and refuses to let the build continue
#  if a capability a release must carry was configured away.
#
#  WHY IT IS ONE FILE AND NOT THREE LINES IN THREE FILES
#
#  A release is Windows, Linux and macOS -- all three, every time, by
#  standing rule. So a capability is not a property of a build script; it is
#  a property of the RELEASE, and the release is only as good as its weakest
#  platform.
#
#  On 2026-10-29 ZMQ was turned on. `NO_ZMQ=1` and `--disable-zmq` came out
#  of all three scripts, and the line that fails the build when ZMQ is
#  missing went into build_linux.sh alone. That is a release able to ship a
#  node that speaks ZMQ on one platform and two that do not, silently, with
#  nothing anywhere saying so -- and the whole reason for the change was a
#  user on Windows or macOS running an indexer.
#
#  Copying the Linux line into the other two was the obvious repair and the
#  wrong one. Three copies of one rule is the fault this repository keeps
#  paying for: twelve scripts each with their own ssh (lib/remote.sh,
#  scripts/wamssh.py), and the pool's fee written in two files that said 0%
#  and 1% for weeks. A rule with three homes has three chances to drift and
#  no way to notice.
#
#  So the list below is the list. Adding a capability is one line here, and
#  it binds every platform the next time each is built.
#
#  WHAT THIS CHECKS, AND WHAT IT DOES NOT
#
#  Configure-time capabilities only -- what the node was COMPILED able to do,
#  read out of the header configure wrote. It cannot check the packaging of
#  the finished archive (whether the binaries carry their own libraries,
#  whether they are hardened): those are properties of the tarball, they are
#  platform-specific, and scripts/check_binary_hardening.sh and
#  scripts/check_release_matches.sh already ask them of the published files.
#  One job.
#
#  And it checks what configure INTENDED. Proof that the finished binary
#  does it belongs where a binary can be run, which for a cross-build is the
#  native runner in .github/workflows/platform-build.yml.
# ===========================================================================

# NAME|MACRO|why it has to be there.
#
# The "why" is printed when it is missing, because the person reading that
# failure forty minutes into a build is usually not the person who added the
# line, and "ENABLE_ZMQ is not defined" tells them nothing about whether to
# care.
RELEASE_CAPABILITIES=(
"ZMQ|ENABLE_ZMQ|Block notifications. An indexer learns that a block arrived by being told, not by polling, and Trezor's Blockbook will not run against a node that cannot tell it -- every bitcoin-type coin in Blockbook carries a message-queue port, checked against Litecoin, Dogecoin, Dash and Vertcoin. It was off in all three build scripts until 2026-10-29, inherited rather than chosen."
)

# assert_release_capabilities PLATFORM [CONFIGURE_LOG]
#   PLATFORM       linux | macos | windows -- named in the failure, because a
#                  release carries all three and the reader has to know which
#                  one is short.
#   CONFIGURE_LOG  optional; named in the failure so the next step is
#                  obvious rather than a search.
assert_release_capabilities() {
    local platform="$1" conflog="${2:-}"
    local header="$CORE_DIR/src/config/bitcoin-config.h"

    if [ ! -f "$header" ]; then
        die "no $header after configure, so nothing could be checked about
          what this $platform node can do. That is not a pass: a release
          carries Windows, Linux and macOS, and an unchecked platform is an
          unknown one."
    fi

    local missing=() entry name rest macro why
    for entry in "${RELEASE_CAPABILITIES[@]}"; do
        name="${entry%%|*}"
        rest="${entry#*|}"
        macro="${rest%%|*}"
        why="${rest##*|}"
        if ! grep -q "^#define $macro" "$header"; then
            missing+=("$name ($macro) -- $why")
        fi
    done

    # Every missing one at once. Dying on the first means finding the second
    # after another forty minutes of compiling, and that is how a second gets
    # quietly dropped instead of fixed.
    if [ "${#missing[@]}" -ne 0 ]; then
        local lines="" m
        for m in "${missing[@]}"; do
            lines="$lines
            * $m"
        done
        die "configure produced a $platform node missing ${#missing[@]} capability
          this project's releases must carry. Nothing is kept.$lines

          Check that nothing passed --disable-* for it and that depends was
          not given the matching NO_* variable:${conflog:+
          grep -niE 'zmq|disable' $conflog}
          The list is scripts/lib/release_capabilities.sh, and it binds all
          three platforms."
    fi

    ok "$platform node carries: $(printf '%s ' "${RELEASE_CAPABILITIES[@]%%|*}")"
}
