'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  A solved block must outlive the process that solved it
// ===========================================================================
//
//      node pool/test/block-spool.test.js
//
//  WHAT WAS WRONG
//
//  _submitBlock held the only copy of a solved block in a local variable and
//  retried for five seconds. Five was chosen because that is how long the node
//  restart on 5 September 2026 took -- a measurement, which is better than a
//  guess, and still a number that a thirty-second wallet load or a reboot
//  walks straight past. The block was then gone: 47.5 WAM, the largest single
//  loss this pool can suffer, with a log line to remember it by.
//
//  Reported by dang150296 (Urriki1502) on 2026-10-04 as solved-block retry
//  being memory-only.
//
//  WHAT THE SPOOL PROMISES
//
//    * the bytes are written down BEFORE the node is asked
//    * a node that never answered leaves the block spooled
//    * a node that READ it and refused settles it -- no retry forever, and
//      the bytes are kept with the reason rather than deleted
//    * "duplicate" means it was already accepted, so that settles it too
//    * the drain offers everything again, at start-up above all, because that
//      is the case where this process died holding a block
// ===========================================================================

const assert = require('assert');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (/native$/.test(request)) {
        return { hash: async () => Buffer.alloc(32, 0xff), configure: () => {},
                 seedForHeight: () => Buffer.alloc(32) };
    }
    return origLoad(request, parent, isMain);
};

const JobManager = require('../lib/jobManager');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** The shape server.js gives it, in a Map. */
function memStore() {
    const live = new Map();
    const refused = new Map();
    return {
        live,
        refused,
        async put(hash, entry) { live.set(hash, entry); },
        async remove(hash, reason) {
            if (reason && live.has(hash)) refused.set(hash, { ...live.get(hash), reason });
            live.delete(hash);
        },
        async all() { return [...live.values()]; }
    };
}

/** submitBlock outcomes, in the shape daemon.js returns.
 *
 * The verdict is produced by the real classifier rather than written in by
 * hand. These fakes carried hand-made results until 2026-10-10, so when the
 * reading of the node's answer moved into daemon.js the tests went on
 * passing their own idea of it. A fake that disagrees with the thing it
 * stands in for tests nothing.
 */
const { outcomeOf } = require('./outcome');

const NOBODY_ANSWERED = outcomeOf(false, ['connect ECONNREFUSED'],
    [{ ok: false, error: 'connect ECONNREFUSED', result: null }]);
const ACCEPTED = outcomeOf(true, [], [{ ok: true, error: null, result: null }]);
const READ_AND_REFUSED = outcomeOf(false, ['bad-txnmrklroot'],
    [{ ok: true, error: null, result: 'bad-txnmrklroot' }]);
const DUPLICATE = outcomeOf(false, ['duplicate'],
    [{ ok: true, error: null, result: 'duplicate' }]);

function jm(store, outcome) {
    const m = new JobManager({ submitBlock: async () => outcome.shift ? outcome.shift() : outcome },
                             {}, quiet);
    m._spoolStore = store;
    return m;
}

(async () => {
    console.log(`\n${BLD}a solved block is written down before it is offered${OFF}`);

    await test('the drain settles nothing when nothing is spooled', async () => {
        const s = memStore();
        const r = await jm(s, ACCEPTED).drainSpool();
        assert.deepStrictEqual(r, { offered: 0, settled: 0 });
    });

    await test('a node that never answered leaves the block spooled', async () => {
        const s = memStore();
        s.live.set('h1', { height: 10, hash: 'h1', hex: 'deadbeef', worker: 'w', foundAt: Date.now() });
        const r = await jm(s, NOBODY_ANSWERED).drainSpool();
        assert.strictEqual(r.settled, 0, 'it gave up on a block nobody looked at');
        assert.strictEqual(s.live.size, 1, 'the block was dropped while the node was down');
    });

    await test('and it is offered again on the next drain, however long it waits', async () => {
        const s = memStore();
        s.live.set('h1', { height: 10, hash: 'h1', hex: 'deadbeef', worker: 'w',
                           foundAt: Date.now() - 3600 * 1000 });
        const m = jm(s, [NOBODY_ANSWERED, ACCEPTED]);
        await m.drainSpool();
        assert.strictEqual(s.live.size, 1, 'an hour old and already forgotten');
        await m.drainSpool();

        // AND IT IS STILL SPOOLED, WHICH IS THE CHANGE OF 2026-11-07.
        //
        // This used to assert 0 here: the node took it, so the drain removed
        // it. But the emit is fire-and-forget -- the listener queues
        // recordBlock and returns -- so the entry was deleted while the
        // accounting it exists to protect had not run. The spool's whole
        // purpose is to survive "accepted by the node, not yet paid for",
        // and it was being emptied at the start of that window.
        //
        // The entry is released by whoever has seen the payout record exist,
        // and by nobody else.
        assert.strictEqual(s.live.size, 1,
            'the entry was dropped before anything recorded the payout');
        await m.unspoolRecorded('h1');
        assert.strictEqual(s.live.size, 0,
            'and it must go once the record exists, or every drain re-offers it');
    });

    await test('an accepted spooled block is counted and announced for payout', async () => {
        const s = memStore();
        s.live.set('h1', { height: 10, hash: 'h1', hex: 'deadbeef', worker: 'bob', foundAt: Date.now() });
        const m = jm(s, ACCEPTED);
        const seen = [];
        m.on('block', (b) => seen.push(b));
        const r = await m.drainSpool();
        assert.strictEqual(r.settled, 1);
        assert.strictEqual(m.stats.blocksFound, 1, 'a late block was not counted');
        assert.strictEqual(seen.length, 1, 'nobody was ever paid for it');
        assert.strictEqual(seen[0].worker, 'bob', 'it was paid to the wrong miner');
        assert.ok(seen[0].fromSpool, 'the payout cannot tell it arrived late');
    });

    // ---- the two cases dang150296 reproduced against bb6d521 --------------
    //
    // The spool recovered the block and lost the payout, which is the same
    // loss one step later. Both are reproduced here before they are fixed
    // again by accident.

    await test('a recovered block carries everything the payout needs', async () => {
        const s = memStore();
        s.live.set('h1', { height: 10, hash: 'h1', hex: 'deadbeef', worker: 'bob',
                           foundAt: Date.now(),
                           coinbaseValue: 5000000000,
                           distributableValue: 4750000000,
                           devFeeAmount: 250000000 });
        const m = jm(s, ACCEPTED);
        const seen = [];
        m.on('block', (b) => seen.push(b));
        await m.drainSpool();

        // recordBlock throws "blockValue must be a non-negative number of base
        // units, got undefined" without these, and nobody is paid for a block
        // that is on the chain.
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].distributableValue, 4750000000,
            'the recovered block has no distributableValue, so recordBlock will '
            + 'throw and no payout record will exist');
        assert.strictEqual(seen[0].coinbaseValue, 5000000000);
        assert.strictEqual(seen[0].devFeeAmount, 250000000);
    });

    await test('"duplicate" still offers the block for payout', async () => {
        // The crash this spool exists for includes dying between the node
        // accepting a block and the payout being recorded. Coming back, the
        // drain is told "duplicate" -- and settling silently leaves the block
        // on the chain with nobody paid for it.
        const s = memStore();
        s.live.set('h1', { height: 10, hash: 'h1', hex: 'deadbeef', worker: 'bob',
                           foundAt: Date.now(), coinbaseValue: 5000000000,
                           distributableValue: 4750000000, devFeeAmount: 250000000 });
        const m = jm(s, DUPLICATE);
        const seen = [];
        m.on('block', (b) => seen.push(b));
        const r = await m.drainSpool();

        assert.strictEqual(r.settled, 1);
        assert.strictEqual(seen.length, 1,
            'a block already on the node was removed from the spool without ever '
            + 'being offered for payout');
        assert.strictEqual(seen[0].worker, 'bob');
        assert.strictEqual(seen[0].distributableValue, 4750000000);
    });

    await test('a block the node read and refused is settled, not retried forever', async () => {
        const s = memStore();
        s.live.set('h1', { height: 10, hash: 'h1', hex: 'deadbeef', worker: 'w', foundAt: Date.now() });
        const r = await jm(s, READ_AND_REFUSED).drainSpool();
        assert.strictEqual(r.settled, 1);
        assert.strictEqual(s.live.size, 0, 'it will be offered again every minute for ever');
        assert.strictEqual(s.refused.size, 1,
            'the only copy of that work was deleted instead of kept with its reason');
        assert.match(s.refused.get('h1').reason, /bad-txnmrklroot/);
    });

    await test('"duplicate" means it was already accepted, and settles it', async () => {
        const s = memStore();
        s.live.set('h1', { height: 10, hash: 'h1', hex: 'deadbeef', worker: 'w', foundAt: Date.now() });
        const m = jm(s, DUPLICATE);
        const r = await m.drainSpool();
        assert.strictEqual(r.settled, 1);
        // Settled with the NODE, which is not the same as paid for. "Already
        // have it" is precisely the answer the drain gets when this process
        // died between acceptance and accounting, so the entry has to
        // outlive the offer -- see the drain above.
        assert.strictEqual(s.live.size, 1,
            'a block was dropped from the spool before its payout was recorded');
        await m.unspoolRecorded('h1');
        assert.strictEqual(s.live.size, 0, 'a block already on the node stayed in the spool');
        assert.strictEqual(s.refused.size, 0,
            'a block that was already accepted was filed as refused');
    });

    await test('an accepted block stays spooled until something records it', async () => {
        // H-02, end to end at the layer where it happened.
        //
        // _submitBlock used to unspool on acceptance, fire-and-forget, with
        // the comment "it is on the chain; the spool has nothing left to
        // protect". But _record() runs AFTER _submitBlock returns, and if it
        // throws -- one redis blip -- processShare returns UNAVAILABLE before
        // `credited`, before emit('share') and before emit('block'). No
        // 'block' event, so recordBlock never runs, so blocks:pending never
        // gets an entry, so nothing matures and nobody is paid. The
        // resubmission hits JOB_NOT_FOUND because refreshTemplate(true)
        // already cleared the job. And the drain, the one thing that could
        // still have recovered it, found an empty spool.
        //
        // 47.5 WAM on the chain, credited to nobody, with no path back.
        //
        // Reported by 0xkerochan, 2026-11-06.
        const s = memStore();
        const m = jm(s, ACCEPTED);

        const header = Buffer.alloc(80, 0x11);
        const job = {
            height: 42,
            coinbaseValue: 5000000000,
            distributableValue: 4750000000,
            devFeeAmount: 250000000,
            serializeBlock: () => Buffer.from('deadbeef', 'hex')
        };
        const share = { worker: 'w.rig1', height: 42 };

        // _submitBlock writes it down before it asks the node, which is the
        // test two rows below this one.
        await m._submitBlock(job, header, Buffer.alloc(0), share);

        assert.strictEqual(share.blockAccepted, true, 'the node took the block');
        assert.strictEqual(s.live.size, 1,
            'the block is on the chain and the only record that it is unpaid ' +
            'was deleted before anything recorded the payout');

        // _record() now throws. Nothing emits 'block'. The drain is the only
        // thing left, and it has to find something.
        const seen = [];
        m.on('block', (b) => seen.push(b));
        const r = await m.drainSpool();
        assert.strictEqual(r.offered, 1, 'there was nothing left to recover');
        assert.strictEqual(seen.length, 1, 'nobody was ever offered the payout');

        // And only once the record exists does the evidence go.
        await m.unspoolRecorded(share.blockHash);
        assert.strictEqual(s.live.size, 0);
    });

    await test('a pool with no spool configured still runs, and says so once', async () => {
        const m = new JobManager({ submitBlock: async () => ACCEPTED }, {}, quiet);
        const r = await m.drainSpool();
        assert.deepStrictEqual(r, { offered: 0, settled: 0 });
        await m._spool({ hash: 'x' });   // must not throw
        await m._unspool('x');
    });

    await test('spooling happens before the node is asked, in the source', () => {
        // The order is the whole protection and it cannot be observed from
        // outside _submitBlock, so it is read. A spool written after the
        // submit protects nothing: the window it covers is the submit itself.
        const src = require('fs').readFileSync(require.resolve('../lib/jobManager'), 'utf8');
        const body = src.slice(src.indexOf('async _submitBlock'));
        const spoolAt = body.indexOf('this._spool(');
        const submitAt = body.indexOf('this.daemon.submitBlock(');
        assert.ok(spoolAt > -1 && submitAt > -1, 'the subject of this assertion is gone');
        assert.ok(spoolAt < submitAt,
            'the block is offered to the node before it is written down, so the '
            + 'window where it exists only in memory is still open');
    });

    console.log();
    if (!fail.length) {
        console.log(`${GRN}${BLD}${pass} passed${OFF}`);
    } else {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
    }
    process.exit(fail.length ? 1 : 0);
})();
