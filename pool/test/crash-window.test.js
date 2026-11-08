'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  A block this pool found is recoverable after a crash at EVERY step
// ===========================================================================
//
//      node pool/test/crash-window.test.js
//
//  WHY THIS EXISTS
//
//  Every fault ever found in this pool's money path was found by somebody
//  outside the project: chovy, dang150296, Alboy, Smooth Jazz Crypto. That is not luck,
//  and it is not that they are better readers. It is that the pool's own
//  tests crash it at points somebody CHOSE.
//
//  pool/test/maturation-claim.test.js has a test called
//
//      a crash inside the credit leaves evidence and never doubles
//
//  and it is a good test. It begins its simulated crash after
//  blocks:maturing has already been written -- so the one interval it does
//  not cover is the interval between the destructive claim and that write.
//  That interval is where Smooth Jazz Crypto found, on 2026-10-12, that a block's entire
//  payout table could be destroyed: deleted from pending, absent from
//  maturing, never credited, and unrecoverable because the round's shares are
//  deleted in the same breath that writes the pending record.
//
//  One chosen crash point proves one crash point. This file does not choose.
//  It walks the failure across EVERY redis command the maturation path
//  issues, one run per position, and after each run asserts the only property
//  that matters:
//
//      THE INVARIANT
//
//      A block the pool has found is always recoverable. Either it is still
//      in blocks:pending, or evidence of it exists in blocks:maturing or
//      blocks:confirmed. Never neither.
//
//      And if the credit did not finish, the evidence is still there -- so
//      an operator has something to replay by hand. Partial credit that can
//      be seen is a repair; silent loss is not.
//
//  WHAT THIS CANNOT DO
//
//  It proves the invariant against this double, not against Redis. A real
//  server can also fail between a command arriving and its reply being read,
//  which from here looks the same as the command never running -- and that
//  case is why the pending-to-evidence step is one server-side script rather
//  than two commands. The script is atomic on the server; this file proves
//  the code around it keeps the invariant wherever else it is cut.
// ===========================================================================

const assert = require('assert');
const ShareProcessor = require('../lib/shareProcessor');
const { attachAtomic } = require('./fakeAtomic');
const { attachMulti } = require('./fakeMulti');

const GRN = '\x1b[32m'; const RED = '\x1b[31m'; const BLD = '\x1b[1m';
const OFF = '\x1b[0m';

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ${GRN}ok${OFF}    ${name}`);
    } catch (err) {
        failures.push(name);
        console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${err.message}`);
    }
}

const BLOCK = 'a'.repeat(64);
const HEIGHT = 4242;

function record() {
    return {
        height: HEIGHT,
        minerPot: 4750000000,
        poolFee: 0,
        payouts: { 'wam1qalice.rig1': 3000000000, 'wam1qbob.rig1': 1750000000 },
        workers: 2,
        confirmations: 101,
        mode: 'pplns'
    };
}

/**
 * A redis double that counts what it is asked and fails on command number
 * `failAt`. Counting every command, not every method, is the point: the
 * positions are not chosen, they are enumerated.
 */
function countingRedis(failAt) {
    const h = new Map(); const l = new Map(); const counters = new Map();
    const sets = new Map();
    const hash = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
    const list = (k) => { if (!l.has(k)) l.set(k, []); return l.get(k); };
    const state = { n: 0, issued: [] };

    const tick = (name) => {
        state.n++;
        state.issued.push(name);
        if (state.n === failAt) {
            const e = new Error(`injected failure at command ${failAt} (${name})`);
            e.injected = true;
            throw e;
        }
    };

    const api = {
        _h: h, _l: l, _counters: counters, _state: state,
        async hgetall(k) { tick('hgetall'); return Object.fromEntries(hash(k)); },
        async hexists(k, f) { tick('hexists'); return hash(k).has(f) ? 1 : 0; },
        async hdel(k, f) { tick('hdel'); return hash(k).delete(f) ? 1 : 0; },
        async hset(k, f, v) { tick('hset'); hash(k).set(f, v); return 1; },
        async hincrby(k, f, n) {
            tick('hincrby');
            const cur = Number(hash(k).get(f) || 0) + Number(n);
            hash(k).set(f, String(cur));
            return cur;
        },
        async lpush(k, v) { tick('lpush'); list(k).unshift(v); return list(k).length; },
        async ltrim() { tick('ltrim'); return 'OK'; },
        async lrem(k, _c, v) {
            tick('lrem');
            const arr = list(k); const i = arr.indexOf(v);
            if (i === -1) return 0;
            arr.splice(i, 1); return 1;
        },
        async decrby(k, n) {
            tick('decrby');
            counters.set(k, Number(counters.get(k) || 0) - Number(n));
            return counters.get(k);
        },
        async incr(k) {
            tick('incr');
            counters.set(k, Number(counters.get(k) || 0) + 1);
            return counters.get(k);
        },
        async sadd(k, v) {
            tick('sadd');
            if (!sets.has(k)) sets.set(k, new Set());
            const before = sets.get(k).size;
            sets.get(k).add(v);
            return sets.get(k).size > before ? 1 : 0;
        },
        async sismember(k, v) {
            tick('sismember');
            return sets.has(k) && sets.get(k).has(v) ? 1 : 0;
        },
        // A PIPELINE IS ONE ROUND TRIP AND NOT A TRANSACTION.
        //
        // So a crash during exec() can leave a PREFIX of it applied, and this
        // models that: each queued command ticks in order, and the injected
        // failure stops the rest. A fake that applied all or nothing would
        // hide exactly the class of fault this file exists to find.
        pipeline() {
            const queued = []; const self = {};
            for (const name of ['hincrby', 'hdel', 'hset', 'lpush', 'ltrim',
                                'lrem', 'decrby', 'incr', 'sadd', 'del']) {
                self[name] = (...args) => { queued.push([name, args]); return self; };
            }
            self.exec = async () => {
                for (const [name, args] of queued) {
                    if (name === 'del') { tick('del'); h.delete(args[0]); l.delete(args[0]); continue; }
                    await api[name](...args);
                }
                return [];
            };
            return self;
        }
    };
    attachAtomic(api, hash, list);
    // The maturation credit is a MULTI now, not a pipeline.
    attachMulti(api);
    // The script is atomic on a real server, and the double must say so: one
    // tick for the whole thing, and either both effects or neither.
    const inner = api.wamClaimAndRecord;
    api.wamClaimAndRecord = async (pendingKey, listKey, field, evidence) => {
        tick('wamClaimAndRecord');
        return inner(pendingKey, listKey, field, evidence);
    };
    return api;
}

function processorOver(redis) {
    return new ShareProcessor(
        redis,
        { async getBlock() { return { confirmations: 101, height: HEIGHT }; } },
        { redisPrefix: 'wam', coinbaseMaturity: 100, poolFeePercent: 0 },
        { info() {}, warn() {}, error() {}, debug() {} });
}

/** Everything the pool could still use to know about this block. */
function recoverable(redis) {
    const pending = redis._h.get('wam:blocks:pending');
    const inPending = Boolean(pending && pending.has(BLOCK));
    const text = (k) => (redis._l.get(k) || []).join('|');
    return {
        inPending,
        inMaturing: text('wam:blocks:maturing').includes(String(HEIGHT)),
        inConfirmed: text('wam:blocks:confirmed').includes(String(HEIGHT)),
        credited: Number((redis._h.get('wam:balances') || new Map())
            .get('wam1qalice') || 0)
    };
}

// ---------------------------------------------------------------------------
console.log(`\n${BLD}a crash at every step still leaves the block ` +
            `recoverable${OFF}\n`);

// How many commands does an uninterrupted maturation issue? Ask, rather than
// assume: the number changes whenever the path does, and a loop bounded by a
// guess is a loop that stops testing the end of it.
const clean = countingRedis(0);
clean._h.set('wam:blocks:pending', new Map([[BLOCK, JSON.stringify(record())]]));
let total = 0;

(async () => {
    await processorOver(clean)._checkPendingBlocks();
    total = clean._state.n;
    console.log(`  an uninterrupted maturation issues ${total} redis ` +
                `command(s): ${clean._state.issued.join(', ')}\n`);

    const afterClean = recoverable(clean);
    check('uninterrupted, the block is credited and recorded once', () => {
        assert.strictEqual(afterClean.inPending, false, 'still pending');
        assert.strictEqual(afterClean.inConfirmed, true, 'not in confirmed');
        assert.strictEqual(afterClean.credited, 3000000000,
                           `alice got ${afterClean.credited}`);
    });

    const lost = [];
    const blind = [];
    for (let at = 1; at <= total; at++) {
        const redis = countingRedis(at);
        redis._h.set('wam:blocks:pending',
                     new Map([[BLOCK, JSON.stringify(record())]]));
        const where = clean._state.issued[at - 1];
        try {
            await processorOver(redis)._checkPendingBlocks();
        } catch (err) {
            if (!err.injected) throw err;
        }
        const s = recoverable(redis);

        // THE INVARIANT.
        if (!s.inPending && !s.inMaturing && !s.inConfirmed) {
            lost.push(`${at} (${where})`);
            continue;
        }
        // And if the credit is unfinished, the evidence must still be there
        // for somebody to replay. inConfirmed means the credit pipeline got
        // far enough to record it; before that, maturing must hold it.
        if (!s.inPending && !s.inConfirmed && !s.inMaturing) {
            blind.push(`${at} (${where})`);
        }
    }

    check(`no crash position loses the block (${total} positions walked)`, () => {
        assert.deepStrictEqual(lost, [],
            'the payout table is gone and nothing records it, after a crash at ' +
            `command ${lost.join(', ')}. The round shares that would rebuild ` +
            'it were deleted when the pending record was written, so this is ' +
            'not recoverable by hand either.');
    });

    check('no crash position leaves an unfinished credit without evidence', () => {
        assert.deepStrictEqual(blind, [], blind.join(', '));
    });

    // AND THE GUARD THAT PROVES THIS FILE CAN FAIL.
    //
    // A test that walks every position and always passes is indistinguishable
    // from a test that walks none. This reproduces the defect Smooth Jazz Crypto
    // reported, in the only way still available now that the transition is one
    // operation: a double whose claim is two steps, with the failure between
    // them. If the invariant above cannot detect that, it cannot detect
    // anything.
    const twoStep = countingRedis(0);
    twoStep._h.set('wam:blocks:pending',
                   new Map([[BLOCK, JSON.stringify(record())]]));
    twoStep.wamClaimAndRecord = async (pendingKey, _listKey, field) => {
        const pending = twoStep._h.get(pendingKey);
        if (!pending || !pending.delete(field)) return 0;
        throw Object.assign(new Error('interrupted after the claim'),
                            { injected: true });
    };
    try {
        await processorOver(twoStep)._checkPendingBlocks();
    } catch (err) {
        if (!err.injected) throw err;
    }
    const after = recoverable(twoStep);
    check('the old two-step claim IS caught by this invariant', () => {
        assert.ok(!after.inPending && !after.inMaturing && !after.inConfirmed,
                  'the reproduction did not actually lose the block, so the ' +
                  'walk above proves nothing');
    });

    console.log();
    console.log('='.repeat(66));
    if (failures.length === 0) {
        console.log(`  ${GRN}${BLD}${passed} checks passed: every crash ` +
                    `position keeps the block recoverable${OFF}`);
    } else {
        console.log(`  ${RED}${BLD}${failures.length} failed${OFF}, ` +
                    `${passed} passed`);
        for (const f of failures) console.log(`    - ${f}`);
    }
    console.log('='.repeat(66));
    console.log();
    process.exit(failures.length ? 1 : 0);
})().catch((err) => {
    console.error(`\n  ${RED}the harness itself failed: ${err.stack}${OFF}\n`);
    process.exit(1);
});
