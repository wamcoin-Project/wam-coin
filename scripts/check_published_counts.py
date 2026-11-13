#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_published_counts.py -- numbers we publish ABOUT OURSELVES, measured
===============================================================================

     python3 scripts/check_published_counts.py

 WHY THIS EXISTS

 check_published_claims.py asks one question well: does a published number
 match the constant the network enforces? Every number it can check has an
 authority in wam-params.h to check it against.

 A whole second class has no such authority, and nothing was reading it. These
 are numbers about this repository rather than about the chain -- how many
 tests there are, how far the emission truncates, what install.sh does before
 it compiles, when a file was last reviewed. Nothing enforces them, so nothing
 compared them, so they drifted, and on 13 November 2026 an outside reader sent
 four in one report:

   README.md         "53 tests over the payout logic"      -- it is 56
   README.md         "35 Boost tests pass"                 -- it is 45
   README.md         "runs the first four ... before it compiles anything"
                                                           -- three, and the
                                                              fourth runs after
   wam-params.h      "19,999,999.99 WAM after truncation"  -- 19,999,999.978
   WHITEPAPER.md     "5% truncates to zero (epoch 26)"     -- epoch 28
   SECURITY.md       "Last reviewed: 2026-08-11"           -- rewritten since,
                                                              three months stale

 Not one of them was a wrong constant. Every one was a sentence about our own
 work that nobody had a way to measure. Three of the six had been wrong since
 the files were written.

 WHAT THIS DOES

 Measures each figure from the thing it describes -- the test files, the
 header's own arithmetic, install.sh's own order -- and fails on any published
 statement that disagrees. Where it cannot measure, it says so and fails
 rather than passing: a check that could not look is not a check that looked.
===============================================================================
"""

from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys

import pathlib as _pathlib
import sys as _sys
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
HDR = ROOT / "src" / "wam" / "wam-params.h"

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# Only what a stranger can read. A number in a gitignored working note is
# nobody's promise.
#
# wam-params.h is in this list, and it is a source file. It belongs here
# because the whitepaper sends readers to it by name -- "reads the constants
# out of src/wam/wam-params.h" -- and its header comment is a published
# PROOF of the 22,000,000 cap, written out line by line. That proof carried
# 19,999,999.99 for the life of the chain, which is the limit of the series
# rounded rather than the sum of the truncated epochs, and the first version
# of this check did not read the file that contained the error it was written
# for.
PUBLISHED = ["README.md", "WHITEPAPER.md", "SECURITY.md", "CONTRIBUTING.md",
             "docs/*.md", "site/*/index.html", "site/*.html", "posts/*.txt",
             "src/wam/wam-params.h"]


def read(p: pathlib.Path) -> str:
    """The file, with the author's quotations blanked and line numbers kept.

    Same reason as everywhere else in scripts/: a check that matches text
    cannot tell use from mention, and the paragraph recording a figure we got
    WRONG necessarily contains that wrong figure. See scripts/lib/quoted.py.
    """
    return quoted.strip_quoted(p.read_text(encoding="utf-8", errors="replace"))


def published_files():
    out = []
    for pat in PUBLISHED:
        for p in sorted(ROOT.glob(pat)):
            if p.is_file():
                out.append(p.relative_to(ROOT).as_posix())
    return sorted(set(out))


def num(s: str) -> int:
    return int(re.sub(r"[,'_]", "", s))


# ---------------------------------------------------------------------------
# What the repository actually contains
# ---------------------------------------------------------------------------

def const(name: str, text: str):
    m = re.search(rf"{name}\s*=\s*([^;]+);", text)
    if not m:
        return None
    raw = m.group(1).replace("'", "").strip()
    mul = re.match(r"(\d+)\s*\*\s*WAM_COIN", raw)
    if mul:
        return int(mul.group(1)) * 100_000_000
    m2 = re.match(r"\d+", raw)
    return int(m2.group(0)) if m2 else None


def emission():
    """Replay the shift epoch by epoch, exactly as GetBlockSubsidy does.

    The published 19,999,999.99 was the limit of the geometric series rounded
    to two places -- a correct figure for a different question. The emission
    truncates on every epoch, and the truncated sum is 0.012 WAM lower.
    """
    text = read(HDR)
    subsidy = const("WAM_INITIAL_BLOCK_SUBSIDY", text)
    interval = const("WAM_SUBSIDY_HALVING_INTERVAL", text)
    halvings = const("WAM_MAX_HALVINGS", text)
    premine = const("WAM_GENESIS_PREMINE", text)
    pct = const("WAM_DEVFEE_PERCENT", text)
    if None in (subsidy, interval, halvings, premine, pct):
        return None

    spacing = const("WAM_POW_TARGET_SPACING", text)
    dgw = const("WAM_DGW_PAST_BLOCKS", text)
    maturity = const("WAM_COINBASE_MATURITY", text)

    mined = sum(interval * (subsidy >> e) for e in range(halvings))
    last_paying_epoch = max(e for e in range(halvings) if (subsidy >> e) > 0)
    # Epoch e covers heights interval*e + 1 .. interval*(e+1), because
    # GetBlockSubsidy computes (nHeight - 1) / interval.
    last_paying_height = interval * (last_paying_epoch + 1)
    # The first epoch where the treasury share truncates away entirely.
    zero_fee_epoch = next(
        (e for e in range(halvings) if ((subsidy >> e) * pct) // 100 == 0),
        None)
    out = {
        "mined": mined,
        "terminal": mined + premine,
        "last_paying_height": last_paying_height,
        "zero_fee_epoch": zero_fee_epoch,
        "zero_fee_subsidy": (subsidy >> zero_fee_epoch) if zero_fee_epoch is not None else None,
        "spacing": spacing,
        "equilibrium": None,
    }

    # THE SPACING THE CHAIN RUNS AT, WHICH IS NOT THE CONSTANT.
    #
    # DarkGravityWave measures WAM_DGW_PAST_BLOCKS - 1 intervals against a
    # target of WAM_DGW_PAST_BLOCKS (src/wam/pow.cpp), so the fixed point is
    # the target scaled by that ratio: 24 * 120 / 23 = 125.2174 s. Every
    # duration this project publishes was computed from the 120 instead --
    # halvings at 9.1 months, 720 blocks a day, maturity in 3.3 hours,
    # emission ending in 25.1 years, four figures wrong for the life of the
    # chain. Each one is derived here so it cannot drift from the algorithm
    # again. Reported 13 November 2026, measured at 126.01 s over the first
    # 40,876 blocks.
    if spacing and dgw and dgw > 1:
        eq = spacing * dgw / (dgw - 1)
        year = 365.2425 * 86400
        month = year / 12
        out.update({
            "equilibrium": eq,
            "blocks_per_day": 86400 / eq,
            "halving_months": interval * eq / month,
            "emission_years": last_paying_height * eq / year,
            "maturity_hours": (maturity * eq / 3600) if maturity else None,
            "devfee_months": (const("WAM_DEVFEE_LAST_HEIGHT", text) or 0) * eq / month,
        })
    return out


def boost_cases():
    """How many Boost test cases the WAM consensus suites define.

    Counted from the sources rather than from a built binary, so this answers
    on a machine that has never compiled anything -- and so it cannot be
    fooled by a stale build.
    """
    d = ROOT / "src" / "wam" / "test"
    if not d.is_dir():
        return None
    total, files = 0, 0
    for p in sorted(d.glob("*.cpp")):
        body = read(p)
        n = len(re.findall(r"^\s*BOOST_(?:AUTO|FIXTURE)_TEST_CASE\s*\(",
                           body, re.M))
        total += n
        files += 1 if n else 0
    return total if files else None


def pool_suite_total(rel: str):
    """Run one pool test file and read the total IT reports.

    Not a count of `await test(` in the source: that is a second opinion
    about the same file, and the figure we publish is the figure the suite
    prints. If node is missing this returns None, and None is reported as a
    comparison that did not happen.
    """
    node = shutil.which("node")
    if not node:
        return None
    try:
        r = subprocess.run([node, rel], cwd=ROOT, capture_output=True,
                           text=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"ALL (\d+) TESTS? PASSED", r.stdout)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d+) checks?:", r.stdout)
    return int(m.group(1)) if m else None


def install_order():
    """Which of the audit commands install.sh runs before `make`, and which after.

    The README told a reader "the first four, before it compiles anything".
    Three run at install.sh:206-210; the pool suite needs the pool's native
    RandomX addon and so cannot run before the build. Measured from the file
    rather than described, because the order is the claim.
    """
    p = ROOT / "install.sh"
    if not p.is_file():
        return None
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    make_at = next((i for i, ln in enumerate(lines, 1)
                    if re.match(r"\s*make\s+-j", ln)), None)
    if not make_at:
        return None
    audits = {
        "verify_supply.py": None,
        "gen_founder_key.py": None,
        "test_serialization.py": None,
        "rewards.test.js": None,
    }
    for i, ln in enumerate(lines, 1):
        for name in audits:
            if name in ln and audits[name] is None and not ln.lstrip().startswith("#"):
                audits[name] = i
    before = sum(1 for at in audits.values() if at and at < make_at)
    after = sum(1 for at in audits.values() if at and at > make_at)
    return {"make_at": make_at, "before": before, "after": after,
            "where": audits}


# ---------------------------------------------------------------------------

def main() -> int:
    fails, notes = [], []

    def bad(m): fails.append(m)
    def note(m): notes.append(m)

    e = emission()
    boost = boost_cases()
    order = install_order()
    rewards = pool_suite_total("pool/test/rewards.test.js")

    if e is None:
        bad("wam-params.h could not be read, so not one figure below was "
            "compared against anything")
        e = {}
    if boost is None:
        bad("src/wam/test/*.cpp defines no Boost test case this could count, "
            "so the published test count was not checked")
    if order is None:
        bad("install.sh has no `make -j` line this could find, so the order "
            "it publishes was not checked")
    if rewards is None:
        bad("pool/test/rewards.test.js did not report a total (is node "
            "installed?), so the published test count was not checked")

    docs = published_files()
    if not docs:
        bad("no published document was found -- this proves nothing")

    # ---- 1. a stated count of tests ---------------------------------------
    #
    # Both forms the README uses, and the figure each one is about. Matched on
    # the words around the number so that "3,000 random hashes" and "33
    # halving epochs" are not read as test counts.
    COUNTS = []
    if rewards is not None:
        COUNTS.append((
            re.compile(r"\b([\d,']{1,5})\s+tests?\s+over\s+the\s+payout\s+logic",
                       re.I),
            rewards, "tests in pool/test/rewards.test.js"))
    if boost is not None:
        COUNTS.append((
            re.compile(r"\b([\d,']{1,5})\s+Boost\s+(?:unit\s+)?tests?"
                       r"(?:\s+cases?)?", re.I),
            boost, "Boost test cases in src/wam/test"))
        COUNTS.append((
            re.compile(r"\b([\d,']{1,5})\s+Boost\s+test\s+cases?", re.I),
            boost, "Boost test cases in src/wam/test"))

    # ---- 2. the emission figures ------------------------------------------
    if e.get("terminal") is not None:
        term = e["terminal"] / 100_000_000
        mined = e["mined"] / 100_000_000
        # Any 19,999,999.x or 21,999,999.x stated as a supply figure.
        COUNTS.append((re.compile(r"\b(19,?999,?999\.\d+)\b"), None,
                       "mined emission after truncation"))
        COUNTS.append((re.compile(r"\b(21,?999,?999\.\d+)\b"), None,
                       "terminal supply after truncation"))
        del term, mined

    for rel in docs:
        text = read(ROOT / rel)
        for i, line in enumerate(text.splitlines(), 1):
            flat = re.sub(r"[|*_`]+", " ", re.sub(r"<[^>]+>", " ", line))
            for pat, want, label in COUNTS:
                for m in pat.finditer(flat):
                    raw = m.group(1)
                    if want is None:
                        # A decimal supply figure: compare the digits, since
                        # trailing zeros are a formatting choice.
                        shown = float(raw.replace(",", ""))
                        truth = (e["mined"] if raw.startswith("19")
                                 else e["terminal"]) / 100_000_000
                        if abs(shown - truth) > 5e-9:
                            exact = f"{truth:.8f}".rstrip("0").rstrip(".")
                            bad(f"{rel}:{i} states {raw} for the {label}; "
                                f"replaying the header's own shift epoch by "
                                f"epoch gives {exact}")
                        continue
                    try:
                        got = num(raw)
                    except ValueError:
                        continue
                    if got != want:
                        bad(f"{rel}:{i} states {got:,} {label}; there are "
                            f"{want:,}")

    # ---- 3. the epoch where the treasury share truncates to zero ----------
    #
    # The whitepaper named epoch 26 for the life of the chain. It is 28, and
    # the sunset at height 400,000 means the branch is never reached at all --
    # which is the sentence that is now there, and this holds the number in it.
    if e.get("zero_fee_epoch") is not None:
        want = e["zero_fee_epoch"]
        pat = re.compile(r"truncat\w*[^.\n]{0,80}?epoch\s+(\d+)"
                         r"|epoch\s+(\d+)[^.\n]{0,80}?truncat\w*", re.I)
        for rel in docs:
            text = read(ROOT / rel)
            for i, line in enumerate(text.splitlines(), 1):
                for m in pat.finditer(line):
                    got = int(m.group(1) or m.group(2))
                    if got != want:
                        bad(f"{rel}:{i} says the treasury share truncates to "
                            f"zero at epoch {got}; it is epoch {want}, where "
                            f"the subsidy is {e['zero_fee_subsidy']} base "
                            f"unit(s)")

    # ---- 4. the final paying height ---------------------------------------
    if e.get("last_paying_height") is not None:
        want = e["last_paying_height"]
        pat = re.compile(r"(?:emission|subsidy)[^.\n]{0,80}?"
                         r"(?:terminates?|ends?|stops?|exhaust\w*|last block)"
                         r"[^.\n]{0,60}?height\s+([\d,']{6,10})"
                         r"|(?:terminates?|ends?|stops?|exhaust\w*|last block)"
                         r"[^.\n]{0,40}?(?:emission|subsidy)"
                         r"[^.\n]{0,60}?height\s+([\d,']{6,10})", re.I)
        # THE TREASURY ENDS SOMEWHERE ELSE, AND SO DID THIS PATTERN.
        #
        # The first version matched any "ending at height N" and reddened
        # CONTRIBUTING.md:148 -- "WAM's treasury is a consensus rule ...
        # ending at height 400,000" -- which is correct, is already checked
        # against WAM_DEVFEE_LAST_HEIGHT by check_published_claims.py, and
        # has nothing to do with when the emission stops. A check that
        # reddens a true sentence is a check people learn to scroll past, so
        # the subject has to be in the match, not assumed from the number.
        for rel in docs + ["src/wam/wam-params.h"]:
            p = ROOT / rel
            if not p.is_file():
                continue
            for i, line in enumerate(read(p).splitlines(), 1):
                for m in pat.finditer(line):
                    got = num(m.group(1) or m.group(2))
                    if got != want:
                        bad(f"{rel}:{i} puts the end of the emission at height "
                            f"{got:,}; the last block that pays anything is "
                            f"{want:,}")

    # ---- 5. what install.sh does before it compiles -----------------------
    if order:
        pat = re.compile(r"install\.sh[^.\n]{0,60}?first\s+"
                         r"(one|two|three|four|five|\d+)\b", re.I)
        words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
        for rel in docs:
            for i, line in enumerate(read(ROOT / rel).splitlines(), 1):
                for m in pat.finditer(line):
                    tok = m.group(1).lower()
                    got = words.get(tok, int(tok) if tok.isdigit() else None)
                    if got is not None and got != order["before"]:
                        bad(f"{rel}:{i} says install.sh runs the first {got} "
                            f"before compiling; it runs {order['before']} "
                            f"(install.sh make is at line {order['make_at']}, "
                            f"and {order['after']} of them run after it)")

    # ---- 5b. durations derived from a spacing the chain never runs at -----
    #
    # Each pattern matches the CLAIM and captures whatever number is there, so
    # a wrong figure is contradicted rather than a right one confirmed. The
    # tolerance is the rounding the documents use: a tenth of a month, a
    # tenth of a year, a block a day.
    if e.get("equilibrium"):
        DURATIONS = [
            (re.compile(r"halving\w*[^.\n]{0,40}?~\s*([\d.]+)\s*months?", re.I),
             e["halving_months"], 0.1, "months between halvings"),
            (re.compile(r"(?:emission|subsidy)[^.\n]{0,60}?~\s*([\d.]+)\s*years?", re.I),
             e["emission_years"], 0.1, "years until the emission ends"),
            (re.compile(r"blocks per day[^|\n]{0,12}?\|?\s*~?\s*([\d,]+)", re.I),
             e["blocks_per_day"], 1.0, "blocks a day"),
            (re.compile(r"coinbase maturity[^.\n]{0,40}?~\s*([\d.]+)\s*hours?", re.I),
             e["maturity_hours"], 0.1, "hours to coinbase maturity"),
            (re.compile(r"(?:settles? at|equilibrium)[^.\n]{0,40}?"
                        r"\*{0,2}([\d.]+)\s*(?:s\b|second)", re.I),
             e["equilibrium"], 0.1, "seconds a block at equilibrium"),
        ]
        for rel in docs:
            text = read(ROOT / rel)
            for i, line in enumerate(text.splitlines(), 1):
                # The pipes go before the match, for the same reason as
                # _flat() in check_published_claims.py: every one of these
                # figures lives in a markdown table, with the claim in one
                # cell and the number in the next. A pattern that excluded
                # `|` to stop it running into the following cell could never
                # match the row a reader actually looks at -- which is how
                # the first version of this passed a whitepaper that still
                # said 9.1 months. The {0,40} bound is what keeps it from
                # reading two cells away.
                flat = re.sub(r"[*_`|]+", " ", re.sub(r"<[^>]+>", " ", line))
                for pat, want, tol, label in DURATIONS:
                    if want is None:
                        continue
                    for m in pat.finditer(flat):
                        try:
                            got = float(m.group(1).replace(",", ""))
                        except ValueError:
                            continue
                        if abs(got - want) > tol:
                            bad(f"{rel}:{i} states {m.group(1)} for the {label}; "
                                f"the DGW equilibrium of "
                                f"{e['equilibrium']:.4f} s gives {want:.2f}")

    # ---- 6. a review date written by hand ---------------------------------
    #
    # SECURITY.md said 2026-08-11 for three months while being rewritten
    # underneath it. A date a human has to remember to change is a date that
    # will be wrong; git already holds the true one.
    # A FRESHNESS BADGE, NOT A DATED RECORD.
    #
    # The whole line, and nothing after the date: `*Last reviewed:
    # 2026-08-11*` claims the document in front of you was checked that day,
    # and nothing makes it true.
    #
    # docs/LISTING_PACKAGE.md:331 is the other shape and must stay: "Last
    # reviewed 2026-09-22, seven days after launch, when the first real
    # atomic swap was performed ... Before that: 2026-09-20 ...". That is a
    # record of when the CONFIRMATION NUMBERS were reviewed, with what was
    # measured and the review before it. It does not go stale when the file
    # is edited for an unrelated reason, and the first version of this check
    # reddened it.
    hand = re.compile(r"^\s*[*_>\s]*Last reviewed\s*:?\s*"
                      r"(20\d\d-\d\d-\d\d)\s*[*_\s]*$", re.I)
    for rel in docs:
        for i, line in enumerate(read(ROOT / rel).splitlines(), 1):
            m = hand.match(re.sub(r"<[^>]+>", " ", line))
            if not m:
                continue
            try:
                r = subprocess.run(["git", "log", "-1", "--date=short",
                                    "--format=%ad", "--", rel],
                                   cwd=ROOT, capture_output=True, text=True,
                                   timeout=30)
                last = r.stdout.strip()
            except (OSError, subprocess.SubprocessError):
                last = ""
            if last and last != m.group(1):
                bad(f"{rel}:{i} says it was last reviewed {m.group(1)}; the "
                    f"file was last changed {last}. A date kept by hand in a "
                    f"file that changes is a date that will be wrong -- write "
                    f"the git command instead.")
            elif not last:
                note(f"{rel}:{i} carries a hand-written review date "
                     f"({m.group(1)}) and git could not say when the file "
                     f"last changed, so the two were not compared")

    # ---- report ------------------------------------------------------------
    print()
    print(f"{BLD}numbers we publish about ourselves, measured{OFF}")
    if e.get("terminal") is not None:
        print(f"  mined emission     : {e['mined'] / 1e8:,.8f} WAM")
        print(f"  terminal supply    : {e['terminal'] / 1e8:,.8f} WAM")
        print(f"  last paying height : {e['last_paying_height']:,}")
        print(f"  5% hits zero at    : epoch {e['zero_fee_epoch']} "
              f"(subsidy {e['zero_fee_subsidy']} base unit(s))")
    if e.get("equilibrium"):
        print(f"  target spacing     : {e['spacing']} s (the constant)")
        print(f"  DGW equilibrium    : {e['equilibrium']:,.4f} s"
              f"  -> {e['blocks_per_day']:,.0f} blocks/day,"
              f" {e['halving_months']:.1f} months a halving,"
              f" {e['emission_years']:.1f} years of emission")
    print(f"  Boost cases        : {boost if boost is not None else '??'}")
    print(f"  rewards.test.js    : {rewards if rewards is not None else '??'}")
    if order:
        print(f"  install.sh         : {order['before']} audit(s) before "
              f"`make` (line {order['make_at']}), {order['after']} after")
    print(f"  documents          : {len(docs)} read")
    print()

    for m in fails:
        print(f"  {RED}FAIL{OFF}  {m}")
    for m in notes:
        print(f"  {YEL}!!{OFF}    {m}")

    print()
    if fails:
        print(f"  {RED}{len(fails)} published figure(s) do not match what is "
              f"here{OFF}\n")
        return 1
    print(f"  {GRN}{BLD}every figure we publish about ourselves was measured "
          f"and agrees{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
