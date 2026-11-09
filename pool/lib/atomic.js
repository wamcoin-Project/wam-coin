'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  atomic.js -- the one state change that must not be interruptible
// ===========================================================================
//
//  WHY THIS FILE EXISTS
//
//  A block this pool found exists in exactly one place between finding it and
//  paying for it: the blocks:pending field that holds its payout table. The
//  round's shares -- the raw record of who did the work -- are deleted in the
//  same breath that writes it:
//
//      pipe.hset(this.k('blocks:pending'), share.blockHash, ...)
//      pipe.del(this.k('round'));           // PROP round closes here
//
//  So that one field is not a copy of anything. It is the only surviving
//  statement of what every miner in the round is owed, and nothing anywhere
//  can reconstruct it.
//
//  Maturation then moved the block out of pending in two separate commands:
//  HDEL first, because the delete is what makes exactly one caller the
//  winner, and LPUSH of the evidence second. Between those two awaits the
//  block belonged to no state at all -- deleted from pending, absent from
//  maturing, not credited -- and a crash, a dropped connection or a Redis
//  failover in that window destroyed the payout table outright. The coins sat
//  in the pool's wallet and nobody, not the pool and not an operator by hand,
//  could say whose they were.
//
//  The code knew about the window and argued for it:
//
//      Losing a credit is recoverable; paying it twice is not, so the
//      order is deliberate.
//
//  The second half is true. The first half was not, and that is the whole
//  defect: a deliberate trade-off resting on a premise that the line
//  deleting blocks:round had already falsified. There was no recovery to
//  fall back on.
//
//  Reported by Smooth Jazz Crypto (@smoothjazcrypto) on 2026-10-12 against 87ac8f0, with the fix: make the
//  transition one server-side operation. Redis runs a script to completion
//  before anything else, so there is no window to crash in. The same shape
//  was in _orphan, which this covers too -- found while fixing this one, not
//  reported.
//
//  AND THEN THE TWO LINES QUOTED ABOVE, WHICH WERE THE REAL ONES
//
//  The quotation at the top of this file is not an illustration. It was the
//  live code until 2026-11-09, and it was a pipeline whose replies nobody
//  read -- so when the HSET failed server-side, redis applied the DEL that
//  follows it anyway, exec() resolved, and recordBlock returned the record as
//  if the block were settled. The payout table was never written, the round
//  that could have rebuilt it was deleted, the pool fee was booked for a
//  block nobody would ever be paid for, and because nothing threw, server.js
//  released the block-spool entry too -- the last copy that could have
//  re-offered the block, discarded with the rest. Nothing was logged.
//
//  Reading the replies is not the fix. By the time a reply can be read the
//  round is already gone, and the retry it would trigger recomputes the
//  payouts from an empty round. The ORDER is the fix: write the statement
//  nothing can rebuild, and let nothing destructive run unless it succeeded.
//  A script is how those two become one thing, which is the answer this file
//  already gave the maturation window in October.
//
//  Reported by Radenlingga (@stokraden45506) on 2026-11-09 against c10e015,
//  with a repro that drives the pool's own ShareProcessor over a Redis double
//  with real pipeline semantics. He also reported, correctly, that the
//  sentence this project had published about the November fix -- that every
//  exec() was now wrapped and its replies read -- was not true of this call
//  site.
//
//  WHY NOT MULTI/EXEC
//
//  MULTI/EXEC is atomic in execution but cannot branch: the "exactly one
//  winner" rule depends on reading what HDEL returned and only then writing
//  the evidence, and inside a transaction that return value is not available
//  until the whole thing has run. WATCH with a retry loop would work and is
//  more moving parts than a four-line script.
//
//  WHY NO FALLBACK
//
//  defineAtomicCommands throws if the client cannot take the script. A
//  fallback to the two-command version would be the defect, back again,
//  reachable by configuration -- and silent, because the window only opens
//  when something else is already going wrong.
// ===========================================================================

/**
 * Move one field out of a hash and record it in a list, or do neither.
 *
 * KEYS[1]  the hash holding the claim      (blocks:pending)
 * KEYS[2]  the list that keeps the evidence (blocks:maturing, blocks:orphaned)
 * ARGV[1]  the field                        (the block hash)
 * ARGV[2]  the evidence                     (the record, serialised)
 *
 * Returns 1 if this caller claimed it, 0 if somebody else already had.
 *
 * HDEL first so the return value decides, exactly as the two-command version
 * did -- the difference is that nothing can run between the two lines.
 */
const CLAIM_AND_RECORD = `
if redis.call('HDEL', KEYS[1], ARGV[1]) ~= 1 then
  return 0
end
redis.call('LPUSH', KEYS[2], ARGV[2])
return 1
`;

/** The name the pool calls it by, on the client and on any test double. */
const CLAIM_AND_RECORD_NAME = 'wamClaimAndRecord';

/**
 * Record a found block, and close the round it was found in, or do neither.
 *
 * KEYS[1]  the hash of payout tables          (blocks:pending)
 * KEYS[2]  the round's shares                 (round)
 * KEYS[3]  the round's proof-of-work set      (round:pow)
 * KEYS[4]  the pool-fee counter               (poolfees)
 * ARGV[1]  the block hash
 * ARGV[2]  the payout record, serialised
 * ARGV[3]  the pool fee, in satoshi
 *
 * Returns 1 if this caller recorded it, 0 if the hash was already there.
 *
 * The order is load-bearing, not stylistic.
 *
 *   HSETNX first, because it writes the only statement of who is owed what.
 *   If redis refuses it -- wrong type, out of memory, anything -- the script
 *   stops on that line and the three below it never run. The round is still
 *   there, the spool entry is still there, and the block can simply be
 *   offered again, which recomputes the same table from the same shares.
 *
 *   DEL after, because it destroys those shares, and nothing may destroy
 *   them until what replaces them is on disk.
 *
 *   INCRBY last, because it is the one command here that can fail at run
 *   time once HSETNX has passed (a counter holding a non-integer). Failing
 *   there aborts the script with the record written and the round closed --
 *   a fee counter that is short by one block, repairable from
 *   blocks:pending, and nobody paid twice. That is the cheap direction, and
 *   it is last so that it is the only one available.
 *
 * HSETNX rather than HSET so that two runs racing on the same block cannot
 * both pass. The loser gets 0 and destroys nothing. recordBlock asks the
 * same question before calling this -- over three separate awaits, which is
 * three chances to be overtaken; this answer cannot be raced.
 */
const RECORD_BLOCK = `
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) ~= 1 then
  return 0
end
redis.call('DEL', KEYS[2], KEYS[3])
redis.call('INCRBY', KEYS[4], ARGV[3])
return 1
`;

/** The name the pool calls it by, on the client and on any test double. */
const RECORD_BLOCK_NAME = 'wamRecordBlock';

/** Every script this pool requires, with the key count each one takes. */
const SCRIPTS = [
    { name: CLAIM_AND_RECORD_NAME, numberOfKeys: 2, lua: CLAIM_AND_RECORD },
    { name: RECORD_BLOCK_NAME, numberOfKeys: 4, lua: RECORD_BLOCK }
];

/**
 * Teach an ioredis client the scripts this pool needs, once.
 *
 * Idempotent: a client that already has the command is left alone, so a
 * second ShareProcessor over the same client is not an error.
 */
function defineAtomicCommands(redis) {
    if (!redis) {
        throw new Error('defineAtomicCommands: no redis client');
    }
    for (const script of SCRIPTS) {
        if (typeof redis[script.name] === 'function') continue;
        if (typeof redis.defineCommand !== 'function') {
            throw new Error(
                `this redis client has neither ${script.name} nor ` +
                'defineCommand, so a state change that must not be ' +
                'interruptible cannot be made atomic. Refusing to run: the ' +
                "multi-command version loses a block's entire payout table " +
                'if it is interrupted or refused partway, and the round ' +
                'shares that would rebuild it are already gone.');
        }
        redis.defineCommand(script.name, {
            numberOfKeys: script.numberOfKeys,
            lua: script.lua
        });
    }
    return redis;
}

module.exports = {
    defineAtomicCommands,
    SCRIPTS,
    CLAIM_AND_RECORD,
    CLAIM_AND_RECORD_NAME,
    RECORD_BLOCK,
    RECORD_BLOCK_NAME
};
