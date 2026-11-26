#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""The pool's lockfile must exist, be complete, and agree with package.json.

WHY THIS IS A GUARD AND NOT A COMMENT

pool/package.json names its dependencies as RANGES. `ioredis: ^5.4.1` means
any 5.x, so `npm install` resolves them at the moment it runs and two
machines installing a month apart are not running the same software -- the
live pool has been on ioredis 5.11.1, not the 5.4.1 the file names. Nine
packages reach a production pool and two of them are named; the other seven
arrive because something else asked for them.

This pool holds every miner's balance in redis and drives payouts through
the node's wallet RPC. A compromised patch release of any of those nine
would land on the next install with nothing changing in this repository.
package-lock.json pins every one by version and integrity hash and `npm ci`
refuses anything that does not match, which turns that attack into a failed
install.

All of which is worth exactly nothing if the lockfile and package.json drift
apart. `npm ci` does refuse when they disagree -- but it refuses on the
operator's machine, at the moment they are trying to bring a pool up, and
the error it prints is about npm rather than about us. This refuses here,
where the mistake was made and can be fixed in one command.

WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT

It compares the dependency RANGES, not the resolved versions: the root entry
of a lockfile records the same ranges package.json declares, so a dependency
added, removed or re-ranged without regenerating the lock is caught exactly.
It does not resolve semver and it does not reach the network -- a guard that
needs a registry is a guard that fails on a train.

    exit 0  the lockfile is present and agrees
    exit 1  it is missing, incomplete, or disagrees
    exit 2  the files could not be read or parsed
"""

import json
import os
import sys

GRN, RED, YLW, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[0m"
if not sys.stdout.isatty():
    GRN = RED = YLW = OFF = ""

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.join(ROOT, "pool", "package.json")
LOCK = os.path.join(ROOT, "pool", "package-lock.json")

problems = []
notes = []


def bad(msg):
    problems.append(msg)


def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        print("%serror%s  %s is not there" % (RED, OFF, path))
        sys.exit(1 if path == LOCK else 2)
    except (OSError, ValueError) as err:
        print("%serror%s  %s could not be read: %s" % (RED, OFF, path, err))
        sys.exit(2)


pkg = load(PKG)
lock = load(LOCK)

# ---- 1. the lockfile is a modern one ---------------------------------------
#
# lockfileVersion 1 (npm 6) has no `packages` map and no integrity hashes for
# the tree, so it pins far less than it looks like it pins.
version = lock.get("lockfileVersion")
if not isinstance(version, int) or version < 2:
    bad("lockfileVersion is %r; 2 or 3 is needed for integrity hashes over "
        "the whole tree. Regenerate with a current npm." % (version,))

packages = lock.get("packages")
if not isinstance(packages, dict) or "" not in packages:
    bad("the lockfile has no root `packages` entry, so there is nothing to "
        "compare against package.json")
    packages = {"": {}}

root = packages.get("", {})

# ---- 2. every declared dependency is in the lockfile, at the same range ----
for field in ("dependencies", "devDependencies"):
    declared = pkg.get(field) or {}
    locked = root.get(field) or {}

    for name, spec in sorted(declared.items()):
        if name not in locked:
            bad("package.json declares %s under %s and the lockfile does not "
                "know about it -- run `npm install` in pool/ and commit the "
                "lockfile it writes" % (name, field))
        elif locked[name] != spec:
            bad("%s is %s in package.json and %s in the lockfile -- the range "
                "was changed without regenerating the lock"
                % (name, spec, locked[name]))

    for name in sorted(locked):
        if name not in declared:
            bad("the lockfile still carries %s under %s and package.json no "
                "longer declares it" % (name, field))

# ---- 3. every package in the tree is pinned AND hashed ---------------------
#
# A tree entry without `resolved` and `integrity` is a package npm will fetch
# by range at install time, which is the thing this file exists to prevent.
# Link entries (a workspace, or a local path) legitimately have neither.
unhashed = []
for path, entry in sorted(packages.items()):
    if path == "" or not isinstance(entry, dict):
        continue
    if entry.get("link") is True:
        continue
    if not entry.get("integrity"):
        unhashed.append(path)

if unhashed:
    shown = ", ".join(unhashed[:6])
    more = "" if len(unhashed) <= 6 else " and %d more" % (len(unhashed) - 6)
    bad("%d package(s) in the lockfile carry no integrity hash, so npm ci "
        "cannot tell if what it downloads is what was pinned: %s%s"
        % (len(unhashed), shown, more))

pinned = sum(1 for p, e in packages.items()
             if p and isinstance(e, dict) and not e.get("link"))
runtime = sum(1 for p, e in packages.items()
              if p and isinstance(e, dict) and not e.get("link")
              and not e.get("dev"))
notes.append("%d packages pinned, %d of them reach a production pool "
             "(--omit=dev)" % (pinned, runtime))

# ---- 4. and the thing that installs it asks for exactly that ---------------
#
# A committed lockfile that nothing installs from is decoration. install.sh
# is the recipe CI follows and the one an operator is told to run.
install_sh = os.path.join(ROOT, "install.sh")
try:
    with open(install_sh, encoding="utf-8") as handle:
        recipe = handle.read()
except OSError:
    recipe = ""
    bad("install.sh could not be read, so it is not known whether anything "
        "installs from the lockfile")

if recipe:
    uses_ci = "npm ci" in recipe
    # `npm install` inside a comment is fine; a line that runs it is not.
    runs_install = any(
        line.strip().startswith("npm install")
        for line in recipe.splitlines())
    if not uses_ci:
        bad("install.sh does not run `npm ci`, so the lockfile pins nothing "
            "that actually gets installed")
    if runs_install:
        bad("install.sh still runs `npm install`, which resolves ranges "
            "afresh and rewrites the lockfile -- use `npm ci`")

# ---- say it ----------------------------------------------------------------
print()
if problems:
    print("%sthe pool's lockfile does not hold%s" % (RED, OFF))
    for p in problems:
        print("  %sFAIL%s  %s" % (RED, OFF, p))
    print()
    sys.exit(1)

print("%sok%s    pool/package-lock.json agrees with package.json"
      % (GRN, OFF))
for n in notes:
    print("      %s" % n)
print("%sok%s    install.sh installs from it with npm ci" % (GRN, OFF))
print()
sys.exit(0)
