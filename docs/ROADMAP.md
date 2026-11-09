# WAM Coin — roadmap from repository to living network

**Read this first, honestly:** the code is the easy part, and it is already mostly done.
Almost every proof-of-work launch that fails does so for reasons no amount of C++ fixes.
This document is organised around that fact — the technical phases are short, and the
phases about people, liquidity and trust are long.

Nobody can plan a coin into market leadership, and this document does not pretend to. What
a plan *can* do is remove the failure modes that are within your control, and there are
more of those than most projects admit.

---

## Phase 0 — make it compile *(blocking everything; 1–2 weeks)*

Nothing below matters until this is done. **2,792 lines of C++ have never seen a
compiler.**

| # | Task | Gate |
|---|---|---|
| 0.1 | Provision Ubuntu 22.04 or 24.04, 8 GB RAM, 40 GB disk | `ssh` works |
| 0.2 | `./install.sh --network regtest` | binaries exist |
| 0.3 | **Fix the patch anchors** (expect 2–5 misses of 12) | patcher runs clean |
| 0.4 | Link librandomx, resolve compile errors in `src/wam/` | `make` succeeds |
| 0.5 | `test_bitcoin --run_test='wam_*'` | all green |
| 0.6 | `wamd -regtest` starts, `getsupplyinfo` answers | node alive |

**Exit gate:** a regtest node that mines blocks and reports a correct supply.

> Step 0.3 is the real work. See PROGRESS.md — never loosen an anchor to make it apply.

---

## Phase 1 — prove the four dangerous claims *(1 week)*

These are the four things that are **unfixable after mainnet launch**. Each must be
observed failing and succeeding, not assumed.

| Claim | How to prove it |
|---|---|
| The premine is spendable at all | Spend tranche 1 on regtest after 100 confirmations. If change WAM-005 did not apply, the entire 2,000,000 is burned — and you find out here or never. |
| The vesting locks actually lock | Attempt to spend tranche 2. The node must refuse. **A lock you have not seen refuse a spend is a lock you do not have.** |
| The 5% is enforced, not requested | Hand-craft a block with no treasury output. The node must reject it with `bad-cb-devfee-amount`. |
| The fee really expires | On a throwaway chain with a lowered `WAM_DEVFEE_LAST_HEIGHT`, mine past it and confirm a block with no treasury output is *accepted*. |

**Exit gate:** all four demonstrated, with terminal output saved.

---

## Phase 2 — testnet *(4–6 weeks, do not compress this)*

| # | Task | Why |
|---|---|---|
| 2.1 | Generate a **testnet** founder key, mine testnet genesis | rehearse the mainnet ritual with nothing at stake |
| 2.2 | Run 3 nodes on 3 different providers | proves P2P actually works between strangers |
| 2.3 | Point a real CPU miner (xmrig) at the stratum pool | **the stratum has never met a miner** |
| 2.4 | Run a full pool payment cycle end to end | share → block → maturity → `sendmany` |
| 2.5 | Simulate an orphaned block | confirm nobody is paid for it |
| 2.6 | **Cross at least two RandomX epoch rotations** | testnet epochs are 256 blocks (~8h) for exactly this |
| 2.7 | ~~Point extra hashrate at it for an hour, then remove it~~ **Done 5 September**, by the founder and Sparks60 on three machines: difficulty 1.00 → 6.26, the block after they stopped took 35 minutes, back at the floor 79 minutes later. Heights 5586–5620. Larger multiples were computed instead, against a model checked on 8,838 real blocks — see `docs/REHEARSALS.md` | proves DGWv3 absorbs and recovers — it did, unattended |
| 2.8 | ~~Write functional tests for the WAM rules~~ **written 11 August** — `feature_wam_devfee.py`, `feature_wam_genesis.py`, `feature_wam_pow.py`, `feature_wam_randomx_epoch.py`: 627 lines, 80 assertions, installed into the tree by `patch_upstream.py`. **Never executed here**, and said plainly rather than ticked: running them needs a configured Core build tree, which exists only inside CI, and CI builds releases rather than running the suite. See `docs/REHEARSALS.md` for what covers these rules instead | regressions are invisible without them |

**Exit gate:** two uninterrupted weeks, ≥2 epoch rotations, zero forks, zero payment
discrepancies.

> A shortened testnet is the most common cause of a dead mainnet. Nothing on this list is
> optional.

---

## Phase 3 — infrastructure & the things money cannot fix later *(parallel with Phase 2)*

| # | Task | Note |
|---|---|---|
| 3.1 | Register `wamcoin.org` | it is hardcoded in `chainparams.cpp` and does not exist |
| 3.2 | Stand up 3 DNS seed nodes on **3 different ASNs** | one provider = one partition away from a dead network |
| 3.3 | Register a SLIP-44 coin type | needed before any hardware wallet will ever support you |
| 3.4 | **Independent security audit of the WAM diff** | ~2,800 lines; this is affordable and it is the single strongest trust signal a small chain can buy |
| 3.5 | **Legal review in your jurisdiction** | issuing a token has real regulatory exposure; exchanges will ask, and "we didn't check" ends listings |
| 3.6 | Multi-sig custody for the treasury | a single key holding 12.50% is a standing liability |
| 3.7 | Reproducible builds + signed release binaries | users must not have to trust your laptop |
| 3.8 | Public block explorer (fuller than `explorer/`) | the current one is a monitor, not a full explorer |

---

## Phase 4 — launch *(the day itself)*

Work `docs/LAUNCH_CHECKLIST.md` top to bottom. Do not skip Phase 5 of it — spending the
premine on a private chain — even though by then you will be sure it works.

Announce the genesis hash, merkle root, treasury address and vesting schedule **before**
the first block, so anyone can verify what they were promised against what shipped.

---

## After the night — the three machines as adoption grows

Written on 13 September, two days before launch, because the founder asked
the right question about a memory fix: *does this push the danger a few days
away and bring it back when more people run nodes?*

The honest answer is that a systemd limit does not stop the machine being
**asked** for more work. Two things on a seed grow with the number of people
running nodes, and neither is bounded by memory policy:

- **Connections.** These are DNS seeds. Every new node's first connection
  attempt arrives at one of them, so inbound pressure scales with the network
  rather than with us.
- **The mempool they relay.** Bitcoin Core's default is 300 MB, chosen for a
  desktop, and it was the default on a host with 1914 MB.

`scripts/apply_host_limits.sh` sizes both to the machine — 39 peers and a
100 MB mempool on Singapore, 110 and 300 MB on the two roomy hosts — so the
smallest host now carries about a seventh of our connection capacity, which
is the share it can actually serve. That is a real division of load and not a
patch. What it is **not** is a promise that 1914 MB is enough forever.

### The division of roles that holds while the network grows

| host | memory | what it does | what it must never do |
|---|---|---|---|
| Germany, Contabo | 12 GB | pool, explorer, announcer, Electrum #1, node | — |
| US-east, Contabo | 8 GB | node, **Electrum #2** — `electrum2.wamcoin.org` since 13 Sep | — |
| Singapore, Hetzner | 1.9 GB | **seed node only**, since 13 Sep | serve wallets |

### Done 13 September, and the founder was right about when

I argued for moving the second published Electrum endpoint off the smallest
host **after** launch: a published endpoint that changes the day before is
one that can be broken on the day, and the Komodo review names
`electrum2.wamcoin.org:50002` explicitly.

He argued the opposite and the argument is better. **Today that endpoint
serves testnet only** — the mainnet ports are deliberately empty until
launch. So a mistake today breaks a test network with 45 hours left to fix
it; the same mistake next week breaks a live wallet server that real people
and a reviewer depend on. Same work, a tenth of the risk, and the risk falls
on the half that does not matter.

It was done in an order that was reversible at every step:

```
cert copied to US-east            invisible outside
ElectrumX installed, both nets    invisible outside
testnet instance started          indexed 9,040 blocks in 4 seconds, 2.8 MB
knocked from the laptop           51001/51002/51004 all open
electrum2 -> US-east in DNS       both hosts served at once, TTL 600
verified by name                  certificate verified, chain and height right
Singapore disabled                a seed node and nothing else
```

The founder added the new A record rather than replacing it, which made the
name resolve to both machines for a few minutes — and that turned out to be
the best possible intermediate state: every wallet was served by one host or
the other throughout, and there was no moment when the answer was nothing.

Singapore keeps its ElectrumX files and its 3.2 MB index for a week. Going
back is one `systemctl enable` and one DNS row.

### The macOS witness, decided 13 September

We publish an Apple Silicon build that no human being has ever used. It is
compiled on an Apple runner and it syncs the chain from genesis there before
the archive may be published, so it is not untested — but CI is not a person,
and nobody on this project owns a Mac.

The founder's decision: **ask the people who own one, after launch.** Not a
purchase, and not a CI step bought at the cost of touching the build during a
freeze. `docs/MINE.md` now says plainly that no person has run it and asks
whoever does to report back, which is also the cheapest way to gain something
we cannot buy — a witness on a platform we do not own.

The measurement it would replace is narrow and worth naming so it is not
mistaken for the whole question: `check_isa_baseline.sh` cannot ask its
question of an arm64 binary at all, because AVX-512 does not exist on ARM.
It reports "does not apply" and exits 2, and our convention prints that as
could-not-ask rather than a pass. On a Mac, or with `OBJDUMP=llvm-objdump` on
the macOS runner, the arm64 equivalent of that question could be asked. It
has not been, and that is a decision rather than an impossibility.

### When to spend money, measured rather than felt

An upgrade or a fourth machine is the answer when the numbers say so, and
these are the numbers:

```
available memory on Singapore stays under   300 MB
swap in use there stays over                200 MB
the mainnet node's RSS approaches           783 MB   (its MemoryHigh)
```

The operations dashboard already shows memory and swap per host, and prints
`none` in amber where there is no swap at all. The day those three lines go
yellow and stay yellow is the day the decision is made — not before, and not
on a feeling that a small machine looks small.

**What measuring first already saved:** the plan an hour earlier was to move
ElectrumX off that host immediately, on the assumption it wanted 300–500 MB.
It uses **50 MB**, and its database is 3.2 MB. The whole launch-night load
there is about 1.2 GB of 1914. The problem was never the amount of memory —
it was that `MemoryMax=2G` on a 1914 MB machine bounded nothing, so the
kernel would have chosen what to kill, by size, and the largest process on
that host is the node itself.

---

## Phase 5 — the part that actually decides whether WAM survives

Everything above is engineering, and engineering is the part you control. What follows is
not a guarantee of anything. It is the honest list of what separates chains that are alive
in three years from the thousands that are not.

### 0. Value does not arrive before the hashrate that defends it

Decided by the founder on 6 September 2026, against an earlier idea of his own:
giving WAM a price from day one by accepting it across the companies he owns.

He worked out why not, and he is right. A proof-of-work chain's entire security
budget is its hashrate. An attacker performs one calculation -- does what I gain
exceed what it costs to out-hash the network -- and value arrives instantly
while hashrate arrives slowly. In between there is a window where the coin is
worth taking and not worth defending, and that window is where small chains
die. Not theory: it is how most 51% attacks on small coins have happened, and
nearly all of them followed a listing.

Measured on the day the decision was made:

<!-- wam:quote-begin -->
    the whole test network      5,446 - 6,089 H/s
    one ordinary desktop        8,740 H/s  (8 threads, measured)
<!-- wam:quote-end -->

The network is weaker than a single desktop computer. Out-hashing it for six
hours costs less than ten dollars of rented CPU. That is not a defect and it is
not unusual -- it is what every chain looks like on its first day. It becomes a
defect only if something valuable is put behind it first.

So: no manufactured demand, no company acceptance, no artificial price, until
the cost of attacking the chain is large next to whatever is being placed on
it. The rule is a comparison and not a feeling --

  **what we put on the chain stays below what an attack on it costs**

-- and it is meant to be checked with a number before any decision to widen
use, not argued about afterwards.

What holds the line meanwhile is confirmation depth. A reorg 60 blocks deep
costs sixty times a reorg one block deep, which is why the published guidance
sets the depth by the amount rather than by the kind of payment: 3
confirmations between two people for a small amount, 20 for an ordinary one,
60 for an exchange deposit, 100 above a few thousand WAM. The exchange figure
is the high one because an exchange is where value leaves this chain and
stops being reversible.

Value earned by mining brings its own defence with it. Value granted by us
arrives alone.

### 1. Answer "why does this exist?" in one sentence — and mean it

Right now WAM's differentiators are: a hard 22M cap, CPU-mineable, 2-minute blocks, and a
founder allocation that is bounded and verifiable. **That is a positioning, not yet a
reason to exist.** Monero already owns "CPU-mineable"; Bitcoin owns "hard cap".

The strongest honest angle available to you is the one already built into the code:
**every promise is machine-checkable.** The vesting is in the genesis script, not a PDF.
The fee expiry is a consensus rule, not a pledge. Very few projects can say that, and it
is provable rather than claimed. Lead with it.

If you cannot articulate a use case beyond "it is a coin", the launch will be technically
perfect and commercially irrelevant. That question deserves more of your time than any
remaining line of C++.

### 2. Miners before speculators

A chain with no hashrate is not a chain. Before launch, have **specific people** committed
to pointing CPUs at it on day one — not an audience, individuals you have spoken to. Ten
committed miners beat ten thousand impressions.

### 3. Publish the uncomfortable numbers yourself

12.50% founder allocation. Nothing liquid at launch. §8 of the whitepaper, unedited. If a <!-- wam:quote-line -->
critic discovers a number you presented gently, you lose the argument permanently. If you
published it first, you win it permanently. **This is the cheapest credibility available
and most projects refuse to buy it.**

### 4. Ship on a public cadence, forever

The most reliable predictor of a dead chain is a repository whose last commit is three
months after launch. Weekly notes, monthly releases, a public treasury spending report.
The consensus layer enforces that the 5% is *collected*; only disclosure shows what it was
*used for*, and that gap is where trust is won or lost.

**Decided by the founder on 16 October 2026: a release should carry something the
software can now do, and not only a list of what it had wrong.** His reasoning was that a
community which only ever sees defects concludes the thing is breaking, and that what
raises a coin's standing is the software built around it rather than anything said about
it. He is right, and the reason is not presentation.

*A release process exercised only in emergencies is untested at the moment it matters.*
The platform-build workflow sat unrun between 27 September and 16 October. Its first run
after that found, in thirty-five seconds, that nobody could build this project from a
clean clone — a `grep` matching nothing had been killing `fetch-upstream.sh` through
`pipefail` since the commit that introduced it. Three weeks in which any developer who
tried would have concluded the project did not compile. A cadence runs the machinery
while it is calm.

**But frequency is a risk here in a way it is not for an application.** Every node
release is consensus-critical software that strangers run. Bitcoin Core ships roughly
twice a year, not for lack of work, but because a chain that moves slowly makes fewer
chances to ship a disagreement about which blocks are valid.

**So the two must be separated, and today they are not.** The node, the miner, the
wallet, the pool, the explorer, the tools and the documentation all ship under one
version number, so improving a tool forces a node release. That coupling is the reason
this cannot be done yet, and undoing it is the work:

| what | how often |
|---|---|
| the node — consensus | rarely, and deliberately |
| miner, wallet, pool, explorer, tools, site | whenever each is ready |

**And not everything built raises standing.** The test is one question: *does this let
somebody outside do something they could not do before, without asking us?*
`verify_release.sh` passes it — anyone can check our binaries without believing us.
`share/examples/wam.conf` passes it. The route for an operator to list his own pool by
pull request passes it. The sixty-odd check scripts in `scripts/` do not: they make this
project reliable and no stranger has ever run one. That is maintenance, it is necessary,
and it is not the same thing.

The cheapest items on that list are the ones already finished and never announced. The
graphical wallet shipped in v0.1.11 and the channels were never told it existed — see
`scripts/test/test_announcement_covers_release.py` for what that cost. An Electrum server
has been running since before launch. Announcing what exists is worth more than building
a fourth thing nobody hears about either.

### 5. Track upstream Bitcoin Core security releases

WAM inherits Core's codebase and its vulnerabilities. A fork that stops merging upstream
fixes becomes dangerous over time. Subscribe to the security announcements and treat a
Core CVE as a WAM CVE until proven otherwise.

### 6. Listings come after liquidity, not before

Exchanges list what people already trade. Chasing a listing before there is organic volume
burns money for a chart nobody looks at. Earn the volume first.

**Status, 2026-08-18.** Enquiries have been sent to six decentralised venues asking what
they require in order to list: Komodo Wallet, BasicSwap DEX, Bisq, Maya Protocol, Haveno and
Block DX. They are the right category for this chain — every one settles native assets by
atomic swap or peer-to-peer order book, so none needs a bridge, a wrapped token or a smart
contract, and none asks the founder to supply liquidity. WAM cannot be listed on an
AMM-style DEX at all: it is its own layer 1, not a token on someone else's chain, which is
the same reason Monero is not on Uniswap.

**None of them has agreed to anything.** These are requests for their requirements, and
their answers are expected by email. Reviews at venues of this kind run two to three weeks,
which is why the enquiries went out before launch rather than after — not because anything
has been secured. It is recorded here as a step taken, and it stays worded this way until
one of them says yes.

The remaining gap is an Electrum server: Komodo Wallet requires one for UTXO chains, and it
is the only item on the common requirements list that WAM does not already have. `electrs`
is written for Bitcoin and WAM is RPC-compatible with it, so this is expected to be
configuration rather than new code.

### 7. Windows, and why it is a hashrate item rather than a convenience one

Every release so far is `x86_64-linux-gnu` and nothing else. `docs/START_HERE.md` said
builds for Windows and macOS were "planned", and until this line was written there was no
plan anywhere for a reader to check — which is a promise with nothing behind it, and it
is what prompted the question when it was finally asked out loud on 7 September.

This belongs beside §2 rather than in a list of niceties. RandomX was chosen so that an
ordinary desktop processor is competitive, and most ordinary desktop processors are inside
Windows machines. The measured hashrate on 6 September was about 6 kH/s — less than one
eight-thread desktop — and that, not the absence of a listing, is what a young chain dies
of. Requiring WSL filters out most of the people the algorithm was chosen for.

**Status, 7 September, measured.** The reason given here on the morning of the 7th was
that nobody had ever run the cross-build, so a signed binary would come from an
unexercised path. That reason is now void, and the sentence it justified has to be
re-argued on facts rather than left standing:

    ok    synced to height 6029 from genesis, over the real network
    ok    height 0 matches      ok    height 1 matches
    ok    height 5000 matches   ok    height 6000 matches
    every one of 4 blocks matches the running chain

A native `wamd.exe` -- 15 MB, `PE32+ x86-64` -- synced the test chain from genesis over
the real peer-to-peer protocol on Windows 11 and agreed with the Linux nodes block for
block, including block 1 where the treasury rule is first enforced. `check_isa_baseline.sh`
reads PE now and reports no AVX-512.

What that proves is narrow and worth stating exactly: RandomX cross-compiles for Windows
and computes the same proof-of-work, `depends` builds Core's dependencies for mingw, and
the consensus rules behave identically. It does not prove a release. Still open: the miner
is not built; `package_release.sh`, the checksum list and the signature have never covered
a second platform; and RandomX's own reference vectors have not been run on Windows, because
that test binary is dynamically linked and wants the mingw runtime DLLs.

**Closed, 12 September, measured — and it was three days before launch, not after it.**
Every item above is now done and the ordering argument below was wrong about one thing:
step 2 was not worthless before step 1, it was the half that mattered. The founder said so
on the 12th — most people are on Windows, and somebody who finds nothing he can run on day
one does not come back — and he was right.

    --self-test          both official RandomX vectors pass on Windows 11
    pool                 connected, subscribed, authorized
    hashrate             1.88 kH/s on 8 of 24 cores, 2 GiB dataset in 5.5 s
    shares               10 accepted, 0 rejected, over five minutes
    block 8478           solved by the .win11 worker, accepted, paid

Zero rejected shares is the measurement that closes the "reference vectors have not been
run on Windows" item twice over: the vectors pass, and the network accepted ten pieces of
work computed by that binary.

The miner is now statically linked, so the mingw runtime DLLs are no longer wanted by
anything. `build_windows.sh` builds it, strips it, and `package_platform.sh` packages it;
the workflow runs `--self-test` on a Windows runner before packaging, because a
cross-compiled binary cannot test itself on the machine that built it.

Two defects surfaced that no amount of reading would have found. The artifact was **197 MB**
— five unstripped executables, three and a half hours on a 16 KB/s connection — because
`package_release.sh` had stripped the Linux binaries since the first release and nothing in
the Windows path ever did. And **Windows Defender deleted the miner fourteen seconds into
its first run**, as `Trojan:Win32/Bearfoos.A!ml`, Severe. That one has no clean fix: a
program that opens a socket and then uses every core is behaviourally identical to
cryptojacking malware, and a publisher certificate is the only thing that removes the
warning. `miner/wam-miner.rc` gives the binary an identity, which is the strongest
remaining input to that classifier and was enough in the run that followed; the warning is
documented in `docs/MINE.md`, in both START_HERE pages and in the archive's own
`RELEASE.txt`; and a CI step now asks Defender about every binary before it is packaged, so
a verdict arrives from a workflow rather than from a stranger.

**When a platform passes, the pages have to stop saying otherwise.** Asked for by the
founder on 7 September: the moment a build passes the consensus gate, say so where readers
are. Four beginner pages and the README currently tell every visitor the release is Linux
and nothing else -- `docs/START_HERE.md`, `docs/START_HERE_AR.md`, `site/start/`,
`site/start-ar/` -- and a proven Windows build that those pages still deny is worth nothing
to the person reading them. The wording has to name all three routes plainly: **Windows,
macOS, and WSL**, with WSL kept rather than dropped, because it is the tested path today
and stays the answer for anyone who prefers it. Nothing goes on those pages before its
gate is green, and nothing stays off them after.

**What the exercise found matters more than the binary.** Building for a second platform
surfaced three defects in a day, and one of them was launch-critical: setting
`nMinimumChainWork` turns on Core's presync path, which enforces Bitcoin's retarget
schedule, which DarkGravityWave violates at height 1 -- so no new node could sync. Every
published release carries zero there, so the live network was never affected; but
`check_min_chain_work.py` instructs setting it on mainnet after launch, which would have
stopped every newcomer syncing, in the weeks when newcomers are the entire point. That
was a trap with a date on it, and the date was after the 15th.

**The order this was planned in, and what happened to it:**

1. ~~`wamd` and `wam-cli` for Windows through `depends` with `HOST=x86_64-w64-mingw32`.~~
   Done 7 September, shipped signed in v0.1.8 on the 12th.
2. ~~`wam-miner.exe`. One `g++` invocation and one static RandomX library — the smallest
   part of the work, and worthless before step 1.~~ Done 12 September. It was one `g++`
   invocation and forty lines of socket compatibility, and calling it worthless before
   step 1 was the error in this list: a node without a miner is a wallet, and this chain's
   whole argument is that an ordinary desktop should be able to mine.
3. ~~**macOS**~~ — done 12 September, in v0.1.8, hours after this line said it
   would wait. The founder pointed out that the agreement had been Windows *and*
   macOS, and that deferring was not what we agreed. He was right, and the reason
   written here -- that the miner was not built and macOS runners are queued -- was
   a cost, not an argument.

   `build_macos.sh` builds the miner now, and it needed no porting at all:
   `miner/src/platform.h` exists because Winsock disagrees with Berkeley sockets,
   and macOS does not. The self-test runs during the build, on the machine the
   binary is for, which is a shorter chain of custody than Windows has.

   **Apple Silicon only.** A binary for one architecture does not run on the other
   and `macos-13` would ask a free public repository for a second macOS runner per
   run. Every Mac sold since 2020 is Apple Silicon; Intel owners build it, and
   that run is still worth more to this project than another arm64 one because
   nobody has done it.

   **Not notarised, and it never will be for free.** macOS refuses an unstapled
   binary from the internet on first run. `docs/MINE.md` says what the message is
   and gives the one command that clears the quarantine flag on three named files
   -- not "disable Gatekeeper", which is what a reader would otherwise search for
   and find.

WSL stays documented rather than dropped: it is the path strangers have actually used
since August, and it is still the answer for anyone who prefers it.

---

## Realistic timeline

| Phase | Duration | Cumulative |
|---|---|---|
| 0 — compile | 1–2 weeks | 2 weeks |
| 1 — prove the four claims | 1 week | 3 weeks |
| 2 — testnet | 4–6 weeks | 9 weeks |
| 3 — infrastructure & audit | parallel, gated by 3.4/3.5 | 9–14 weeks |
| 4 — launch | 1 day | — |

**The 2026-09-15 launch date is ~6 weeks away and Phase 0 has not started.**

That is tight but not impossible — *if* Phase 0 begins now and the security audit and legal
review can run in parallel. If either slips, move the date. A date is one constant in one
header file; a rushed launch cannot be undone.

> If the date must move, change `WAM_GENESIS_TIME` in `src/wam/wam-params.h` **before** the
> genesis block is mined, and re-run the verification suite. Afterwards it is a hard fork.

---

## What this document deliberately does not contain

No price targets, no market-cap projections, no marketing spend plan, no promises about
returns. Those are not engineering questions, several of them are regulated advice, and a
roadmap that includes them is a roadmap you should not trust.
