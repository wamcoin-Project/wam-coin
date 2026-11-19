#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_consensus_params.py -- no consensus field is left to chance
===============================================================================

     python3 scripts/check_consensus_params.py

 WHY THIS EXISTS

 WAM does not edit upstream's chainparams, it REPLACES the file:

     scripts/patch_upstream.py
         ("src/wam/chainparams.cpp", "src/kernel/chainparams.cpp")

 That is the right way to own the consensus of a fork and it has one failure
 mode that nothing else in this repository looks for: a field upstream
 assigns and our replacement does not. The declaration still exists, the code
 that reads it still exists, and nobody is told.

 It happened. `consensus.enforce_BIP94` was declared in Consensus::Params with
 no default initialiser, read in three consensus paths --

     src/validation.cpp:4280   ContextualCheckBlockHeader
     src/node/miner.cpp:39     the block assembler
     src/pow.cpp:75            GetNextWorkRequired

 -- and assigned by no network at all. The params object is heap-allocated,
 so the reads were indeterminate. It happened to be false on this build, and
 nothing in the code said so.

 Measured consequence: mining_basic.py test_timewarp failed on WAM's regtest
 on the exact assertion the BIP94 mitigation exists to satisfy.

 Reported by Alboy on 2026-10-11 as WAM-F6, with the fix: assign it per
 network, and give the field a default so the class cannot recur.

 This check is the "so the class cannot recur" half, and it needs no copy of
 upstream to do its job. The rule is self-contained:

     every field of Consensus::Params either carries a default initialiser,
     or is assigned by every network WAM defines.

 A field that satisfies neither is read before it is written. That is the
 defect, whatever the field is for, and it is the shape that makes two nodes
 disagree about which blocks are valid.

 EXIT CODES, this project's convention

     0  every field is either defaulted or assigned by every network
     1  a field is neither -- an indeterminate read in consensus code
     2  the files could not be read, so nothing was checked
===============================================================================
"""

from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
import cpp_text  # noqa: E402
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

PARAMS_H = "build/wam-core/src/consensus/params.h"
CHAINPARAMS = "src/wam/chainparams.cpp"

# A declaration inside `struct Params`. The default initialiser, when there is
# one, is the `{...}` or `= ...` before the semicolon.
# wam:quote-begin
DECL = re.compile(
    r"^\s*(?:static\s+)?(?:const\s+)?"
    r"(?P<type>(?:unsigned\s+)?[A-Za-z_][\w:<>,\s\*&]*?)\s+"
    r"(?P<name>[A-Za-z_]\w*)\s*(?P<init>\{[^;]*\}|=\s*[^;]+)?\s*;")
# wam:quote-end

# A CLASS TYPE INITIALISES ITSELF. A SCALAR DOES NOT.
#
# std::map, std::string, uint256 and arith_uint256 all have default
# constructors, so leaving one unassigned gives an empty map or a zero hash --
# defined, and in every case here the value upstream also starts from. Only
# the scalars are indeterminate, and only they are worth failing a build over.
#
# The first run of this check flagged `std::map<uint256, uint32_t>
# script_flag_exceptions`, which is not a defect: it default-constructs empty.
# Reporting it would have taught the reader that this check cries wolf.
# wam:quote-begin
SCALAR = re.compile(
    r"^(?:unsigned\s+|signed\s+|const\s+)*"
    r"(bool|char|short|int|long|float|double|size_t|"
    r"u?int(?:8|16|32|64)_t|CAmount|BIP9Deployment)\b\s*\**$")
# wam:quote-end

# Fields that are not simple values and are set through their own machinery.
# Each one is named rather than pattern-matched, so adding to this list is a
# visible decision and not an accident.
# wam:quote-begin
NOT_A_PLAIN_FIELD = {
    "vDeployments",        # an array, assigned element by element
    "hashGenesisBlock",    # set from the genesis block after it is built
    "defaultAssumeValid",  # assigned, but by type alias in some branches
    "BIP16Exception",
    "powLimit",
    "nMinimumChainWork",
    "signet_challenge",
}
# wam:quote-end


def fields_of_params_h(text):
    """[(name, has_default)] for the members of struct Params."""
    start = text.find("struct Params {")
    if start < 0:
        return None
    depth, i, body = 0, start, []
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                break
        body.append(text[i])
    out = []
    for line in "".join(body).splitlines():
        if "(" in line or line.strip().startswith(("//", "*", "/*")):
            continue       # a method, or a comment
        m = DECL.match(line)
        if not m:
            continue
        name = m.group("name")
        if name in ("struct", "Params"):
            continue
        out.append((name, bool(m.group("init")),
                    m.group("type").strip()))
    return out


def networks_of_chainparams(text):
    """{class name: the text of its own class body}.

    EACH NETWORK OWNS ITS BRACES AND NOTHING BEYOND THEM.

    This used to slice from one class header to the next, so the LAST class
    in the file owned everything after it to end-of-file. A free function
    written below it that named a consensus field was then credited to that
    network as though its constructor had run the line -- and the last class
    in chainparams.cpp is the regtest one.

    Literals are blanked before the braces are counted: a seed host or a
    message string containing a brace would otherwise end a class body in
    the wrong place. Blanking keeps the offsets, so the slice indices are
    still valid in the comment-stripped text.

    Reported by Fahrizal, 18 November 2026.
    """
    structural = cpp_text.strip_literals(text)
    out = {}
    for m in re.finditer(r"class\s+(C\w+Params)\s*:\s*public\s+CChainParams",
                         structural):
        out[m.group(1)] = cpp_text.class_body(structural, m.end())
    return out


def main() -> int:
    print(f"\n{BLD}no consensus field is read before it is written{OFF}\n")

    try:
        header = (ROOT / PARAMS_H).read_text(encoding="utf-8", errors="replace")
        # COMMENTS TOO, NOT JUST QUOTATION MARKS.
        #
        # strip_quoted() blanks wam:quote-marked lines and nothing else, so
        # this gate read `// consensus.enforce_BIP94 = false;` as assigning
        # the field. chainparams.cpp is full of prose quoting its own
        # values, deliberately, and every one of those is a mention rather
        # than a use -- the same distinction the quote marks draw, for a
        # different kind of text.
        #
        # The three sibling gates all stripped comments and this one did
        # not, which is why check_mentions.py was satisfied with it: it
        # asks whether a scanner honours the quote marks, and this one did.
        #
        # Reported by Fahrizal, 18 November 2026.
        cp = cpp_text.strip_comments(quoted.strip_quoted(
            (ROOT / CHAINPARAMS).read_text(encoding="utf-8", errors="replace")))
    except OSError as e:
        print(f"  {YEL}could not read the consensus sources ({e}) -- nothing "
              f"was checked{OFF}\n")
        return 2

    fields = fields_of_params_h(header)
    if not fields:
        print(f"  {YEL}struct Params could not be parsed -- nothing was "
              f"checked{OFF}\n")
        return 2

    nets = networks_of_chainparams(cp)
    if not nets:
        print(f"  {YEL}no network class was found in {CHAINPARAMS}{OFF}\n")
        return 2

    print(f"  {len(fields)} field(s) in Consensus::Params, "
          f"{len(nets)} network(s): {', '.join(sorted(nets))}\n")

    bad = []
    scalars = 0
    for name, has_default, ctype in fields:
        if not SCALAR.match(ctype):
            continue          # a class type initialises itself
        scalars += 1
        if has_default or name in NOT_A_PLAIN_FIELD:
            continue
        # `=` AND NOT `==`.
        #
        # This read `(=|\[)`, so `assert(consensus.enforce_BIP94 == false)`
        # -- a READ of the field -- counted as assigning it. The one
        # construct that proves nobody assigned a value was accepted as
        # proof that somebody did.
        #
        # `=[^=]` cannot match `==`. It does not need to exclude `>=`, `<=`
        # or `!=`: in those the character before the `=` is not whitespace,
        # so `\s*=` never reaches it.
        #
        # Reported by Fahrizal, 18 November 2026.
        assigner = re.compile(r"consensus\.%s\s*(=[^=]|\[)" % re.escape(name))
        missing = [n for n, body in nets.items() if not assigner.search(body)]
        if missing:
            bad.append((name, missing))

    for name, missing in bad:
        print(f"  {RED}FAIL{OFF}  {name}")
        print(f"          no default initialiser, and not assigned by: "
              f"{', '.join(sorted(missing))}")
        reads = [f"{p}:{i}" for p in ("build/wam-core/src/validation.cpp",
                                      "build/wam-core/src/node/miner.cpp",
                                      "build/wam-core/src/pow.cpp")
                 for i, line in enumerate(
                     (ROOT / p).read_text(encoding="utf-8",
                                          errors="replace").splitlines(), 1)
                 if re.search(r"\b%s\b" % re.escape(name), line)]
        if reads:
            print(f"          read at: {', '.join(reads[:4])}")

    print()
    if bad:
        print(f"  {RED}{len(bad)} consensus field(s) are read before they are "
              f"written{OFF}")
        print("  Give the field a default in Consensus::Params, or assign it")
        print("  in every network in src/wam/chainparams.cpp. Both is better.")
        print()
        print("  This is how enforce_BIP94 was declared, read in three")
        print("  consensus paths, and never assigned by anybody.\n")
        return 1

    print(f"  {GRN}{BLD}every consensus field is defaulted or assigned by "
          f"every network{OFF}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
