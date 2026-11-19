#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 test_consensus_gate.py -- the gate for a paid class cannot be fooled by prose
===============================================================================

     python3 scripts/test/test_consensus_gate.py

 WHAT THIS HOLDS DOWN

 scripts/check_consensus_params.py exists so that WAM-F6 cannot recur: a
 scalar of Consensus::Params declared with no default initialiser, read in
 validation.cpp, node/miner.cpp and pow.cpp, and assigned by no network.
 That one shipped, the regtest timewarp test failed on it, and a
 value-dependent field reading indeterminate memory on a heap-allocated
 Params is a consensus-split primitive.

 Three ways past it were reported by Fahrizal on 18 November 2026, each
 reproduced ten times against a fixture tree:

   a commented-out assignment counted as an assignment
   a `==` comparison -- a READ -- counted as an assignment
   a free function below the last class was credited to that network

 Each arm below builds a tree where the field is assigned NOWHERE that
 runs, and requires exit 1. The two control arms require that the gate
 still passes an honest tree and still fails a bare one, because a gate
 that fails everything is not a fix.

 The gate is run as CI runs it: as a subprocess, against a fixture tree,
 with the real file copied in.
===============================================================================
"""

from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
GATE = ROOT / "scripts" / "check_consensus_params.py"

RED = "\033[31m"; GRN = "\033[32m"; BLD = "\033[1m"; OFF = "\033[0m"

PARAMS_H = """\
#pragma once
namespace Consensus {
struct Params {
    int nSubsidyHalvingInterval;
    bool enforce_BIP94;
};
}
"""

READ_SITE = "bool g_read(ContextChain& c) { return c.params.enforce_BIP94; }\n"

MAIN = """\
class CMainParams : public CChainParams {
public:
    CMainParams() {
        consensus.nSubsidyHalvingInterval = 210000;
        consensus.enforce_BIP94 = false;
        pchMessageStart[0] = 0x57;
        strNetworkID = "main{not a brace that ends a class}";
    }
};
"""

REG_REAL = """\
class CRegTestParams : public CChainParams {
public:
    CRegTestParams() {
        consensus.nSubsidyHalvingInterval = 150;
        consensus.enforce_BIP94 = false;
    }
};
"""

REG_COMMENT = """\
class CRegTestParams : public CChainParams {
public:
    CRegTestParams() {
        consensus.nSubsidyHalvingInterval = 150;
        // consensus.enforce_BIP94 = false;
    }
};
"""

REG_BLOCK_COMMENT = """\
class CRegTestParams : public CChainParams {
public:
    CRegTestParams() {
        consensus.nSubsidyHalvingInterval = 150;
        /* upstream has consensus.enforce_BIP94 = false; here, and we
           decided against it -- see the note in WHITEPAPER.md */
    }
};
"""

REG_READ = """\
class CRegTestParams : public CChainParams {
public:
    CRegTestParams() {
        consensus.nSubsidyHalvingInterval = 150;
        assert(consensus.enforce_BIP94 == false);
    }
};
"""

REG_NONE = """\
class CRegTestParams : public CChainParams {
public:
    CRegTestParams() {
        consensus.nSubsidyHalvingInterval = 150;
    }
};
"""

TRAILING = """\
static void ResetForTesting(CChainParams& params) {
    params.consensus.enforce_BIP94 = false;
}
"""

PASS_BANNER = "every consensus field is defaulted or assigned by every network"

ARMS = {
    "a commented-out assignment": (MAIN + REG_COMMENT, 1),
    "a block comment quoting the assignment": (MAIN + REG_BLOCK_COMMENT, 1),
    "a == comparison, which is a read": (MAIN + REG_READ, 1),
    "a free function below the last class": (MAIN + REG_NONE + TRAILING, 1),
    # Controls. The gate must still work in both directions.
    "an honest tree, assigned by both": (MAIN + REG_REAL, 0),
    "a tree that assigns it nowhere": (MAIN + REG_NONE, 1),
}


def build(arm_text: str, work: pathlib.Path) -> pathlib.Path:
    (work / "scripts" / "lib").mkdir(parents=True)
    (work / "build" / "wam-core" / "src" / "consensus").mkdir(parents=True)
    (work / "build" / "wam-core" / "src" / "node").mkdir(parents=True)
    (work / "src" / "wam").mkdir(parents=True)
    shutil.copy(GATE, work / "scripts" / "check_consensus_params.py")
    for lib in ("quoted.py", "cpp_text.py"):
        shutil.copy(ROOT / "scripts" / "lib" / lib, work / "scripts" / "lib" / lib)
    (work / "build/wam-core/src/consensus/params.h").write_text(PARAMS_H)
    for rel in ("build/wam-core/src/validation.cpp",
                "build/wam-core/src/node/miner.cpp",
                "build/wam-core/src/pow.cpp"):
        (work / rel).write_text(READ_SITE)
    (work / "src" / "wam" / "chainparams.cpp").write_text(arm_text)
    return work


def run_gate(work: pathlib.Path):
    p = subprocess.run([sys.executable, "scripts/check_consensus_params.py"],
                       cwd=work, capture_output=True, text=True)
    return p.returncode, re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)


def main() -> int:
    print(f"\n{BLD}  the consensus gate reads code, not prose{OFF}\n")
    failed = 0
    passed = 0

    for label, (text, want) in ARMS.items():
        with tempfile.TemporaryDirectory(prefix="wam-gate-") as tmp:
            rc, out = run_gate(build(text, pathlib.Path(tmp)))
        if rc == want:
            print(f"  {GRN}ok{OFF}    {label}")
            passed += 1
            continue
        failed += 1
        print(f"  {RED}FAIL{OFF}  {label}")
        if want == 1:
            print(f"        the gate exited {rc} and printed its pass banner "
                  f"for a tree")
            print("        where enforce_BIP94 is assigned by nothing that runs.")
            print("        This is the one automated check that stops WAM-F6")
            print("        recurring, and it just said a recurrence was fine.")
        else:
            print(f"        the gate exited {rc} on a tree where both networks")
            print("        really assign the field. A gate that fails an honest")
            print("        tree is turned off within the week.")
        for line in out.splitlines():
            if line.strip():
                print(f"        gate| {line.strip()}")

    print()
    if failed:
        print(f"{RED}{BLD}  {failed} of {failed + passed} arms failed{OFF}\n")
        return 1
    print(f"{GRN}{BLD}  {passed} arms: a mention of an assignment is not one{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
