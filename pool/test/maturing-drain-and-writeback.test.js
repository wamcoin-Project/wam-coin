'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// TWO FIXES THAT SHIPPED ON 26 NOVEMBER 2026 AND DID NOT DO WHAT THEY SAID.
//
// Both were written in answer to real findings, both were reviewed, and both
// were wrong in a way no test could see, because the tests written with them
// asserted the thing the author was thinking about.
//
//   1. _drainMaturing offers a block stranded in blocks:maturing to _orphan
//      when the chain has moved past it. _orphan claims through
//      CLAIM_AND_RECORD, and that script HDELs the hash from blocks:PENDING.
//      A block stranded in maturing is not in pending, so the claim removes
//      nothing, returns 0, and _orphan takes its "already orphaned by
//      another run" branch and returns -- no orphan record, no fee reversal,
//      no orphan count. _drainMaturing then LREMs it from the maturing list
//      anyway. The block ends in no state at all: not pending, not
//      confirmed, not orphaned, and with nothing written down about who
//      earned it.
//
//   2. The immature write-back guards on whereAccountedFor(hash), which
//      returns {pending, confirmed, maturing} -- an OBJECT, always truthy.
//      So `if (settled)` is taken every time, the hset below it has never
//      executed, and the log line interpolates the object as
//      "[object Object]". The guard that was supposed to stop a resurrection
//      stopped the write-back as well, and the operator's audit trail of
//      which state the block was in cannot be read.
//
// Reported by mpit, 26 November 2026 (items 7 and 8).
//
// WHAT THIS ASSERTS, AND WHY IT IS BOTH DIRECTIONS
//
// A guard that refuses everything passes any test that only checks it
// refuses. So the resurrection case and the ordinary case are both here: a
// block whose field another run deliberately removed must NOT come back, and
// a block still sitting in pending MUST have its confirmations brought up to
// date. One without the other is how this got here.
// ---------------------------------------------------------------------------

const assert = require('assert');
const ShareProcessor = require('../lib/shareProcessor');
const { attachAtomic, attachUnsupported,
        RECORD_BLOCK_NAME, CREDIT_SHARE_NAME,
        COMMIT_PAYMENT_NAME } = require('./fakeAtomic');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const HASH = 'ab'.repeat(32);

function fakeRedis() {
    const hashes = {};
    const lists = {};
    const sets = {};
    const strings = {};

    const own = (k) => (sets[k] = sets[k] || new Set());

    const r = {
        _hashes: hashes,
        _lists: lists,
        async hgetall(k) { return { ...(hashes[k] || {}) }; },
        async hset(k, f, v) { (hashes[k] = hashes[k] || {})[f] = v; return 1; },
        async hdel(k, f) {
            if (!hashes[k] || !(f in hashes[k])) return 0;
            delete hashes[k][f];
            return 1;
        },
        async hexists(k, f) { return hashes[k] && f in hashes[k] ? 1 : 0; },
        async sismember(k, m) { return own(k).has(m) ? 1 : 0; },
        async sadd(k, m) { own(k).add(m); return 1; },
        async lrange(k, a, b) {
            const l = lists[k] || [];
            return b === -1 ? l.slice(a) : l.slice(a, b + 1);
        },
        async lpush(k, v) { (lists[k] = lists[k] || []).unshift(v); return 1; },
        async rpush(k, v) { (lists[k] = lists[k] || []).push(v); return 1; },
        async lrem(k, _n, v) {
            const l = lists[k] || [];
            const i = l.indexOf(v);
            if (i === -1) return 0;
            l.splice(i, 1);
            return 1;
        },
        async ltrim() { return 'OK'; },
        async incrby(k, n) {
            strings[k] = String(Number(strings[k] || 0) + Number(n));
            return Number(strings[k]);
        },
        async incr(k) { return r.incrby(k, 1); },
        async get(k) { return strings[k] ?? null; },
        async set(k, v) { strings[k] = String(v); return 'OK'; },
        async del(k) { delete strings[k]; delete hashes[k]; delete lists[k]; return 1; },
        async hincrby(k, f, n) {
            const h = (hashes[k] = hashes[k] || {});
            h[f] = String(Number(h[f] || 0) + Number(n));
            return Number(h[f]);
        },
        async decrby(k, n) { return r.incrby(k, -Number(n)); },

        // The orphan bookkeeping runs through a pipeline and READS the
        // replies -- a double that cannot be read from would let a failure
        // there go unnoticed, which is the fault this file is about in
        // another form. Replies come back in ioredis's shape: [err, value].
        pipeline() {
            const queued = [];
            const api = {
                exec: async () => {
                    const out = [];
                    for (const [name, args] of queued) {
                        try { out.push([null, await r[name](...args)]); }
                        catch (err) { out.push([err, null]); }
                    }
                    return out;
                }
            };
            for (const name of ['ltrim', 'incr', 'incrby', 'decrby', 'del',
                                'hset', 'hdel', 'lpush', 'rpush', 'sadd']) {
                api[name] = (...args) => { queued.push([name, args]); return api; };
            }
            return api;
        }
    };

    const asMap = (k) => {
        hashes[k] = hashes[k] || {};
        return {
            has: (f) => f in hashes[k],
            get: (f) => hashes[k][f],
            set: (f, v) => { hashes[k][f] = v; },
            delete: (f) => {
                if (!(f in hashes[k])) return false;
                delete hashes[k][f];
                return true;
            },
            clear: () => { hashes[k] = {}; }
        };
    };
    attachAtomic(r, asMap, (k) => (lists[k] = lists[k] || []),
                 { members: own, unset: (k) => { delete strings[k]; } });
    attachUnsupported(r, 'it models maturation only',
                      [RECORD_BLOCK_NAME, CREDIT_SHARE_NAME, COMMIT_PAYMENT_NAME]);
    return r;
}

function make(redis, blocks) {
    return new ShareProcessor(redis, {
        async getBlock(h) {
            if (!blocks[h]) throw new Error('Block not found');
            return blocks[h];
        },
        async cmd() { return null; }
    }, {
        redisPrefix: 'wam', rewardMode: 'pplns', coinbaseMaturity: 100
    }, quiet);
}

const RECORD = (hash, height, confirmations) => JSON.stringify({
    blockHash: hash, height, confirmations, workers: 2,
    minerPot: 4750000000, poolFee: 500,
    payouts: { 'Waaa.rig': 2375000000, 'Wbbb.rig': 2375000000 }
});

async function test(name, fn) {
    try {
        await fn();
        pass += 1;
        console.log(`  ${GRN}ok${OFF}    ${name}`);
    } catch (err) {
        fail.push(name);
        console.log(`  ${RED}FAIL${OFF}  ${name}`);
        console.log(`        ${err.message.split('\n')[0]}`);
    }
}

(async () => {
    console.log(`\n${BLD}  a block that leaves one state arrives in another${OFF}\n`);

    // ---- mpit #7 --------------------------------------------------------
    await test('a block reorganised while stranded in maturing is orphaned, '
               + 'not erased', async () => {
        const r = fakeRedis();
        r._lists['wam:blocks:maturing'] = [RECORD(HASH, 10, 101)];
        // Off the best chain: this is the state _drainMaturing exists for.
        await make(r, { [HASH]: { confirmations: -1 } }).checkPendingBlocks();

        const orphaned = await r.lrange('wam:blocks:orphaned', 0, -1);
        assert.strictEqual(orphaned.length, 1,
            'the block was removed from blocks:maturing and no orphan record '
            + 'was written: it is now in no state at all, and nothing records '
            + 'who earned it or that it was lost');

        const maturing = await r.lrange('wam:blocks:maturing', 0, -1);
        assert.strictEqual(maturing.length, 0,
            'it was orphaned and left in the maturing list, so the next drain '
            + 'orphans it again');
    });

    await test('and the pool fee it reversed is reversed exactly once',
               async () => {
        const r = fakeRedis();
        r._hashes['wam:poolfees'] = {};
        await r.incrby('wam:poolfees', 500);
        r._lists['wam:blocks:maturing'] = [RECORD(HASH, 10, 101)];

        const p = make(r, { [HASH]: { confirmations: -1 } });
        await p.checkPendingBlocks();
        await p.checkPendingBlocks();          // a second run, same state

        const orphaned = await r.lrange('wam:blocks:orphaned', 0, -1);
        assert.strictEqual(orphaned.length, 1,
            `two runs produced ${orphaned.length} orphan records for one block`);
    });

    // ---- mpit #8, the direction that was lost ---------------------------
    await test('an immature block still in pending has its confirmations '
               + 'brought up to date', async () => {
        const r = fakeRedis();
        r._hashes['wam:blocks:pending'] = { [HASH]: RECORD(HASH, 10, 5) };
        await make(r, { [HASH]: { confirmations: 50 } }).checkPendingBlocks();

        const stored = r._hashes['wam:blocks:pending'][HASH];
        assert.ok(stored, 'the block disappeared from blocks:pending');
        assert.strictEqual(JSON.parse(stored).confirmations, 50,
            'the write-back never ran: whereAccountedFor returns an object, '
            + 'so `if (settled)` is always true and the hset below it is dead '
            + 'code. The operator sees a confirmation count frozen at '
            + 'whatever it was when the block was found');
    });

    // ---- mpit #8, the direction that was kept ---------------------------
    await test('a block another run has already claimed is NOT written back',
               async () => {
        const r = fakeRedis();
        // The snapshot the loop is working from still names it; the field it
        // came from has been consumed by another run's claim.
        r._hashes['wam:blocks:pending'] = { [HASH]: RECORD(HASH, 10, 5) };
        const p = make(r, { [HASH]: { confirmations: 50 } });

        const realGetall = r.hgetall.bind(r);
        r.hgetall = async (k) => {
            const snapshot = await realGetall(k);
            if (k === 'wam:blocks:pending') {
                // Another run claims it the instant after the snapshot.
                delete r._hashes[k][HASH];
                await r.sadd('wam:blocks:credited', HASH);
            }
            return snapshot;
        };

        await p.checkPendingBlocks();

        assert.ok(!(HASH in (r._hashes['wam:blocks:pending'] || {})),
            'the write-back resurrected a field a claim had consumed, so the '
            + 'next sweep wins the exactly-once claim a second time -- the '
            + 'double fee reversal this guard exists to stop');
    });

    console.log('');
    if (fail.length) {
        console.log(`${RED}${BLD}  ${fail.length} failed, ${pass} passed${OFF}\n`);
        for (const f of fail) console.log(`    - ${f}`);
        console.log('');
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} passed${OFF}\n`);
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
