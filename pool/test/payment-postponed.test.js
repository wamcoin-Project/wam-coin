'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// A postponed payment run and a broken one look identical from outside.
//
// The pool refuses to send a batch its wallet cannot cover, because a
// half-failed sendmany is far harder to reconcile than a late payment. Block
// rewards mature at 100 confirmations, so the wallet is routinely short of
// what has already been credited to miners, and the run waits.
//
// Seen from a monitor, that is the same picture as payments being broken:
// owed climbs, the last payment ages, nothing is sent. On 2026-09-23 the
// sweep reported "payouts have stopped" while the pool was working exactly as
// designed -- it paid 808.51 WAM to 23 miners minutes later.
//
// A monitor that reports the safe case as an emergency does more harm than no
// monitor at all: the operator learns that the red card means nothing, and is
// not looking on the day it means something. The pool is the only party that
// knows which of the two it is, so it must publish the reason rather than
// leave it in a log line nobody reads.
// ---------------------------------------------------------------------------

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ShareProcessor = require('../lib/shareProcessor');
const { attachAtomic, attachUnsupported,
        CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME, CREDIT_MATURED_NAME,
        CREDIT_SHARE_NAME } = require('./fakeAtomic');

let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const COIN = 100000000;

// One throwaway directory for the payment journals, one file per double: the
// default lives inside the pool's own tree and a suite must not write there.
const JOURNALS = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-payment-postponed-'));
let journalSeq = 0;
process.on('exit', () => fs.rmSync(JOURNALS, { recursive: true, force: true }));

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

/** Enough of ioredis to drive the payment path and getPoolStats. */
function fakeRedis(balances = {}) {
    const hashes = { 'wam:balances': { ...balances }, 'wam:paid': {}, 'wam:blocks:pending': {} };
    const strings = {};
    const lists = { 'wam:payments': [], 'wam:blocks:confirmed': [], 'wam:blocks:orphaned': [] };
    const sets = {};
    const r = {
        _strings: strings,
        _journalPath: path.join(JOURNALS, `j${++journalSeq}.journal`),
        async sismember(k, v) { return sets[k] && sets[k].has(v) ? 1 : 0; },
        async scard(k) { return sets[k] ? sets[k].size : 0; },
        async hgetall(k) { return { ...(hashes[k] || {}) }; },
        async get(k) { return strings[k] ?? null; },
        async set(k, v) { strings[k] = v; },
        async del(k) { delete strings[k]; },
        async lrange(k, a, b) { return (lists[k] || []).slice(a, b + 1); },
        async llen(k) { return (lists[k] || []).length; }
    };

    // The money commit is one script -- see payment-commit.test.js, which is
    // about what happens when it refuses. Here it is only the thing that has
    // to run for the postponement record to be cleared, so it runs the real
    // definition over this double's own stores rather than a hand-written
    // copy of what it is believed to do.
    const asMap = (bag, k) => {
        bag[k] = bag[k] || {};
        return {
            get: (f) => bag[k][f],
            set: (f, v) => { bag[k][f] = String(v); },
            has: (f) => Object.prototype.hasOwnProperty.call(bag[k], f),
            delete: (f) => delete bag[k][f],
            clear: () => { bag[k] = {}; }
        };
    };
    attachAtomic(r,
        (k) => asMap(hashes, k),
        (k) => (lists[k] = lists[k] || []),
        {
            members: (k) => {
                if (!sets[k]) sets[k] = new Set();
                return sets[k];
            },
            unset: (k) => { delete strings[k]; }
        });
    attachUnsupported(r, 'it models balances and the payment batch, not block maturation',
                      [CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME,
                       CREDIT_MATURED_NAME, CREDIT_SHARE_NAME]);
    return r;
}

/** balanceWam is what the wallet can actually spend right now. */
function fakeDaemon(balanceWam) {
    // The real sequence since 2026-10-04: the transaction is built and signed
    // so that it HAS a txid before it is broadcast, and only the broadcast can
    // leave the outcome unknown. A fake that still answers `sendmany` would be
    // testing a protocol the pool no longer speaks.
    return {
        sent: [],
        calls: [],
        async getBalance() { return balanceWam; },
        async cmd(method, params) {
            this.calls.push(method);
            switch (method) {
                case 'createrawtransaction':
                    this.sent.push(params[1]);          // the outputs, as before
                    return 'raw' + this.sent.length;
                case 'fundrawtransaction':
                    return { hex: 'funded' + this.sent.length };
                case 'signrawtransactionwithwallet':
                    return { complete: true, hex: 'signed' + this.sent.length };
                case 'decoderawtransaction':
                    return { txid: `txid-${this.sent.length}` };
                case 'sendrawtransaction':
                    return `txid-${this.sent.length}`;
                case 'getrawtransaction': {
                    const e = new Error('No such mempool or blockchain transaction');
                    e.ambiguous = false;
                    throw e;
                }
                default:
                    return null;
            }
        }
    };
}

function make(redis, daemon, cfg = {}) {
    return new ShareProcessor(redis, daemon, {
        redisPrefix: 'wam', rewardMode: 'pplns', minimumPayoutWam: 1,
        paymentJournal: redis._journalPath, ...cfg
    }, quiet);
}

(async () => {
    console.log('\n=== a postponement must be published, not only logged ===');

    await test('a wallet short of the batch writes the reason and sends nothing', async () => {
        // 300 WAM is owed across two miners; the wallet holds 100.
        const redis = fakeRedis({ addr1: String(200 * COIN), addr2: String(100 * COIN) });
        const daemon = fakeDaemon(100);
        const sp = make(redis, daemon);

        await sp.processPayments();

        assert.strictEqual(daemon.sent.length, 0,
            'the pool sent a payment its wallet could not cover');

        const raw = await redis.get('wam:payment:postponed');
        assert.ok(raw, 'the run postponed but published no reason, so a monitor '
                     + 'cannot tell this from payments being broken');

        const pp = JSON.parse(raw);
        assert.strictEqual(pp.held, 100 * COIN, `held was ${pp.held}`);
        assert.ok(pp.due > pp.held, 'due must exceed held or there was nothing to postpone');
        assert.strictEqual(pp.shortfall, pp.due - pp.held,
            'the shortfall must be the arithmetic, not a second opinion');
        assert.ok(pp.at > Date.now() - 60000,
            'the record must carry when it happened; a monitor needs the age to '
            + 'tell a current postponement from a stale one');
    });

    await test('the record says how many miners are waiting', async () => {
        const redis = fakeRedis({ a: String(200 * COIN), b: String(100 * COIN), c: String(50 * COIN) });
        const sp = make(redis, fakeDaemon(10));
        await sp.processPayments();
        const pp = JSON.parse(await redis.get('wam:payment:postponed'));
        assert.strictEqual(pp.recipients, 3, `recipients was ${pp.recipients}`);
    });

    console.log('\n=== and cleared the moment a run pays ===');

    await test('a successful run deletes the postponement record', async () => {
        const redis = fakeRedis({ addr1: String(200 * COIN), addr2: String(100 * COIN) });
        const poor = fakeDaemon(100);
        const sp = make(redis, poor);

        await sp.processPayments();
        assert.ok(await redis.get('wam:payment:postponed'), 'setup: expected a postponement');

        // Blocks matured; the wallet can now cover it.
        const rich = fakeDaemon(1000);
        const sp2 = make(redis, rich);
        await sp2.processPayments();

        assert.strictEqual(rich.sent.length, 1, 'the funded run did not pay');
        assert.strictEqual(await redis.get('wam:payment:postponed'), null,
            'the record survived a run that paid, so the monitor will report a '
            + 'postponement that is over');
    });

    console.log('\n=== and reaches the monitor through the stats ===');

    await test('getPoolStats carries paymentPostponed, and null once it clears', async () => {
        const redis = fakeRedis({ addr1: String(200 * COIN) });
        const sp = make(redis, fakeDaemon(1));
        await sp.processPayments();

        let stats = await sp.getPoolStats();
        assert.ok(stats.paymentPostponed, 'stats hid the postponement from the monitor');
        assert.strictEqual(typeof stats.paymentPostponed.shortfall, 'number',
            'the shortfall must arrive as a number the monitor can compare');

        const rich = fakeDaemon(1000);
        const sp2 = make(redis, rich);
        await sp2.processPayments();

        stats = await sp2.getPoolStats();
        assert.strictEqual(stats.paymentPostponed, null,
            'stats still report a postponement after a run that paid');
    });

    await test('a corrupt record is reported as no record, not as a crash', async () => {
        const redis = fakeRedis({ addr1: String(200 * COIN) });
        const sp = make(redis, fakeDaemon(1000));
        redis._strings['wam:payment:postponed'] = '{not json';
        const stats = await sp.getPoolStats();
        assert.strictEqual(stats.paymentPostponed, null,
            'a damaged record took the whole stats endpoint down with it');
    });

    console.log(`\n  ${pass} passed, ${fail.length} failed`);
    if (fail.length) { fail.forEach((f) => console.log(`    - ${f}`)); process.exit(1); }
})();
