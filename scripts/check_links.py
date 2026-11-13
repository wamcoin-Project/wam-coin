#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_links.py -- does every link in every document point at something?
# ===========================================================================
#
#      python3 scripts/check_links.py
#
#  WHY THIS EXISTS
#
#  audit_repo.sh already refuses a broken file reference, and has since
#  August. It looks for paths beginning with one of a dozen named top-level
#  directories:
#
# wam:quote-begin
#      (brand|docs|scripts|genesis|deploy|site|pool|explorer|bots|miner)/...
# wam:quote-end
#
#  integration/ is not in that list, and neither is any RELATIVE link -- a
#  document saying `wallet-confs/x.conf` names a file beside itself, with no
#  top-level directory in it at all.
#
#  So on 6 September 2026, integration/blockdx/PR.md and NOTES.md both linked
#  to
#
# wam:quote-begin
#      wallet-confs/wamcoin--v0.1.3.conf
#      xbridge-confs/wamcoin--v0.1.3.conf
# wam:quote-end
#
#  which have not existed since the coin's prefix changed from `wamcoin` to
#  `wam` and the configs moved to v0.1.6. PR.md is the text submitted to the
#  BlockDX repository as a pull request: we would have described our own
#  files by names nobody could find, to the people deciding whether to list
#  this coin.
#
#  A path is relative to the document that writes it. That is the whole idea,
#  and no list of directory names can express it.
#
#  WHAT IS NOT CHECKED
#
#  http(s) links. Reaching the network makes a check that fails when a site
#  is briefly down, and a check that cries wolf is one people stop reading --
#  which is how three faults stayed live at once on 19 August. Anchors
#  (#section) are not resolved either; a wrong anchor lands the reader on the
#  right page.
# ===========================================================================

import os
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts" / "lib"))
import quoted  # noqa: E402  -- needs the path above

GRN, RED, YLW, BLD, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[0m"

# Markdown links only -- [text](target). A bare `path/like/this.ext` in
# backticks is not followed, and the distinction is not cosmetic.
#
# The integration notes are tables of "our file -> where it goes in THEIR
# repository":
#
# wam:quote-begin
#     | [`chainparams.py`](chainparams.py) | `basicswap/interface/wam/chainparams.py` |
# wam:quote-end
#
# The left cell is a link to a file here and must resolve. The right cell is
# a path inside BasicSwap's tree, correct and absent from this repository by
# definition. Following backticked paths reported twenty of those as broken
# on the first run -- a check objecting to correct text, which teaches its
# reader to skip the output, and is how three faults stayed live at once on
# 19 August.
#
# The blockdx fault that prompted this check was in the LEFT cell, so nothing
# is lost: a link is a claim that a file is there, and a code span is prose.
MD_LINK = re.compile(r"\[[^\]]*\]\(\s*([^)\s]+)")

SKIP_PREFIX = ("http://", "https://", "mailto:", "#", "ftp://", "//")

# Named on purpose without existing: created by the reader, or kept out by
# .gitignore. Each is a decision, and git is asked about the rest.
EXPECTED_ABSENT = re.compile(r"config\.json$|config-mainnet\.json$|wam\.conf$")


def tracked_markdown():
    out = subprocess.run(["git", "ls-files", "*.md"], cwd=str(REPO),
                         capture_output=True, text=True).stdout.split()
    return sorted(out)


def tracked_paths():
    """Every path git serves, plus every directory on the way to one.

    THE DIFFERENCE BETWEEN "IT IS HERE" AND "A READER CAN OPEN IT".

    This check asked the filesystem. `review/REVIEW_RESPONSE.md` is on this
    machine and is in .gitignore -- deliberately, it is a named reviewer's
    correspondence and his to publish -- and README.md linked to it twice, in
    the status table and in the paragraph under it. Both resolved here and
    both were 404 for every reader of the repository, from the day the
    directory was ignored until 13 November 2026, when an outside reader
    followed them and said so.

    Worse, the old code went on to SKIP a target that `git check-ignore`
    matched, as though being ignored were a reason the link was fine. It is
    the reason the link is broken: the file is not served to anyone but us.

    It is the same mistake `public()` in check_published_claims.py was
    written to document -- audit_repo.sh asking whether a file happened to
    exist on this machine -- made one script along.

    Directories are included because a link may point at one, and a directory
    is not itself an entry in the index.
    """
    out = subprocess.run(["git", "ls-files", "-z"], cwd=str(REPO),
                         capture_output=True, text=True).stdout
    paths = set()
    for rel in out.split("\0"):
        if not rel:
            continue
        paths.add(rel)
        parts = rel.split("/")
        for i in range(1, len(parts)):
            paths.add("/".join(parts[:i]))
    return paths


def targets(text):
    """Every local path a document points at, with its line number."""
    found = []
    for i, line in quoted.unquoted_lines(text):
        for m in MD_LINK.finditer(line):
            found.append((i, m.group(1)))
    return found


def main():
    print(f"\n{BLD}every link points at something that is here{OFF}")

    docs = tracked_markdown()
    if not docs:
        print(f"  {RED}FAIL{OFF}  no markdown was found -- this proves nothing")
        print()
        return 2

    served = tracked_paths()
    if not served:
        print(f"  {RED}FAIL{OFF}  git listed no files -- nothing was compared")
        print()
        return 2

    broken, checked = [], 0
    for rel in docs:
        path = REPO / rel
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line_no, target in targets(text):
            if target.startswith(SKIP_PREFIX):
                continue
            target = target.split("#", 1)[0].strip()
            if not target:
                continue
            if EXPECTED_ABSENT.search(target):
                continue
            # Relative to the document that writes it -- which is the point.
            # Asked of the index, not of this disk: every document scanned
            # here is one git serves, so every path it points at has to be
            # one git serves too.
            checked += 1
            here = pathlib.PurePosixPath(rel).parent
            forms = {
                os.path.normpath(str(here / target)).replace("\\", "/"),
                target.lstrip("/").rstrip("/"),
            }
            if any(f.rstrip("/") in served for f in forms):
                continue
            # Why it is broken, which is not the same answer every time: a
            # file that is here and ignored reads as fine to anybody checking
            # by hand on this machine, and that is exactly how two of them
            # survived for months.
            on_disk = (path.parent / target).exists() \
                or (REPO / target.lstrip("/")).exists()
            broken.append((rel, line_no, target,
                           "it is on this machine but .gitignore keeps it out "
                           "of the repository, so it is 404 for every reader"
                           if on_disk else "there is no such path"))

    if checked == 0:
        print(f"  {RED}FAIL{OFF}  no link was resolved at all -- this proves nothing")
        print()
        return 2

    if broken:
        print(f"  {RED}FAIL{OFF}  {len(broken)} link(s) a reader cannot follow")
        for rel, line_no, target, why in broken[:12]:
            print(f"          {rel}:{line_no}  ->  {target}")
            print(f"              {why}")
        if len(broken) > 12:
            print(f"          ... and {len(broken) - 12} more")
        print()
        print("        A path is relative to the document that writes it.")
        print("        Some of these documents are submitted to other projects.")
        print()
        return 1

    print(f"  {GRN}ok{OFF}    {checked} link(s) in {len(docs)} document(s) are "
          f"served by git")
    print()
    print(f"  {GRN}{BLD}every link points at something a reader can open{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
