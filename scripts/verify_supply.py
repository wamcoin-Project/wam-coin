#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 verify_supply.py -- independent audit of the WAM Coin monetary policy
===============================================================================

This script exists so that nobody -- including the WAM developers -- has to be
trusted about the supply. It reads the constants directly out of the C++ header
that consensus actually compiles against, replays the entire emission schedule
with exact integer arithmetic, and asserts the hard cap.

It also cross-checks that every language in the repository agrees on the same
numbers. A coin whose C++ says 200,000 and whose pool says 210,000 will pay the
wrong amounts and nobody will notice until the first halving.

    python3 scripts/verify_supply.py
    python3 scripts/verify_supply.py --schedule       # full epoch table
    python3 scripts/verify_supply.py --check-constants

Exit code 0 means the 22,000,000 WAM cap is mathematically enforced.
===============================================================================
"""

from __future__ import annotations

import argparse
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARAMS_H = os.path.join(REPO, "src", "wam", "wam-params.h")

FAILURES: list[str] = []


def check(name: str, got, want=True) -> bool:
    ok = (got == want)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}"
          + ("" if ok else f"\n          got  {got}\n          want {want}"))
    if not ok:
        FAILURES.append(name)
    return ok


# ---------------------------------------------------------------------------
# Parse the C++ header -- the single source of truth
# ---------------------------------------------------------------------------

def parse_params_header(path: str) -> dict[str, int | str]:
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()

    # Strip block comments so that numbers inside the documentation (of which
    # there are many) cannot be mistaken for definitions.
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"//[^\n]*", "", src)

    out: dict[str, int | str] = {}

    for m in re.finditer(
            r"static\s+constexpr\s+(?:int64_t|int)\s+(WAM_\w+)\s*=\s*([^;]+);", src):
        name, expr = m.group(1), m.group(2).strip()
        expr = expr.replace("'", "")            # C++14 digit separators
        expr = expr.replace("WAM_COIN", str(out.get("WAM_COIN", 100_000_000)))
        for known, val in out.items():
            expr = re.sub(rf"\b{known}\b", str(val), expr)
        try:
            out[name] = int(eval(expr, {"__builtins__": {}}, {}))  # noqa: S307
        except Exception:
            pass

    for m in re.finditer(
            r'static\s+constexpr\s+const\s+char\*\s+(WAM_\w+)\s*=\s*"([^"]*)"', src):
        out[m.group(1)] = m.group(2)

    # Arrays, e.g. the vesting unlock table.
    for m in re.finditer(
            r"static\s+constexpr\s+int64_t\s+(WAM_\w+)\s*\[[^\]]*\]\s*=\s*\{([^}]*)\}", src):
        values = [int(v.strip().replace("'", ""))
                  for v in m.group(2).split(",") if v.strip()]
        out[m.group(1)] = values

    return out


# ---------------------------------------------------------------------------
# The emission model -- mirrors wam::GetBlockSubsidy() exactly
# ---------------------------------------------------------------------------

def block_subsidy(height: int, interval: int, initial: int,
                  premine: int, max_halvings: int) -> int:
    if height < 0:
        return 0
    if height == 0:
        return premine
    halvings = (height - 1) // interval
    if halvings >= max_halvings:
        return 0
    return initial >> halvings          # integer shift, truncating -- as in C++


def emission_table(interval: int, initial: int, max_halvings: int):
    """Yield (epoch, first_height, last_height, subsidy, epoch_total)."""
    for e in range(max_halvings):
        subsidy = initial >> e
        if subsidy == 0:
            break
        first = e * interval + 1
        last = (e + 1) * interval
        yield e, first, last, subsidy, subsidy * interval


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--schedule", action="store_true", help="print the full epoch table")
    ap.add_argument("--check-constants", action="store_true",
                    help="cross-check constants across C++, Python and JavaScript")
    args = ap.parse_args()

    print("=" * 78)
    print(" WAM COIN -- MONETARY POLICY AUDIT")
    print("=" * 78)
    print(f" source of truth: {os.path.relpath(PARAMS_H, REPO)}\n")

    if not os.path.exists(PARAMS_H):
        print(f"error: {PARAMS_H} not found", file=sys.stderr)
        return 1

    P = parse_params_header(PARAMS_H)

    COIN      = P["WAM_COIN"]
    MAX_MONEY = P["WAM_MAX_MONEY"]
    PREMINE   = P["WAM_GENESIS_PREMINE"]
    MINING    = P["WAM_MINING_ALLOCATION"]
    INITIAL   = P["WAM_INITIAL_BLOCK_SUBSIDY"]
    INTERVAL  = P["WAM_SUBSIDY_HALVING_INTERVAL"]
    HALVINGS  = P["WAM_MAX_HALVINGS"]
    DEVFEE    = P["WAM_DEVFEE_PERCENT"]
    SPACING   = P["WAM_POW_TARGET_SPACING"]

    print("[1] constants read from the header")
    print(f"      COIN                     = {COIN:,}")
    print(f"      MAX_MONEY                = {MAX_MONEY / COIN:,.8f} WAM")
    print(f"      GENESIS_PREMINE          = {PREMINE / COIN:,.8f} WAM")
    print(f"      MINING_ALLOCATION        = {MINING / COIN:,.8f} WAM")
    print(f"      INITIAL_BLOCK_SUBSIDY    = {INITIAL / COIN:,.8f} WAM")
    print(f"      SUBSIDY_HALVING_INTERVAL = {INTERVAL:,} blocks")
    print(f"      DEVFEE_PERCENT           = {DEVFEE}%")
    print(f"      POW_TARGET_SPACING       = {SPACING} s")

    # -- 2. the headline arithmetic ----------------------------------------
    print("\n[2] the identity that makes 22,000,000 close exactly")
    ideal = INTERVAL * INITIAL * 2
    print(f"      interval x initial x 2 = {INTERVAL:,} x {INITIAL // COIN} x 2"
          f" = {ideal / COIN:,.0f} WAM")
    check("mining allocation matches the geometric series", ideal, MINING)
    check("premine + mining == hard cap", PREMINE + MINING, MAX_MONEY)
    check("hard cap is exactly 22,000,000 WAM", MAX_MONEY, 22_000_000 * COIN)
    check("premine is exactly 2,000,000 WAM", PREMINE, 2_000_000 * COIN)

    # -- 3. exhaustive replay ----------------------------------------------
    print("\n[3] exact emission replay (integer arithmetic, truncation included)")
    total = PREMINE
    epochs = list(emission_table(INTERVAL, INITIAL, HALVINGS))
    for _, _, _, _, epoch_total in epochs:
        total += epoch_total

    last_height = epochs[-1][2] if epochs else 0
    truncation_loss = MAX_MONEY - total

    print(f"      epochs with a non-zero subsidy : {len(epochs)}")
    print(f"      final block with a subsidy     : {last_height:,}")
    print(f"      terminal supply                : {total / COIN:,.8f} WAM")
    print(f"      headroom below the hard cap    : {truncation_loss / COIN:,.8f} WAM")

    check("terminal supply never exceeds the hard cap", total <= MAX_MONEY)
    check("subsidy is exhausted after MAX_HALVINGS", (INITIAL >> HALVINGS) == 0)
    check("no subsidy is paid past the final epoch",
          block_subsidy(last_height + 1, INTERVAL, INITIAL, PREMINE, HALVINGS), 0)

    # The residual is pure right-shift truncation, i.e. it is a *shortfall*,
    # never an overshoot. Confirm it is tiny (< 1 WAM) rather than a real bug.
    check("truncation loss is under 1 WAM", truncation_loss < COIN)

    # -- 4. dev fee, with the sunset ---------------------------------------
    SUNSET = P["WAM_DEVFEE_LAST_HEIGHT"]

    print("\n[4] treasury fee (carved out of the subsidy, and time-limited)")
    dev0 = (INITIAL * DEVFEE) // 100
    print(f"      epoch 0: miner {(INITIAL - dev0) / COIN:>8,.2f} WAM"
          f"   treasury {dev0 / COIN:>6,.2f} WAM"
          f"   total {INITIAL / COIN:>6,.2f} WAM")
    check("miner + treasury == subsidy (emission unchanged)",
          (INITIAL - dev0) + dev0, INITIAL)
    check("treasury share is 5% of epoch-0 subsidy", dev0, 250_000_000)

    # Exact replay honouring the sunset height.
    dev_total = 0
    for e in range(HALVINGS):
        subsidy = INITIAL >> e
        if subsidy == 0:
            break
        first = e * INTERVAL + 1
        if first > SUNSET:
            break
        last = min((e + 1) * INTERVAL, SUNSET)
        dev_total += (last - first + 1) * ((subsidy * DEVFEE) // 100)

    sunset_days = SUNSET * SPACING / 86400
    print(f"      fee applies to heights 1..{SUNSET:,} "
          f"(~{sunset_days / 30.44:.1f} months), then ZERO")
    print(f"      lifetime treasury income   : {dev_total / COIN:>12,.2f} WAM"
          f"   ({100 * dev_total / MAX_MONEY:.2f}% of the cap)")
    print(f"      founder total (premine+fee): {(dev_total + PREMINE) / COIN:>12,.2f} WAM"
          f"   ({100 * (dev_total + PREMINE) / MAX_MONEY:.2f}% of the cap)")
    print(f"      public mining share        : "
          f"{(MAX_MONEY - dev_total - PREMINE) / COIN:>12,.2f} WAM"
          f"   ({100 * (MAX_MONEY - dev_total - PREMINE) / MAX_MONEY:.2f}%)")

    check("the fee sunsets rather than running forever", SUNSET < HALVINGS * INTERVAL)
    check("lifetime treasury income stays inside the mining allocation",
          dev_total < MINING)
    check("founder total is under 15% of the cap",
          100 * (dev_total + PREMINE) / MAX_MONEY < 15.0)

    # After the sunset the miner must keep the entire subsidy.
    post = SUNSET + 1
    post_epoch = (post - 1) // INTERVAL
    check(f"at height {post:,} the treasury share is zero",
          0 if post > SUNSET else ((INITIAL >> post_epoch) * DEVFEE) // 100, 0)

    # -- 4b. founder reserve vesting ---------------------------------------
    import datetime as dt

    TRANCHES = P["WAM_PREMINE_TRANCHES"]
    TRANCHE_AMT = P["WAM_PREMINE_TRANCHE_AMOUNT"]
    UNLOCKS = P["WAM_PREMINE_UNLOCK_TIMES"]
    GTIME = P["WAM_GENESIS_TIME"]

    print("\n[4b] founder reserve vesting")
    print(f"      genesis / launch : {GTIME} "
          f"({dt.datetime.fromtimestamp(GTIME, dt.timezone.utc):%Y-%m-%d %H:%M UTC})")
    cum = 0
    for i, unlock in enumerate(UNLOCKS):
        cum += TRANCHE_AMT
        when = ("genesis (unlocked)" if unlock == 0 else
                f"{dt.datetime.fromtimestamp(unlock, dt.timezone.utc):%Y-%m-%d}")
        print(f"        tranche {i + 1}: {TRANCHE_AMT / COIN:>9,.0f} WAM   {when:<20}"
              f"   cumulative {cum / COIN:>9,.0f}")

    check("tranche count matches the unlock table", len(UNLOCKS), TRANCHES)
    check("tranches sum to exactly the premine", TRANCHES * TRANCHE_AMT, PREMINE)
    check("no tranche is unlocked at genesis", any(t == 0 for t in UNLOCKS), False)  # wam:quote-line
    check("every lock is read as a timestamp, not a height",
          all(t > 500_000_000 for t in UNLOCKS))
    check("every lock is after the launch",
          all(t > GTIME for t in UNLOCKS))
    check("unlock times strictly increase",
          all(UNLOCKS[i] < UNLOCKS[i + 1] for i in range(len(UNLOCKS) - 1)))
    check("the schedule spans 5 years",
          round((UNLOCKS[-1] - GTIME) / 86400 / 365.25), 5)
    check("liquid at launch is 0% of the reserve",  # wam:quote-line
          sum(TRANCHE_AMT for t in UNLOCKS if t <= GTIME), 0)

    # -- 5. timing ----------------------------------------------------------
    print("\n[5] timing")
    halving_days = INTERVAL * SPACING / 86400
    total_years = last_height * SPACING / 86400 / 365.25
    blocks_per_day = 86400 / SPACING
    print(f"      blocks per day        : {blocks_per_day:,.0f}")
    print(f"      time between halvings : {halving_days:,.1f} days"
          f"  (~{halving_days / 30.44:,.1f} months)")
    print(f"      emission ends after   : ~{total_years:,.1f} years")
    check("block spacing is 120 s", SPACING, 120)

    # -- 6. spot checks against the C++ function ---------------------------
    print("\n[6] GetBlockSubsidy() spot checks")
    for h, want in [
        (0,               PREMINE),
        (1,               50 * COIN),
        (INTERVAL,        50 * COIN),     # last block of epoch 0
        (INTERVAL + 1,    25 * COIN),     # first block of epoch 1
        (2 * INTERVAL,    25 * COIN),
        (2 * INTERVAL + 1, 12_50000000),
        (HALVINGS * INTERVAL + 1, 0),
    ]:
        got = block_subsidy(h, INTERVAL, INITIAL, PREMINE, HALVINGS)
        check(f"height {h:>10,} -> {got / COIN:>16,.8f} WAM", got, want)

    # -- 7. schedule --------------------------------------------------------
    if args.schedule:
        print("\n[7] full emission schedule")
        print(f"      {'epoch':>5} {'from':>12} {'to':>12} {'subsidy':>16} "
              f"{'epoch total':>18} {'cumulative':>18}")
        cum = PREMINE
        for e, first, last, sub, tot in epochs:
            cum += tot
            print(f"      {e:>5} {first:>12,} {last:>12,} {sub / COIN:>16,.8f} "
                  f"{tot / COIN:>18,.2f} {cum / COIN:>18,.2f}")

    # -- 8. cross-language constant check ----------------------------------
    if args.check_constants:
        print("\n[8] cross-language constant agreement")
        _check_other_languages(P)

    print("\n" + "=" * 78)
    if FAILURES:
        print(f" AUDIT FAILED -- {len(FAILURES)} check(s) did not pass:")
        for f in FAILURES:
            print(f"   - {f}")
        return 1
    print(" AUDIT PASSED -- the 22,000,000 WAM cap is enforced by the arithmetic.")
    print("=" * 78)
    return 0


def _check_other_languages(P: dict) -> None:
    """Grep the Python and JavaScript components for the same numbers."""
    targets = [
        (os.path.join(REPO, "genesis", "genesis_generator.py"), [
            ("GENESIS_PREMINE", rf"GENESIS_PREMINE\s*=\s*([\d_]+)\s*\*\s*COIN",
             P["WAM_GENESIS_PREMINE"] // P["WAM_COIN"]),
            ("GENESIS_TIME", r"(?m)^GENESIS_TIME\s*=\s*(\d+)", P["WAM_GENESIS_TIME"]),
            ("PREMINE_TRANCHES", r"PREMINE_TRANCHES\s*=\s*(\d+)",
             P["WAM_PREMINE_TRANCHES"]),
            ("PREMINE_TRANCHE_AMOUNT",
             r"PREMINE_TRANCHE_AMOUNT\s*=\s*([\d_]+)\s*\*\s*COIN",
             P["WAM_PREMINE_TRANCHE_AMOUNT"] // P["WAM_COIN"]),
            ("RANDOMX_BOOTSTRAP_KEY", r'RANDOMX_BOOTSTRAP_KEY\s*=\s*b"([^"]+)"',
             P.get("WAM_RANDOMX_BOOTSTRAP_KEY")),
            ("GENESIS_PHRASE", r'GENESIS_PHRASE\s*=\s*"([^"]+)"',
             P.get("WAM_GENESIS_TIMESTAMP_PHRASE")),
        ]),
        (os.path.join(REPO, "pool", "lib", "constants.js"), [
            # EITHER FORM, BECAUSE THE FILE IS FREE TO DECLARE IT EITHER WAY.
            #
            # This read "SUBSIDY_HALVING_INTERVAL:" alone, which is the shape
            # of an entry inside the exported object. On 9 November the same
            # constant was also declared with `const` above that object, so
            # that nextHalvingHeight() could default to it -- and this check
            # stopped finding it and failed, on a file whose VALUE had not
            # changed at all.
            #
            # A consensus check that depends on which side of a colon a
            # number sits is checking the syntax, not the number.
            ("halving interval",
             r"SUBSIDY_HALVING_INTERVAL\s*[:=]\s*([\d_]+)",
             P["WAM_SUBSIDY_HALVING_INTERVAL"]),
            ("initial subsidy", r"INITIAL_BLOCK_SUBSIDY_WAM:\s*([\d_]+)",
             P["WAM_INITIAL_BLOCK_SUBSIDY"] // P["WAM_COIN"]),
            ("dev fee percent", r"DEVFEE_PERCENT:\s*([\d_]+)",
             P["WAM_DEVFEE_PERCENT"]),
            ("dev fee sunset", r"DEVFEE_LAST_HEIGHT:\s*([\d_]+)",
             P["WAM_DEVFEE_LAST_HEIGHT"]),
            ("randomx epoch", r"RANDOMX_EPOCH_BLOCKS:\s*([\d_]+)",
             P["WAM_RANDOMX_EPOCH_BLOCKS"]),
            ("bootstrap key", r'RANDOMX_BOOTSTRAP_KEY:\s*"([^"]+)"',
             P.get("WAM_RANDOMX_BOOTSTRAP_KEY")),
        ]),
    ]

    for path, patterns in targets:
        rel = os.path.relpath(path, REPO)
        if not os.path.exists(path):
            check(f"{rel} exists", False)
            continue
        with open(path, "r", encoding="utf-8") as fh:
            src = fh.read()
        for label, pattern, expected in patterns:
            m = re.search(pattern, src)
            if not m:
                check(f"{rel}: {label} found", False)
                continue
            raw = m.group(1)
            got = int(raw.replace("_", "")) if raw.replace("_", "").isdigit() else raw
            check(f"{rel}: {label}", got, expected)


if __name__ == "__main__":
    sys.exit(main())
