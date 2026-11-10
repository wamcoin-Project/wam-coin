'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  credit-idempotent.test.js -- the same credit twice pays once
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  The maturation credit used to be a MULTI whose replies were read after it
//  ran. That is one unit against a lost connection and no unit at all against
//  two things:
//
//    A COMMAND REFUSED PARTWAY. Redis applies the rest and hands the error
//    back, so a balance field holding a non-integer credited one miner,
//    refused the next, and still marked the block confirmed -- while the
//    message this code printed said the block was not marked confirmed.
//
//    THE SAME UNIT DELIVERED TWICE. ioredis, on its defaults, re-sends
//    commands whose reply never arrived after a connection drops. Every
//    command in the credit is an increment, so the second delivery doubled
//    the balances and wrote the evidence twice -- and the call returned
//    success. Nothing in the pool could tell the deliveries apart, because
//    nothing recorded that the first had happened.
//
//  Reported by dang150296 (Urriki1502) on 10 November 2026, reproduced
//  against a real Redis with this pool's own sources: balances doubled, two
//  identical entries in blocks:confirmed, and a paid balance driven to
//  -300000000 with the run reported as successful.
//
//  The fix is wamCreditMatured in pool/lib/atomic.js: a marker tested inside
//  the script, and every refusable type and number checked before the first
//  write. This file asks for both properties through the pool's own
//  _mature(), not through the script directly.
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

const HASH = 'cc'.repeat(32);
const A = 'WaaaMinerOne';
const B = 'WbbbMinerTwo';

const RECORD = {
    height: 900, blockHash: HASH, finder: `${A}.rig`,
    minerPot: 4750000000, poolFee: 50000000, workers: 2,
    payouts: { [`${A}.rig`]: 3000000000, [`${B}.rig`]: 1750000000 },
    confirmations: 101, mode: 'prop'
};

function fakeRedis() {
    const h = new Map(), l = new Map(), counters = new Map();
    const raw = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
    const list = (k) => { if (!l.has(k)) l.set(k, []); return l.get(k); };
    const hash = (k) => raw(k);

    const ops = {
        _sets: new Map(),
        async hgetall(k) { return Object.fromEntries(raw(k)); },
        async hexists(k, f) { return raw(k).has(f) ? 1 : 0; },
        async hset(k, f, v) { raw(k).set(f, v); return 1; },
        async hdel(k, f) { return raw(k).delete(f) ? 1 : 0; },
        async hincrby(k, f, n) {
            const cur = Number(raw(k).get(f) || 0) + Number(n);
            raw(k).set(f, String(cur));
            return cur;
        },
        async lrange(k) { return list(k).slice(); },
        async lpush(k, v) { list(k).unshift(v); return list(k).length; },
        async ltrim() { return 'OK'; },
        async lrem(k, _c, v) {
            const a = list(k);
            for (let i = a.length - 1; i >= 0; i--) if (a[i] === v) a.splice(i, 1);
            return 1;
        },
        async incr(k) {
            counters.set(k, (counters.get(k) || 0) + 1);
            return counters.get(k);
        },
        async decrby() { return 0; },
        async sadd(k, v) {
            if (!ops._sets.has(k)) ops._sets.set(k, new Set());
            const before = ops._sets.get(k).size;
            ops._sets.get(k).add(v);
            return ops._sets.get(k).size > before ? 1 : 0;
        },
        async sismember(k, v) {
            return ops._sets.has(k) && ops._sets.get(k).has(v) ? 1 : 0;
        },
        _balance: (who) => Number(raw('wam:balances').get(who) || 0),
        _confirmed: () => list('wam:blocks:confirmed').slice(),
        _maturing: () => list('wam:blocks:maturing').slice(),
        _count: () => counters.get('wam:blocks:confirmed:count') || 0
    };

    attachAtomic(ops, hash, list, {
        members(k) {
            if (!ops._sets.has(k)) ops._sets.set(k, new Set());
            return ops._sets.get(k);
        },
        count(k) { counters.set(k, (counters.get(k) || 0) + 1); }
    });
    attachMulti(ops);
    return ops;
}

function processorOver(redis) {
    return new ShareProcessor(
        redis,
        { async getBlock() { return { confirmations: 101, height: 900, tx: ['a'] }; } },
        { redisPrefix: 'wam', coinbaseMaturity: 100, rewardMode: 'prop' },
        { info() {}, warn() {}, error() {}, debug() {} });
}

(async () => {
    console.log(`\n${BLD}  the same credit twice pays once${OFF}\n`);

    await test('the ordinary credit pays each miner what the table says', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', HASH, JSON.stringify(RECORD));
        await processorOver(r)._mature(HASH, { ...RECORD });
        assert.strictEqual(r._balance(A), 3000000000);
        assert.strictEqual(r._balance(B), 1750000000);
        assert.strictEqual(r._confirmed().length, 1);
        assert.strictEqual(r._count(), 1);
        assert.strictEqual(r._maturing().length, 0);
    });

    await test('the same credit delivered a second time changes nothing', async () => {
        // THE RE-SEND. The client replays a command whose reply was lost; the
        // pool never learns that it did. Before the marker this doubled every
        // balance and wrote the evidence twice, and the call returned success.
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', HASH, JSON.stringify(RECORD));
        const sp = processorOver(r);
        await sp._mature(HASH, { ...RECORD });

        await r.hset('wam:blocks:pending', HASH, JSON.stringify(RECORD));
        await sp._mature(HASH, { ...RECORD });

        assert.strictEqual(r._balance(A), 3000000000,
            'the first miner was credited twice for one block');
        assert.strictEqual(r._balance(B), 1750000000,
            'the second miner was credited twice for one block');
        assert.strictEqual(r._confirmed().length, 1,
            'the block was written into blocks:confirmed twice');
        assert.strictEqual(r._count(), 1,
            'the confirmed-block counter moved twice for one block');
    });

    await test('a refused credit moves no balance at all', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', HASH, JSON.stringify(RECORD));
        r._creditFails = 'WRONGTYPE balances is not a hash';
        let threw = false;
        try { await processorOver(r)._mature(HASH, { ...RECORD }); }
        catch { threw = true; }
        r._creditFails = undefined;

        assert.ok(threw, 'a refused credit was reported as a success');
        assert.strictEqual(r._balance(A), 0,
            'one miner was credited by a credit that was refused');
        assert.strictEqual(r._balance(B), 0,
            'the other miner was credited by a credit that was refused');
        assert.strictEqual(r._count(), 0,
            'the block was counted as confirmed by a credit that failed');
    });

    await test('and the evidence survives the refusal, so it can be replayed', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', HASH, JSON.stringify(RECORD));
        r._creditFails = true;
        await processorOver(r)._mature(HASH, { ...RECORD }).catch(() => {});
        r._creditFails = undefined;

        assert.strictEqual(r._maturing().length, 1,
            'the payout table is in no list at all after a refused credit');
        const kept = JSON.parse(r._maturing()[0]);
        assert.strictEqual(kept.payouts[`${A}.rig`], 3000000000,
            'what was kept is not the table that was owed');
    });

    await test('after the refusal is cleared, the replay credits once', async () => {
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', HASH, JSON.stringify(RECORD));
        const sp = processorOver(r);
        r._creditFails = true;
        await sp._mature(HASH, { ...RECORD }).catch(() => {});
        r._creditFails = undefined;

        await r.hset('wam:blocks:pending', HASH, JSON.stringify(RECORD));
        await sp._mature(HASH, { ...RECORD });
        assert.strictEqual(r._balance(A), 3000000000);
        assert.strictEqual(r._balance(B), 1750000000);
        assert.strictEqual(r._confirmed().length, 1);
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: one credit, one payment${OFF}\n`);
})();
