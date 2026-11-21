// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  network-total.test.js -- the whole is never smaller than its part
// ===========================================================================
//
//      node pool/test/network-total.test.js
//
//  WHY THIS EXISTS
//
//  On 2026-11-21 the dashboard read:
//
//      POOL HASHRATE     273.6 kH/s
//      NETWORK HASHRATE  258.9 kH/s
//
//  for the second time. The first time, on 2026-10-29, the SHARE was the
//  division that crossed 100% and it was replaced by a count off the ledger.
//  The total was left alone, with a comment saying the total never had to
//  stop being a division. This is that comment being wrong.
//
//  Neither number was wrong on its own. The pool's is ten minutes of
//  submitted shares; the node's is the arrival rate of the last 120 blocks,
//  which is about four hours. The chain was accelerating -- 66 s a block over
//  the last twelve against 126.8 s over the last hundred and twenty -- so a
//  ten-minute measurement of a part legitimately exceeded a four-hour average
//  of the whole, and the page showed something that cannot be true.
//
//  The network hashrate is this pool plus every other pool plus everyone
//  mining alone. It contains us. Whatever window either number is taken over,
//  it cannot come out below us, and that is what is asserted here.
// ===========================================================================

const assert = require('assert');
const ApiServer = require('../lib/api');
const { ADDRESS_VERSIONS } = require('../lib/constants');

let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

/**
 * An ApiServer whose four collaborators answer with exactly the numbers a
 * case wants, so the arithmetic under test is the only thing that can fail.
 *
 * blocksFound are heights this pool found; tip and maturity decide the window
 * the counted share is taken over, the same way the live path does.
 */
function makeApi({ poolHashrate, estimate, blocksFound, tip = 1000, maturity = 100 }) {
    const api = new ApiServer({
        config: { netVersions: ADDRESS_VERSIONS.testnet, coinbaseMaturity: maturity },
        logger: quiet,
        jobManager: { getStatus: () => ({ currentJob: null }) },
        stratumServer: { getConnectedMiners: () => [] },
        shareProcessor: {
            getPoolStats: async () => ({
                blocksFound: blocksFound.length,
                // The counted share is taken from here, which is what
                // blocks:pending holds: every block this pool found that has
                // not yet matured, so exactly the pool's blocks inside the
                // last `maturity` blocks of chain.
                pendingBlocks: blocksFound.map((h) => ({ height: h }))
            }),
            getHashrateStats: async () => ({ poolHashrate, workers: {} })
        },
        daemon: {}
    });
    api._network = async () => ({
        blocks: tip,
        networkHashPerSecond: estimate,
        networkHashWindowBlocks: 120
    });
    return api;
}

(async () => {
    console.log('\n\x1b[1m  the whole is never smaller than its part\x1b[0m\n');

    // The measured case, from the live reading that produced this file.
    // 273.6 kH/s of pool, 51 of the last 100 blocks, and a node estimate
    // lagging four hours behind at 258.9 kH/s.
    // 51 heights, all inside the hundred-block window [901, 1000], so the
    // counted share is exactly 51/100 and the arithmetic below is checkable
    // by hand.
    const heights = [];
    for (let i = 0; i < 51; i++) heights.push(1000 - i);

    await test('the reported case: the total is not below the pool', async () => {
        const api = makeApi({ poolHashrate: 273600, estimate: 258900, blocksFound: heights });
        const s = await api._stats();
        assert.ok(s.network.networkHashPerSecond >= s.pool.hashrate,
            `network ${Math.round(s.network.networkHashPerSecond)} < pool ${Math.round(s.pool.hashrate)}`);
    });

    await test('and it is built from the counted share, not the lagging estimate', async () => {
        const api = makeApi({ poolHashrate: 273600, estimate: 258900, blocksFound: heights });
        const s = await api._stats();
        assert.strictEqual(s.network.networkHashBasis, 'counted-share');
        // 273600 / 0.51 = 536,470
        assert.ok(Math.abs(s.network.networkHashPerSecond - 536470) < 100,
            `expected ~536470, got ${Math.round(s.network.networkHashPerSecond)}`);
    });

    await test('the node estimate is still published, under its own name', async () => {
        const api = makeApi({ poolHashrate: 273600, estimate: 258900, blocksFound: heights });
        const s = await api._stats();
        assert.strictEqual(s.network.networkHashEstimate, 258900);
        assert.strictEqual(s.network.networkHashEstimateWindowBlocks, 120);
    });

    await test('others is never negative, and is the remainder', async () => {
        const api = makeApi({ poolHashrate: 273600, estimate: 258900, blocksFound: heights });
        const s = await api._stats();
        assert.ok(s.network.othersHashPerSecond >= 0);
        assert.ok(Math.abs(
            s.network.othersHashPerSecond
            - (s.network.networkHashPerSecond - s.pool.hashrate)) < 1e-6);
    });

    // Below the floor the count is too thin to divide by, so the estimate is
    // used -- and must still not come out below the pool.
    await test('too few blocks to count: the estimate is used, floored at the pool', async () => {
        const api = makeApi({ poolHashrate: 273600, estimate: 258900, blocksFound: [1000, 998, 996] });
        const s = await api._stats();
        assert.strictEqual(s.network.networkHashBasis, 'node-estimate');
        assert.ok(s.network.networkHashPerSecond >= s.pool.hashrate,
            `network ${Math.round(s.network.networkHashPerSecond)} < pool ${Math.round(s.pool.hashrate)}`);
    });

    await test('a pool finding every block is the whole network, not more', async () => {
        const all = [];
        for (let i = 0; i < 100; i++) all.push(1000 - i);
        const api = makeApi({ poolHashrate: 400000, estimate: 10, blocksFound: all });
        const s = await api._stats();
        assert.ok(Math.abs(s.network.networkHashPerSecond - 400000) < 1,
            `expected 400000, got ${s.network.networkHashPerSecond}`);
        assert.ok(Math.abs(s.network.othersHashPerSecond) < 1e-6);
    });

    await test('an idle pool does not invent a network', async () => {
        const api = makeApi({ poolHashrate: 0, estimate: 0, blocksFound: [] });
        const s = await api._stats();
        assert.strictEqual(s.network.networkHashPerSecond, 0);
        assert.strictEqual(s.network.othersHashPerSecond, 0);
    });

    console.log();
    if (fail.length) {
        console.log(`\x1b[31m\x1b[1m  ${fail.length} failed\x1b[0m`);
        for (const f of fail) console.log(`        ${f}`);
        process.exit(1);
    }
    console.log(`\x1b[32m\x1b[1m  ${pass} passed: the part can no longer exceed the whole\x1b[0m\n`);
})();
