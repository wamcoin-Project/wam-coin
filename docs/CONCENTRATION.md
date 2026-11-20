# How concentrated is WAM's hash rate, and what we do about it

This file exists because of the first four hours of mainnet.

WAM opened at 00:00 UTC on 15 September 2026. By 00:19 one payout address had
found **77 of the first 79 blocks — 97.5%**. Nothing we had built asked that
question: fifty-four launch checks looked at units, clocks, ports, configs,
binaries, backups, peers and payouts, and not one of them looked at who was
producing the blocks. The first people to work it out were miners who had
mined all night and won nothing, in a chat, at half past two in the morning.
Two of them left.

So the number is measured, published, and written down here with what we do
about it — because a figure that lives only in a channel scrolls away, and the
people who need it most (a miner deciding where to point, an exchange deciding
whether to list) arrive weeks later.

---

## What is measured

The share of recent blocks found by the largest single payout address.

The coinbase of each block in a window is read and its **largest output**
taken. That is always the miner's: the treasury takes 5% of the subsidy by
consensus and the miner takes the remaining 95% plus every fee in the block,
so no halving and no fee spike can swap them round.

Two places do it:

| | window | where |
|---|---|---|
| `explorer/lib/concentration.js` | last 50 blocks **and** last 5040 | `https://explorer.wamcoin.org/api/concentration` |
| `scripts/check_concentration.py` | last 144, configurable | ops panel, every cycle, exit 1 at or above 50% |

5040 blocks is seven days at the 120-second target, and on a chain younger
than that it covers every block there has ever been. Both windows are
published and neither is the headline: the short one turns over in an hour and
a half, so three lucky blocks move it twenty points, while the long one
carries days that are already finished. A safety rule should be quick to say
*danger* and slow to say *safe*, which is why the commitments below are judged
on the long window.

`deploy/wam-concentration-log.sh` appends one reading an hour to
`/var/lib/wam-concentration/history.jsonl`, so the question "is this getting
better" has an answer that does not depend on when anybody happened to look.
It records both windows. For its first day it recorded only the short one — the
volatile number kept, and the number the commitments are written against
thrown away.

### What the number cannot tell you

**One address is not one person.** A pool pays its own address and then
distributes to its miners, so the coins spread out while the hash rate stays
under one operator's hand — and it is the hand, not the balance, that decides
whether a chain gets rewritten.

Measured on the first night: the address holding 93.8% was a pool of **46
workers**, reading its own public dashboard. That is the hopeful half of the
same fact. No new hash rate is needed to fix it; about 21 of those 46 moving
puts the network under 50%, and any of them can move in one command line.

**A large share is not an accusation.** The operator holding it on night one
announced themselves publicly, ran the published pool code, paid the treasury
in every block they found, answered within half an hour when asked about the
number, and agreed to point their own community at the other pools. None of
that changes the arithmetic, which is why this file prints numbers and not
adjectives.

---

## What follows from it

These are commitments about what the founder does. They bind nobody else:
anyone may list WAM, trade it, mine it, or ignore it.

**Above 50% held by one finder — withdrawn on 20 November 2026.** This read:
"no application to any exchange, no request to any exchange, no payment to
any exchange", and it is being retired by the founder's decision rather than
quietly dropped, because a commitment that disappears from a file is worse
than one that is openly withdrawn.

It was written for the opening weeks, when the chain was days old and a
single operator held 93.8% of it. The project is past that: the seven-day
window has twenty-six distinct finders.

What the sentence said about the risk has not changed and is not being
withdrawn. Above half the blocks, one party can reorganise the chain by one
decision, and a deposit sitting on an exchange across that reorganisation is
not safe. That was true when the promise was made and it is true now; the
promise governed what the founder would DO about it, and the arithmetic
governs what is true. This file goes on printing the number either way,
which is the whole point of it, and the figure below is current.

**The bar actually aimed at** — no single finder above **35% of blocks over
seven days**, with **at least three pools producing**. It is the line good
pools hold themselves to on other chains.

**The founder does not mine.** Unchanged from the whitepaper and `SECURITY.md`,
and it was put to the test on the first night: at 93.8% concentration, adding
the founder's own three machines would have moved the figure by about two
points and cost a published commitment. It was not done, and the machines were
stopped.

**Anyone accepting WAM should require depth while this lasts**, and the
depth follows the amount: 3 confirmations between two people for a small
amount, 20 for an ordinary one, 60 for an exchange deposit, 100 for anything
that matters -- which is the same depth consensus already requires before a
mined coin can move. The full table, with the reasoning and the date it was
last measured, is in docs/LISTING_PACKAGE.md.

---

## Readings

Hand-taken readings. The machine-written record is the hourly log.

| when (UTC) | height | recent window | whole chain | distinct |
|---|---|---|---|---|
| 2026-09-15 00:19 | 79 | 97.5% | — | 2 |
| 2026-09-15 00:41 | 82 | 97.6% (95.0% over the last 40) | — | 2 |
| 2026-09-15 01:35 | 106 | 91.7% | — | 3 |
| 2026-09-15 02:05 | 129 | 93.8% | — | 3 |
| 2026-09-15 02:40 | 149 | 91.7% | — | 2 |
| 2026-09-17 | ~1900 | 54% | 72.1% | 10 |
| 2026-09-18 10:04 | 2391 | 36.2% | 63.8% | 14 |

The figure moves in both directions, and the window is rolling — our own
blocks ageing out of it push the top share up without anybody mining
differently. A single reading proves nothing, which is exactly why the two
columns sit side by side: on 18 September the recent window read 36% and the
whole chain read 64%, and both were true.

Fourteen distinct finders now, and four independent pools serving the coin.
The recent window first went under 50% on 17 September. The whole-chain figure
is still above it, and the commitments above are judged on that one, so
nothing about them has changed yet.

---

## What actually changes it

Miners choosing a different pool, and nothing else. Not consensus, not a fork,
not a rule we could write. Three pools were producing blocks on the first
night, and the project's own pool dropped its fee to **0%** that night so that
choosing it costs a miner nothing — the project's pool has no business earning
from miners while one operator writes most of the chain.

A pool refusing new miners does not decentralise anything. It moves the
decision from the miner to the operator, which is the same concentration with
a different owner. That argument was made to us by the operator holding the
majority, and it is right.
