#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""release_watch.py -- keep asking whether what the world can download verifies.

    python3 scripts/release_watch.py                 # once, from a timer
    python3 scripts/release_watch.py --dry-run       # print, send nothing
    python3 scripts/release_watch.py --status        # what it currently believes

WHY THIS EXISTS

On 12 September 2026 v0.1.8 was published. It was the first release carrying
Windows archives, and those are attached to the page by hand: SHA256SUMS.asc
was uploaded and SHA256SUMS was not replaced, so the signature covered a
four-line list while the page still served the runner's two-line one.

Anyone following this project's own instructions was told:

    FAIL  the signature over SHA256SUMS is NOT valid
          SHA256SUMS was changed after it was signed, or the signature is not
          ours. Do not run the binaries.

That is the verifier working exactly as designed, and it is the worst sentence
a coin project can put in front of a stranger deciding whether to trust it.

WHAT THIS IS NOT

It is not a new check. check_release_signed.sh has asked this question since
the day it was written, and its header has always said why:

    Everything else here can be true while the published release is not. The
    signing key can be present, package_release.sh can sign correctly, the
    local files can verify perfectly -- and the asset uploaded to GitHub two
    weeks ago can still be the unsigned one, because uploading is a manual
    step and manual steps get half-done.

The check was right, was written down, and ran only when a person happened to
run the sweep. Nothing asked it at the moment it mattered. This is the timer
that asks.

The announcement bot now refuses to speak about a release that does not
verify, which stops the public being pointed at a broken page. This is the
other half: it catches a release that was ALREADY announced, or was published
before the gate existed, or broke afterwards because somebody re-uploaded an
asset. On the night of 15 September the mainnet release is assembled by hand
the same way, and ten minutes is how long a mistake should be allowed to live.

WHY IT WILL NOT CRY WOLF

It alarms once, when the answer changes to "does not verify", and says so once
more when it recovers -- because the Germany rehearsal on 11 September proved
that the missing half of an alert is not "something broke" but "it is over".

Exit 2 from the check means the question could not be asked: no gpg, no curl,
GitHub unreachable. That is neither a pass nor a finding. It is reported and
nothing is sent, and the question is asked again on the next run.
"""

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from wamnotify import send as notify  # noqa: E402

CHECK = HERE / "check_release_signed.sh"

STATE = pathlib.Path(os.environ.get("WAM_RELEASE_WATCH_STATE",
                                   "/var/lib/wam-release-watch/state.json"))

# The check downloads two small files. Generous, because a slow link is not a
# finding and a timeout that reports "the release is broken" would be a lie.
TIMEOUT = int(os.environ.get("WAM_RELEASE_WATCH_TIMEOUT", "240"))


def load():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(state):
    try:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        tmp.replace(STATE)
    except Exception as e:
        print(f"could not write {STATE}: {e}", file=sys.stderr)


def run_check(tag=None):
    """(exit code, the lines worth quoting).

    Returns None for the code when the check could not be run at all, which is
    different from the check running and reporting that it could not decide.
    """
    if not CHECK.exists():
        return None, f"{CHECK} is not there"
    cmd = ["bash", str(CHECK)]
    if tag:
        cmd.append(tag)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, f"the check did not finish within {TIMEOUT}s"
    except Exception as e:
        return None, f"the check could not be run: {e}"

    text = re.sub(r"\x1b\[[0-9;]*m", "", (r.stdout or "") + (r.stderr or ""))
    said = [ln.strip() for ln in text.splitlines()
            if re.search(r"FAIL|!!|could not", ln, re.I)]
    return r.returncode, "\n".join(said[:6])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be sent, send nothing")
    ap.add_argument("--status", action="store_true",
                    help="print what this watcher currently believes, and exit")
    ap.add_argument("--tag", default=None,
                    help="check this tag instead of the newest release")
    a = ap.parse_args()

    state = load()
    if a.status:
        print(json.dumps(state, indent=2) if state else "no state yet")
        return 0

    code, said = run_check(a.tag)
    now = int(time.time())
    first_run = not state

    if code is None or code == 2:
        # Could not ask. Not a pass, not a finding, and nothing is sent: a
        # watcher that alarms because GitHub was slow is a watcher that gets
        # muted, and a muted watcher is worse than none.
        print(f"the check could not run -- nothing was compared\n{said}")
        return 2

    if code == 0:
        if state.get("alarmed"):
            gone = int((now - state.get("since", now)) / 60)
            # The fingerprint, not the filename.
            #
            # This line said "the key in SECURITY.md", and Telegram turned  # wam:quote-line
            # SECURITY.md into a hyperlink -- .md is Moldova's top-level
            # domain -- so an alarm from this project pointed at a stranger's
            # server. scripts/test/test_alert_text.py refuses it now. The
            # fingerprint is also the more useful thing to be told: it is what
            # a reader compares, and a filename is only where to find it.
            msg = ("RECOVERED  the published release verifies again, after "
                   f"about {gone} minute(s). SHA256SUMS and its signature "
                   "agree, and the signature is "
                   "4BD4 A8D3 AFD4 3F5C BCB5  00E2 3798 462F E00A DBA4.")
            print(msg)
            notify(msg, a.dry_run)
        state.update(alarmed=False, since=now, last_ok=now)
        save(state)
        if first_run:
            msg = ("release watch started. It asks every ten minutes whether "
                   "the release a stranger can download actually verifies, and "
                   "will speak only when the answer changes.")
            print(msg)
            notify(msg, a.dry_run)
        else:
            print("the published release verifies")
        return 0

    # code == 1: it is published, and it does not verify.
    if not state.get("alarmed"):
        state.update(alarmed=True, since=now)
        msg = ("ALARM  the release on the GitHub releases page DOES NOT "
               "VERIFY.\n"
               f"{said}\n"
               "Anyone downloading it and following our own instructions is "
               "being told the signature is not valid and not to run the "
               "binaries.\n"
               "The usual cause is a half-finished upload: SHA256SUMS.asc "
               "replaced while SHA256SUMS was not, or an archive named in the "
               "list that was never attached. Check with:\n"
               "    bash scripts/check_release_signed.sh\n"
               "If it cannot be fixed within a few minutes, set the release "
               "back to Draft: a link that 404s is better than a page telling "
               "people our file is forged.")
        print(msg)
        notify(msg, a.dry_run)
    else:
        quiet = int((now - state.get("since", now)) / 60)
        print(f"still not verifying, for about {quiet} minute(s) "
              f"-- already alarmed, saying nothing again")
    save(state)
    return 1


if __name__ == "__main__":
    sys.exit(main())
