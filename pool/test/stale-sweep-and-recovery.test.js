// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  stale-sweep-and-recovery.test.js -- the four money faults Radenlingga
//                                      measured on 2026-11-26
// ===========================================================================
//
//      node pool/test/stale-sweep-and-recovery.test.js
//
//  WHY THIS EXISTS
//
//  Four separate reports, all against v0.1.15's own code, all reproduced by
//  the reporter with harnesses that MEASURED rather than argued. Each is
//  driven here against the real ShareProcessor, the real journal and the
//  repository's own fakeAtomic, so a regression fails here rather than in
//  somebody's balance.
//
//    1  a stale sweep wrote its snapshot back over blocks:pending and
//       resurrected a block another sweep had already claimed -- one block
//       orphaned twice, poolfees 500 -> -500
//    2  the maturing drain credited a stranded block without asking the
//       chain -- 4,750,000,000 base units credited for a block the node was
//       reporting at confirmations -1, with getBlock called zero times
//    3  reconcile() checked only the last 100 entries, ordered by broadcast,
//       so a late-committed payment whose redis record was lost passed with
//       no complaint at all
//    4  read() reported partial: true on a truncated journal and reconcile()
//       dropped the flag
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ShareProcessor = require('../lib/shareProcessor');
const { PaymentJournal, reconcile, CHECK_RECENT, TAIL_BYTES } = require('../lib/journal');
const { attachAtomic } = require('./fakeAtomic');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
let pass = 0;
const fail = [];

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

function fakeRedis() {
    const hashes = new Map(), lists = new Map(), sets = new Map(), strings = new Map();
    const H = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
    const L = (k) => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); };
    const S = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
    const r = {
        _H: H, _L: L, _S: S, _str: strings,
        async hgetall(k) { return Object.fromEntries(H(k)); },
        async hset(k, f, v) { H(k).set(f, String(v)); return 1; },
        async hsetnx(k, f, v) { if (H(k).has(f)) return 0; H(k).set(f, String(v)); return 1; },
        async hdel(k, f) { return H(k).delete(f) ? 1 : 0; },
        async hexists(k, f) { return H(k).has(f) ? 1 : 0; },
        async get(k) { return strings.has(k) ? strings.get(k) : null; },
        async set(k, v) { strings.set(k, String(v)); return 'OK'; },
        async del(k) { strings.delete(k); hashes.delete(k); lists.delete(k); return 1; },
        async sismember(k, v) { return S(k).has(v) ? 1 : 0; },
        async scard(k) { return S(k).size; },
        async lrange(k, a, b) { const l = L(k); return l.slice(a, b < 0 ? l.length + b + 1 : b + 1); },
        async lrem(k, _c, v) { const l = L(k); let n = 0; for (let i = l.length - 1; i >= 0; i--) if (l[i] === v) { l.splice(i, 1); n++; } return n; },
        pipeline() {
            const ops = [];
            const self = {
                ltrim(k, a, b) { ops.push(() => { lists.set(k, L(k).slice(a, b + 1)); }); return self; },
                incr(k) { ops.push(() => { strings.set(k, String(Number(strings.get(k) || 0) + 1)); return 1; }); return self; },
                decrby(k, n) { ops.push(() => { strings.set(k, String(Number(strings.get(k) || 0) - n)); return 1; }); return self; },
                async exec() { return ops.map((f) => [null, f()]); }
            };
            return self;
        }
    };
    attachAtomic(r, H, L, {
        members: S,
        unset: (k) => { strings.delete(k); },
        count: (k) => { strings.set(k, String(Number(strings.get(k) || 0) + 1)); },
        drop: (k) => { hashes.delete(k); lists.delete(k); strings.delete(k); sets.delete(k); },
        fee: (k, n) => { strings.set(k, String(Number(strings.get(k) || 0) + Number(n))); }
    });
    return r;
}

const HASH = 'ab'.repeat(32);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-sweep-'));
const cfg = (j) => ({
    redisPrefix: 'wam', rewardMode: 'pplns', coinbaseMaturity: 100,
    paymentJournal: path.join(tmp, j)
});

(async () => {
    console.log('\n\x1b[1m  a stale sweep cannot resurrect a claimed block\x1b[0m\n');

    await test('a snapshot is not written back over a field another sweep took', async () => {
        const redis = fakeRedis();
        const record = JSON.stringify({
            blockHash: HASH, height: 10, confirmations: 0, workers: 1,
            minerPot: 4750000000, poolFee: 500, payouts: { 'Waaa.rig': 4750000000 }
        });
        redis._H('wam:blocks:pending').set(HASH, record);
        redis._str.set('wam:poolfees', '500');

        let release;
        const gate = new Promise((r) => { release = r; });
        // B is on a lagging daemon: the block still looks immature to it.
        const spB = new ShareProcessor(redis, {
            async getBlock() { await gate; return { confirmations: 50 }; },
            async cmd() { return null; }
        }, cfg('b.journal'), quiet);
        // A is current: the block is orphaned.
        const spA = new ShareProcessor(redis, {
            async getBlock() { return { confirmations: -1 }; },
            async cmd() { return null; }
        }, cfg('a.journal'), quiet);

        const runB = spB.checkPendingBlocks();
        await new Promise((r) => setTimeout(r, 20));
        await spA.checkPendingBlocks();          // claims and orphans it
        release();
        await runB;                              // B tries to write its snapshot back

        assert.strictEqual(redis._H('wam:blocks:pending').has(HASH), false,
            'the stale sweep put the claimed block back into blocks:pending');

        await spA.checkPendingBlocks();          // nothing left to claim twice
        assert.strictEqual(redis._str.get('wam:poolfees'), '0',
            `poolfees is ${redis._str.get('wam:poolfees')}; the 500 fee was `
            + 'reversed more than once');
        assert.strictEqual(Number(redis._str.get('wam:blocks:orphaned:count')), 1,
            'the block was orphaned more than once');
    });

    console.log('\n\x1b[1m  the drain asks the chain before it credits\x1b[0m\n');

    await test('a block reorganised while stranded is orphaned, not credited', async () => {
        const redis = fakeRedis();
        const record = JSON.stringify({
            blockHash: HASH, height: 10, confirmations: 101, workers: 2,
            minerPot: 4750000000, poolFee: 0,
            payouts: { 'Waaa.rig': 2375000000, 'Wbbb.rig': 2375000000 }
        });
        redis._H('wam:blocks:pending').set(HASH, record);

        const daemon = {
            view: { confirmations: 101 },
            calls: 0,
            async getBlock() { this.calls++; return this.view; },
            async cmd() { return null; }
        };
        const sp = new ShareProcessor(redis, daemon, cfg('c.journal'), quiet);

        // The credit refuses, so the block strands in blocks:maturing.
        const healthy = redis.wamCreditMatured;
        redis.wamCreditMatured = async () => { throw new Error('balances is not a hash'); };
        await sp.checkPendingBlocks();
        assert.strictEqual(redis._L('wam:blocks:maturing').length, 1,
            'the refused credit did not strand the block, so the case is not set up');

        // The chain then reorganises it out, and the fault clears.
        daemon.view = { confirmations: -1 };
        redis.wamCreditMatured = healthy;
        daemon.calls = 0;
        await sp.checkPendingBlocks();

        assert.ok(daemon.calls > 0,
            'the crediting sweep asked the chain nothing at all');
        assert.strictEqual(redis._H('wam:balances').get('Waaa'), undefined,
            'an orphaned block was credited');
        assert.strictEqual(redis._L('wam:blocks:confirmed').length, 0,
            'an orphaned block was written to blocks:confirmed');
    });

    console.log('\n\x1b[1m  reconcile sees every committed payment\x1b[0m\n');

    await test('a late-committed payment outside the window is still checked', async () => {
        const jp = path.join(tmp, 'window.journal');
        fs.rmSync(jp, { force: true });
        const journal = new PaymentJournal(jp, quiet);
        const victim = 'aa'.repeat(32);
        const done = new Set();

        journal.recordBroadcast(victim, 5000, { Waaa: 5000 });
        for (let i = 1; i <= CHECK_RECENT + 5; i++) {
            const t = (i.toString(16).padStart(4, '0') + 'bb'.repeat(30)).slice(0, 64);
            journal.recordBroadcast(t, 1000, { Waaa: 1000 });
            journal.recordCommitted(t);
            done.add(t);
        }
        journal.recordCommitted(victim);      // commits after all of them

        const redis = {
            async sismember(_k, v) { return done.has(v) ? 1 : 0; },
            async scard() { return done.size; }
        };
        const complaints = await reconcile(journal, redis, 'wam:payments:done', null);
        const fatals = complaints.filter((c) => c.fatal);
        assert.ok(fatals.length >= 1,
            'redis lost a committed payment and reconcile said nothing: '
            + JSON.stringify(complaints));
        assert.ok(fatals.some((c) => c.text.includes(victim)),
            'the complaint does not name the payment whose record was lost');
    });

    await test('a truncated journal is reported rather than passed over', async () => {
        const jp = path.join(tmp, 'partial.journal');
        const lines = [];
        const at = 1764000000000;
        const done = new Set();
        for (let i = 1; i <= 2200; i++) {
            const t = (i.toString(16).padStart(6, '0') + 'dd'.repeat(29)).slice(0, 64);
            lines.push(JSON.stringify({ at: at + i * 2, state: 'broadcast', txid: t, total: 1000, payouts: { Waaa: 1000 } }));
            lines.push(JSON.stringify({ at: at + i * 2 + 1, state: 'committed', txid: t }));
            done.add(t);
        }
        fs.writeFileSync(jp, lines.join('\n') + '\n');
        assert.ok(fs.statSync(jp).size > TAIL_BYTES, 'the fixture is not long enough to truncate');

        const journal = new PaymentJournal(jp, quiet);
        assert.strictEqual(journal.read().partial, true, 'read() did not report a truncated journal');

        const redis = {
            async sismember(_k, v) { return done.has(v) ? 1 : 0; },
            async scard() { return done.size; }
        };
        const complaints = await reconcile(journal, redis, 'wam:payments:done', null);
        assert.ok(complaints.some((c) => /only its tail was read/i.test(c.text)),
            'reconcile ignored read()\'s partial flag: ' + JSON.stringify(complaints));
    });

    console.log();
    if (fail.length) {
        console.log(`\x1b[31m\x1b[1m  ${fail.length} failed\x1b[0m`);
        for (const f of fail) console.log(`        ${f}`);
        process.exit(1);
    }
    console.log(`\x1b[32m\x1b[1m  ${pass} passed\x1b[0m\n`);
})();
