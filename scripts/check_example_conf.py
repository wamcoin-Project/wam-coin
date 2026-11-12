#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_example_conf.py -- the example configuration, against the binary
===============================================================================

     python3 scripts/check_example_conf.py --bin /path/to/dir/with/wamd

 WHY THIS EXISTS

 share/examples/wam.conf lists every option the node accepts. It was asked
 for by an operator running his own node and pool, and it is generated from
 `wamd -help` by scripts/gen_wam_conf.sh precisely so that it cannot be a
 hand-written list that goes stale -- which is what upstream's
 share/examples/bitcoin.conf became here: never renamed, never adapted, never
 packaged, and still describing Bitcoin.

 A generated file only stays true while somebody regenerates it. An option
 added upstream, or one this project adds, appears in the binary immediately
 and in the committed file never. Then an operator reads our file, does not
 find the setting he needs, and concludes the node cannot do it.

 So this compares the OPTION LIST in the committed file against what the
 binary prints today. The prose above that list is editorial and is not
 compared: it says where the file goes and which settings are worth a
 decision, and no binary has an opinion about either.

 EXIT CODES, this project's convention

     0  the committed list is what the binary accepts
     1  it is not -- regenerate with scripts/gen_wam_conf.sh
     2  there was no wamd to ask, so nothing was checked
===============================================================================
"""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONF = ROOT / "share" / "examples" / "wam.conf"
MARKER = "EVERY OPTION THE BINARY ACCEPTS"

# AND THE CONFIGURATION WE ACTUALLY WRITE ON SOMEBODY'S MACHINE.
#
# share/examples/wam.conf is generated and therefore could not go stale in
# the one direction that matters. install.sh is hand-written, is run by every
# operator who follows the README, and nothing compared it to anything.
#
# It carried `randomxmining=0` from the beginning, with two lines of comment
# explaining when to set it to 1. There is no such option. In wam.conf the
# node ignores it with one line in debug.log; on the command line it refuses
# to start with "Invalid parameter". So every node installed this way has a
# setting in its configuration that does nothing, and its operator has a
# written instruction for switching on a mode the software does not have.
#
# Found by Radenlingga (Discord) on 10 November 2026 -- as a dead function in
# the node, which is the same fact seen from the other end.
INSTALLER = ROOT / "install.sh"
INSTALL_CONF_BEGIN = re.compile(r'^\s*cat > "\$CONF" <<EOF\s*$')
INSTALL_CONF_END = re.compile(r"^EOF\s*$")

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# An option line in the generated list: "#name" or "#name=<value>".
# wam:quote-begin
OPTION = re.compile(r"^#([a-z][a-z0-9]*)(=|$)")
# wam:quote-end


def options_in_file(text):
    """The option names in the generated half of the committed file."""
    i = text.find(MARKER)
    if i < 0:
        return None
    names = []
    for line in text[i:].splitlines():
        m = OPTION.match(line)
        if m:
            names.append(m.group(1))
    return names


def options_in_installer(text):
    """The settings install.sh writes into an operator's wam.conf.

    Returns a list of (name, line number), or None if the heredoc that
    writes the file is no longer where this expects it -- which must be
    reported rather than read as "nothing to check".
    """
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if INSTALL_CONF_BEGIN.match(line):
            start = i + 1
            break
    if start is None:
        return None

    names = []
    for i in range(start, len(lines)):
        line = lines[i]
        if INSTALL_CONF_END.match(line):
            return names
        m = re.match(r"^([a-z][a-z0-9]*)=", line)
        if m:
            names.append((m.group(1), i + 1))
    return None        # ran off the end: the heredoc is not closed as expected


def options_from_binary(wamd):
    """The option names `wamd -help` prints, in the order it prints them."""
    try:
        out = subprocess.run([str(wamd), "-help"], capture_output=True,
                             text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 and not out.stdout:
        return None
    names = []
    for line in out.stdout.splitlines():
        m = re.match(r"^  -([a-z][a-z0-9]*)(=|\s|$)", line)
        if m:
            names.append(m.group(1))
    return names or None


def find_wamd(given):
    if given:
        p = pathlib.Path(given)
        for candidate in (p, p / "wamd", p / "wamd.exe"):
            if candidate.is_file():
                return candidate
        return None
    for candidate in (ROOT / "build" / "wam-core" / "src" / "wamd",
                      pathlib.Path("/usr/local/bin/wamd")):
        if candidate.is_file():
            return candidate
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bin", help="directory holding wamd, or the binary itself")
    a = ap.parse_args()

    print(f"\n{BLD}the example configuration, against the binary{OFF}\n")

    if not CONF.is_file():
        print(f"  {RED}FAIL{OFF}  {CONF.relative_to(ROOT)} is not here.")
        print("          Generate it: bash scripts/gen_wam_conf.sh <bindir>\n")
        return 1

    text = quoted.strip_quoted(CONF.read_text(encoding="utf-8",
                                              errors="replace"))
    listed = options_in_file(text)
    if listed is None:
        print(f"  {RED}FAIL{OFF}  the file has no generated option list -- the "
              f"marker\n          \"{MARKER}\" is gone, and with it any way to "
              f"tell\n          the generated half from the written half.\n")
        return 1

    wamd = find_wamd(a.bin)
    if wamd is None:
        print(f"  {YEL}no wamd to ask, so the list was NOT checked -- this is "
              f"not a pass.{OFF}")
        print("  Point it at one:  --bin build/wam-core/src\n")
        return 2

    actual = options_from_binary(wamd)
    if actual is None:
        print(f"  {YEL}{wamd} did not print a usable help, so nothing was "
              f"checked.{OFF}\n")
        return 2

    print(f"  file   {len(listed)} option(s) in {CONF.relative_to(ROOT)}")
    print(f"  binary {len(actual)} option(s) from {wamd}\n")

    # The configuration install.sh writes, which is the one that ends up on
    # a stranger's machine. Only one direction is a fault here: install.sh
    # writes a chosen few settings and is not meant to list them all.
    installer_bad = []
    if INSTALLER.is_file():
        written = options_in_installer(
            INSTALLER.read_text(encoding="utf-8", errors="replace"))
        if written is None:
            print(f"  {RED}FAIL{OFF}  install.sh no longer writes wam.conf where "
                  f"this can read it.\n          The heredoc after "
                  f"'cat > \"$CONF\" <<EOF' is what is checked; if it moved, "
                  f"this\n          check is looking at nothing and must say so "
                  f"rather than pass.")
            installer_bad = [("<not found>", 0)]
        else:
            print(f"  writes {len(written)} setting(s) into wam.conf "
                  f"(install.sh)\n")
            installer_bad = [(n, ln) for n, ln in written if n not in set(actual)]
            for name, ln in installer_bad[:12]:
                print(f"  {RED}FAIL{OFF}  install.sh:{ln} writes {name}= into "
                      f"every operator's wam.conf\n          and the node does "
                      f"not accept -{name}")

    missing = [o for o in actual if o not in set(listed)]
    extra = [o for o in listed if o not in set(actual)]

    for o in missing[:12]:
        print(f"  {RED}FAIL{OFF}  the binary accepts -{o} and the file does "
              f"not list it")
    if len(missing) > 12:
        print(f"          ... and {len(missing) - 12} more")
    for o in extra[:12]:
        print(f"  {RED}FAIL{OFF}  the file lists -{o} and the binary does not "
              f"accept it")
    if len(extra) > 12:
        print(f"          ... and {len(extra) - 12} more")

    print()
    if installer_bad:
        print(f"  {RED}{BLD}install.sh writes a setting the node does not "
              f"have{OFF}")
        print("  Remove it, with whatever comment above it explains when to")
        print("  use it. An option the node ignores is a line the operator")
        print("  believes is doing something.\n")
        return 1
    if extra and not missing:
        # THE FILE KNOWS SOMETHING THIS BINARY DOES NOT, AND THAT IS USUALLY
        # THE BINARY'S FAULT.
        #
        # Options only ever leave a node when a build turns a capability off.
        # So a file listing more than the binary accepts most often means the
        # binary was configured without something the release has -- and the
        # old advice here, "regenerate it", would then DELETE those options
        # from the file.
        #
        # On 9 November 2026 that was ten lines away from happening: the node
        # built on this project's WSL by install.sh has no ZMQ, so it accepted
        # 126 options against the file's 136, and the ten it did not know were
        # -zmqpub* -- the entire reason v0.1.13 exists. Regenerating would have
        # removed them and the check would then have passed.
        #
        # The direction decides the advice. Nothing is regenerated from a
        # binary that is missing things.
        print(f"  {RED}{BLD}this binary accepts fewer options than the file "
              f"documents{OFF}")
        print("  DO NOT regenerate from it. Check first whether the binary is")
        print("  the incomplete one: a node built without ZMQ, without the")
        print("  wallet, or without the GUI accepts fewer options than a")
        print("  release does, and regenerating would delete what it lacks.")
        print()
        print("  If this binary IS a full release build, then the options")
        print("  above were genuinely removed and the file should be rebuilt:")
        print(f"      bash scripts/gen_wam_conf.sh {wamd.parent}\n")
        return 1
    if missing or extra:
        print(f"  {RED}{BLD}the example configuration is out of date{OFF}")
        print("  Regenerate it rather than editing the list by hand:")
        print(f"      bash scripts/gen_wam_conf.sh {wamd.parent}")
        print()
        print("  An operator reads this file to find out what the node can do.")
        print("  A setting the node has and the file does not is a setting he")
        print("  concludes does not exist.\n")
        return 1

    print(f"  {GRN}{BLD}every option the binary accepts is in the file, and "
          f"nothing else is{OFF}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
