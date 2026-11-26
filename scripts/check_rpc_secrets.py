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

# BOTH SPELLINGS, BECAUSE ARGV DOES NOT CARE WHICH ONE YOU WROTE.
#
# This matched `-rpcpassword=VALUE` only. `-rpcpassword "$PASS"` -- the
# separated form, which bitcoin-cli accepts identically and which
# scripts/test_miner.sh already uses -- was invisible to it, and so was the
# Python list form `[..., "-rpcpassword", pw]`. The guard exists because two
# key-handling scripts put the password in argv, where /proc/<pid>/cmdline
# makes it readable by every account on the machine; it would not have
# caught the same mistake written the other way round.
#
# Found in the pre-release review of v0.1.15. Nothing in the tree violates
# it today -- the only separated uses are literals in a test -- which is
# exactly when a hole is worth closing.
# wam:quote-begin
# THE ARGV-LIST FORM, WHICH THIS MISSED WHILE SAYING IT DID NOT.
#
# The pattern required `=` or whitespace immediately after the option. In
# Python's subprocess form the option is followed by a QUOTE and a comma --
# ["-rpcpassword", pw] -- so it never matched, and the comment above claimed
# the opposite in so many words.
#
# Nothing in the tree violates it today, so the defect is in the guard: the
# next script written the idiomatic way, which is also the way the original
# argv-password bug was actually written, sails through the release gate and
# puts the password back in /proc/<pid>/cmdline for every account on the box.
#
# Reported by Warung Bunda Kanse Bunda on 2026-11-22, who ran this module's
# own OPT over five spellings of the list form and got NO MATCH on all five.
#
# Three alternatives now, in order: `=value`, whitespace `value`, and the
# list form -- a closing quote, then a comma or whitespace, then the value.
# THE SHAPE THAT ACTUALLY HAPPENED, AND NOTHING WIDER.
#
# install.sh invoked `python3 - <path> "$RPC_PASS" ...`: an interpreter
# reading its program from stdin, handed a secret as a positional
# argument. No flag, so OPT could not see it, and every account on the
# machine could read it from /proc/<pid>/cmdline.
#
# The first pattern written here matched any secret-named expansion in
# quotes and fired 44 times on `if [ -n "$KEYFILE" ]` and its like. A
# guard that cries that often is a guard that gets switched off. This
# one names the invocation: python/perl/ruby/sh/bash reading from stdin,
# with a PASS/PASSWORD/SECRET/WIF expansion among its arguments.
BARE_SECRET_ARG = re.compile(
    r"\b(?:python3?|perl|ruby|bash|sh)\s+-(?:\s|s\b)[^\n|;]*"
    r"\"\$\{?([A-Z_]*(?:PASS|PASSWORD|SECRET|WIF)[A-Z_]*)"
)

OPT = re.compile(
    r"-{1,2}rpcpassword"
    r"(?:"
    r"=(\S*)"                                   # -rpcpassword=VALUE
    r"|[\"']?\s*,\s*[\"']?([^\s\"',\])]+)"      # ["-rpcpassword", VALUE]
    r"|\s+(?!-)[\"']?([^\s\"',)]+)"             # -rpcpassword VALUE
    r")")
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
            # A COMMENT DESCRIBING THE FLAG IS NOT A COMMAND LINE.
            #
            # Widening the pattern to the separated spelling made it read
            # prose: check_mentions.py carries the sentence "-rpcpassword
            # matched the comment describing the flag", and this reported
            # "matched" as a password. That is this repository's own
            # mention-is-not-use rule, in the file that enforces it.
            if line.lstrip().startswith(("#", "//")):
                continue
            # A SECRET WITH NO FLAG IN FRONT OF IT IS STILL ON THE COMMAND
            # LINE.
            #
            # install.sh:533 passed the node's RPC password and the pool's
            # Redis password to python3 as bare positional arguments. No
            # `-rpcpassword` anywhere, so OPT could not match, and this gate
            # listed install.sh among the files it scanned and passed the
            # tree. Reported by Radenlingga on 2026-11-26, who read both
            # values out of /proc/<pid>/cmdline of a live process.
            #
            # A bare value cannot be recognised by its shape, so what is
            # recognised instead is the VARIABLE: a shell expansion whose
            # name says password or secret, appearing as an argument to a
            # command, with no flag attached. That is narrow enough to name
            # the mistake and wide enough to catch it with no flag at all.
            bare = BARE_SECRET_ARG.search(line)
            if bare and "add_argument" not in line:
                fails.append((rel, i, bare.group(1),
                              line.strip()[:110]))
                continue

            # An argparse DECLARATION is not a password on a command line.
            # `p.add_argument("--rpcpassword", default="")` names the option
            # so a caller can pass one; the value beside it is argparse's own
            # keyword, not a secret. The list-form alternative added on
            # 2026-11-22 matches that shape, so it is excluded here rather
            # than by weakening the pattern it was added for.
            if "add_argument" in line:
                continue
            for m in OPT.finditer(line):
                # Group 1 is the =joined spelling, group 2 the argv-list
                # form, group 3 the separated one; exactly one matched.
                value = next((g for g in m.groups() if g is not None), None)
                if value is None:
                    continue
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
