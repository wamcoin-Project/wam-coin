#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_rpc_secrets.py -- no RPC password reaches a command line
===============================================================================

     python3 scripts/check_rpc_secrets.py

 WHY THIS EXISTS

 /proc/<pid>/cmdline is world-readable on Linux by default. Anything in argv
 is readable by every other account on the machine for as long as the process
 lives, and `ps` is how you read it.

 Two scripts in this repository put the node's RPC password there, and both
 were scripts about a key:

   scripts/import_founder_key.sh   its own header listed three precautions
                                   taken to keep the WIF out of argv, and
                                   then passed the password as an option on
                                   every call it made. Its error path printed
                                   the whole command line, password included,
                                   as a copy-this hint.

   scripts/treasury_spend.py       carried a long note about moving the
                                   private key out of the process list onto
                                   stdin -- two hundred lines below the
                                   function that appended the password to the
                                   same command.

 Reported 13 November 2026. scripts/show_vesting.py had it too, found while
 fixing those.

 Both were written by people who knew the rule. Knowing it is not the same as
 having it checked, which is the only reason this file exists.

 WHAT THIS DOES

 Refuses the password option on a command line when its value comes from a
 variable -- a variable can hold the real password. A hard-coded literal in a
 file that only ever starts a throwaway regtest node is a fixture, not a
 secret, and is left alone.

 WHAT IT DOES NOT DO

 It does not know whether a password reaches a terminal by some other route:
 an `echo` of an array, a log line, a shell trace. Those are real and this
 reads argv construction only. It is a floor, not a ceiling.

 THE TWO WAYS TO DO IT INSTEAD

   cookie auth    -- pass nothing. wam-cli reads <datadir>/.cookie, which the
                     node writes mode 0600 and rewrites on every restart.
   -stdinrpcpass  -- wam-cli reads the password as the first line of standard
                     input. It composes with -stdin, which takes the
                     remaining lines as arguments, so a key and a password can
                     travel together without either being an argument.
===============================================================================
"""

from __future__ import annotations

import pathlib
import re
import sys

import pathlib as _pathlib
import sys as _sys
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# Everything that could invoke wam-cli or wamd.
WHERE = ["scripts/*.sh", "scripts/*.py", "scripts/test/*.sh", "scripts/lib/*.sh",
         "ops/*.py", "ops/*.sh", "deploy/**/*.sh", "miner/*.sh", "pool/*.js",
         "pool/lib/*.js", "contrib/**/*.sh", "install.sh"]

# wam:quote-begin
OPT = re.compile(r"-rpcpassword=(\S*)")
# wam:quote-end

# A value that is a variable, a format slot, or a concatenation. Anything in
# here can hold the real password at run time; a bare literal cannot.
INTERPOLATED = re.compile(r"[$]|%s|%\(|\{|\}|\+\s*\w|`")

# A FIXTURE IS A PROPERTY OF THE FILE, NOT OF THE LINE.
#
# The first version looked for "regtest" on the same line as the option and
# found it on neither of check_fresh_sync.sh's three calls nor on
# psbt_rehearsal.sh's two -- all five of them throwaway nodes, started a few
# lines above with a mktemp datadir. Seven permanent warnings is how a
# project teaches itself to scroll past warnings, which is the opposite of
# what this is for. A file that starts a throwaway node and nothing else may
# write `f` into it.
#
# Getting this wrong costs little in one direction: it means a LITERAL
# password in the repository goes unremarked. A literal is not the operator's
# real one. Getting the interpolated case wrong is what would matter, and
# that is decided on the value, not on this.
FIXTURE = re.compile(r"-regtest\b|regtest|mktemp|TMPDIR|throwaway", re.I)


def files():
    out = []
    for pat in WHERE:
        for p in sorted(ROOT.glob(pat)):
            if p.is_file():
                out.append(p.relative_to(ROOT).as_posix())
    return sorted(set(out))


def main() -> int:
    scanned = files()
    if not scanned:
        print(f"\n  {RED}FAIL{OFF}  no script was found -- this proves nothing\n")
        return 2

    fails, fixtures = [], []
    for rel in scanned:
        raw = (ROOT / rel).read_text(encoding="utf-8", errors="replace")
        is_fixture_file = bool(FIXTURE.search(raw))
        text = quoted.strip_quoted(raw)
        for i, line in enumerate(text.splitlines(), 1):
            for m in OPT.finditer(line):
                value = m.group(1)
                if INTERPOLATED.search(value):
                    fails.append((rel, i, value, line.strip()[:110]))
                else:
                    fixtures.append((rel, i, value, is_fixture_file))

    print()
    print(f"{BLD}no RPC password reaches a command line{OFF}")
    print(f"  scanned   : {len(scanned)} script(s)")
    print(f"  fixtures  : {len(fixtures)} literal value(s) on throwaway nodes")
    print()

    for rel, i, value, line in fails:
        print(f"  {RED}FAIL{OFF}  {rel}:{i} passes the password option in "
              f"argv as [{value}], and that value comes from a variable")
        print(f"          {line}")
        print(f"          Any other account on the machine can read it from "
              f"/proc/<pid>/cmdline while this runs.")
        print(f"          Pass nothing and let wam-cli read the cookie file, "
              f"or use -stdinrpcpass.")

    # A literal on something that does not look like a throwaway is worth a
    # human reading: it is not a leak of a real secret, but it is a password
    # written into the repository.
    loose = [(r, i, v) for r, i, v, is_fixture in fixtures if not is_fixture]
    for rel, i, value in loose:
        print(f"  {YEL}!!{OFF}    {rel}:{i} passes the password option as a "
              f"literal [{value}] in a file that never starts a throwaway "
              f"node. Harmless if that node is one, worth a look if not.")

    print()
    if fails:
        print(f"  {RED}{len(fails)} command line(s) carry a password that could "
              f"be the real one{OFF}\n")
        return 1
    if loose:
        print(f"  {YEL}nothing interpolated; {len(loose)} literal(s) worth a "
              f"human reading{OFF}\n")
        return 0
    print(f"  {GRN}{BLD}no password is built into any command line{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
