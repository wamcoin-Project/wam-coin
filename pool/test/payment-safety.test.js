'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// The two ways a payment run loses the pool operator's money.
//
// Both were found by reading the payment path rather than by anything going
// wrong, which is the only way either would ever have been found: each needs a
// coincidence of timing that is rare per run and certain over years.
//
//   1. Two runs overlapping. processPayments is on a setInterval. A run that
//      takes longer than the interval -- a slow daemon, two hundred outputs, a
//      wallet rescan -- is still between reading balances and clearing them
//      when the next tick starts. Both read the same balances, both build the
//      same batch, both call sendmany. Everyone is paid twice out of the
//      pool's own wallet and no log line looks wrong.
//
//   2. A crash between sendmany returning and the balances being cleared. The
//      coins are gone, the balances still say they are owed, and the next run
//      pays them again. The window is milliseconds; this project lost power
//      twice in one day.
//
// The fix for the second is not to close the window -- it cannot be closed
// without a transaction across two systems -- but to leave evidence in it, and
// to refuse to pay until a human has looked. A pool that pauses is a support
// ticket. A pool that pays twice is money.
// ---------------------------------------------------------------------------

const assert = require('assert');
const EventEmitter = require('events');
const ShareProcessor = require('../lib/shareProcessor');
const { attachAtomic, attachUnsupported,
        CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME, CREDIT_MATURED_NAME,
        CREDIT_SHARE_NAME } = require('./fakeAtomic');

let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

/** Enough of ioredis to drive the payment path. */
function fakeRedis(initial = {}) {
    const hashes = { 'wam:balances': { ...initial } };
    const strings = {};
    const lists = {};
    const sets = {};
    const r = {
        calls: [],
        async hgetall(k) { return { ...(hashes[k] || {}) }; },
        async get(k) { return strings[k] ?? null; },
        async set(k, v) { strings[k] = v; r.calls.push(['set', k]); },
        async del(k) { delete strings[k]; r.calls.push(['del', k]); },
        _strings: strings,
        _lists: lists,
        _hashes: hashes,
        _sets: sets,
        async sismember(k, v) { return sets[k] && sets[k].has(v) ? 1 : 0; }
    };

    // THE COMMIT IS THE REAL ONE, OVER THIS DOUBLE'S OWN STORES.
    //
    // It used to be a hand-written MULTI here, and that is how this file came
    // to hold eight cases about a commit while modelling the one thing the
    // commit could not do: refuse halfway. The double applied `hincrby` and
    // `del` in a loop that could not fail, so the shape that paid a man twice
    // -- a deduction refused and the marker deleted anyway -- had nowhere to
    // appear. attachAtomic runs the same definition the pool requires, and
    // `_commitFails` injects the refusal before any of it.
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
            // The double's own del, so a test can ask through its own get
            // whether the marker survived -- and so the call is recorded.
            unset: (k) => { r.del(k); }
        });
    // Everything except the commit: this double models balances and the
    // payment batch, and a stub that quietly returned 1 for block maturation
    // would let a test pass while proving nothing.
    attachUnsupported(r, 'it models balances and the payment batch, not block maturation',
                      [CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME,
                       CREDIT_MATURED_NAME, CREDIT_SHARE_NAME]);
    return r;
}

function fakeDaemon(onBroadcast) {
    // The real sequence since 2026-10-04: the transaction is built and signed
    // so that it HAS a txid before it is broadcast, and only the broadcast can
    // leave the outcome unknown. A fake that still answers `sendmany` would be
    // testing a protocol the pool no longer speaks.
    return {
        sent: [],
        calls: [],
        async getBalance() { return 1000000; },
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
                    if (onBroadcast) await onBroadcast(this.sent[this.sent.length - 1]);
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
    const sp = new ShareProcessor(redis, daemon, {
        redisPrefix: 'wam', rewardMode: 'pplns', minimumPayoutWam: 1, ...cfg
    }, quiet);
    Object.setPrototypeOf(sp, ShareProcessor.prototype);
    if (!(sp instanceof EventEmitter)) { /* constructed fine */ }
    return sp;
}

(async () => {
    console.log('\n=== two payment runs must not overlap ===');

    await test('a second tick during a slow run pays nobody twice', async () => {
        // The real scenario: one ShareProcessor, one setInterval, and a run
        // that is still inside sendmany when the next tick fires.
        const redis = fakeRedis({ addr1: '500000000', addr2: '300000000' });
        let release;
        const held = new Promise((r) => { release = r; });

        const daemon = fakeDaemon(() => held);   // sendmany hangs until released
        const sp = make(redis, daemon);

        const first = sp.processPayments();      // enters, blocks in sendmany
        await new Promise((r) => setImmediate(r));
        const second = sp.processPayments();     // the next interval tick

        // The second call must return at once, having done nothing. Without the
        // guard it walks into sendmany and blocks on the same promise, so the
        // test would hang rather than fail -- and a hang is a bad way to learn
        // that a pool pays twice. Race it against a timer so the failure says
        // what happened.
        const verdict = await Promise.race([
            second.then(() => 'returned'),
            new Promise((r) => setTimeout(() => r('blocked'), 1500))
        ]);
        assert.strictEqual(verdict, 'returned',
            'the second run entered the payment path instead of skipping; '
            + 'without the guard both runs call sendmany and everyone is paid twice');

        release();
        await first;

        assert.strictEqual(daemon.sent.length, 1,
            `sendmany was called ${daemon.sent.length} times; must be exactly 1`);
    });

    await test('the guard is released after a failure, not left stuck', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon(() => { throw new Error('daemon exploded'); });
        const sp = make(redis, daemon);
        await sp.processPayments();
        assert.strictEqual(sp.paying, false,
            'a thrown error left the pool unable to ever pay again');
    });

    console.log('\n=== a crash mid-payment must not pay twice ===');

    await test('an intent record is written before the money moves', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        let atSendTime = null;
        const daemon = fakeDaemon(async () => {
            atSendTime = await redis.get('wam:payment:inflight');
        });
        const sp = make(redis, daemon);
        await sp.processPayments();
        assert.ok(atSendTime, 'nothing recorded the intent before the money moved');
        const rec = JSON.parse(atSendTime);
        assert.ok(rec.payouts.addr1, 'the record does not name who was being paid');
    });

    await test('it is cleared once balances are cleared', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const sp = make(redis, fakeDaemon());
        await sp.processPayments();
        assert.strictEqual(await redis.get('wam:payment:inflight'), null,
            'a completed run left a marker that will pause the next start-up');
    });

    await test('a broadcast whose commit fails is not broadcast again', async () => {
        // THE FAULT: six cases in this file and none of them failed at the
        // commit. _processPayments broadcast inside a try/catch and committed
        // the balances outside it, so a rejected exec() travelled up to the
        // interval handler, which logs and nothing else. The balances were
        // untouched, payment:inflight was still set, `paused` was never set
        // on that path, and 600 seconds later the same batch was built from
        // the same balances and broadcast a second time -- out of the pool's
        // own wallet, with nothing in the logs looking wrong.
        //
        // Reported by bobbyning, 2026-11-07.
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        const sp = make(redis, daemon);

        redis._commitFails = true;
        await sp.processPayments();
        redis._commitFails = false;

        assert.strictEqual(daemon.sent.length, 1, 'the first run did not pay');
        assert.strictEqual((await redis.hgetall('wam:balances')).addr1, '500000000',
            'the balance was deducted by a commit that did not answer');
        assert.ok(await redis.get('wam:payment:inflight'),
            'the intent must survive, or nothing can tell what happened');
        assert.strictEqual(sp.paused, true,
            'the run that did not commit left payments running');

        // The next tick, exactly as the timer would fire it.
        await sp.processPayments();
        assert.strictEqual(daemon.sent.length, 1,
            `the same batch was broadcast ${daemon.sent.length} times`);
    });

    await test('and the marker stops it even if nothing paused the pool', async () => {
        // The guard beneath the guard. `paused` is one flag set from seven
        // places, and the whole fault was a path that reached none of them.
        // A test that only checks `paused` would pass again the next time a
        // path is added that forgets it, so this clears the flag by hand and
        // asks whether the marker alone is enough.
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        const sp = make(redis, daemon);

        redis._commitFails = true;
        await sp.processPayments();
        redis._commitFails = false;

        sp.paused = false;                     // as if no path had set it
        await sp.processPayments();

        assert.strictEqual(daemon.sent.length, 1,
            'an unfinished run was found only by a flag, not by its own record');
        assert.strictEqual(sp.paused, true,
            'finding the marker must pause the pool, not just skip one tick');
    });

    await test('a REFUSED payment clears it, so one RPC error does not halt the pool', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        // As daemon.js now classifies it: the node parsed the request and said
        // no, so no transaction exists.
        const daemon = fakeDaemon(() => {
            const e = new Error('Insufficient funds');
            e.ambiguous = false;
            throw e;
        });
        const sp = make(redis, daemon);
        await sp.processPayments();
        assert.strictEqual(await redis.get('wam:payment:inflight'), null,
            'a definite refusal left the pool paused');
        assert.notStrictEqual(sp.paused, true,
            'a definite refusal must not pause the pool');
    });

    // ---- the four findings, each failing on the code as it was -------------
    //
    // Reported by dang150296 (Urriki1502), 2026-10-03. Every one of these
    // passes trivially against the old shareProcessor if you remove the fix,
    // except that it does not: each was run against the old code first and
    // each failed. That is the only reason to believe they test anything.

    await test('an UNKNOWN broadcast outcome keeps the intent and pauses', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon(() => {
            const e = new Error('RPC timeout calling sendmany');
            e.ambiguous = true;
            throw e;
        });
        const sp = make(redis, daemon);
        await sp.processPayments();
        assert.ok(await redis.get('wam:payment:inflight'),
            'a timeout deleted the only evidence that the money may have moved');
        assert.strictEqual(sp.paused, true,
            'the pool kept paying after an outcome it could not determine');
    });

    await test('an unclassified error is treated as unknown, not as a refusal', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon(() => { throw new Error('something nobody classified'); });
        const sp = make(redis, daemon);
        await sp.processPayments();
        assert.ok(await redis.get('wam:payment:inflight'),
            'an error of unknown provenance was assumed harmless');
        assert.strictEqual(sp.paused, true, 'uncertainty did not stop the pool');
    });

    await test('the money commit is one script, and the txid is its name', async () => {
        // It was a pipeline, then a MULTI, and neither is a unit against a
        // command refused at run time. What the commit has to be is one
        // server-side operation whose identity is the transaction, so that a
        // re-sent command cannot deduct twice.
        const redis = fakeRedis({ addr1: '500000000' });
        const sp = make(redis, fakeDaemon());
        await sp.processPayments();
        assert.strictEqual(await redis.sismember('wam:payments:done', 'txid-1'), 1,
            'the commit left no record of which transaction it was for, so a '
            + 're-sent command cannot be told from a second payment');
        assert.strictEqual((await redis.hgetall('wam:balances')).addr1, '0',
            'the balance was not deducted');
        assert.strictEqual((await redis.hgetall('wam:paid')).addr1, '500000000',
            'the paid total was not credited');
    });

    await test('payments are paused until the start-up check has finished', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        let release;
        const held = new Promise((r) => { release = r; });
        // A redis that hangs on the one GET startupReconcile makes.
        const slow = { ...redis, async get(k) { await held; return redis.get(k); } };
        const daemon = fakeDaemon();
        const sp = make(slow, daemon);
        sp.start();
        assert.strictEqual(sp.paused, true,
            'the payment timer was armed before the unfinished-run check answered');
        await sp.processPayments();
        assert.strictEqual(daemon.sent.length, 0,
            'the pool paid while the check that prevents double payment was still running');
        sp.stop();
        release();
    });

    await test('a start-up check that throws leaves payments paused', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const broken = { ...redis, async get() { throw new Error('redis is down'); } };
        const daemon = fakeDaemon();
        const sp = make(broken, daemon);
        sp.start();
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(sp.paused, true,
            'a failed check released payments instead of holding them');
        await sp.processPayments();
        assert.strictEqual(daemon.sent.length, 0, 'the pool paid anyway');
        sp.stop();
    });

    // ---- the payment has a name before it has a fate ----------------------
    //
    // sendmany created and broadcast in one call, so a lost reply left nothing
    // to ask about: no txid, no bytes, nothing to look up and nothing to send
    // again. The only safe answer was to stop and fetch a human.
    //
    // Building and signing first gives the transaction an identity before
    // anybody could have seen it, which turns an unknown outcome into a
    // question with an answer.
    //
    // Reported by dang150296 (Urriki1502), 2026-10-04.

    await test('the txid and the signed bytes are stored BEFORE the broadcast', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        let atBroadcast = null;
        const daemon = fakeDaemon(async () => {
            atBroadcast = await redis.get('wam:payment:inflight');
        });
        const sp = make(redis, daemon);
        await sp.processPayments();

        assert.ok(atBroadcast, 'no intent existed when the money moved');
        const rec = JSON.parse(atBroadcast);
        assert.ok(rec.txid, 'the intent has no txid, so a lost answer is unanswerable');
        assert.ok(rec.hex, 'the intent has no signed bytes, so it cannot be re-sent');
    });

    await test('a lost answer is settled by finding the txid on the node', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        // The broadcast's reply is lost, and the node turns out to have it.
        const cmd = daemon.cmd.bind(daemon);
        daemon.cmd = async function (m, p) {
            if (m === 'sendrawtransaction') {
                const e = new Error('socket hang up'); e.ambiguous = true; throw e;
            }
            if (m === 'getrawtransaction') return { txid: p[0] };
            return cmd(m, p);
        };
        const sp = make(redis, daemon);
        await sp.processPayments();

        assert.notStrictEqual(sp.paused, true,
            'the pool stopped over a payment it could have confirmed was sent');
        assert.strictEqual(await redis.get('wam:payment:inflight'), null,
            'the run completed but left a marker that will pause the next start');
    });

    await test('a lost answer with no transaction re-sends the same bytes', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        const cmd = daemon.cmd.bind(daemon);
        let broadcasts = 0;
        let resentHex = null;
        daemon.cmd = async function (m, p) {
            if (m === 'sendrawtransaction') {
                broadcasts++;
                if (broadcasts === 1) {
                    const e = new Error('RPC timeout'); e.ambiguous = true; throw e;
                }
                resentHex = p[0];
                return 'txid-1';
            }
            return cmd(m, p);     // getrawtransaction says it does not have it
        };
        const sp = make(redis, daemon);
        await sp.processPayments();

        assert.strictEqual(broadcasts, 2, 'the payment was never re-sent');
        assert.ok(resentHex && resentHex.startsWith('signed'),
            're-broadcast something other than the exact signed bytes, which is '
            + 'the one thing that makes a retry safe');
        assert.notStrictEqual(sp.paused, true, 'it paused after a successful retry');
    });

    await test('and if the retry fails too, it stops and says so', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        const cmd = daemon.cmd.bind(daemon);
        daemon.cmd = async function (m, p) {
            if (m === 'sendrawtransaction') {
                const e = new Error('still unreachable'); e.ambiguous = true; throw e;
            }
            return cmd(m, p);
        };
        const sp = make(redis, daemon);
        await sp.processPayments();

        assert.strictEqual(sp.paused, true,
            'it carried on without knowing whether the miners were paid');
        const left = await redis.get('wam:payment:inflight');
        assert.ok(left && JSON.parse(left).hex,
            'the signed bytes were not kept, so nobody can send them by hand');
    });

    await test('a surviving record pauses payments until a human clears it', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        await redis.set('wam:payment:inflight', JSON.stringify({
            startedAt: Date.now(), total: 500000000, payouts: { addr1: 500000000 }
        }));
        const daemon = fakeDaemon();
        const sp = make(redis, daemon);
        const ok = await sp.startupReconcile();
        assert.strictEqual(ok, false, 'reconcile did not report a problem');
        await sp.processPayments();
        assert.strictEqual(daemon.sent.length, 0,
            'the pool paid again over an unfinished previous run');
    });

    await test('no record means a clean start', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const sp = make(redis, fakeDaemon());
        assert.strictEqual(await sp.startupReconcile(), true);
        assert.notStrictEqual(sp.paused, true);
    });

    console.log('\n' + '='.repeat(66));
    if (fail.length === 0) {
        console.log(`\x1b[32m${pass} passed\x1b[0m`);
    } else {
        console.log(`\x1b[31m${fail.length} failed\x1b[0m, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
    }
    console.log('='.repeat(66));
    process.exit(fail.length === 0 ? 0 : 1);
})();
