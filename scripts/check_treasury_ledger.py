#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_treasury_ledger.py -- the ledger's own numbers, against the chain
===============================================================================

     python3 scripts/check_treasury_ledger.py --node 169.58.159.165

 WHY THIS EXISTS

 docs/TREASURY_LEDGER.md does not merely record the spends. It invites the
 reader to check them:

     2.5 x height  -  (every amount below + every fee below)

     At height N that is ... which is what `scantxoutset` returns. Two
     independent routes to the same number, to the last decimal place.

 That is the strongest sentence in the file and the only one that can rot
 without anybody touching it, because the chain moves on its own. On
 2026-10-11 it had: the worked example still stood at height 4,989 and
 subtracted 500 WAM, while ten further rows -- 10,010 WAM of bounty -- sat in
 the table underneath it. A reader who did what the file told him to do would
 have got a number 10,010 WAM away from the chain's, in a file about where the
 money went. Nothing in this repository noticed for nine days.

 check_treasury_claims.py already compares what we SAY about the money to the
 ledger. Nothing compared the LEDGER to the chain. This is that half.

 WHAT THIS DOES

 Four questions, and the third is the one that matters:

   1. every row is a real transaction that pays the stated amount to the
      stated address, and whose fee is the stated fee
   2. the stated balance is not older than the newest row, and is what the
      arithmetic gives at the height it names
   3. accrued(tip) - (every amount + every fee) == what the chain holds now

      If a coin ever leaves the treasury without a row, this is what finds
      it. No address index and no block scan: the identity cannot hold with
      a spend missing from the table.

   4. the worked example in the prose agrees with the table it describes

 The accrual is consensus, not a constant copied into this file:

     halvings = (height - 1) // WAM_SUBSIDY_HALVING_INTERVAL
     subsidy  = WAM_INITIAL_BLOCK_SUBSIDY >> halvings
     treasury = subsidy * WAM_DEVFEE_PERCENT // 100, for heights 1..400,000

 -- the same integer arithmetic as src/wam/consensus/subsidy.cpp, with every
 constant read out of src/wam/wam-params.h at run time. A halving that this
 script did not expect cannot make it disagree with the chain.

 EXIT CODES, this project's convention

     0  every row is on the chain and the identity holds to the atom
     1  a row is wrong, a number is stale, or coins left without a row
     2  the node could not be asked, so nothing was checked
===============================================================================
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402
from wamcli import flags as _wamcli_flags          # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

LEDGER = "docs/TREASURY_LEDGER.md"
PARAMS = "src/wam/wam-params.h"
TREASURY = "WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE"

# Coins are compared as integer atoms. A float sum of eleven rows does not
# land on the chain's number, and "to the last decimal place" is the claim
# being checked.
ATOM = 100_000_000


def atoms(x):
    """A coin amount as an exact integer, from a string or a float."""
    return int(round(float(x) * ATOM))


def rsh(host, cmd, timeout=180):
    if not host:
        p = subprocess.run(["bash", "-lc", cmd], capture_output=True,
                           text=True, timeout=timeout)
    else:
        p = subprocess.run(["ssh", "-o", "BatchMode=yes",
                            "-o", "ConnectTimeout=15", f"root@{host}", cmd],
                           capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


# ---------------------------------------------------------------------------
# consensus, read rather than assumed
# ---------------------------------------------------------------------------

def consensus_constants(text):
    """The three numbers the treasury accrual is made of, from wam-params.h."""
    def one(name, pattern):
        m = re.search(pattern, text)
        if not m:
            raise LookupError(name)
        return int(m.group(1).replace("'", "").replace("_", ""))

    return {
        "subsidy": one("WAM_INITIAL_BLOCK_SUBSIDY",
                       r"WAM_INITIAL_BLOCK_SUBSIDY\s*=\s*(\d+)\s*\*\s*WAM_COIN"),
        "interval": one("WAM_SUBSIDY_HALVING_INTERVAL",
                        r"WAM_SUBSIDY_HALVING_INTERVAL\s*=\s*([\d'_]+)"),
        "percent": one("WAM_DEVFEE_PERCENT",
                       r"WAM_DEVFEE_PERCENT\s*=\s*(\d+)"),
        "start": one("WAM_DEVFEE_START_HEIGHT",
                     r"WAM_DEVFEE_START_HEIGHT\s*=\s*([\d'_]+)"),
        "last": one("WAM_DEVFEE_LAST_HEIGHT",
                    r"WAM_DEVFEE_LAST_HEIGHT\s*=\s*([\d'_]+)"),
        "max_halvings": one("WAM_MAX_HALVINGS",
                            r"WAM_MAX_HALVINGS\s*=\s*(\d+)"),
    }


def treasury_at(height, k):
    """What WAM-1 pays the treasury at one height, in atoms.

    The same integer steps as GetBlockSubsidy and GetDevFeeAmount, in the
    same order. Floating point is not used anywhere in here."""
    if height < k["start"] or height > k["last"]:
        return 0
    halvings = (height - 1) // k["interval"]
    if halvings >= k["max_halvings"]:
        return 0
    subsidy = (k["subsidy"] * ATOM) >> halvings
    return (subsidy * k["percent"]) // 100


def accrued_through(height, k):
    """Everything WAM-1 has paid the treasury up to and including `height`.

    Summed per halving epoch rather than per block, so the tip's height costs
    a handful of multiplications instead of eighteen thousand additions."""
    total = 0
    h = max(k["start"], 1)
    while h <= min(height, k["last"]):
        epoch_end = min(height, k["last"],
                        ((h - 1) // k["interval"] + 1) * k["interval"])
        total += treasury_at(h, k) * (epoch_end - h + 1)
        h = epoch_end + 1
    return total


# ---------------------------------------------------------------------------
# the file
# ---------------------------------------------------------------------------

# | date | amount | fee | to | reason | txid |
# wam:quote-begin
ROW = re.compile(
    r"^\|\s*(?P<date>\d{4}-\d{2}-\d{2})\s*\|\s*\*\*(?P<amount>[\d.]+)\s*WAM\*\*"
    r"\s*\|\s*`(?P<fee>[\d.]+)`\s*\|\s*`(?P<to>\w+)`\s*\|"
    r".*?txid\s*`(?P<txid>[0-9a-f]{64})`\s*\|\s*$")
# wam:quote-end

BALANCE = re.compile(
    r"\*\*Balance after the last line:\*\*\s*`([\d,.]+)\s*WAM`.*?"
    r"at\s*height\s*([\d,]+)", re.S)

EXAMPLE = re.compile(
    r"At height ([\d,]+) that is `2\.5 × ([\d,]+) − ([\d,.]+) − ([\d,.]+) \+\s*"
    r"([\d,.]+) =\s*([\d,.]+)`", re.S)

# WHAT ARRIVED THAT CONSENSUS DID NOT PAY.
#
# The identity was accrued - spent for two months and was true, until
# somebody authorized on this project's own pool with the TREASURY address
# as their payout address and mined into it: 666.49347736 WAM across 372
# payout batches, the pool's records and the chain agreeing to the satoshi.
#
# This check is how it was found. It reported the chain holding exactly that
# much more than the table accounted for, which reads as a spend recorded
# twice -- and every one of the 36 rows then checked out against the chain,
# each one's net effect equalling its amount plus its fee. The rows were
# right and the equation was short a term.
#
# The figure is READ FROM THE LEDGER rather than written here, so there is
# one place to change it and the document a reader checks is that place. It
# is closed: since 19 November 2026 the pool refuses that address at
# mining.authorize, so nothing adds to it. If anything does, this check
# fails again, which is what it is for.
ARRIVED = re.compile(r"\+\s*([\d,.]+)\s+\(see \"Money that arrived\"", re.S)


def num(s):
    return s.replace(",", "")


def rows_of(text):
    out = []
    for line in text.splitlines():
        m = ROW.match(line)
        if m:
            out.append(m.groupdict())
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--node", help="ssh host running the node; omit to ask "
                                   "this machine")
    ap.add_argument("--network", default="mainnet",
                    choices=["mainnet", "testnet", "regtest"])
    a = ap.parse_args()

    print(f"\n{BLD}the ledger's own numbers, against the chain{OFF}\n")

    # A ROW WRITTEN AS AN EXAMPLE IS NOT A SPEND.
    #
    # Both files this reads are prose that people edit, and both can show
    # what they are talking about: the ledger can carry a specimen row to
    # explain its own table, and wam-params.h can quote a number in a comment
    # while declaring another. Read literally, the first becomes a payment
    # nobody made and the second a consensus constant nobody set -- and this
    # check would then accuse the ledger of hiding money, which is the worst
    # thing in this repository to be wrong about.
    #
    # scripts/lib/quoted.py is the convention: an author marks the specimen,
    # and every check drops what is marked before it reads anything.
    try:
        text = quoted.strip_quoted(
            (ROOT / LEDGER).read_text(encoding="utf-8", errors="replace"))
        k = consensus_constants(quoted.strip_quoted(
            (ROOT / PARAMS).read_text(encoding="utf-8", errors="replace")))
    except OSError as e:
        print(f"  {YEL}could not read the sources ({e}) -- nothing was "
              f"checked{OFF}\n")
        return 2
    except LookupError as e:
        print(f"  {YEL}{PARAMS} no longer declares {e} -- nothing was "
              f"checked{OFF}\n")
        return 2

    rows = rows_of(text)
    if not rows:
        print(f"  {YEL}no spend rows could be read out of {LEDGER} -- either "
              f"the treasury has never moved, or the table's shape changed "
              f"and this check is blind. Nothing was checked.{OFF}\n")
        return 2

    cli = f"wam-cli {_wamcli_flags(a.network)}"

    # THE HEIGHT AND THE BALANCE MUST DESCRIBE ONE CHAIN STATE.
    #
    # This asked getblockcount and then ran scantxoutset, and failed on its
    # first real run with "off by -2.50000000 WAM -- the chain holds MORE than
    # the table accounts for". Nothing was wrong with the ledger. A block had
    # arrived between the two calls: the scan counted a treasury output that
    # the accrual, computed at the earlier height, did not. 2.5 WAM, which is
    # exactly one block, every time.
    #
    # Blocks come every two minutes and the scan takes about one on 10,000
    # outputs, so the window is wide and the failure is intermittent -- the
    # worst kind of check, because an intermittent accusation about missing
    # money teaches the reader to ignore it.
    #
    # scantxoutset answers with the height and the best block it scanned at.
    # Taking the height from the scan makes the two consistent by
    # construction rather than by being quick.
    rc, out, err = rsh(a.node,
                       f"{cli} scantxoutset start '[\"addr({TREASURY})\"]'",
                       timeout=300)
    if rc != 0:
        first = (err or out or "no answer").splitlines()[0][:90]
        print(f"  {YEL}scantxoutset did not answer ({first}). Nothing was "
              f"checked.{OFF}\n")
        return 2
    scan = json.loads(out)
    if not scan.get("success") or "height" not in scan:
        print(f"  {YEL}the scan did not complete, so the balance it reports "
              f"is not a balance. Nothing was checked.{OFF}\n")
        return 2
    tip = int(scan["height"])
    held = atoms(scan["total_amount"])

    print(f"  height {tip} ({scan.get('bestblock', '')[:16]}...), "
          f"{len(rows)} row(s) in the ledger, "
          f"{len(scan['unspents'])} unspent output(s)\n")

    # --- 1. every row is the transaction it says it is --------------------
    bad = []
    spent = 0
    heights = {}
    newest_row_height = 0
    by_height = []
    for r in rows:
        rc, out, err = rsh(a.node, f"{cli} getrawtransaction {r['txid']} 2")
        if rc != 0:
            bad.append((r, "the chain does not have this transaction"))
            continue
        tx = json.loads(out)
        paid = sum(atoms(o["value"]) for o in tx["vout"]
                   if o["scriptPubKey"].get("address") == r["to"])
        want = atoms(r["amount"])
        if paid != want:
            bad.append((r, "it pays %s WAM to that address, the row says %s"
                        % (paid / ATOM, want / ATOM)))
        fee = atoms(tx.get("fee", 0))
        if fee != atoms(r["fee"]):
            bad.append((r, "its fee is %.8f WAM, the row says %s"
                        % (fee / ATOM, r["fee"])))
        stray = sorted({o["scriptPubKey"].get("address") for o in tx["vout"]}
                       - {r["to"], TREASURY, None})
        if stray:
            bad.append((r, "it also pays an address in neither the row nor "
                           "the treasury: %s" % stray[0]))
        # The row's block height, from the block rather than from a
        # confirmation count: a count is relative to whatever the tip was
        # during THIS call, and the tip used for the accrual came from the
        # scan. Mixing the two puts a row one block out. Cached, because
        # nineteen rows live in a handful of blocks.
        bh = tx.get("blockhash")
        if bh:
            if bh not in heights:
                rc, bout, _ = rsh(a.node, f"{cli} getblock {bh} 1")
                heights[bh] = (json.loads(bout)["height"]
                               if rc == 0 else None)
            h = heights[bh]
            if h is not None:
                newest_row_height = max(newest_row_height, h)
                by_height.append((h, want + fee))
        spent += want + fee

    for r, why in bad:
        print(f"  {RED}FAIL{OFF}  {r['date']}  {r['amount']} WAM  "
              f"{r['txid'][:16]}...")
        print(f"          {why}")
    if not bad:
        print(f"  {GRN}ok{OFF}    every row pays what it says, to whom it "
              f"says, for the fee it says")

    # --- 2 and 3. the identity ---------------------------------------------
    #
    # Three terms, not two. See ARRIVED above for why the third exists and
    # why it is read from the ledger rather than written here.
    am = ARRIVED.search(text)
    arrived = atoms(num(am.group(1))) if am else 0
    if not am:
        print(f"  {YEL}the ledger states no arrived figure, so the identity "
              f"is read as accrued - spent{OFF}")

    expected = accrued_through(tip, k) - spent + arrived
    print(f"\n  accrued through {tip}   {accrued_through(tip, k) / ATOM:>18.8f}")
    print(f"  less the table         {spent / ATOM:>18.8f}")
    if arrived:
        print(f"  plus what arrived      {arrived / ATOM:>18.8f}")
    print(f"  = should be held       {expected / ATOM:>18.8f}")
    print(f"  the chain holds        {held / ATOM:>18.8f}")

    if expected != held:
        d = expected - held
        print(f"\n  {RED}FAIL{OFF}  off by {d / ATOM:+.8f} WAM")
        if d > 0:
            print("          The chain holds LESS than the table accounts "
                  "for, which")
            print("          means coins left the treasury without a row. "
                  "That is the")
            print("          one thing this file exists to make impossible.")
        else:
            print("          The chain holds MORE than the table accounts "
                  "for: a row")
            print("          overstates what left, or a spend was recorded "
                  "twice.")
        bad.append(("identity", "the arithmetic does not reach the chain"))
    else:
        print(f"\n  {GRN}ok{OFF}    the identity holds to the atom -- nothing "
              f"left the treasury unrecorded")

    # --- 4. the stated balance, and the worked example ---------------------
    stale = []
    m = BALANCE.search(text)
    if not m:
        stale.append("the file no longer states a balance, so a reader has "
                     "nothing to check")
    else:
        said, at_h = atoms(num(m.group(1))), int(num(m.group(2)))
        if at_h < newest_row_height:
            stale.append("the stated balance is at height %d, and the newest "
                         "row was mined at %d -- it predates a spend in its "
                         "own table" % (at_h, newest_row_height))
        else:
            then = accrued_through(at_h, k) - sum(v for h, v in by_height
                                                  if h <= at_h)
            if then != said:
                stale.append("the stated balance at height %d is %.8f, and "
                             "the table gives %.8f"
                             % (at_h, said / ATOM, then / ATOM))

    m = EXAMPLE.search(text)
    if not m:
        stale.append("the worked example is gone, and it is the only thing "
                     "that shows a reader how to check the rest")
    else:
        at_h = int(num(m.group(1)))
        if int(num(m.group(2))) != at_h:
            stale.append("the worked example says height %s on one side and "
                         "%s on the other" % (m.group(1), m.group(2)))
        amounts = sum(atoms(r["amount"]) for r in rows)
        fees = sum(atoms(r["fee"]) for r in rows)
        if (atoms(num(m.group(3))) != amounts
                or atoms(num(m.group(4))) != fees):
            stale.append("the worked example subtracts %s and %s; the table "
                         "adds up to %.8f and %.8f"
                         % (m.group(3), m.group(4), amounts / ATOM,
                            fees / ATOM))
        elif atoms(num(m.group(5))) != arrived:
            stale.append("the worked example adds %s as what arrived; the "
                         "equation above it says %.8f"
                         % (m.group(5), arrived / ATOM))
        elif (atoms(num(m.group(6)))
              != accrued_through(at_h, k) - amounts - fees + arrived):
            stale.append("the worked example does not come out at the number "
                         "it prints")

    print()
    for s in stale:
        print(f"  {RED}FAIL{OFF}  {s}")
    if not stale:
        print(f"  {GRN}ok{OFF}    the balance and the worked example agree "
              f"with the table")

    print()
    if bad or stale:
        print(f"  {RED}{BLD}the ledger and the chain do not agree{OFF}")
        print(f"  {LEDGER} tells every reader to check it against a node.")
        print("  Until this passes, doing so makes the project look worse")
        print("  than saying nothing would have.\n")
        return 1

    print(f"  {GRN}{BLD}the ledger is what the chain says it is{OFF}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
    except subprocess.TimeoutExpired:
        print(f"\n  {YEL}the node took too long. Nothing was checked.{OFF}\n")
        sys.exit(2)
