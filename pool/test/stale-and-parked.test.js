'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  stale-and-parked.test.js -- a block that cannot pay must not destroy
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Three findings reported by Fahrizal on 18 November 2026, each with a
//  harness that drove these same classes:
//
//    A spooled block that LOST ITS RACE was re-offered by the drain and
//    recorded, which wrote a payout table for it and ran del(round) and
//    del(round:pow). It then orphaned. Nobody was paid for it AND every
//    miner's accumulated work since the last block was destroyed with it.
//    Measured at 4,000 difficulty of round work, in both verdict variants.
//
//    A block whose reward computation threw was parked in blocks:failed
//    with no payout record, and the 'block' listener released its spool
//    entry anyway -- the only copy drainSpool could re-offer, deleted at
//    the moment the accounting path was broken.
//
//    The recovery the pool printed for an interrupted payment left the
//    journal FATAL for ever, so an operator who followed it halted every
//    payout.
//
//  THE SHAPE OF THESE CASES
//
//  Each one asserts what SURVIVES, not what is logged. A fix that merely
//  logs the hazard and proceeds passes a test written against messages and
//  fails every one of these.
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { attachAtomic } = require('./fakeAtomic');
const { attachBlockAccounting } = require('../lib/blockAccounting');
const ShareProcessor = require('../lib/shareProcessor');
const { PaymentJournal, reconcile } = require('../lib/journal');
const { COIN } = require('../lib/constants');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

// ---------------------------------------------------------------------------
//  The pool's own double, over maps. The five Lua commands come from
//  fakeAtomic so the script semantics are the project's.
// ---------------------------------------------------------------------------

function makeRedis() {
    const hashes = new Map(), lists = new Map(), sets = new Map(),
          strings = new Map(), zsets = new Map();
    const hash = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
    const list = (k) => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); };
    const set = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    const zset = (k) => { if (!zsets.has(k)) zsets.set(k, new Map()); return zsets.get(k); };

    const api = {
        async hgetall(k) { return Object.fromEntries(hash(k)); },
        async hget(k, f) { const v = hash(k).get(f); return v === undefined ? null : v; },
        async hset(k, f, v) { hash(k).set(f, String(v)); return 1; },
        async hdel(k, f) { return hash(k).delete(f) ? 1 : 0; },
        async hexists(k, f) { return hash(k).has(f) ? 1 : 0; },
        async hincrby(k, f, n) {
            const c = Number(hash(k).get(f) || 0) + Number(n);
            hash(k).set(f, String(c)); return c;
        },
        async lrange(k, a, b) {
            const arr = list(k); return arr.slice(a, b === -1 ? arr.length : b + 1);
        },
        async llen(k) { return list(k).length; },
        async lpush(k, v) { list(k).unshift(String(v)); return list(k).length; },
        async ltrim(k, a, b) { lists.set(k, list(k).slice(a, b + 1)); return 'OK'; },
        async lrem(k, _n, v) {
            const arr = list(k); let r = 0;
            for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === v) { arr.splice(i, 1); r++; }
            return r;
        },
        async sadd(k, v) { const s = set(k), n = s.size; s.add(String(v)); return s.size > n ? 1 : 0; },
        async sismember(k, v) { return set(k).has(String(v)) ? 1 : 0; },
        async scard(k) { return set(k).size; },
        async get(k) { const v = strings.get(k); return v === undefined ? null : v; },
        async set(k, v) { strings.set(k, String(v)); return 'OK'; },
        async del(k) {
            let n = 0;
            for (const s of [hashes, lists, sets, strings, zsets]) if (s.delete(k)) n++;
            return n;
        },
        async incr(k) { const v = Number(strings.get(k) || 0) + 1; strings.set(k, String(v)); return v; },
        async incrby(k, n) { const v = Number(strings.get(k) || 0) + Number(n); strings.set(k, String(v)); return v; },
        async decrby(k, n) { const v = Number(strings.get(k) || 0) - Number(n); strings.set(k, String(v)); return v; },
        async zadd(k, s, m) { zset(k).set(String(m), Number(s)); return 1; },
        async zrangebyscore(k, min) {
            return [...zset(k)].filter(([, s]) => s >= Number(min)).map(([m]) => m);
        },
        async zremrangebyscore(k, min, max) {
            let n = 0;
            for (const [m, s] of [...zset(k)]) {
                if (s >= Number(min) && s <= Number(max)) { zset(k).delete(m); n++; }
            }
            return n;
        },
        pipeline() {
            const q = [], self = {};
            for (const name of ['hincrby', 'hdel', 'hset', 'lpush', 'ltrim',
                                'lrem', 'decrby', 'incr', 'sadd', 'del']) {
                self[name] = (...a) => { q.push([name, a]); return self; };
            }
            self.exec = async () => {
                const out = [];
                for (const [name, a] of q) {
                    try { out.push([null, await api[name](...a)]); }
                    catch (err) { out.push([err, null]); }
                }
                return out;
            };
            return self;
        }
    };

    attachAtomic(api, hash, list, {
        drop: (key) => { hashes.delete(key); lists.delete(key); sets.delete(key); },
        fee: (key, n) => strings.set(key, String(Number(strings.get(key) || 0) + n)),
        members: (key) => set(key),
        count: (key) => strings.set(key, String(Number(strings.get(key) || 0) + 1)),
        zadd: (key, s, m) => zset(key).set(String(m), Number(s)),
        unset: (key) => { strings.delete(key); }
    });
    return api;
}

/** jobManager, with the RandomX addon stubbed: nothing here hashes. */
function loadJobManager() {
    const Module = require('module');
    const orig = Module._load;
    const stub = {
        configure() {}, selfTest() { return '0'.repeat(64); },
        async hash() { throw new Error('not needed'); }, stats() { return {}; }
    };
    Module._load = function (request) {
        if (request === '../native' || request.endsWith('/native')) return stub;
        return orig.apply(this, arguments);
    };
    try { return require('../lib/jobManager'); } finally { Module._load = orig; }
}
const JobManager = loadJobManager();

/** The accounting wiring from pool/server.js, including the new guard. */
function wireLikeServer({ redis, jobManager, shareProcessor, prefix = 'wam' }) {
    const k = (...p) => [prefix, ...p].join(':');
    let chain = Promise.resolve();
    const inOrder = (what, fn) => {
        const run = chain.then(fn);
        chain = run.catch(() => {});
        return run;
    };
    const spoolKey = k('blocks:unsent');
    const refusedKey = k('blocks:refused');

    jobManager._spoolStore = {
        async put(h, e) { await redis.hset(spoolKey, h, JSON.stringify(e)); },
        async remove(h, why) {
            if (why) {
                const raw = await redis.hget(spoolKey, h);
                if (raw) {
                    await redis.hset(refusedKey, h, JSON.stringify(
                        { ...JSON.parse(raw), refusedReason: why, refusedAt: Date.now() }));
                }
            }
            await redis.hdel(spoolKey, h);
        },
        async all() {
            return Object.values(await redis.hgetall(spoolKey) || {})
                .map((v) => JSON.parse(v));
        }
    };

    // THE REAL LISTENER, NOT A COPY OF IT.
    //
    // This used to write the listener out by hand, and the first
    // falsification run proved why that is worthless: reverting
    // pool/server.js left this suite green, because the suite was running
    // its own already-fixed copy. The decision now lives in
    // pool/lib/blockAccounting.js and both callers import it.
    attachBlockAccounting({ jobManager, shareProcessor, log: quiet, inOrder });

    return { spoolKey, refusedKey, flush: () => chain };
}

const STALE = 'cd'.repeat(32);
const FRESH = 'ab'.repeat(32);

function setup({ confirmations, workingHeight = 201, coinbaseMaturity = 100 }) {
    const redis = makeRedis();
    const config = {
        redisPrefix: 'wam', rewardMode: 'prop', poolFeePercent: 1,
        coinbaseMaturity, paymentIntervalSec: 600,
        paymentJournal: path.join(os.tmpdir(),
            `sp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.journal`)
    };
    const daemon = {
        async submitBlock() { return { accepted: true, verdict: 'accepted', reasons: [] }; },
        async getBlock(hash) {
            if (hash === STALE || hash === FRESH) {
                return { hash, confirmations, height: 100 };
            }
            throw new Error('Block not found');
        },
        async getBalance() { return 0; },
        async cmd() { throw new Error('not needed'); }
    };
    const shareProcessor = new ShareProcessor(redis, daemon, config, quiet);
    const jobManager = new JobManager(daemon, config, quiet);
    jobManager.currentJob = { height: workingHeight };
    const wire = wireLikeServer({ redis, jobManager, shareProcessor });
    return { redis, config, daemon, shareProcessor, jobManager, wire };
}

async function liveRound(sp) {
    for (let i = 0; i < 3; i++) {
        await sp.recordShare({
            jobId: 'j1', height: 100, worker: 'Walice.rig1',
            difficulty: 1000, powHash: 'aa'.repeat(16) + i, time: Date.now()
        });
    }
    await sp.recordShare({
        jobId: 'j1', height: 100, worker: 'Wbob.rig1',
        difficulty: 1000, powHash: 'bb'.repeat(32), time: Date.now()
    });
}

const work = (round) => Object.values(round).reduce((a, b) => a + Number(b), 0);

(async () => {
    console.log(`\n${BLD}  a block that cannot pay must not destroy${OFF}\n`);

    // ---- the round, against a block that lost its race -------------------

    await test('a spooled block on a side branch does not close the live round',
               async () => {
        const t = setup({ confirmations: -1 });
        await liveRound(t.shareProcessor);
        const before = work(await t.redis.hgetall('wam:round'));
        assert.strictEqual(before, 4000, 'the fixture round is not what it was');

        await t.jobManager._spool({
            height: 100, hash: STALE, hex: 'deadbeef', worker: 'Walice.rig1',
            foundAt: Date.now() - 70000, coinbaseValue: 50 * COIN,
            distributableValue: 47.5 * COIN, devFeeAmount: 2.5 * COIN
        });
        await t.jobManager.drainSpool();
        await t.wire.flush();

        const after = work(await t.redis.hgetall('wam:round'));
        assert.strictEqual(after, before,
            `the round went from ${before} to ${after}. A block the node holds `
            + 'at confirmations -1 is valid and on a side branch: it lost its '
            + 'race, it can only orphan, and it just destroyed every miner\'s '
            + 'accumulated work since the last block');
        assert.strictEqual(await t.redis.scard('wam:round:pow'), 4,
            'round:pow was deleted, so the cross-round replay guard is gone '
            + 'for every share since the previous block');
        const pending = await t.redis.hgetall('wam:blocks:pending');
        assert.ok(!pending[STALE],
            'a payout table was frozen into blocks:pending for a block that '
            + 'can never mature');
        assert.strictEqual(Number(await t.redis.get('wam:poolfees') || 0), 0,
            'the pool fee was booked for a block nobody will ever be paid for');
    });

    await test('and a block that WON its race still pays', async () => {
        // The control. Same wiring, same drain; the node holds this one on
        // the best chain.
        const t = setup({ confirmations: 50 });
        await liveRound(t.shareProcessor);
        await t.jobManager._spool({
            height: 100, hash: FRESH, hex: 'deadbeef', worker: 'Walice.rig1',
            foundAt: Date.now() - 70000, coinbaseValue: 50 * COIN,
            distributableValue: 47.5 * COIN, devFeeAmount: 2.5 * COIN
        });
        await t.jobManager.drainSpool();
        await t.wire.flush();

        const pending = await t.redis.hgetall('wam:blocks:pending');
        assert.ok(pending[FRESH],
            'the guard refused a legitimate recovered block, which is the '
            + 'fault the spool exists to prevent, arriving from the other side');
        assert.strictEqual(work(await t.redis.hgetall('wam:round')), 0,
            'a real block did not close the round it was found in');
    });

    await test('a stale block is kept while a reorganisation could still save it',
               async () => {
        // Three blocks past it. A side branch that shallow can still win,
        // and a payout thrown away over that is not recoverable.
        const t = setup({ confirmations: -1, workingHeight: 104 });
        await t.jobManager._spool({
            height: 100, hash: STALE, hex: 'deadbeef', worker: 'Walice.rig1',
            foundAt: Date.now(), coinbaseValue: 50 * COIN,
            distributableValue: 47.5 * COIN, devFeeAmount: 2.5 * COIN
        });
        await t.jobManager.drainSpool();
        await t.wire.flush();
        const spool = await t.redis.hgetall(t.wire.spoolKey);
        assert.ok(spool[STALE],
            'a block three deep on a side branch was retired. The branch it '
            + 'lost to can still be reorganised away, and the entry is the '
            + 'only copy of its payout values');
    });

    await test('and retired once it is buried deeper than a coinbase matures',
               async () => {
        const t = setup({ confirmations: -1, workingHeight: 301 });
        await t.jobManager._spool({
            height: 100, hash: STALE, hex: 'deadbeef', worker: 'Walice.rig1',
            foundAt: Date.now(), coinbaseValue: 50 * COIN,
            distributableValue: 47.5 * COIN, devFeeAmount: 2.5 * COIN
        });
        await t.jobManager.drainSpool();
        await t.wire.flush();
        assert.ok(!(await t.redis.hgetall(t.wire.spoolKey))[STALE],
            'it is still offered every minute, for ever, and can never pay');
        const refused = await t.redis.hgetall(t.wire.refusedKey);
        assert.ok(refused[STALE] && /lost the race/.test(refused[STALE]),
            'it was dropped without the reason being written down anywhere');
    });

    // ---- the spool, against a block whose accounting failed --------------

    await test('a parked block keeps the spool entry that is its only way back',
               async () => {
        const t = setup({ confirmations: 7 });
        // Fee fields that do not add up: 50 - 2.5 is not 47, so
        // computeBlockRewards throws and recordBlock parks the block.
        await t.jobManager._spool({
            height: 100, hash: FRESH, hex: 'deadbeef', worker: 'Walice.rig1',
            foundAt: Date.now(), coinbaseValue: 50 * COIN,
            distributableValue: 47 * COIN, devFeeAmount: 2.5 * COIN
        });
        t.jobManager.emit('block', {
            height: 100, blockHash: FRESH, worker: 'Walice.rig1',
            blockAccepted: true, fromSpool: false,
            coinbaseValue: 50 * COIN, distributableValue: 47 * COIN,
            devFeeAmount: 2.5 * COIN
        });
        await t.wire.flush();

        const failed = await t.redis.hgetall('wam:blocks:failed');
        assert.ok(failed[FRESH], 'the fixture did not reach the park path');
        assert.ok(!(await t.redis.hgetall('wam:blocks:pending'))[FRESH],
            'the fixture wrote a payout record, so it is testing nothing');
        assert.ok((await t.redis.hgetall(t.wire.spoolKey))[FRESH],
            'the spool entry was deleted for a block with no payout record. '
            + 'blocks:failed is read by nothing in this repository -- its only '
            + 'two references are the two places that write it -- so the block '
            + 'is on the chain, its coinbase matures to the pool, and no '
            + 'automated path can ever pay the miners who earned it');

        const drain = await t.jobManager.drainSpool();
        assert.strictEqual(drain.offered, 1,
            'the drain has nothing left to offer, which is the whole loss');
    });

    await test('and the entry is released once a record really exists', async () => {
        const t = setup({ confirmations: 7 });
        await t.jobManager._spool({
            height: 100, hash: FRESH, hex: 'deadbeef', worker: 'Walice.rig1',
            foundAt: Date.now(), coinbaseValue: 50 * COIN,
            distributableValue: 47.5 * COIN, devFeeAmount: 2.5 * COIN
        });
        t.jobManager.emit('block', {
            height: 100, blockHash: FRESH, worker: 'Walice.rig1',
            blockAccepted: true, fromSpool: false,
            coinbaseValue: 50 * COIN, distributableValue: 47.5 * COIN,
            devFeeAmount: 2.5 * COIN
        });
        await t.wire.flush();
        assert.ok((await t.redis.hgetall('wam:blocks:pending'))[FRESH],
            'the control did not record the block');
        assert.ok(!(await t.redis.hgetall(t.wire.spoolKey))[FRESH],
            'the guard now keeps every entry for ever, which fills redis and '
            + 'makes every drain re-offer a block that is already paid');
    });

    // ---- a node that has not got the block --------------------------------

    await test('a node that does not have the block does not orphan it', async () => {
        // "NOT FOUND" IS NOT AN ORPHAN.
        //
        // _checkPendingBlocks read getblock's "Block not found" as "a
        // definitive orphan signal". Core does not discard a valid block on
        // a side branch -- it keeps it for ever and reports confirmations
        // -1, which is the branch immediately below. So "not found" means
        // this node does not know the hash: it is reindexing, it is a
        // different node, it was restored from backup.
        //
        // One 60-second tick then walked all of blocks:pending and orphaned
        // EVERY entry. Each payout table moved to blocks:orphaned, which
        // nothing in this repository reads back, and the round that produced
        // it was deleted when the block was recorded. server.js runs a full
        // sweep during shutdown, which is when an operator restarts both.
        const t = setup({ confirmations: 7 });
        const hash = FRESH;

        // One block waiting to mature, exactly as recordBlock leaves it.
        await t.redis.hset('wam:blocks:pending', hash, JSON.stringify({
            height: 100, blockHash: hash, finder: 'Walice.rig1',
            time: Date.now(), rewards: { Walice: 4750000000 },
            poolFee: 47500000, minerPot: 4750000000
        }));

        // The node answers as a reindexing or freshly restored one does.
        t.daemon.getBlock = async () => { throw new Error('Block not found'); };
        await t.shareProcessor._checkPendingBlocks();

        assert.ok((await t.redis.hgetall('wam:blocks:pending'))[hash],
            'the payout table was moved to blocks:orphaned because the node '
            + 'had not got the block yet. Nothing in this repository ever '
            + 'reads that list back, and the round that produced the table is '
            + 'already gone -- so the coins sit in the wallet and nothing can '
            + 'say whose they were. A reindex does this to every pending '
            + 'block at once.');
        assert.strictEqual((await t.redis.lrange('wam:blocks:orphaned', 0, -1)).length, 0,
            'it was filed as orphaned on no statement from the chain');
    });

    await test('and a block the chain really dropped is still orphaned', async () => {
        // The control: confirmations -1 IS a statement from the chain.
        const t = setup({ confirmations: -1 });
        const hash = FRESH;
        await t.redis.hset('wam:blocks:pending', hash, JSON.stringify({
            height: 100, blockHash: hash, finder: 'Walice.rig1',
            time: Date.now(), rewards: { Walice: 4750000000 },
            poolFee: 47500000, minerPot: 4750000000
        }));
        await t.shareProcessor._checkPendingBlocks();

        assert.ok(!(await t.redis.hgetall('wam:blocks:pending'))[hash],
            'a block the node holds on a side branch was left pending for '
            + 'ever, which is the fault arriving from the other side');
        assert.strictEqual((await t.redis.lrange('wam:blocks:orphaned', 0, -1)).length, 1,
            'it was dropped without the evidence being kept');
    });

    // ---- the runbook -----------------------------------------------------

    await test('the printed recovery no longer tells an operator to dead-end it',
               async () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'shareProcessor.js'), 'utf8');
        const code = src.split('\n')
            .filter((l) => !/^\s*\/\//.test(l)).join('\n');
        assert.ok(!/Clear the\\n?\s*'?\s*marker and the next run will pay normally/
                  .test(code.replace(/\s+/g, ' ')),
            'the banner still promises that clearing the marker is enough. '
            + 'The journal line was written before the broadcast and outlives '
            + 'it, so reconcile goes FATAL on every run from then on and the '
            + 'pool pauses for ever');
        assert.ok(/resolve_lost_payment\.js/.test(code),
            'the banner does not name the tool that finishes the recovery, so '
            + 'the operator is left with a half-step and no documented way to '
            + 'complete it');
    });

    await test('and the state that recovery leaves behind reconciles', async () => {
        // The reported sequence, end to end: a broadcast line with no
        // commit, the marker cleared, and then the abandoned line the tool
        // writes. The FATAL is correct before it and gone after.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-journal-'));
        const file = path.join(dir, 'payment.journal');
        const journal = new PaymentJournal(file, quiet);
        const txid = 'aa'.repeat(32);
        journal.recordBroadcast(txid, 2 * COIN, { Wminer: 2 * COIN });

        const redis = makeRedis();
        const before = await reconcile(journal, redis, 'wam:payments:done', null);
        assert.strictEqual(before.filter((c) => c.fatal).length, 1,
            'the reported state is no longer fatal, so either the fixture is '
            + 'wrong or a refusal that protects against paying twice was '
            + 'softened to make a complaint go away');

        journal.recordAbandoned(txid, 'the node answered that no such '
                                      + 'transaction exists');
        const after = await reconcile(journal, redis, 'wam:payments:done', null);
        assert.strictEqual(after.filter((c) => c.fatal).length, 0,
            'the line the tool writes does not clear the complaint, so the '
            + 'recovery still dead-ends');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: nothing that cannot pay is allowed to destroy${OFF}\n`);
})();
