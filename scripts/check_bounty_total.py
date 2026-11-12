#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_bounty_total.py -- what the pages say has been paid, against the ledger
===============================================================================

     python3 scripts/check_bounty_total.py

 WHY THIS EXISTS

 Four places state how much this project has paid in bounties, and to how
 many people:

     SECURITY.md          "21,250 WAM to four people", in prose
     SECURITY.md          one PAID entry per payment, with txid and rung
     site/index.html      "21,250 WAM has been paid against it so far"  (en)
     site/index.html      the same sentence in Arabic
     site/index.html      "an organic exchange has happened four times"

 They are edited by different hands at different moments and nothing made
 them move together, so on 2026-10-13 they stopped agreeing with each other:
 the footer said 21,000 WAM, which was correct and included three payments,
 while the paragraph above it said the exchange had happened "twice" and
 named two. Both sentences were on the same page, visible at the same time,
 and the number in one contradicted the count in the other for two days. The
 founder found it by reading his own front page.

 That is the same mechanism as scripts/set_version.py: a figure that lives in
 two kinds of place, moved by hand, with nothing asking whether the copies
 agree. The answer is the same -- make something ask.

 WHAT THIS DOES

 It takes the total from docs/TREASURY_LEDGER.md -- the bounty rows of it --
 and requires every published figure to match: the total, the number of
 people, the count in the "organic exchange" sentence, and any count of how
 many times the treasury has moved. It also requires SECURITY.md's own PAID
 entries to add up to the same number, and every transaction id it quotes to
 be a row in the ledger. An unpaid or unclaimed entry is counted as neither,
 because it has not been paid.

 THE AUTHORITY USED TO BE THE DOCUMENT BEING CHECKED.

 This paragraph said "this checks that the prose agrees with the ledger" and
 the code never opened the ledger. It added up SECURITY.md's own entries and
 asked whether SECURITY.md's prose matched them -- so a file that was wrong
 in two places agreed with itself and passed, and a payment missing from the
 entry list was missing from the total that was compared against it.

 The ledger is the right authority because it is the only one of the three
 that can be checked against something outside this repository: every row
 carries a txid, and scripts/check_treasury_ledger.py walks them against the
 chain and verifies the balance identity to the atom. That checks the ledger
 against the chain; this checks the pages against the ledger.

 A LEDGER ROW IS NOT ALWAYS A BOUNTY, AND THE LEDGER ALREADY SAYS WHICH.

 34 rows, 33,950 WAM. One of them is the 500 WAM atomic-swap test coin of
 2026-09-22, whose own reason field says what it is. 33 rows and 33,450 WAM
 are bounties. Folding the test coin into a bounty total was one of the three
 wrong figures this check now exists to catch, and the distinction needs no
 new column: a bounty row says "bounty".

 Reported by cx / StartupComplianceKit (ne8nai2534@proton.me) on 10 November
 2026: three published figures disagreeing with the ledger they point the
 reader at, and the observation that the amount was gated and the COUNT was
 not. "34 txids in the ledger against 'twenty times' on the published page is
 not a number any check in scripts/ compares."

 EXIT CODES, this project's convention

     0  every published figure matches the paid entries
     1  one does not
     2  the entries could not be read, so nothing was compared
===============================================================================
"""

from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# A bounty heading: "**10,000 WAM — <what>, accepted <date>, PAID <date>.**"
#
# The word "paid" is what makes it count, and it is matched case-insensitively
# with "un" excluded: this file has written PAID, "first instalment paid",
# "not claimed" and "unpaid", and a check keyed to one spelling found three
# payments out of four on its first run. The lookbehind is the whole of the
# difference between counting "unpaid" and not.
ENTRY = re.compile(r"^\*\*([\d,]+) WAM\s*[—-]\s*(.+?)\*\*", re.MULTILINE | re.DOTALL)
PAID = re.compile(r"(?<![a-z])(?<!un)paid\b", re.IGNORECASE)

ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")

COUNT_WORDS = {1: ("once", "مرّة"), 2: ("twice", "مرّتين"),
               3: ("three times", "ثلاث مرّات"), 4: ("four times", "أربع مرّات"),
               5: ("five times", "خمس مرّات"), 6: ("six times", "ستّ مرّات"),
               7: ("seven times", "سبع مرّات"), 8: ("eight times", "ثماني مرّات")}

PEOPLE_WORDS = {1: ("one person", "شخص واحد"), 2: ("two people", "شخصين"),
                3: ("three people", "ثلاثة أشخاص"), 4: ("four people", "أربعة أشخاص"),
                5: ("five people", "خمسة أشخاص"), 6: ("six people", "ستّة أشخاص"),
                7: ("seven people", "سبعة أشخاص"), 8: ("eight people", "ثمانية أشخاص")}


# A ledger row: | date | **amount WAM** | fee | to | reason | txid `hex` |
LEDGER_ROW = re.compile(r"^\|\s*(\d{4}-\d{2}-\d{2})\s*\|(.+)$")
TXID = re.compile(r"\b[0-9a-f]{64}\b")

# How many times the treasury has moved, as a sentence might put it. Both
# shapes are ones this project has published; the digits are there because a
# rewrite is as likely to use them as a word.
WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50
}
MOVEMENT = re.compile(
    r"(?:has moved|moved|movements?)\s+([a-z]+(?:-[a-z]+)?|[\d,]+)\s*(?:times)?",
    re.IGNORECASE)


def word_to_number(token):
    """20, 'twenty' and 'thirty-four' all become an integer, or None."""
    t = token.strip().lower().replace(",", "")
    if t.isdigit():
        return int(t)
    if t in WORD_NUMBERS:
        return WORD_NUMBERS[t]
    if "-" in t:
        tens, _, units = t.partition("-")
        if tens in WORD_NUMBERS and units in WORD_NUMBERS:
            return WORD_NUMBERS[tens] + WORD_NUMBERS[units]
    return None


def ledger_rows(text):
    """[(date, wam, txid, reason)] for every spend row in the ledger."""
    out = []
    for line in text.splitlines():
        m = LEDGER_ROW.match(line)
        if not m:
            continue
        cells = [c.strip() for c in m.group(0).strip().strip("|").split("|")]
        if len(cells) < 6:
            continue
        amount = re.sub(r"[^0-9.]", "", cells[1])
        txid = TXID.search(cells[5])
        if not amount or not txid:
            continue
        out.append((cells[0], float(amount), txid.group(0), cells[4]))
    return out


def paid_entries(text):
    """[(amount_in_wam, heading)] for every entry whose heading says PAID."""
    out = []
    for m in ENTRY.finditer(text):
        heading = " ".join(m.group(2).split())
        if not PAID.search(heading):
            continue
        out.append((int(m.group(1).replace(",", "")), heading))
    return out


def fmt(n):
    return "{:,}".format(n)


def main() -> int:
    print(f"\n{BLD}what the pages say has been paid, against the ledger{OFF}\n")

    sec = ROOT / "SECURITY.md"
    index = ROOT / "site" / "index.html"
    ledger = ROOT / "docs" / "TREASURY_LEDGER.md"
    for p in (sec, index, ledger):
        if not p.is_file():
            print(f"  {YEL}{p.relative_to(ROOT)} is not here, so nothing was "
                  f"compared.{OFF}\n")
            return 2

    # The authority. Not stripped of quoted text: a ledger row is a record of
    # a transaction, never a quotation of one.
    rows = ledger_rows(ledger.read_text(encoding="utf-8", errors="replace"))
    if not rows:
        print(f"  {YEL}no spend row was found in docs/TREASURY_LEDGER.md -- "
              f"either the table format changed or nothing has been spent. "
              f"Nothing was compared.{OFF}\n")
        return 2

    bounty_rows = [r for r in rows if "bounty" in r[3].lower()]
    other_rows = [r for r in rows if "bounty" not in r[3].lower()]
    ledger_total = round(sum(r[1] for r in bounty_rows))
    ledger_txids = {r[2] for r in rows}

    print(f"  {len(rows)} spend row(s) in the ledger, "
          f"{len(ledger_txids)} distinct transaction id(s)")
    print(f"      {fmt(ledger_total):>7} WAM   in {len(bounty_rows)} bounty row(s)")
    for r in other_rows:
        print(f"      {fmt(round(r[1])):>7} WAM   NOT a bounty: {r[3][:52]}")
    print()

    # Quotation marks are honoured, as in every other text-scanning check
    # here: this file quotes the wording it replaced more than once, and a
    # quoted "21,000 WAM" is a record of what the page used to say, not a
    # claim the page is making now.
    sec_text = quoted.strip_quoted(sec.read_text(encoding="utf-8", errors="replace"))
    entries = paid_entries(sec_text)
    if not entries:
        print(f"  {YEL}no PAID entry was found in SECURITY.md -- either the "
              f"heading format changed or nothing has been paid. Nothing was "
              f"compared.{OFF}\n")
        return 2

    entry_total = sum(a for a, _ in entries)
    count = len(entries)
    total = ledger_total          # the ledger decides, not this document

    print(f"  {count} paid entr{'y' if count == 1 else 'ies'} in SECURITY.md, "
          f"{fmt(entry_total)} WAM in all")
    for amount, heading in entries:
        print(f"      {fmt(amount):>7} WAM   {heading[:64]}")
    print()

    bad = []

    # 0. The entries against the ledger. This is the comparison that did not
    #    exist: the total was taken FROM these entries and then checked
    #    against prose beside them, so an entry missing from this list was
    #    also missing from the number it was measured against.
    if entry_total != ledger_total:
        bad.append(("SECURITY.md",
                    "its PAID entries add up to %s WAM and the ledger's bounty "
                    "rows add up to %s. One of them is missing a payment, or "
                    "counting something that is not a bounty."
                    % (fmt(entry_total), fmt(ledger_total))))
    else:
        print(f"  {GRN}ok{OFF}    SECURITY.md's paid entries add up to the "
              f"ledger's bounty rows")

    # 0b. Every transaction id SECURITY.md quotes is a row in the ledger.
    #     A txid printed in the record of a payment that the ledger does not
    #     carry is either a typo or a payment nothing can check.
    quoted_txids = set(TXID.findall(sec_text))
    stray = sorted(quoted_txids - ledger_txids)
    if stray:
        for t in stray[:4]:
            bad.append(("SECURITY.md",
                        f"quotes transaction {t[:16]}... which is not a row in "
                        f"docs/TREASURY_LEDGER.md"))
    elif quoted_txids:
        print(f"  {GRN}ok{OFF}    every transaction SECURITY.md names "
              f"({len(quoted_txids)}) is in the ledger")

    # 1. The prose total in SECURITY.md.
    if not re.search(r"\b%s WAM\b" % re.escape(fmt(total)), sec_text):
        bad.append(("SECURITY.md", f"does not state the total {fmt(total)} WAM"))
    else:
        print(f"  {GRN}ok{OFF}    SECURITY.md states {fmt(total)} WAM")

    # 2. The number of people, in SECURITY.md's prose.
    want_people = PEOPLE_WORDS.get(count)
    if want_people and not any(w in sec_text for w in want_people):
        bad.append(("SECURITY.md",
                    f"does not say the money went to {want_people[0]}"))
    elif want_people:
        print(f"  {GRN}ok{OFF}    SECURITY.md says {want_people[0]}")

    # 3. The front page, both languages. Its own digits may be Arabic-Indic.
    page = quoted.strip_quoted(
        index.read_text(encoding="utf-8", errors="replace")).translate(ARABIC_DIGITS)
    found = (re.findall(r"([\d,]+) WAM has been paid", page)
             + re.findall(r"([\d,]+) WAM[،,]? بكلّ مبلغ", page))
    stated = set(found)
    if not stated:
        bad.append(("site/index.html",
                    "states no paid total at all -- the sentence that carried "
                    "it has moved or gone"))
    elif stated != {fmt(total)}:
        bad.append(("site/index.html",
                    "says %s, and the ledger adds up to %s"
                    % (", ".join(sorted(stated)), fmt(total))))
    else:
        print(f"  {GRN}ok{OFF}    site/index.html states {fmt(total)} WAM, in "
              f"{len(found)} sentence(s)")

    # 4. The "organic exchange has happened N times" count, which is the one
    #    that went stale while the total beside it stayed right.
    want_count = COUNT_WORDS.get(count)
    if want_count:
        for word in want_count:
            if word not in page:
                bad.append(("site/index.html",
                            "does not say the exchange has happened %r -- that "
                            "sentence counts the same payments" % word))
        if not any((w, ) for w in want_count if w not in page):
            print(f"  {GRN}ok{OFF}    site/index.html counts the exchange "
                  f"{want_count[0]}, in both languages")

    # 5. HOW MANY TIMES THE TREASURY HAS MOVED.
    #
    #    "It has moved twenty times" stood on the published security page
    #    while the ledger carried 34 rows, and no check anywhere compared the
    #    two. The amount was gated and the count was not, which is why the
    #    amount was corrected twice and the count went wrong twice.
    #
    #    The sentence has since been removed rather than corrected -- a count
    #    that must be retyped after every payment is a figure waiting to go
    #    stale -- so the usual result here is that there is nothing to check.
    #    That is said out loud rather than passed over in silence, because a
    #    check that finds nothing to look at has not looked.
    movements = []
    for where, text in (("SECURITY.md", sec_text), ("site/index.html", page)):
        for m in MOVEMENT.finditer(text):
            n = word_to_number(m.group(1))
            if n is None or n < 2:
                continue        # "moved to", "moved it": not a count
            movements.append((where, n, " ".join(m.group(0).split())))

    if not movements:
        print(f"  {GRN}ok{OFF}    no page states how many times the treasury "
              f"has moved (the ledger's {len(rows)} rows are the count)")
    for where, n, phrase in movements:
        if n == len(rows):
            print(f"  {GRN}ok{OFF}    {where} says {phrase!r}, and the ledger "
                  f"has {len(rows)} rows")
        else:
            bad.append((where,
                        "says %r and the ledger has %d spend rows"
                        % (phrase, len(rows))))

    print()
    if bad:
        for where, why in bad:
            print(f"  {RED}FAIL{OFF}  {where}: {why}")
        print()
        print(f"  {RED}{BLD}a published figure does not match the "
              f"ledger{OFF}")
        print("  These numbers are read by people deciding whether to trust the")
        print("  bounty table at all. Two of them disagreeing on the same page")
        print("  is worse than either one being out of date alone.\n")
        return 1

    print(f"  {GRN}{BLD}every published figure matches the ledger{OFF}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
