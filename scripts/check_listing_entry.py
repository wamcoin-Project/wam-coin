#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_listing_entry.py -- does the Komodo entry still describe this coin?
# ===========================================================================
#
#      python3 scripts/check_listing_entry.py
#
#  WHY THIS EXISTS
#
#  A listing entry is read by software, not by a person. A wrong `pubtype`
#  does not look wrong on the page -- it sends somebody's coins nowhere, and
#  the first report of it is a user who has already lost them.
#
#  The entry was written by hand from the source, and hand-written copies of
#  constants drift. Every one of these numbers already exists exactly once in
#  src/wam, so the entry can be checked against it rather than trusted, and
#  the check can run in the sweep rather than at submission time -- because
#  the dangerous moment is not the day it is written, it is the day somebody
#  changes a prefix and forgets that a file in integration/ repeats it.
# ===========================================================================

import json
import pathlib
import re
import sys

import pathlib as _pathlib
import sys as _sys
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

def _read(p, **kw):
    """Read a file with the author's quotations blanked.

    Line numbers survive the blanking, so anything this check reports still
    points where it says. See scripts/lib/quoted.py: a check that matches text
    cannot tell use from mention, and four checks here were fired by text that
    merely mentioned what they look for, within one day.
    """
    kw.setdefault("encoding", "utf-8")
    kw.setdefault("errors", "replace")
    return quoted.strip_quoted(_pathlib.Path(p).read_text(**kw))

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

REPO = pathlib.Path(__file__).resolve().parent.parent
KOMODO = REPO / "integration" / "komodo"

# Where a reader of these entries actually goes to fetch a wallet. Not a
# mirror of the source -- the downloads themselves, on this project's own
# hardware, which is the only copy whose disappearance is ours to prevent.
DOWNLOADS_URL = "https://wamcoin.org/downloads/"

# The swap depth, decided once and read by two checks below: the Komodo entry
# and the Block DX xbridge conf. It lived inside main() and the Block DX check
# could not see it, which is how a constant that exists in one place still
# manages to be missing from another.
REQUIRED_CONFIRMATIONS = 15

_fails = []


# Questions this run could not ask. The local fields were still compared, so
# this is not a failure -- but the summary line below vouches for the whole
# entry, and it may not vouch for a question nobody put.
_unknown = []


def ok(m):   print(f"  {GRN}ok{OFF}    {m}")
def bad(m):  print(f"  {RED}FAIL{OFF}  {m}"); _fails.append(m)
def warn(m): print(f"  {YEL}!!{OFF}    {m}")
def unmeasured(m):
    print(f"  {YEL}??{OFF}    {m}")
    _unknown.append(m)


def main():
    entry = json.loads((KOMODO / "coin-entry.json").read_text(encoding="utf-8"))
    if isinstance(entry, list):
        entry = entry[0]
    cp = _read(REPO / "src/wam/chainparams.cpp")
    hdr = _read(REPO / "src/wam/wam-params.h")

    # Only the mainnet section. Testnet repeats every one of these constants
    # with different values, and a check that reads the wrong section passes
    # for the wrong reason.
    main_section = cp[cp.index("CMainParams"):cp.index("CTestNetParams")]

    def num(pat, text):
        m = re.search(pat, text)
        return int(m.group(1).replace("'", "")) if m else None

    def prefix(name):
        return num(r"base58Prefixes\[%s\][^;]*?\(1,\s*([0-9]+)\)" % name,
                   main_section)

    coin_type = re.search(r"WAM_BIP44_COIN_TYPE[^=]*=\s*(0x[0-9A-Fa-f]+)", hdr)
    coin_type = int(coin_type.group(1), 16) if coin_type else None
    hrp = re.search(r'bech32_hrp\s*=\s*"([a-z]+)"', main_section)

    print(f"{BLD}every field of the Komodo entry, against src/wam{OFF}")

    checks = [
        ("coin",                   entry.get("coin"), "WAM"),
        ("pubtype",                entry.get("pubtype"), prefix("PUBKEY_ADDRESS")),
        ("p2shtype",               entry.get("p2shtype"), prefix("SCRIPT_ADDRESS")),
        ("wiftype",                entry.get("wiftype"), prefix("SECRET_KEY")),
        ("bech32_hrp",             entry.get("bech32_hrp"),
                                   hrp.group(1) if hrp else None),
        ("avg_blocktime",          entry.get("avg_blocktime"),
                                   num(r"WAM_POW_TARGET_SPACING[^=]*=\s*([0-9']+)", hdr)),
        ("derivation_path",        entry.get("derivation_path"),
                                   f"m/44'/{coin_type}'"),
        ("protocol.type",          entry.get("protocol", {}).get("type"), "UTXO"),
    ]

    for name, got, want in checks:
        if want is None:
            bad(f"{name}: could not find the value in src/wam to compare against")
        elif str(got) != str(want):
            bad(f"{name}: entry says {got!r}, source says {want!r}")
        else:
            ok(f"{name:<18} {got}")

    # Not derived from source -- a judgement, recorded so a later change is
    # deliberate rather than accidental. See integration/komodo/NOTES.md.
    # 6 -> 20 on 2026-08-29, 20 -> 60 on 2026-09-06. The direction has been the
    # same each time and for the same reason: reorg cost is set by hashrate, and
    # this chain's hashrate was measured that day at 5,400-6,100 H/s against a
    # single desktop's 8,740. Sixty is also the number this project publishes
    # for an exchange deposit, so the entry and the documentation now ask for
    # the same thing -- they did not before, and the machine-readable copy was
    # the lower of the two, which is the wrong way round.
    # A judgement, not a constant -- and no longer ours alone.
    #
    # It was raised to 60 on 2026-09-06, matching the depth this project
    # publishes for an exchange deposit, because the cost of reversing a
    # confirmation is set by hashrate and this network is weaker than one
    # desktop computer.
    #
    # It is 15 from 2026-09-22, because the venue's own maintainer lowered it
    # and merged: 60 confirmations at a 120 second target is a two hour swap,
    # and the backend cannot hold one open that long -- so 60 did not mean a
    # safer swap, it meant no swap. His test at 4 confirmations completed in
    # ten minutes. 15 is about thirty minutes.
    #
    # THE TRADE IS REAL AND IS WRITTEN DOWN, in komodo/NOTES.md: the window in
    # which a swap could be reversed by a party able to rewrite the chain
    # falls from two hours to thirty minutes. The depth this project publishes
    # for an exchange DEPOSIT is a different number and stays at 60; a deposit
    # can wait two hours and an atomic swap cannot.

    rc = entry.get("required_confirmations")
    if rc != REQUIRED_CONFIRMATIONS:
        bad(f"required_confirmations is {rc}, and this project's decision is "
            f"{REQUIRED_CONFIRMATIONS}. Changing it is a decision, not a typo "
            f"-- change it here and update NOTES.md with the reason.")
    else:
        ok(f"{'required_confirmations':<18} {REQUIRED_CONFIRMATIONS}  "
           f"(a judgement, not a constant)")

    # And the live entry is not ours to set alone any more, so it is read
    # rather than assumed. WAM was merged into GLEECBTC/coins on 2026-09-22 by
    # that repository's maintainer, in a pull request of his own -- which is
    # why it survived our account being suspended, and why the value there can
    # change without anybody telling us.
    try:
        import urllib.request as _u
        _req = _u.Request("https://raw.githubusercontent.com/GLEECBTC/coins/master/coins",
                          headers={"User-Agent": "wam-listing-check"})
        with _u.urlopen(_req, timeout=25) as f:
            live = [c for c in json.load(f) if c.get("coin") == "WAM"]
        if not live:
            bad("WAM is no longer in GLEECBTC/coins. It was merged there on "
                "2026-09-22 and is what dex.gleec.com reads.")
        else:
            drift = {k: (v, live[0].get(k)) for k, v in entry.items()
                     if k in live[0] and live[0].get(k) != v}

            # One field is asked for and not ours to change, and the rest are
            # dangerous. They must not be reported the same way.
            #
            # `links` holds the repository URL and only that repository's
            # maintainer can edit it. A red that nobody here can clear is a
            # red that teaches the reader to skip the line, which this project
            # has already paid for once.
            #
            # So it warns while it is waiting, AND STOPS WAITING. After
            # WAITING_ON_UNTIL it is a failure again, because "reported" is
            # not a state a wrong link gets to sit in forever. Every other
            # field fails immediately: a wrong prefix, port or confirmation
            # count does not inconvenience a reader, it sends somebody's coins
            # nowhere.
            #
            # TWICE NOW, AND THE SECOND TIME THIS CHECK WAS THE ONLY WITNESS.
            # The first time the live link named the account locked on
            # 2026-09-24; it was reported in GLEECBTC/coins#2034, kept in
            # posts/replies/cipig-2034.txt, and he changed it. On 2026-10-29
            # that replacement account was suspended in turn, so the one venue
            # where WAM actually trades went back to sending anyone who
            # pressed "source" to a 404 -- and nothing but this line said so,
            # on 2026-10-30.
            #
            # This time a pull request went instead of a comment:
            # GLEECBTC/coins#2077, one line, +1/-1, approved and merged
            # FIFTEEN MINUTES after it was opened.
            #
            # So the messages below name no pull request number. A number is
            # true for one incident and a lie at the next, and this block
            # exists because a check that lies stops being read -- it was
            # already telling us to send a request we had just sent. What
            # they name instead is the part that does not go stale: a
            # one-line request to this repository has been merged twice now,
            # the second time inside a quarter of an hour, so there is no
            # case for sitting in a warning and asking again.
            WAITING_ON = {"links"}
            WAITING_ON_UNTIL = "2026-11-13"
            import datetime as _dt
            overdue = _dt.date.today().isoformat() > WAITING_ON_UNTIL

            if drift:
                for k, (ours, theirs) in sorted(drift.items()):
                    msg = (f"live entry disagrees with ours: {k} is {theirs!r} "
                           f"at GLEECBTC/coins and {ours!r} here")
                    if k in WAITING_ON and not overdue:
                        warn(f"{msg} -- only that repository's maintainer can "
                             f"change it. This becomes a failure on "
                             f"{WAITING_ON_UNTIL}.")
                    elif k in WAITING_ON:
                        bad(f"{msg} -- open a one-line pull request against "
                            f"GLEECBTC/coins. Two have been merged there, the "
                            f"second within fifteen minutes of opening.")
                    else:
                        bad(msg)
            else:
                ok(f"{'live entry':<18} matches ours, field for field")
    except Exception as e:
        unmeasured(f"could not read the merged entry at GLEECBTC/coins, so "
                   f"whether ours still matches what dex.gleec.com reads is "
                   f"unknown ({e})")

    # Fields comparable entries carry. Missing one is not fatal, but it is
    # the kind of omission a reviewer notices and we would rather not.
    expected = {"coin", "name", "fname", "rpcport", "pubtype", "p2shtype",
                "wiftype", "txfee", "dust", "segwit", "bech32_hrp", "mm2",
                "required_confirmations", "avg_blocktime", "protocol",
                "derivation_path", "links", "wallet_only",
                "sign_message_prefix"}
    missing = sorted(expected - set(entry))
    if missing:
        warn(f"fields other entries carry and this one does not: {', '.join(missing)}")
    else:
        ok("no field missing that comparable entries carry")

    # The Electrum file publishes the mainnet ports. If it ever names the
    # testnet set, a wallet would be pointed at the wrong chain -- which is
    # exactly the state that was corrected on 2026-08-29.
    el = json.loads((KOMODO / "electrums-WAM.json").read_text(encoding="utf-8"))
    # Local, not `if not _fails`. That read the whole run's tally, so a field
    # disagreeing two checks above silently swallowed this line -- and a line
    # that disappears when something else is wrong is worst exactly when it is
    # needed.
    ports_ok = True
    for s in el:
        url = s.get("url", "")
        ws = s.get("ws_url", "")
        if ":50002" not in url or ":50004" not in ws:
            ports_ok = False
            bad(f"electrum entry {url} / {ws} does not use the published "
                f"mainnet ports 50002 and 50004")
    if ports_ok:
        ok(f"{len(el)} electrum server(s), all on the published mainnet ports")

    # And what a wallet is actually handed, which is a different file.
    #
    # Everything above reads OUR copy. A wallet reads GLEECBTC/coins, and the
    # two came apart the moment a third server was verified on 2026-11-02: ours
    # held three, the live file held two, and nothing here said so. The coin
    # entry forty lines up has been read from the live copy since September for
    # exactly this reason. The electrum list never was -- and it is the half
    # that decides whether a wallet can read a balance at all.
    #
    # The two directions do not mean the same thing. A server in ours and not
    # theirs is work prepared and not yet merged: expected between verifying an
    # operator and the pull request landing, and the action is to open it or
    # chase it. A server in theirs and not ours is a wallet being sent to an
    # endpoint nobody here has verified, which is not paperwork.
    try:
        import urllib.request as _u
        _req = _u.Request("https://raw.githubusercontent.com/GLEECBTC/coins"
                          "/master/electrums/WAM",
                          headers={"User-Agent": "wam-listing-audit"})
        with _u.urlopen(_req, timeout=25) as f:
            live_el = json.load(f)
    except Exception as e:
        unmeasured(f"could not read electrums/WAM at GLEECBTC/coins, so the "
                   f"servers a wallet is actually given were not compared: {e}")
    else:
        ours_urls = {s.get("url") for s in el}
        live_urls = {s.get("url") for s in live_el}
        only_ours = sorted(ours_urls - live_urls)
        only_live = sorted(live_urls - ours_urls)
        if only_live:
            bad(f"electrums/WAM at GLEECBTC/coins names {', '.join(only_live)}, "
                f"which is not in ours -- a wallet is being handed a server "
                f"nobody here has verified against the node")
        if only_ours:
            bad(f"{', '.join(only_ours)} is verified here and absent from "
                f"electrums/WAM at GLEECBTC/coins, so no wallet is being given "
                f"it. If the pull request is open this is the expected state; "
                f"if it is not, the work is sitting here serving nobody")
        if not only_ours and not only_live:
            ok(f"{'live electrums':<18} matches ours, {len(live_urls)} server(s)")

    check_blockdx(prefix, num, hdr)

    print()
    if _fails:
        print(f"  {RED}{len(_fails)} field(s) disagree with the source{OFF}")
        return 1
    if _unknown:
        print(f"  {YEL}the fields agree, but {len(_unknown)} question(s) could "
              f"not be asked{OFF}")
        # 2, this project's convention for "the check could not run in full".
        return 2
    print(f"  {GRN}the entries describe this coin{OFF}")
    return 0


def check_blockdx(prefix, num, hdr):
    """The Block DX manifest, which had two faults nobody would have seen.

    On 2026-08-29 a Block DX maintainer said he was about to test our entry
    by deploying the wallet in docker. It carried ver_id `wamcoin--v0.1.3`,
    and:

      * every one of the 142 entries in their manifest derives ver_id from
        the *conf_name* stem, not the coin name -- bitcoin.conf gives
        bitcoin--v0.15.1. Ours is wam.conf, so ours must be wam--.
      * v0.1.3 has no downloadable assets. Only v0.1.6 does. A test that
        fetches the wallet for a listed version would have found nothing,
        in the same batch where he was removing dead coins.

    Neither would have been visible by reading the file.
    """
    bd = REPO / "integration" / "blockdx"
    if not bd.is_dir():
        return
    print()
    print(f"{BLD}the Block DX manifest entry{OFF}")

    m = json.loads((bd / "manifest-entry.json").read_text(encoding="utf-8"))
    if isinstance(m, list):
        m = m[0]

    stem = m.get("conf_name", "").rsplit(".", 1)[0]
    if not m.get("ver_id", "").startswith(stem + "--"):
        bad(f"ver_id {m.get('ver_id')!r} does not follow conf_name "
            f"{m.get('conf_name')!r}. Every entry in their manifest does: "
            f"bitcoin.conf gives bitcoin--v0.15.1.")
    else:
        ok(f"{'ver_id':<18} {m['ver_id']}  (follows {m['conf_name']})")

    for field, folder in (("wallet_conf", "wallet-confs"),
                          ("xbridge_conf", "xbridge-confs")):
        want = f"{m['ver_id']}.conf"
        if m.get(field) != want:
            bad(f"{field} is {m.get(field)!r}, should be {want!r} to match ver_id")
        elif not (bd / folder / want).is_file():
            bad(f"{folder}/{want} does not exist")
        else:
            ok(f"{field:<18} {want}")

    # The xbridge conf repeats the base58 prefixes and the RPC port. They are
    # what tells a DEX how to build and read an address, and a wrong one does
    # not look wrong -- it sends a swap somewhere nobody can spend from.
    xb = (bd / "xbridge-confs" / f"{m['ver_id']}.conf").read_text(encoding="utf-8") \
        if (bd / "xbridge-confs" / f"{m['ver_id']}.conf").is_file() else ""
    for key, want in (("AddressPrefix", prefix("PUBKEY_ADDRESS")),
                      ("ScriptPrefix",  prefix("SCRIPT_ADDRESS")),
                      ("SecretPrefix",  prefix("SECRET_KEY")),
                      ("BlockTime",     num(r"WAM_POW_TARGET_SPACING[^=]*=\s*([0-9']+)", hdr))):
        mm = re.search(rf"^{key}=(\d+)", xb, re.M)
        if not mm:
            bad(f"the xbridge conf has no {key}")
        elif int(mm.group(1)) != want:
            bad(f"xbridge {key} is {mm.group(1)}, source says {want}")
        else:
            ok(f"{('xbridge ' + key):<18} {want}")

    # CONFIRMATIONS, WHICH IS A DECISION AND NOT A CONSTANT.
    #
    # The Block DX submission carried Confirmations=60 -- the depth this
    # project publishes for an exchange DEPOSIT -- on a venue where a swap
    # completes when that number of confirmations is reached. 60 at a 120
    # second target is a two hour swap. Of the 247 coins in that repository,
    # 245 use 0 and one uses 1; we were the only 60 in it.
    #
    # It is 15 now, which is the number the Komodo maintainer arrived at after
    # running a real swap, and the same number this project's own entry
    # carries: half an hour rather than two, and still fifteen times more
    # cautious than every other coin on that venue. The deposit depth stays
    # 60 and is a different question with a different answer.
    #
    # Checked here because it was wrong once, in a file that looked finished.
    mm = re.search(r"^Confirmations=(\d+)", xb, re.M)
    if not mm:
        bad("the xbridge conf has no Confirmations")
    elif int(mm.group(1)) != REQUIRED_CONFIRMATIONS:
        bad(f"xbridge Confirmations is {mm.group(1)}, and a swap on that venue "
            f"completes at that depth. This project's swap depth is "
            f"{REQUIRED_CONFIRMATIONS}; 60 is the DEPOSIT depth and would mean "
            f"a two hour swap.")
    else:
        ok(f"{'xbridge Confirmations':<18} {REQUIRED_CONFIRMATIONS}  "
           f"(a swap, not a deposit)")

    # Two faults, opposite directions, and until 19 September only one of
    # them could be seen from here.
    #
    #   listed but not downloadable -- somebody is told to install a version
    #       that does not exist. Caught since this was written.
    #
    #   released but not listed -- the newest wallet is missing from the
    #       manifest an integrator reads, so Block DX does not recognise the
    #       version people are actually running. v0.1.9 was published and
    #       this printed "the entries describe this coin" with the newest
    #       release absent, because it only ever walked the list in the file
    #       and never asked what the repository had released.
    #
    # A check that can only look one way says nothing about the other.
    #
    # WHERE THIS LOOKS, AND WHY IT IS NO LONGER GITHUB
    #
    # Until 2026-09-25 both halves asked api.github.com. That was the right
    # question while GitHub held the only copy of the downloads, and it became
    # the wrong one the day the account behind it was suspended: v0.1.8 and
    # v0.1.9 are still published, still signed and still downloadable, and
    # asking GitHub about them now answers 404 -- so this check reported a
    # missing download that is not missing, and would have reported the whole
    # list downloadable again on the day somebody re-uploaded old binaries to
    # a mirror nobody reads.
    #
    # The manifest sends an integrator to the downloads, and the downloads are
    # at wamcoin.org, on hardware this project runs. That is what has to be
    # true, so that is what is measured. GitHub, GitLab and Gitea are three
    # mirrors of the source; none of them is where a wallet is fetched from,
    # and a check must ask the place the reader will actually go.
    try:
        import urllib.request
        import urllib.error

        def _get(url):
            req = urllib.request.Request(
                url, headers={"User-Agent": "wam-listing-check"})
            with urllib.request.urlopen(req, timeout=25) as f:
                return f.read().decode("utf-8", "replace")

        def _vkey(v):
            return tuple(int(x) for x in re.findall(r"\d+", v))

        listed = m.get("versions", [])

        # ---- released but not listed --------------------------------------
        newest = None
        try:
            index = _get(DOWNLOADS_URL)
            published = sorted(set(re.findall(r'href="(v\d+\.\d+\.\d+)/"', index)),
                               key=_vkey)
            newest = published[-1] if published else None
        except Exception as e:
            unmeasured(f"could not read the downloads index, so whether the "
                       f"newest release is listed is unknown ({e})")
        if newest and newest not in listed:
            bad(f"{newest} is published and downloadable and is NOT in "
                f"versions. An integrator reading this file does not know the "
                f"version people are running exists.")
        elif newest:
            ok(f"{'newest ' + newest:<18} is in versions")

        # ---- listed but not downloadable ----------------------------------
        #
        # A version is downloadable when its directory carries wallet archives
        # AND the signature over their checksums. Half of that is worse than
        # neither: binaries nobody can verify, reached by following a manifest
        # this project published.
        for v in listed:
            try:
                page = _get(f"{DOWNLOADS_URL}{v}/")
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    bad(f"versions lists {v}, which has no download directory "
                        f"at {DOWNLOADS_URL}{v}/. Anyone told to install that "
                        f"version finds nothing.")
                else:
                    unmeasured(f"could not read the {v} downloads ({e})")
                continue
            except Exception as e:
                unmeasured(f"could not read the {v} downloads ({e})")
                continue

            files = re.findall(r'href="([^"/]+)"', page)
            archives = [f for f in files
                        if re.match(rf"wam-(coin|miner)-{re.escape(v)}-.*"
                                    rf"(\.tar\.gz|\.zip)$", f)]
            if not archives:
                bad(f"versions lists {v}, whose download directory holds no "
                    f"wallet archive. Anyone told to install that version "
                    f"finds nothing.")
            elif "SHA256SUMS.asc" not in files:
                bad(f"versions lists {v}, whose {len(archives)} archives have "
                    f"no SHA256SUMS.asc beside them. Nobody can check what "
                    f"they downloaded, and this manifest sent them there.")
            else:
                ok(f"{('release ' + v):<18} {len(archives)} signed download(s)")
    except Exception as e:
        unmeasured(f"could not reach {DOWNLOADS_URL}, so whether every listed "
                   f"version still has a download is unknown ({e})")


if __name__ == "__main__":
    sys.exit(main())
