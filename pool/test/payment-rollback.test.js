'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  payment-rollback.test.js -- when redis comes back younger than the money
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Every defence the payment path has is written into redis, and redis on
//  its defaults is a few minutes behind its own disk. A kill -9, a power
//  cut, a failover to a replica that was behind, a restore from a snapshot:
//  redis comes back as it was at the last save.
//
//  That takes all three defences at once. The balances come back owed, the
//  payment:inflight marker that would have paused the pool is gone, and the
//  payments:done entry that would have refused a second commit is gone. The
//  next run reads a state that is perfectly consistent and simply older than
//  the money, and pays the same miners again out of the pool's wallet.
//
//  Nothing in the pool could see it, because the pool had nowhere to look
//  that redis could not rewrite.
//
//  Reported by dang150296 (Urriki1502) on 10 November 2026.
//
//  The fix is pool/lib/journal.js: an append-only file, fsynced before the
//  broadcast, reconciled against redis before every run. It does not make
//  redis durable and it cannot rebuild what a rollback destroyed. It makes
//  the pool refuse to pay while redis disagrees with the file.
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ShareProcessor = require('../lib/shareProcessor');
const { PaymentJournal } = require('../lib/journal');
const { attachAtomic, attachUnsupported,
        CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME, CREDIT_MATURED_NAME,
        CREDIT_SHARE_NAME } = require('./fakeAtomic');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function test(name, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-journal-'));
    try { await fn(path.join(dir, 'payments.journal')); pass++;
          console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function fakeRedis(balances = {}) {
    const hashes = { 'wam:balances': { ...balances }, 'wam:paid': {} };
    const strings = {};
    const lists = {};
    const sets = {};
    const own = (k) => {
        if (!sets[k]) sets[k] = new Set();
        return sets[k];
    };

    const r = {
        _strings: strings,
        _sets: sets,
        _hashes: hashes,
        async hgetall(k) { return { ...(hashes[k] || {}) }; },
        async get(k) { return strings[k] ?? null; },
        async set(k, v) { strings[k] = v; },
        async del(k) { delete strings[k]; },
        async sismember(k, v) { return own(k).has(v) ? 1 : 0; },
        async scard(k) { return own(k).size; },
        async lrange(k, a, b) {
            const l = lists[k] || [];
            return l.slice(a, b < 0 ? l.length + b + 1 : b + 1);
        }
    };

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
        { members: own, unset: (k) => { delete strings[k]; } });
    attachUnsupported(r, 'it models balances and the payment batch, not block maturation',
                      [CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME,
                       CREDIT_MATURED_NAME, CREDIT_SHARE_NAME]);
    return r;
}

function fakeDaemon() {
    return {
        // `sent` is every transaction BUILT, `broadcast` every one actually
        // handed to the node. They are not the same question and this file
        // needs both: a payment the journal could not record must be built
        // and then not broadcast.
        sent: [],
        broadcast: [],
        async getBalance() { return 1000000; },
        async cmd(method, params) {
            switch (method) {
                case 'createrawtransaction':
                    this.sent.push(params[1]);
                    return 'raw' + this.sent.length;
                case 'fundrawtransaction':
                    return { hex: 'funded' + this.sent.length };
                case 'signrawtransactionwithwallet':
                    return { complete: true, hex: 'signed' + this.sent.length };
                case 'decoderawtransaction':
                    return { txid: `txid-${this.sent.length}` };
                case 'sendrawtransaction':
                    this.broadcast.push(params[0]);
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

function make(redis, daemon, journalPath, cfg = {}) {
    return new ShareProcessor(redis, daemon, {
        redisPrefix: 'wam', rewardMode: 'pplns', minimumPayoutWam: 1,
        paymentJournal: journalPath, ...cfg
    }, quiet);
}

/**
 * What a rollback leaves behind: the money gone, and every key redis holds
 * back at the value it had at the last save. The balances owed again, no
 * payment:inflight marker, no record that the transaction ever happened --
 * all three together, which is why nothing inside redis could see it.
 */
function rollRedisBack(redis, balances) {
    redis._hashes['wam:balances'] = { ...balances };
    redis._hashes['wam:paid'] = {};
    delete redis._strings['wam:payment:inflight'];
    delete redis._sets['wam:payments:done'];
    return redis;
}

(async () => {
    console.log(`\n${BLD}  when redis comes back younger than the money${OFF}\n`);

    await test('an ordinary run writes the journal before it broadcasts', async (jp) => {
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        let atSendTime = null;
        const sendrawtransaction = daemon.cmd.bind(daemon);
        daemon.cmd = async function cmd(method, params) {
            if (method === 'sendrawtransaction') {
                atSendTime = fs.existsSync(jp) ? fs.readFileSync(jp, 'utf8') : null;
            }
            return sendrawtransaction(method, params);
        };
        await make(redis, daemon, jp).processPayments();

        assert.ok(atSendTime, 'nothing was journalled before the money moved');
        assert.ok(atSendTime.includes('txid-1'),
            'the journal line written before the broadcast does not name the '
            + 'transaction, so it cannot be reconciled against redis afterwards');
        const { entries } = new PaymentJournal(jp, quiet).read();
        assert.ok(entries.get('txid-1').committedAt,
            'the commit was not journalled, so the next run cannot tell a '
            + 'rollback from a payment that never happened');
    });

    await test('a committed payment redis no longer has stops the pool', async (jp) => {
        // THE MEASUREMENT. One run pays; redis then comes back as it was
        // before that run, which is what a snapshot restore, a kill -9 or a
        // failover to a replica that was behind actually gives you.
        const owed = { addr1: '500000000' };
        const redis = fakeRedis(owed);
        const first = fakeDaemon();
        await make(redis, first, jp).processPayments();
        assert.strictEqual(first.sent.length, 1, 'the first run did not pay');

        rollRedisBack(redis, owed);

        const again = fakeDaemon();
        const sp = make(redis, again, jp);     // a restarted pool, same journal
        await sp.processPayments();

        assert.strictEqual(sp.paused, true,
            'redis lost a payment it had already recorded and the pool carried on');
        assert.strictEqual(again.sent.length, 0,
            `the same balance was paid ${again.sent.length} more time(s) after a `
            + 'redis rollback -- out of the pool operator\'s own wallet');
    });

    await test('and the start-up check refuses to release payments', async (jp) => {
        // start() pauses payments and startupReconcile() is the only thing
        // that releases them. Reading the marker was all it did, and after a
        // rollback there is no marker to read.
        const owed = { addr1: '500000000' };
        const redis = fakeRedis(owed);
        await make(redis, fakeDaemon(), jp).processPayments();
        rollRedisBack(redis, owed);

        const sp = make(redis, fakeDaemon(), jp);
        const released = await sp.startupReconcile();
        assert.strictEqual(released, false,
            'the start-up check released payments over a redis that had gone back');
        assert.strictEqual(sp.paused, true, 'the pool was left able to pay');
    });

    await test('a broadcast with no commit and no marker stops the pool', async (jp) => {
        // The other half of a rollback: redis lost the marker too, so the
        // one record that a transaction is in the air is this file.
        new PaymentJournal(jp, quiet).recordBroadcast('txid-stranded', 500000000,
                                                      { addr1: 500000000 });
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        const sp = make(redis, daemon, jp);
        await sp.processPayments();

        assert.strictEqual(daemon.sent.length, 0,
            'a transaction nothing can account for did not stop the payment');
        assert.strictEqual(sp.paused, true, 'the pool was not paused');
    });

    await test('a transaction the node refused is not money in the air', async (jp) => {
        // The journal line is written BEFORE the broadcast, so a refusal
        // leaves an entry for a transaction that never existed. Without the
        // abandoned line that entry would stop every run from then on.
        const redis = fakeRedis({ addr1: '500000000' });
        const refusing = fakeDaemon();
        const inner = refusing.cmd.bind(refusing);
        refusing.cmd = async function cmd(method, params) {
            if (method === 'sendrawtransaction') {
                const e = new Error('Insufficient funds');
                e.ambiguous = false;
                throw e;
            }
            return inner(method, params);
        };
        const sp = make(redis, refusing, jp);
        await sp.processPayments();
        assert.notStrictEqual(sp.paused, true, 'a definite refusal paused the pool');

        // The wallet is funded again and the next run must simply pay.
        const ok = fakeDaemon();
        const next = make(redis, ok, jp);
        await next.processPayments();
        assert.strictEqual(ok.sent.length, 1,
            'a refused transaction was mistaken for money in the air for ever');
        assert.notStrictEqual(next.paused, true, 'the pool stayed paused');
    });

    await test('a journal that cannot be written stops the payment', async (jp) => {
        // The file is the thing that makes the broadcast accountable. If it
        // cannot be written the broadcast must not happen -- which is the
        // one ordering this whole file is about.
        fs.mkdirSync(jp);                      // a directory where the file goes
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        const sp = make(redis, daemon, jp);
        await sp.processPayments();

        assert.strictEqual(daemon.broadcast.length, 0,
            'the pool broadcast a payment it could not record');
        assert.strictEqual((await redis.hgetall('wam:balances')).addr1, '500000000',
            'the balance moved for a payment that was never recorded');
    });

    await test('a truncated last line is read, not thrown on', async (jp) => {
        const journal = new PaymentJournal(jp, quiet);
        journal.recordBroadcast('txid-1', 1, { a: 1 });
        journal.recordCommitted('txid-1');
        fs.appendFileSync(jp, '{"at":17944,"state":"broad');   // the power went

        const { entries, damaged } = journal.read();
        assert.strictEqual(damaged, 1, 'the half-written line was not noticed');
        assert.ok(entries.get('txid-1').committedAt,
            'one unreadable line lost the whole file');
    });

    await test('a missing journal is reported and does not stop payments', async (jp) => {
        // The detector is blind, which an operator must be told. It is not a
        // reason to stop paying miners: redis is the stronger record in this
        // direction and nothing here says money moved twice.
        const redis = fakeRedis({ addr1: '500000000' });
        redis._sets['wam:payments:done'] = new Set(['txid-older']);
        const daemon = fakeDaemon();
        const said = [];
        const sp = new ShareProcessor(redis, daemon, {
            redisPrefix: 'wam', rewardMode: 'pplns', minimumPayoutWam: 1,
            paymentJournal: jp
        }, { info() {}, debug() {}, warn(m) { said.push(m); }, error(m) { said.push(m); } });

        await sp.processPayments();
        assert.strictEqual(daemon.sent.length, 1,
            'a missing log file stopped the miners being paid');
        assert.ok(said.some((m) => String(m).includes(jp)),
            'the pool did not say that the rollback detector was blind');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: the record outlives redis${OFF}\n`);
})();
