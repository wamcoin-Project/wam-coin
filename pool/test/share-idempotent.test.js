'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  share-idempotent.test.js -- one proof of work, one credit, whatever fails
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  The claim and the accounting used to be three separate decisions: SADD
//  took the claim, a MULTI wrote the four fields, and any failure handed the
//  claim back so the miner could resubmit. Each is reasonable on its own.
//  Together they paid for one proof five times.
//
//  A MULTI is one unit against a lost connection and no unit at all against
//  a command refused at run time -- redis applies the rest and hands the
//  error back. So with round, pplns or hashrate holding the wrong type, the
//  difficulty was credited, the window entry written, the claim released,
//  and the miner told to send the share again. He did. Measured by the
//  reporter at four fault positions: five submissions of one proof credited
//  50 where 10 was owed, and in PPLNS terms took 4,318,181,819 base units
//  against an honest miner's 431,818,181 for the same work.
//
//  And it needs no corruption at all. If only the EXEC reply is lost, the
//  accounting ran, the claim came back, and the resubmission was credited
//  again.
//
//  Reported by dang150296 (Urriki1502) on 10 November 2026, reproduced
//  against a real Redis with this pool's own sources.
//
//  The fix is wamCreditShare in pool/lib/atomic.js: everything refusable is
//  checked BEFORE the claim is taken, so a refusal leaves no claim and no
//  credit; then the claim and the writes happen in one script, so a proof
//  already counted returns 0 and changes nothing.
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

const PROOF = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

function fakeRedis() {
    const hashes = new Map(), lists = new Map(), sets = new Map();
    const api = {
        async hgetall(k) { return Object.fromEntries(hashes.get(k) || []); },
        async sismember(k, v) { return sets.has(k) && sets.get(k).has(v) ? 1 : 0; },
        async srem(k, v) { return sets.has(k) && sets.get(k).delete(v) ? 1 : 0; },
        async lrange() { return []; },
        _round(worker) {
            const h = hashes.get('wam:round');
            return h ? Number(h.get(worker) || 0) : 0;
        },
        _window() { return (lists.get('wam:pplns') || []).length; },
        _claims() { return (sets.get('wam:round:pow') || new Set()).size; }
    };
    attachAtomic(api,
        (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); },
        (k) => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); },
        {
            members(k) {
                if (!sets.has(k)) sets.set(k, new Set());
                return sets.get(k);
            },
            zadd() { /* the hash-rate set is not read here */ }
        });
    attachMulti(api);
    return api;
}

function processorOver(redis) {
    return new ShareProcessor(
        redis, {},
        { redisPrefix: 'wam', coinbaseMaturity: 100, rewardMode: 'pplns' },
        { info() {}, warn() {}, error() {}, debug() {} });
}

const share = (powHash, difficulty = 10) =>
    ({ worker: 'Wminer.rig', difficulty, jobId: 'j1', powHash });

(async () => {
    console.log(`\n${BLD}  one proof of work, one credit${OFF}\n`);

    await test('an ordinary share is credited once', async () => {
        const r = fakeRedis();
        await processorOver(r).recordShare(share(PROOF));
        assert.strictEqual(r._round('Wminer.rig'), 10);
        assert.strictEqual(r._window(), 1);
        assert.strictEqual(r._claims(), 1);
    });

    await test('the same proof sent five times is credited once', async () => {
        // THE MEASUREMENT THE REPORT WAS BUILT ON. Against the old code this
        // credited 50 for one unit of work, and the window held five entries
        // the other miners in the round paid for.
        const r = fakeRedis();
        const sp = processorOver(r);
        for (let i = 0; i < 5; i++) {
            await sp.recordShare(share(PROOF)).catch(() => {});
        }
        assert.strictEqual(r._round('Wminer.rig'), 10,
            'one proof of work was credited more than once');
        assert.strictEqual(r._window(), 1,
            'one proof of work put more than one entry in the PPLNS window');
    });

    await test('a refused accounting credits nothing and keeps no claim', async () => {
        // The claim is what the miner needs back before he can resubmit, and
        // the credit is what he must not already have. Before the fix he
        // could have both.
        const r = fakeRedis();
        r._shareFails = 'WRONGTYPE hashrate is not a sorted set';
        let threw = false;
        try { await processorOver(r).recordShare(share(PROOF)); }
        catch { threw = true; }
        r._shareFails = undefined;

        assert.ok(threw, 'a refused share was reported as credited');
        assert.strictEqual(r._round('Wminer.rig'), 0,
            'a refused share still moved the round credit');
        assert.strictEqual(r._window(), 0,
            'a refused share still wrote a window entry');
        assert.strictEqual(r._claims(), 0,
            'a refused share left the proof claimed, so the resubmission the '
            + 'miner was invited to send can never be credited');
    });

    await test('and the resubmission after that refusal is credited once', async () => {
        const r = fakeRedis();
        const sp = processorOver(r);
        r._shareFails = true;
        await sp.recordShare(share(PROOF)).catch(() => {});
        r._shareFails = undefined;

        await sp.recordShare(share(PROOF));
        assert.strictEqual(r._round('Wminer.rig'), 10);
        assert.strictEqual(r._window(), 1);

        await sp.recordShare(share(PROOF)).catch(() => {});
        assert.strictEqual(r._round('Wminer.rig'), 10,
            'the retry was credited and then credited again');
    });

    await test('two different proofs are still two credits', async () => {
        const r = fakeRedis();
        const sp = processorOver(r);
        await sp.recordShare(share(PROOF));
        await sp.recordShare(share(OTHER));
        assert.strictEqual(r._round('Wminer.rig'), 20,
            'honest work was refused as a duplicate');
        assert.strictEqual(r._window(), 2);
    });

    await test('a duplicate is refused with the tag the caller reads', async () => {
        const r = fakeRedis();
        const sp = processorOver(r);
        await sp.recordShare(share(PROOF));
        let tagged = false;
        try { await sp.recordShare(share(PROOF)); }
        catch (e) { tagged = e.duplicateShare === true; }
        assert.ok(tagged,
            'a duplicate must say so, or the caller tells the miner to '
            + 'resubmit a share that is already counted');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: one unit of work, one credit${OFF}\n`);
})();
