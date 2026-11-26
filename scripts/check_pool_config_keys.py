#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""A config key the code reads under a name no config file writes.

WHAT THIS CATCHES, AND WHY IT IS NARROW ON PURPOSE

pool/scripts/resolve_lost_payment.js read `config.daemon`. Every config this
project ships -- example, mainnet, testnet -- writes `daemons`. So the value
was undefined, the Daemon constructor threw "at least one daemon must be
configured", and the script exited 2 before doing anything.

That script is the one the pool's own pause banner tells the operator to run
when a payment is lost. It is the only sanctioned recovery path, it could
not start on any shipped config, and nothing noticed, because nothing runs
it: a singular read of a plural key is invisible to every test that does not
execute that exact line with a real config.

Reported by mpit, 26 November 2026, with the one-word fix.

So this guard looks for exactly that shape: a key the code reads, that no
config file defines, whose name is one `s` away from a key that IS defined.
Not "every key that is not in the example config" -- `apiHealthDetail`,
`apiProxyPeers` and `apiUntrustedProxyFactor` are real settings a reader is
told about in comments rather than in the file, and flagging those would
produce a guard the next reader learns to ignore. A singular/plural mismatch
is never deliberate.

It is also case-insensitive, because `config.poolAddress` read as
`config.pooladdress` fails the same silent way.

    exit 0  nothing reads a near-miss of a defined key
    exit 1  something does
    exit 2  the files could not be read
"""

import glob
import io
import json
import os
import re
import sys

GRN, RED, OFF = "\033[32m", "\033[31m", "\033[0m"
if not sys.stdout.isatty():
    GRN = RED = OFF = ""

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

CONFIGS = sorted(glob.glob("pool/config*.json"))
SOURCES = (sorted(glob.glob("pool/lib/*.js"))
           + sorted(glob.glob("pool/scripts/*.js"))
           + ["pool/server.js"])

if not CONFIGS:
    print("%serror%s  no pool/config*.json to compare against" % (RED, OFF))
    sys.exit(2)

defined = set()
for path in CONFIGS:
    try:
        with io.open(path, encoding="utf-8") as handle:
            blob = json.load(handle)
    except (OSError, ValueError) as err:
        print("%serror%s  %s: %s" % (RED, OFF, path, err))
        sys.exit(2)
    # A leading underscore is this project's convention for the prose that
    # explains the key beside it, not a key.
    defined |= {k for k in blob if not k.startswith("_")}

# Nested one level too: `redis.password` is written as a key of `redis`, and
# a script reading `config.redis.pasword` fails just as quietly.
nested = {}
for path in CONFIGS:
    with io.open(path, encoding="utf-8") as handle:
        blob = json.load(handle)
    for key, value in blob.items():
        if isinstance(value, dict):
            nested.setdefault(key, set()).update(
                k for k in value if not k.startswith("_"))

lower = {d.lower(): d for d in defined}

read = {}
for path in SOURCES:
    if not os.path.exists(path):
        continue
    try:
        with io.open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError as err:
        print("%serror%s  %s: %s" % (RED, OFF, path, err))
        sys.exit(2)
    for match in re.finditer(r"\bconfig\.([a-zA-Z_][a-zA-Z0-9_]*)", text):
        read.setdefault(match.group(1), set()).add(path)

problems = []
for key in sorted(read):
    if key in defined:
        continue
    # "config.json" and "config.example" come from file names in prose.
    if key in ("json", "example"):
        continue

    candidates = set()
    low = key.lower()
    for other_low, other in lower.items():
        if other_low == low:                      # differs only by case
            candidates.add(other)
        elif other_low == low + "s":              # read singular, defined plural
            candidates.add(other)
        elif low == other_low + "s":              # read plural, defined singular
            candidates.add(other)
    if candidates:
        problems.append((key, sorted(candidates), sorted(read[key])))

# The same question one level down, for the keys that hold an object.
for parent, children in sorted(nested.items()):
    child_lower = {c.lower(): c for c in children}
    for path in SOURCES:
        if not os.path.exists(path):
            continue
        with io.open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
        pattern = r"\bconfig\.%s\.([a-zA-Z_][a-zA-Z0-9_]*)" % re.escape(parent)
        for match in re.finditer(pattern, text):
            child = match.group(1)
            if child in children:
                continue
            low = child.lower()
            near = sorted({child_lower[o] for o in child_lower
                           if o == low or o == low + "s" or low == o + "s"})
            if near:
                problems.append(("%s.%s" % (parent, child),
                                 ["%s.%s" % (parent, n) for n in near],
                                 [path]))

print()
if problems:
    print("%sa config key is read under a name no config file writes%s"
          % (RED, OFF))
    for key, near, where in problems:
        print("  %sFAIL%s  config.%s is read in %s"
              % (RED, OFF, key, ", ".join(where)))
        print("        every shipped config writes %s" % (", ".join(near),))
        print("        so the value is undefined, every time, on every host")
    print()
    sys.exit(1)

print("%sok%s    every pool config key the code reads is one a config writes"
      % (GRN, OFF))
print("      %d keys defined across %d config files, %d read in %d sources"
      % (len(defined), len(CONFIGS), len(read), len(SOURCES)))
print()
sys.exit(0)
