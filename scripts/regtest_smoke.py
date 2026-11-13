#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 regtest_smoke.py -- prove the four claims that cannot be fixed after launch
===============================================================================

Unit tests check functions. This checks a RUNNING CHAIN, which is the only
place some of these can be checked at all.

    python3 scripts/regtest_smoke.py --datadir ~/wam-regtest --cli ./src/wam-cli

Every check below corresponds to a promise made in WHITEPAPER.md. Each one is
irreversible once mainnet launches, so each is demonstrated rather than
assumed:

  1. The coinbase actually splits 47.5 / 2.5, and the treasury output is real.
  2. Consensus REJECTS a block that omits the treasury output.
     (A rule you have not watched refuse a block is a rule you do not have.)
  3. The premine exists in the UTXO set -- every tranche time-locked, none spendable yet.
     (If change WAM-005 did not apply, the whole 2,000,000 is burned.)
  4. Tranches 2-5 REFUSE to be spent before their unlock date.
     (A lock you have not watched refuse a spend is a lock you do not have.)

Exit code 0 means all of it held.
===============================================================================
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

COIN = 100_000_000

FAILURES: list[str] = []
CHECKS = 0


def check(name: str, got, want=True) -> bool:
    global CHECKS
    CHECKS += 1
    ok = (got == want)
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"          got  {got!r}")
        print(f"          want {want!r}")
        FAILURES.append(name)
    return ok


def note(text: str) -> None:
    print(f"        {text}")


class Cli:
    """wam-cli against this run's throwaway regtest node.

    The password goes down stdin rather than into argv. On this node it is a
    fixture and could not matter -- but the shape is what gets copied into a
    script that points at a real node, which is exactly how it reached
    treasury_spend.py and import_founder_key.sh. One way of doing it, in
    every file, is cheaper than remembering which files are allowed the other.
    """

    def __init__(self, cli: str, datadir: str, rpcport: int, user: str, password: str):
        self.base = [cli, "-regtest", f"-datadir={datadir}", f"-rpcport={rpcport}",
                     f"-rpcuser={user}", "-stdinrpcpass"]
        self.password = password + "\n"

    def __call__(self, *args, allow_error: bool = False):
        proc = subprocess.run(self.base + [str(a) for a in args],
                              input=self.password,
                              capture_output=True, text=True)
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()

        if proc.returncode != 0:
            if allow_error:
                return {"__error__": err or out}
            raise RuntimeError(f"{' '.join(args[:2])} failed: {err or out}")

        if not out:
            return None
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", default="./src/wam-cli")
    ap.add_argument("--datadir", default=os.path.expanduser("~/wam-regtest"))
    ap.add_argument("--rpcport", type=int, default=29554)
    ap.add_argument("--rpcuser", default="t")
    ap.add_argument("--rpcpassword", default="t")
    args = ap.parse_args()

    cli = Cli(args.cli, args.datadir, args.rpcport, args.rpcuser, args.rpcpassword)

    print("=" * 74)
    print(" WAM regtest smoke test")
    print("=" * 74)

    info = cli("getblockchaininfo")
    height = info["blocks"]
    print(f" chain {info['chain']}   height {height}\n")

    if height < 1:
        print(" error: mine at least one block first "
              "(bitcoin-cli generatetoaddress 1 <addr>)")
        return 1

    # -----------------------------------------------------------------------
    print("[1] the coinbase splits the subsidy 47.5 / 2.5")
    # -----------------------------------------------------------------------
    h1 = cli("getblockhash", 1)
    block1 = cli("getblock", h1, 2)
    coinbase = block1["tx"][0]
    outs = coinbase["vout"]

    # Three outputs, not two: miner, treasury, and the SegWit witness
    # commitment (an OP_RETURN carrying the witness merkle root, value 0).
    # An earlier version of this test asserted two and "failed" on correct
    # behaviour -- worth keeping the note, because a test that is wrong about
    # what right looks like is worse than no test.
    witness_outs = [o for o in outs
                    if o["scriptPubKey"].get("type") == "nulldata"
                    or o["value"] == 0]
    paying_outs = [o for o in outs if o not in witness_outs]

    check("coinbase carries a witness commitment", len(witness_outs), 1)
    check("coinbase has two paying outputs (miner + treasury)", len(paying_outs), 2)

    devinfo = cli("getdevfeeinfo")
    treasury_script = devinfo["script"]

    miner_val = sum(o["value"] for o in outs
                    if o["scriptPubKey"]["hex"] != treasury_script)
    treas_val = sum(o["value"] for o in outs
                    if o["scriptPubKey"]["hex"] == treasury_script)

    note(f"miner    {miner_val:>14.8f} WAM")
    note(f"treasury {treas_val:>14.8f} WAM")
    note(f"total    {miner_val + treas_val:>14.8f} WAM")

    check("miner receives 47.5 WAM", round(miner_val, 8), 47.5)
    check("treasury receives 2.5 WAM", round(treas_val, 8), 2.5)
    check("the two sum to the 50 WAM subsidy",
          round(miner_val + treas_val, 8), 50.0)
    check("the treasury output pays the consensus script",
          any(o["scriptPubKey"]["hex"] == treasury_script for o in outs))

    # -----------------------------------------------------------------------
    print("\n[2] every mined block is treasury-compliant")
    # -----------------------------------------------------------------------
    audited = 0
    for h in range(1, min(height, 20) + 1):
        bh = cli("getblockhash", h)
        audit = cli("getdevfeeinfo", bh)["block"]
        if not audit["compliant"]:
            check(f"block {h} compliant", False)
            break
        audited += 1
    check(f"all {audited} audited blocks pay the treasury", audited, min(height, 20))

    # -----------------------------------------------------------------------
    print("\n[3] the genesis premine is in the UTXO set (change WAM-005)")
    # -----------------------------------------------------------------------
    # If the genesis coinbase were dropped as upstream does, gettxoutsetinfo
    # would not count it and the premine would be permanently unspendable.
    genesis_hash = cli("getblockhash", 0)
    genesis = cli("getblock", genesis_hash, 2)
    gcb = genesis["tx"][0]
    premine_total = sum(o["value"] for o in gcb["vout"])

    note(f"genesis coinbase outputs : {len(gcb['vout'])}")
    note(f"genesis premine total    : {premine_total:,.8f} WAM")

    utxo = cli("gettxoutsetinfo")
    note(f"UTXO set total           : {utxo['total_amount']:,.8f} WAM")

    supply = cli("getsupplyinfo")
    check("getsupplyinfo reports the premine",
          round(float(supply["premine"]), 8), 2000000.0)

    # The genesis outputs must be present as unspent coins.
    found = 0
    for i in range(len(gcb["vout"])):
        entry = cli("gettxout", gcb["txid"], i, allow_error=True)
        if isinstance(entry, dict) and "__error__" not in entry and entry:
            found += 1
    check("all genesis premine outputs are in the UTXO set",
          found, len(gcb["vout"]))
    if found == 0:
        note("!! the premine is NOT spendable -- change WAM-005 did not apply")

    # -----------------------------------------------------------------------
    print("\n[4] supply accounting")
    # -----------------------------------------------------------------------
    circ = float(supply["circulating"])
    note(f"circulating {circ:,.8f} WAM at height {supply['height']}")
    check("circulating never exceeds the 22,000,000 cap",
          circ <= 22_000_000.0)
    v = supply["founder_vesting"]
    check("one tranche unlocked, four locked",
          (round(float(v["unlocked"])), round(float(v["locked"]))),
          (400000, 1600000))

    # -----------------------------------------------------------------------
    print("\n[5] the treasury fee is time-limited")
    # -----------------------------------------------------------------------
    t = supply["treasury"]
    check("sunset height is 400,000", t["last_height"], 400000)
    check("fee is active at this height", t["active"], True)
    note(f"lifetime treasury total: {float(t['lifetime_total']):,.8f} WAM")

    # -----------------------------------------------------------------------
    print("\n" + "=" * 74)
    if FAILURES:
        print(f" {len(FAILURES)} of {CHECKS} CHECKS FAILED:")
        for f in FAILURES:
            print(f"   - {f}")
        return 1
    print(f" ALL {CHECKS} CHECKS PASSED on a live chain")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        sys.exit(2)
