# WAM Coin

[![release](https://img.shields.io/github/v/release/wamcoin-Project/wam-coin?include_prereleases&label=release&color=0a7)](https://github.com/wamcoin-Project/wam-coin/releases)
[![downloads](https://img.shields.io/github/downloads/wamcoin-Project/wam-coin/total?label=downloads&color=0a7)](https://wamcoin.org/downloads/)
[![licence MIT](https://img.shields.io/badge/licence-MIT-blue)](COPYING)

**A CPU-mineable proof-of-work currency with a hard 22,000,000 cap.**

RandomX proof of work · DarkGravityWave v3 · 2-minute blocks · consensus-enforced 5% treasury

[wamcoin.org](https://wamcoin.org) · [@WAMCoinCore](https://x.com/WAMCoinCore) ·
[announcements](https://t.me/wam_coin_updates) · [discord](https://discord.gg/Gxvmrjy9Qb) ·
[security](SECURITY.md)

> Those five are the only official channels, and [CHANNELS.txt](CHANNELS.txt) is the
> canonical copy of that list — plain text, so it can be signed and checked rather than
> merely believed. A page that claims to be WAM but is not named there is not WAM. There
> is no presale, no allocation to buy, and nobody who will ever ask you for funds.

---

## What this repository is

WAM Coin is a fork of Bitcoin Core, not a rewrite. Roughly 250,000 lines of peer-to-peer
networking, script interpretation, UTXO management and wallet code are inherited from a
codebase that has been adversarially reviewed for fifteen years. Retyping that would not
make WAM more original — it would make it less safe.

What this repository owns is the ~2,000 lines that actually make WAM different:

```
src/wam/                 the consensus layer that is genuinely ours
  wam-params.h             every monetary constant, in one file
  consensus/subsidy.cpp    the emission schedule
  consensus/devfee.cpp     consensus rule WAM-1: the mandatory 5% treasury output
  pow.cpp                  DarkGravityWave v3
  crypto/randomx_hash.cpp  RandomX PoW, key rotation, VM pooling
  chainparams.cpp          network identity, genesis, address prefixes
  rpc/wam_rpc.cpp          getsupplyinfo, getdevfeeinfo, getrandomxinfo, ...
  test/                    Boost unit tests for the above

scripts/
  patch_upstream.py        anchored, verified transformations onto Bitcoin Core
  fetch-upstream.sh        pull the pinned upstream tag and apply them
  gen_founder_key.py       offline founder keypair generator (zero dependencies)
  verify_supply.py         independent audit of the 22,000,000 cap

genesis/
  genesis_generator.py     mine the genesis block
  test_serialization.py    proves the serializer by reproducing Bitcoin's genesis
  randomx_ffi.py           ctypes binding to librandomx

explorer/                network dashboard — zero dependencies, `node server.js`
pool/                    stratum mining pool (Node.js) + live pool dashboard
brand/                   the coin mark, transparent PNG from 32 to 2048
install.sh               one-command deployment on Ubuntu 22.04 / 24.04 LTS
WHITEPAPER.md            the full public specification
```

---

## Network dashboard

```bash
cd explorer && node server.js
# http://127.0.0.1:8081/
```

**No `npm install`, no build step, no config.** It reads RPC credentials straight out of
`~/.wam/wam.conf` (which `install.sh` writes) and starts even when the node is down —
reporting that the node is down is part of its job.

Shows the supply against the 22,000,000 cap split four ways (publicly mined / founder
unlocked / founder time-locked / not yet mined), the live vesting schedule, the treasury
fee with a countdown to its expiry at block 400,000, RandomX epoch rotation, recent blocks,
and a per-block treasury audit against consensus rule WAM-1.

```bash
curl -fs localhost:8081/api/health || echo "WAM node is down"
```

---

## Project status

**Testnet is live. Mainnet launches 2026-09-15 00:00 UTC.**

| | |
|---|---|
| Consensus code | compiles; 29 Boost tests pass |
| Testnet | running, seed nodes in France and Singapore, found by DNS |
| Mainnet genesis | mined and committed — `d8d3debe…` |
| Founder key | generated offline, on paper, never on a networked machine |
| Founder reserve | fully time-locked; nothing spendable at launch |
| Release | [v0.1.13](https://wamcoin.org/downloads/), built and published by CI from a tag |
| Independent review | two developers outside the project, both still reading — [findings and what changed](review/REVIEW_RESPONSE.md) |
| Registry | [SLIP-0044](https://github.com/satoshilabs/slips/blob/master/slip-0044.md) coin type **5718349** and [SLIP-0173](https://github.com/satoshilabs/slips/blob/master/slip-0173.md) prefix **`wam`** — merged into SatoshiLabs' registry, 2026-08-26 |
| Paid security audit | **none** |

Two developers outside the project have read this code. The first found two
real security holes -- a Redis instance reachable without a password, and a
share-accounting race -- both fixed, with the exchange on the record in
[review/REVIEW_RESPONSE.md](review/REVIEW_RESPONSE.md); he still follows the
repository and sends notes. The second began on 2026-08-21, intends to keep
following it, and says he will bring colleagues who would each take a different
area. That last part has not started and is written here as an intention, not a
fact.

That is peer review, and peer review is not a paid audit. Nobody has been
engaged to attack the consensus changes methodically and publish what they
find. The consensus layer is where a mistake costs most and where the fewest
eyes have been, so it is the part most worth volunteering for: see
[SECURITY.md](SECURITY.md), which says plainly what a reviewer gets — a real
answer, credit if wanted, a fix, and the report published in full. **No
payment**, and the reason is in that file: this project has no revenue, and a
promise we could not keep would be worse than saying so.

- **[docs/START_HERE.md](docs/START_HERE.md)** — run a node and mine, written for someone who has never done either ([بالعربية](docs/START_HERE_AR.md)).
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — the phased plan from here to a running network.
- **[docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md)** — the irreversible steps.
- **[docs/LAUNCH_DAY.md](docs/LAUNCH_DAY.md)** — the order things happen in on 15 September, and where the point of no return is.
- **[docs/TREASURY_CUSTODY.md](docs/TREASURY_CUSTODY.md)** — what holds the 5%, and the dated plan to stop it being one key.
- **[docs/LISTING_PACKAGE.md](docs/LISTING_PACKAGE.md)** — every parameter an integrator needs.

---

## Quick start

```bash
git clone https://gitlab.com/WAMCoin/wam-coin.git && cd wam-coin
./install.sh --network regtest
```

Regtest works immediately and needs no founder key. For mainnet, see
[Launching a real chain](#launching-a-real-chain) below — there are three steps that only
you can do, and the installer will stop and tell you so.

---

## Audit it before you trust it

Every claim in the whitepaper has a command attached. None of these need a compiler,
a network connection, or a running node:

```bash
python3 scripts/verify_supply.py --schedule
```
Reads the constants out of `src/wam/wam-params.h` and replays all 33 halving epochs with
exact integer arithmetic. Prints the terminal supply and asserts the cap.

```bash
python3 genesis/test_serialization.py
```
Rebuilds **Bitcoin's real genesis block** with WAM's serializer and checks the resulting
hash against `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f`. If the
varint encoding, script pushes, transaction layout or header layout were wrong by a single
byte, this fails.

```bash
python3 scripts/gen_founder_key.py --selftest
```
Verifies the secp256k1 implementation against known vectors, then brute-forces 3,000 random
hashes per version byte to prove that mainnet addresses *always* start with `W`.

```bash
node pool/test/rewards.test.js
```
53 tests over the payout logic, including the one that matters most: the pool refuses to
distribute the consensus treasury output.

```bash
python3 scripts/patch_upstream.py --list
```
Every single change made to Bitcoin Core, with its rationale.

`install.sh` runs the first four automatically **before** it compiles anything.

---

## The numbers

| | |
|---|---|
| Maximum supply | **22,000,000 WAM** (hard-coded, unreachable by 0.022 WAM) |
| **Public mining** | **19,250,000 WAM — 87.50%** |
| Founder reserve | 2,000,000 WAM (9.09%) — **locked 5 years, on-chain, none of it liquid at launch** <!-- wam:quote-line --> |
| Operating budget | 750,000 WAM (3.41%) — 5% fee, **expires at block 400,000** |
| *Founder + operating* | *2,750,000 WAM — **12.50%*** |
| Initial subsidy | 50 WAM |
| Halving | every 200,000 blocks (~9.1 months) |
| Block time | 120 seconds |
| Launch | 2026-09-15 00:00 UTC |
| Emission ends | height 6,600,000 (~25.1 years) |
| Algorithm | RandomX (ASIC-resistant, CPU-friendly) |
| Difficulty | DarkGravityWave v3, retargeting every block |
| Addresses | start with `W` |

**Why 200,000 and not Bitcoin's 210,000?** Because `interval × subsidy × 2` must equal the
mining allocation exactly:

```
200,000 × 50 × 2 = 20,000,000 ✓        210,000 × 50 × 2 = 21,000,000 ✗ (cap would be 23M)
```

The interval was chosen to fit the cap, rather than the cap being quietly adjusted to fit a
borrowed constant.

**Where the 5% goes.** At epoch 0 a block pays the miner 47.5 WAM plus all transaction
fees, and the treasury 2.5 WAM. Total emission is unchanged, which is what keeps the
22,000,000 ceiling intact. Transaction fees are never shared.

**Both founder allocations are bounded by consensus, not by promise:**

<!-- wam:quote-begin -->
```
Founder reserve   2,000,000 WAM   5 tranches, NONE liquid at launch.
                                  Every one behind OP_CHECKLOCKTIMEVERIFY:
                                  2027-09-15 / 2028-09-15 / 2029-09-15 /
                                  2030-09-15 / 2031-09-15

Operating fee       750,000 WAM   5% of the subsidy for heights 1..400,000 only.
                                  From block 400,001 miners keep 100%.
                                  This is the operating money -- which is why
                                  the reserve does not need to be liquid.
```
<!-- wam:quote-end -->

The vesting locks are **bare CLTV scripts in the genesis block**, not P2SH — the unlock
date is readable straight out of block 0 (`wam-cli getblock <genesis> 2`), so the schedule
is verifiable rather than promised. `wam-cli getsupplyinfo` shows the locked/unlocked split
at any moment.

Total founder + operating allocation: **12.50%** of the cap, of which **none** is liquid on
launch day. The entire 2,000,000 reserve is time-locked until 2027 at the earliest, and the
operating fee has to be mined block by block like everyone else's coins. Stated here so
nobody has to assemble it from footnotes.

---

## Launching a real chain

Three steps cannot be automated, because each one is irreversible.

### 1. Generate the founder key — offline

```bash
python3 scripts/gen_founder_key.py --network mainnet
```

This key controls the entire premine and every future treasury payment. Run it on an
air-gapped machine. Write the WIF on paper. Never paste it into a chat, a ticket, a cloud
note, or this repository. Use multi-signature custody before real value accrues.

The script has **zero third-party dependencies** — secp256k1 is implemented in ~60 lines of
integer arithmetic so the whole trust surface is one file you can read.

### 2. Put the address into the chain parameters

```cpp
// src/wam/chainparams.cpp
static const std::string WAM_FOUNDER_ADDRESS_MAINNET = "W...";
```

The build refuses to produce a mainnet binary while the placeholder is present. This is
deliberate: a chain whose premine and treasury pay an invalid script would burn all
2,000,000 WAM of the reserve plus every treasury payment up to block 400,000, with no way
to undo it.

### 3. Mine the genesis block

```bash
python3 genesis/randomx_ffi.py          # verify librandomx first
python3 genesis/genesis_generator.py \
    --network mainnet --address W... --patch src/wam/chainparams.cpp
```

Roughly 1,048,576 RandomX hashes — about two minutes on eight cores in full-dataset mode.
The script writes `nNonce`, `hashGenesisBlock` and `hashMerkleRoot` straight into
`chainparams.cpp` and keeps a `.bak`.

Then re-run `./install.sh`.

---

## Running a node

```bash
wam-cli getblockchaininfo
wam-cli getsupplyinfo          # live supply vs. the cap, next halving
wam-cli getdevfeeinfo          # treasury parameters
wam-cli getdevfeeinfo "<hash>" # audit a specific block's treasury payment
wam-cli getrandomxinfo         # current key, blocks until rotation
wam-cli getemissionschedule    # the full halving table
```

Validation runs RandomX in light mode (~256 MiB). Set `randomxmining=1` only if the node
will also mine; that needs ~2.1 GiB more.

---

## Running the pool

```bash
cd pool
cp config.example.json config.json
$EDITOR config.json        # set poolAddress and the RPC password
npm install
npm run build:native       # compiles the RandomX addon
npm test
node server.js
```

Dashboard on `http://localhost:8080/`, stratum on 3333 / 3334 / 3335.

Miners authorize as `<W-address>.<worker>`:

```bash
xmrig -a rx/wam -o stratum+tcp://pool.example.org:3333 -u W....rig1 -p x
```

The pool refuses to start if `getblocktemplate` does not report a `devfee` field — an
unpatched daemon would make it build coinbases that consensus rejects, wasting every share
submitted to it.

---

## Requirements

**Node:** Ubuntu 22.04 or 24.04 LTS, 4 GB RAM (8 GB to mine), 20 GB disk, a 64-bit CPU with AES-NI.
**Pool:** Node.js ≥ 18, Redis, and a fully synced local `wamd` with `txindex=1`.

`install.sh` handles all of it on Ubuntu. For other distributions see `docs/BUILD.md` and
run with `--skip-deps`.

---

## Honest limitations

Read [§8 of the whitepaper](WHITEPAPER.md#8-threat-model-and-honest-limitations) before
putting anything at risk. In short: a young chain is cheap to attack regardless of its
difficulty algorithm; RandomX resists ASICs but not botnets; the founder allocation is
enforced by code but its *spending* is discretionary; the treasury address is a single
point of failure until it is multi-sig; and this fork must keep tracking upstream Bitcoin
Core security releases to stay safe.

---

## Licence

MIT. See [COPYING](COPYING).

Bitcoin Core is MIT-licensed. RandomX is BSD-3-Clause. Both retain their own copyrights.
