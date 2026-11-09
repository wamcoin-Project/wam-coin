'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  record-block-commit.test.js -- what the commit does when a command fails
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  recordBlock writes a block's payout table and closes the round that earned
//  it. Those are not two steps that happen to sit together: the round's shares
//  are the only thing that could rebuild the table, and the write that
//  replaces them is the only copy. Until 2026-11-09 both went out in a redis
//  pipeline whose replies nobody read.
//
//  A pipeline is a batch and not a transaction. When one command fails
//  server-side the others are still applied and exec() still resolves, so the
//  worst case was the first command failing: no payout table, the round
//  deleted anyway, the pool fee booked for a block nobody would ever be paid
//  for -- and recordBlock returning the record as if the block were settled,
//  which made server.js release the block-spool entry too. The last copy that
//  could have re-offered the block went with the rest, and nothing was logged.
//
//  Reported by Radenlingga (@stokraden45506) on 2026-11-09 against c10e015.
//
//  WHY THE ASSERTIONS NAME NO MECHANISM
//
//  Every case below says only what must be true of the keys afterwards, so
//  this file runs against the pipeline version and against the script that
//  replaced it. That is how it was shown to test something: checked out over
//  the old shareProcessor.js, cases two and three fail -- the round destroyed
//  with no table written, and a function that reported success while doing it.
//
//  The case this directory did not have before is the FAILING one. One test
//  reached these four lines and watched them succeed; nothing anywhere asked
//  what they do when redis refuses one.
// ===========================================================================

const assert = require('assert');

const ShareProcessor = require('../lib/shareProcessor');
const { attachAtomic } = require('./fakeAtomic');
const { attachMulti } = require('./fakeMulti');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

const HASH = 'aa'.repeat(32);
const WORKER = 'Wd2cHTHQFNVKdoZJQJcPd1KvPTkPESjDPE.rig1';

/**
 * A redis double that refuses one command the way a server refuses it.
 *
 * `failOn` is 'hset' (the payout table's key holds the wrong type) or
 * 'incrby' (the fee counter holds something that is not an integer). Both are
 * states this code cannot itself produce -- they come from an operator tool, a
 * manual edit, a future writer -- which is why the report was about the
 * silence rather than about reaching it.
 *
 * The refusal is modelled at the store, so it bites whichever way the commit
 * is written: the pipeline's hset and incrby go through the same objects the
 * script's HSETNX and INCRBY do.
 */
function fakeRedis(failOn) {
    // Mutable, so a test can let the operator fix the key and watch the block
    // be offered again -- which is the whole reason for throwing rather than
    // logging.
    let refuse = failOn;
    const h = new Map([
        ['wam:blocks:pending', new Map()],
        // A live PROP round: one worker with a hundred shares in it.
        ['wam:round', new Map([[WORKER, '100']])],
        ['wam:round:pow', new Map([['someproof', '1']])]
    ]);
    const l = new Map();
    const sets = new Map();
    const counters = new Map([['wam:poolfees', 0]]);

    const raw = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
    const list = (k) => { if (!l.has(k)) l.set(k, []); return l.get(k); };

    // A façade, so a refused write throws from inside the store rather than
    // being filtered by the code under test. A double that refuses politely
    // teaches the caller nothing.
    const hash = (k) => {
        const m = raw(k);
        return {
            has: (f) => m.has(f),
            get: (f) => m.get(f),
            delete: (f) => m.delete(f),
            clear: () => m.clear(),
            set: (f, v) => {
                if (refuse === 'hset' && k === 'wam:blocks:pending') {
                    throw new Error('WRONGTYPE Operation against a key ' +
                                    'holding the wrong kind of value');
                }
                return m.set(f, v);
            }
        };
    };
    const fee = (k, n) => {
        if (refuse === 'incrby') {
            throw new Error('ERR value is not an integer or out of range');
        }
        counters.set(k, (counters.get(k) || 0) + n);
    };

    const ops = {
        async hexists(k, f) { return raw(k).has(f) ? 1 : 0; },
        async hgetall(k) { return Object.fromEntries(raw(k)); },
        async hset(k, f, v) { hash(k).set(f, v); return 1; },
        async hdel(k, f) { return raw(k).delete(f) ? 1 : 0; },
        async del(k) { raw(k).clear(); return 1; },
        async incrby(k, n) { fee(k, Number(n)); return counters.get(k); },
        async lrange(k) { return list(k).slice(); },
        async lpush(k, v) { list(k).unshift(v); return list(k).length; },
        async ltrim() { return 'OK'; },
        async lrem() { return 1; },
        async incr() { return 1; },
        async decrby() { return 0; },
        async sadd(k, v) {
            if (!sets.has(k)) sets.set(k, new Set());
            const before = sets.get(k).size;
            sets.get(k).add(v);
            return sets.get(k).size > before ? 1 : 0;
        },
        async sismember(k, v) {
            return sets.has(k) && sets.get(k).has(v) ? 1 : 0;
        },

        // ioredis semantics, for running this file against the old commit:
        // one [error, result] pair per command, and the commands that do not
        // fail ARE applied.
        pipeline() {
            const queued = [];
            const p = {};
            for (const n of ['hset', 'del', 'incrby', 'hdel', 'lpush',
                             'ltrim', 'lrem', 'incr', 'decrby', 'sadd']) {
                p[n] = (...a) => { queued.push([n, a]); return p; };
            }
            p.exec = async () => {
                const out = [];
                for (const [n, a] of queued) {
                    try { out.push([null, await ops[n](...a)]); }
                    catch (e) { out.push([e, null]); }
                }
                return out;
            };
            return p;
        },

        // what the assertions read
        _heal: () => { refuse = null; },
        _pending: () => raw('wam:blocks:pending'),
        _round: () => raw('wam:round'),
        _pow: () => raw('wam:round:pow'),
        _fees: () => counters.get('wam:poolfees')
    };

    attachAtomic(ops, hash, list, { drop: (k) => raw(k).clear(), fee });
    attachMulti(ops);
    return ops;
}

function processorOver(redis) {
    return new ShareProcessor(
        redis,
        { async getBlock() { return { confirmations: 1, height: 1, tx: ['a'] }; } },
        { redisPrefix: 'wam', coinbaseMaturity: 100,
          rewardMode: 'prop', poolFeePercent: 1 },
        { info() {}, warn() {}, error() {}, debug() {} });
}

function share() {
    return {
        blockHash: HASH, height: 123, worker: WORKER,
        coinbaseValue: 5000000000,      // 50 WAM
        devFeeAmount: 250000000,        // 2.5 WAM, paid by consensus
        distributableValue: 4750000000  // 47.5 WAM to split
    };
}

/** Run recordBlock and say what came back, without the throw ending the run. */
async function record(sp) {
    try { return { value: await sp.recordBlock(share()), threw: null }; }
    catch (err) { return { value: undefined, threw: err }; }
}

(async () => {
    console.log(`\n${BLD}  a block is recorded, or nothing is destroyed${OFF}\n`);

    await test('the ordinary commit writes the table and closes the round', async () => {
        const redis = fakeRedis(null);
        const { value, threw } = await record(processorOver(redis));
        assert.ifError(threw);
        assert.ok(value, 'recordBlock returned nothing for a block it recorded');
        assert.ok(redis._pending().has(HASH), 'the payout table was not written');
        assert.strictEqual(redis._round().size, 0, 'the round was left open');
        assert.strictEqual(redis._pow().size, 0,
            'the proof-of-work set outlived the round it belongs to');
        assert.strictEqual(redis._fees(), 47500000,
            'the pool fee was not booked');
        assert.strictEqual(JSON.parse(redis._pending().get(HASH)).payouts[WORKER],
            4702500000, 'the table does not say what the worker is owed');
    });

    await test('a refused table destroys nothing -- the round survives it', async () => {
        // THE CASE THE PIPELINE FAILED. Against the old commit the hset came
        // back as an [error, null] pair nobody read, and the two dels and the
        // incrby were applied regardless: the round gone, the fee booked, and
        // no table anywhere. Nothing could rebuild it and nothing said so.
        const redis = fakeRedis('hset');
        const { value, threw } = await record(processorOver(redis));

        assert.ok(!redis._pending().has(HASH),
            'the table was written although the store refused it');
        assert.strictEqual(redis._round().get(WORKER), '100',
            'the round was destroyed although the table that replaces it was '
            + 'never written -- nothing can say who is owed what for this block');
        assert.strictEqual(redis._pow().size, 1,
            'the claim set was destroyed although nothing replaced the round');
        assert.strictEqual(redis._fees(), 0,
            'the pool fee was booked for a block with no payout table');
        assert.ok(threw && !value,
            'recordBlock reported success after a refused commit, so '
            + 'server.js releases the block-spool entry and the last copy of '
            + 'the block goes with it');
    });

    await test('and the block can simply be offered again', async () => {
        // The point of throwing rather than logging: the spool keeps the
        // entry, the drain re-offers it, and the retry recomputes the SAME
        // table from the round that was never destroyed.
        const redis = fakeRedis('hset');
        await record(processorOver(redis));

        redis._heal();   // the operator fixed the key's type
        const second = await record(processorOver(redis));
        assert.ifError(second.threw);
        assert.ok(second.value, 'the retry did not record the block');
        assert.strictEqual(second.value.payouts[WORKER], 4702500000,
            'the retry did not rebuild the same payout table, so the first '
            + 'failure cost the round after all');
    });

    await test('a refused fee leaves the table standing', async () => {
        // The cheap direction, and it is last in the script so that it is the
        // only one available once the table is written: the block is recorded
        // and the round is closed, a counter is short by one block, and the
        // failure is loud rather than silent.
        const redis = fakeRedis('incrby');
        const { value, threw } = await record(processorOver(redis));

        assert.ok(redis._pending().has(HASH),
            'the payout table was lost over a fee counter');
        assert.strictEqual(redis._fees(), 0, 'the fee was booked after all');
        assert.ok(threw && !value,
            'the refusal was swallowed: recordBlock reported success over a '
            + 'fee that was never booked, which is the silence this whole '
            + 'file exists about. An accounting write that fails must be '
            + 'seen, even when what it costs is only a counter.');
        assert.strictEqual(redis._round().size, 0,
            'the throw left the round open although the table was written, '
            + 'so the next block would pay these shares a second time');
    });

    await test('a block already recorded destroys nothing a second time', async () => {
        const redis = fakeRedis(null);
        await record(processorOver(redis));
        // a new round, opened by the miners who kept working
        redis._round().set(WORKER, '55');

        const { value } = await record(processorOver(redis));
        assert.strictEqual(value, null,
            'recordBlock recorded the same block twice');
        assert.strictEqual(redis._round().get(WORKER), '55',
            'the second call destroyed a round that belongs to the NEXT '
            + 'block, so that work is paid to nobody');
        assert.strictEqual(redis._fees(), 47500000,
            'the pool fee was booked twice for one block');
    });

    console.log();
    if (!fail.length) {
        console.log(`${GRN}${BLD}${pass} passed: the table is written before anything is destroyed${OFF}\n`);
    } else {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
    }
    process.exit(fail.length ? 1 : 0);
})();
