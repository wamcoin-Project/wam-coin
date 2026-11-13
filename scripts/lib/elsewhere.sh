# shellcheck shell=bash
# ===========================================================================
#  lib/elsewhere.sh -- ask a machine that has the tool
# ===========================================================================
#
#      . "$SCRIPTS_DIR/lib/elsewhere.sh"
#      command -v dig >/dev/null 2>&1 || run_elsewhere "$0" "$@"
#
#  WHY THIS EXISTS
#
#  Two checks cannot run on the founder's Windows machine, which is the machine
#  the sweep is actually run from:
#
#      check_dns_seeds.sh    needs dig
#      check_isa_baseline.sh needs objdump
#
#  Both said so honestly and exited 3. Their callers then reported the
#  unmeasured thing as a finding -- "seeding could not be checked at all" in
#  red, and "the published binaries carry instructions many CPUs do not have"
#  about binaries that are, in fact, clean. Those callers are fixed. But a
#  check that is permanently "not run" on the only machine anyone runs it from
#  is a check the project does not have, and DNS seeding is the thing that
#  decides whether a stranger can find the network at all on launch day.
#
#  Installing Windows ports of dig and objdump is the obvious answer and the
#  worse one. It fixes one laptop, the Windows builds lag, and the whole class
#  of fault chased on 5 September was a tool that answered to the right name
#  and was not the right tool.
#
#  We already own two Linux machines that have both, that the sweep already
#  talks to, and whose SSH access is already required for half the checks
#  above this one. So the check goes to the tool rather than the tool coming
#  to the check.
#
#  IT RUNS THE REPOSITORY'S OWN COPY, NOT A SHIPPED SCRIPT
#
#  The first version piped the local script in over `bash -s`. That sends the
#  code and not the context, and check_dns_seeds.sh reads the seed names out
#  of src/wam/chainparams.cpp -- so it arrived with no working tree, parsed
#  nothing, and announced "no seed was checked". A check that reports a
#  failure because of how it was invoked is the same disease as the four fixed
#  the same afternoon, introduced while fixing them.
#
#  The hosts already hold the repository at /opt/wam, and deploy.sh keeps it
#  at origin/main. So the remote runs ITS OWN checkout, and the commit is
#  compared first: an answer from different source is an answer to a different
#  question, and it must say so rather than pass quietly.
#
#  A check that needs a local artifact -- a tarball unpacked in a temp
#  directory here -- still cannot be moved this way, and must not pretend to
#  be. check_isa_baseline.sh is that case; its caller re-fetches the published
#  release on the remote host instead, which asks the same question where the
#  answer lives.
# ===========================================================================

# Same defaults as scripts/deploy.sh. Override for a different pair:
#   WAM_TOOL_HOSTS="203.0.113.4" bash scripts/check_dns_seeds.sh
# All three. With only two named, a check that borrows a tool (dig, curl)
# had nowhere to go the moment those two were a commit behind -- which is
# exactly what happened to the DNS seed check on 18 September.
WAM_TOOL_HOSTS="${WAM_TOOL_HOSTS:-169.58.159.165 5.223.52.200 13.140.33.187}"
WAM_REMOTE_REPO="${WAM_REMOTE_REPO:-/opt/wam}"

# run_elsewhere <path relative to repo root> [args...]
#
# Runs that script from the host's own checkout and exits with its status.
# Never returns on success -- it redirects the whole run.
run_elsewhere() {
    local rel="$1"; shift

    # A remote run must never bounce onward. If the tool is missing THERE too,
    # the honest answer is exit 3, not another hop.
    [ "${WAM_ALREADY_REMOTE:-0}" = "1" ] && return 1

    local here h there
    here="$(git rev-parse HEAD 2>/dev/null)"

    for h in $WAM_TOOL_HOSTS; do
        there="$(timeout 60 ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o ConnectTimeout=12 "root@$h" \
                 "cd $WAM_REMOTE_REPO 2>/dev/null && git rev-parse HEAD" 2>/dev/null)"
        [ -n "$there" ] || continue

        if [ -n "$here" ] && [ "$here" != "$there" ]; then
            printf '  %s holds %s, this tree is %s -- not the same source, skipping\n' \
                "$h" "${there:0:7}" "${here:0:7}" >&2
            continue
        fi

        printf '  the tool is not here; running this check on %s (%s)\n' \
            "$h" "${there:0:7}" >&2
        timeout 300 ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o ConnectTimeout=25 "root@$h" \
            "cd $WAM_REMOTE_REPO && WAM_ALREADY_REMOTE=1 bash $rel $*"
        exit $?
    done

    printf '  no host with the tool, at this commit, could be reached (%s)\n' \
        "$WAM_TOOL_HOSTS" >&2
    return 1
}
