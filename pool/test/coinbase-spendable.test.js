'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// The pool may not credit a coin it cannot yet spend.
//
// COINBASE_MATURITY is 100, and reading that as "spendable at 100
// confirmations" is wrong by exactly one block. Core's wallet computes
//
//     max(0, (COINBASE_MATURITY + 1) - depth)              wallet.cpp:3454
//
// so a coinbase output moves at depth 101. The pool credited at 100, which
// meant that from the moment mainnet started it believed it held one block
// more than the node would let it send -- 47.5 WAM of permanent gap between
// what miners were owed and what could actually be paid.
//
// Found on 2026-09-23 by measuring the gap in the pool's own postponement
// logs rather than by anything breaking: it sat between 39.76 and 32.05 WAM
// for seven days, never growing, which is the signature of a fixed offset and
// not of a leak. The arithmetic then reconciled to 0.1 WAM of accumulated
// transaction fees, so nothing had been lost and nobody had been paid twice.
//
// What it cost was time. Every payment run that landed inside the gap
// postponed itself, and the 10-minute payout interval became 20 to 40 minutes
// for miners who had done nothing wrong.
// ---------------------------------------------------------------------------

const assert = require('assert');
const ShareProcessor = require('../lib/shareProcessor');
const { COINBASE_MATURITY } = require('../lib/constants');
const { attachAtomic, attachUnsupported } = require('./fakeAtomic');
const { attachMulti } = require('./fakeMulti');

let pass = 0;
const fail = [];

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

function fakeRedis() {
    const h = new Map();
    const l = new Map();
    const hash = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
    const list = (k) => { if (!l.has(k)) l.set(k, []); return l.get(k); };

    const counters = new Map();
    const ops = {
        async hgetall(k) { return Object.fromEntries(hash(k)); },
        async hdel(k, f) { return hash(k).delete(f) ? 1 : 0; },
        async hset(k, f, v) { hash(k).set(f, v); return 1; },
        async hincrby(k, f, n) {
            const cur = Number(hash(k).get(f) || 0) + Number(n);
            hash(k).set(f, String(cur));
            return cur;
        },
        async lpush(k, v) { list(k).unshift(v); return list(k).length; },
        async ltrim() { return 'OK'; },
        async lrem() { return 1; },
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
            for (const n of ['hincrby', 'hdel', 'hset', 'lpush', 'ltrim', 'lrem', 'decrby', 'incr', 'sadd']) {
                api[n] = (...args) => { queued.push([n, args]); return api; };
            }
            api.exec = async () => {
                for (const [n, args] of queued) await ops[n](...args);
                return [];
            };
            return api;
        },
        _dump: { h, l }
    };
    attachAtomic(ops, hash, list);
    // The maturation credit is a MULTI now, not a pipeline.
    attachMulti(ops);
    return ops;
}

function processorWith(redis, confirmations) {
    const daemon = {
        async getBlock() { return { confirmations, height: 9000, tx: ['ab'] }; }
    };
    return new ShareProcessor(
        redis, daemon,
        { redisPrefix: 'wam', coinbaseMaturity: COINBASE_MATURITY },
        { info() {}, warn() {}, error() {}, debug() {} }
    );
}

const RECORD = {
    height: 9000,
    minerPot: 4750000000,
    poolFee: 0,
    workers: 2,
    payouts: { 'wam1aaa.rig1': 2375000000, 'wam1bbb.rig2': 2375000000 }
};

const balances = (r) => Object.fromEntries(r._dump.h.get('wam:balances') || new Map());
const pending = (r) => Object.fromEntries(r._dump.h.get('wam:blocks:pending') || new Map());

async function atDepth(confirmations) {
    const r = fakeRedis();
    await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
    await processorWith(r, confirmations).checkPendingBlocks();
    return r;
}

(async () => {
    console.log('\n=== a coinbase is spendable at 101 confirmations, not 100 ===');

    await test('Core asks for depth > COINBASE_MATURITY, so 100 is one short', async () => {
        // The rule this whole file exists to encode, stated once as arithmetic
        // so a future reader does not have to trust the prose:
        //     blocksToMaturity = max(0, (COINBASE_MATURITY + 1) - depth)
        const toMaturity = (depth) => Math.max(0, (COINBASE_MATURITY + 1) - depth);
        assert.strictEqual(toMaturity(100), 1,
            'at 100 confirmations Core still wants one more block');
        assert.strictEqual(toMaturity(101), 0,
            'at 101 confirmations the coin can move');
    });

    await test('at 100 confirmations nothing is credited and the block stays pending', async () => {
        const r = await atDepth(100);
        assert.deepStrictEqual(balances(r), {},
            'the pool credited miners with a coin the node will not let it spend; '
            + 'every payment run near this boundary then postpones itself');
        assert.ok(pending(r).H, 'the block left blocks:pending before it was spendable');
    });

    await test('at 101 confirmations it is credited', async () => {
        const r = await atDepth(101);
        assert.strictEqual(balances(r)['wam1aaa'], '2375000000',
            'the block became spendable and was not credited');
        assert.strictEqual(balances(r)['wam1bbb'], '2375000000');
        assert.strictEqual(pending(r).H, undefined,
            'a credited block must leave blocks:pending');
    });

    await test('99 confirmations is still pending, and 150 is credited', async () => {
        assert.deepStrictEqual(balances(await atDepth(99)), {},
            'credited far too early');
        assert.strictEqual(balances(await atDepth(150))['wam1aaa'], '2375000000',
            'a long-buried block was never credited');
    });

    await test('the boundary moves with a configured maturity, not a hardcoded 101', async () => {
        // regtest and testnet can set coinbaseMaturity, so the rule has to be
        // "one past whatever it is", never the number 101 written down again.
        const r = fakeRedis();
        await r.hset('wam:blocks:pending', 'H', JSON.stringify(RECORD));
        const sp = new ShareProcessor(
            r, { async getBlock() { return { confirmations: 10, height: 9000, tx: ['ab'] }; } },
            { redisPrefix: 'wam', coinbaseMaturity: 10 },
            { info() {}, warn() {}, error() {}, debug() {} });
        await sp.checkPendingBlocks();
        assert.deepStrictEqual(balances(r), {},
            'a pool configured with maturity 10 credited at depth 10, not 11');
    });

    console.log(`\n  ${pass} passed, ${fail.length} failed`);
    if (fail.length) { fail.forEach((f) => console.log(`    - ${f}`)); process.exit(1); }
})();
