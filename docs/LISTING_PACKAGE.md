# WAM Coin — integration and listing package

Everything an exchange, wallet or explorer needs in order to integrate WAM,
on one page. Send this link rather than answering a form field at a time.

**Status:** mainnet launches **2026-09-15 00:00 UTC**. Until that date the
mainnet chain does not exist, and only testnet is live. Nothing below is a
projection — the parameters are final and already committed to source.

---

## 1. Identity

| | |
|---|---|
| Name | WAM Coin |
| Ticker | WAM |
| Consensus | Proof of work, **RandomX** (CPU) |
| Base | Bitcoin Core v28.1 fork |
| Licence | MIT |
| Source | https://gitlab.com/WAMCoin/wam-coin |
| Website | https://wamcoin.org |
| Explorer | https://explorer.wamcoin.org |
| Contact | wam.coin.official@proton.me |

**Integration cost is low and this is the main thing worth knowing:** WAM is a
Bitcoin Core fork, not a rewrite. The RPC interface, wallet API, address
handling, PSBT support and block structure are Bitcoin's. Any system that
already integrates Bitcoin can integrate WAM with configuration rather than new
code — the differences are the constants in section 3.

---

## 2. Monetary policy

| | |
|---|---|
| Maximum supply | 22,000,000 WAM |
| Block time | 120 seconds |
| Initial subsidy | 50 WAM |
| Halving interval | 200,000 blocks (~13.9 months) |
| Difficulty algorithm | DarkGravityWave v3, retargets every block |
| Decimals | 8 |
| Smallest unit | 1 satoshi-equivalent = 0.00000001 WAM |

**Premine:** 2,000,000 WAM (9.09%) in the genesis block, paid to the founder
address in five outputs. **Every one is time-locked with
OP_CHECKLOCKTIMEVERIFY; none is spendable at launch.** They unlock on
2027-09-15, 2028-09-15, 2029-09-15, 2030-09-15 and 2031-09-15.

**Treasury:** 5% of each block subsidy, heights 1 to 400,000 only, then zero
forever. 750,000 WAM total over roughly 18 months.

Founder + treasury = 2,750,000 = **12.50%** of the cap. Public mining = 87.50%.

Both are enforced by consensus, not by policy. The locks are bare scripts in
the genesis block, so the schedule can be read directly:

```
wam-cli getblock $(wam-cli getblockhash 0) 2
```

---

## 3. Chain parameters

### Mainnet

| | |
|---|---|
| Network magic | `0x57 0x41 0x4d 0x21` ("WAM!") |
| P2P port | 9555 |
| RPC port | 9554 |
| Genesis hash | `d8d3debea987b62a0934c3980d62bffbb6e16aa797d19891d4fcc9b9fb11d7e9` |
| Genesis merkle root | `230fc579dfbad4cec208c43392e3178760fcd74617e4ef22903eae7bf7fcff29` |
| Genesis time | 1789430400 (2026-09-15 00:00 UTC) |
| Genesis nBits | `0x1e0ffff0` |
| Genesis nonce | 1264205 |
| PUBKEY_ADDRESS | 73 — addresses start with `W` |
| SCRIPT_ADDRESS | 135 — addresses start with `w` |
| SECRET_KEY (WIF) | 190 — keys start with `V` |
| bech32 HRP | `wam` |
| BIP32 xpub | `0x0488B21E` |
| BIP32 xprv | `0x0488ADE4` |
| DNS seeds | seed1.wamcoin.org, seed2.wamcoin.org, seed3.wamcoin.org |

### Testnet

| | |
|---|---|
| Network magic | `0x77 0x61 0x6d 0x21` ("wam!") |
| P2P port | 19555 |
| RPC port | 19554 |
| Genesis hash | `ce81c20a59a9586946d46177317658575b9d1c1fc07912b5488ab76202f59bcb` |
| PUBKEY_ADDRESS | 65 — `T` |
| SCRIPT_ADDRESS | 128 — `t` |
| SECRET_KEY (WIF) | 239 — `c` |
| bech32 HRP | `twam` |
| DNS seed | testnet-seed.wamcoin.org |

**Note on RPC ports.** They are the peer port **minus one**, not plus one.
Bitcoin Core reserves peer+1 for its Tor onion listener, so 9556 and 19556 are
taken and must not be used for RPC.

---

## 4. Consensus features

Active from **height 1**. There is no legacy chain to stay compatible with, so
none of Bitcoin's activation scaffolding is carried:

| Feature | Status |
|---|---|
| SegWit | active from height 1 |
| Taproot | active from height 1 |
| CSV (BIP68/112/113) | active from height 1 |
| CLTV (BIP65) | active from height 1 |
| BIP34 / BIP66 | active from height 1 |
| Address types | P2PKH, P2SH, P2WPKH, P2WSH, P2TR |
| PSBT | supported (BIP174) |

**For atomic swap integrators:** CLTV and CSV are active from the first block
and the scripting language is Bitcoin's, so HTLCs work without any adaptation.
This is what makes WAM straightforward for BasicSwap, Block DX, Komodo and
similar venues, and it is why no bridge or wrapped token is involved.

**WAM is a layer 1, not a token.** It cannot be listed on an AMM-style DEX such
as Uniswap without a wrapped representation and a bridge, for the same reason
Monero cannot. Atomic swap and order-book venues need neither.

---

## 5. Consensus rules that differ from Bitcoin

Every difference from Bitcoin Core is a scripted, anchored transformation in
`scripts/patch_upstream.py`. Run it to read all of them with their reasons:

```
python3 scripts/patch_upstream.py --list
```

The two that affect validation:

**WAM-1 — mandatory treasury output.** Every block from height 1 to 400,000
must pay exactly 5% of the subsidy to the treasury address, or it is invalid.
From 400,001 the rule stops applying and miners keep 100%.

**RandomX proof of work.** The 80-byte header is Bitcoin's, with the nonce at
byte 76. The PoW hash is RandomX over that header; the block id remains
double-SHA256 of the header, as in Bitcoin. The RandomX key rotates every 2048
blocks with a 64-block lag on mainnet.

---

## 6. Software

Releases, with SHA256SUMS, are published at:

    https://wamcoin.org/downloads/

Built by GitHub Actions from the tagged commit on ubuntu-22.04, so the binaries
run on Ubuntu 22.04 and newer; the workflow is `.github/workflows/release.yml`
and the build is reproducible from source with `./install.sh --build-only`.

| Binary | Purpose |
|---|---|
| `wamd` | full node daemon |
| `wam-cli` | RPC client |
| `wam-tx` | transaction utility |
| `wam-util` | block/header utility |
| `wam-wallet` | offline wallet tool |

Runtime dependencies: libevent and libsqlite3. Nothing else — ZMQ is disabled
deliberately.

### Electrum protocol

An ElectrumX server runs, so a light wallet can read a balance without holding
the chain. Komodo Wallet requires one before it will list a UTXO coin at all;
it is useful whether or not any venue asks.

| | |
|---|---|
| Host | `electrum.wamcoin.org` |
| TCP | 50001 |
| SSL | 50002 (Let's Encrypt, renewing automatically) |
| WebSocket | 50004 |
| Implementation | spesmilo/electrumx, with the WAM coin class in `integration/electrumx/` |

It serves testnet today, because that is the only WAM network that exists. The
same installer produces the mainnet server; `integration/electrumx/install.sh`
is the whole recipe, and `integration/komodo/electrums-WAM.json` is the entry
their repository takes.

The server holds no keys and can spend nothing. It reads the node and answers
questions.

---

## 7. Assets

All transparent PNG, square, the coin masked to its own circle — no background
is baked in, so they sit correctly on a light or a dark interface.

| | Path |
|---|---|
| **Listing logo, 200×200** | `brand/png/wam-platform-200.png` |
| Listing logo, other sizes | `wam-platform-{32,64,128,256,512,2048}.png` |
| Social / announcement image | `brand/png/wam-social-{512,1024,2048}.png` |
| Masters (JPEG, 1080) | `wam-platform-master-1080.jpg`, `wam-social-master-1080.jpg` |
| Whitepaper | `WHITEPAPER.md` |

The listing logo carries the mark alone. The social image is the same coin with
`22,000,000` and the launch date struck into it — correct for an announcement,
wrong for a listing, where it is rendered at 32 pixels and the text becomes
noise.

---

## 8. Who runs this network, other than us

Two operators outside the project run nodes. We do not know who they are.
Neither was asked, neither was paid, and neither mines — they found the
network through the DNS seeds, connected inbound, and stayed.

As of 27 August 2026 their connections had been unbroken for 58 and 52
hours: no crash, no restart, no intervention by anybody. That is the only
evidence we have that the software runs unattended, because our own servers
prove nothing on that point — we fix ours when they break, and nobody can
fix theirs but them. Both hold the same tip as we do, which means each of
them validated the chain from the genesis block on hardware and a network we
have never seen.

One of them upgraded within hours of a release announcement, which is the
part that cannot be faked by a forgotten process.

The number is two. It is small, they owe us nothing, and either could
disappear tomorrow. We state it because it is checkable rather than
flattering: run a node, and see who is on the network.

The full picture, including the versions in use, is what
`scripts/check_peer_versions.py` prints. It reports counts and versions and
never addresses — a list of who runs a node is a list of who to attack.

## 9. Chain security, and how many confirmations to require

The honest number is not 6. Here is the whole of the reasoning, because an
exchange that finds this out for itself will find it out from a loss.

**What the risk is.** A proof-of-work chain is as hard to rewrite as it is
to out-mine. WAM is RandomX, which is mined on CPUs, which are the most
rentable hardware in existence — any cloud provider will sell you a hundred
cores by the hour. Monero is safe on the same algorithm because its hashrate
is enormous. A chain in its first weeks is not Monero, and no amount of
careful engineering changes that. It is a property of being new.

**What the risk is not.** A reorganisation does not touch anybody's wallet
and cannot move coins the attacker does not own. What it allows is a double
spend of the attacker's *own* coins: deposit somewhere, take the value out,
then publish a longer chain in which the deposit never happened. So the
exposure lands almost entirely on whoever accepted a payment on few
confirmations. In practice, that is you.

**What we ask you to do about it.**

| | |
|---|---|
| Between two people, small amounts | 3 confirmations (6 minutes) |
| **Atomic swaps, peer to peer** | **15 confirmations (about 31 minutes)** |
| Ordinary amounts | 20 confirmations (40 minutes) |
| **Custodial exchange deposits, while hashrate is low** | **60 confirmations (2 hours)** |
| Anything above a few thousand WAM | 100 confirmations, or wait for us |

**Why an atomic swap is not an exchange deposit, and gets its own row.** The
two are not the same risk wearing different clothes. A custodial deposit puts
a reversal against the exchange's whole balance, and the proceeds leave
through withdrawals nobody can claw back. A swap is two people and one trade:
the exposure is the size of that trade, it ends when the swap ends, and there
is no pooled balance for anyone to drain. The depth is sized to what is
actually at risk.

The number came from measurement, and from a maintainer who tested it rather
than argued about it. cipig ran the first WAM swap on 2026-09-22 -- 249.68
WAM against Litecoin, completed in 10m31s at 4 confirmations -- and pointed
out that 60 confirmations would make a swap take two hours, which the Komodo
DeFi Framework cannot complete without changing its own source. He asked for
under an hour, and said to budget 30 minutes for block variance.

Measured over the last 1,000 blocks of mainnet, the time to accumulate N
confirmations:

| N | median | 95th percentile | worst |
|---|---|---|---|
| 4 | 7m29s | 16m54s | 26m18s |
| **15** | **30m53s** | **45m47s** | 61m23s |
| 20 | 41m18s | 56m48s | 75m18s |
| 30 | 62m42s | 78m50s | 90m05s |
| 60 | 2h06m | 2h20m | 2h33m |

So his 30 minutes is 15 confirmations on our own data, under 46 minutes 95
times out of 100. And 60 really is unworkable: two hours at the median.

**And the two-hour limit is not an obstacle we talked our way around.** An
atomic swap is built on time locks -- both sides lock funds with a deadline
and get them back if it passes. A swap that runs for two hours pushes against
those locks, so it fails more often and leaves funds in a half-finished
state. Their limit protects the user as much as ours does. Asking them to
raise it would have made WAM swaps the fragile ones.

**The depth follows the amount, not the ceremony.** An attack has a fixed
cost -- renting more than half the network for that many blocks -- so it is
only ever worth mounting against something worth more than that. Nobody rents
fifty machines for two hours to reverse a payment worth ten coins. Asking a
person to wait forty minutes to receive a small amount buys them nothing and
costs them the use of the chain, which is a real cost with an imaginary
benefit.

That is also why the exchange row is the high one and stays high. An exchange
is where value leaves this chain and becomes something irreversible, so it is
the one place where reversing a deposit pays. WAM has no listing and no price
today; until it does, that row is the only one with anything behind it.

Confirmation counts are the one lever that works here, and they work
linearly: doubling them doubles what an attack costs. We would rather ask
you for two hours than have you find out the other way.

These numbers are reviewed publicly against measured hashrate rather than
left to age. When they change, the change and its reason are published, and
the last review date is recorded here.

    Last reviewed  2026-09-22, seven days after launch, when the first real
                   atomic swap was performed and the peer-to-peer row was
                   added at 15 confirmations on measured data rather than on
                   judgement. Before that: 2026-09-20, five days after
                   launch, against a measured
                   network hashrate of 228 kH/s over the last 120 blocks and
                   245 kH/s over the last 720, with seven distinct block
                   finders and more than forty mining addresses. The figure
                   moves by roughly a factor of two between the quietest hour
                   of the night and the busiest of the morning, so the low
                   end of the day is what these depths are set against.

                   The previous review, 2026-08-29, was made before launch on
                   the basis that the hashrate would be one founder's laptop
                   and one pool. That basis no longer holds, which is why the
                   small-amount row was added: the earlier numbers were set
                   for a chain that had not started.

**What we do on our side.** Every node we run checks itself every two
minutes for a block that has stopped being a block —
`scripts/check_reorg.py`, and the systemd timer beside it. It cannot prevent
an attack at this size; it means we are not the last to know, and the
difference between telling you in four minutes and in four days is the
difference between one bad deposit and a delisting. If it fires, the
channels in section 1 carry it.

**What we deliberately do not do.** We have not added a consensus rule
refusing reorganisations beyond some depth, and we do not intend to. It
looks protective and it is a trap: during any network partition the two
halves each refuse to return to the other, and a temporary split becomes a
permanent one. Several chains have been broken exactly that way. Bitcoin
does not do it, and neither will we.

**Checkpoints.** The policy is to carry them: the hash of a real block at a
known height, compiled in, so that no node running that release can be walked
onto a chain that lacks it. This is a real defence and it is also a real
centralisation — it means trusting whoever cuts the release — and we would
rather say that plainly than describe it as security. **No checkpoint has
shipped yet.** The chain passed the 1,000-block burial rule in September; the
decision, the tool (`scripts/make_checkpoint.py`) and the policy are in
`docs/CHECKPOINTS.md`. Until one ships, confirmation depth in section 9 is
the protection this chain actually has.

---

## 10. What we do not claim

This project sets no price for WAM and runs no market for it. More than seven
people have read the code and reported what they found, and their findings
were adopted -- see review/REVIEW_RESPONSE.md and SECURITY.md -- but no
security firm has been engaged to audit the consensus changes, and peer review
is not an audit. There is no presale, no ICO, no private round and no
allocation to anyone but the founder reserve and treasury described above —
both disclosed here and enforced by every node.

Mainnet opened at 00:00 UTC on 15 September 2026. Until 2026-10-15 this
section still said the chain had not launched — a month after it had, in the
document this project hands to listing venues.

We would rather you knew all of that before spending time on an integration
than after.
