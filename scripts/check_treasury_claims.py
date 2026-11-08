#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_treasury_claims.py -- what we SAY about the money, against the ledger
===============================================================================

     python3 scripts/check_treasury_claims.py

 WHY THIS EXISTS

 On 2 October 2026 the founder read the front page and found this sentence
 about the one venue where WAM is listed:

     No fee was asked and none was paid.

 It is true, and it reads as a lie, because 500 WAM left the treasury to that
 venue's maintainer on the same day the merge happened -- for a swap test he
 asked for, since nobody can test a swap for a coin without holding some of
 it. That spend is in docs/TREASURY_LEDGER.md with its amount, its reason and
 its transaction id, and we tell every reader to go and check that file. So
 the page invited the reader to find a 500 WAM payment we had not mentioned,
 and the question that follows a discovery like that is never about the 500.

 It was the second time. On 25 September a draft reply to three exchanges
 ended with "nothing was paid and nothing was promised" about the same venue,
 and that one was caught before it was sent -- the record is in
 posts/replies/exchange-offers-2026-09-25.txt, which says in its own words
 that writing it "would have contradicted our own record to make a cleaner
 sentence". Six days later the same sentence was on the front page.

 Two occurrences, one cause: nothing in this repository compares a claim about
 money to the ledger. check_published_claims.py reads wam-params.h, which is
 consensus -- it has no opinion about what has been spent. So the ledger had
 no detector at all, and the only thing standing between a false-looking
 sentence and the public was whoever happened to read the page.

 WHAT THIS DOES

 docs/TREASURY_LEDGER.md is the authority: every coin that has left the
 treasury is a row in it. For each published document this finds the
 paragraphs that DENY a payment, or say the treasury has not moved, and fails
 any that does not name an amount from the ledger in the same paragraph.

 Same paragraph, not the same file, and not behind a link. A denial on line 10
 and the truth on line 400 is how the front page passed every check it had.
===============================================================================
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEDGER = ROOT / "docs" / "TREASURY_LEDGER.md"

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# The same set check_published_claims.py reads, for the same reason: everything
# a stranger can open. The ledger itself is in it -- a row whose reason text
# denies a payment has to name the amount too, and every row does, in its own
# amount column.
PUBLISHED = [
    "CONTRIBUTING.md", "README.md", "WHITEPAPER.md", "SECURITY.md",
    "PROGRESS.md",
    "docs/*.md", "posts/*.txt", "posts/*/*.txt", "posts/*/*.md",
    "integration/*/PR.md",
    "site/*.html", "site/*/*.html", "explorer/web/index.html",
]

EXCLUDE_DIRS = ("build/", "node_modules/", ".git/", "depends/", "src/", "out/")

# A paragraph that denies a payment. Each of these was written by this project
# about a payment that had been made.
#
# They match the DENIAL, not the correct wording -- a pattern written to find
# "none was paid. 500 WAM went to him" can only confirm text that is already
# right, which is the mistake CLAIMS in check_published_claims.py was built
# wrong around once.
# wam:quote-begin
DENIALS = [
    (r"\bno(?:thing|ne)\s+was\s+paid\b",            "nothing was paid"),
    (r"\bno\s+(?:listing\s+)?fee\s+was\s+(?:asked|paid|charged|requested)",
                                                     "no fee was asked or paid"),
    (r"\bnone\s+was\s+(?:asked|paid)\b",            "none was asked or paid"),
    (r"\bwe\s+(?:have\s+)?(?:did\s+not|never)\s+pa(?:y|id)\b",
                                                     "we did not pay"),
    (r"\bnot(?:hing)?\s+a\s+coin\s+has\s+(?:left|moved)\b",
                                                     "not a coin has left"),
    (r"\btreasury\s+has\s+(?:never|not)\s+(?:ever\s+)?(?:moved|spent|paid)",
                                                     "the treasury has not moved"),
    (r"\bnever\s+moved\s+a\s+coin\b",               "never moved a coin"),
    (r"لم\s+يُ?دفع\b",                               "لم يُدفع"),
    (r"لم\s+نَ?دفع\b",                               "لم ندفع"),
    (r"(?:لم|ما)\s+تتحرّ?ك\s+الخزينة",               "لم تتحرّك الخزينة"),
    (r"لم\s+(?:يخرج|تخرج)\s+(?:من\s+الخزينة|منها)",  "لم يخرج من الخزينة"),
]
# wam:quote-end


# A WAM mainnet address in EITHER form the chain pays to, which is how the
# recipient cell is recognised rather than counted to.
#
# This read base58 alone -- ^W[1-9A-HJ-NP-Za-km-z]{25,42}$ -- and the treasury
# has been paying bech32 recipients since 13 October 2026. A row whose
# recipient is a wam1 address did not look like a row at all, so it was
# dropped before any arithmetic saw it, and nothing said so: 1,000 WAM to
# Smooth Jazz Crypto went unseen here for twenty-six days, and the 10,250 to
# bobbyning on 8 November would have joined it. The check whose entire subject
# is "no paragraph may deny a payment that was made" was blind to every
# payment made in the newer format, and reported green while being blind.
#
# The lesson is the one this repository keeps relearning: a check that matches
# a SHAPE sees only that shape, and the day the shape changes it goes quiet
# rather than red. Identifying a cell by what it is remains right -- it is why
# a new fee column did not break this -- but the identity has to know every
# form the thing legitimately takes.
# wam:quote-begin
ADDRESS = re.compile(r"^(?:W[1-9A-HJ-NP-Za-km-z]{25,42}"
                     r"|wam1[02-9ac-hj-np-z]{25,86})$")
AMOUNT = re.compile(r"^\*{0,2}([\d,]+\.\d+)\s*WAM\s*\*{0,2}$")
DATE = re.compile(r"^(20\d\d-\d\d-\d\d)$")
# wam:quote-end


def rows():
    """Every spend in the ledger: (date, amount string, amount, recipient).

    BY WHAT THE CELL IS, NOT BY WHICH COLUMN IT SITS IN.

    This used to read the date, the amount and the recipient as cells one,
    two and three. On 2026-10-11 a fee column was added between the amount
    and the recipient -- a correct change, because the ledger asks the reader
    to subtract the fees and had not been telling him what they were -- and
    this check went on matching position three. It read every fee as an
    address, found no rows for the real recipient, and reported that
    SECURITY.md claimed 10,000 WAM paid where the ledger showed zero.

    The ledger is a document people edit. A checker that depends on its
    column order will accuse it of lying every time a column is added, and
    the accusation is about missing money, which is the worst thing here to
    be wrong about. So each cell is identified by its own shape."""
    out = []
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        date = amount = recipient = None
        for c in cells:
            if date is None and DATE.match(c):
                date = c
                continue
            m = AMOUNT.match(c)
            if amount is None and m:
                amount = m.group(1)
                continue
            bare = c.strip("`")
            if recipient is None and ADDRESS.match(bare):
                recipient = bare
        if date and amount and recipient:
            out.append((date, amount, float(amount.replace(",", "")),
                        recipient))
    return out


def spoken(amount: float) -> set:
    """How a document is allowed to write this amount.

    500.00000000 is written "500 WAM" in prose and "500.00000000 WAM" in the
    ledger, and both have to count. Digits only, in both languages: a reader
    checking a page against the ledger is comparing numbers, and a number
    spelled out in words is one he has to translate before he can.
    """
    forms = {f"{amount:.8f}", f"{amount:,.8f}"}
    if amount == int(amount):
        forms |= {str(int(amount)), f"{int(amount):,}"}
    else:
        forms |= {f"{amount:.2f}".rstrip("0").rstrip(".")}
    return forms


def blocks(rel: str, text: str):
    """(first line number, text) for each paragraph.

    A blank line ends a paragraph everywhere; in HTML a </p> does too, because
    two adjacent <p> tags with no blank line between them are two paragraphs to
    the reader and have to be two here. The alternative -- a window of N lines
    either side -- lets a denial borrow a number from a paragraph the reader
    never reaches, which is the whole fault being checked.
    """
    if rel.endswith(".html"):
        text = re.sub(r"</p\s*>", "\n\n", text, flags=re.I)
    buf, start, i = [], 1, 0
    for i, line in enumerate(text.splitlines(), 1):
        if line.strip():
            if not buf:
                start = i
            buf.append(line)
        elif buf:
            yield start, "\n".join(buf)
            buf = []
    if buf:
        yield start, "\n".join(buf)


def files():
    seen = []
    for pat in PUBLISHED:
        for p in sorted(ROOT.glob(pat)):
            rel = p.relative_to(ROOT).as_posix()
            if any(rel.startswith(d) for d in EXCLUDE_DIRS):
                continue
            if p.is_file() and rel not in seen:
                seen.append(rel)
    return seen


def public(rel: str) -> bool:
    try:
        r = subprocess.run(["git", "check-ignore", "-q", rel], cwd=ROOT,
                           capture_output=True, timeout=10)
        return r.returncode != 0
    except Exception:
        return True


def main() -> int:
    if not LEDGER.exists():
        print(f"  {RED}FAIL{OFF}  {LEDGER.relative_to(ROOT)} is not here -- "
              f"it is the authority this check reads")
        return 1

    spends = rows()
    fails = []

    # Every way any ledger amount may be written, plus the words that say a
    # payment happened at all. A paragraph that denies a payment and then
    # explains the one that was made contains one of these; a paragraph that
    # denies it and stops does not.
    allowed = set()
    for _, _, amt, _ in spends:
        allowed |= spoken(amt)
    total = sum(a for _, _, a, _ in spends)
    allowed |= spoken(total)

    for rel in files():
        text = quoted.strip_quoted(
            (ROOT / rel).read_text(encoding="utf-8", errors="replace"))
        for line_no, para in blocks(rel, text):
            for pat, says in DENIALS:
                if not re.search(pat, para, re.I):
                    continue
                flat = re.sub(r"[\s‌]+", " ", para)
                if any(f in flat for f in allowed):
                    break
                fails.append(
                    f"{rel}:{line_no} says \"{says}\" and the same paragraph "
                    f"names no amount. {len(spends)} spend(s) are in the "
                    f"ledger, {total:,.8f} WAM in all -- a reader who opens it "
                    f"reads this paragraph as a lie.")
                break

    # ---- totals stated as on-chain facts ------------------------------------
    #
    # "the total on the chain is X WAM to <address>" is an instruction to go
    # and add it up. If our arithmetic is wrong, the reader's is right.
    for rel in files():
        text = quoted.strip_quoted(
            (ROOT / rel).read_text(encoding="utf-8", errors="replace"))
        flat = re.sub(r"\s+", " ", text)
        for m in re.finditer(r"total\s+on\s+the\s+chain\s+is\s+"
                             r"([\d,]+\.?\d*)\s*WAM\s+to\s+`?([A-Za-z0-9]{26,42})`?",
                             flat, re.I):
            said = float(m.group(1).replace(",", ""))
            addr = m.group(2)
            got = sum(a for _, _, a, to in spends if to == addr)
            if abs(said - got) > 1e-8:
                fails.append(
                    f"{rel} states the total paid to {addr} as "
                    f"{said:,.8f} WAM; the ledger's rows for that address add "
                    f"up to {got:,.8f} WAM")

    # ---- report -------------------------------------------------------------
    scanned = files()
    print()
    print(f"{BLD}what we say about the money, against the ledger{OFF}")
    print(f"  authority : {LEDGER.relative_to(ROOT)}")
    print(f"  spends    : {len(spends)}, {total:,.8f} WAM, "
          f"{spends[0][0] if spends else '-'} to {spends[-1][0] if spends else '-'}")
    print(f"  documents : {len(scanned)} scanned, "
          f"{sum(1 for f in scanned if public(f))} of them on GitHub")
    print()

    for m in fails:
        rel = m.split(":")[0].split(" ")[0]
        mark = "" if public(rel) else f"  {YEL}[local only, not on GitHub]{OFF}"
        print(f"  {RED}FAIL{OFF}  {m}{mark}")

    if not fails:
        print(f"  {GRN}ok{OFF}    every paragraph that denies a payment names "
              f"the one that was made")
    print()
    if fails:
        print(f"  {RED}{len(fails)} paragraph(s) the ledger contradicts{OFF}")
    else:
        print(f"  {GRN}{BLD}nothing we publish about the treasury is "
              f"contradicted by the treasury{OFF}")
    print()
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
