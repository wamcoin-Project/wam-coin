# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 components.py -- what this project ships, what it runs, and on whose clock
===============================================================================

 WHY THIS FILE EXISTS

 Every shippable thing here moves on one version number. The node, the
 miner, the wallet, the pool, the explorer, the site and the tooling all
 carry v0.1.12 because the node does. So improving a tool forces a node
 release, and a node release is consensus-critical software that strangers
 run -- which is why Bitcoin Core ships about twice a year and not because
 there is nothing to do.

 Decided by the founder on 16 October 2026, and written into
 docs/ROADMAP.md Phase 5.4: the node moves rarely and deliberately, and the
 things around it move whenever each is ready. That cannot be done while one
 number means seven things, and undoing it is the work.

 THIS FILE IS THE FIRST PART OF THAT, AND IT IS CHEAP TODAY.

 Right now there is one train and seven components, so this file says so in
 a few lines. At ten times the size the same change is a migration that
 touches other people's workflows. The founder's rule, given more than once:
 build the base for what it will be, so that growing is adding rather than
 breaking.

 WHAT READS IT

 scripts/set_version.py            where a train's version lives
 scripts/test/test_announcement_covers_release.py   what ships, by name

 and anything else that would otherwise hard-code the same answer. The
 lesson is already written in scripts/lib/docversion.py, which exists for
 exactly this reason: keeping two copies in agreement is not agreement.

 WHAT IT DOES NOT DO

 It does not split anything. Every component below is on the one train
 there is, and the checks that enforce a single version still enforce it.
 Splitting is a later change to this file and to the guards that read it --
 which is the point: the guards learn to ask before the answer changes,
 not after.
===============================================================================
"""

from __future__ import annotations

import pathlib
import re

SCHEMA = 1

# ---------------------------------------------------------------------------
#  Trains
# ---------------------------------------------------------------------------
#
# A train is a thing that gets a version number and a release of its own.
# There is one today. `source` and `pattern` are where that number actually
# lives, so set_version.py stops knowing the path by heart -- it moved once
# already, from a hand-edited constant to patch_upstream.py, and nothing
# recorded the move except the diff.

TRAINS = {
    "node": {
        "source":  "scripts/patch_upstream.py",
        "pattern": r'(WAM_CLIENT_VERSION\s*=\s*")(\d+\.\d+\.\d+)(")',
        "cadence": "rarely, and deliberately",
        "why":     "it is consensus-critical software that strangers run",
    },
}

# ---------------------------------------------------------------------------
#  Components -- the things this project ships
# ---------------------------------------------------------------------------
#
# `recognise` is what a reader would call the thing. The announcement check
# uses it to ask whether the twelve lines the bot actually sends mention
# every artefact in the release: v0.1.11 shipped the first graphical wallet
# this project ever built and the channels were never told it existed, and
# somebody in the chat filled that silence by building one of his own.
#
# `archives` is the suffix after the version, not the whole name, so adding
# a platform is one line rather than three.

COMPONENTS = [
    {
        "name":      "wam-coin",
        "train":     "node",
        "kind":      "consensus",
        "recognise": ("node", "wamd", "wam-coin"),
        "archives":  ("x86_64-linux-gnu.tar.gz",
                      "x86_64-w64-mingw32.zip",
                      "arm64-apple-darwin.tar.gz"),
        "note":      "the node and the command-line tools; the only component "
                     "whose release has to be slow",
    },
    {
        "name":      "wam-miner",
        "train":     "node",
        "kind":      "tool",
        "recognise": ("miner", "mine", "wam-miner"),
        "archives":  ("x86_64-linux-gnu.tar.gz",
                      "x86_64-w64-mingw32.zip",
                      "arm64-apple-darwin.tar.gz"),
        "note":      "RandomX CPU miner. Not consensus: it builds candidate "
                     "blocks and the node decides whether they are valid",
    },
    {
        "name":      "wam-qt",
        "train":     "node",
        "kind":      "tool",
        "recognise": ("wallet", "wam-qt", "graphical"),
        "archives":  ("x86_64-linux-gnu.tar.gz",
                      "x86_64-w64-mingw32.zip",
                      "arm64-apple-darwin.tar.gz"),
        "note":      "the same node with a window on it, shipped separately "
                     "so a node is not several times larger for the people "
                     "who never open one",
    },
]

# ---------------------------------------------------------------------------
#  Services -- what this project RUNS, which is not what it ships
# ---------------------------------------------------------------------------
#
# These are deployed from a checkout rather than released, so they have no
# version of their own and never appear in a SHA256SUMS. They are listed
# because "what does this project run" had no single answer, and the ops
# panel, the sweep and docs/LAUNCH_DAY.md each carried their own partial one.
#
# Read off the hosts on 2026-10-18 rather than remembered.

SERVICES = [
    {"unit": "wamd.service",              "where": "all three", "what": "testnet node"},
    {"unit": "wamd-mainnet.service",      "where": "all three", "what": "mainnet node"},
    {"unit": "wam-pool.service",          "where": "Germany",    "what": "stratum pool"},
    {"unit": "wam-announce.service",      "where": "Germany",    "what": "Telegram and Discord announcements"},
    {"unit": "wam-dashboard.service",     "where": "Germany",    "what": "the ops panel"},
    {"unit": "electrumx@mainnet.service", "where": "Germany, US-east", "what": "Electrum server"},
    {"unit": "electrumx@testnet.service", "where": "Germany, US-east", "what": "Electrum server, testnet"},
    {"unit": "wam-miner.service",         "where": "Germany, US-east", "what": "our own miner"},
]


# ---------------------------------------------------------------------------
#  Reading it
# ---------------------------------------------------------------------------

class ComponentError(ValueError):
    pass


def train_version_file(repo, train="node"):
    """(path, compiled pattern) for where a train's version is written."""
    t = TRAINS.get(train)
    if t is None:
        raise ComponentError(f"no train named {train!r}")
    return pathlib.Path(repo) / t["source"], re.compile(t["pattern"])


def train_version(repo, train="node"):
    """The version that train is on, read from the file that defines it."""
    path, pattern = train_version_file(repo, train)
    if not path.is_file():
        raise ComponentError(f"{t_src(train)} is not here, so no version "
                             f"could be read")
    m = pattern.search(path.read_text(encoding="utf-8", errors="replace"))
    if m is None:
        raise ComponentError(f"{t_src(train)} does not carry the version "
                             f"pattern this file says it does")
    return m.group(2)


def t_src(train="node"):
    return TRAINS[train]["source"]


def shipped(train=None):
    """The components that are released, optionally on one train."""
    return [c for c in COMPONENTS if train is None or c["train"] == train]


def archive_names(version, train=None):
    """Every file name a release of that train publishes, version included."""
    v = version if version.startswith("v") else "v" + version
    return [f"{c['name']}-{v}-{suffix}"
            for c in shipped(train) for suffix in c["archives"]]


def recognise_pairs():
    """[(name, words)] -- what each shipped thing is called, for text checks."""
    return [(c["name"], c["recognise"]) for c in COMPONENTS]


def check(repo):
    """Is this file true about the repository it describes?

    A manifest nobody verifies is a second place to be wrong. Returns a list
    of complaints; empty means it describes what is actually here.
    """
    problems = []
    repo = pathlib.Path(repo)
    for name, t in TRAINS.items():
        path = repo / t["source"]
        if not path.is_file():
            problems.append(f"train {name!r} says its version lives in "
                            f"{t['source']}, and that file is not here")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if re.compile(t["pattern"]).search(text) is None:
            problems.append(f"train {name!r} names {t['source']}, which does "
                            f"not carry the pattern given for it")
    for c in COMPONENTS:
        if c["train"] not in TRAINS:
            problems.append(f"component {c['name']!r} is on train "
                            f"{c['train']!r}, which is not defined")
        if not c["archives"]:
            problems.append(f"component {c['name']!r} ships no archive")
        if not c["recognise"]:
            problems.append(f"component {c['name']!r} has no word a reader "
                            f"would recognise it by")
    return problems
