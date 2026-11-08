'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// A block may be credited to miners exactly once.
//
// Reported 2026-09-14 by an outside reviewer, eleven hours before mainnet, as
// a pool block-maturation race: the same pending block could mature more than
// once and every miner on it was credited twice, out of the operator's own
// wallet, with nothing in the logs looking wrong.
//
// Two independent paths reached it, which is why the fix is two things:
//
//   1. checkPendingBlocks() had no re-entrancy guard, while processPayments()
//      has had one since 14 August. It is called from a 60-second interval AND
//      from the shutdown handler in server.js -- "one last payment run so
//      miners are not left waiting on a restart" -- so an operator restart
//      during a maturation check ran both at once. Both read the same
//      blocks:pending, both saw 100 confirmations, both credited.
//
//   2. _mature() credited balances and deleted the pending record in one
//      redis.pipeline(), which batches commands into a single round trip and
//      is NOT a transaction. A crash or dropped connection between them left
//      the balance credited and the block still pending, so the next run
//      credited it again.
//
// The fix is the claim: HDEL returns how many fields it removed, so exactly
// one caller gets 1 and only that caller credits. These tests hold that down
// against re-entrancy, against a second process, and against a crash in the
// window -- because a change that fixes one of the three alone is the bug
// coming back.
// ---------------------------------------------------------------------------

const assert = require('assert');
const ShareProcessor = require('../lib/shareProcessor');
const { attachAtomic, attachUnsupported } = require('./fakeAtomic');
const { attachMulti } = require('./fakeMulti');

let pass = 0;
const fail = [];

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

/**
 * Enough of Redis to answer the only question these tests ask, with HDEL
 * behaving as Redis does: it returns the number of fields actually removed.
 */
function fakeRedis() {
    const h = new Map();          // key -> Map(field -> value)
    const l = new Map();          // key -> array
    const hash = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
    const list = (k) => { if (!l.has(k)) l.set(k, []); return l.get(k); };

    const counters = new Map();
    const ops = {
        async hgetall(k) { return Object.fromEntries(hash(k)); },
        async hexists(k, f) { return hash(k).has(f) ? 1 : 0; },
        async hdel(k, f) { return hash(k).delete(f) ? 1 : 0; },
        async hset(k, f, v) { hash(k).set(f, v); return 1; },
        async hincrby(k, f, n) {
            const cur = Number(hash(k).get(f) || 0) + Number(n);
            hash(k).set(f, String(cur));
            return cur;
        },
        async lpush(k, v) { list(k).unshift(v); return list(k).length; },
        async ltrim() { return 'OK'; },
        // recordBlock reads blocks:maturing whole, to find a block that was
        // claimed for maturation and interrupted before it was credited.
        // Such a block is in neither pending nor confirmed:hashes, so
        // without this it passed the "already paid?" test and could be
        // recorded a second time.
        async lrange(k, start, stop) {
            const arr = list(k);
            const end = stop === -1 ? arr.length : stop + 1;
            return arr.slice(start, end);
        },
        async lrem(k, _c, v) {
            const arr = list(k);
            const i = arr.indexOf(v);
            if (i === -1) return 0;
            arr.splice(i, 1);
            return 1;
        },
        async decrby() { return 0; },
        // blocks:confirmed:hashes -- the set recordBlock asks before
        // paying, so a recovered block cannot be paid a second time.
        _sets: new Map(),
        async sadd(k, v) {
            if (!ops._sets.has(k)) ops._sets.set(k, new Set());
            const before = ops._sets.get(k).size;
            ops._sets.get(k).add(v);
            return ops._sets.get(k).size > before ? 1 : 0;
        },
        async sismember(k, v) {
            return ops._sets.has(k) && ops._sets.get(k).has(v) ? 1 : 0;
        },
        async incr(k) {
            const cur = Number(counters.get(k) || 0) + 1;
            counters.set(k, cur);
            return cur;
        },
        pipeline() {
            const queued = [];
            const api = {};
            // 'incr' is here because shareProcessor keeps blocks:confirmed:count
            // and blocks:orphaned:count, which nothing trims -- the dashboard's
            // block total used to be the length of a list that is cut at 5000
            // and so stopped moving at 5000. A fake that does not know a command
            // the code under test calls does not fail that command; it fails the
            // test, with "pipe.incr is not a function", and these two are payout
            // tests.
            for (const name of ['hincrby', 'hdel', 'hset', 'lpush', 'ltrim', 'lrem', 'decrby', 'incr', 'sadd']) {
                api[name] = (...args) => { queued.push([name, args]); return api; };
            }
            // A pipeline is a batch, not a transaction: it runs the commands in
            // order and stops at nothing. crashAfter simulates the process dying
            // partway through, which is the window the old code lived in.
            api.exec = async () => {
                for (let i = 0; i < queued.length; i++) {
                    if (ops._crashAfter !== undefined && i >= ops._crashAfter) {
                        throw new Error('connection lost mid-pipeline');
                    }
                    const [name, args] = queued[i];
                    await ops[name](...args);
                }
                return [];
            };
            return api;
        },
        _dump: { h, l }
    };
    attachAtomic(ops, hash, list);
    // _mature credits through MULTI now, not a pipeline: a connection lost
    // during the credit must leave no balance touched at all, rather than
    // the first few miners credited and the rest not.
    attachMulti(ops);
    return ops;
}

function processorWith(redis, confirmations) {
    // constructor(redis, daemon, config, logger) -- positional, not an object.
    const daemon = {
        // The real path is daemon.getBlock(hash, 1), not a generic call().
        async getBlock() { return { confirmations, height: 9000, tx: ['ab'] }; }
    };
    return new ShareProcessor(
        redis,
        daemon,
        { redisPrefix: 'wam', coinbaseMaturity: 100 },
        { info() {}, warn() {}, error() {}, debug() {} }
    );
}

const RECORD = {
    height: 9000,
    // The hash is what recordBlock keys its idempotence on, and what the
    // pending hash is keyed by throughout this file. Without it here, a test
    // asserting "this hash was remembered" asserts that `undefined` was
    // remembered, and passes while proving nothing.
    blockHash: 'H',
    minerPot: 4750000000,
    poolFee: 0,
    workers: 2,
    payouts: { 'twam1aaa.rig1': 2375000000, 'twam1bbb.rig2': 2375000000 }
};

function balances(redis) {
    return Object.fromEntries(redis._dump.h.get('wam:balances') || new Map());
}

(async () => {
    console.log('\na block is credited to miners exactly once');

    await test('two concurrent _mature calls credit once, not twice', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
        const sp = processorWith(r, 120);
        await Promise.all([
            sp._mature('H', { ...RECORD }),
            sp._mature('H', { ...RECORD })
        ]);
        const b = balances(r);
        assert.strictEqual(b.twam1aaa, '2375000000', `credited ${b.twam1aaa}`);
        assert.strictEqual(b.twam1bbb, '2375000000', `credited ${b.twam1bbb}`);
    });

    await test('the loser of the claim credits nothing at all', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
        const sp = processorWith(r, 120);
        await sp._mature('H', { ...RECORD });      // winner
        await sp._mature('H', { ...RECORD });      // loser: pending is gone
        assert.strictEqual(balances(r).twam1aaa, '2375000000');
    });

    await test('checkPendingBlocks is not re-entrant', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
        const sp = processorWith(r, 120);
        // The interval and the shutdown handler, overlapping -- the exact
        // trigger in the report.
        await Promise.all([sp.checkPendingBlocks(), sp.checkPendingBlocks()]);
        assert.strictEqual(balances(r).twam1aaa, '2375000000');
    });

    await test('a crash inside the credit leaves evidence and never doubles', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
        const sp = processorWith(r, 120);
        r._multiFails = 'connection lost before EXEC';
        await sp._mature('H', { ...RECORD }).catch(() => {});
        r._multiFails = undefined;

        const maturing = r._dump.l.get('wam:blocks:maturing') || [];
        assert.strictEqual(maturing.length, 1,
            'the claimed block must be recorded before crediting starts');
        assert.strictEqual((await r.hgetall('wam:blocks:pending')).H, undefined,
            'the claim must be gone, so a later run cannot credit it again');

        // AND NOT ONE MINER IS CREDITED, WHICH IS THE POINT OF THE CHANGE.
        //
        // With a pipeline this asserted 2375000000 -- the first hincrby had
        // been applied and the rest had not, so one miner held a credit for
        // a block whose maturation never finished and whose other miners got
        // nothing. The payout table was split across a failure. MULTI is one
        // unit: the credit either happens whole or not at all, and the
        // evidence in blocks:maturing is then a complete record of what is
        // owed rather than a record of what is partly owed.
        assert.strictEqual(balances(r).twam1aaa, undefined,
            'a credit interrupted mid-transaction must leave no balance at all');
    });

    await test('a block stranded in maturing is not recorded a second time', async () => {
        // The gap bobbyning found on 2026-11-07: a block claimed for
        // maturation and interrupted before the credit is in neither
        // blocks:pending nor blocks:confirmed:hashes, so recordBlock's
        // "already paid?" test used to wave it through. The spool drain
        // offers exactly such a block, and recording it again runs
        // del(round) -- wiping a live round -- and puts it back in pending
        // for a second payout.
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
        const sp = processorWith(r, 120);

        r._multiFails = true;
        await sp._mature('H', { ...RECORD }).catch(() => {});
        r._multiFails = undefined;

        assert.strictEqual((r._dump.l.get('wam:blocks:maturing') || []).length, 1,
            'the block must be sitting in maturing for this test to mean anything');
        assert.strictEqual((await r.hgetall('wam:blocks:pending')).H, undefined,
            'and it must not be in pending, or the old check would catch it');

        const again = await sp.recordBlock({
            height: RECORD.height, blockHash: RECORD.blockHash,
            worker: 'twam1aaa', coinbaseValue: RECORD.coinbaseValue,
            distributableValue: RECORD.minerPot, devFeeAmount: 0
        });
        assert.strictEqual(again, null,
            'recordBlock must refuse a block that is already maturing');
        assert.strictEqual((await r.hgetall('wam:blocks:pending'))[RECORD.blockHash],
            undefined, 'and must not put it back in pending for a second payout');
    });

    await test('a matured block still lands in blocks:confirmed', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
        const sp = processorWith(r, 120);
        await sp._mature('H', { ...RECORD });
        assert.strictEqual((r._dump.l.get('wam:blocks:confirmed') || []).length, 1);
        assert.strictEqual((r._dump.l.get('wam:blocks:maturing') || []).length, 0,
            'the evidence entry is removed once the credit is through');
    });

    await test('a matured block hash is remembered, so it cannot be paid again', async () => {
        // recordBlock asks two questions before paying: is this block already
        // pending, and has it already been confirmed? The second needs a list
        // that nothing trims -- blocks:confirmed is cut at 5000 and the counter
        // is a number -- so the hashes go into a set as blocks mature.
        //
        // The spool drain is what made this necessary: it offers a recovered
        // block for payout without knowing whether the crash happened before
        // or after the original accounting, and a block recovered after it had
        // matured would otherwise be paid twice.
        //
        // Found by dang150296 (Urriki1502) against bb6d521.
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
        const sp = processorWith(r, 120);
        await sp._mature('H', { ...RECORD });
        assert.strictEqual(await r.sismember('wam:blocks:confirmed:hashes', RECORD.blockHash), 1,
            'a confirmed block leaves no record of its hash, so recordBlock '
            + 'cannot tell whether it has already been paid');
    });

    await test('recording the same block twice pays once and wipes no round', async () => {
        // Emitting a recovered block for payout is only safe if asking twice
        // costs nothing. recordBlock also runs del(round) and incr(poolfees),
        // so a second call used to wipe a LIVE round -- every miner losing the
        // work they had done since the last block -- and double-count the fee.
        const r = fakeRedis();
        const sp = processorWith(r, 120);
        await r.hset('wam:blocks:pending', RECORD.blockHash, JSON.stringify(RECORD));
        await r.hset('wam:round', 'carol', '500');      // a new round is under way

        const again = await sp.recordBlock({
            height: RECORD.height, blockHash: RECORD.blockHash, worker: 'bob',
            coinbaseValue: 5000000000, distributableValue: 4750000000,
            devFeeAmount: 250000000
        });

        assert.strictEqual(again, null,
            'the same block was recorded twice, so it will be paid twice');
        assert.strictEqual((await r.hgetall('wam:round')).carol, '500',
            'the second recording wiped a live round; every miner in it lost '
            + 'the work done since the last block');
    });

    console.log(fail.length
        ? `\n  ${fail.length} failure(s): ${fail.join(', ')}\n`
        : `\n  ${pass} checks: a block cannot be credited twice\n`);
    process.exit(fail.length ? 1 : 0);
})();
