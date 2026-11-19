#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_gated_tests.py -- a disabled test is a decision, not a convenience
===============================================================================

     python3 scripts/check_gated_tests.py

 WHY THIS EXISTS

 WAM-029 disables 43 inherited Boost cases, each because it encodes a Bitcoin
 fact this chain does not have -- its 0x80 WIF version byte, its 21,000,000
 cap, its 2016-block retarget, port 8333, a coinbase with no treasury output.
 Every one of them has a reason written beside it in the source.

 That mechanism is also the easiest way in the world to turn a red build
 green. `*boost::unit_test::disabled()` is nine words; nobody reviewing a
 1,400-line patch file would see the forty-fourth appear, and the suite would
 go on reporting that everything passed.

 WHAT THIS CHECKS

   every disabled case in the tree is in the table    nothing was added
                                                      without a reason
   every row of the table is a case that exists       no stale gate
                                                      forgiving something
                                                      nobody can see
   every gated case carries its WAM_GATED_ marker     the reason survived
                                                      into the source
   no row is a duplicate                              one decision, once

 It needs the patched tree, which exists only after scripts/fetch-upstream.sh.
 Without it this says so and exits 2: a check that could not look has not
 looked, which is this project's convention and is not a pass.
===============================================================================
"""

from __future__ import annotations

import importlib.util
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TREE = ROOT / "build" / "wam-core"

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

DISABLED = re.compile(r"BOOST_(?:AUTO|FIXTURE)_TEST_CASE\(\s*([A-Za-z_0-9]+)"
                      r"[^)]*\*\s*boost::unit_test::disabled\(\)")
CASE_NAME = re.compile(r"BOOST_(?:AUTO|FIXTURE)_TEST_CASE\(\s*([A-Za-z_0-9]+)")


def table():
    """GATED_CASES, imported rather than parsed.

    The patcher is the authority on what is gated, so this reads the same
    object the patcher applies. A regex over that file would be a second
    opinion about it, and a second opinion is how two lists drift apart.
    """
    spec = importlib.util.spec_from_file_location(
        "wam_patch_upstream", ROOT / "scripts" / "patch_upstream.py")
    mod = importlib.util.module_from_spec(spec)
    # Registered BEFORE it is executed. @dataclass resolves a field's type by
    # looking its class's module up in sys.modules, so a module executed
    # outside it dies on `'NoneType' object has no attribute '__dict__'` --
    # which says nothing at all about what went wrong.
    sys.modules[spec.name] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop(spec.name, None)
    return list(mod.GATED_CASES)


def main() -> int:
    print(f"\n{BLD}a disabled test is a decision, not a convenience{OFF}")

    try:
        rows = table()
    except Exception as exc:                                  # noqa: BLE001
        print(f"  {RED}FAIL{OFF}  scripts/patch_upstream.py has no readable "
              f"GATED_CASES ({exc})")
        print()
        return 2

    wanted = {}
    dupes = []
    for rel, decl, reason in rows:
        m = CASE_NAME.match(decl)
        if not m:
            print(f"  {RED}FAIL{OFF}  a row's declaration is not a test case: "
                  f"{decl!r}")
            print()
            return 1
        name = m.group(1)
        if name in wanted:
            dupes.append(name)
        wanted[name] = (rel, reason)

    print(f"  table    : {len(rows)} case(s) gated by WAM-029")

    if not TREE.is_dir():
        print(f"  {YEL}!!{OFF}    {TREE.relative_to(ROOT)} is not here, so the "
              f"tree was not read")
        print("        Run scripts/fetch-upstream.sh first. Nothing was "
              "compared.")
        print()
        return 2

    src = TREE / "src"
    found, missing_marker = {}, []
    for p in sorted(src.rglob("*.cpp")):
        rel = p.relative_to(src).as_posix()
        if not (rel.startswith("test/") or "/test/" in rel):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in DISABLED.finditer(text):
            name = m.group(1)
            found[name] = rel
            if f"WAM_GATED_{name}" not in text:
                missing_marker.append(name)

    print(f"  tree     : {len(found)} case(s) carrying "
          f"*boost::unit_test::disabled()")
    print()

    fails = []

    for name in sorted(dupes):
        fails.append(f"{name} appears twice in GATED_CASES -- one decision, once")

    for name in sorted(set(found) - set(wanted)):
        fails.append(
            f"{found[name]}: {name} is disabled in the tree and is NOT in "
            f"GATED_CASES. Every gate is a decision with a reason; this one "
            f"has neither.")

    for name in sorted(set(wanted) - set(found)):
        rel, _ = wanted[name]
        exists = (src / rel).is_file() and \
            re.search(r"BOOST_(?:AUTO|FIXTURE)_TEST_CASE\(\s*" +
                      re.escape(name) + r"\b",
                      (src / rel).read_text(encoding="utf-8", errors="replace"))
        if exists:
            fails.append(
                f"{rel}: {name} is in GATED_CASES and is NOT disabled in the "
                f"tree. The patch did not apply, or somebody re-enabled it.")
        else:
            fails.append(
                f"{rel}: {name} is in GATED_CASES and no longer exists "
                f"upstream. A stale gate forgives something nobody can see; "
                f"delete the row.")

    for name in sorted(set(missing_marker)):
        fails.append(
            f"{found[name]}: {name} is disabled but carries no WAM_GATED_"
            f"{name} marker, so the reason did not reach the source.")

    for m in fails:
        print(f"  {RED}FAIL{OFF}  {m}")

    print()
    if fails:
        print(f"  {RED}{len(fails)} gate(s) the table and the tree disagree "
              f"about{OFF}\n")
        return 1
    print(f"  {GRN}{BLD}every disabled case is one WAM-029 names, and every "
          f"one it names is disabled{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
