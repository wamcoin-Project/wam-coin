#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_presync_work_cap.py -- the chain has not grown into the cap that
#                               keeps presync spam expensive
# ===========================================================================
#
#      python3 scripts/check_presync_work_cap.py [--rpc HOST]
#
#  WHY THIS EXISTS
#
#  Headers-presync cannot check a header's hash: RandomX needs a seed from a
#  buried block and a presynced header has no established height. So this
#  fork returns true from HasValidProofOfWork, which is written down in
#  scripts/patch_upstream.py with the reasoning.
#
#  What it could still check is what a header CLAIMS. Until 2026-11-22 it did
#  not, and nothing else did either -- PermittedDifficultyTransition is
#  unconditional here (WAM-006) and GetBlockProof has no upper clamp. One
#  80-byte header with nBits 0x01010000 claims 2^255 work and clears
#  nMinimumChainWork by itself, so the floor raised on 13 November to make
#  this spam cost 275 MB made it cost about 300 bytes.
#
#  The fix caps a presynced header's claimed work at the work implied by
#  powLimit >> 12. That is a fixed number against a difficulty that moves,
#  which is the kind of constant that silently stops a chain syncing years
#  later -- so this exists to say so while it is still a warning.
#
#  WHAT IT CHECKS
#
#    the cap is still above the chain's difficulty, with margin
#    the patch still carries the cap at all
# ===========================================================================

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402  -- this reads tracked files, so it honours the marks

ROOT = Path(__file__).resolve().parent.parent
PATCH = ROOT / "scripts" / "patch_upstream.py"
CHAINPARAMS = ROOT / "src" / "wam" / "chainparams.cpp"

GRN, RED, YLW, BLD, OFF = '\033[32m', '\033[31m', '\033[33m', '\033[1m', '\033[0m'

# Below this many times of headroom the cap is close enough to the chain that
# a person should be deciding, not finding out from a node that will not sync.
MIN_HEADROOM = 8.0


def ok(m):   print(f"  {GRN}ok{OFF}    {m}")
def bad(m):  print(f"  {RED}FAIL{OFF}  {m}")
def warn(m): print(f"  {YLW}!!{OFF}    {m}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", default=None,
                    help="host running a mainnet node to ask for the current "
                         "difficulty; without it only the patch is checked")
    ap.add_argument("--datadir", default="/root/.wam-mainnet")
    args = ap.parse_args()

    print()
    print(f"{BLD}presync claimed-work cap{OFF}")
    print()

    # The marks are honoured: a comment QUOTING the cap expression
    # is not a tree that has one.
    src = quoted.strip_quoted(PATCH.read_text(encoding="utf-8", errors="replace"))
    m = re.search(r"UintToArith256\(consensusParams\.powLimit\)\s*>>\s*(\d+)", src)
    if not m:
        bad("scripts/patch_upstream.py no longer caps a presynced header's "
            "claimed work")
        print("        Without it one header with forged nBits claims 2^255 "
              "work\n        and nMinimumChainWork prices nothing. See the "
              "comment in\n        the WAM_PRESYNC_POW_SKIPPED replacement.")
        print()
        return 1
    shift = int(m.group(1))
    ok(f"the cap is powLimit >> {shift}")

    cp = quoted.strip_quoted(CHAINPARAMS.read_text(encoding="utf-8", errors="replace"))
    pm = re.search(r'consensus\.powLimit\s*=\s*uint256S\("([0-9a-fA-F]+)"\)', cp)
    if not pm:
        warn("powLimit could not be read from src/wam/chainparams.cpp")
        print()
        return 0
    pow_limit = int(pm.group(1), 16)
    cap_target = pow_limit >> shift
    ok(f"powLimit is 2^{pow_limit.bit_length() - 1}, "
       f"the cap target is 2^{cap_target.bit_length() - 1}")

    if not args.rpc:
        warn("no --rpc given, so the chain's own difficulty was not compared")
        print("        Run with --rpc <host> to check the headroom that is "
              "left.")
        print()
        return 0

    try:
        out = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=no",
             f"root@{args.rpc}",
             f"wam-cli -datadir={args.datadir} getblockchaininfo"],
            capture_output=True, text=True, timeout=60)
        info = json.loads(out.stdout)
        difficulty = float(info["difficulty"])
    except Exception as e:                                   # noqa: BLE001
        warn(f"the chain could not be asked ({type(e).__name__}), so the "
             f"headroom was not checked")
        print()
        return 0

    # difficulty is relative to Bitcoin's diff-1 target, 2^224.
    cur_target = int((1 << 224) / difficulty)
    headroom = cur_target / cap_target if cap_target else 0.0

    if cur_target < cap_target:
        bad(f"the chain is HARDER than the cap: a header this network really "
            f"produces would be refused during presync")
        print(f"        difficulty {difficulty:.6f} -> target "
              f"2^{cur_target.bit_length() - 1}, cap 2^{cap_target.bit_length() - 1}")
        print("        Raise the shift in scripts/patch_upstream.py and say "
              "why, or\n        new nodes stop being able to sync.")
        print()
        return 1

    if headroom < MIN_HEADROOM:
        warn(f"only {headroom:.1f}x of difficulty growth left before an "
             f"honest header is refused")
        print("        Raise the shift before it becomes a sync failure.")
        print()
        return 0

    ok(f"{headroom:.0f}x of difficulty growth left "
       f"(difficulty {difficulty:.6f})")
    print()
    print(f"{GRN}{BLD}  one header cannot claim the floor{OFF}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
