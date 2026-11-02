#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  ops.py -- the operator's dashboard, on the operator's own machine
# ===========================================================================
#
#      python3 ops/ops.py
#      then open http://127.0.0.1:8787
#
#  WHY IT RUNS HERE AND NOT ON A SERVER
#
#  A monitoring page shows which service is down, which machine is short of
#  memory, what hour the backup runs and which node is behind. That is what
#  makes it useful, and it is also a map for anyone who wants to attack the
#  network: it names the weak machine and the unwatched hour.
#
#  Served from a server it needs a public address, a password, TLS, and it
#  becomes one more door into a machine that holds money. Run here it needs
#  none of those, because it is not on the internet at all. It binds to
#  127.0.0.1, which no other machine can reach -- not the café wifi, not the
#  router, not anyone.
#
#  WHAT IT MUST NEVER DO, AND DOES NOT
#
#  It runs read-only commands over the ssh key already on this machine. It
#  writes nothing to any server, stores no credential, and opens no port
#  beyond the loopback.
#
#  THE FOUR RULES AGAINST LYING
#
#  The founder put it plainly: "the report sometimes lies". A green panel
#  over a broken system is worse than no panel, because it buys calm that
#  was not earned. Three times in one day this project has had exactly that
#  -- a sweep reporting 21 passed while the backups had been dead for three
#  days; a version check going green because the outdated node happened to
#  be offline in that minute; two of my own measurements reporting the wrong
#  answer about something that was working.
#
#  So:
#
#    1. Every value carries the moment it was measured. Not "backups ok" but
#       "backups, 6h ago". A stale number shown as current is the ordinary
#       way a dashboard lies.
#    2. Unreachable is not healthy. When a host cannot be reached its panel
#       goes grey and says so, rather than holding the last good reading.
#    3. The page shows its own age. If the collector dies the page freezes,
#       and the age is what tells you rather than the stillness.
#    4. Nothing is inferred. What was not measured is not displayed.
#
#  It runs the same check scripts the sweep runs, rather than reimplementing
#  them, so that this page and the sweep cannot ever disagree about what is
#  true.
# ===========================================================================

import http.server
import json
import os
import re
import shutil
import shlex
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# 9787 rather than the obvious 8787: that one is already taken on the
# founder's laptop by another of his applications, and a dashboard that
# silently shows somebody else's page is worse than one that will not start.
PORT = int(os.environ.get("WAM_OPS_PORT", "9787"))
STATE = os.path.join(HERE, "state.json")

HOSTS = [
    ("France", "169.58.159.165"),
    ("Singapore", "5.223.52.200"),
    ("US-east", "13.140.33.187"),
]

# Services that are expected on a host. A host that has never run one is not
# failing by not running it -- the pool lives on one machine only -- so the
# collector reports what it finds rather than what it hoped to find.
SERVICES = [
    "wamd", "wam-electrumx@testnet", "wam-pool", "wam-dashboard",
    "wam-announce", "wam-miner",
    "wam-reorg-watch@testnet.timer", "wam-version-watch.timer",
    "wamd-mainnet", "wam-electrumx@mainnet",
]

# The backup timers are not in that list, because their names are not knowable
# from here.
#
# This list said "wam-backup.timer". On 7 September the backup became a
# template with one instance per network, that unit was disabled in favour of
# wam-backup@testnet.timer, and this panel went red on both hosts --
#
#     wam-backup.timer - inactive
#
# about a backup that had run successfully at 03:27 that morning.
#
# That was the THIRD copy of the same hardcoded name. check_backups.py had it,
# scripts/wam-facts.sh had it, and this file had it, and fixing the first two
# left the red on the only one the founder actually looks at. Three files
# answering "which units matter" independently is the fault; each of them
# discovering the answer is what stops it recurring.
#
# Writing the new name in would move the fault to 15 September, when
# wam-backup@mainnet.timer is enabled and this list would not know it exists.
# The template itself is excluded: wam-backup@.timer is not an instance and
# can never be active, so it would report as a permanent failure.
BACKUP_TIMER_DISCOVERY = (
    "systemctl list-units --type=timer --all --no-legend 'wam-backup*' 2>/dev/null"
    " | awk '{print $1}' | grep -v '^wam-backup@[.]timer$'"
)

_state = {"generated": 0, "hosts": {}, "checks": {}, "errors": []}
_lock = threading.Lock()


def rsh(host, cmd, timeout=45, tries=2):
    """One read-only command on a host. Returns (rc, stdout).

    The script goes in on STDIN, never as an argument.

    Passing it as the last argv element worked for as long as this ran under
    WSL. Moved to Windows Python it began timing out on both hosts at once:
    Windows has no argv, so subprocess rebuilds a single command line and
    escapes the double quotes inside the script. ssh delivered that to the
    remote shell, which saw an unbalanced quote and sat waiting for the rest
    of it until the 45-second limit expired -- and the panel then showed two
    healthy servers as unreachable.

    `bash -s` reads from stdin, so nothing quotes anything. This is the same
    fix, for the same reason, as the one made to check_reorg.py earlier the
    same day, where a script passed as an argument hit the kernel's 128 KiB
    limit. A script belongs on stdin.

    AND IT IS SENT AS BYTES, NOT AS TEXT.

    With text=True, Python opens that pipe in text mode, and on Windows text
    mode rewrites every \\n as \\r\\n. The remote bash then receives a shell
    script with Windows line endings and says:

        cut: '/proc/uptime'$'\\r': No such file or directory
        bash: syntax error near unexpected token $'do\\r'

    Half the sections came back empty and the rest of the script never ran.
    Encoding here and decoding the answer keeps the bytes the bytes, on any
    platform. Stripping the carriage returns afterwards would have been the
    patch; not letting the platform rewrite them is the fix.
    """
    # ONE MISSED TIMEOUT IS NOT A DEAD MACHINE.
    #
    # On 2026-09-24 the panel showed France "unreachable -- timed out after 60
    # seconds" while ssh from the same laptop answered in six, and the backup
    # check went red with it because it reaches all three hosts. The cause was
    # 70 MB being scp'd to that host at the same moment: its uplink and sshd
    # were busy, one connection went past the limit, and the panel called the
    # machine dead.
    #
    # A false "unreachable" is expensive in a way a slow one is not. It is the
    # loudest thing on the page, it drags other checks red with it, and after
    # it has been wrong twice the operator stops believing the colour. So a
    # timeout or a transport error is retried once, briefly, before any verdict
    # is reached. A host that is genuinely down fails both times and costs a
    # few seconds; a host that was merely busy is reported as what it is.
    #
    # Retried only for timeouts and transport failures -- never for a command
    # that ran and returned non-zero, which is an answer and must be reported.
    last = (255, "not attempted")
    for attempt in range(max(1, tries)):
        rc, out = _rsh_once(host, cmd, timeout)
        if rc != 255:
            return rc, out
        last = (rc, out)
        if attempt + 1 < max(1, tries):
            time.sleep(2)
    return last


def _rsh_once(host, cmd, timeout):
    try:
        p = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
             "-o", "StrictHostKeyChecking=accept-new", f"root@{host}",
             "bash -s"],
            input=cmd.encode("utf-8"), capture_output=True, timeout=timeout)
        out = p.stdout.decode("utf-8", "replace")
        # KEEP stderr WHEN THERE IS NOTHING ELSE TO SAY.
        #
        # This returned stdout alone, so a host that did not answer produced
        # an empty string and the card said "no answer" -- true, and useless.
        # ssh puts every reason it has on stderr: a refused key, a closed
        # port, a name that does not resolve, a host key that changed. On
        # 22 September all three cards read "no answer" for an hour while the
        # real cause was that the panel process had been running for four
        # days and could no longer spawn ssh at all. The machines were fine
        # and the panel could have said so in one line.
        #
        # stderr is used only when stdout is empty. A successful call must
        # not have ssh's warnings pasted into the facts it parses.
        if not out.strip():
            err = p.stderr.decode("utf-8", "replace").strip()
            if err:
                return p.returncode, err
        return p.returncode, out
    except Exception as e:
        return 255, f"{type(e).__name__}: {e}"


def collect_host(name, ip):
    """Everything about one machine, in one round trip.

    One ssh call rather than ten: ten calls take ten times as long and can
    disagree with each other, because the machine changes between them.
    """
    script = r"""
set -u
echo "###os"; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
echo "###uptime"; cut -d. -f1 /proc/uptime
echo "###load"; cut -d' ' -f1-3 /proc/loadavg
echo "###mem"; free -m | awk '/Mem:/{print $2, $7} /Swap:/{print $2, $3}'
echo "###disk"; df -BM --output=avail,size / | tail -1 | tr -d 'M'
echo "###git"; timeout 5 git -C /opt/wam rev-parse --short HEAD 2>/dev/null
# MAINNET. These three said -testnet, written in August when testnet was the
# only chain. Mainnet opened on 15 September and for three days this panel
# showed height 9964 -- the test chain -- while mainnet stood at 2551, with
# nothing on the page naming a network. The founder saw the number every day.
#
# Spelled out rather than left bare: the default datadir on these hosts is
# /root/.wam, whose wam.conf says testnet=1, so an empty flag is the test
# chain and not "the default one".
WAMMAIN="-chain=main -conf=/root/.wam-mainnet/wam.conf -datadir=/root/.wam-mainnet"
# EVERY REMOTE CALL IS ON A LEASH, AND THE REASON IS NOT THE NODE.
#
# wamd serves four RPC threads. Anything that occupies them -- a long
# getblock walk, a wallet rescan, an address scan over the whole chain --
# leaves `wam-cli getblockcount` waiting in line, and it will wait for
# minutes without complaining. The three calls below then never return, this
# whole script never reaches its ###end, and rsh's 60 second limit expires.
#
# The panel's verdict for that was "France -- unreachable", in red, at the
# top of the page, dragging the backup check red with it. On 2026-09-26 that
# is exactly what happened, twice: the node was healthy, ssh answered in 1.7
# seconds, every command in this script ran in under a fifth of a second when
# measured -- and a chain-wide address scan was running against that node at
# the same moment.
#
# A slow answer and a dead machine are not the same fact, and the panel
# already has a colour for "not measured". So each call gets five seconds and
# then gives up, leaving its field empty: the card stays alive and says the
# height is unknown, which is true, instead of declaring a running server
# dead, which is not.
#
# Five seconds is generous by two orders of magnitude for a local RPC call.
# A node that cannot answer getblockcount within it is itself worth seeing --
# as an unknown height on a live card, which is where the eye should go.
echo "###height"; timeout 5 /opt/wam-current-bin/wam-cli $WAMMAIN getblockcount 2>/dev/null
echo "###tip"; timeout 5 /opt/wam-current-bin/wam-cli $WAMMAIN getbestblockhash 2>/dev/null
echo "###peers"; timeout 5 /opt/wam-current-bin/wam-cli $WAMMAIN getconnectioncount 2>/dev/null
echo "###services"
for u in %s $(%s); do
  # is-active prints "inactive" AND exits non-zero, so the obvious
  # `$(... || echo unknown)` yields "inactive unknown" on one line and the
  # field split reads the wrong word. Capture first, then decide.
  a=$(systemctl is-active "$u" 2>/dev/null); [ -n "$a" ] || a=unknown
  e=$(systemctl is-enabled "$u" 2>/dev/null); [ -n "$e" ] || e=-
  printf '%%s %%s %%s\n' "$u" "$a" "$e"
done
echo "###backup"; ls -t /root/backups/*.gpg 2>/dev/null | head -1 | xargs -r stat -c %%Y
echo "###alarms"; ls /var/lib/wam-reorg/ALARM-* /var/lib/wam-solo-gate/ALARM-* /var/lib/wam-alarms/ALARM-* 2>/dev/null | wc -l
echo "###motd"; [ -f /etc/update-motd.d/98-wam-version ] && echo yes || echo no
# The state of the SERVICE, not of the timer above it. This panel read only
# is-active on the timer, and a timer stays active however often the service
# under it fails -- which is how wam-reorg-watch failed on both machines at
# 03:11 and 03:47 UTC on 1 September 2026 and this page stayed green for ten
# hours. The leading bullet comes and goes with the systemd version, so strip
# everything before the name instead of counting columns.
echo "###failed"; systemctl list-units --state=failed --plain --no-legend --no-pager 2>/dev/null \
  | sed 's/^[^A-Za-z0-9]*//' | awk '{print $1}' | head -20
# Planned work, declared with wam-maint. It silences nothing; the panel shows
# it so a red line during a reboot reads as expected rather than as a fault --
# and so that a red line with NO declared work reads as what it is.
# Every literal percent in here must be doubled -- including in comments.
# This whole string goes through Python's %% operator to substitute the
# service list, so a lone %%d is eaten there and never reaches the shell.
# Adding the block below without doubling them broke every host card with
# "not enough arguments for format string", and the panel then showed both
# machines as unreachable -- which reads exactly like two servers being down.
# The first attempt at this comment had single percents in it and re-broke
# the same thing while explaining it.
echo "###maint"; [ -f /var/lib/wam-login-watch/maintenance.json ] && \
  python3 -c "
import json,time
m=json.load(open('/var/lib/wam-login-watch/maintenance.json'))
left=int(float(m.get('until',0))-time.time())
print('%%d %%s'%%(left,m.get('reason','?')) if left>0 else '')" 2>/dev/null
echo "###end"
""" % (" ".join(SERVICES), BACKUP_TIMER_DISCOVERY)

    rc, out = rsh(ip, script, timeout=60)
    now = int(time.time())

    # "unreachable" means the machine did not answer. It does not mean the
    # script answered and something in it exited non-zero.
    #
    # This conflated the two, and so twice in one afternoon it painted two
    # perfectly healthy servers as unreachable -- once for a Python format
    # error in the script it sends, once for carriage returns in it. Both
    # times the machines were up, answering ssh in milliseconds, mining and
    # serving. A panel that says a live server is unreachable is worse than
    # one that says nothing: it sends a person to look for a fault that is
    # not there, and the next time it says it, they will not believe it.
    #
    # The marker is the evidence. If ###end came back, the machine answered
    # and ran the script to the end; whatever else went wrong belongs in the
    # fields, not in a verdict about the host being gone.
    if "###end" not in out:
        return {"name": name, "ip": ip, "reachable": False, "checked": now,
                "why": (out or "no answer").strip()[:200]}
    # It answered. Keep whatever fields came back, and note separately that
    # part of the collection failed -- shown as a warning on the card, not as
    # a dead host and not swallowed into a green one.
    collect_warning = None
    if rc != 0:
        collect_warning = f"the collector script exited {rc} on this host"

    parts = {}
    key = None
    for line in out.splitlines():
        if line.startswith("###"):
            key = line[3:]
            parts[key] = []
        elif key:
            parts[key].append(line)

    def one(k, cast=str, default=None):
        v = parts.get(k) or []
        v = [x for x in v if x.strip()]
        if not v:
            return default
        try:
            return cast(v[0].strip())
        except Exception:
            return default

    mem = (parts.get("mem") or ["", ""])
    mem_total = mem_avail = swap_total = swap_used = None
    if len(mem) >= 1 and mem[0].split():
        f = mem[0].split()
        mem_total, mem_avail = int(f[0]), int(f[1])
    if len(mem) >= 2 and mem[1].split():
        f = mem[1].split()
        swap_total, swap_used = int(f[0]), int(f[1])

    disk = (parts.get("disk") or [""])[0].split()
    services = {}
    for line in parts.get("services", []):
        f = line.split()
        if len(f) >= 3:
            services[f[0]] = {"active": f[1], "enabled": f[2]}

    return {
        "name": name, "ip": ip, "reachable": True, "checked": now,
        "os": one("os"),
        "uptimeSeconds": one("uptime", int),
        "load": (parts.get("load") or [""])[0].strip() or None,
        "memTotalMb": mem_total, "memAvailMb": mem_avail,
        "swapTotalMb": swap_total, "swapUsedMb": swap_used,
        "diskAvailMb": int(disk[0]) if len(disk) > 1 else None,
        "diskTotalMb": int(disk[1]) if len(disk) > 1 else None,
        "git": one("git"),
        "height": one("height", int),
        "tip": one("tip"),
        "peers": one("peers", int),
        "services": services,
        "newestBackup": one("backup", int),
        "reorgAlarms": one("alarms", int, 0),
        "versionNotice": one("motd") == "yes",
        "failedUnits": [x.strip() for x in parts.get("failed", []) if x.strip()],
        "maintenance": one("maint"),
        "collectWarning": collect_warning,
    }


WINDOWS = os.name == "nt"

# Where this repository lives as seen from inside WSL, for the checks that are
# shell scripts. Derived, not hardcoded: C:\wam-blockchain-core -> /mnt/c/...
def _wsl_path(p):
    d, rest = os.path.splitdrive(os.path.abspath(p))
    return "/mnt/" + d[0].lower() + rest.replace("\\", "/")


def git_bash():
    """Git for Windows' bash, or None.

    NOT `shutil.which("bash")`. On this machine that returns

        C:\\Users\\...\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe

    which is the WSL launcher wearing the name bash -- the same shape of trap
    as the Microsoft Store `python3` stub that lib/python.sh exists to avoid.
    Anything under WindowsApps is refused by path for that reason.
    """
    seen = []
    for p in (r"C:\Program Files\Git\bin\bash.exe",
              r"C:\Program Files\Git\usr\bin\bash.exe",
              r"C:\Program Files (x86)\Git\bin\bash.exe"):
        if os.path.isfile(p):
            return p
    found = shutil.which("bash")
    if found:
        seen.append(found)
        if "windowsapps" not in found.replace("/", "\\").lower():
            return found
    return None


def portable(argv):
    """The same check, runnable from a Windows process.

    The dashboard now serves the page from Windows rather than from inside
    WSL, because a page bound to 127.0.0.1 inside the WSL virtual machine is
    not reliably reachable from the Windows browser -- on 2 September 2026 it
    was not reachable at all, by localhost or by the VM's own address, and the
    one tool whose job is to say when something is wrong was itself
    unreachable with nothing to announce it.

    But half of these checks are shell scripts, so the HTTP server runs
    natively and the shell checks are handed to a bash. Python checks run
    under the Windows interpreter directly.

    AND IT MUST BE THE OPERATOR'S BASH, NOT WSL.

    This used to say "Windows has no bash" and hand every shell check to
    `wsl -e bash`. It does have one: Git for Windows installs bash, and that
    is the bash a person gets when they run these checks by hand.

    The two are different machines. WSL is a separate Linux with its own
    filesystem and its own HOME -- /home/grgo, not /c/Users/gargo -- and
    therefore its own ~/.ssh. On 18 September that cost two panel entries:

        nodes agree                    unknown   13.140.33.187 could not be read
        deployed code is origin/main   unknown   13.140.33.187 could not be read

    while the same two checks run by hand from the operator's shell said
    "all 3 nodes agree" and "every deployed checkout is origin/main". The
    reason was one line out of ssh -v: WSL holds
    wam.coin.official@proton.me, the laptop shell holds gargo@r4x0uf-TUF,
    France and Singapore authorise both, and US-east -- added on 16
    September -- authorises only the second. So the panel had been reporting
    a healthy host as unreadable, permanently, for a reason no amount of
    looking at the host would ever reveal.

    A panel that disagrees with a hand-run of the same script is worse than
    no panel: it teaches the reader that yellow means nothing. So the shell
    checks now run in the same shell, with the same keys and the same
    known_hosts, as a person typing the command. WSL stays as a fallback for
    a machine with no Git bash, and the page says which one was used.
    """
    if not WINDOWS:
        return argv, REPO
    if argv and argv[0] == "bash":
        gb = git_bash()
        if gb:
            return [gb] + list(argv[1:]), REPO
        inner = " ".join(shlex.quote(a) for a in argv[1:])
        return (["wsl", "-e", "bash", "-lc",
                 f"cd {shlex.quote(_wsl_path(REPO))} && bash {inner}"], None)
    return argv, REPO


def run_check(name, argv, timeout=240):
    """Run one of the repository's own check scripts and keep its verdict.

    The exit code is the verdict -- these scripts are written that way -- and
    the text is kept so the page can show why. Running them rather than
    reimplementing them is the point: this page and the sweep read the same
    instrument, so they cannot disagree about what is true.
    """
    started = int(time.time())
    argv, cwd = portable(argv)
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout)
        rc, out = p.returncode, (p.stdout + p.stderr)
    except subprocess.TimeoutExpired:
        return {"name": name, "status": "unknown", "ran": started,
                "detail": f"did not finish within {timeout}s -- "
                          f"that is not a pass"}
    except Exception as e:
        return {"name": name, "status": "unknown", "ran": started,
                "detail": f"could not run: {type(e).__name__}: {e}"}

    clean = re.sub(r"\x1b\[[0-9;]*m", "", out)
    lines = [l.rstrip() for l in clean.splitlines() if l.strip()]
    return {
        "name": name,
        # Exit 2 is this project's convention for "the check could not run" --
        # a host that did not answer, an ssh that timed out. It is not a
        # finding, and showing it as one is how "everyone can follow mainnet:
        # FAILING" came to mean that an ssh call took longer than a minute.
        # A check that says somebody will be rejected at launch, when it never
        # managed to look, is worse than no check.
        "status": "ok" if rc == 0 else ("unknown" if rc == 2 else "bad"),
        "exit": rc,
        "ran": started,
        "detail": "\n".join(lines[-14:]),
    }


FAST_EVERY = 60

# Ten minutes rather than fifteen. The heavy checks each open their own ssh
# connections and cannot run every minute, but at fifteen a verdict could
# sit twelve minutes behind the facts printed directly above it -- the cards
# saying both machines run the same commit while the check below still read
# FAILING. The age beside each verdict makes that legible rather than
# misleading, which is the point of showing it, but a shorter cycle means
# the two agree sooner and the reader has less to reconcile.
SLOW_EVERY = 600

# The host list above is the one list of machines. Until 13 September these
# checks carried their own, written when there were two seeds, and the third
# joined on the 11th -- so "nodes agree" compared two of three nodes and
# called it agreement, and "deployed code is origin/main" could not see a
# divergence on US-east at all. The panel showed the third host's checkout in
# its card and no check ever read it.
#
# Derived from HOSTS now, so a fourth machine is one line in one place.
ALL_IPS = [ip for _, ip in HOSTS]

CHECKS = [
    ("backups", [sys.executable, "scripts/check_backups.py"] + ALL_IPS, 150),
    # mainnet on both, and the second one had been lying in its own label.
    # "everyone can follow mainnet" asked the TESTNET node -- so the check
    # whose whole purpose is to know whether independent operators will be
    # rejected on mainnet was counting testnet peers, under a name that said
    # otherwise. And the reorg watch guarded the chain with nothing on it
    # while the chain with coins on it went unwatched.
    ("no block was un-confirmed", [sys.executable, "scripts/check_reorg.py",
                                   "--network", "mainnet", "--state-dir",
                                   os.path.expanduser("~/.wam-reorg-mainnet")]
                                  + ALL_IPS, 180),
    ("everyone can follow mainnet", [sys.executable,
                                     "scripts/check_peer_versions.py",
                                     "--node", "169.58.159.165",
                                     "--network", "mainnet"], 200),
    # Added 2026-09-15, an hour into mainnet, because nothing on this panel
    # asked who was writing the chain -- and one party had just written 80 of
    # the first 82 blocks. 54 launch checks, and not one of them looked.
    ("no one party writes the chain", [sys.executable,
                                       "scripts/check_concentration.py",
                                       "--node", "169.58.159.165",
                                       "--network", "mainnet"], 600),
    ("nodes agree", ["bash", "scripts/check_nodes_agree.sh"] + ALL_IPS, 150),
    # Added 2026-11-01, the day "nodes agree" went red and said less than it
    # looked like it was saying. It compares the hosts to each other, so a
    # fleet that is uniformly behind reads as perfect agreement -- and on that
    # day it was: wam-tx, wam-util and wam-wallet were v0.1.7 on all three
    # machines, six releases back since 11 September, byte-identical and
    # therefore silent. This one asks a question from outside the fleet.
    ("machines run the version we publish",
     [sys.executable, "scripts/check_running_version.py"] + ALL_IPS, 300),
    # 300, not 150. Measured at 55 seconds for three hosts on a quiet link,
    # and it reads a git log from each of them over ssh -- so it is one slow
    # host away from the old limit. On 2026-09-27 it hit it, and the panel
    # said "unknown: did not finish within 150s" while the answer it could
    # not finish printing was three servers fourteen commits behind. A check
    # that times out reports nothing, and reporting nothing is the one thing
    # this panel exists to prevent.
    # Until 2026-11-02 this panel had no Electrum row at all, though sweep.sh
    # has had one since the 39-hour outage in August. A light wallet does not
    # read the chain -- it asks one of these servers and believes the answer --
    # so when they are down it shows nothing, and when they are behind it shows
    # a wrong balance, which is worse. The panel is what gets looked at between
    # sweeps, and this was the service it never looked at.
    ("electrum servers answer and agree",
     [sys.executable, "scripts/check_electrum.py",
      "--node", "169.58.159.165", "--network", "mainnet",
      "electrum.wamcoin.org", "electrum2.wamcoin.org"], 200),
    # Its own row, because this one is not ours: cup runs it in Seoul, on a
    # machine we hold no ssh on and should not. A reboot of his must not redden
    # the row that judges ours -- a red line nobody can act on is how people
    # learn to ignore red lines. It still has to be able to fail: electrums/WAM
    # advertises this endpoint, so a wallet told a wrong balance by it was sent
    # there by us. The action on this line is to tell the operator, or to take
    # the endpoint out of the entry.
    ("a server we do not own agrees",
     [sys.executable, "scripts/check_electrum.py",
      "--node", "169.58.159.165", "--network", "mainnet",
      "wam.zcd.lol"], 150),
    ("deployed code is origin/main",
     ["bash", "scripts/check_deployed_code.sh"] + ALL_IPS, 300),
    ("the same keys get a shell everywhere",
     ["bash", "scripts/check_admin_keys.sh"] + ALL_IPS, 150),
    ("the repository agrees with itself", ["bash", "scripts/audit_repo.sh"], 200),
    ("listing entries match source", [sys.executable,
                                      "scripts/check_listing_entry.py"], 120),
]


def collector():
    last_slow = 0
    while True:
        start = time.time()
        hosts = {}
        for name, ip in HOSTS:
            try:
                hosts[ip] = collect_host(name, ip)
            except Exception as e:
                hosts[ip] = {"name": name, "ip": ip, "reachable": False,
                             "checked": int(time.time()),
                             "why": f"{type(e).__name__}: {e}"}

        with _lock:
            _state["hosts"] = hosts
            _state["generated"] = int(time.time())

        if time.time() - last_slow > SLOW_EVERY:
            last_slow = time.time()
            for name, argv, timeout in CHECKS:
                r = run_check(name, argv, timeout)
                with _lock:
                    _state["checks"][name] = r
            with _lock:
                _state["generated"] = int(time.time())

        try:
            with _lock:
                tmp = STATE + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(_state, f)
                os.replace(tmp, STATE)
        except OSError:
            pass

        time.sleep(max(5, FAST_EVERY - (time.time() - start)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def do_GET(self):
        if self.path.startswith("/state.json"):
            with _lock:
                body = json.dumps(_state).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()

    def log_message(self, *a):
        pass


def already_serving():
    """Is a copy of this panel already answering on the port?

    The scheduled task that owns this dashboard fires at logon and then every
    ten minutes, as a keep-alive: if the panel has died, the next trigger
    brings it back. But when it is alive and something else holds the port,
    every one of those triggers used to end like this --

        OSError: [WinError 10048] Only one usage of each socket address
            (protocol/network address/port) is normally permitted

    -- a console window flashing a Python traceback at the operator every ten
    minutes for a day. That happened on 7 September because I restarted the
    panel by hand instead of through its task, so my process held the port and
    the task's own copy could never bind.

    A traceback is the wrong answer to "something else is already doing this".
    It reads like a fault in the panel, and the fault is that there is nothing
    to do.

    THE GUARD IS NOT THE WHOLE FIX, AND IT RECURRED ON 18 SEPTEMBER.

    The message above is now polite and the exit code is 0, so nothing
    crashes. But the task is set to IgnoreNew: while it owns the port its own
    ten-minute trigger does nothing at all and no window ever appears. The
    moment somebody hand-starts this panel instead, the task has no instance
    of itself to ignore -- so every trigger launches a fresh py.exe, which
    finds the port taken, prints the polite line and exits, opening a console
    window in the operator's face every ten minutes. The task's Hidden flag
    does not suppress that window; it only hides the task in the UI.

    So the remedy belongs here next to the diagnosis, because a comment that
    describes a failure without naming the correct action is how the same
    person makes the same mistake twice:

        DO NOT start this by hand. To restart the panel on Windows:

            Get-NetTCPConnection -LocalPort 9787 -State Listen |
                ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
            Start-ScheduledTask -TaskName "WAM ops dashboard"

    The task must end up owning the port. Anything else leaves a window
    flashing every ten minutes until somebody notices.
    """
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/state.json", timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    threading.Thread(target=collector, daemon=True).start()
    # 127.0.0.1 and nothing else. Binding to 0.0.0.0 here would put the map
    # of this network's weak points on whatever wifi this laptop is using.
    try:
        srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        # errno 98 on Linux, 10048 on Windows -- both mean "taken".
        if getattr(e, "winerror", None) == 10048 or e.errno in (48, 98, 10048):
            if already_serving():
                print(f"  the dashboard is already running on "
                      f"http://127.0.0.1:{PORT} -- nothing to do.")
                return 0
            print(f"  port {PORT} is held by something that is not this "
                  f"dashboard.\n  Find it with:  Get-NetTCPConnection "
                  f"-LocalPort {PORT} -State Listen")
            return 2
        raise
    with srv:
        srv.allow_reuse_address = True
        print(f"  WAM ops dashboard  ->  http://127.0.0.1:{PORT}")
        print(f"  reachable from this machine only. Ctrl-C to stop.\n")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.")


if __name__ == "__main__":
    # main() returns a code now: 0 when another copy is already
    # serving, 2 when the port is held by something else.
    sys.exit(main() or 0)
