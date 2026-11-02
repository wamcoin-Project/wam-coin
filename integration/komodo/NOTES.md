# Komodo Wallet — what a submission needs

> **MERGED AND LIVE since 2026-09-22.** WAM is in `GLEECBTC/coins` and trades
> on dex.gleec.com. It did not get there by our pull request. `cipig`, that
> repository's maintainer, wrote on 2026-09-21 that he had to fix conflicts
> so he opened one of his own — [#2034](https://github.com/GLEECBTC/coins/pull/2034)
> — ran a test swap himself, changed one field, and merged it on 2026-09-22.
> Because that pull request was his and not ours, it survived our GitHub
> account being suspended on 2026-09-24 while all five of ours vanished.
>
> **He lowered `required_confirmations` from 60 to 15, and he was right.**
> 60 confirmations at a 120 second target is a two hour swap, and the backend
> cannot hold one open that long: 60 did not mean a safer swap, it meant no
> swap at all. His test at 4 confirmations completed in ten minutes. 15 is
> about thirty minutes, and he said it can be raised later if swaps start
> failing.
>
> **What it costs, stated rather than glossed:** the window in which a swap
> could be undone by a party able to rewrite the chain falls from two hours to
> thirty minutes. That number is set by hashrate, and this network's is small.
> It is a real exposure and it is accepted knowingly, for the one reason that
> the alternative is a listing nobody can trade on.
>
> **The deposit depth this project publishes stays 60.** It is a different
> question with a different answer: a deposit can wait two hours and an
> atomic swap cannot. Do not let the two numbers be "unified" by anybody
> tidying up.
>
> **The link is fixed.** The live entry's `links.github` pointed at
> `wam-coin-official`, which is locked. It now reads
> `wamcoin-Project/wam-coin`, checked against the raw file on 2026-10-01.
>
> **One thing is outstanding as of 2026-11-02:** the live `electrums/WAM` holds
> our two servers only. A third, run by an operator who is not us, has been
> verified and is in [`electrums-WAM.json`](electrums-WAM.json) awaiting a pull
> request — see *Electrum servers* below. `scripts/check_listing_entry.py` now
> reads the live `electrums/WAM` as well as the live `coins` entry, so this is
> a red row rather than a silence: it stays red until the pull request is
> merged, which is the expected state and whose action is to open it.

**`KomodoPlatform/coins` is not a second platform, and nothing should be sent
there.** It is a copy of `GLEECBTC/coins`, kept only so that older builds of
the wallet — which look for a repository at that name — keep working. cipig
said so on the pull request on 2026-09-27, and he maintains both.

This file previously treated it as the destination, and a pull request was
opened there on that reading: [#23](https://github.com/KomodoPlatform/coins/pull/23).
It asks an obsolete mirror to carry a change its source already has, so it is
to be closed rather than chased. The work is not lost — it is merged, in the
repository that is read.

Written down because the mistake is invisible from outside: both repositories
are public, both hold a `coins` file, both look maintained, and only one of
them is.

What a submission needs, kept for the next coin or the next field change — a
pull request to [`GLEECBTC/coins`](https://github.com/GLEECBTC/coins), not a
web form, and not the mirror above. Four things go in.

Only one thing still blocks the submission, and it is not one of them: these
files describe mainnet, and mainnet opens on 15 September 2026. Everything
that could be built before that day now is.

| | Where | State |
|---|---|---|
| Coin entry | appended to `coins` | [`coin-entry.json`](coin-entry.json) |
| Icon, 200×200 PNG | `icons/wam.png` | `brand/png/wam-platform-200.png` |
| Explorer | `explorers/WAM` | `https://explorer.wamcoin.org` |
| Electrum servers | `electrums/WAM` | [`electrums-WAM.json`](electrums-WAM.json) — see below |

They also ask for contact details for service alerts, since a listed coin whose
infrastructure goes quiet is their support problem as much as ours.

---

## Every field, and where it comes from

Each value below is duplicated from the consensus source. If they disagree, the
source wins and this file is wrong.

| Field | Value | Source |
|---|---|---|
| `rpcport` | 9554 | `WAM_MAINNET_RPC_PORT` — peer port **minus** one |
| `pubtype` | 73 | `base58Prefixes[PUBKEY_ADDRESS]`, addresses start `W` |
| `p2shtype` | 135 | `base58Prefixes[SCRIPT_ADDRESS]`, start `w` |
| `wiftype` | 190 | `base58Prefixes[SECRET_KEY]`, keys start `V` |
| `bech32_hrp` | `wam` | `bech32_hrp` |
| `segwit` | true | active from height 1 |
| `avg_blocktime` | 120 | `WAM_POW_TARGET_SPACING` |
| `sign_message_prefix` | `WAM Coin Signed Message:\n` | `MESSAGE_MAGIC`, changed by `WAM-021` |

**`required_confirmations` is 60**, which is two hours at a two-minute
target. It was 6 until 2026-08-29, with a note saying 6 gave "a comparable
reorg cost on this chain's timing". That was wrong, and wrong in the
direction that costs somebody money.

The cost of reversing a confirmation is set by hashrate, not by block
timing. Six confirmations on a chain with a millionth of Bitcoin's hashrate
cost a millionth as much to reverse; making the blocks faster or slower does
not change that. WAM is a new RandomX chain, which means the hardware that
would attack it is CPU — the most rentable resource there is, by the hour,
from every cloud provider. Monero is safe at ten confirmations because its
hashrate is enormous. A chain in its first weeks is not Monero.

20 is not an invented number. Of the coins already in this registry, 3 is
the most common value (475 of them) and 20 is the second (122). The majors
sit at the bottom — BTC 1, LTC 2, DOGE 2, DASH 2, RVN 3, ZEC 3 — because
their chains are settled. Putting WAM at 20 says, in the registry's own
vocabulary, that this chain is new and is being treated as new.

This field governs when Komodo Wallet shows a received payment as spendable
to its owner. It is not exchange deposit policy, which should be far more
conservative while hashrate is low — see the security section of
`docs/LISTING_PACKAGE.md`.

---

## The derivation path, and the one field still absent

**`derivation_path` is `m/44'/5718349'`.** It was blank until 2026-08-20 for a
good reason and is filled now for a better one: `wamd` derives there. A wallet
reports `44h/5718349h`, `49h/5718349h`, `84h/5718349h` and `86h/5718349h`, so
the field describes the software Komodo would be talking to rather than
requesting something of it.

`5718349` is `0x57414D`, which is `WAM` in ASCII — the convention Wanchain used
one number above at `0x57414E`. It is declared once, in
`src/wam/wam-params.h`, and `scripts/audit_repo.sh` rejects any file here that
disagrees with it.

**Registration is granted.** SatoshiLabs merged
[PR #2051](https://github.com/satoshilabs/slips/pull/2051) into master on
2026-08-26: SLIP-0044 coin type `5718349`, and SLIP-0173 prefixes `wam`,
`twam`, `wamrt`. The number in this file is no longer a request. It was
worth waiting for -- had they assigned a different one, every wallet built
in the meantime would have been discarded, which costs nothing before
mainnet and everything after.

**`trezor_coin` stays absent, and the SLIP registration did not change that.**

It is easy to read the merge of PR #2051 as hardware wallet support arriving,
and it is not. SLIP-0044 is a numbering registry; Trezor's own coin support
lives in a different one, `common/defs/bitcoin/` in `trezor/trezor-firmware`,
which holds 59 definitions and none of them is WAM. Checked on 2026-08-27
rather than assumed.

The registration is a prerequisite for that submission, not a substitute for
it. Writing a name into this field now would tell Komodo Wallet that a
Trezor can hold WAM, and it cannot.

---

## Electrum servers

Komodo Wallet requires ElectrumX servers with valid SSL for a UTXO coin. Their
repository has an `electrums/` directory and a UTXO coin without an entry there
is not usable by the wallet — it has no way to read balances.

**Three now run, and the third is not ours** — which is the one property no
number of our own machines could ever supply. All were verified from outside
the machines rather than on them: `scripts/check_electrum.py` speaks the
protocol, compares the genesis hash *and* the claimed height against the node
over ssh, and probes every A record behind a name separately. Measured
2026-11-02:

```
electrum.wamcoin.org    169.58.159.165:50002 SSL   height 33344, ElectrumX 2.0.0
                        169.58.159.165:50001 TCP   height 33344
electrum2.wamcoin.org    13.140.33.187:50002 SSL   height 33344, ElectrumX 2.0.0
                         13.140.33.187:50001 TCP   height 33344
wam.zcd.lol            158.247.220.175:50002 SSL   height 33344, ElectrumX 2.0.0
                       158.247.220.175:50001 TCP   height 33344
```

Genesis on all three reads
`d8d3debea987b62a0934c3980d62bffbb6e16aa797d19891d4fcc9b9fb11d7e9`, identical
to the assert in `src/wam/chainparams.cpp:483`. That field is the only one that
proves a working server indexes *this* chain — every other call answers just as
cheerfully on the wrong network.

`electrum` is at Contabo, `electrum2` in the US. Until 2026-11-02 this file
said `electrum2` was at Hetzner in Singapore, and it had moved: Singapore is
one core and two gigabytes, and an ElectrumX index does not fit on it. That
host runs nodes only and refuses 50001, 50002 and 50004 — measured, not
assumed.

**`wam.zcd.lol` is run by `cup`, who is not us**, in Seoul on Vultr: a third
operator, a third provider, a third continent. He built it with this
repository's own `integration/electrumx/install.sh --network mainnet`, runs
`wamd` v0.1.13 from the signed release with SHA256SUMS checked, holds a
Let's Encrypt certificate to 2027-01-31 with `wam-reload-electrumx` installed
as the renewal hook, and publishes a status board at <https://wam.zcd.lol/>
carrying tip, certificate expiry and per-server lag every two minutes. Until
tonight every number anybody could quote about this chain's infrastructure came
from us.

Two servers under one operator fail together, and here that is measured rather
than feared: the drift found on 2026-11-01 put the same wrong binaries on all
three of our machines at once, and the check that compared them to each other
called them agreed. An operator who is not us fails for different reasons than
we do, and survives what happens to us — the way cipig's pull request survived
our GitHub account being suspended on 2026-09-24 while all five of ours
vanished.

What was given up for it is narrow and gets named rather than glossed. We hold
no ssh on his machine, so nothing here can read which binary it executes, and
"I track your signed releases and stay current" is a promise rather than a
measurement — the exact shape of what blinded us for seven weeks. What the
protocol still shows from outside is what his index says *about the chain*: a
stale daemon lags in height, a divergent one disagrees on genesis, and both are
already compared. So what was lost is the early warning, not the sight — a
version check says "he is behind" before anything splits, and genesis says "it
split" afterwards. He asked for that outside row himself, before we offered it.

50004 carries the Electrum protocol over WebSocket for Komodo's *web* wallet
and is open on all three; desktop and mobile use 50002 directly.

### 2026-08-29: those ports now hold nothing, on purpose

The heights above were a **testnet** chain, answering on the ports this
entry publishes for **mainnet**. That is worse than an endpoint being down.
A reviewer who connects to `electrum.wamcoin.org:50002`, gets a working
ElectrumX, and reads back a genesis hash that is not the one in this entry
has found a defect in the submission — where a port that is not up yet is
just a launch date.

So testnet's ElectrumX moved to **51001 / 51002 / 51004** on both hosts, its
index carried across rather than rebuilt, and 50001 / 50002 / 50004 are held
empty until mainnet opens on 2026-09-15. `wam-electrumx@mainnet` is already
installed on both machines, configured against those ports, and deliberately
not started.

Until 15 September the endpoints in `electrums-WAM.json` do not answer, and
the pull request says so rather than leaving it to be discovered.

Getting there found two faults worth recording, neither of which any check
would have reported:

**The first server was down for 39 hours.** Stopped during the testnet reset on
2026-08-20 and never restarted. `systemctl` showed `inactive` with
`Result=success`, so nothing looked wrong, and `sweep.sh` ran in that window
and reported 14 passed — because no check had ever asked. `check_electrum.py`
exists for that reason and is now in the sweep.

**`electrum.wamcoin.org` resolved to two addresses** and only one had ever run
the service, so half of all connections failed even while the server was up.
Any check that resolved the name once and got lucky would have passed.

**One thing is still not true.** They serve testnet, and Komodo lists mainnet.
The same installer with `--network mainnet` produces the mainnet server and
nothing else about either host changes — so on launch day this is a restart,
not a build under time pressure.

The two venues ranked most likely to fit — BasicSwap and Block DX — run `wamd`
itself and never speak the Electrum protocol, so neither was ever blocked by
any of this.
