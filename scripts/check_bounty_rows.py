#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_bounty_rows.py -- one row per finding, and the rows agree with the
                         entries underneath them
===============================================================================

     python3 scripts/check_bounty_rows.py

 WHY THIS EXISTS

 SECURITY.md carries two records of the same thing: a summary table near the
 top, and a detailed entry for every finding further down. They drifted, and
 the drift was found by the founder reading the page rather than by anything
 here.

 It drifted in the way a summary always does. The prose said "1,950 to three
 people on 9 November, and 650 to two more on 13 November". The arithmetic
 was right and the sentence named nobody, so no reader could check one figure
 in it against one entry -- and a reporter asking what their own finding had
 been worth could not be answered from it at all.

 Worse, one entry carried TWO findings under one number: "10,250 WAM -- a
 broadcast payment paid a second time, and three more faults in the same
 accounting". Two findings at two rungs, which the reporter had himself
 named separately. Printed as a sum, neither could be priced, and the next
 person to report either one could not be told what the first had been worth.

 The founder's instruction, 19 November 2026: the table must match the
 entries, person by person and value by value, and two findings from one
 person are never one figure.

 WHAT THIS CHECKS

   every table row has an entry with the same amount    no row invented
   every entry appears as a table row                   no entry hidden
   the two agree on how many findings exist             no merging

 It compares MULTISETS of amounts, not sums. A sum hides exactly the fault
 this was written for: 10,000 + 250 and one row of 10,250 add to the same
 number, and that is the whole defect.

 EXIT CODES, this project's convention

     0  the table and the entries describe the same findings
     1  they do not
     2  SECURITY.md could not be read, so nothing was checked
===============================================================================
"""

from __future__ import annotations

import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SECURITY = ROOT / "SECURITY.md"

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# | who | finding | amount | paid |
ROW = re.compile(r"^\|\s*([^|]{2,40}?)\s*\|\s*([^|]+?)\s*\|\s*([\d,]+)\s*\|\s*([^|]+?)\s*\|\s*$")

# **N WAM — ... accepted DATE, STATUS.**
#
# `accepted\s` and not `accepted `: SECURITY.md is hard-wrapped, so the date
# lands on the next line about a third of the time. Written with a literal
# space this read 11 entries out of 17 and accused the table of inventing
# six findings -- a check that cries wolf about money is worse than no check,
# because the next real drift is read as another parsing bug.
ENTRY = re.compile(r"^\*\*([\d,]+) WAM\s*[—–-]\s*(.+?),\s*accepted\s", re.S)


def amount(text: str) -> int:
    return int(text.replace(",", ""))


def main() -> int:
    print(f"\n{BLD}one row per finding, and the rows match the entries{OFF}\n")

    # THIS FILE QUOTES ITS OWN HEADINGS, SO THE MARKS ARE HONOURED.
    #
    # SECURITY.md explains its own corrections in prose, and explaining a
    # merged entry means printing the merged heading. A line that quotes
    # `**10,250 WAM — ...` is a sentence ABOUT a row, not a row, and
    # scripts/lib/quoted.py is how this project draws that line everywhere
    # else. Without it this check would count the apology for the old entry
    # as an eighteenth finding.
    try:
        text = quoted.strip_quoted(SECURITY.read_text(encoding="utf-8"))
    except OSError as e:
        print(f"  {YEL}could not read {SECURITY.name} ({e}) -- nothing was "
              f"checked{OFF}\n")
        return 2

    rows = []
    for line in text.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        who, finding, amt, paid = m.groups()
        if who.lower() in ("who", "---") or set(who) <= set("-: "):
            continue
        rows.append((who, finding, amount(amt), paid))

    # Entries are paragraphs that OPEN with the bolded amount.
    entries = []
    for para in re.split(r"\n\s*\n", text):
        m = ENTRY.match(para.strip())
        if m:
            entries.append((amount(m.group(1)), m.group(2).strip()))

    if not rows:
        print(f"  {RED}FAIL{OFF}  the summary table is gone from SECURITY.md")
        print("          It is what a reporter reads to price their own "
              "finding.\n")
        return 1
    if not entries:
        print(f"  {YEL}no bounty entries were found -- nothing to compare{OFF}\n")
        return 2

    print(f"  {len(rows)} row(s) in the table, {len(entries)} entry(ies) below\n")

    bad = False

    # MULTISETS, NOT SUMS.
    #
    # 10,000 + 250 and a single 10,250 have the same total. Only the
    # multiset tells them apart, and telling them apart is the point.
    want = collections.Counter(a for _, _, a, _ in rows)
    have = collections.Counter(a for a, _ in entries)

    for amt in sorted(set(want) | set(have), reverse=True):
        if want[amt] == have[amt]:
            continue
        bad = True
        if want[amt] > have[amt]:
            print(f"  {RED}FAIL{OFF}  {amt:,} WAM appears {want[amt]} time(s) in "
                  f"the table and {have[amt]} below")
            print("          A row with no entry is a figure a reader cannot "
                  "check.")
        else:
            print(f"  {RED}FAIL{OFF}  {amt:,} WAM appears {have[amt]} time(s) "
                  f"below and {want[amt]} in the table")
            print("          An entry with no row is a finding the summary "
                  "hides, which")
            print("          is how the last drift happened: the prose said "
                  '"three people".')

    if len(rows) != len(entries):
        bad = True
        print(f"  {RED}FAIL{OFF}  {len(rows)} row(s) against {len(entries)} "
              f"entry(ies)")
        print("          One finding, one row, one entry. Two findings from "
              "one person")
        print("          are two of each, even when one transaction paid "
              "both.")

    if bad:
        print(f"\n  {RED}{BLD}the table and the entries do not describe the "
              f"same findings{OFF}\n")
        return 1

    print(f"  {GRN}ok{OFF}    every finding has one row and one entry, at the "
          f"same amount")
    print(f"\n{GRN}{BLD}  a reporter can price their own finding from this "
          f"page{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
