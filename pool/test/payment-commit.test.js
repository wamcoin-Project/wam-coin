'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  payment-commit.test.js -- the money moved; the books must follow, or not
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  The commit that follows a broadcast was a MULTI, and a MULTI is one unit
//  against a lost connection and no unit at all against a command refused at
//  run time: redis applies the rest and hands the error back. `DEL
//  payment:inflight` sat in the middle of it.
//
//  So with one balance field holding a non-integer -- which parseInt accepts
//  and HINCRBY does not -- the deduction was refused, the journal entry and
//  the paid counter were written anyway, and the marker was deleted. The pool
//  read the replies, found the failure, logged THE COMMIT PARTLY FAILED and
//  paused, which was the right thing to do and bought nothing: the marker
//  that pause depends on was already gone. The restart found nothing to
//  reconcile, released payments, read the same undeducted balance, built the
//  same batch and broadcast it again.
//
//  Two confirmed transactions, one owed balance, measured on regtest with the
//  money real.
//
//  Reported by dang150296 (Urriki1502) on 10 November 2026 as manifestation C
//  of one root cause -- the same root cause as the maturation credit and the
//  share accounting: a sequence of writes whose first half cannot be undone
//  if the second half is refused.
//
//  THE DOUBLE SPEAKS BOTH LANGUAGES ON PURPOSE.
//
//  It has the script AND a working MULTI, so every case below can be run
//  against the shareProcessor as it was. Four of the six fail there. A test
//  written after the fix, against a double that only knows the fix, proves
//  that the code calls what it calls.
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ShareProcessor = require('../lib/shareProcessor');
const { attachAtomic, attachUnsupported,
        CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME, CREDIT_MATURED_NAME,
        CREDIT_SHARE_NAME, COMMIT_PAYMENT_NAME } = require('./fakeAtomic');
const { attachMulti } = require('./fakeMulti');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// One throwaway directory for the payment journals, one file per double: the
// default lives inside the pool's own tree and a suite must not write there.
const JOURNALS = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-payment-commit-'));
let journalSeq = 0;
process.on('exit', () => fs.rmSync(JOURNALS, { recursive: true, force: true }));

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

/**
 * Enough of ioredis to drive the payment path, with one thing modelled that
 * the other payment doubles in this directory do not model: HINCRBY REFUSES
 * a field that does not hold an integer, the way a real server does. That is
 * the failure the whole file is about, and a double that cannot produce it
 * cannot be used to ask what happens next.
 */
function fakeRedis(balances = {}) {
    const hashes = { 'wam:balances': { ...balances }, 'wam:paid': {} };
    const strings = {};
    const lists = {};
    const sets = {};

    const r = {
        _strings: strings,
        _lists: lists,
        _hashes: hashes,
        _journalPath: path.join(JOURNALS, `j${++journalSeq}.journal`),
        async hgetall(k) { return { ...(hashes[k] || {}) }; },
        async get(k) { return strings[k] ?? null; },
        async set(k, v) { strings[k] = v; },
        async del(k) { delete strings[k]; },
        async sismember(k, v) { return sets[k] && sets[k].has(v) ? 1 : 0; },
        async scard(k) { return sets[k] ? sets[k].size : 0; },
        // Redis counts the stop index from the end when it is negative, and
        // -1 means the last element. slice(a, -1 + 1) is the empty array,
        // which is how a double answers "nothing was written" to a question
        // about something that was.
        async lrange(k, a, b) {
            const l = lists[k] || [];
            return l.slice(a, b < 0 ? l.length + b + 1 : b + 1);
        },
        // The one command that refuses. Redis answers "hash value is not an
        // integer" and applies nothing -- and inside a MULTI it answers that
        // while the commands after it run regardless.
        async hincrby(k, f, by) {
            hashes[k] = hashes[k] || {};
            const held = hashes[k][f];
            if (held !== undefined && !/^-?\d+$/.test(String(held))) {
                throw new Error('ERR hash value is not an integer');
            }
            hashes[k][f] = String((parseInt(held || '0', 10)) + Number(by));
            return Number(hashes[k][f]);
        },
        async lpush(k, v) { (lists[k] = lists[k] || []).unshift(v); return lists[k].length; },
        async ltrim(k, a, b) {
            const l = lists[k] || [];
            lists[k] = l.slice(a, b < 0 ? l.length + b + 1 : b + 1);
            return 'OK';
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
        {
            members: (k) => {
                if (!sets[k]) sets[k] = new Set();
                return sets[k];
            },
            unset: (k) => { delete strings[k]; }
        });
    // So that this file can be run against the shareProcessor as it was.
    attachMulti(r);
    attachUnsupported(r, 'it models balances and the payment batch, not block maturation',
                      [CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME,
                       CREDIT_MATURED_NAME, CREDIT_SHARE_NAME]);
    return r;
}

/**
 * Deliver every commit twice, which is what ioredis does on its defaults
 * when a connection drops with a command unacknowledged: it re-sends it. The
 * caller sees one promise either way, so this is invisible to the pool --
 * which is exactly why the defence has to live inside the command.
 */
function deliverTwice(redis) {
    const commit = redis[COMMIT_PAYMENT_NAME];
    redis[COMMIT_PAYMENT_NAME] = async (...args) => {
        await commit(...args);
        return commit(...args);
    };
    const multi = redis.multi;
    redis.multi = function reSent() {
        const api = multi.call(redis);
        const exec = api.exec;
        api.exec = async () => { await exec(); return exec(); };
        return api;
    };
    return redis;
}

function fakeDaemon() {
    return {
        sent: [],
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
    console.log(`\n${BLD}  the money moved; the books must follow, or not${OFF}\n`);

    await test('an ordinary payment is committed once, in full', async () => {
        const redis = fakeRedis({ addr1: '500000000', addr2: '300000000' });
        const daemon = fakeDaemon();
        await make(redis, daemon).processPayments();

        assert.strictEqual(daemon.sent.length, 1, 'nothing was paid');
        assert.strictEqual((await redis.hgetall('wam:balances')).addr1, '0');
        assert.strictEqual((await redis.hgetall('wam:balances')).addr2, '0');
        assert.strictEqual((await redis.hgetall('wam:paid')).addr1, '500000000');
        assert.strictEqual(await redis.sismember('wam:payments:done', 'txid-1'), 1,
            'the commit kept no record of which transaction it was for');
        assert.strictEqual(await redis.get('wam:payment:inflight'), null,
            'a finished run left a marker that will pause the next start-up');
        const journal = JSON.parse((await redis.lrange('wam:payments', 0, 0))[0]);
        assert.strictEqual(journal.txid, 'txid-1');
    });

    await test('a REFUSED commit leaves the marker exactly where it was', async () => {
        // THE MEASUREMENT THE REPORT WAS BUILT ON.
        //
        // A balance of 500000000.5 -- what one HINCRBYFLOAT anywhere in the
        // pool's history leaves behind. parseInt reads it as 500000000 and
        // pays that; HINCRBY then refuses the field. Against the MULTI the
        // deduction failed and the DEL below it ran anyway.
        const redis = fakeRedis({ addr1: '500000000.5' });
        const daemon = fakeDaemon();
        const sp = make(redis, daemon);
        await sp.processPayments();

        assert.strictEqual(daemon.sent.length, 1, 'the payment was not sent');
        assert.ok(await redis.get('wam:payment:inflight'),
            'the commit was refused and the marker was deleted anyway -- so '
            + 'nothing is left to tell the next run that this batch was paid');
        assert.strictEqual((await redis.hgetall('wam:balances')).addr1, '500000000.5',
            'a refused commit still moved the balance');
        assert.strictEqual((await redis.hgetall('wam:paid')).addr1, undefined,
            'a refused commit still credited the paid total');
        assert.strictEqual(await redis.sismember('wam:payments:done', 'txid-1'), 0,
            'a refused commit recorded itself as done');
        assert.strictEqual(sp.paused, true, 'a refused commit left payments running');
    });

    await test('and the run after that refusal pays nobody a second time', async () => {
        // The consequence, driven the way the pool would reach it: the flag
        // is cleared by hand, as a restart clears it, and the only thing
        // standing between the miner and a second transaction is the marker.
        const redis = fakeRedis({ addr1: '500000000.5' });
        const daemon = fakeDaemon();
        const sp = make(redis, daemon);
        await sp.processPayments();

        sp.paused = false;                       // as a restart leaves it
        await sp.processPayments();

        assert.strictEqual(daemon.sent.length, 1,
            `the same batch was broadcast ${daemon.sent.length} times`);
        assert.strictEqual(sp.paused, true,
            'finding the marker must pause the pool, not just skip one tick');
    });

    await test('a commit delivered twice deducts once', async () => {
        // ioredis re-sends a command whose reply never arrived, and every
        // write in the commit is an increment. The txid is the identity, and
        // it is tested inside the command, because the caller cannot see the
        // second delivery at all.
        const redis = deliverTwice(fakeRedis({ addr1: '500000000' }));
        const daemon = fakeDaemon();
        await make(redis, daemon).processPayments();

        assert.strictEqual((await redis.hgetall('wam:balances')).addr1, '0',
            'the second delivery deducted the balance again');
        assert.strictEqual((await redis.hgetall('wam:paid')).addr1, '500000000',
            'the second delivery credited the paid total again');
        assert.strictEqual((await redis.lrange('wam:payments', 0, -1)).length, 1,
            'one payment was journalled twice');
    });

    await test('a commit that does not answer pauses and keeps the marker', async () => {
        const redis = fakeRedis({ addr1: '500000000' });
        const daemon = fakeDaemon();
        const sp = make(redis, daemon);

        redis._commitFails = true;
        await sp.processPayments();
        redis._commitFails = false;

        assert.strictEqual(daemon.sent.length, 1, 'the first run did not pay');
        assert.ok(await redis.get('wam:payment:inflight'),
            'the intent must survive, or nothing can tell what happened');
        assert.strictEqual((await redis.hgetall('wam:balances')).addr1, '500000000',
            'the balance was deducted by a commit that did not answer');
        assert.strictEqual(sp.paused, true,
            'the run that did not commit left payments running');
    });

    await test('the journal keeps a bounded number of payments', async () => {
        // The bound used to be written out as 999 inside the commit. It is an
        // argument now, and an argument that does not arrive is a journal
        // that grows until redis runs out of memory -- which is the commit
        // failing, which is this whole file.
        const redis = fakeRedis({ addr1: '100000000' });
        redis._lists['wam:payments'] = new Array(1200).fill('{"txid":"old"}');
        await make(redis, fakeDaemon()).processPayments();
        assert.strictEqual((await redis.lrange('wam:payments', 0, -1)).length, 1000,
            'the payment journal is not bounded');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: the commit is one decision${OFF}\n`);
})();
