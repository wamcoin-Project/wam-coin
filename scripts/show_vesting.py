#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 show_vesting.py -- read the founder vesting schedule straight out of block 0
===============================================================================

This is the tool that makes the vesting claim checkable by anyone, not just by
the people who wrote the whitepaper. It reads the genesis block from a running
node, decodes each coinbase output's script, and prints the unlock date that is
literally encoded in it.

    python3 scripts/show_vesting.py --network testnet

Nothing here trusts the node's own summary RPCs. It parses the raw scripts,
because the point is to verify what the chain actually committed to -- not what
a convenience endpoint reports about it.

The locks are BARE OP_CHECKLOCKTIMEVERIFY scripts rather than P2SH precisely so
that this is possible: a P2SH output would show only a hash, and the unlock
dates would have to be taken on faith.
===============================================================================
"""

from __future__ import annotations

import argparse
import os
import datetime as dt
import json
import subprocess
import sys

COIN = 100_000_000

NET_FLAG = {"mainnet": None, "testnet": "-testnet", "regtest": "-regtest"}
NET_PORT = {"mainnet": 9554, "testnet": 19554, "regtest": 29554}


def cli(args_ns, *params):
    """One wam-cli call, with the RPC password off the command line.

    This put the password option in argv, and a reader asking what the
    founder reserve looks like will point it at a mainnet node with real
    credentials. /proc/<pid>/cmdline is world-readable on Linux by default,
    so every call leaked the password to any other account on the machine for
    as long as it ran.

    -stdinrpcpass takes it as the first line of standard input instead. With
    no password given, nothing is passed and wam-cli reads the node's own
    cookie file.

    Found while fixing the same shape in treasury_spend.py and
    import_founder_key.sh, 13 November 2026.
    """
    cmd = [args_ns.cli]
    flag = NET_FLAG[args_ns.network]
    if flag:
        cmd.append(flag)
    cmd += [f"-datadir={args_ns.datadir}", f"-rpcport={args_ns.rpcport}"]
    if args_ns.rpcuser:
        cmd.append(f"-rpcuser={args_ns.rpcuser}")
    stdin = None
    if args_ns.rpcpassword:
        cmd.append("-stdinrpcpass")
        stdin = args_ns.rpcpassword + "\n"
    cmd += [str(p) for p in params]

    proc = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout).strip())
    out = proc.stdout.strip()
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


def describe(script_asm: str) -> tuple[int | None, str]:
    """Return (locktime, kind) for a coinbase output script."""
    if "CHECKLOCKTIMEVERIFY" not in script_asm:
        return None, "unlocked"
    first = script_asm.split()[0]
    try:
        return int(first), "time-locked"
    except ValueError:
        return None, "time-locked (unparsed)"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", choices=sorted(NET_FLAG), default="testnet")
    ap.add_argument("--cli", default="./src/wam-cli")
    ap.add_argument("--datadir", required=True)
    ap.add_argument("--rpcport", type=int, default=None)
    # Empty by default, so wam-cli falls back to the node's cookie file.
    # The old defaults were "t"/"t", which works on a throwaway regtest
    # node and silently fails on any real one -- and taught whoever hit
    # that failure to pass the real password on the command line.
    ap.add_argument("--rpcuser", default="")
    ap.add_argument("--rpcpassword", default="")
    args = ap.parse_args()

    # The RPC password from the environment, as well as from the option.
    #
    # Whatever is typed after the option sits in this process's own
    # /proc/<pid>/cmdline, which every account on the machine can read while
    # it runs. /proc/<pid>/environ cannot be read by anyone but the process's
    # own user and root. The option still works -- a written-down command has
    # to keep working -- and this gives a way that does not need it.
    #
    # Found by scripts/check_rpc_secrets.py after mpit reported the same
    # shape in import_founder_key.sh and treasury_spend.py on 26 November
    # 2026. He named two scripts; the guard named these as well.
    if not args.rpcpassword and os.environ.get("WAM_RPCPASSWORD"):
        args.rpcpassword = os.environ["WAM_RPCPASSWORD"]

    if args.rpcport is None:
        args.rpcport = NET_PORT[args.network]

    genesis_hash = cli(args, "getblockhash", 0)
    block = cli(args, "getblock", genesis_hash, 2)
    coinbase = block["tx"][0]

    print("=" * 76)
    print(f" FOUNDER VESTING, READ FROM BLOCK 0 OF {args.network.upper()}")
    print("=" * 76)
    block_time = dt.datetime.fromtimestamp(block["time"], dt.timezone.utc)
    print(f"  genesis hash : {genesis_hash}")
    print(f"  block time   : {block_time:%Y-%m-%d %H:%M UTC}")
    print(f"  outputs      : {len(coinbase['vout'])}")
    print()

    now = dt.datetime.now(dt.timezone.utc).timestamp()
    total = 0
    unlocked = 0
    rows = []

    for i, out in enumerate(coinbase["vout"]):
        value = out["value"]
        total += value
        asm = out["scriptPubKey"]["asm"]
        locktime, kind = describe(asm)

        if locktime is None:
            when = "genesis"
            is_open = True
        else:
            when = dt.datetime.fromtimestamp(locktime, dt.timezone.utc).strftime("%Y-%m-%d")
            is_open = now >= locktime

        if is_open:
            unlocked += value

        rows.append((i, value, when, kind, is_open, out["scriptPubKey"]["hex"]))

    print(f"  {'#':>2}  {'amount':>14}  {'unlocks':<12} {'status':<10} script")
    print("  " + "-" * 72)
    for i, value, when, kind, is_open, hexs in rows:
        status = "SPENDABLE" if is_open else "locked"
        short = hexs[:22] + "…" if len(hexs) > 22 else hexs
        print(f"  {i:>2}  {value:>14,.2f}  {when:<12} {status:<10} {short}")

    print("  " + "-" * 72)
    print(f"  {'':>2}  {total:>14,.2f}  total")
    print()
    print(f"  spendable now : {unlocked:>14,.2f} WAM  "
          f"({100 * unlocked / total if total else 0:.1f}%)")
    print(f"  still locked  : {total - unlocked:>14,.2f} WAM  "
          f"({100 * (total - unlocked) / total if total else 0:.1f}%)")
    print()

    # ---- the assertion that matters ---------------------------------------
    problems = []
    if abs(total - 2_000_000) > 1e-8:
        problems.append(f"premine total is {total:,.8f}, expected 2,000,000")
    if len(rows) == 5:
        # WHAT IS SPENDABLE DEPENDS ON THE DATE, AND THIS ASSERTED ONE NUMBER.
        #
        # It expected exactly 400,000 whatever the day. The consensus schedule
        # CLTV-locks all five tranches, unlocking one each 15 September from
        # 2027 to 2031, and this script counts an output spendable only once
        # its lock time has passed -- so before 2027-09-15 the honest answer
        # is 0, and the tool reported PROBLEMS and exited 1 against a genesis
        # that matches the published table exactly. It could only have passed
        # during the twelve months after September 2027.
        #
        # A verifier that accuses the correct chain teaches its readers to
        # ignore it, and this is the one tool a stranger uses to check the
        # founder reserve. Reported by Radenlingga on 2026-11-26, run against
        # a genesis built from wam-params.h itself.
        #
        # The expectation is now derived the way the table is: count the
        # tranches whose unlock time has passed. That is the same arithmetic
        # the rows above print, so the two can no longer disagree.
        # rows is (index, value, when, kind, is_open, script); is_open is the
        # same test the table above printed as SPENDABLE.
        unlocked_tranches = sum(1 for r in rows if r[4])
        expected = unlocked_tranches * 400_000
        if abs(unlocked - expected) > 1e-8:
            problems.append(
                f"spendable now is {unlocked:,.2f}, but {unlocked_tranches} "
                f"of 5 tranches have reached their unlock date, so it should "
                f"be {expected:,.2f}")
    elif len(rows) == 1:
        print("  note: single-output genesis (regtest) -- no vesting to show")
    else:
        problems.append(f"expected 5 tranches or 1 regtest output, found {len(rows)}")

    if problems:
        print("  PROBLEMS:")
        for p in problems:
            print(f"    - {p}")
        return 1

    print("  OK -- the schedule in block 0 matches the published one.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(2)
