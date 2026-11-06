#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 test_endpoint_extraction.py -- which strings on a page are a port to dial
===============================================================================

     python3 scripts/test/test_endpoint_extraction.py

 WHY THIS EXISTS

 check_published_endpoints.py has been wrong twice, in opposite directions,
 and neither failure needed a socket to find.

 On 2026-11-02 it read `src/wam/chainparams.cpp:483` -- a line of our own
 source, cited in the Komodo notes -- as a host called "chainparams.cpp", and
 spent three days reporting "1 published endpoint a stranger cannot use"
 about a file in this tree. A red line nobody can act on is how people learn
 to ignore red lines, and that one was on the sweep.

 On 2026-11-06 the other direction. docs/MINE.md promises that "a check in
 this repository dials every address on this page on every sweep", and two
 of the four pools publish a second port with no host beside it:

     veinpool.fr:3310                  and :3311 for servers, a higher start

 A bare :port carried no host, so nothing ever dialled it. veinpool.fr:3311
 had been on the page since it was listed and had never been tried once --
 and it is the port published for farms, the miner whose hashrate we would
 most notice losing and least quickly explain.

 Both faults were in the extraction, which is pure text in and pairs out.
 The check around it needs a network and twelve seconds a host; this needs
 neither, so it can hold every shape at once and be run before a push.

 WHAT IT HOLDS

 That the four shapes a page really uses are found: bare host:port, inside a
 stratum+tcp:// or https:// URL, and a bare second port bound to the host
 named earlier ON THE SAME LINE.

 And that the four shapes that merely look like endpoints are refused: a
 source reference after a single slash, a clock, a bare port on a line with
 no host at all, and a bare port in a document whose host is on the line
 above -- because "the same line" is the whole rule, and a rule that drifts
 across lines would put every port in a file behind the first host in it.
===============================================================================
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent

# Loaded by path rather than imported by name: the module is a script with a
# hyphen-free but check_-prefixed name that nothing else imports, and loading
# it this way means this test does not depend on how the sweep sets PYTHONPATH.
_spec = importlib.util.spec_from_file_location(
    "cpe", ROOT / "scripts" / "check_published_endpoints.py")
cpe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cpe)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

RED = "\033[31m"; GRN = "\033[32m"; BLD = "\033[1m"; OFF = "\033[0m"

passed = 0
failed = []


def found(text):
    """{(host, port)} the extraction takes from one page's text."""
    return {(h, int(p)) for h, p in cpe.endpoints_in(text)}


def check(name, fn):
    global passed
    try:
        fn()
        passed += 1
        print(f"  {GRN}ok{OFF}    {name}")
    except AssertionError as e:
        failed.append(name)
        print(f"  {RED}FAIL{OFF}  {name}\n          {e}")


# --------------------------------------------------------------------------
#  found
# --------------------------------------------------------------------------

def test_a_bare_host_and_port():
    assert found("wampool.vslabs.co.in:3333\n") == {
        ("wampool.vslabs.co.in", 3333)}


def test_a_port_inside_a_stratum_url():
    assert found("./wam-miner -o stratum+tcp://pool.wamcoin.org:3333 -u X\n") \
        == {("pool.wamcoin.org", 3333)}


def test_a_second_port_bound_to_the_host_on_its_line():
    """The failure of 2026-11-06, in the two shapes the page really uses."""
    page = ("pool.wamcoin.org:3333             run by this project, "
            "and :3334 :3335 higher\n"
            "wampool.vslabs.co.in:3333         and :3334 for servers "
            "and farms\n"
            "veinpool.fr:3310                  and :3311 for servers, "
            "a higher start\n")
    assert found(page) == {
        ("pool.wamcoin.org", 3333), ("pool.wamcoin.org", 3334),
        ("pool.wamcoin.org", 3335),
        ("wampool.vslabs.co.in", 3333), ("wampool.vslabs.co.in", 3334),
        ("veinpool.fr", 3310), ("veinpool.fr", 3311)}


def test_a_second_port_in_backticks():
    """How the Komodo notes write it: `host:50002` and `:50004`."""
    assert found("`electrum.wamcoin.org:50002` and `:50004` are held empty\n") \
        == {("electrum.wamcoin.org", 50002), ("electrum.wamcoin.org", 50004)}


def test_two_hosts_on_one_line_take_their_own_continuations():
    """The nearest host to the LEFT owns the bare port, not the first one."""
    assert found("a.wamcoin.org:3333 and b.wamcoin.org:4444 and :4445\n") == {
        ("a.wamcoin.org", 3333), ("b.wamcoin.org", 4444),
        ("b.wamcoin.org", 4445)}


# --------------------------------------------------------------------------
#  refused
# --------------------------------------------------------------------------

def test_a_source_reference_is_not_a_host():
    """The three days of red of 2026-11-02."""
    assert found("asserted at `src/wam/chainparams.cpp:483` in this tree\n") \
        == set()


def test_a_clock_is_not_a_second_port():
    """A colon preceded by a digit, on a line that does name a server."""
    assert found("electrum.wamcoin.org:50002 went quiet at 12:30 and 09:4512\n") \
        == {("electrum.wamcoin.org", 50002)}


def test_a_bare_port_with_no_host_on_the_line_is_ignored():
    assert found("the test pool was :13333 and answers nothing now\n") == set()


def test_a_bare_port_does_not_reach_back_to_the_line_above():
    """'The same line' is the rule. Without it, every port in a file would
    bind to the first host in the file."""
    page = ("pool.wamcoin.org:3333\n"
            "\n"
            "Elsewhere, entirely unrelated, the number :9999 appears.\n")
    assert found(page) == {("pool.wamcoin.org", 3333)}


def test_a_continuation_before_its_host_is_not_claimed():
    """A bare port written to the LEFT of every host on the line has no
    owner, and guessing one would dial a port nobody published."""
    assert found("port :4444 is mentioned before pool.wamcoin.org:3333\n") == {
        ("pool.wamcoin.org", 3333)}


# --------------------------------------------------------------------------
#  and the page it was written for
# --------------------------------------------------------------------------

def test_the_live_page_still_yields_every_pool_port():
    """Not a fixture: docs/MINE.md as it stands. If a pool line is reshaped
    into something this extraction cannot read, the address stops being
    dialled silently, and that is exactly the failure above."""
    import importlib
    sys.path.insert(0, str(ROOT / "scripts" / "lib"))
    quoted = importlib.import_module("quoted")
    text = quoted.strip_quoted(
        (ROOT / "docs" / "MINE.md").read_text(encoding="utf-8"))
    got = found(text)
    for want in [("pool.wamcoin.org", 3333),
                 ("stratum.cryptopickaxe.co.uk", 6040),
                 ("wampool.vslabs.co.in", 3333),
                 ("veinpool.fr", 3310), ("veinpool.fr", 3311)]:
        assert want in got, f"docs/MINE.md no longer yields {want[0]}:{want[1]}"
    assert ("wam.ariabrain.com", 3333) not in got, \
        "the quoted dead pool is being dialled again"


def main():
    print(f"\n{BLD}every address on the page, and nothing that only looks "
          f"like one{OFF}\n")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if failed:
        print(f"  {RED}{BLD}{len(failed)} failed{OFF}, {passed} passed")
        for f in failed:
            print(f"    - {f}")
        print()
        return 1
    print(f"  {GRN}{BLD}{passed} shapes: found what is published, refused "
          f"what is not{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
