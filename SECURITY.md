# Reporting a security issue

**Email: wam.coin.official@proton.me**

Please do not open a public issue for a security problem. Do not post it in the
Discord, and do not describe it on a forum. A consensus bug that is public
before it is fixed is a bug every node on the network is exposed to at once.

You will get an acknowledgement. If you do not hear anything within 72 hours,
send the mail again — assume it was lost, not ignored.

---

## What counts

Anything that would let someone:

* create WAM outside the emission schedule, or spend coins they do not own
* make honest nodes disagree about which chain is valid
* crash or stall a node from the network, or from a crafted block or transaction
* take a block reward that the treasury rule reserves, or bypass the time locks
  on the founder reserve
* steal from a mining pool built on `pool/`, or from a miner running `miner/`

Also worth reporting, though less urgent: a way to make the node leak
information about its wallet or its peers, and anything in `scripts/` that
could expose a private key.

Denial of service that requires more resources than it costs the attacker is
interesting. A report that amounts to "I sent 10 Gbit/s at it" is not.

## What to send

Enough to reproduce it. A patch is welcome but not required — a clear
description of the mechanism is worth more than a proof of concept we cannot
follow. If you have exploit code, send it; it will not be published.

State whether you want to be credited, and how.

## What happens next

**The published tiers, paid in mainnet WAM.** These were announced before
launch, on BitcoinTalk and in the channels:

| | |
|---|---|
| Inflation beyond the 22,000,000 cap, or a way past the treasury rule | 50,000 WAM |
| A consensus split, or a remote crash of nodes | 15,000 WAM |
| Theft of funds held by software in this project | 12,500 WAM |
| Credit without entitlement — paying out coins nobody earned | 10,000 WAM |
| Bulk deanonymisation of miners or users | 2,500 WAM |
| Denial of service against the pool, the explorer or a seed | 1,000 WAM |
| Hardening, a misconfiguration, or a document that misleads | 250 WAM |

They are a floor and not a ceiling: a finding that matters more than its rung
can be paid more than its rung, and if that happens it will be said plainly
that it was a judgement and not a tier.

**What changed on 1 October 2026, and what did not.** The table above was
three rows, and its top row held three different things at one price:
a consensus split, inflation past the cap, and theft of pool funds. They are
not one thing. Coins created out of nothing cannot be taken back without a
reorganisation nobody would accept; pool funds are bounded and can be
replaced. So the top rung now names only the one that cannot be undone, and
keeps its number. **No published amount was reduced.** The middle rung rose
from 10,000 to 15,000, deanonymisation rose from 1,000 to 2,500, and the
classes that previously had no rung of their own now have one — which tells a
reviewer where to look, and that brings more reports rather than fewer.

**Findings already accepted keep the classification they were given.** The
10,000 and the 1,000 below were judged under the three-row table and are not
re-read against this one.

**One payment per root cause, not per symptom.** Three reports that are three
faces of one state machine are one finding, which is how the 10,000 below was
handled. And the amount follows the impact, not the effort: one line that
reveals an inflation bug is worth the top rung, and a month of reading that
finds nothing is worth thanks.

**What does not qualify**, said rather than left to be discovered: a
theoretical bug with no demonstrated path; anything that needs the operator's
own key or physical access; software this project did not write; social
engineering; and denial of service by raw volume, which anybody can do to
anything.

This file said the opposite of all of it until 2026-09-14 — "there is no bug
bounty" — while three other places in the repository said "there is a bounty"
and linked here. A reviewer followed our own sentence to our own file and found
it contradicted. He was right and the file was wrong.

**What has been paid is in the ledger, and nothing else has.** 10,000 WAM went
to chovy on 1–2 October 2026, 10,000 to Alboy on 11 October, 1,000 to
Smooth Jazz Crypto on 13 October, and 250 to ahten on 15 October — 21,250 WAM
to four people. The 1,000 for the pool API leak is the one still unpaid. Until 2 October this paragraph opened
"nothing has been paid yet", which stayed after it stopped being true and
contradicted the line further down this same file. Between 14 and 15 September
it claimed the opposite error: that 1,000 WAM had already been paid to the reviewer who
found the pool API leaking payout addresses, bought from a miner at a price the
miners set in public, with the offers, the price and the transaction published.
None of that had happened. Mainnet did not exist when the sentence was written,
so there were no mainnet coins to pay with and no price for anyone to have set.
It was written here in error and stood for a day, including on
wamcoin.org/security.

## Where the money comes from

**The operating treasury** — 5% of every block subsidy for heights 1 to
400,000, paid by consensus rule WAM-1 and designated in the whitepaper for
listings, audits and infrastructure.

    WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE

Check it rather than believe it, from any node:

    wam-cli scantxoutset start '["addr(WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE)"]'

At height 19,371 that returned 10,760 unspent outputs totalling
26,927.24421040 WAM. One output per block, and it accrues 1,800 WAM per day.

**It has moved twenty times, and every movement is a bounty or a test coin.**
This paragraph said "the treasury has never moved a coin since block 1", and
that was true until 2026-09-22, when 500 WAM went to a GLEEC maintainer so he
could run an atomic-swap test on a pull request he had opened and fixed
himself. Not a listing fee — none was asked for and none was paid. The
nineteen movements since are the bounties below: two of them left in nine
instalments each, because the treasury is paid one 2.5 WAM output per block
and never consolidated, so 10,000 WAM in a single transaction would be about
4,000 inputs and six times what any node will relay. Every
coin that leaves is recorded with its amount, its fee, its
reason and its transaction id in
[docs/TREASURY_LEDGER.md](docs/TREASURY_LEDGER.md), and the balance above can
be checked against the chain with the command above rather than believed.

**The source changed, and this is the record of it.** The announcement on
BitcoinTalk said the tiers would be paid "from the founder reserve". That
reserve is locked by consensus until 2027-09-15 — five outputs of 400,000 WAM
behind OP_CHECKLOCKTIMEVERIFY in the genesis coinbase, readable with
`wam-cli getblock $(wam-cli getblockhash 0) 2` — so it cannot pay anything
today, and the founder has committed in public not to pay from it in any case.
Until 17 September this file said the new source "has not yet been decided"
while the project was telling a reviewer by email that it was the treasury. He
found the contradiction and asked for the public reference. He was right to.

**The ceiling, and it is a number rather than a feeling.** The treasury is
750,000 WAM over its entire life — 2.5 WAM a block to height 200,000 and 1.25
to height 400,000 — and then nothing, ever. It also has to keep this network
running, which comes first, because a chain with no nodes has nothing worth
securing.

**This programme's share of it is one eighth: 93,750 WAM, for the whole life
of the programme.** 22,000 of that is committed to the findings below. One of
every class in the table above comes to 91,250, so the table is
payable even if every class is found — which is the test a promise has to
pass before it is made.

**When the eighth is spent, the programme closes and this file says so.** It
is not left open and unfunded. The ceiling can be raised later by announcement
and will never be lowered for a finding already accepted.

**Priority is the order of validation** — first validated, first paid. A rule
rather than a judgement, because the alternative is a queue whose order the
payer decides.

## Accepted findings

**10,000 WAM — pool accounting, accepted 16 September 2026, PAID 1–2 October 2026.**

Three related reports: the same pending block could mature more than once,
crediting miner balances twice out of the pool operator's own wallet, plus two
further manifestations of the same accounting fault. Found before launch and
fixed in `pool/lib/shareProcessor.js`; held down by
`pool/test/maturation-claim.test.js`.

Classified at 10,000 and not at 50,000, with the reasoning in full because a
tier decision without one is just a number: the 50,000 rung says *theft of
pool funds*, and nobody took the funds. The money left the operator's wallet
twice to legitimate miners, and the trigger was an operator restart during a
maturation check rather than anything an attacker could cause — which the
reporter stated himself before we did. It is a loss of pool funds, not a theft
of them, and stretching our own published word would cost more than the
difference. Nor is it the base rung: three reports in the money path, before
launch, which would have drained the operator's wallet with nothing in the logs
looking wrong. 10,000 is a judgement on severity rather than a reading of the
rung's wording, and is recorded as such.

Paid in nine transactions, and the reason is arithmetic rather than caution:
consensus pays the treasury 2.5 WAM per block, so its balance is thousands of
small outputs. 10,000 WAM in one transaction is about 4,000 inputs and 590 KB
— six times the standard size limit, which no node would relay. It would have
been signed and broadcast and simply never arrived. The first of the nine was
10 WAM, sent and confirmed received before the rest moved.

Every transaction id is in `docs/TREASURY_LEDGER.md`, and the total on the
chain is 10000.00000000 WAM to `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr`, which
anybody can add up without asking us.

**10,000 WAM — WAM-F5, pool share accounting, accepted 11 October 2026, PAID 11
October 2026.** Nine transactions, every id in `docs/TREASURY_LEDGER.md`: a test
payment of 10 WAM sent first and confirmed received, then 1,248.75 eight times.
This heading said "first instalment paid" until 2026-10-15, after all nine had
gone out — the wording was true on the day it was written and nothing moved it
when the rest followed the same day.

The pool rebuilds its job every 55 seconds even when the tip has not moved, so
that newly arrived transactions reach miners, and keeps four jobs submittable.
On this chain the mempool is almost always empty, so every job at one height
came out byte-identical — same coinbase, same merkle root, same header — and
the duplicate-share guard was a `Set` held per job. One RandomX solution was
therefore claimed again under each live sibling: up to three credits for one
unit of electricity. PPLNS pays a miner his weight against everyone else's, so
the excess came out of the other miners in the round, and one stratum
connection with a valid payout address was the whole requirement.

Reported by Alboy on 11 October 2026 and reproduced end to end over the
stratum socket. Fixed in two independent places rather than one: the claim is
now keyed to the work it was done on, in `pool/lib/blockTemplate.js`, and
`pool/lib/shareProcessor.js` separately refuses a proof-of-work hash it has
already credited in the round. Held down by
`pool/test/cross-job-replay.test.js`.

Classified at 10,000 — *credit without entitlement, paying out coins nobody
earned* — which is what it is, with no stretching of the rung's wording in
either direction.

Why it survived: `pool/test/share-claim.test.js` built one job and proved the
guard refuses a repeat inside it. It never asked what happens across two. That
test now builds two.

**250 WAM — WAM-F6, a consensus field that no network assigned, accepted 11
October 2026, not claimed.**

`consensus.enforce_BIP94` was declared in `Consensus::Params` with no default
initialiser, read in three consensus paths — `ContextualCheckBlockHeader`, the
block assembler, and `GetNextWorkRequired` — and assigned by no network at all.
The params object is heap-allocated, so every one of those reads was
indeterminate. It read false on the binaries this project released, which is
the behaviour this chain has had since block 1; but an indeterminate read is
not a promise, and a compiler owes nobody that answer. That is the shape that
makes two nodes disagree about which blocks are valid.

Measured consequence: `mining_basic.py test_timewarp` failed on WAM's regtest,
on the exact assertion the BIP94 mitigation exists to satisfy.

Also reported by Alboy, the same day. Fixed by assigning the field in all three
networks in `src/wam/chainparams.cpp` — false on mainnet and testnet, which
keeps the behaviour the released binaries already had, and true on regtest. The
class is now held down by `scripts/check_consensus_params.py`, which fails the
sweep if any scalar in `Consensus::Params` is left both undefaulted and
unassigned by some network.

Hardening rung, 250 WAM. The reporter claimed the 10,000 above and has not
asked for this one. It is payable on request, at the rung.

**1,000 WAM — pool maturation, a matured block could lose every trace of who
was owed what, accepted 12 October 2026, PAID 13 October 2026.** One
transaction of 402 inputs, txid
`867bffa18cafda9a82349125a2c1e15828a095ffe584b44dfa63d90d722dab70`, in block
19,370, and in `docs/TREASURY_LEDGER.md` with the rest.

When a block matured, the pool deleted it from `blocks:pending` and only then
wrote the evidence to `blocks:maturing` — two separate Redis commands. An
interruption between them left the block in no state at all: gone from
pending, absent from maturing, never credited.

What makes that final rather than inconvenient is one line in `recordBlock`:
the round's shares are deleted in the same pipeline that writes the pending
record. So that field is not a copy of anything. It is the only surviving
statement of what each miner in the round is owed, and once it is gone the
payout table cannot be rebuilt — not by the pool on restart, not by an
operator by hand. The coins arrive in the pool's wallet with nobody able to
say whose they are.

The code argued for that order in a comment: *losing a credit is recoverable;
paying it twice is not.* The second half is true. The first half was false,
and the line deleting the round is what falsified it. The defect was a
deliberate trade-off resting on a premise the code had already broken.

Reported by Smooth Jazz Crypto (@smoothjazcrypto) on 12 October 2026, against
`87ac8f0`, with a reproduction over the project's own test harness and the
fix: make the transition one server-side operation. Fixed in
`pool/lib/atomic.js` — a Lua script moves the field and writes the evidence
together, and the pool refuses to start against a Redis that cannot run it,
because a fallback is the same defect reachable by configuration. `_orphan`
had the identical shape, was not reported, and was found while fixing this.

Classified at 1,000 — the rung for denial of service against the pool — and
said plainly as a judgement rather than a reading of the wording. The
mechanism is the credit ledger, which is the 10,000 rung; the impact is one
block's payout table inside a sub-second window that no attacker can cause,
which is the 1,000 band.

The reporter also made the point that mattered most. The regression test for
the September finding crashes the pool at a point somebody chose — after the
evidence is written — so the one interval it never touched was the one this
fault lived in. `pool/test/crash-window.test.js` chooses nothing: it walks
the failure across every Redis command the maturation path issues, one run
per position, and asserts after each that the block is still recoverable.

**250 WAM — pool address validation, valid base58 addresses refused as bech32,
accepted 15 October 2026, PAID 15 October 2026.** One transaction of 102
inputs, txid
`2ba6139518819ffeee0a15d4075680f04fa00a4730859cbe206ea4b1c57c2d12`, in block
21,114, and in `docs/TREASURY_LEDGER.md` with the rest.

`addressToScript` in `pool/lib/util.js` tested whether an address *looked like*
bech32 before trying to decode it as base58. The test asks whether there is a
`1` with only bech32 characters after it, and a valid base58 address answers
yes by chance about one time in twenty — measured at 4.99% over 200,000
generated mainnet P2PKH addresses here, and at 5.04%, 4.8% and 5.12% in the
reporter's own three simulations.

This project's own treasury address is one of them.
`WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE` lower-cases to a `1` followed by 27
characters that all happen to be in the bech32 alphabet, so the pool called it
*a segwit address for 'wdmmqw'* and refused it, while base58check decodes it
cleanly as version 73 — this network's P2PKH version.

A miner whose address matched was refused at `mining.authorize` and
disconnected, told that his own address belonged to another chain. An operator
whose `poolAddress` matched could not start his pool at all.

No funds were at risk: payments go out through `sendmany`, where the node
parses the address, and an affected address never reached that point.

Reported by ahten (@ahteen66) on 15 October 2026, with a reproduction against
the project's own test harness, prevalence simulations, and the fix. He also
found the thing that makes this more than one file's mistake: the identical
fault was fixed in the miner on 19 September 2026, in `miner/src/address.h`
(`2e91026`), and the pool was never updated with it. `pool/lib/util.js` carried
its original commit, twenty-six days later.

Fixed by decoding first: base58check carries a checksum, so it decides instead
of guessing, and a real segwit address cannot survive it. The message that
names a Bitcoin or Litecoin address is kept — it is a useful answer to a
routine mistake — and now runs after the decoder has refused the address
rather than before it.

Classified at 250, the hardening rung, which is where the reporter classified
it. Held down by `pool/test/address-validation.test.js`.

**1,000 WAM — the pool API leak, accepted 13 September 2026, unpaid.** Three of
four `/api/*` endpoints returned every miner's full payout address while the
pool's own page said otherwise. Fixed at the response boundary in
`pool/lib/api.js`; held down by `pool/test/api-redaction.test.js`.

When each is paid, the amount, the reason for the amount and the transaction id
are published here, and nothing is announced before it exists.

Alongside it, and worth more in most cases: a real answer from someone who
read your report, credit in the release notes in whatever name you choose, and
a fix.

For anything that affects consensus or funds, the fix is written and tested
before it is described publicly. Once it is released, the report is published
in full, including the timeline and the name of whoever found it.

## Scope

This repository: the node (`src/`), the reference miner (`miner/`), the mining
pool (`pool/`), the explorer (`explorer/`), and the tooling in `scripts/`.

WAM is a fork of Bitcoin Core v28.1. A vulnerability in unmodified upstream code
should go to [Bitcoin Core's security process](https://bitcoincore.org/en/contact/)
first — they maintain it, and every fork including this one benefits from
disclosure to them. Send it here too if you believe WAM's changes make it worse.

## The signing key

Its fingerprint goes here — on this line, in this file, in this repository,
and in no other place:

```
4BD4 A8D3 AFD4 3F5C BCB5  00E2 3798 462F E00A DBA4
```

```
WAM Coin (release signing) <wam.coin.official@proton.me>
RSA 4096 · created 2026-09-03 · expires 2031-09-02
```

The public key is [SIGNING-KEY.asc](SIGNING-KEY.asc) in this repository.

**Anyone quoting a WAM fingerprint from anywhere other than this file is
quoting an invention.** Not from an email, not from a chat message, not from a
forum post, and not from a copy of this repository hosted somewhere else.
Check it at https://wamcoin.org/security/, over HTTPS, on a domain this
project controls -- not on a service that can take it away.

### What it signs, and what that is worth

Every release carries `SHA256SUMS` and `SHA256SUMS.asc`. The first lists the
hash of each file; the second is a signature over that list.

A checksum file on its own protects against a corrupted download and nothing
else: whoever can replace the binary can replace the list beside it, and both
will agree. The signature is what a stranger cannot forge without this key.

To check a download:

```
gpg --import SIGNING-KEY.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
curl -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS.asc
curl -LO https://wamcoin.org/verify_release.sh
curl -LO https://wamcoin.org/SIGNING-KEY.asc
bash verify_release.sh .
```

or run [scripts/verify_release.sh](scripts/verify_release.sh), which does the
three and refuses to say "ok" unless all three pass.

`gpg --verify` printing `Good signature` with a `WARNING: This key is not
certified with a trusted signature` is the normal and expected result. It
means the signature is genuine and that you have not personally vouched for
the key — which nobody should, on first contact. The fingerprint above is what
you check instead.

### The key is not on any server this project runs

It was generated on the founder's own machine and exists in two places: that
machine, and an offline backup. No node, no seed, no pool and no build server
has ever held it. A server that is compromised cannot be used to sign a
release, which is the entire point of keeping it off them.

A revocation certificate was created in the same session and is stored apart
from the key. If this fingerprint ever changes, or a revocation is published,
treat every release signed after that moment as untrusted until this file
says otherwise.

### CHANNELS.txt

[CHANNELS.txt](CHANNELS.txt) lists the project's official channels, and a list
of accounts that vouch for each other is only as strong as the weakest of
them: take one, repoint it at three impostors, and the mutual linking now
argues *for* the attacker. A detached signature over CHANNELS.txt removes
that. The reader stops needing to trust any account and only needs the one
fingerprint above.

## PGP mail

Mail is accepted in plain text. The key above is for signing releases; if you
need to encrypt a report before sending it, say so in a first message with no
details.

---

*Last reviewed: 2026-08-11*
