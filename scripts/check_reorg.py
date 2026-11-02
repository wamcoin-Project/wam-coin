#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_reorg.py -- did a block that was confirmed stop being confirmed?
# ===========================================================================
#
#      python3 scripts/check_reorg.py --network testnet HOST [HOST ...]
#      python3 scripts/check_reorg.py --local --network mainnet
#      python3 scripts/check_reorg.py --local --depth 3 --announce
#
#  WHY THIS EXISTS
#
#  A new proof-of-work chain is cheap to reorganise, and WAM is a RandomX
#  chain, which means the hardware that attacks it is CPU -- the most
#  rentable resource there is. Monero is safe because its hashrate is
#  enormous. A chain in its first weeks is not Monero.
#
#  What that attack actually does is narrow, and worth stating precisely
#  because the fear is usually aimed at the wrong thing: it does not touch
#  anybody's wallet and it cannot move coins the attacker does not own. It
#  lets the attacker spend their own coins twice -- deposit somewhere, take
#  the value out, then publish a longer chain in which the deposit never
#  happened. The victim is whoever accepted the payment on few
#  confirmations. Almost always an exchange.
#
#  There is no way to make that impossible for a young chain. There is a way
#  to not be the last to know. A reorganisation is visible from any node the
#  moment it lands, and the difference between hearing about it in four
#  minutes and hearing about it in four days is the difference between one
#  exchange losing one deposit and every exchange delisting.
#
#  So this asks two questions, and they catch different things:
#
#    1. Is there a competing branch, and how deep?  getchaintips shows
#       branches the node knows about but has not switched to. An attacker
#       who mined in private and then published shows up here at full depth
#       BEFORE the node reorganises onto it, if we are quick. This is the
#       early warning.
#
#    2. Has a hash we recorded at a given height changed?  This is the
#       proof. A branch can be pruned and forgotten; a block that used to be
#       at height 3,600 and is not there any more cannot be explained away.
#       Nothing else in our checks would notice it.
#
#  CALIBRATION, MEASURED RATHER THAN GUESSED
#
#  On 2026-08-29, with 3,608 blocks of testnet behind us, the deepest side
#  branch the node had ever held was ONE block, and there were three of
#  them, all valid-headers -- headers received for blocks we never fetched.
#  That is ordinary and happens on every chain.
#
#  So depth 1 is noise. The default alarm is 2, which on this chain's own
#  history has never happened. An alarm that fires weekly is an alarm nobody
#  reads, and an alarm that has never fired is one people believe.
# ===========================================================================

import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wamssh import run as _ssh, UNREACHABLE        # noqa: E402

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

_fails = []
_warns = []

# Things this run could not measure. They are NOT findings, and keeping them
# apart matters twice over in this particular check:
#
#   1. On the ops panel a finding here reads "no block was un-confirmed:
#      FAILING", which says the chain rewrote itself. A node that was merely
#      restarting said exactly that, in exactly that red, until 2026-09-14.
#   2. With --announce, a finding is PUBLISHED to the channels as "Chain
#      reorganisation detected on WAM ... Exchanges and pools: raise your
#      confirmation requirement until this is explained." An unreachable node
#      must never be able to send that message to anybody. Only _fails can
#      announce, and after this change nothing unanswered reaches _fails.
_unknown = []


def ok(m):   print(f"  {GRN}ok{OFF}    {m}")
def bad(m):  print(f"  {RED}FAIL{OFF}  {m}"); _fails.append(m)
def warn(m): print(f"  {YEL}!!{OFF}    {m}"); _warns.append(m)


def unmeasured(m):
    """Said out loud, counted apart, never announced."""
    print(f"  {YEL}??{OFF}    {m}")
    _unknown.append(m)


# Heights are remembered sparsely rather than every one of them. A reorg
# deep enough to matter crosses several of these no matter where it starts,
# and twenty numbers is one round trip instead of five hundred.
OFFSETS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000]

# Anything older than this is dropped. A reorg five thousand blocks deep is
# not something a watcher tells you about; it is something you read in the
# news.
FORGET_AFTER = 5000

# How many of the older recorded heights are re-read on an ordinary run.
#
# It used to re-read all of them, every two minutes. By September that was
# 1560 heights -- 1560 processes spawned every two minutes on a 2 GB server,
# to re-confirm blocks a thousand deep that cannot change without the ones
# above them changing first. The cost grew with the chain until it broke.
#
# Sixty per run, rotating, means every recorded height is re-read inside an
# hour and the work stops growing. The heights near the tip, where a reorg
# actually happens, are still read on every single run.
AUDIT_PER_RUN = 60


def run(host, cmd, timeout=60):
    """Run a shell command locally or on a host, and return its stdout.

    The script goes in on stdin, never as an argument. `bash -lc "<script>"`
    puts the whole thing in one element of argv, and the kernel refuses any
    single argument over 128 KiB with E2BIG -- "Argument list too long".

    That is not a theoretical limit here. This check re-read every height it
    had ever recorded, so the command grew with the chain, and on 1 September
    2026 at 03:11 UTC it crossed the line. From then on the deeper of the two
    questions -- did a block that was confirmed stop being confirmed -- was
    not asked at all, on either machine, and the failure was visible only as
    a red service nothing was reading. Feeding stdin removes the ceiling for
    good; bounding the work (see heights_to_check) removes the growth that
    walked into it.

    THE REMOTE HALF IS wamssh NOW, not a private copy.

    This one never crashed the way check_peer_versions.py and
    check_concentration.py did -- every caller wraps it in `except Exception`
    and reports an unmeasured host rather than a finding, which is
    load-bearing here: a finding in this check publishes "Chain
    reorganisation detected" to the channels. But it still had its own ssh,
    so it got no retry and no way to tell ssh's own 255 from a status the
    node returned. A host that dropped one connection on a bad minute became
    "could not read block hashes" with nothing asked twice.

    What it raises is unchanged on purpose: callers already catch it, and a
    timeout now arrives as RuntimeError through the same door as everything
    else instead of escaping as TimeoutExpired.

    Still two round trips per host. The heights to re-read are chosen here,
    out of state this machine holds, and cannot be chosen before the tip is
    known. Two is not what makes the ops panel grey -- the shell checks
    opening twelve and sixteen are -- and guessing the rotation remotely to
    save one handshake would put the chain's reorg alarm at risk to save a
    few seconds.
    """
    if host in (None, "", "local", "localhost"):
        try:
            p = subprocess.run(["bash", "-ls"], input=cmd, capture_output=True,
                               text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"no answer within {timeout}s")
        if p.returncode != 0:
            raise RuntimeError((p.stderr or p.stdout or "no output").strip()[:300])
        return p.stdout

    rc, text = _ssh(host, cmd, timeout=timeout)
    if rc == UNREACHABLE:
        raise RuntimeError((text or "could not reach the host").strip()[:300])
    if rc != 0:
        raise RuntimeError((text or "no output").strip()[:300])
    return text


def cli(network, datadir=None):
    flag = {"mainnet": "-chain=main -conf=/root/.wam-mainnet/wam.conf "
                       "-datadir=/root/.wam-mainnet",
            "testnet": "-testnet",
            "regtest": "-regtest"}[network]
    # --datadir overrides the lot. It exists so this can be proved against a
    # throwaway regtest chain where a reorganisation can actually be caused
    # on purpose, without going anywhere near a node that matters.
    if datadir:
        flag = {"mainnet": "-chain=main", "testnet": "-testnet",
                "regtest": "-regtest"}[network] + f" -datadir={datadir}"
    return f"/opt/wam-current-bin/wam-cli {flag}"


def state_path(directory, host, network):
    tag = (host or "local").replace("/", "_").replace(":", "_")
    return os.path.join(directory, f"reorg-{network}-{tag}.json")


def load_state(path):
    try:
        with open(path) as f:
            d = json.load(f)
        return {int(k): v for k, v in d.get("heights", {}).items()}, d
    except (OSError, ValueError):
        return {}, {}


def save_state(path, heights, tip, cursor=0):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"heights": {str(k): v for k, v in heights.items()},
                   "tip": tip, "cursor": cursor,
                   "written": int(time.time())}, f, indent=1)
    os.replace(tmp, path)          # never leave a half-written state file


def raise_alarm(state_dir, network, host, detail):
    """Leave evidence that outlives the run that found it.

    A reorganisation is over in minutes. If this only reported through its
    exit status, the run two minutes later would find a perfectly consistent
    chain, say ok, and the one event anybody needed to know about would be a
    line in a journal that rotates. So it is written to a file, and the file
    stays until a person deletes it -- the same reason the backup check
    trusts a file on disk over a service that reported success.
    """
    os.makedirs(state_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    p = os.path.join(state_dir, f"ALARM-{network}-{stamp}.json")
    with open(p, "w") as f:
        json.dump({"utc": stamp, "network": network,
                   "host": host or "local", "detail": detail}, f, indent=1)
    return p


def outstanding_alarms(state_dir):
    try:
        return sorted(f for f in os.listdir(state_dir) if f.startswith("ALARM-"))
    except OSError:
        return []


def heights_to_check(tip, known, cursor):
    """The bounded set of heights this run will re-read.

    Always the offsets: they are dense near the tip, which is the only place
    a reorganisation of the kind worth alarming about begins.

    Plus a rotating slice of everything else recorded, so that nothing is
    trusted for ever on the strength of one reading, and so that the cost of
    a run does not grow with the length of the chain.
    """
    near = {tip - o for o in OFFSETS if tip - o >= 0}
    old = sorted(h for h in known
                 if tip - FORGET_AFTER < h <= tip and h not in near)
    if not old:
        return sorted(near), 0
    start = cursor % len(old)
    take = (old + old)[start:start + AUDIT_PER_RUN]
    return sorted(near | set(take)), (start + AUDIT_PER_RUN) % len(old)


def read_hashes(host, c, heights, timeout=120):
    """Ask the node for the hash at each of these heights."""
    script = "\n".join(f'echo "{h} $({c} getblockhash {h} 2>/dev/null)"'
                       for h in heights)
    out = run(host, script, timeout=timeout)
    got = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and len(parts[1]) == 64:
            got[int(parts[0])] = parts[1]
    return got


def fork_bracket(host, c, known, unchanged, changed):
    """Narrow where the chain we recorded and the chain we see part company.

    A reorganisation replaces a run of blocks from some height to the tip, so
    "this height changed" is true for every height above the fork and false
    below it. That is a boundary, and a boundary is found by halving: about
    eleven reads across fifteen hundred heights instead of fifteen hundred.

    It returns a bracket, not a number, and the difference is the whole
    point. A height can only be tested if its hash was recorded, and the
    offsets are sparse far from the tip -- 500 then 1000. So the honest
    answer is "deeper than this height, no deeper than that one", and the
    caller quotes the range. Naming a single height the evidence does not
    support would be a precise-sounding number that is wrong, given to an
    exchange asking how deep the damage went.
    """
    lo, hi = unchanged, changed              # lo still matches, hi does not
    pool = sorted(h for h in known if lo < h < hi)
    while pool:
        m = pool[len(pool) // 2]
        got = read_hashes(host, c, [m], timeout=45)
        if m in got and got[m] == known[m]:
            lo, pool = m, [h for h in pool if h > m]
        else:
            hi, pool = m, [h for h in pool if h < m]
    return lo, hi


def check(host, network, depth_alarm, state_dir, datadir=None):
    label = host or "this machine"
    print(f"\n{BLD}{label} -- {network}{OFF}")
    c = cli(network, datadir)

    # ---- one round trip for everything the check needs -------------------
    try:
        raw = run(host, f"{c} getblockcount && echo --- && {c} getchaintips")
    except Exception as e:
        unmeasured(f"{label}: node not answering ({e}). Nothing was compared, "
                   f"so nothing is claimed about this chain either way.")
        return
    try:
        head, tips_raw = raw.split("---", 1)
        tip = int(head.strip())
        tips = json.loads(tips_raw)
    except (ValueError, json.JSONDecodeError) as e:
        unmeasured(f"{label}: could not read the node's reply ({e}). A reply "
                   f"we cannot parse is a reply we did not read.")
        return

    # ---- 1. competing branches ------------------------------------------
    # An "active" tip is our own chain. Everything else is a branch the node
    # has heard of. valid-fork means we have the full blocks and they are
    # valid -- one more block of work on that side and we switch to it.
    worst = 0
    for t in tips:
        if t.get("status") == "active":
            continue
        d = int(t.get("branchlen", 0))
        worst = max(worst, d)
        if d >= depth_alarm:
            fn = bad if t.get("status") == "valid-fork" else warn
            fn(f"{label}: a competing branch {d} blocks deep at height "
               f"{t['height']} ({t.get('status')}) -- {t['hash'][:16]}...")

    if worst < depth_alarm:
        ok(f"deepest competing branch is {worst} block(s); alarm is at {depth_alarm}")

    # ---- 2. did a hash we recorded change? ------------------------------
    path = state_path(state_dir, host, network)
    known, prev = load_state(path)
    prev_tip = prev.get("tip")

    wanted, cursor = heights_to_check(tip, known, int(prev.get("cursor", 0)))
    if not wanted:
        ok("chain too short to have anything to compare yet")
        save_state(path, {}, tip, 0)
        return

    try:
        now = read_hashes(host, c, wanted)
    except Exception as e:
        unmeasured(f"{label}: could not read block hashes ({e}). The recorded "
                   f"heights are left untouched for the next run.")
        return

    changed = [(h, known[h], now[h]) for h in sorted(known)
               if h in now and known[h] != now[h]]

    if changed:
        # Depth is measured against the tip we last recorded, not the tip
        # now. Everything above the old tip is honest new work: counting it
        # as "rewritten" inflates the number, and this is a number that gets
        # quoted to an exchange deciding whether its deposits are safe.
        #
        # The offsets are sparse below the tip -- 500 then 1000 -- so the
        # shallowest height seen to change is an upper bound on the fork, not
        # the fork. Between the deepest height that still matches and that
        # one, the exact boundary is found by halving, so the depth reported
        # is the depth, not a round number that happened to be sampled.
        shallowest = min(h for h, _, _ in changed)
        floor = None
        still_good = [h for h in sorted(now) if h < shallowest and h in known
                      and known[h] == now[h]]
        if still_good:
            try:
                floor, shallowest = fork_bracket(host, c, known,
                                                 still_good[-1], shallowest)
            except Exception as e:
                warn(f"{label}: could not narrow the fork point ({e}); "
                     f"reporting the shallowest height sampled")

        # Two depths, because the fork sits somewhere in the bracket. The
        # larger one is quoted first: understating how deep a rewrite went is
        # the error that costs somebody money.
        depth = (prev_tip - shallowest + 1) if prev_tip else len(changed)
        deepest = (prev_tip - floor) if (prev_tip and floor is not None) else None
        if deepest and deepest != depth:
            how = (f"between {depth} and {deepest} block(s) deep -- the chain "
                   f"was rewritten from a height above {floor} and no higher "
                   f"than {shallowest}")
        else:
            how = (f"{depth} block(s) deep -- the chain was rewritten from "
                   f"height {shallowest}")
        msg = (f"{label}: REORGANISATION {how}. {len(changed)} recorded "
               f"height(s) no longer hold the block they held. Tip is now {tip}"
               + (f", was {prev_tip}." if prev_tip else "."))
        bad(msg)
        try:
            p = raise_alarm(state_dir, network, host,
                            {"message": msg, "depth": depth,
                             "depth_worst_case": deepest,
                             "from_height": shallowest,
                             "from_height_floor": floor, "tip": tip,
                             "previous_tip": prev_tip,
                             "changed": [{"height": h, "was": w, "now": n}
                                         for h, w, n in changed]})
            print(f"          evidence written to {p}")
            print(f"          it stays until a person deletes it")
        except OSError as e:
            warn(f"could not write the alarm file: {e}")
        for h, was, isnow in changed[:6]:
            print(f"          height {h}")
            print(f"            was  {was}")
            print(f"            now  {isnow}")
        if len(changed) > 6:
            print(f"          ... and {len(changed) - 6} more")
    else:
        # Say how many were actually re-read, not how many are on file. This
        # run checks a bounded slice, and reporting the whole file as verified
        # would be the exact kind of true-sounding sentence that makes a
        # monitor worth less than no monitor at all.
        rechecked = sum(1 for h in now if h in known)
        if known:
            ok(f"{rechecked} of {len(known)} recorded height(s) re-read this "
               f"run, all unchanged; the rest are re-read within the hour")
        else:
            ok(f"first run -- recorded {len(now)} height(s) to compare against")

    # Merge rather than replace: a height we recorded last week is a better
    # tripwire than one recorded a minute ago.
    merged = {h: v for h, v in known.items() if h > tip - FORGET_AFTER}
    merged.update(now)
    save_state(path, merged, tip, cursor)


def announce(text, repo):
    """Publish the alarm. Deliberate, never automatic -- see main()."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(text)
        p = f.name
    try:
        subprocess.run(["node", os.path.join(repo, "bots", "say.js"),
                        "--file", p], check=True, timeout=120)
    finally:
        os.unlink(p)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("hosts", nargs="*", help="hosts to ask; omit with --local")
    ap.add_argument("--local", action="store_true",
                    help="ask this machine's own node instead of an ssh host")
    # mainnet by default. Until 18 September every check here defaulted to
    # testnet, written when testnet was the only chain and never revisited;
    # run by hand without the flag, three days into mainnet, they answered
    # confidently about a chain with nothing on it.
    ap.add_argument("--network", default="mainnet",
                    choices=["mainnet", "testnet", "regtest"])
    ap.add_argument("--depth", type=int, default=2,
                    help="alarm at a competing branch this deep (default 2; "
                         "the deepest ever seen on this chain is 1)")
    ap.add_argument("--state-dir", default="/var/lib/wam-reorg",
                    help="where the recorded heights are kept")
    ap.add_argument("--datadir",
                    help="override the node data directory. Exists so this can "
                         "be proved against a throwaway regtest chain, where a "
                         "reorganisation can be caused on purpose.")
    ap.add_argument("--announce", action="store_true",
                    help="publish the alarm to the channels. Off by default: "
                         "a false alarm published is worse than a real one "
                         "found late, and this is a decision a person makes.")
    a = ap.parse_args()

    targets = a.hosts if a.hosts else ([None] if a.local else [])
    if not targets:
        ap.error("give one or more hosts, or --local")

    print(f"{BLD}has any confirmed block stopped being confirmed?{OFF}")

    # Anything found on an earlier run is still a finding. A run that says ok
    # two minutes after a reorganisation is telling the truth about the
    # chain now and nothing at all about what happened.
    old = outstanding_alarms(a.state_dir)
    for f in old:
        bad(f"an earlier run recorded a reorganisation: {a.state_dir}/{f}")
    if old:
        print(f"  {YEL}      delete those files once each one has been "
              f"looked at and understood{OFF}")

    for h in targets:
        try:
            check(h, a.network, a.depth, a.state_dir, a.datadir)
        except Exception as e:                      # never let one host hide another
            # A crash in this script is a failure of this script, not evidence
            # about the chain -- and it must not be able to publish an alarm.
            unmeasured(f"{h or 'this machine'}: {type(e).__name__}: {e}")

    print()
    if _fails:
        print(f"  {RED}{len(_fails)} finding(s) that need a person{OFF}")
        if a.announce:
            announce("Chain reorganisation detected on WAM " + a.network +
                     ".\n\n" + "\n".join(_fails) +
                     "\n\nExchanges and pools: raise your confirmation "
                     "requirement until this is explained.",
                     os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        return 1
    if _unknown:
        print(f"  {YEL}{len(_unknown)} thing(s) could not be measured -- that "
              f"is not 'nothing rewritten', it is 'nobody looked'{OFF}")
        # 2, this project's convention for "the check could not run". 1 would
        # claim a reorganisation nobody saw; 0 would vouch for a chain nobody
        # read.
        return 2
    if _warns:
        print(f"  {YEL}{len(_warns)} thing(s) worth a look, nothing confirmed{OFF}")
        return 0
    print(f"  {GRN}nothing rewritten{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
