#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  wamnotify.py -- the one place that knows how to reach a person
# ===========================================================================
#
#  Import it:
#
#      from wamnotify import send
#      send("the pool stopped paying")
#
#  WHY IT IS ONE PLACE
#
#  Delivery has two rules that are easy to get wrong twice. First, a host
#  without a bot token must not be given one -- whoever took that machine
#  could otherwise post to the public announcement channel in the founder's
#  name -- so its alarms are parked in a file that the host holding the token
#  reads and forwards. Second, the parked file must be capped, because the
#  forwarding host dedupes by hash and cannot write an acknowledgement back
#  through a key that runs one read-only command.
#
#  Both rules were written into the login watcher first. The second thing
#  that needed to raise an alarm would have copied them, and a copy is where
#  the two versions start to differ.
# ===========================================================================

import json
import os
import re
import time
import urllib.parse
import urllib.request

CONF = "/etc/wam/announce.json"
PENDING = "/var/lib/wam-login-watch/pending.txt"
MAINT = "/var/lib/wam-login-watch/maintenance.json"

# Two hundred lines is far more than the few minutes between forwarding runs,
# and small enough that reading the file costs nothing.
KEEP = 200


# A parked line older than this is dropped, forwarded or not.
#
# The forwarding host dedupes by hash and cannot write an acknowledgement back
# through a read-only key, so a parked line is never removed when it is sent.
# By 4 September Singapore held twenty-one lines, all forwarded, all from the
# day's own testing -- and the ONLY thing preventing them being sent again was
# a state file on Germany. Lose that file, or rebuild that machine, and
# yesterday's alarms arrive as today's.
#
# An alarm nobody forwarded within a day is not going to be forwarded, and one
# that was forwarded has already done its work. Either way it should go.
STALE_HOURS = 24


def park(text):
    """No way to send from here. Leave it where the other machine looks."""
    stamp = int(time.time())
    try:
        os.makedirs(os.path.dirname(PENDING), exist_ok=True)
        # Each line carries the time it was parked, as a leading field the
        # forwarder strips. Without it there is no way to tell a line written
        # an hour ago from one written last week.
        with open(PENDING, "a") as f:
            f.write(f"[{stamp}] " + text.replace("\n", " ") + "\n")

        cutoff = stamp - STALE_HOURS * 3600
        kept = []
        for line in open(PENDING):
            m = re.match(r"\[(\d+)\] ", line)
            # A line with no timestamp is from before this change. Keep it
            # once more rather than dropping something that may not have been
            # forwarded, and it ages out on the next pass.
            if not m or int(m.group(1)) >= cutoff:
                kept.append(line)
        with open(PENDING, "w") as f:
            f.writelines(kept[-KEEP:])
    except OSError:
        pass
    print(text)


def maintenance():
    """The open maintenance window, if there is one and it has not expired.

    NOTHING IS EVER SILENCED BY IT. It only adds a label.

    The first design of this suppressed alarms during planned work, because
    rebooting both servers on 2 September raised two perfectly correct alarms
    that were both mine -- a check that could not reach a node I had stopped,
    and a machine whose ports "were closed before" because it had just come
    back.

    The founder rejected suppression, and his reason is the right one: a
    switch that silences the alarms is the first thing an intruder would want,
    and an intrusion that happens to land inside a window we opened ourselves
    would arrive as silence. The noise is the smaller problem. He knows when
    he is doing maintenance; he cannot know when somebody else is.

    So the window answers "was this expected?" and never "should this be
    sent?". Every alarm still leaves the machine. The label is there so a
    person can see at a glance which ones were us -- and, more usefully, which
    ones were not.

    It still carries an absolute expiry, so a forgotten window stops labelling
    on its own rather than mislabelling a real fault as routine next week.
    """
    try:
        with open(MAINT) as f:
            m = json.load(f)
    except (OSError, ValueError):
        return None
    if time.time() >= float(m.get("until", 0)):
        return None
    return m


def send(text, dry=False):
    """Deliver, or park it for the host that can. Always."""
    if dry:
        print(text)
        return

    m = maintenance()
    if m:
        left = int((float(m["until"]) - time.time()) / 60)
        text = (f"[planned work in progress: {m.get('reason', '?')} "
                f"— {left} min left. This alarm was still sent.]\n{text}")
    # A host with no announce.json is a host that was never given a token,
    # which is the design and not a fault. Parking it quietly is right; the
    # first version let the missing file fall through to the error path and
    # stamped every alarm Singapore raised with "FileNotFoundError", which
    # reads as a broken alerter rather than a working one.
    try:
        cfg = json.load(open(CONF))
        chat = cfg.get("opsChatId")
        token = cfg.get("telegram", {}).get("token")
    except (OSError, ValueError):
        park(text)
        return
    if not (chat and token):
        park(text)
        return
    try:
        data = urllib.parse.urlencode({
            "chat_id": chat, "text": text,
            "disable_web_page_preview": "true"}).encode()
        with urllib.request.urlopen(urllib.request.Request(
                f"https://api.telegram.org/bot{token}/sendMessage", data=data),
                timeout=25) as r:
            # A 200 with {"ok": false} is Telegram accepting the request and
            # refusing the message -- a wrong chat id reads exactly like a
            # delivered alarm if the body is not read.
            body = json.loads(r.read().decode())
        if not body.get("ok"):
            park(f"{text}  [telegram refused it: "
                 f"{str(body.get('description'))[:80]}]")
    except Exception as e:
        park(f"{text}  [could not send from that host: {type(e).__name__}]")


if __name__ == "__main__":
    # So a person can prove delivery whenever they want to, rather than
    # trusting that the last alarm would have arrived:
    #
    #     python3 scripts/wamnotify.py "test from Germany"
    import sys
    send(" ".join(sys.argv[1:]) or "wamnotify test")
    print("sent, or parked if this host holds no token")
