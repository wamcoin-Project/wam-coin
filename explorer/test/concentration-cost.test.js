'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  concentration-cost.test.js -- what one request costs the node
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  /api/concentration is unauthenticated, and it awaited a fetch pass
//  inline on every request. Three things made that pass unbounded on a
//  PRUNED NODE, which is a configuration this project supports and this
//  very panel displays:
//
//    the per-cycle budget counted SUCCESSES. `fetched++` sat at the bottom
//    of the try and the catch counted nothing, so where every fetch fails
//    the counter stays near zero, the break never fires, and one pass walks
//    all 5,040 heights of the long window at two RPC calls each
//
//    a height that failed was not remembered, so the next request paid for
//    it again, and the one after that
//
//    nothing serialised or spaced the passes, so concurrent requests each
//    started their own
//
//  Measured and reported by Fahrizal, 18 November 2026: 500 calls for a
//  healthy cold request, where the budget binds, against 9,986 per request
//  on a pruned node, and 9,986 again on the repeat.
//
//  The explorer's own README states the invariant all of this broke: ten
//  open tabs cost the node exactly what one does.
//
//  Every case here counts RPC calls against a scripted peer. None of them
//  reads a clock for an assertion -- the refresh interval is the one thing
//  that needs time, and it is moved rather than waited for.
// ===========================================================================

const assert = require('assert');
const { Concentration } = require('../lib/concentration');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const log = { debug() {}, info() {}, warn() {}, error() {} };

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

const TIP = 6000;

/**
 * A node that answers for recent heights and refuses older ones.
 *
 * `pruneBelow` is the horizon: a real pruned node has the last few hundred
 * blocks and nothing before them. Set it above the tip for a node that
 * refuses everything, or below 1 for a healthy one.
 */
function peer(pruneBelow) {
    const rpc = {
        calls: 0,
        async call(method, [arg]) {
            rpc.calls++;
            if (method === 'getblockhash') {
                if (arg < pruneBelow) throw new Error('Block not available (pruned data)');
                return `hash-${arg}`;
            }
            const h = Number(String(arg).replace('hash-', ''));
            if (h < pruneBelow) throw new Error('Block not available (pruned data)');
            return {
                time: 1760000000 + h * 120,
                tx: [{ vout: [{ value: 47.5, scriptPubKey: { address: `Wfinder${h % 3}` } }] }]
            };
        }
    };
    return rpc;
}

(async () => {
    console.log(`\n${BLD}  what one request costs the node${OFF}\n`);

    // A REAL PRUNED NODE HAS THE RECENT BLOCKS AND NOT THE OLD ONES.
    //
    // The first version of these two cases used a peer that refused EVERY
    // height, and they passed against the unfixed module -- because with
    // the recent window unreadable, _complete() is false, the depth stays
    // at WINDOW (50) and the long backfill is never entered at all. The
    // reported 9,986 calls are two per height across the 5,040-height long
    // window, and reaching that window REQUIRES the recent fifty to be
    // readable. The fixture has to be a pruned node, not a dead one.
    const HORIZON = TIP - 288;      // what a default -prune=550 keeps

    /** Fill the recent window, as any live explorer does in its first minute. */
    async function warmRecent(c, rpc) {
        for (let i = 0; i < 8; i++) await c.update(rpc, TIP);
        assert.ok(c._complete(TIP, 50),
            'the fixture never completed the recent window, so the long '
            + 'backfill -- which is where the cost is -- is not being tested');
    }

    await test('a pruned node does not turn one request into thousands of calls',
               async () => {
        const c = new Concentration(log);
        const rpc = peer(HORIZON);
        await warmRecent(c, rpc);

        rpc.calls = 0;
        await c.update(rpc, TIP);           // the first long-window pass

        // The backfill budget is 250 heights, two calls each.
        assert.ok(rpc.calls <= 500,
            `one pass made ${rpc.calls} RPC calls. The per-cycle budget counted `
            + 'SUCCESSES -- `fetched++` at the bottom of the try, and the catch '
            + 'counting nothing -- so below the prune horizon, where every '
            + 'fetch fails, it never binds and the pass walks all 5,040 heights '
            + 'of the long window. That is an unauthenticated GET pinning an '
            + 'RPC worker, on a page the dashboard refreshes every six seconds '
            + 'per open tab.');
    });

    await test('and no height below the horizon is asked about twice', async () => {
        const asked = new Map();
        const c = new Concentration(log);
        const rpc = peer(HORIZON);
        const realCall = rpc.call;
        rpc.call = async (method, args) => {
            if (method === 'getblockhash') {
                asked.set(args[0], (asked.get(args[0]) || 0) + 1);
            }
            return realCall(method, args);
        };

        await warmRecent(c, rpc);
        for (let i = 0; i < 5; i++) await c.update(rpc, TIP);

        const twice = [...asked].filter(([h, n]) => h < HORIZON && n > 1);
        assert.deepStrictEqual(twice, [],
            `${twice.length} pruned height(s) were fetched more than once. `
            + 'Nothing remembered which heights could not be read, so every '
            + 'pass re-paid for the same failures and never moved past them. '
            + 'On a pruned node that condition is permanent, not a cold-start '
            + 'transient.');
    });

    await test('and once the window is exhausted a pass costs only the tip re-read',
               async () => {
        const c = new Concentration(log);
        const rpc = peer(HORIZON);
        await warmRecent(c, rpc);
        // 5,040 heights at 250 a pass. Bounded, and far fewer in practice
        // because the readable ones are cached as answers.
        for (let i = 0; i < 25; i++) await c.update(rpc, TIP);
        rpc.calls = 0;
        await c.update(rpc, TIP);
        // SIX, NOT ZERO, AND THE SIX ARE DELIBERATE.
        //
        // update() drops the three heights nearest the tip on every pass
        // and reads them again, because a block that shallow can still be
        // reorganised away and the panel would otherwise publish a finder
        // for a block that no longer exists. Three heights, two calls each.
        assert.ok(rpc.calls <= 6,
            `a pass over a fully-known window cost ${rpc.calls} calls. Only `
            + 'the three heights nearest the tip should be re-read; anything '
            + 'more means the panel keeps charging the node for answers it '
            + 'already holds');
    });

    await test('a healthy node is still read, and still fills in', async () => {
        // The control. The budget must bind the same way it always did, and
        // the panel must still arrive at an answer.
        const c = new Concentration(log);
        const rpc = peer(0);
        await c.update(rpc, TIP);
        assert.ok(c.finders.size > 0, 'nothing was read at all');
        assert.ok(c.finders.size <= 12,
            `${c.finders.size} heights in one cold cycle: the budget that keeps `
            + 'a page load from hanging is not binding');
        const firstPass = c.finders.size;
        for (let i = 0; i < 6; i++) await c.update(rpc, TIP);
        assert.ok(c.finders.size > firstPass,
            'repeated passes do not fill the window in, so the panel never '
            + 'reaches an answer');
    });

    await test('a height that failed is read again once the node is reindexed',
               async () => {
        const c = new Concentration(log);
        const pruned = peer(TIP + 1);
        await c.update(pruned, TIP);
        assert.strictEqual(c.finders.size, 0, 'the fixture read something');

        // The operator reindexes. The negative cache must not be permanent:
        // move the recorded failures past their hour.
        for (const h of c.unreadable.keys()) {
            c.unreadable.set(h, Date.now() - (2 * 60 * 60 * 1000));
        }
        await c.update(peer(0), TIP);
        assert.ok(c.finders.size > 0,
            'the heights stayed unreadable for ever, so an operator who fixed '
            + 'their node would see an empty panel until the explorer was '
            + 'restarted');
    });

    await test('ten requests at once are one pass, not ten', async () => {
        const c = new Concentration(log);
        const rpc = peer(0);
        await Promise.all(Array.from({ length: 10 }, () => c.refresh(rpc, TIP)));
        assert.ok(rpc.calls <= 24,
            `${rpc.calls} RPC calls for ten simultaneous requests. Each one `
            + 'started its own fetch pass, which is the amplification the '
            + "README's own invariant forbids: ten open tabs cost the node "
            + 'exactly what one does.');
    });

    await test('and a second request moments later asks the node nothing',
               async () => {
        const c = new Concentration(log);
        const rpc = peer(0);
        await c.refresh(rpc, TIP);
        const afterFirst = rpc.calls;
        assert.ok(afterFirst > 0, 'the first refresh did nothing');
        await c.refresh(rpc, TIP);
        assert.strictEqual(rpc.calls, afterFirst,
            'a request six seconds after another started a second pass. That '
            + "is the dashboard's own refresh interval, so this is what one "
            + 'open tab does on its own.');
    });

    await test('while a refresh after the interval still works', async () => {
        const c = new Concentration(log);
        const rpc = peer(0);
        await c.refresh(rpc, TIP);
        const afterFirst = rpc.calls;
        c._lastPass -= 60 * 1000;           // a minute passes
        await c.refresh(rpc, TIP);
        assert.ok(rpc.calls > afterFirst,
            'the panel stopped updating altogether, which is a worse answer '
            + 'than a slow one');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: a request costs what it should${OFF}\n`);
})();
