#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 test_panel_ssh_silence.py -- a hung ssh is not a failing service
===============================================================================

     python3 scripts/test/test_panel_ssh_silence.py

 WHAT HAPPENED

 On 2026-11-04 the ops panel showed three red rows. Two of them read:

     electrum servers answer and agree      FAILING
     a server we do not own agrees          FAILING

 Both were false. All four of our Electrum endpoints were answering at the
 correct height at that moment, over certificates that verified, and so was
 cup's server in Seoul. What had actually happened was one slow ssh to the
 Germany node, and the stored detail for both rows was a Python traceback
 ending in subprocess.TimeoutExpired.

 check_electrum.py kept a private copy of the ssh call. Its caller had the
 right shape already -- warn, and carry on with heights unverified -- but
 subprocess.run RAISES TimeoutExpired rather than returning a non-zero status,
 so the graceful path only ever ran when ssh failed QUICKLY. When ssh HUNG,
 the exception went straight past it and killed the script.

 Four other scripts had learned this same lesson separately and late, which is
 why scripts/wamssh.py exists. check_electrum.py was the last panel check that
 had not been moved onto it.

 The second row is the sharper loss. ops.py gives cup's server a row of its
 own, and says why: a reboot of HIS must not redden a row that judges OURS,
 because a red line nobody can act on is how people learn to ignore red lines.
 An ssh hiccup of ours reddened it anyway.

 WHAT THIS HOLDS DOWN

 Two things, one structural and one behavioural.

   1. No Python check on the ops panel may speak ssh by itself. The panel is
      what gets looked at between sweeps, so a private copy there is a false
      red waiting for a slow morning.

   2. When the question cannot be put at all, the check says so and still
      measures everything it CAN measure. It does not raise, and it does not
      report a failure of the service it was named after.

 Nothing here touches the network. A guard that needs the internet is a guard
 that goes red on a train, and then nobody reads it.
===============================================================================
"""

from __future__ import annotations

import io
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPTS = os.path.join(ROOT, "scripts")
sys.path.insert(0, SCRIPTS)

GRN = "\033[32m"; RED = "\033[31m"; BLD = "\033[1m"; OFF = "\033[0m"

passed = 0
failed = 0


def ok(msg):
    global passed
    passed += 1
    print(f"  {GRN}ok{OFF}    {msg}")


def bad(msg):
    global failed
    failed += 1
    print(f"  {RED}FAIL{OFF}  {msg}")


# ---------------------------------------------------------------------------
#  1. The panel's Python checks go through wamssh, or do not ssh at all.
# ---------------------------------------------------------------------------
def panel_python_checks():
    src = io.open(os.path.join(ROOT, "ops", "ops.py"), encoding="utf-8").read()
    # The CHECKS table names each script as a literal path.
    names = sorted({m.group(1) for m in
                    re.finditer(r'"(scripts/[a-z_0-9]+\.py)"', src)})
    return names


def test_no_private_ssh_on_the_panel():
    names = panel_python_checks()
    if not names:
        bad("found no Python checks in ops.py -- this test stopped testing")
        return
    for rel in names:
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.exists(path):
            bad(f"{rel} is on the panel and not in the tree")
            continue
        text = io.open(path, encoding="utf-8").read()
        # The argv form, not the word: every comment in this repository is
        # free to discuss ssh, and several of them do.
        raw = re.search(r'\[\s*"ssh"\s*,', text)
        if raw and "from wamssh import" not in text:
            bad(f"{rel} speaks ssh by itself -- a hung call will redden its row")
        elif raw:
            bad(f"{rel} imports wamssh and still has a raw ssh call")
        else:
            ok(f"{rel} does not speak ssh by itself")


# ---------------------------------------------------------------------------
#  2. A question that cannot be put is not an answer of "no".
# ---------------------------------------------------------------------------
def test_hung_ssh_degrades():
    import wamssh
    import check_electrum

    real_run = subprocess.run
    attempts = {"n": 0}

    def hanging_run(*a, **kw):
        """What the kernel did that morning: accept, then never answer."""
        attempts["n"] += 1
        raise subprocess.TimeoutExpired(a[0] if a else "ssh",
                                        kw.get("timeout", 25))

    gap = wamssh.GAP_SECONDS
    wamssh.subprocess.run = hanging_run
    wamssh.GAP_SECONDS = 0          # the pause is real, and not what is tested
    try:
        rc, text = wamssh.run("198.51.100.1", "wam-cli getblockcount", timeout=5)
        if rc == wamssh.UNREACHABLE:
            ok(f"a hung ssh is UNREACHABLE, not a status ({text})")
        else:
            bad(f"a hung ssh returned rc={rc} -- callers will read it as an answer")
        if attempts["n"] >= 2:
            ok("it was asked twice before being believed")
        else:
            bad(f"only {attempts['n']} attempt(s) -- an intermittent hang will stick")

        # node_state is the exact function whose traceback the panel printed.
        try:
            h, g, why = check_electrum.node_state("198.51.100.1", "mainnet")
        except Exception as e:
            bad(f"node_state raised {type(e).__name__} -- this is the 2026-11-04 bug")
            return
        if h is None and g is None and why:
            ok(f"node_state degrades instead of raising ({why})")
        else:
            bad(f"node_state returned {(h, g, why)} from a host that never answered")

        # The whole check, with the network stubbed out: the row must stay
        # green, name what it could not verify, and still measure the servers.
        real_resolve, real_probe = check_electrum.resolve, check_electrum.probe
        check_electrum.resolve = lambda name: (["203.0.113.9"], None)
        check_electrum.probe = lambda ip, port, tls, sni, timeout=15: (
            {"version": ["ElectrumX 2.0.0", "1.4"], "height": 34728,
             "genesis": "d8d3debea987b62a0934c3980d62bffbb6e16aa797d19891d4fcc9b9fb11d7e9"},
            None)
        argv = sys.argv
        sys.argv = ["check_electrum.py", "--node", "198.51.100.1",
                    "--network", "mainnet", "electrum.example"]
        buf = io.StringIO()
        try:
            import contextlib
            with contextlib.redirect_stdout(buf):
                code = check_electrum.main()
        finally:
            sys.argv = argv
            check_electrum.resolve, check_electrum.probe = real_resolve, real_probe
        out = buf.getvalue()

        if code == 0:
            ok("an unreachable node does not fail the Electrum row")
        else:
            bad(f"exit {code} -- our own ssh hiccup is being reported as their outage")
        if "UNVERIFIED" in out:
            ok("and the row says which part of it was not verified")
        else:
            bad("the row went green without saying heights were unverified")
        if "serving this chain" in out:
            ok("the endpoints were still measured")
        else:
            bad("the endpoints were not measured at all")
    finally:
        wamssh.subprocess.run = real_run
        wamssh.GAP_SECONDS = gap


print()
print(f"{BLD}no panel row blames the wrong thing{OFF}")
test_no_private_ssh_on_the_panel()
print()
print(f"{BLD}a question that could not be put is not an answer{OFF}")
test_hung_ssh_degrades()
print()
if failed:
    print(f"  {RED}{BLD}{failed} of {passed + failed} would print a false red{OFF}")
else:
    print(f"  {GRN}{BLD}all {passed} hold{OFF}")
print()
sys.exit(1 if failed else 0)
