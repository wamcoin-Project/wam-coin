# shellcheck shell=bash
# ===========================================================================
#  lib/remote.sh -- one way for a shell check to ask a server a question
# ===========================================================================
#
#      . "$SCRIPTS_DIR/lib/remote.sh"
#
#      remote_ask "$host" "$script"
#      if [ "$REMOTE_RC" = "$REMOTE_UNREACHABLE" ]; then
#          unknown "$host -- could not be asked"   # NOT a finding
#      fi
#      echo "$REMOTE_OUT"
#
#  IT RETURNS THROUGH A VARIABLE, NOT THROUGH STDOUT, AND THAT IS THE POINT
#
#  The obvious shape is `out="$(remote_ask ...)"`, and it is wrong here. A
#  command substitution runs in a SUBSHELL, so everything the function learns
#  about WHY it failed -- the difference between 255, 124 and a status the
#  node actually returned -- is set in a child process and thrown away when
#  it exits. The caller then sees an empty string and has to guess, which is
#  exactly the guess this file exists to remove. Written the obvious way
#  first; `set -u` caught it immediately with "REMOTE_RC: unbound variable",
#  which is the good outcome -- silently reading a stale status from the
#  previous host is the bad one.
#
#  WHY THIS EXISTS
#
#  scripts/wamssh.py is this, for Python, and its header lists the four
#  separate fixes that three scripts needed before they agreed to share one.
#  The shell checks never had an equivalent, so each grew its own `rsh()`,
#  and none of them learned what wamssh knows:
#
#    * ssh exits 255 for its OWN failures and never for a status the far end
#      returned, so a host that is down is otherwise indistinguishable from a
#      host that answered "no". A monitor that cannot tell those apart prints
#      a red line about a machine it never reached.
#
#    * `timeout` exits 124, which is not an answer either.
#
#    * one lost packet should cost a retry, not a verdict.
#
#  "I could not ask" and "the answer is no" are different, and a panel that
#  confuses them is worse than no panel: a false red teaches a person to stop
#  reading red, and the true one then arrives inside noise nobody looks at.
#
#  AND IT EXISTS TO CUT HANDSHAKES, WHICH IS THE OTHER HALF
#
#  On the founder's link an ssh handshake is five to fifteen seconds before
#  any work starts. check_nodes_agree.sh opened six connections per host,
#  check_deployed_code.sh four -- so on three machines the panel spent most
#  of its budget saying hello, and the lines that went grey with "did not
#  finish" had nothing wrong with them except arithmetic.
#
#  ControlMaster is the usual answer and is not available here: the founder's
#  OpenSSH_10.2p1 under Git Bash refuses with "Failed to connect to new
#  control master", every time. So the remedy is fewer questions, not a
#  cheaper second question. A check that needs five things from one host asks
#  for five things once, in one script, and parses the keyed reply.
#
#  THE SCRIPT GOES IN ON STDIN, AS wamssh DOES
#
#  Not as an argument: a single argv element is capped at 128 KiB, which
#  check_reorg.py walked into as the chain grew. And \r is stripped on the
#  way in, because a checkout on Windows can give this very file CRLF line
#  endings, and the remote bash reads those as $'\r' and dies on them.
# ===========================================================================

# Distinct from any exit status a remote command can return.
REMOTE_UNREACHABLE=-1

# Overridable per call site: a check that reads a git log needs longer than
# one that reads a block height.
: "${REMOTE_TIMEOUT:=45}"
: "${REMOTE_TRIES:=2}"
: "${REMOTE_GAP:=3}"

# Declared here so `set -u` has something to read before the first call, and
# so a caller that forgets to check cannot pick up the previous host's
# status by accident.
REMOTE_OUT=""
REMOTE_RC=0

# remote_ask HOST SCRIPT
#   Sets REMOTE_OUT to the remote stdout (carriage returns stripped) and
#   REMOTE_RC to the remote command's own exit status -- or to
#   $REMOTE_UNREACHABLE when the question could not be put at all. Never
#   fails: the caller decides what an unreachable host means, and for every
#   monitor in this repository it means "unknown", not "broken".
remote_ask() {
    local host="$1" script="$2" rc attempt
    REMOTE_OUT=""
    REMOTE_RC="$REMOTE_UNREACHABLE"
    for (( attempt = 1; attempt <= REMOTE_TRIES; attempt++ )); do
        REMOTE_OUT="$(printf '%s' "$script" | tr -d '\r' | \
               timeout "$REMOTE_TIMEOUT" \
               ssh -o BatchMode=yes \
                   -o ConnectTimeout=15 \
                   -o StrictHostKeyChecking=accept-new \
                   -o ServerAliveInterval=15 \
                   -o ServerAliveCountMax=3 \
                   "root@$host" "bash -s" 2>/dev/null)"
        # $? is the LAST element of the pipeline, so ssh has to be last. It
        # was briefly `... | ssh ... | tr -d '\r'`, and that reads tr's status
        # instead -- which is always 0, so an unreachable host came back as a
        # successful empty answer and the 255 this file is built around was
        # never seen. The carriage returns are taken off below, where they
        # cost nothing and hide nothing.
        rc=$?
        # 255 is ssh's own; 124 is timeout's own. Anything else came from the
        # far end and is an answer, even when it is a bad one.
        if [ "$rc" -ne 255 ] && [ "$rc" -ne 124 ]; then
            REMOTE_RC="$rc"
            REMOTE_OUT="${REMOTE_OUT//$'\r'/}"
            return 0
        fi
        if [ "$attempt" -lt "$REMOTE_TRIES" ]; then sleep "$REMOTE_GAP"; fi
    done
    REMOTE_OUT=""
    REMOTE_RC="$REMOTE_UNREACHABLE"
    return 0
}

# remote_field KEY TEXT
#   Pull the values of one key out of a keyed reply. A single round trip
#   brings back several answers at once, so they arrive as
#
#       HEIGHT 30340
#       GENESIS d8d3de...
#       BIN wamd a1b2c3d4e5f60718
#
#   and each caller takes the lines it wants. Keyed rather than positional:
#   a reply that loses a line should cost the field it lost, not shift every
#   field after it by one and report a disagreement that is not there.
remote_field() {
    printf '%s\n' "$2" | sed -n "s/^$1 //p"
}
