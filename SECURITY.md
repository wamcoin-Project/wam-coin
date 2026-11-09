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
| Inflation beyond the 22,000,000 cap, or a way past the treasury rule | 3,000 WAM |
| A consensus split, or a remote crash of nodes | 2,000 WAM |
| Theft of funds held by software in this project | 1,500 WAM |
| Credit without entitlement — paying out coins nobody earned | 1,000 WAM |
| Bulk deanonymisation of miners or users | 600 WAM |
| Denial of service against the pool, the explorer or a seed | 400 WAM |
| Hardening, a misconfiguration, or a document that misleads | 250 WAM |

They are a floor and not a ceiling. A finding that matters more than its rung
can be paid more than its rung, and when that happens it will be said plainly
that it was a judgement and not a tier. That is not a formality: the two
classes this project would most like to hear about — a way past consensus,
and a way into the treasury — are the two whose damage has no ceiling, and
the payment for them will not have one either.

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

**What changed on 8 November 2026, and why, in full.** Every amount above
except the last was reduced. The top rung went from 50,000 WAM to 3,000.
Nothing already reported is re-read against this table: every finding below
keeps the classification it was given, and the 10,250 paid on 8 November was
judged under the old one and paid in full at the rungs the reporter named
himself.

A programme that quietly starts paying less is a programme nobody trusts
twice, so the reasons are here rather than left to be guessed at. There are
three, and they were studied from every side before anything was touched.

*One. The treasury is finite, and we have now measured how fast it empties.*
Consensus pays it 2.5 WAM a block until height 400,000 — 750,000 WAM for its
whole life, of which one eighth, 93,750, is this programme's share. 33,950 of
that is already paid, in the programme's first fifty-four days. Under the
old table a single inflation finding, at 50,000, was more than half of
everything the programme had for its entire life. A table that one report can
empty is not a commitment; it is a number waiting to be withdrawn. This one
can be paid in full seven times over from what is left.

*Two. A bounty is not only a cost. It is a distribution of coin that was
never mined, and that is not a reading — we have watched it.* An earlier
bounty was offered to the market in full, not long after it was paid.
Nothing in that broke a rule: a bounty is the finder's coin and his to sell
on whatever day he chooses. But the effect on everyone else is not neutral.
A sum of that size is hours of the whole network's output landing in one
wallet and then moving, and the question miners ask before they point a CPU
at a new chain is whether anything was handed out before they arrived. A
lump arriving and leaving has that shape whatever the reason behind it.

*Three. The amounts had drifted away from what this coin costs to make.*
Miners take 47.5 WAM a block and the chain makes thirty blocks an hour, so
every machine on this network together earns about 1,425 WAM an hour. That
figure does not move with the hash rate; it is what consensus pays. 10,250
WAM is seven hours of all of it, or — measured against one person instead of
everyone, on the day it was paid — about 120 days of an average miner in our
pool. And the direction runs one way only: the hash rate rises, difficulty
follows it, and the block keeps paying the same 47.5 WAM until it halves at
height 200,000, so the same sum costs more work to produce every month that
passes. A figure fixed in coin is a figure that grows in labour, and the one
above is a floor rather than a ceiling. A table has to be priced against
something, and ours had stopped being priced against what the coin is made
of.

*What did not change.* The classes did not: the table still names what it
pays for rather than leaving it to be argued about afterwards. The bottom
rung did not move, because the smallest findings are the ones most often left
unreported and 250 WAM is not what makes or breaks this budget. And the
discretion above the table did not move either — it matters more now than it
did when the top rung was 50,000, and it is the reason a lower ceiling is not
the same thing as a cap.

**Findings already accepted keep the classification they were given.** The
10,000 and the 1,000 below were judged under the three-row table and are not
re-read against the one that replaced it, and nothing below is re-read
against the table of 8 November.

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
Smooth Jazz Crypto on 13 October, 250 to ahten on 15 October, and 10,250 to
bobbyning on 8 November, and 1,950 to three people on 9 November — 33,950 WAM
in all. What has been accepted and
not yet paid says so in its own entry below, with what it is waiting on. This
sentence used to count them, and a count is wrong again by the next payment;
the entries cannot be. Until 2 October this paragraph opened
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
of the programme.** 33,950 of that has been paid against the findings below,
leaving 59,800. One of every class in the table above comes to 8,750, so what
is left pays the whole table six times over — which is the test a promise
has to pass before it is made. The table it replaced passed that test once.

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

**250 WAM — the block spool was emptied at the start of the window it exists
for, accepted 6 November 2026, PAID 9 November 2026.** One transaction of 102
inputs, txid
`1a5498938994237fe6ce9bc5c87767521bd52befc0b980a4e6563d1670ecdc33`, in block
38,089, and in `docs/TREASURY_LEDGER.md` with the rest. The address arrived on
9 November, five days after the finding was accepted; nothing else was waiting
on anything. `drainSpool` says in its own comment
what the spool is for: dying between the node accepting a block and the payout
being recorded. `_submitBlock` removed the entry the moment the node accepted
the block — the first instant of that window rather than the last — and
`_record` runs after it. A redis failure there returned UNAVAILABLE before
`credited`, before `emit('share')` and before `emit('block')`. No event, and
`recordBlock` is the only writer of `blocks:pending`, so nothing recorded the
block. The resubmission hit JOB_NOT_FOUND because `refreshTemplate(true)` had
already cleared the job, and the drain found an empty spool. 47.5 WAM on the
chain, credited to nobody, with no path back: the one crash the spool was
built for was the one it did not cover.

Reported by 0xkerochan, with a harness that drives the real JobManager and
ShareProcessor against a redis whose first write throws. Fixed on the option
he named: the entry is released by the 'block' listener in `pool/server.js`
after `recordBlock` returns, so it covers the whole accept-to-record window,
and `unspoolRecorded` swallows its own failure because an entry that stays
costs one round trip a minute while an entry removed early costs a block.
Held down by `pool/test/block-spool.test.js`.

Classified at 250, the hardening rung, which is where the reporter classified
it — he wrote that he was not inflating it. The payment is waiting on a
mainnet address from him.

**10,250 WAM — a broadcast payment paid a second time, and three more faults
in the same accounting, accepted 7 November 2026, PAID 8 November 2026.** Ten
transactions of 1,025 WAM, all in block 37,299, and in
`docs/TREASURY_LEDGER.md` with the rest.

ioredis `pipeline()` is a batch, not a transaction, and its `exec()` resolves
with `[error, result]` pairs: a command that fails arrives as data, not as a
throw. `_processPayments` broadcast the transaction, wrote `payment:inflight`,
then committed the balance decrements through such a pipeline. If that commit
failed, nothing threw, nothing paused, every balance stayed as it was, and the
run ten minutes later paid the same miners again from the same balances. The
marker written for exactly this case was read in one place in the whole
repository, `startupReconcile`, so it only ever spoke after a restart.

Three more in the same report. `recordShare`'s accounting had the identical
shape with a smaller blast radius, so a miner was told `valid:true` on the
first submission of a share that was never recorded. `recordBlock` asked
`blocks:pending` and `blocks:confirmed:hashes` whether a block was already
accounted for, and a block sitting in `blocks:maturing` answered neither. And
`shutdown()` did not wait for the accounting chain, so a SIGTERM arriving
between a block being accepted and its payout being recorded lost it the way a
power cut would — except that this is the ordinary way the pool is restarted,
which makes it the likelier of the two.

Reported by bobbyning from a read of `pool/` at `6d613ae`, without running
anything. Fixed in `pool/lib/shareProcessor.js`, `pool/lib/jobManager.js` and
`pool/server.js`: the marker is read before every payment run and pauses the
pool if it is there, the payment commit and `recordShare` read what their
`exec()` returns, the
accounting is a MULTI, a duplicate share is answered with code 22 instead of
"resubmit", and `_mature`'s `lrem` was moved outside its MULTI and gated on
the replies — a MULTI is one unit against a lost connection but does not abort
on a command that fails at run time, so with the `lrem` inside it, a failed
credit could still erase the record of what was owed. Held down by
`pool/test/payment-safety.test.js`, `pool/test/maturation-claim.test.js` and
`pool/test/cross-job-replay.test.js`, each run against the old code to confirm
it fails there.

Classified at 10,000 for the payment commit and 250 for the share called
accepted while its accounting had failed — both rungs the reporter named
himself. His appendix A was the spool finding above, reported a day earlier
and credited there, though his observation about `shutdown()` was new and is
fixed with it. His appendix B, the block stranded in `blocks:maturing`, is
fixed and credited to him by name; he did not price it and no amount was added
for it.

**400 WAM — a found block's payout table could be destroyed instead of written,
and the pool would report success, accepted 9 November 2026, PAID 9 November
2026.** Paid together with the finding below it, in one transaction of 322
inputs, txid
`c3429df273b5e5eb03cb4c35271e9396cd634498ab902196c72ede83cc08fd15`, in block
38,089.

`recordBlock` committed a found block as four commands in a redis pipeline and
never read the `[error, result]` pairs that `exec()` resolves with. A pipeline
is a batch and not a transaction — this repository's own comments say so in
three places — so when the first command was refused server-side, the three
after it were applied anyway. That first command is the one that writes the
payout table. The round, which is the only other statement of who had earned
what, was deleted; the pool fee was booked for a block nobody would ever be
paid for; and the function returned the record as though the block were
settled. Because it did not throw, `pool/server.js` then released the
block-spool entry, so the last copy that could have re-offered the block went
with it. Nothing was logged.

Reading the replies is not the fix, and that is the part worth writing down.
By the time a reply can be read the round is already gone, and the retry it
would trigger recomputes the payouts from an empty round. The order is the
fix, and an order only means something if nothing can run between its parts.
`wamRecordBlock` in `pool/lib/atomic.js` writes the table with `HSETNX` and
lets nothing destructive run unless that succeeded. A refused table now costs
nothing: the round stands, the spool keeps the block, and the retry rebuilds
the same table from the same shares. The one command that can still fail after
the table is written is the fee counter, which is last for that reason — a
counter short by one block, repairable from `blocks:pending`, and loud.

Reported by Radenlingga (@stokraden45506) on 9 November 2026 against
`c10e015`, with a reproduction that drives this repository's own
`ShareProcessor` over a double with real pipeline semantics. He ran nothing
against the live pool, the explorer or the network. Held down by
`pool/test/record-block-commit.test.js`, which was run against the old commit
first: three of its five cases fail there.

**He also corrected this file.** The entry above said of the 8 November fix
that "every `exec()` is wrapped and its replies read". That was not true. It
was true of the payment commit and of `recordShare`; this call site and
`_orphan`'s bookkeeping were never touched, and the sentence covered them. He
read the code against the claim and found the gap. The sentence now says what
was actually done, `_orphan` reads its replies and logs them, and nothing in
`pool/` calls `exec()` unread.

Classified at 400 — the rung for denial of service against the pool — and said
as a judgement rather than a reading of the wording. The reporter suggested
1,000 by the precedent of the maturation gap above, with 250 as his own floor.
The maturation entry was classified at 1,000 *because 1,000 was the
denial-of-service rung* in the table of that day, in those words. That rung is
400 in the table published on 8 November, the day before this report arrived.
So the band is the same one and the precedent is kept rather than set aside.
Not 250: this is not hardening, it is one block's payout table, which is the
one thing here that cannot be rebuilt. And not read as a duplicate of the
7 November report: the fix for that report is what he read, and what he found
is where it stopped.

**400 WAM — a header a peer had already been punished for still bought twenty
milliseconds of the node, accepted 8 November 2026, PAID 9 November 2026.**
Paid with the two findings below it, in one transaction of 362 inputs, txid
`262f1813d6483d5b1f7bec160d932f1120bf7bc4874d788edbdeef72e3361a0c`, in block
38,089.

Verifying one block header costs this chain about twenty milliseconds of
RandomX light mode, against the microsecond a double-SHA256 costs Bitcoin, and
WAM-010 made `CheckBlockHeader` a no-op while WAM-013 moved the proof of work
into `ContextualCheckBlockHeader`, which holds `cs_main`. Forging a header that
reaches that check costs nothing: the parent is our own tip, which is public,
and `nBits` is `GetNextWorkRequired`, which anybody can compute.

The node did punish it. A failed proof of work is `BLOCK_INVALID_HEADER`, which
is `Misbehaving`, which discourages the address. What it did not do was stop
SPENDING on an address it had already punished — `net.cpp` accepts a discouraged
peer's next connection whenever the inbound slots are not nearly full. Upstream
means that leniency and it costs upstream a microsecond. It cost us the whole
defence: reconnect, send another ninety bytes, buy another twenty milliseconds,
without limit.

Reported by bobbyning on 8 November 2026, measured on an isolated regtest
instance of his own at 725 headers in fifteen seconds with one core at 95 per
cent. Nothing was run against the network. Fixed as WAM-027 in
`scripts/patch_upstream.py`: headers from a discouraged peer are dropped before
any proof of work is touched. Held down by
`test/functional/feature_wam_header_dos.py`, which connects over this machine's
ordinary address rather than the loopback, because
`MaybeDiscourageAndDisconnect` refuses to discourage a local address — a test
written on the loopback would have passed against the unfixed node for the
wrong reason. Shipped in v0.1.14.

Classified at 400, the denial-of-service rung, which is the rung the reporter
named.

**250 WAM — the treasury comment described the opposite of the value under it,
accepted 8 November 2026, PAID 9 November 2026.** Part of the same transaction
as the finding above.

`src/wam/chainparams.cpp` carried a comment saying the mainnet treasury address
was something other than what the line beneath it decodes to. The value is
right, has been since `a79835e` on 23 August 2026, and is what every block has
paid; the sentence above it was wrong. A consensus file is read by people
deciding whether to trust a chain, and a comment that contradicts its own code
is read as either a mistake or a trap. Reported by bobbyning.

**250 WAM — one hostile field in a block template hung the solo miner, accepted
8 November 2026, PAID 9 November 2026.** Part of the same transaction as the two
findings above.

`AsInt` converted a JSON number with a bare `int64_t(double)` cast. A double
whose truncated value does not fit is undefined in C++, and on x86-64 the
hardware hands back `0x8000000000000000`. So a node answering `"height": 1e300`
produced `-9223372036854775808` from a field that is arithmetically positive,
silently — and `HeightPush` then ran for ever on it, because an arithmetic right
shift of a negative number never reaches zero. One hostile field, one hung
miner, memory climbing until the OOM killer arrives. Reported by bobbyning.
Fixed in `miner/src/json.h` and `miner/src/solo_template.h`, and held down by
`miner/test/solo_template_test.cpp` — which hangs rather than fails against the
old code, so the runner kills it at twenty seconds.

It also produced the first fuzzer this project has ever run,
`scripts/fuzz_miner.sh`. gcc has had ASan and UBSan all along and nothing here
had ever been pointed at anything; against the code of that morning it hung on
case one.

**400 WAM — the fix for the finding above threw where nothing caught, and one
line from a pool ended the miner, accepted 9 November 2026, PAID 9 November
2026.** Paid with the `recordBlock` finding above, in the same transaction.

Making `AsInt` refuse an impossible number was right. Refusing by throwing was
right for the solo path, which catches. The stratum path caught nothing — not
`HandleLine`, not the pool loop in `miner/src/main.cpp` — and four call sites
handed a pool's number straight into it. So `{"id":1e300,"result":true}` reached
`std::terminate`, and the reference miner speaks no TLS, so every one of its
connections is plaintext and anyone on the path could send that line. Every
miner on a pool, dead together, and dead again on each reconnect.

Three of those four had written down a fallback saying exactly what they wanted
instead, and were thrown past anyway. `AsInt` is two forms now: the one with no
fallback throws, the one with a fallback returns it, and neither can produce a
garbage integer. The stratum dispatch is also total, because the first fix
depends on every future reader of that header choosing the right form.

Reported by Radenlingga (@stokraden45506) on 9 November 2026, the morning after
the fix that created it shipped to `main`, by reading the fix. No release
carried it: v0.1.13 is from 31 October and the throw landed on 8 November.

He also reported, and was right, that `contrib/wam-miner-android` still held the
unfixed `json.h` and `solo_template.h`. That tree keeps its own copy of the
miner's sources for the Gradle build, nothing was diffing them, and a fix
applied to one of two copies is a fix that was announced and not made. He did
not claim it separately and no amount was added for it;
`scripts/check_android_miner.py` now requires the Android tree to be the desktop
tree after two named edits, byte for byte. Held down by
`miner/test/stratum_hostile_test.cpp`, which opens a pool on the loopback and
drives `Poll()` the way `main.cpp` does, with no try/catch: against the old
miner it does not fail, it aborts. Shipped in v0.1.14.

**250 WAM — `getsupplyinfo` named the last block of the old epoch as the next
halving, accepted 9 November 2026, recorded and not claimed.**

`GetBlockSubsidy` counts halvings as `(nHeight - 1) / interval`, because block 0
mints the premine and would otherwise sit inside epoch 0 and leave it one block
short. So epoch *e* begins at `e * interval + 1`, and the RPC was missing that
`+ 1`: on regtest, standing at height 150, it reported the halving as 150 while
150 still paid 50 WAM and 151 was the first to pay 25. On mainnet it named
200,000 when the subsidy falls at 200,001, and `blocks_until_halving` reached
zero a block early.

Not a consensus or payout fault — what pays miners was always right. It is a
number we publish: `explorer/lib/collector.js` serves it and `bots/announce.js`
posts "Next halving in N blocks" from it, so the wrong figure reached the
channels and the explorer rather than stopping at an RPC nobody calls by hand.
That is the rung for something we publish that misleads.

Found by dang150296 (Urriki1502) in a second independent review that rebuilt the
patched Core from the v0.1.13 tag and ran native regtest, and reported with the
list of what he had NOT executed alongside what he had. When the RPC was fixed
he read the fix and found the same arithmetic written out four more times — in
the explorer and in the pool's API, in the branches that run when the node
cannot be asked, which is exactly when nobody is comparing the number against
anything. It is one function per package now rather than five copies of an
expression, held down by `explorer/test/halving.test.js` and
`pool/test/halving.test.js`.

He did not price it and no amount was paid. The rung is recorded, and it is
his whenever he asks for it.

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
curl -LO https://wamcoin.org/downloads/v0.1.14/SHA256SUMS.asc
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
