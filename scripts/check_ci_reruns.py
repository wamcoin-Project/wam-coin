#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_ci_reruns.py -- a failing job is diagnosed, not run again
# ===========================================================================
#
#      python3 scripts/check_ci_reruns.py            # asks GitHub
#      python3 scripts/check_ci_reruns.py --offline  # says so and stops
#
#  WHY THIS EXISTS
#
#  The account suspended on 2026-10-29 was the second, and unlike the first
#  it came with no message and no reason. This repository recorded that gap
#  honestly and then, on 2026-10-31, filled it with a guess.
#
#  The founder supplied the actual answer, because he watched it happen: a
#  workflow was started, it failed, and it was started again. Once, twice,
#  three times. Not a build that was forbidden -- a build that was repeated.
#
#  GitHub's own terms name it, fourth in the Actions list:
#
# wam:quote-begin
#      Any activity that places a burden on our servers, where that burden is
#      disproportionate to the benefits provided to users
# wam:quote-end
#
#  A failed run repeated without a change between is exactly that. Nothing
#  new is produced, their machines are spent, and an abuse detector counts
#  runs and cannot see an intention.
#
#  THE RULE THIS ENFORCES
#
#  A failing job is read, reproduced on our own machine, fixed, and only then
#  run again. One retry for a genuine flake is a retry. The third run of the
#  same workflow against the same commit is the pattern that cost an account.
#
#  WHAT IT CANNOT DO
#
#  It cannot stop the click. It counts what already happened, which is the
#  only thing an API can see, and it is in the sweep so the count is read
#  before the next release rather than after the next suspension. The part
#  that prevents is not code: it is that a build is proved locally first --
#  scripts/build_linux.sh, build_windows.sh and the test scripts all run
#  without a runner.
#
#  Exit 0 all good, 1 the pattern is present, 2 the question could not be
#  asked -- which is never the same as an answer.
# ===========================================================================

import collections
import json
import subprocess
import sys

REPO = "wamcoin-Project/wam-coin"

# Two runs of one workflow against one commit is a retry. Three is the thing
# that was being done when the account went.
LIMIT = 2

GRN, RED, YLW, BLD, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[0m"


def runs():
    """Every workflow run GitHub still holds, or None if it cannot be asked.

    subprocess.run RAISES when the binary is not there. It does not come back
    with a non-zero status, so "gh is missing" -- which the message in main()
    has named since this check was written -- was never reached by the thing
    it describes.

    On 2026-11-05 the sweep was run on US-east, where gh is not installed. The
    traceback killed the script, the sweep read exit 1, and the row printed

        a failure is read, not repeated    FAIL

    which says a failing workflow is being started over and over. That is the
    pattern that cost an account on 29 October. Nothing had been measured.
    A false alarm on this row in particular is how the true one gets ignored.

    The timeout is the same lesson one step further on: `gh api --paginate`
    walks every run GitHub still holds, and on a slow link it had no bound at
    all. TimeoutExpired is a SubprocessError, so both ways of failing to ask
    arrive here as None, and main() turns None into exit 2 -- "could not
    run", which the sweep reports as such instead of counting it a failure.

    check_components.py, one file away, has asked gh this way all along.
    """
    try:
        p = subprocess.run(
            ["gh", "api", "--paginate",
             f"repos/{REPO}/actions/runs?per_page=100",
             "--jq", ".workflow_runs[] | {name, head_sha, conclusion, created_at}"],
            capture_output=True, text=True, timeout=120,
            encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    out = []
    for line in p.stdout.splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                return None
    return out


def main():
    print(f"\n{BLD}is a failing job being run again instead of read?{OFF}")

    if "--offline" in sys.argv:
        print(f"  {YLW}skipped{OFF}  --offline, so GitHub was not asked")
        print()
        return 2

    data = runs()
    if data is None:
        print(f"  {YLW}!!{OFF}    GitHub could not be asked -- gh is missing, "
              f"unauthenticated,")
        print(f"          or the network is down. Nothing here says the "
              f"pattern is absent.")
        print()
        return 2

    if not data:
        print(f"  {GRN}ok{OFF}    no workflow run exists on {REPO}")
        print()
        print(f"  {GRN}{BLD}nothing has been run, so nothing has been "
              f"re-run{OFF}\n")
        return 0

    per = collections.Counter((r["name"], r["head_sha"]) for r in data)
    heavy = sorted(((n, sha, c) for (n, sha), c in per.items() if c > LIMIT),
                   key=lambda t: -t[2])

    failed = sum(1 for r in data if r.get("conclusion") == "failure")
    print(f"  {GRN}ok{OFF}    {len(data)} run(s) seen, {failed} of them failed")

    if heavy:
        print(f"  {RED}FAIL{OFF}  {len(heavy)} workflow/commit pair(s) run more "
              f"than {LIMIT} times")
        for name, sha, c in heavy[:8]:
            print(f"          {c:>3} runs   {name}   @ {sha[:7]}")
        print()
        print("        Same workflow, same commit. Nothing between the runs")
        print("        changed, so nothing new could come out of them.")
        print("        That is the burden their terms call disproportionate,")
        print("        and it is what the account was doing when it went on")
        print("        2026-10-29. Read the log, reproduce it here, fix it,")
        print("        then run it once.")
        print()
        return 1

    print(f"  {GRN}ok{OFF}    no workflow was run more than {LIMIT} times on "
          f"one commit")
    print()
    print(f"  {GRN}{BLD}a failure here is read, not repeated{OFF}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
