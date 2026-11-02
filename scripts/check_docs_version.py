#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_docs_version.py -- do the instructions name a release that exists?
# ===========================================================================
#
#      python3 scripts/check_docs_version.py
#
#  WHY THIS EXISTS
#
#  docs/START_HERE.md and its Arabic twin are the pages written for someone
#  who has never run a node. They give exact commands to copy:
#
#      curl -LO .../releases/download/v0.1.3/wam-coin-v0.1.3-...tar.gz
#      tar -xzf wam-coin-v0.1.3-...tar.gz
#      cd wam-coin-v0.1.3/bin
#
#  Four releases later those files had been withdrawn, deliberately, because
#  v0.1.3 could not send a transaction and v0.1.4 enforced a treasury address
#  that would fork a node off mainnet at height 1. Both were superseded and
#  their binaries removed -- and the guide still pointed at them.
#
#  So the first command a beginner ran returned 404, and the page written to
#  make them feel capable made them feel stupid instead. It was found by the
#  founder reading his own documentation, not by any check here.
#
#  WHAT IS CHECKED
#
#  Every vX.Y.Z in the documentation is compared against the releases that
#  actually exist on GitHub, and against which of those still have binaries.
#  A version that was withdrawn is worse than one that is merely old: the
#  download does not fail loudly, the tag page loads and looks normal, and
#  only the asset is gone.
#
#  /releases/latest is deliberately NOT used to find the newest. It excludes
#  pre-releases, every WAM release is marked one until 1.0, and it answers
#  404 for this repository -- a check that could never pass.
# ===========================================================================

import pathlib
import sys
import urllib.error

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

REPO = pathlib.Path(__file__).resolve().parent.parent

# Where the downloads actually are, and why: scripts/lib/releases.py. The
# constant and the history that chose it moved there on 2026-11-01, with the
# function that uses them. json, re and urllib.request went with it; they had
# nothing left to do here, and json had had nothing to do here for weeks.
sys.path.insert(0, str(REPO / "scripts" / "lib"))
import docversion  # noqa: E402  -- needs the path above
import releases as releases_lib  # noqa: E402  -- needs the path above

# Discovered, not listed -- and by the same rule set_version.py uses to decide
# what to rewrite, from the same module, so the writer and the auditor cannot
# drift apart.
#
# The list that used to be here named seven files. Two that set_version.py
# rewrites were missing from it (docs/MINE.md, deploy/systemd/laptop/README.md,
# both added on 5 September), and of the site it named only site/index.html --
# which contains no download instruction at all, while site/start/,
# site/mine/ and site/start-ar/ contain eleven between them and were absent.
#
# So this printed "every documented version is one that exists" after reading
# a page that could not fail and skipping every page that could. A check that
# cannot fail is not a check; it is a sentence that makes people stop looking.
def _targets():
    return docversion.documents(REPO) + docversion.pages(REPO)

# Which contexts count, and why prose about old versions must not: see
# scripts/lib/docversion.py. Defined there because set_version.py rewrites
# exactly what this audits, and the two must not be able to disagree.
instructed_versions = docversion.instructed_versions

_fails = []


def ok(m):   print(f"  {GRN}ok{OFF}    {m}")
def bad(m):  print(f"  {RED}FAIL{OFF}  {m}"); _fails.append(m)
def warn(m): print(f"  {YEL}!!{OFF}    {m}")


# What can be downloaded, and which of those is newest: scripts/lib/releases.py.
#
# It used to be written out here. check_running_version.py needs the same
# answer -- our machines must run the version our documents name -- and a
# second copy of this function is how the auditor and the writer came apart
# in docversion.py's own history. One definition, imported twice.
releases = releases_lib.published


def main():
    print(f"\n{BLD}the version the instructions tell people to download{OFF}")
    try:
        rels, newest = releases()
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            # The rate limit, not a fact about our releases. GitHub allows 60
            # unauthenticated calls an hour per address, and this check is one
            # of two here that spend them. Reported as 1 it put "the
            # documented version still exists  FAIL" on the launch panel about
            # documentation that was correct.
            #
            # 2 is this project's code for "the check could not run".
            warn(f"GitHub rate limit ({e.code}) -- the documented versions were "
                 f"NOT compared against the releases. 60 unauthenticated calls "
                 f"an hour; this is not a pass.")
            print()
            return 2
        bad(f"could not read the releases from GitHub: {e}")
        print()
        return 1
    except Exception as e:
        bad(f"could not read the releases from GitHub: {e}")
        print()
        return 1

    if not newest:
        bad("the repository has no releases at all")
        print()
        return 1
    ok(f"newest release: v{newest}")

    checked = 0
    for rel_path in _targets():
        p = REPO / rel_path
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        found = instructed_versions(text)
        ours = docversion.our_versions(text)
        if not found:
            continue
        checked += 1
        for v in sorted(found):
            info = rels.get(v)
            if info is None:
                if v in ours:
                    # A download URL into this repository, or one of this
                    # project's own tarball names, naming a release that does
                    # not exist. The first command a newcomer copies 404s.
                    #
                    # This used to `continue` on every unknown version with
                    # the comment "not one of ours", which is true of a link
                    # to Bitcoin Core v28.1 and false of a curl at our own
                    # releases/download/. The question in this file's title is
                    # exactly this one, and for three days it could not be
                    # asked -- see scripts/lib/docversion.py.
                    #
                    # It is EXPECTED to fail between setting the version and
                    # publishing the release. docs/RELEASING.md says so: the
                    # documents name the tag and the tag is built from the
                    # documents.
                    bad(f"{rel_path} tells the reader to download v{v}, which "
                        f"has never been released. Newest is v{newest}. If a "
                        f"tag is about to be pushed this is the expected and "
                        f"correct state; if not, the instructions are broken.")
                    continue
                # Not one of ours: Bitcoin Core v28.1, RandomX v1.2.1, and so on.
                continue
            if v == newest:
                ok(f"{rel_path}: v{v}")
            elif not info["has_binaries"]:
                bad(f"{rel_path} tells the reader to download v{v}, whose binaries "
                    f"were withdrawn. The tag page still loads, so the download "
                    f"just 404s and the first command a beginner runs fails. "
                    f"Newest is v{newest}.")
            else:
                warn(f"{rel_path} names v{v}, which still has binaries but is not "
                     f"the newest (v{newest})")

    if checked == 0:
        bad("no documentation file was read -- this proves nothing")

    print()
    if _fails:
        print(f"  {RED}{len(_fails)} document(s) point at a release nobody can download{OFF}")
        print("  The guide for people who have never run a node is the one page\n"
              "  where a dead link costs the most.\n")
        return 1
    print(f"  {GRN}every documented version is one that exists{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
