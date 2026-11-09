#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_min_chain_work.py -- is there a floor under what this node will follow?
# ===========================================================================
#
#      python3 scripts/check_min_chain_work.py            # testnet
#      python3 scripts/check_min_chain_work.py --network mainnet
#
#  WHY THIS EXISTS
#
#  consensus.nMinimumChainWork is the least total work a chain must carry
#  before a node will follow it at all. Zero means "follow whoever shows me
#  the heaviest chain", and for a young network that is not theoretical.
#
#  On 6 September 2026 the test network carried 6.63 billion hashes of work
#  across 5,897 blocks. At the difficulty floor a block costs about 1.05
#  million hashes, so ten ordinary desktops rebuild the whole history from
#  genesis in under a day. A node syncing for the first time would follow
#  that history rather than this one -- it is heavier, and nothing in the
#  software said otherwise.
#
#  Mainnet launches on 15 September with zero work, so the value CANNOT be
#  set before launch. It has to be set afterwards, in the first release with
#  some depth behind it, and the only thing that would have made that happen
#  is somebody remembering. This project has established what happens to
#  things that depend on somebody remembering: a hand-kept file list went
#  stale three times, "four accounts" survived into a fifth, and two beginner
#  guides pointed at withdrawn binaries for two releases.
#
#  THE OTHER DIRECTION, WHICH IS WORSE
#
#  A value ABOVE the real chain's work stops new nodes syncing the real
#  chain. They wait for a heavier one, which never comes, and report nothing
#  more helpful than no progress. That failure looks like a network outage
#  and is one bad copy-paste away, so both directions are checked here
#  against a node that is actually running.
# ===========================================================================

import argparse
import json
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

sys.path.insert(0, str(REPO / "scripts" / "lib"))
sys.path.insert(0, str(REPO / "scripts"))
import quoted  # noqa: E402  -- needs the path above


def _read(p):
    """Read a source file with the author's quotations blanked.

    Both of these checks match values out of C++ that also has comments in
    it, and the comment beside a value is exactly where somebody explains an
    old one. See scripts/lib/quoted.py.
    """
    return quoted.strip_quoted(pathlib.Path(p).read_text(encoding="utf-8", errors="replace"))
CHAINPARAMS = REPO / "src" / "wam" / "chainparams.cpp"

GRN, RED, YLW, BLD, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[0m"

# Below this height the chain is too young for the value to mean anything,
# and demanding one would fail the first release of a new network.
YOUNG = 1000


def ok(m):   print(f"  {GRN}ok{OFF}    {m}")
def bad(m):  print(f"  {RED}FAIL{OFF}  {m}")
def warn(m): print(f"  {YLW}!!{OFF}    {m}")


def declared():
    """{network: int} -- the value compiled into each network's parameters.

    The sections are found by the class each network is defined in, so a new
    network added later is read rather than silently skipped.
    """
    # The class names are read from the file, not guessed. The first version
    # of this matched `class C(Main|Test|Reg)Params` and found only mainnet,
    # because the others are CTestNetParams and CRegTestParams -- so it
    # reported "no nMinimumChainWork found for testnet" about a value that was
    # sitting right there. A parser that silently sees one of three sections
    # is worse than none: it answers confidently about a file it did not read.
    text = _read(CHAINPARAMS)
    NAMES = {
        "CMainParams": "mainnet",
        "CTestNetParams": "testnet",
        "CRegTestParams": "regtest",
    }
    marks = [(m.start(), m.group(1)) for m in
             re.finditer(r"^class (\w+Params)\s*:", text, re.M)]
    if not marks:
        return {}
    marks.append((len(text), None))

    out = {}
    for (start, cls), (end, _) in zip(marks, marks[1:]):
        if cls not in NAMES:
            continue                      # CUnusedNetParams and anything later
        section = text[start:end]
        m = re.search(r"nMinimumChainWork\s*=\s*uint256S?[\{\(]"
                      r"(?:\"(?:0x)?([0-9a-fA-F]*)\")?[\}\)]",
                      section)
        if not m:
            continue
        out[NAMES[cls]] = int(m.group(1), 16) if m.group(1) else 0
    return out


CHAIN_FIELD = {"mainnet": "main", "testnet": "test", "regtest": "regtest"}


def node(network, host):
    """(height, chainwork) from a node ON THAT NETWORK, or None, or "wrong".

    The answer is checked against the `chain` field before it is believed.
    Asking this script about mainnet, on the Germany host, ran `wam-cli
    getblockchaininfo` with no flag -- and that host's wam.conf carries
    testnet=1, so the reply came from the TEST chain and was reported as
    mainnet. Height 5,897 and all.

    That is not a new mistake here. On 4 September six checks were found
    asking about mainnet and answering about testnet, for the same reason,
    and were fixed one at a time -- and wamcli.py was written that day so
    there would be one place the flags live. This file was written two days
    later, carried its own copy of the broken line anyway, and kept it until
    18 September: the guard below meant it never lied, but it also meant this
    check could never pass on mainnet. It reported "could not run" on every
    sweep of the live chain.

    The guard stays. A check that knows which chain answered is worth having
    even when the flags are right, because the next way to reach the wrong
    node will not look like this one.
    """
    from wamcli import flags as _flags
    cmd = ["wam-cli"] + _flags(network).split() + ["getblockchaininfo"]
    if host:
        cmd = ["ssh", "-o", "ConnectTimeout=12", "-o", "BatchMode=yes",
               f"root@{host}", " ".join(cmd)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        info = json.loads(r.stdout)
    except Exception:
        return None
    if info.get("chain") != CHAIN_FIELD[network]:
        return ("wrong", info.get("chain"), info.get("blocks"))
    return info["blocks"], int(info["chainwork"], 16)


def main():
    ap = argparse.ArgumentParser()
    # mainnet, because mainnet is the chain a stranger syncs.
    ap.add_argument("--network", default="mainnet",
                    choices=["mainnet", "testnet", "regtest"])
    ap.add_argument("--host", default=None,
                    help="ask this machine's node instead of a local one")
    args = ap.parse_args()

    print(f"\n{BLD}a floor under what a new node will follow ({args.network}){OFF}")

    if not CHAINPARAMS.exists():
        bad(f"{CHAINPARAMS} is not here -- nothing was checked")
        print()
        return 2

    values = declared()
    if args.network not in values:
        bad(f"no nMinimumChainWork found for {args.network} in chainparams.cpp")
        print()
        return 2
    want = values[args.network]

    live = node(args.network, args.host)
    if live is None:
        # Not "ok". A check that cannot reach the thing it checks has not
        # checked it, and this project's convention is that 2 means exactly
        # that -- so it is never mistaken for a pass.
        warn("no node answered, so nothing was compared")
        print(f"        declared: {want:#x}")
        print("        Run it against a node:  --host 169.58.159.165")
        print()
        return 2

    if live[0] == "wrong":
        _, got, blocks = live
        bad(f"the node that answered is on {got!r}, not {args.network}")
        print(f"        It reported height {blocks}, and reporting that as"
              f" {args.network}\n        would be a confident answer about the"
              f" wrong chain.")
        print("        That host's wam.conf probably carries testnet=1, so a")
        print("        flagless wam-cli reaches the test node.")
        print()
        return 2
    height, work = live

    if want == 0:
        if height < YOUNG:
            ok(f"zero, and the chain is {height} blocks old -- too young to set")
            print(f"        Set it once there is depth. Until then a fresh node"
                  f" follows\n        whatever chain is heaviest, which is"
                  f" correct only while nobody\n        has had time to build"
                  f" a heavier one.")
            print()
            return 0
        bad(f"zero, and the chain is {height} blocks deep")
        print()
        print("        A node syncing for the first time will follow whatever")
        print("        chain is heaviest, from anyone. This chain carries")
        print(f"        {work:,} hashes of work; at the difficulty floor that is")
        print(f"        about {work // 1_048_573:,} blocks a rented machine could redo.")
        print()
        print("        Set it in chainparams.cpp from a block behind the tip:")
        print(f"            wam-cli getblockhash {max(0, height - 100)}")
        print("            wam-cli getblock <that hash> | grep chainwork")
        print()
        return 1

    if want > work:
        bad(f"declared work is HIGHER than the real chain's")
        print(f"        declared : {want:#x}")
        print(f"        the chain: {work:#x}  (height {height})")
        print()
        print("        A new node will wait for a chain heavier than this one,")
        print("        which will not arrive. It reports no progress and looks")
        print("        exactly like a network outage. Lower it.")
        print()
        return 1

    behind = work - want
    ok(f"{want:#x}, and the live chain carries more ({work:#x} at height {height})")
    print(f"        margin: {behind:,} hashes of work above the floor")
    if behind < work // 100:
        warn("less than 1% of margin -- close enough to the tip that a short "
             "stall could\n        leave a new node waiting. Move it further back "
             "at the next release.")
    print()
    print(f"  {GRN}{BLD}a new node cannot be walked onto a cheaper history{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
