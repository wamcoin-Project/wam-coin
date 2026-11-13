'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  stranded-block.test.js -- a refused credit is a delay, not a loss
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Two defects, both residues of the fix that stopped a block being credited
//  twice. That fix closed the double-credit by making the in-between state a
//  dead end; what it did not do was leave a way out of the dead end.
//
//  ONE. wamCreditMatured took its exactly-once marker on its first lines and
//  ran the refusable checks after it. Redis does not roll back the writes a
//  script made before an error_reply, so a balances field of the wrong type
//  meant: the block marked credited, nobody paid, and every later call
//  answering "already credited". One block's miners, 47.5 WAM, never paid --
//  and atomic.js's own header said "anything that can be refused is checked
//  BEFORE the first write", which was true of the other two scripts and
//  false of this one.
//
//  TWO. The block was then stranded. _mature throws when the credit is
//  refused, the call sat outside every try, so one refusal ended the whole
//  sweep tick and every later block in it stayed pending though nothing was
//  wrong with them. And the stranded block itself had no way back:
//  recordBlock refuses a hash already maturing, and nothing anywhere
//  re-read blocks:maturing to credit it. The log said the evidence was kept
//  "for an operator to replay by hand" and there was no replay.
//
//  Reported on 13 November 2026 against v0.1.14, with both measured: the
//  marker present after a refusal, and a block still in blocks:maturing with
//  empty balances across three ticks.
//
//  The fix is the order and a drain. The claim now happens after every
//  check, so a refusal leaves no claim; and _drainMaturing offers anything
//  stranded again on every sweep, which is safe because the credit is
//  idempotent -- a block already credited answers 0 and changes nothing.
//
//  HOW THE FIRST CASE IS KEPT HONEST. The double below does not decide for
//  itself whether a refusal keeps the marker: it reads the real script in
//  lib/atomic.js and refuses the way THAT script's statement order would
//  make a real server refuse. Put the SADD back above the type checks and
//  this test fails without anything here being touched.
// ===========================================================================

const assert = require('assert');
const ShareProcessor = require('../lib/shareProcessor');
const { CREDIT_MATURED } = require('../lib/atomic');
const { attachAtomic, attachUnsupported,
        CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME,
        CREDIT_SHARE_NAME, COMMIT_PAYMENT_NAME } = require('./fakeAtomic');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

const HASH = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

// Read off the real script: does the claim come after every refusal?
// A server executing it keeps whatever the script wrote before the error.
const CLAIM_AT = CREDIT_MATURED.indexOf("SADD', KEYS[1]");
const LAST_REFUSAL_AT = CREDIT_MATURED.lastIndexOf('error_reply');
assert.ok(CLAIM_AT > 0 && LAST_REFUSAL_AT > 0,
          'wamCreditMatured no longer looks like the script this measures');
const REFUSAL_KEEPS_THE_CLAIM = CLAIM_AT < LAST_REFUSAL_AT;

/**
 * A Redis double for the maturation path, with one fault that can be turned
 * on and off between sweeps: `r.fault = true` makes the credit refuse the way
 * a wrong-typed balances field makes the real script refuse.
 */
function fakeRedis() {
    const hashes = {}, lists = {}, sets = {}, strings = {};
    const own = (k) => { if (!sets[k]) sets[k] = new Set(); return sets[k]; };
    const r = {
        fault: false,
        _hashes: hashes, _lists: lists, _sets: sets,
        async hgetall(k) { return { ...(hashes[k] || {}) }; },
        async hset(k, f, v) { (hashes[k] = hashes[k] || {})[f] = v; return 1; },
        async hdel(k, f) { if (hashes[k]) delete hashes[k][f]; return 1; },
        async get(k) { return strings[k] ?? null; },
        async set(k, v) { strings[k] = v; return 'OK'; },
        async del(k) { delete strings[k]; return 1; },
        async sismember(k, v) { return own(k).has(v) ? 1 : 0; },
        async scard(k) { return own(k).size; },
        async incr(k) { strings[k] = String(Number(strings[k] || 0) + 1); return 1; },
        async lrange(k, a, b) {
            const l = lists[k] || [];
            return l.slice(a, b < 0 ? l.length + b + 1 : b + 1);
        },
        async lrem(k, _count, v) {
            const l = lists[k] || [];
            for (let i = l.length - 1; i >= 0; i--) if (l[i] === v) l.splice(i, 1);
            return 1;
        },
        pipeline() {
            const q = [];
            const self = {
                ltrim() { return self; }, incr() { return self; },
                decrby() { return self; }, async exec() { return q; }
            };
            return self;
        }
    };
    const asMap = (k) => {
        hashes[k] = hashes[k] || {};
        return {
            get: (f) => hashes[k][f],
            set: (f, v) => { hashes[k][f] = String(v); },
            has: (f) => Object.prototype.hasOwnProperty.call(hashes[k], f),
            delete: (f) => delete hashes[k][f],
            clear: () => { hashes[k] = {}; }
        };
    };
    attachAtomic(r, asMap, (k) => (lists[k] = lists[k] || []),
                 { members: own, unset: (k) => { delete strings[k]; } });

    const healthyCredit = r.wamCreditMatured;
    r.wamCreditMatured = async (creditedKey, ...rest) => {
        if (!r.fault) return healthyCredit(creditedKey, ...rest);
        // rest: balances, confirmed, count, hashes, maturing, blockHash, ...
        if (REFUSAL_KEEPS_THE_CLAIM) own(creditedKey).add(rest[5]);
        throw new Error('balances is not a hash');
    };
    // Nothing here mines, pays or records blocks; a stub that answered
    // anyway would let a test pass without asserting.
    attachUnsupported(r, 'it models maturation only',
                      [RECORD_BLOCK_NAME, CREDIT_SHARE_NAME, COMMIT_PAYMENT_NAME]);
    void CLAIM_AND_RECORD_NAME;
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

const RECORD = (hash, height) => JSON.stringify({
    blockHash: hash, height, confirmations: 101, workers: 2,
    minerPot: 4750000000, poolFee: 0,
    payouts: { 'Waaa.rig': 2375000000, 'Wbbb.rig': 2375000000 }
});

(async () => {
    console.log(`\n${BLD}  a refused credit is a delay, not a loss${OFF}\n`);

    await test('a refused credit leaves no claim behind', async () => {
        const r = fakeRedis();
        r.fault = true;
        r._hashes['wam:blocks:pending'] = { [HASH]: RECORD(HASH, 10) };
        await make(r, { [HASH]: { confirmations: 101 } }).checkPendingBlocks();

        assert.strictEqual(await r.sismember('wam:blocks:credited', HASH), 0,
            'the block is marked credited and nobody was paid: every later '
            + 'call answers "already credited" and the 47.5 WAM is never sent');
    });

    await test('the refusal leaves the payout table where it can be found', async () => {
        const r = fakeRedis();
        r.fault = true;
        r._hashes['wam:blocks:pending'] = { [HASH]: RECORD(HASH, 10) };
        await make(r, { [HASH]: { confirmations: 101 } }).checkPendingBlocks();

        const waiting = await r.lrange('wam:blocks:maturing', 0, -1);
        assert.strictEqual(waiting.length, 1,
            'the only statement of who was owed what for this block is gone');
        assert.deepStrictEqual(r._hashes['wam:balances'] || {}, {},
            'a refused credit moved a balance');
    });

    await test('and a later sweep pays it once the fault is cleared', async () => {
        const r = fakeRedis();
        r.fault = true;
        r._hashes['wam:blocks:pending'] = { [HASH]: RECORD(HASH, 10) };
        const sp = make(r, { [HASH]: { confirmations: 101 } });

        await sp.checkPendingBlocks();                  // refused, stranded
        r.fault = false;                                // the operator fixes it
        await sp.checkPendingBlocks();                  // the drain offers it again

        assert.strictEqual((r._hashes['wam:balances'] || {}).Waaa, '2375000000',
            'the stranded block was never offered to the credit again: its '
            + 'miners stay unpaid and nothing anywhere reads blocks:maturing');
        assert.strictEqual((await r.lrange('wam:blocks:maturing', 0, -1)).length, 0,
            'it was credited but left in blocks:maturing');
    });

    await test('the drain cannot pay a credited block twice', async () => {
        const r = fakeRedis();
        r._hashes['wam:blocks:pending'] = { [HASH]: RECORD(HASH, 10) };
        const sp = make(r, { [HASH]: { confirmations: 101 } });
        await sp.checkPendingBlocks();

        // Put the evidence back by hand, as an interrupted LREM would leave
        // it, and sweep again: the marker inside the script is what stops it.
        r._lists['wam:blocks:maturing'] = [RECORD(HASH, 10)];
        await sp.checkPendingBlocks();

        assert.strictEqual((r._hashes['wam:balances'] || {}).Waaa, '2375000000',
            'the drain credited a block that was already credited');
    });

    await test('one block that cannot be credited does not stop the others', async () => {
        const r = fakeRedis();
        r.fault = true;
        r._hashes['wam:blocks:pending'] = {
            [HASH]: RECORD(HASH, 10), [OTHER]: RECORD(OTHER, 11)
        };
        await make(r, {
            [HASH]: { confirmations: 101 }, [OTHER]: { confirmations: 101 }
        }).checkPendingBlocks();

        assert.deepStrictEqual(Object.keys(r._hashes['wam:blocks:pending']), [],
            'one refused credit ended the sweep and left a healthy block '
            + 'pending, with nothing wrong with it');
        assert.strictEqual((await r.lrange('wam:blocks:maturing', 0, -1)).length, 2,
            'both blocks should have reached the credit');
    });

    await test('a drain that cannot read the list is a delay, not a crash', async () => {
        const r = fakeRedis();
        const broken = r.lrange;
        let asked = 0;
        r.lrange = async (k, a, b) => {
            if (k === 'wam:blocks:maturing' && asked++ === 0) {
                throw new Error('LOADING Redis is loading the dataset in memory');
            }
            return broken.call(r, k, a, b);
        };
        r._hashes['wam:blocks:pending'] = { [HASH]: RECORD(HASH, 10) };
        await make(r, { [HASH]: { confirmations: 101 } }).checkPendingBlocks();

        assert.strictEqual((r._hashes['wam:balances'] || {}).Waaa, '2375000000',
            'a drain that could not read the list took the whole sweep with '
            + 'it, so the healthy blocks behind it were not credited either');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: nothing is stranded${OFF}\n`);
})();
