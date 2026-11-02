# Block DX — what a submission needs

Block DX replied to the enquiry sent 2026-08-18 and pointed at a GitHub
repository. The one that matters is not `blocknetdx/block-dx`, which is the
client, but
[`blocknetdx/blockchain-configuration-files`](https://github.com/blocknetdx/blockchain-configuration-files),
which is where the 142 coins it can trade are described.

An earlier version of this directory held a single `xbridge.conf` written from
a general idea of what XBridge wants. That was wrong in form: their repository
takes three separate things, and a pull request shaped like the guess would not
have applied.

## The three files

| From here | To there |
|---|---|
| [`xbridge-confs/wam--v0.1.9.conf`](xbridge-confs/wam--v0.1.9.conf) | `xbridge-confs/wam--v0.1.9.conf` |
| [`wallet-confs/wam--v0.1.9.conf`](wallet-confs/wam--v0.1.9.conf) | `wallet-confs/wam--v0.1.9.conf` |
| [`manifest-entry.json`](manifest-entry.json) | one object appended to `manifest-latest.json` |

## Every value, and where it comes from

Read off `bitcoin--v0.17.0.conf` in their repository, because WAM is a Bitcoin
Core fork and that entry is the closest thing they already ship.

| Field | Value | Source |
|---|---|---|
| `Port` | 9554 | RPC port, not p2p — their `Port` is what XBridge calls |
| `AddressPrefix` | 73 | `base58Prefixes[PUBKEY_ADDRESS]` |
| `ScriptPrefix` | 135 | `base58Prefixes[SCRIPT_ADDRESS]` |
| `SecretPrefix` | 190 | `base58Prefixes[SECRET_KEY]` |
| `BlockTime` | 120 | `WAM_POW_TARGET_SPACING` |
| `COIN` | 100000000 | eight decimals, as Bitcoin |
| `dir_name_linux` | `wam` | the node's own default data directory is `~/.wam` |
| `conf_name` | `wam.conf` | measured by running `wamd`, not assumed |

**`GetNewKeySupported=false` and `ImportWithNoScanSupported=false`** follow
Bitcoin v0.17 rather than Litecoin v0.15. Those two flags describe a wallet
that will hand out a raw private key and import one without a rescan, which
descriptor wallets in modern Core do not do. WAM is a v28.1 fork, so claiming
otherwise would fail at the first swap rather than at submission.

**`MinTxFee=10000` and `FeePerByte=10`** are Litecoin's numbers, not Bitcoin's
12000/60, because those reflect a congested fee market WAM does not have. Ten
satoshis per byte is ten times the relay minimum a WAM node enforces, which
leaves room without inventing a fee market.

**`Confirmations=15`.** It was `0`, and it was the only value in that file
with no reason written beside it.

The cost of reversing a confirmation is set by hashrate, not by block timing.
On 6 September 2026 this chain ran at 5,400-6,100 H/s, and one ordinary
desktop measures 8,740 H/s on eight threads -- so the whole network is weaker
than a single computer, and out-hashing it for six hours costs under ten
dollars of rented CPU. That is ordinary for a chain three weeks old and it is
exactly why the number here matters: a swap settled at zero confirmations on
such a chain is not settled at all.

It was submitted as `60` -- two hours at a 120-second target, and the same
depth this project publishes for an exchange deposit. It is `15` now, about
thirty minutes, because the Komodo maintainer ran an actual swap on this
chain and arrived at that number from the swap rather than from the deposit.
A measured value from somebody who ran it beats a cautious one reasoned to
from the outside, and 15 is still far more cautious than the other 246 files
in that directory.

## The version in the filename

Their names carry the wallet version a config was verified against —
`litecoin--v0.15.1.conf`. A new file goes beside it when a release changes
anything XBridge reads.

Ours said `v0.1.6` from 21 August, which was right while WAM was pre-launch
and the number was still moving. The PR says so in as many words, and promises
one update after launch to the release people would actually be running:

> the conf is named for the wallet release it targets, and WAM is still
> pre-launch, so that number is moving. Mainnet opens on 15 September 2026 and
> I will update this entry once to the release people will actually be
> running, rather than resubmitting for each pre-release.

That is this change. Mainnet opened on 15 September and v0.1.9 is what nodes
run, so the files are `wam--v0.1.9.conf` and `versions` lists v0.1.8 and
v0.1.9 — both signed, both carrying Linux, Windows and macOS builds. Nothing
inside either file changed: every value was already verified against the
consensus source and is unchanged by v0.1.7, v0.1.8 or v0.1.9.

The older releases are dropped from `versions` deliberately. They still sync
mainnet — the consensus floor is v0.1.5 — but v0.1.6 predates launch, and a
list is a recommendation to somebody deciding what to install.

## Where it stands

Reopened as [`#200`](https://github.com/blocknetdx/blockchain-configuration-files/pull/200)
on 30 October 2026, from `wamcoin-Project/blockchain-configuration-files`,
branch `add-wam-coin`.

The history is three numbers for one submission. `#197` carried the v0.1.6
files and was superseded by `#199` on 28 September, after the first account
closed; `#199` carried the v0.1.10 files and went down with the account that
pushed it on 29 October. `#200` is `#199`'s own two commits, fetched back out of
`refs/pull/199/head` and verified byte for byte against the conf files here,
plus two commits extending `versions`: one naming v0.1.11 and v0.1.12 on 30
October, and one naming v0.1.13 on 31 October, the day it was released.

Each of those three shipped after `#199` was opened and each is served by the
downloads page. None of them changes anything XBridge reads, so `ver_id` and
both conf files stay on v0.1.10 and no `wam--v0.1.13.conf` is submitted. A new
conf goes beside the old one when a release changes a field in it, and these
did not.

Measured the day it was reopened rather than recalled: 247 conf files in
`xbridge-confs`, 245 of them `Confirmations=0`, one `1`, and ours the only
`15`. Actions are disabled on the fork.
