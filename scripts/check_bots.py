#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_bots.py -- is the announcement bot alive, or merely quiet?
# ===========================================================================
#
#      python3 scripts/check_bots.py --host HOST [--network testnet]
#
#  WHY THIS EXISTS
#
#  A bot that has died looks exactly like a chain with nothing to report.
#  Both produce silence, and silence is what everyone expects most of the
#  time: the announcer speaks at milestones, halvings, seed rotations,
#  releases and stalls, and between those it says nothing for days.
#
#  So the failure is invisible by construction. The stall alert -- the one
#  message that matters most, because it fires when the chain stops -- is
#  also the message most likely to be missing when it is needed, since a
#  host in trouble takes the bot down with it.
#
#  WHAT PROVES IT IS ALIVE
#
#  Not "the service is active": a process can be running and stuck. The bot
#  writes its state file every poll, so the age of that file is proof it
#  completed a full cycle -- read the node, decide, write. If that timestamp
#  is stale the bot is not working, whatever systemd says.
#
#  WHAT PROVES IT CAN SPEAK
#
#  A configured token is not a working one. Telegram's getMe validates the
#  token and getChat proves the channel is still reachable; a Discord
#  webhook answers GET with its own metadata. All three are read-only --
#  nothing is posted to anyone's channel by this check.
#
#  Those calls run ON the host, and only their verdict comes back. The
#  token, the chat id and the webhook URL never leave the machine and never
#  appear in this output.
# ===========================================================================

import os
import argparse
import json
import subprocess
import sys
import time
import urllib.request

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"
_fails = []
UNREACHED = []


def ok(m):   print(f"  {GRN}ok{OFF}    {m}")
def bad(m):  print(f"  {RED}FAIL{OFF}  {m}"); _fails.append(m)
def warn(m): print(f"  {YEL}!!{OFF}    {m}")
def head(m): print(f"\n{BLD}{m}{OFF}")


def rsh(host, cmd, timeout=90):
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                        f"root@{host}", cmd],
                       capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


# Addressing a chain with wam-cli lives in one place. Each of these files had
# its own copy, and every copy mapped mainnet to an EMPTY flag -- which means
# the default datadir, which on both servers is the TESTNET node. Asked to
# check mainnet, they all quietly checked testnet.
#
# This import belongs HERE, at module level, and in this one file it was
# inserted five lines lower -- inside REMOTE_SINKS, a raw string shipped to
# the server. So it was never executed locally, and main() died with
#
#     NameError: name '_wamcli_flags' is not defined
#
# every single time, since the refactor that added it. The sweep reported "the
# announcer is alive and can be heard: FAIL" -- about an announcer that was
# fine. It also broke the remote snippet, which imports json and urllib and
# has no sys or os to call.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wamcli import flags as _wamcli_flags   # noqa: E402


# Runs on the host. Prints verdicts only -- never a token, a chat id or a URL.
REMOTE_SINKS = r'''
python3 - <<'PY'
import json, urllib.request, urllib.error

# Discord answers 403 to a request with no User-Agent, and urllib sends
# "Python-urllib/3.x" by default. The first version of this check reported the
# webhook as deleted or revoked when it was working perfectly -- a false alarm
# is worse than no check, because a check that cries wolf gets ignored on the
# day it is right.
UA = {"User-Agent": "WAMCoin-check (+https://wamcoin.org)"}


def fetch(url):
    return json.load(urllib.request.urlopen(
        urllib.request.Request(url, headers=UA), timeout=20))


try:
    cfg = json.load(open("/etc/wam/announce.json"))
except Exception as e:
    print("CONFIG_UNREADABLE %s" % e); raise SystemExit

tg = cfg.get("telegram") or {}
if tg.get("token") and tg.get("chatId"):
    base = "https://api.telegram.org/bot%s" % tg["token"]
    try:
        r = fetch(base + "/getMe")
        name = (r.get("result") or {}).get("username", "?")
        print("TELEGRAM_TOKEN ok @%s" % name)
    except urllib.error.HTTPError as e:
        print("TELEGRAM_TOKEN fail HTTP %s" % e.code); raise SystemExit(0)
    except Exception as e:
        # A timeout is not a finding about the token.
        print("TELEGRAM_TOKEN unreachable %s" % type(e).__name__); raise SystemExit(0)
    try:
        r = fetch(base + "/getChat?chat_id=%s" % tg["chatId"])
        c = r.get("result") or {}
        print("TELEGRAM_CHAT ok %s (%s)" % (c.get("title") or c.get("username") or "?", c.get("type")))
    except urllib.error.HTTPError as e:
        print("TELEGRAM_CHAT fail HTTP %s -- the bot cannot see that channel" % e.code)
    except Exception as e:
        print("TELEGRAM_CHAT unreachable %s" % type(e).__name__)
else:
    print("TELEGRAM_TOKEN absent")

dc = cfg.get("discord") or {}
if dc.get("webhookUrl"):
    try:
        r = fetch(dc["webhookUrl"])
        print("DISCORD ok channel=%s" % (r.get("channel_id") or "?"))
    except urllib.error.HTTPError as e:
        print("DISCORD fail HTTP %s -- the webhook was deleted or revoked" % e.code)
    except Exception as e:
        print("DISCORD unreachable %s" % type(e).__name__)
else:
    print("DISCORD absent")
PY
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="pool.wamcoin.org")
    # mainnet by default. Until 18 September every check here defaulted to
    # testnet, written when testnet was the only chain and never revisited;
    # run by hand without the flag, three days into mainnet, they answered
    # confidently about a chain with nothing on it.
    ap.add_argument("--network", default="mainnet",
                    choices=["mainnet", "testnet", "regtest"])
    ap.add_argument("--repo", default="wamcoin-Project/wam-coin")
    # Not a tuning knob. It is what makes the silence check testable without
    # waiting a day for a bot to go quiet, and a check nobody has watched fail
    # is a check nobody knows works. Default: the heartbeat interval plus two
    # hours, read from the bot's own config.
    ap.add_argument("--max-quiet-hours", type=float, default=None,
                    help="fail if nothing has been sent for longer than this "
                         "(default: the bot's heartbeatHours plus 2)")
    args = ap.parse_args()

    flag = _wamcli_flags(args.network)
    # --- the unit ---------------------------------------------------------
    head("the announcer is running")
    rc, active, err = rsh(args.host, "systemctl is-active wam-announce")
    # ssh answers 255 when the connection itself failed, and systemctl answers
    # 3 for "inactive" -- so a non-zero rc alone says nothing. Only the first
    # is a question that was never put, and it used to come out of here as
    # "wam-announce is unreachable | FAIL", followed by two more failures about
    # a host that had not been reached at all. Three red lines, nothing
    # measured. Exit 2 is this project's word for that.
    if rc == 255 or (not active and err):
        print(f"  {YEL}??{OFF}    could not reach {args.host} "
              f"({err.splitlines()[0] if err else 'ssh failed'}). Nothing "
              f"about the announcer was established, either way.")
        UNREACHED.append(args.host)
        print()
        return 2
    rc2, enabled, _ = rsh(args.host, "systemctl is-enabled wam-announce")
    if active != "active":
        bad(f"wam-announce is {active or 'unreachable'}")
    else:
        ok(f"wam-announce {active}, {enabled}")
    if enabled != "enabled":
        bad("wam-announce is not enabled -- it will not come back after a reboot")

    # --- the state file, which is the only real proof of a completed cycle -
    head("it completed a poll recently, not merely started")
    rc, raw, _ = rsh(args.host, "cat /var/lib/wam-announce/state.json 2>/dev/null")
    if rc != 0 or not raw:
        bad("no state file -- the bot has never completed a cycle on this host")
        print(); return 1
    try:
        st = json.loads(raw)
    except Exception as e:
        bad(f"the state file is not valid JSON: {e}")
        print(); return 1

    rc, cfgraw, _ = rsh(args.host,
                        "python3 -c \"import json;c=json.load(open('/etc/wam/announce.json'));"
                        "print(c.get('pollSeconds',60),c.get('heartbeatHours',24),c.get('stallMinutes',60))\"")
    poll, hb_hours, stall_min = (60, 24, 60)
    if rc == 0 and cfgraw:
        try:
            poll, hb_hours, stall_min = (int(float(x)) for x in cfgraw.split())
        except Exception:
            pass

    # AND WHICH REPOSITORY IT IS WATCHING, WHICH NOTHING CHECKED.
    #
    # v0.1.13 was published on 2026-10-31 and no announcement went out. The
    # bot had been saying "nothing to announce" every minute for two days:
    # its config named wamcoin-core-dev/wam-coin, the account suspended on
    # 29 October, and a 404 has no releases in it. The repository moved and
    # the code moved with it -- but /etc/wam/announce.json is written once by
    # bots/setup.sh and never again, so the hosts kept the dead name. One of
    # them was still on wam-coin-official, lost five weeks earlier.
    #
    # A STOPPED announcer is caught above, by the state file's age. This one
    # was not stopped. It polled, answered, saved its state and said nothing,
    # which is the failure that looks exactly like a quiet month.
    #
    # Compared against CHANNELS.txt because that file is signed, and saying
    # which GitHub account is ours is the one thing it exists to do.
    canon = os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "CHANNELS.txt")
    want = ""
    try:
        for line in open(canon, encoding="utf-8", errors="replace"):
            s = line.strip()
            if s.startswith("source") and "github.com/" in s:
                want = s.split("github.com/", 1)[1].strip().rstrip("/")
                break
    except OSError:
        pass

    rc, repo, _ = rsh(args.host,
                      "python3 -c \"import json;print(json.load("
                      "open('/etc/wam/announce.json')).get('githubRepo') or '')\"")
    repo = (repo or "").strip()
    if not want:
        warn("CHANNELS.txt names no GitHub source, so the announcer's "
             "repository cannot be compared against anything")
    elif not repo:
        bad("the announcer has no githubRepo configured. It sees no release "
            "and reports nothing to announce, which is not an error anywhere")
    elif repo != want:
        bad(f"the announcer watches {repo} and CHANNELS.txt names {want}. A "
            f"release published to the second is invisible to the first, and "
            f"the bot says 'nothing to announce' rather than failing")
    else:
        ok(f"the announcer watches {repo}, the repository CHANNELS.txt names")

    # Liveness comes from the file's mtime, not from lastHeightAt inside it.
    #
    # lastHeightAt records when the HEIGHT last changed -- once a block, so
    # every ~120s on this chain -- while the file itself is rewritten on every
    # poll. Reading the field measures the chain's pulse and calls it the
    # bot's. On a quiet stretch of two slow blocks that reports a healthy
    # announcer as dead, and a check that cries wolf is one people stop
    # reading.
    rc, mt, _ = rsh(args.host,
                    "stat -c %Y /var/lib/wam-announce/state.json 2>/dev/null")
    if rc != 0 or not mt.strip().isdigit():
        bad("cannot read the state file's timestamp -- cannot tell a live bot "
            "from a dead one")
    else:
        age = time.time() - int(mt.strip())
        if age > poll * 3:
            bad(f"the state file was last written {age/60:.0f} minutes ago, and the "
                f"bot polls every {poll}s. It is not running its loop -- and a "
                f"stopped announcer looks exactly like a quiet chain.")
        else:
            ok(f"wrote its state {age:.0f}s ago (polls every {poll}s)")

    if st.get("lastHeightAt"):
        hage = time.time() - st["lastHeightAt"] / 1000.0
        print(f"        the height it saw last changed {hage/60:.1f} min ago "
              f"(that is the chain's pulse, not the bot's)")

    # --- does it see the same chain ---------------------------------------
    head("it sees the chain the node sees")
    rc, h, _ = rsh(args.host, f"wam-cli {flag} getblockcount")
    if rc == 0 and h.isdigit():
        lag = int(h) - (st.get("lastHeight") or 0)
        if abs(lag) > 5:
            bad(f"the bot last saw height {st.get('lastHeight')}, the node is at {h} "
                f"({lag} behind) -- it is not reading the node")
        else:
            ok(f"bot at {st.get('lastHeight')}, node at {h}")
    else:
        warn("could not read the node's height")

    if st.get("stallAnnounced"):
        warn(f"a stall has been announced and not cleared (stall threshold "
             f"{stall_min} min) -- check whether the chain is actually moving")

    # --- would anyone hear it ---------------------------------------------
    head("it can still reach its channels")
    rc, out, err = rsh(args.host, REMOTE_SINKS, timeout=150)
    if rc != 0 and not out:
        bad(f"could not test the channels: {err[:100]}")
    for line in out.splitlines():
        if line.startswith("CONFIG_UNREADABLE"):
            bad("the bot config could not be read")
        elif line.endswith("absent") or " absent" in line:
            warn(f"{line.split()[0].lower()} is not configured -- nothing is sent there")
        elif " ok" in line:
            ok(line.replace("_", " ").lower())
        elif " unreachable" in line:
            # A network timeout reaching Telegram or Discord says nothing about
            # whether the bot works. On 6 September one timed-out request from
            # the founder's laptop -- on a connection in Libya, about a bot
            # running healthily in France -- printed "announcements to this
            # channel are silently going nowhere". The announcer was cycling
            # every minute at the time, and api.telegram.org answered from that
            # server in 0.22 seconds on three tries out of three.
            #
            # This project's convention is that exit 2 means the check could not
            # run. sweep.sh already carries the same lesson in its own comment,
            # about an ssh call that took longer than a minute being reported as
            # "everyone can follow mainnet: FAILING".
            warn(f"{line.replace('_', ' ').lower()} -- could not reach it from "
                 f"here, which is not the same as it being broken")
            UNREACHED.append(line.split()[0].lower())
        elif " fail" in line:
            bad(f"{line.replace('_', ' ').lower()} -- announcements to this channel "
                f"are silently going nowhere")

    # --- did it miss the release ------------------------------------------
    head("it announced the current release")
    try:
        # NOT /releases/latest. That endpoint excludes pre-releases, and the
        # release workflow marks every v0.* as one deliberately, so it answers
        # 404 for this repository and always will until 1.0. Asking it was a
        # check that could never pass.
        req = urllib.request.Request(
            f"https://api.github.com/repos/{args.repo}/releases?per_page=5",
            headers={"User-Agent": "wam-check-bots"})
        rels = json.load(urllib.request.urlopen(req, timeout=25))
        latest = rels[0].get("tag_name") if rels else None
    except Exception:
        latest = None
        warn("could not read the latest release from GitHub")

    seen = st.get("lastReleaseTag")
    if latest:
        if seen != latest:
            bad(f"the newest release is {latest} and the bot last announced "
                f"{seen or 'nothing'} -- a published release nobody was told about")
        else:
            ok(f"announced {seen}")

    # ---------------------------------------------------------------------
    head("it has actually sent something recently")
    #
    # Every check above asks whether the bot COULD speak: the service is up,
    # the state file moves, the token is valid, the channel exists, the
    # webhook answers. None of them asks whether it HAS spoken.
    #
    # A bot that runs, polls and never posts -- a fault in the deciding
    # rather than in the plumbing -- passes all of them. The founder found
    # exactly that gap by looking at his phone and asking why it had been
    # quiet, and the honest answer was that nothing here would have told him.
    #
    # The journal line is the only proof of delivery there is: announce.js
    # logs "sent to <sink>" after the await returns, so it cannot be written
    # by a send that failed. The state file is not proof -- it is saved after
    # the send loop whether the sinks threw or not.
    #
    # The threshold is the heartbeat's own promise: it posts every
    # heartbeatHours whatever else happens, so silence longer than that plus
    # a margin is a fault and not a quiet week.
    rc, hb, _ = rsh(args.host,
                    "python3 -c \"import json;print(json.load("
                    "open('/etc/wam/announce.json')).get('heartbeatHours',24))\"")
    try:
        heartbeat_h = float((hb or "").strip())
    except ValueError:
        heartbeat_h = 24.0

    rc, last_sent, _ = rsh(
        args.host,
        "journalctl -u wam-announce --since '5 days ago' --no-pager -o short-unix "
        "2>/dev/null | grep -i 'sent to ' | tail -1 | cut -d. -f1")
    last_sent = (last_sent or "").strip()

    if rc != 0 or not last_sent.isdigit():
        warn("could not read the journal to see when it last sent -- this "
             "check could not answer, which is not the same as a pass")
    else:
        quiet_h = (time.time() - int(last_sent)) / 3600.0
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(int(last_sent)))
        limit = args.max_quiet_hours if args.max_quiet_hours is not None \
            else heartbeat_h + 2
        if quiet_h <= limit:
            ok(f"last message {quiet_h:.1f} h ago, at {when} "
               f"(the heartbeat alone posts every {heartbeat_h:.0f} h)")
        else:
            bad(f"nothing sent for {quiet_h:.1f} h -- the last was at {when}. "
                f"The heartbeat should post every {heartbeat_h:.0f} h on its own, "
                f"so this is a bot that is running and silent, which is the one "
                f"state every other check here reads as healthy.")

    print()
    if _fails:
        print(f"  {RED}{len(_fails)} check(s) failed{OFF}")
        print("  The stall alert is the message that matters most and the one most\n"
              "  likely to be missing when it is needed.\n")
        return 1
    if UNREACHED:
        # Exit 2, this project's word for "the check could not run". A
        # timeout reported as a failure says something was measured and
        # found wrong, and what was measured was this machine's connection.
        print(f"  {YEL}could not reach {', '.join(UNREACHED)} from here{OFF}")
        print("  Nothing about the bot was established either way.")
        return 2
    print(f"  {GRN}the announcer is alive and can be heard{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
