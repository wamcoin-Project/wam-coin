# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 cpp_text.py -- read C++ as code, not as prose that happens to contain code
===============================================================================

 WHY THIS EXISTS

 Four gates in scripts/ match patterns against src/wam/chainparams.cpp and
 the upstream headers. Three of them strip comments first, each with its own
 regex written at a different time. The fourth,
 scripts/check_consensus_params.py, did not -- and it is the regression gate
 for a PAID bug class (WAM-F6, a consensus scalar with no default and no
 assignment, read in three consensus paths).

 So this counted as assigning the field:

     // consensus.enforce_BIP94 = false;

 A commented-out line satisfied the one automated check that exists to stop
 that class recurring, and the gate printed its green banner.

 Reported by Fahrizal, 18 November 2026, with a fixture tree that copies the
 real gate in and runs it as CI does.

 This file is the one implementation. A gate that matches C++ text calls
 these; it does not write a fifth regex.

 chainparams.cpp is FULL of prose quoting values, deliberately -- it is how
 this project explains its own consensus. Every one of those sentences is a
 mention and not one of them is a use. That is the same distinction
 scripts/lib/quoted.py draws for quotation marks, and strip_quoted() does
 not draw it for comments: it blanks wam:quote-marked lines and nothing
 else, which is why check_mentions.py was satisfied with a gate that had
 this hole in it.
===============================================================================
"""

from __future__ import annotations

import re

__all__ = ["strip_comments", "strip_literals", "class_body"]


def strip_comments(text: str, keep: str | None = None) -> str:
    """Blank // and /* */ comments, keeping line numbers intact.

    Replaced with spaces and newlines rather than removed, so a line number
    computed afterwards still points at the same line of the file. A gate
    that reports "FAIL at line 412" and means line 388 sends somebody to the
    wrong place at the worst possible moment.

    `keep` is a regex for block comments that are DATA rather than prose.
    consensus_floor.py has one: /*nNonce=...*/ records the value it sits
    beside, and blanking it would lose the thing being checked.
    """
    def blank(m: re.Match) -> str:
        if keep and re.search(keep, m.group(0)):
            return m.group(0)
        # Keep the newlines; blank everything else.
        return re.sub(r"[^\n]", " ", m.group(0))

    text = re.sub(r"/\*.*?\*/", blank, text, flags=re.S)
    text = re.sub(r"//[^\n]*", blank, text)
    return text


def strip_literals(text: str) -> str:
    """Blank the contents of "..." and '...' , keeping the quotes.

    For STRUCTURAL passes only -- brace matching, mostly. A seed host or a
    message string containing a brace would otherwise make a class body end
    in the wrong place, and the whole point of reading the body is to know
    which network a line belongs to.

    Escapes are honoured, so "a \\" b" is one literal and not two.
    """
    out = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in '"\'':
            quote = c
            out.append(c)
            i += 1
            while i < n:
                if text[i] == "\\" and i + 1 < n:
                    out.append("  " if text[i + 1] != "\n" else " \n")
                    i += 2
                    continue
                if text[i] == quote:
                    out.append(quote)
                    i += 1
                    break
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def class_body(text: str, header_end: int) -> str:
    """The text between a class's own braces, and not a character more.

    `header_end` is where the class header match ended.

    WHY NOT "UP TO THE NEXT CLASS".

    That is what check_consensus_params.py did, and the last network in the
    file therefore owned everything after it to end-of-file. A free function
    written below the last class -- a test helper, a reset, anything that
    names a consensus field -- was credited to that network as if its
    constructor had run the line. The last class in chainparams.cpp is the
    regtest one, which is also the one whose assignments are easiest to drop.

    Returns the whole remainder if the braces do not balance, which is the
    old behaviour and the safe direction: a gate that silently reads LESS
    text finds fewer assignments and fails an honest tree.
    """
    open_at = text.find("{", header_end)
    if open_at < 0:
        return text[header_end:]
    depth = 0
    for i in range(open_at, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[open_at + 1:i]
    return text[open_at + 1:]
