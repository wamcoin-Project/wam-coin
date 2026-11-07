# Checkpoints — the defence, and what it costs

A checkpoint is the hash of a real block, at a known height, compiled into
the software. A node running that release refuses any chain that does not
contain that block.

For a young chain it is the only defence against being out-mined that
actually works, and it is not a new idea: Litecoin, Dogecoin, Peercoin and
most others carried checkpoints through their early years and dropped them
once their hashrate made the question academic.

It is also a centralisation, and this document says so first rather than
last, because a defence that is described dishonestly is how people end up
trusting something they would not have chosen to trust.

---

## What it actually costs

**Every updated node trusts whoever cut the release.** Not the code — the
person. If the release names a block, every node that runs it will follow
whichever chain contains that block, and will refuse the longest chain if it
does not. That is a real transfer of authority from proof of work to a
maintainer, and at present the maintainer is one person.

**A wrong checkpoint cannot be undone.** Freezing a block that turns out to
be on a minority fork splits the network permanently: nodes with the release
can never rejoin the chain everyone else is on, and no later release fixes
it for anyone who has already synced past it. The only exit is a hard fork,
announced and coordinated, on a chain that has just proved it cannot
coordinate.

That asymmetry is why `scripts/make_checkpoint.py` refuses to emit anything
from a single node, and why it requires the block to be buried.

---

## The rules

1. **Two independent nodes minimum, and they must agree.** One node's view
   is not evidence. A node can be on a fork and report it with complete
   confidence, because from the inside a fork looks exactly like the chain.

2. **At least 1,000 blocks of burial** — about 33 hours at a two-minute
   target. A checkpoint that could still be reorganised out from under the
   release is a checkpoint on a guess. `--bury` can be raised, never
   quietly lowered.

3. **Never on the day of a release.** Generate the entry, read it, sleep,
   and check it again against a node the next morning. There is no situation
   where a checkpoint must be shipped within the hour that is not better
   served by telling exchanges to raise their confirmation counts.

4. **Genesis stays.** The `{0, hashGenesisBlock}` entry is not replaced by
   later ones; entries accumulate.

5. **Every checkpoint release is announced as one.** A release carrying a new
   checkpoint changes what a node will accept, so it is not optional in the
   way an ordinary release is. `scripts/consensus_floor.py` treats a change
   to chainparams as consensus-affecting and the release workflow demands a
   `MANDATORY:` line for it.

6. **They come off eventually.** Checkpoints are for the period when
   hashrate cannot defend the chain by itself. When it can, they stop being
   protection and remain only as authority, and authority nobody needs is
   authority that should be given up. There is no honest fixed date for
   that; there is a duty to keep asking.

---

## How

```bash
python3 scripts/make_checkpoint.py --network mainnet <host1> <host2>
```

It prints the block to add to `CMainParams` in `src/wam/chainparams.cpp`,
or refuses and says why. Refusals are the point of it.

---

## What we do not do, and will not

**No consensus rule refusing reorganisations beyond a fixed depth.** It is
the tempting version of this — no maintainer trust, no release needed, just
a rule saying the chain will not roll back more than N blocks.

It is a trap. During any network partition, each half accumulates more than
N blocks and then each half refuses to return to the other. A partition that
would have healed in an hour becomes two chains forever, and the coins on
each are real to the people holding them. Several chains have been broken
this way, and it is always discovered during the partition, when nothing can
be coordinated.

Bitcoin does not have this rule. It is not an oversight.

---

## Status

Mainnet opened on 2026-09-15. Measured on 2026-11-07 it was 36,672 blocks
high, so the 1,000-block burial rule has been satisfied since 16 September
and a checkpoint could be cut at any time.

**None has been cut.** `checkpointData` in `src/wam/chainparams.cpp` still
holds one entry on every network: the genesis block, which has to be there
because `GetHeight()` calls `rbegin()`. Said plainly rather than left in the
conditional, because a reader deciding what to trust needs to know which
release carries a checkpoint, and today the answer is none of them.

The decision is the one above: a checkpoint is protection and authority at
once, and the second half is why nobody should cut one because the chain is
old enough. What it needs is two agreeing nodes, the command below, and a
release whose notes say `MANDATORY:`.

Confirmation guidance, which is the lever that works from the first block
and needs nobody's cooperation, is in `docs/LISTING_PACKAGE.md` section 9.
