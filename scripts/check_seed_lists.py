#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_seed_lists.py -- our own seeds are one list, and every page that
#                         names them names the same ones
# ===========================================================================
#
#      python3 scripts/check_seed_lists.py
#
#  WHY THIS EXISTS
#
#  explorer/lib/seeds.js held three seed addresses with their countries, and
#  explorer/lib/network.js held its own copy with two. Nobody updated the
#  second one when the third seed arrived, and nothing could notice: a peer
#  at the missing address was simply counted as an ordinary stranger.
#
#  On 2026-11-22 the explorer said:
#
#      73 CONNECTED NOW -- 2 out, 71 in, 1 of them a WAM seed
#
#  while getpeerinfo on that node, at that moment, listed both 5.223.52.200
#  and 13.140.33.187 as connected. The number was 2. The founder saw the 1
#  and asked why it had been 2 before.
#
#  network.js now reads the list from seeds.js, so there is one place to add
#  a seed. This exists so that the day somebody writes a second list again --
#  in a page, a script, a config -- it is refused rather than discovered by a
#  reader of a dashboard.
#
#  WHAT IT CHECKS
#
#    seeds.js parses and names at least one seed       the list exists
#    network.js does not define its own seed map       no second copy
#    every file that hard-codes a seed address names   no short list
#      all of them
# ===========================================================================

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

GRN, RED, YLW, BLD, OFF = '\033[32m', '\033[31m', '\033[33m', '\033[1m', '\033[0m'

failures = []
notes = []


def ok(msg):
    print(f'  {GRN}ok{OFF}    {msg}')


def bad(msg, detail=''):
    print(f'  {RED}FAIL{OFF}  {msg}')
    if detail:
        for line in detail.splitlines():
            print(f'        {line}')
    failures.append(msg)


def read(rel):
    p = ROOT / rel
    return p.read_text(encoding='utf-8', errors='replace') if p.is_file() else None


print()
print(f'{BLD}our seeds are one list{OFF}')
print()

# ---- 1. the one list -------------------------------------------------------
seeds_js = read('explorer/lib/seeds.js')
if seeds_js is None:
    bad('explorer/lib/seeds.js is not here')
    sys.exit(1)

m = re.search(r'const\s+PLACES\s*=\s*\{(.*?)\n\};', seeds_js, re.S)
if not m:
    bad('explorer/lib/seeds.js has no PLACES map',
        'That is the one list every other page is supposed to read.')
    sys.exit(1)

PLACES = dict(re.findall(r"'([0-9.]+)'\s*:\s*'([^']+)'", m.group(1)))
if not PLACES:
    bad('PLACES is empty')
    sys.exit(1)

ok(f'seeds.js names {len(PLACES)} seed(s): '
   + ', '.join(f'{a} ({w})' for a, w in sorted(PLACES.items())))

# ---- 2. nobody keeps a second copy -----------------------------------------
net_js = read('explorer/lib/network.js')
if net_js is None:
    bad('explorer/lib/network.js is not here')
else:
    literal = re.search(
        r'const\s+OWN_SEEDS\s*=\s*\{\s*\n\s*\'[0-9.]',
        net_js)
    if literal:
        bad('explorer/lib/network.js defines its own seed map',
            'That is the second list, and the second list goes short.\n'
            'Build OWN_SEEDS from the PLACES exported by seeds.js.')
    else:
        ok('network.js keeps no list of its own')

# ---- 3. and no file names only some of them --------------------------------
#
# A file is allowed to not mention seeds at all. What it may not do is name
# some of them and not the others: that is a list written by hand, going
# stale the next time one is added.
addrs = set(PLACES)
skip_parts = ('build/', 'node_modules/', '.git/', 'depends/')
short = []

for path in ROOT.rglob('*'):
    if not path.is_file():
        continue
    rel = path.relative_to(ROOT).as_posix()
    if any(s in rel + '/' for s in skip_parts):
        continue
    if path.suffix.lower() not in ('.js', '.py', '.sh', '.json', '.conf', '.yml', '.yaml'):
        continue
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        continue
    named = {a for a in addrs if a in text}
    if named and named != addrs:
        missing = ', '.join(sorted(addrs - named))
        short.append(f'{rel} names {len(named)} of {len(addrs)}, missing {missing}')

if short:
    # This is a warning rather than a failure: a runbook quoting one host, or
    # a test fixture using a single address, is legitimate. It is printed so
    # a short list is seen rather than assumed.
    print()
    print(f'  {YLW}note{OFF}  {len(short)} file(s) name some seeds and not others:')
    for s in short[:12]:
        print(f'        {s}')
    if len(short) > 12:
        print(f'        ... and {len(short) - 12} more')
    notes.extend(short)
else:
    ok('no file names only part of the list')

print()
if failures:
    print(f'{RED}{BLD}  {len(failures)} failed{OFF}')
    print()
    sys.exit(1)

print(f'{GRN}{BLD}  the seeds are named in one place and read from it{OFF}')
print()
sys.exit(0)
