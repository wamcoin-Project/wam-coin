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

/**
 * Credit a matured block, exactly once, or do nothing at all.
 *
 * KEYS[1]  the set of blocks already credited   (blocks:credited)
 * KEYS[2]  balances
 * KEYS[3]  blocks:confirmed
 * KEYS[4]  blocks:confirmed:count
 * KEYS[5]  blocks:confirmed:hashes
 * KEYS[6]  blocks:maturing
 * ARGV[1]  the block hash
 * ARGV[2]  the evidence record, serialised
 * ARGV[3]  how many entries blocks:confirmed keeps
 * ARGV[4..] address, amount, address, amount, ...
 *
 * Returns 1 if this call credited it, 0 if it had already been credited.
 *
 * TWO PROPERTIES, AND THE SECOND ONE IS WHY THIS EXISTS.
 *
 * EXACTLY ONCE. SADD is the marker and it is tested here rather than by the
 * caller, so a second run of the identical command credits nobody twice. That
 * matters because the client re-sends: ioredis, on its defaults, replays
 * commands whose reply never arrived after a connection drops, and every
 * command below is an increment. Measured on 10 November 2026: balances
 * doubled, two identical entries in blocks:confirmed, and the call reporting
 * success. The claim script above could not see it -- it answered 0 the
 * second time and the pool logged "already claimed by another run", leaving
 * the block in blocks:maturing, uncredited, with no error.
 *
 * ALL OR NOTHING. Redis does not roll a script back when a command fails
 * partway, so anything that can be refused is checked BEFORE the first write.
 * A balance field holding a non-integer made HINCRBY fail in the middle of
 * the loop: one miner credited, the next not, the block marked confirmed, and
 * an operator message saying the block was not marked confirmed. Checking
 * first turns that into a refusal that changes nothing.
 *
 * Reported by dang150296 (Urriki1502) on 10 November 2026, reproduced against
 * a real Redis with the pool's own sources, three runs of three.
 */
const CREDIT_MATURED = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('TYPE', KEYS[1])['ok'] ~= 'set' then
    return redis.error_reply('credited-set is not a set')
  end
end
if redis.call('SADD', KEYS[1], ARGV[1]) ~= 1 then
  return 0
end

if redis.call('EXISTS', KEYS[2]) == 1 and redis.call('TYPE', KEYS[2])['ok'] ~= 'hash' then
  return redis.error_reply('balances is not a hash')
end
if redis.call('EXISTS', KEYS[3]) == 1 and redis.call('TYPE', KEYS[3])['ok'] ~= 'list' then
  return redis.error_reply('blocks:confirmed is not a list')
end
if redis.call('EXISTS', KEYS[5]) == 1 and redis.call('TYPE', KEYS[5])['ok'] ~= 'set' then
  return redis.error_reply('blocks:confirmed:hashes is not a set')
end
if redis.call('EXISTS', KEYS[6]) == 1 and redis.call('TYPE', KEYS[6])['ok'] ~= 'list' then
  return redis.error_reply('blocks:maturing is not a list')
end

local counter = redis.call('GET', KEYS[4])
if counter and not string.match(counter, '^%-?%d+$') then
  return redis.error_reply('blocks:confirmed:count is not an integer')
end

for i = 4, #ARGV, 2 do
  local who = ARGV[i]
  local amount = ARGV[i + 1]
  if not string.match(amount, '^%-?%d+$') then
    return redis.error_reply('payout amount for ' .. who .. ' is not an integer')
  end
  local held = redis.call('HGET', KEYS[2], who)
  if held and not string.match(held, '^%-?%d+$') then
    return redis.error_reply('balance for ' .. who .. ' is not an integer')
  end
end

for i = 4, #ARGV, 2 do
  redis.call('HINCRBY', KEYS[2], ARGV[i], ARGV[i + 1])
end
redis.call('LPUSH', KEYS[3], ARGV[2])
redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[3]) - 1)
redis.call('INCR', KEYS[4])
redis.call('SADD', KEYS[5], ARGV[1])
redis.call('LREM', KEYS[6], 0, ARGV[2])
return 1
`;

/** The name the pool calls it by, on the client and on any test double. */
const CREDIT_MATURED_NAME = 'wamCreditMatured';

/**
 * Credit one share, exactly once, or credit nothing and keep no claim.
 *
 * KEYS[1]  round:pow     the set of proofs already counted this round
 * KEYS[2]  round         worker -> difficulty credited
 * KEYS[3]  pplns         the recent-share window
 * KEYS[4]  hashrate      the sliding hash-rate set
 * ARGV[1]  the proof-of-work hash
 * ARGV[2]  the worker
 * ARGV[3]  the difficulty
 * ARGV[4]  the window entry
 * ARGV[5]  how many entries the window keeps
 * ARGV[6]  now, in milliseconds
 *
 * Returns 1 if this call credited it, 0 if the proof was already counted.
 *
 * THE CLAIM AND THE ACCOUNTING ARE ONE DECISION. THEY USED TO BE THREE.
 *
 * SADD took the claim, a MULTI did the accounting, and on any failure the
 * claim was handed back so the miner could resubmit. Each of those is
 * reasonable and together they paid for one proof five times:
 *
 *   The MULTI is not a unit against a command that fails at run time --
 *   redis applies the rest and hands the error back. So with round, pplns or
 *   hashrate holding the wrong type, the difficulty was credited, the window
 *   entry written, the claim released, and the miner told to resubmit. He
 *   did. Measured: five submissions of one proof credited 50 where 10 was
 *   owed, and in PPLNS terms the resubmitting miner took 4,318,181,819 base
 *   units against an honest miner's 431,818,181 for the same work.
 *
 *   And it needs no corruption at all. If only the EXEC reply is lost, the
 *   accounting ran, the claim is released, and the resubmission is credited
 *   again.
 *
 * The order here is the fix. Everything that can be refused is checked
 * BEFORE the claim is taken, so a refusal leaves no claim and no credit and
 * the miner may safely resubmit. The claim is then taken in the same script
 * as the writes, so a proof already counted -- by a duplicate, by a race, or
 * by the client re-sending a command whose reply was lost -- returns 0 and
 * changes nothing.
 *
 * Reported by dang150296 (Urriki1502) on 10 November 2026 as manifestation B
 * of one root cause, reproduced against a real Redis at four fault positions,
 * three runs of three.
 */
const CREDIT_SHARE = `
if redis.call('EXISTS', KEYS[1]) == 1 and redis.call('TYPE', KEYS[1])['ok'] ~= 'set' then
  return redis.error_reply('round:pow is not a set')
end
if redis.call('EXISTS', KEYS[2]) == 1 and redis.call('TYPE', KEYS[2])['ok'] ~= 'hash' then
  return redis.error_reply('round is not a hash')
end
if redis.call('EXISTS', KEYS[3]) == 1 and redis.call('TYPE', KEYS[3])['ok'] ~= 'list' then
  return redis.error_reply('pplns is not a list')
end
if redis.call('EXISTS', KEYS[4]) == 1 and redis.call('TYPE', KEYS[4])['ok'] ~= 'zset' then
  return redis.error_reply('hashrate is not a sorted set')
end

if tonumber(ARGV[3]) == nil then
  return redis.error_reply('share difficulty is not a number')
end

local held = redis.call('HGET', KEYS[2], ARGV[2])
if held and tonumber(held) == nil then
  return redis.error_reply('round credit for ' .. ARGV[2] .. ' is not a number')
end

if redis.call('SADD', KEYS[1], ARGV[1]) ~= 1 then
  return 0
end

redis.call('HINCRBYFLOAT', KEYS[2], ARGV[2], ARGV[3])
redis.call('LPUSH', KEYS[3], ARGV[4])
redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[5]) - 1)
redis.call('ZADD', KEYS[4], ARGV[6], ARGV[4])
return 1
`;

/** The name the pool calls it by, on the client and on any test double. */
const CREDIT_SHARE_NAME = 'wamCreditShare';

/**
 * Commit one payment that has already been broadcast, exactly once, or
 * change nothing at all.
 *
 * KEYS[1]  payments:done       the txids already committed
 * KEYS[2]  balances
 * KEYS[3]  paid
 * KEYS[4]  payments            the journal of payment records
 * KEYS[5]  payment:inflight    the marker written before the broadcast
 * KEYS[6]  payment:postponed
 * ARGV[1]  the transaction id
 * ARGV[2]  the payment record, serialised
 * ARGV[3]  how many payment records the journal keeps
 * ARGV[4..] address, amount, address, amount, ...
 *
 * Returns 1 if this call committed it, 0 if that txid was already committed.
 *
 * THE MARKER IS DELETED LAST, AND ONLY IF EVERYTHING ELSE SUCCEEDED.
 *
 * This was a MULTI, and a MULTI is one unit against a lost connection and no
 * unit at all against a command refused at run time: redis applies the rest
 * and hands the error back. `DEL payment:inflight` sat in the middle of it,
 * so a balance field holding a non-integer refused its HINCRBY and the
 * deletion ran anyway. The pool read the replies, saw the failure, logged
 * "THE COMMIT PARTLY FAILED" and paused -- correctly -- but the marker that
 * pause depends on was already gone. The restart found nothing, released
 * payments, rebuilt the same batch from the same balances and paid it again:
 * two confirmed transactions to one recipient, measured on regtest with the
 * money real.
 *
 * So every refusable value is checked before the first write; the deductions,
 * the journal entry and the markers follow; and the marker is removed only
 * after all of them are applied. If anything is wrong, nothing moves and the
 * marker stays -- which is the state the marker exists to describe.
 *
 * AND THE TXID IS THE IDENTITY. ioredis replays a command whose reply never
 * arrived, and every write below is an increment. A second delivery finds the
 * txid in payments:done, returns 0 and changes nothing, instead of deducting
 * every balance twice and driving a paid one to -300000000 while reporting
 * success. The caller treats 0 as "the first delivery landed", because that
 * is the only way a txid gets into that set.
 *
 * Reported by dang150296 (Urriki1502) on 10 November 2026 as manifestation C
 * of one root cause, with two confirmed regtest transactions for one owed
 * balance.
 */
const COMMIT_PAYMENT = `
if #ARGV < 5 then
  return redis.error_reply('wamCommitPayment refused: no payouts to commit')
end
if redis.call('EXISTS', KEYS[1]) == 1 and redis.call('TYPE', KEYS[1])['ok'] ~= 'set' then
  return redis.error_reply('wamCommitPayment refused: payments:done is not a set')
end
if redis.call('EXISTS', KEYS[2]) == 1 and redis.call('TYPE', KEYS[2])['ok'] ~= 'hash' then
  return redis.error_reply('wamCommitPayment refused: balances is not a hash')
end
if redis.call('EXISTS', KEYS[3]) == 1 and redis.call('TYPE', KEYS[3])['ok'] ~= 'hash' then
  return redis.error_reply('wamCommitPayment refused: paid is not a hash')
end
if redis.call('EXISTS', KEYS[4]) == 1 and redis.call('TYPE', KEYS[4])['ok'] ~= 'list' then
  return redis.error_reply('wamCommitPayment refused: payments is not a list')
end
if tonumber(ARGV[3]) == nil then
  return redis.error_reply('wamCommitPayment refused: journal limit is not a number')
end

for i = 4, #ARGV, 2 do
  local who = ARGV[i]
  local amount = ARGV[i + 1]
  if amount == nil or not string.match(amount, '^%d+$') then
    return redis.error_reply(
      'wamCommitPayment refused: amount paid to ' .. who .. ' is not a whole number of satoshi')
  end
  local owed = redis.call('HGET', KEYS[2], who)
  if owed and not string.match(owed, '^%-?%d+$') then
    return redis.error_reply(
      'wamCommitPayment refused: balance for ' .. who .. ' is not an integer')
  end
  local sent = redis.call('HGET', KEYS[3], who)
  if sent and not string.match(sent, '^%-?%d+$') then
    return redis.error_reply(
      'wamCommitPayment refused: paid total for ' .. who .. ' is not an integer')
  end
end

if redis.call('SADD', KEYS[1], ARGV[1]) ~= 1 then
  return 0
end

for i = 4, #ARGV, 2 do
  redis.call('HINCRBY', KEYS[2], ARGV[i], '-' .. ARGV[i + 1])
  redis.call('HINCRBY', KEYS[3], ARGV[i], ARGV[i + 1])
end
redis.call('LPUSH', KEYS[4], ARGV[2])
redis.call('LTRIM', KEYS[4], 0, tonumber(ARGV[3]) - 1)
redis.call('DEL', KEYS[5])
redis.call('DEL', KEYS[6])
return 1
`;

/** The name the pool calls it by, on the client and on any test double. */
const COMMIT_PAYMENT_NAME = 'wamCommitPayment';

/** Every script this pool requires, with the key count each one takes. */
const SCRIPTS = [
    { name: CLAIM_AND_RECORD_NAME, numberOfKeys: 2, lua: CLAIM_AND_RECORD },
    { name: RECORD_BLOCK_NAME, numberOfKeys: 4, lua: RECORD_BLOCK },
    { name: CREDIT_MATURED_NAME, numberOfKeys: 6, lua: CREDIT_MATURED },
    { name: CREDIT_SHARE_NAME, numberOfKeys: 4, lua: CREDIT_SHARE },
    { name: COMMIT_PAYMENT_NAME, numberOfKeys: 6, lua: COMMIT_PAYMENT }
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
    RECORD_BLOCK_NAME,
    CREDIT_MATURED,
    CREDIT_MATURED_NAME,
    CREDIT_SHARE,
    CREDIT_SHARE_NAME,
    COMMIT_PAYMENT,
    COMMIT_PAYMENT_NAME
};
