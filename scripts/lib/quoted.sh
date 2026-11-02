# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  quoted.sh -- the shell twin of scripts/lib/quoted.py
# ===========================================================================
#
#      . "$SCRIPTS_DIR/lib/quoted.sh"
#      unquoted path/to/file | grep -n 'TODO'
#
#  Same marks, same meaning, one convention: text that mentions a thing is not
#  the thing. The reasoning is in quoted.py; it is not repeated here, because
#  two copies of a reason drift exactly the way two copies of a file list did.
#
#  `unquoted` prints the file with every quoted line blanked and the line
#  COUNT preserved, so `grep -n` still reports the real line number.
# ===========================================================================

# shellcheck disable=SC2148

# A REGION MARK IS THE WHOLE LINE. A LINE MARK IS NOT.
#
# These three patterns matched the words ANYWHERE on a line until 2026-11-01,
# while quoted.py anchored the two region marks to the whole line on 8 October
# -- so for three weeks the twins enforced different rules under a header
# saying "same marks, same meaning, one convention". Any shell check reading a
# file that NAMES the mark in a sentence went blind from that sentence to the
# end of the file: quoted.py's own header, check_mentions.py, test_quoted.py,
# posts/README.md and this file all name it.
#
# That is the identical fault quoted.py was fixed for, reached by the identical
# route: a check that cannot tell use from mention could not tell them apart in
# its own marks. The reason is in quoted.py and is not repeated; the RULE is
# repeated here because awk cannot import it, and scripts/test/test_quoted.py
# now runs both over the same text and fails if they disagree.
#
# \W in Python is [^[:alnum:]_] in POSIX ERE -- exactly the comment syntax that
# may surround a mark: `<!-- wam:quote-begin -->`, `# wam:quote-begin`.
unquoted() {
    awk '
        /^[^[:alnum:]_]*wam:quote-begin[^[:alnum:]_]*$/ { inside = 1; print ""; next }
        /^[^[:alnum:]_]*wam:quote-end[^[:alnum:]_]*$/   { inside = 0; print ""; next }
        /wam:quote-line([^[:alnum:]_]|$)/               { print ""; next }
        inside                                          { print ""; next }
                                                        { print }
    ' "$@"
}

# For the many callers that want "does this file contain X, ignoring
# quotations" without building a pipeline each time.
#   grep_unquoted -E 'TODO|FIXME' file...
grep_unquoted() {
    local last="${!#}"
    local args=("${@:1:$#-1}")
    unquoted "$last" | grep "${args[@]}"
}
