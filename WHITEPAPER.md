# WAM Coin

### A CPU-mineable proof-of-work currency with a hard 22,000,000 cap

**Version 1.0 — 2026**

---

## Abstract

WAM Coin is a proof-of-work cryptocurrency built on the Bitcoin Core codebase with four
deliberate departures: a hard supply ceiling of **22,000,000 WAM**, a **two-minute** block
target, **RandomX** proof of work so that ordinary CPUs remain competitive, and
**DarkGravityWave v3** difficulty retargeting on every block.

The founder and operating allocations are stated up front, separately, with their totals:

| Allocation | Amount | Share | Status |
|---|---:|---:|---|
| **Public mining** | 19,250,000 WAM | **87.50%** | issued to miners over ~25 years |
| Founder reserve | 2,000,000 WAM | 9.09% | genesis block, **locked 5 years, none liquid at launch** <!-- wam:quote-line --> |
| Operating budget | 750,000 WAM | 3.41% | 5% of subsidy, **ends at block 400,000** |
| *Founder + operating* | *2,750,000 WAM* | ***12.50%*** | — |

Both founder allocations are time-constrained by consensus, not by promise. The reserve is
locked behind `OP_CHECKLOCKTIMEVERIFY` in the genesis block itself, releasing 20% per year
across five tranches. The operating fee expires permanently at height 400,000 — roughly
eighteen months after launch — after which miners receive **100%** of every block subsidy.

Every number in this document is checkable. `scripts/verify_supply.py` reads the constants
directly out of the consensus header and replays the entire emission schedule with exact
integer arithmetic. If the arithmetic in this whitepaper and the arithmetic in the shipped
binary ever disagree, that script fails.

> ### Before you read further
>
> **This coin may be worth nothing.** The overwhelming majority of new
> cryptocurrencies fail, and there is no reason to assume this one is different.
> **Nobody will buy it back from you** — the founder does not sell WAM and does
> not buy it. Treat anything you acquire as money you can afford to lose
> entirely. Section 9 says the rest.

---

## 1. Motivation

Two failure modes dominate small proof-of-work launches.

**The first is mining centralisation on day one.** A chain that uses SHA-256 or Scrypt is
mineable by hardware that already exists in warehouses. Within days of launch a handful of
operators control the majority of the hash rate, and the "community mining phase" that the
launch announcement promised never actually happens. WAM uses RandomX, which is optimised
for the general-purpose CPU pipeline and is deliberately hostile to fixed-function silicon.
A laptop is a legitimate mining device on WAM.

**The second is a difficulty algorithm that cannot survive its own launch.** Bitcoin
retargets every 2,016 blocks. On a young chain with almost no hash rate, a rented gigahash
farm can mine weeks of blocks in an hour, trigger an enormous difficulty increase, and then
leave — freezing the chain at a difficulty nobody remaining can reach. Chains have died
this way. WAM retargets on *every* block using DarkGravityWave v3, which absorbs a
hundred-fold hash rate spike within roughly half an hour and recovers from its departure
just as quickly.

A third concern is honesty about the founder allocation. Many projects fund development
through opaque mechanisms — an unannounced premine, a "foundation wallet" of unclear
provenance, or a fee that can be silently turned off. WAM states both mechanisms up front,
fixes them in consensus code, and makes both auditable from any node with a single RPC
call.

---

## 2. Monetary policy

### 2.1 The supply identity

For a Bitcoin-style halving schedule, the total ever mined converges to:

```
total = halving_interval × initial_subsidy × 2
```

WAM chooses the parameters so that this closes on a round number:

```
200,000 blocks × 50 WAM × 2 = 20,000,000 WAM
```

Adding the genesis premine:

| What the coinbase creates | Amount | Of which goes to | |
|---|---:|---|---:|
| Genesis premine (block 0) | 2,000,000 WAM | founder reserve, locked 5 years | 2,000,000 |
| Mined emission (blocks 1 →) | 20,000,000 WAM | **miners** | **19,250,000** |
| | | operating treasury (blocks 1–400,000) | 750,000 |
| **Absolute maximum supply** | **22,000,000 WAM** | | |

Two different questions have two different answers, and both are stated here so neither can
be quoted out of context:

- **What does the coinbase create?** 2,000,000 premine + 20,000,000 mined = 22,000,000.
- **Who ends up holding it?** Miners 19,250,000 (**87.50%**), founder reserve 2,000,000
  (9.09%), operating treasury 750,000 (3.41%).

The 20,000,000 figure is an *emission* number; the 19,250,000 figure is a *destination*
number. The difference between them is the 750,000 WAM treasury fee, which stops entirely
at block 400,000 (§3.2).

This is why the halving interval is 200,000 blocks and not Bitcoin's 210,000. At 210,000
the emission would be 21,000,000 WAM, which together with the premine would be 23,000,000
— a million over the stated cap. The interval was chosen to fit the cap, rather than the
cap being quietly adjusted to fit a borrowed constant.

Because the subsidy halves by integer right-shift, the true terminal supply is
**21,999,999.978 WAM** — about 0.022 WAM below the ceiling, lost to truncation. `MAX_MONEY`
is therefore a strict upper bound that is approached but never reached, exactly as in
Bitcoin.

### 2.2 Parameters

| Parameter | Value |
|---|---|
| Ticker | WAM |
| Base unit | 1 WAM = 100,000,000 watoshi (8 decimals) |
| Maximum supply | 22,000,000 WAM (hard-coded) |
| Genesis premine | 2,000,000 WAM |
| Initial block subsidy | 50 WAM |
| Halving interval | 200,000 blocks (~9.1 months) |
| Block target | 120 seconds |
| Blocks per day | 720 |
| Launch date | 2026-09-15 00:00 UTC |
| Operating fee | 5% of the block subsidy, heights 1–400,000 only |
| Founder reserve vesting | 5 tranches, 20% per year, 2027-09-15 to 2031-09-15 |
| Coinbase maturity | 100 blocks (~3.3 hours) |
| Emission ends | height 6,600,000 (~25.1 years) |
| Proof of work | RandomX |
| Difficulty algorithm | DarkGravityWave v3, every block |
| Address prefix | `W` (mainnet P2PKH) |

### 2.3 Emission schedule

| Epoch | Heights | Subsidy | Epoch total | Cumulative supply |
|---:|---|---:|---:|---:|
| — | 0 (genesis) | 2,000,000 | 2,000,000 | 2,000,000 |
| 0 | 1 – 200,000 | 50 | 10,000,000 | 12,000,000 |
| 1 | 200,001 – 400,000 | 25 | 5,000,000 | 17,000,000 |
| 2 | 400,001 – 600,000 | 12.5 | 2,500,000 | 19,500,000 |
| 3 | 600,001 – 800,000 | 6.25 | 1,250,000 | 20,750,000 |
| 4 | 800,001 – 1,000,000 | 3.125 | 625,000 | 21,375,000 |
| 5 | 1,000,001 – 1,200,000 | 1.5625 | 312,500 | 21,687,500 |
| 6 | 1,200,001 – 1,400,000 | 0.78125 | 156,250 | 21,843,750 |
| … | … | … | … | … |
| 32 | 6,400,001 – 6,600,000 | 0.00000001 | 0.002 | 21,999,999.978 |
| 33+ | 6,600,001 → | 0 | 0 | 21,999,999.978 |

Over half the entire supply (12,000,000 WAM) exists after the first epoch. This is a
deliberate front-load: a chain needs its security budget early, when it is most vulnerable,
not in year twenty.

After height 6,600,000 the subsidy is exactly zero and miners are compensated entirely by
transaction fees.

Run `python3 scripts/verify_supply.py --schedule` to print this table from the actual
consensus constants, or `wam-cli getemissionschedule` to get it from a running node.

---

## 3. The operating budget (5% fee)

### 3.1 Mechanism

Five percent of every block subsidy is paid to a fixed treasury address through an output
in the coinbase transaction. At epoch 0:

```
block subsidy      50.0 WAM
  ├─ miner         47.5 WAM   + all transaction fees
  └─ treasury       2.5 WAM
```

**The fee is carved out of the subsidy, not added to it.** This distinction is the reason
the 22,000,000 cap survives. A fee added on top would raise the real emission to 21,000,000
WAM of mining issuance and break the ceiling; carving it out leaves total emission exactly
unchanged.

**Transaction fees are never touched.** They belong entirely to the miner. Sharing fee
revenue with a treasury would distort the fee market, and there is no good reason to do it.

### 3.2 It expires — consensus rule, not a promise

The fee applies to heights **1 through 400,000** and to no height after that. From block
400,001 the treasury receives nothing and miners keep 100% of the subsidy plus 100% of
fees. The expiry is a constant in the consensus code (`WAM_DEVFEE_LAST_HEIGHT`), so
extending it would require a hard fork that every node operator would have to install.

| Period | Heights | Subsidy | To miner | To treasury | Treasury total |
|---|---|---:|---:|---:|---:|
| Epoch 0 | 1 – 200,000 | 50 WAM | 47.5 | 2.5 | 500,000 WAM |
| Epoch 1 | 200,001 – 400,000 | 25 WAM | 23.75 | 1.25 | 250,000 WAM |
| **Epoch 2 onward** | **400,001 →** | 12.5 → 0 | **100%** | **0** | **0** |
| | | | | **Lifetime** | **750,000 WAM** |

At 120 seconds per block, the window is roughly **18.3 months**.

Two things follow from the halving schedule that are worth stating plainly:

- The fee is heavily front-loaded. Epoch 0 alone yields 500,000 of the 750,000 WAM — two
  thirds of the lifetime total arrives in the first nine months, which is when a new chain
  actually needs funding.
- Extending the window would have yielded little. A third epoch would have added only
  125,000 WAM while converting a bounded commitment into an open-ended one.

**Why a sunset at all.** A permanent 5% is economically small but reads to a miner as a
tax without end. The same money collected inside a fixed, published window reads as launch
funding. The amounts barely differ; the incentive story does. WAM's RandomX audience is the
Monero audience — a community with zero premine and zero dev fee — and that is precisely
the audience for whom "forever" is the objectionable word.

**What it funds.** Exchange listings, an independent security audit, seed-node and explorer
infrastructure, legal and entity costs, and development. Unlocked and flowing from block 1
at roughly **1,800 WAM per day**, which is why the founder reserve does not need to be
liquid (§3.5).

### 3.3 Enforcement

The fee is not a convention that mining software is asked to respect. It is consensus rule
**WAM-1**, implemented in `src/wam/consensus/devfee.cpp` and checked when every block is
connected:

> For every block at height between 1 and 400,000 inclusive, the coinbase transaction MUST
> contain at least one output whose `scriptPubKey` is exactly the treasury script and whose
> value is at least 5% of the block subsidy. A block that fails this is rejected with
> `bad-cb-devfee-amount`. Outside that height range the rule imposes nothing.

A miner who omits or reduces the output produces a block that no node will accept. Paying
*more* than the required amount is allowed, so that pools which merge outputs, and anyone
who wishes to donate, are not penalised.

Once the subsidy has decayed so far that 5% truncates to zero base units (epoch 26 onward),
the rule stops requiring an output rather than demanding a zero-value one that would only
bloat the UTXO set.

Anyone can audit any block:

```bash
wam-cli getdevfeeinfo "<blockhash>"
```

which reports the required amount, the amount actually paid, and a `compliant` boolean.

### 3.4 The treasury address

The address is compiled into `chainparams.cpp` and cannot be changed without a hard fork
that every node operator would have to consent to. It is generated offline by
`scripts/gen_founder_key.py`, a dependency-free script whose entire trust surface is one
auditable file, and the corresponding private key never appears in the repository, in a
build log, or on a networked machine.

---

### 3.5 The founder reserve, and why it is locked

The 2,000,000 WAM minted in the genesis block is **not paid to a single output.** It is
split into five equal tranches inside the genesis coinbase, **every one of which** is locked
behind `OP_CHECKLOCKTIMEVERIFY` until an exact calendar date:

| Tranche | Amount | Unlocks | Cumulative | % of reserve |
|---:|---:|---|---:|---:|
| 1 | 400,000 WAM | 2027-09-15 | 400,000 | 20% |
| 2 | 400,000 WAM | 2028-09-15 | 800,000 | 40% |
| 3 | 400,000 WAM | 2029-09-15 | 1,200,000 | 60% |
| 4 | 400,000 WAM | 2030-09-15 | 1,600,000 | 80% |
| 5 | 400,000 WAM | 2031-09-15 | 2,000,000 | 100% |

Nothing in the reserve is spendable on launch day, and nothing in it is spendable during the
first year of the chain.

All five are additionally subject to the ordinary 100-block coinbase maturity.

**This is verifiable from block 0, not from this document.** The lock scripts are written
*bare*, not wrapped in P2SH. A P2SH output would publish only a hash and a reader would
have to trust a separately distributed redeem script; bare, the unlock timestamp sits in
the `scriptPubKey` itself, where `wam-cli getblock <genesis> 2` prints it in plain sight.
`wam-cli getsupplyinfo` reports the locked/unlocked split at any moment.

**The locks are timestamp-based, not height-based.** A height-based lock of "262,980
blocks" only equals one year if the chain sustains exactly 120 seconds per block forever;
if hash rate falls, a four-year commitment silently becomes five. Timestamps are what the
public will hold this schedule to, so timestamps are what consensus enforces.

**Why none of it is liquid at launch.** An earlier version of this schedule released the <!-- wam:quote-line -->
first tranche at genesis, and justified it as working capital for listings, audits and
infrastructure. That justification did not survive the paragraph after it: the operating fee
(§3.2) already delivers ~1,800 WAM per day, unlocked from block 1, and *that* is what pays
for operations. The reserve was never needed for it.

So the only thing an unlocked tranche bought was 400,000 WAM the founder could sell on day
one into a market with no depth — which is precisely the fear a premine creates, granted
voluntarily, for no benefit. Removing it costs nothing: the same coins arrive twelve months
later, and the operating fee covers the interval. The reserve is strategic and held long,
and now the chain enforces that rather than asking anyone to believe it.

**Why locking matters more than the size of the number.** The fear a premine creates is not
"the founder owns 9%" — it is "the founder can sell 9% into a thin market tomorrow." A
vesting schedule enforced by script addresses that fear directly, and costs the founder
nothing in coins. It is the cheapest credibility available.

### 3.6 The founder allocation in total

Stated plainly, in one place, so that nobody has to assemble it from footnotes:

| Source | Amount | Share of cap | Constraint |
|---|---:|---:|---|
| Founder reserve (genesis) | 2,000,000 WAM | 9.09% | locked 5 years, on-chain |
| Operating fee (blocks 1–400,000) | 750,000 WAM | 3.41% | expires by consensus |
| **Founder + operating total** | **2,750,000 WAM** | **12.50%** | — |
| **Public mining** | **19,250,000 WAM** | **87.50%** | — |

Twelve and a half percent. Of that, **none** is liquid on launch day: the entire 2,000,000 <!-- wam:quote-line -->
reserve is time-locked until 2027 at the earliest, and the operating fee has to be mined
block by block on the same schedule as everyone else's coins.

For comparison, and without claiming that comparison is a justification: Zcash allocated
20% to founders for four years, Dash directs 10% to a treasury permanently, and Decred
premined 8%. Monero and Litecoin allocated nothing — and Monero, being the RandomX chain,
is the comparison WAM's miners are most likely to reach for. That is a fair criticism to
make, and it is why both WAM allocations are bounded rather than perpetual.

---

## 4. Proof of work

### 4.1 Why RandomX

RandomX generates a random program from a key and executes it in a virtual machine against
the input. The program uses the same instruction mix as general-purpose code — integer and
floating-point arithmetic, branches, and a 2 GiB working set with random access patterns.
A fixed-function ASIC has no advantage over a CPU here, because the thing being accelerated
is "being a CPU."

The practical consequence for WAM is that a laptop, a desktop, and a rented cloud instance
are all viable mining devices from block 1. There is no window during which specialised
hardware exists and ordinary participants are excluded.

RandomX is not novel or experimental. It has secured Monero since 2019 and has been
extensively cryptanalysed.

### 4.2 Integration into a Bitcoin-style header

WAM keeps Bitcoin's 80-byte block header and its double-SHA256 **block identifier**. Only
the proof-of-work comparison changes: the value tested against the target is
`RandomX(seed, header)` rather than `SHA256d(header)`.

This separation matters. Block hashes, transaction IDs, the block index, and every RPC that
reports a hash behave exactly as in Bitcoin. Only one comparison in `CheckProofOfWork` is
different.

### 4.3 Key rotation

RandomX requires a key that all participants agree on. WAM derives it from a buried block:

```
seed_height = floor((height − 64) / 2048) × 2048
key         = block_hash(seed_height)
```

- **Epoch length: 2,048 blocks** (~2.8 days). Rotation forces every miner to rebuild the
  2 GiB dataset, which keeps the algorithm hostile to hardware built around a fixed key.
- **Lag: 64 blocks** (~2.1 hours). By the time a height becomes a seed it is buried deeply
  enough that no realistic reorganisation can change it, so no miner ever discards a
  dataset because of a reorg.

**The bootstrap epoch.** Seeding the first epoch from the genesis hash would be circular:
mining the genesis block requires a key, and that key would require the hash mining is
trying to produce. Epoch 0 is therefore keyed by `SHA256("WAM/RandomX/epoch-0/2026")`, a
fixed constant. Every later epoch uses a real block hash.

Validating nodes run RandomX in light mode (~256 MiB); miners use the full dataset (~2.1
GiB) for roughly eight times the hash rate. Both produce identical results.

`wam-cli getrandomxinfo` reports the current seed and how many blocks remain before the
next rotation.

### 4.4 DarkGravityWave v3

Difficulty is recalculated on **every block** from a weighted average of the last 24 block
targets, rescaled by the observed elapsed time against the expected 48 minutes. The
observed timespan is clamped to between one third and three times the expected value, so
that a miner manipulating timestamps within the network's tolerance cannot move difficulty
by more than 3× in a single step.

The result is a chain that responds to hash rate changes in tens of minutes rather than
weeks — which is the difference between surviving a flash-mining attack and being abandoned
because of one.

---

## 5. Network

| Parameter | Mainnet | Testnet |
|---|---|---|
| P2P port | 9555 | 19555 |
| RPC port | 9554 | 19554 |
| Message prefix | `WAM!` | `wam!` |
| P2PKH prefix | `73` → addresses start with `W` | `65` → `T` |
| P2SH prefix | `135` → `w` | `128` → `t` |
| WIF prefix | `190` → `V` | `239` → `c` |
| Bech32 HRP | `wam` | `twam` |

The version bytes were selected by brute force, not by guesswork: for each candidate,
thousands of random hashes were encoded and the leading base58 character was required to be
identical every time. Values such as 72 and 74 were rejected precisely because they straddle
a digit boundary and would produce addresses beginning with either `V` or `W` depending on
the key. `scripts/gen_founder_key.py --selftest` re-verifies this on every install.

WAM launches with BIP34, BIP65, BIP66, CSV, SegWit and Taproot active from height 1. There
is no legacy chain to remain compatible with, and dormant activation machinery is where
consensus bugs hide.

---

## 6. Genesis block

The genesis coinbase commits the launch phrase:

> `WAM Network Launching Next Generation Decentralized Economy 2026`

Because the phrase is inside the coinbase, it is inside the merkle root, and therefore
inside the genesis hash. It is unforgeable proof that the chain was not created before the
phrase existed.

The outputs pay 2,000,000 WAM to the founder address across the five vesting tranches
described in §3.5 — one liquid, four time-locked.

**One consensus change is required for this to work.** Stock Bitcoin Core never adds the
genesis coinbase to the UTXO set — this is why Satoshi's original 50 BTC are unspendable.
WAM patches `ConnectBlock` to add it (change **WAM-005**), because otherwise the entire
2,000,000 WAM premine would be burned at launch. The output remains subject to normal
coinbase maturity.

The genesis block is mined by `genesis/genesis_generator.py`, whose serialization is
verified byte-for-byte by reproducing Bitcoin's real genesis block hash
(`000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f`) using the same code
path. If those bytes were wrong, that reproduction would fail.

---

## 7. Mining and pools

The reference stratum pool implements both **PPLNS** (default) and **PROP**.

PROP splits each block among the shares submitted since the previous block. It is intuitive
but rewards pool hopping: a miner who mines only the early part of each round earns more
than their fair share, paid for by everyone else.

PPLNS splits each block among the last *N* units of difficulty submitted, regardless of
round boundaries, with *N* = 2 × network difficulty by default. Leaving the pool means
forfeiting a share of every block found before your work ages out, which removes the
incentive to hop.

The pool distributes the coinbase value **minus the consensus treasury output**. The
treasury amount is reported by the patched daemon in `getblocktemplate`, so the pool copies
one number rather than reimplementing the halving schedule in a second language and being
wrong about it at some future halving. Handing the raw coinbase value to the reward
calculator throws an exception rather than silently over-distributing by 5%.

The pool operator's own fee, if any, is taken *after* the treasury output and is entirely
separate from it: a miner on a pool sees the consensus 5% plus whatever that operator
charges. The 5% is a consensus rule and is stated here. An operator's rate is a setting
they can change, so it is not stated here — each pool publishes its own.

---

## 8. Threat model and honest limitations

**A young chain is cheap to attack.** WAM's security budget at launch is small in absolute
terms, and no difficulty algorithm changes that. DGW v3 makes the chain *survivable* under
hash rate volatility; it does not make a 51% attack expensive. Exchanges and merchants
should require deep confirmations during the first months, and the project should publish
a chain-work checkpoint policy rather than pretending the risk is absent.

**RandomX resists ASICs; it does not resist botnets.** CPU mining is accessible to
everyone, which includes people running code on machines they do not own. This is a known
and unavoidable trade-off of the CPU-friendly design, and it should be stated rather than
glossed over.

**The founder allocation is 12.50%, and how it is spent is discretionary.** The amounts,
the vesting schedule and the fee's expiry are enforced by code. The *use* of those funds is
not, and cannot be — no consensus rule can compel a particular expenditure. Holders should
evaluate the team, not only the protocol.

**Vesting constrains selling, not everything.** All five tranches are locked and cannot move
before their dates, and that is enforced by script rather than promised. But the operating
fee accrues unlocked from block 1, and nothing prevents borrowing against locked coins
off-chain, or selling a claim on them. Vesting is a real constraint, not a complete one.

**The treasury address is a single point of failure.** If its private key is lost, the
premine and all future fee income are permanently unspendable — and the time-locked
tranches would be lost with it. If it is stolen, they are gone. Multi-signature custody is
strongly advisable before any significant value accrues.

**Inherited risk.** WAM is a fork of Bitcoin Core v28. It inherits that codebase's security
properties and any vulnerabilities discovered in it. Upstream security releases must be
tracked and rebased; a fork that stops merging upstream fixes becomes dangerous over time.

**No checkpoints ship at launch.** `nMinimumChainWork` and `defaultAssumeValid` are empty
because inventing values before any work exists would be theatre. They should be populated
in a release once the chain has real accumulated work.

---

## 9. What can go wrong for you

Section 8 is about what can go wrong with the chain. This is about what can go wrong for a
person who ends up holding WAM.

**It may be worth nothing.** The overwhelming majority of new cryptocurrencies fail. There is
no guarantee that anyone will want to buy WAM, use it, or list it anywhere. Nothing in this
document is a prediction, and no figure in it is a price.

**Nobody will buy it back.** The founder does not sell WAM and does not buy it. There is no
buyback, no market maker, no price floor and no reserve standing behind it. If a price exists
it is whatever two strangers agree on, and it can be zero.

**A secondary market is outside anyone's control.** If you buy WAM from a miner or another
holder and the price then falls, the loss is yours. The project makes no representation about
price, at any time, to anyone.

**Mining costs electricity and may never repay it.** A block reward is worth whatever WAM is
worth, which may be nothing at all. Do not mine with power you cannot afford to spend for its
own sake.

**Lose your key and the coins are gone.** There is no recovery, no reset and no support desk.
This is true of every chain built this way, Bitcoin included, and it is not a defect — it is
the same property that means nobody can take your coins either.

These are not formalities. They are written here because the founder makes no public
statements, promises no return, and will not be available to warn anyone individually. The
warning has to live in the document, or it does not exist.

---

## 10. Verifying these claims

Nothing in this document asks for trust. Each claim has a corresponding check:

| Claim | How to verify |
|---|---|
| 22,000,000 hard cap | `python3 scripts/verify_supply.py` |
| Founder total is 12.50% | `python3 scripts/verify_supply.py` (section 4) |
| The reserve really is locked 5 years, with nothing liquid at launch | `python3 scripts/verify_supply.py` (section 4b) <!-- wam:quote-line --> |
| The fee really does expire at 400,000 | `python3 scripts/verify_supply.py` (section 4) |
| Vesting scripts are bare CLTV, not P2SH | `python3 genesis/test_serialization.py` |
| Live locked/unlocked split | `wam-cli getsupplyinfo` |
| Full emission schedule | `python3 scripts/verify_supply.py --schedule` |
| The 5% is enforced, not conventional | `src/wam/test/wam_devfee_tests.cpp` |
| Genesis serialization is byte-exact | `python3 genesis/test_serialization.py` |
| Address prefixes are stable | `python3 scripts/gen_founder_key.py --selftest` |
| Pool never distributes the treasury | `node pool/test/rewards.test.js` |
| Every upstream change is auditable | `python3 scripts/patch_upstream.py --list` |
| Live supply on a running node | `wam-cli getsupplyinfo` |
| A specific block paid the treasury | `wam-cli getdevfeeinfo "<hash>"` |

`install.sh` runs the first four of these *before* it compiles anything. If the arithmetic
does not hold, there is no point building the binary.

---

## 11. References

1. S. Nakamoto, *Bitcoin: A Peer-to-Peer Electronic Cash System*, 2008.
2. tevador, *RandomX: proof of work algorithm based on random code execution*,
   `github.com/tevador/RandomX`.
3. E. Duffield, D. Diaz, *Dash: A Privacy-Centric Cryptocurrency* — DarkGravityWave.
4. Bitcoin Core, `github.com/bitcoin/bitcoin`, tag v28.1.

---

## Appendix A — Consensus changes from Bitcoin Core

Every departure from upstream, in the order applied. Run
`python3 scripts/patch_upstream.py --list` for the live list.

| ID | Change | Consensus? |
|---|---|---|
| WAM-000 | Install the WAM source tree and chain parameters | yes |
| WAM-001 | Add WAM fields to `Consensus::Params` | no (plumbing) |
| WAM-002 | `MAX_MONEY` = 22,000,000 WAM | **yes** |
| WAM-003 | `GetBlockSubsidy` → the WAM schedule | **yes** |
| WAM-004 | Enforce the 5% treasury output, heights 1–400,000 (rule WAM-1) | **yes** |
| WAM-005 | Make the genesis coinbase spendable (all five tranches) | **yes** |
| WAM-006 | RandomX PoW + DarkGravityWave v3 | **yes** |
| WAM-007 | Report the treasury amount in `getblocktemplate` | no (RPC) |
| WAM-008 | Rename binaries to `wamd` / `wam-cli` | no (packaging) |

---

*This document describes software. It is not investment advice, not an offer, and not a
promise of value. Proof-of-work mining consumes electricity and may be regulated where you
live. Read the code.*
