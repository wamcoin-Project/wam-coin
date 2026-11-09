// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  halving.test.js -- the countdown names the first cheap block, not the last
//                     expensive one
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  wam::GetBlockSubsidy counts halvings as (height - 1) / interval, because
//  block 0 mints the premine and would otherwise sit inside epoch 0 and leave
//  that epoch one block short. So epoch e begins at e * interval + 1, and the
//  LAST block of an epoch still pays the old subsidy.
//
//  getsupplyinfo was missing that + 1 and named the last expensive block as
//  "next_halving_height", with blocks_until_halving reaching zero a block
//  early. Found by dang150296 (Urriki1502) on 9 November 2026 in a second
//  independent review that rebuilt the patched Core and ran native regtest:
//  at regtest height 150 the node still paid 50 WAM while the RPC said the
//  halving was there.
//
//  He then found that fixing the RPC was not enough. The same arithmetic was
//  written out four more times in JavaScript -- the explorer and the pool API
//  each compute it locally when the node cannot be asked -- and all four were
//  missing the same + 1. Those paths run exactly when the node is unreachable,
//  which is when nobody is comparing the number against anything.
//
//  So the rule is one function per package now, and this is the test that it
//  is the right one. A fifth copy of the expression is how this came back.
// ===========================================================================

'use strict';

const assert = require('assert');
const { nextHalvingHeight, SUBSIDY_HALVING_INTERVAL } = require('../lib/constants');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

/** What the node does, written once here so the test does not trust the code
 *  it is testing: src/wam/consensus/subsidy.cpp, (nHeight - 1) / interval. */
function halvingsAt(height, interval) {
    if (height < 1) return 0;
    return Math.floor((height - 1) / interval);
}

console.log(`\n${BLD}  the halving countdown names the first cheap block${OFF}\n`);

test('the first reduced block of every epoch, for several intervals', () => {
    for (const interval of [150, 1000, 200000]) {
        for (let e = 0; e < 5; e++) {
            const inside = e * interval + 1;          // first block of epoch e
            const got = nextHalvingHeight(inside, interval);
            assert.strictEqual(got, (e + 1) * interval + 1,
                `interval ${interval}, standing at ${inside}`);
            // and it really is the first block that pays less
            assert.strictEqual(halvingsAt(got, interval),
                               halvingsAt(got - 1, interval) + 1,
                `interval ${interval}: ${got} is not where the subsidy changes`);
        }
    }
});

test('the last block of an epoch still has its halving ahead of it', () => {
    for (const interval of [150, 200000]) {
        const last = interval;                         // last block of epoch 0
        assert.strictEqual(halvingsAt(last, interval), 0,
            'this block should still pay the full subsidy');
        assert.strictEqual(nextHalvingHeight(last, interval), interval + 1);
        assert.strictEqual(nextHalvingHeight(last, interval) - last, 1,
            'the countdown reached zero while the old subsidy was still paid');
    }
});

test('the regtest case the reviewer measured on a real node', () => {
    assert.strictEqual(nextHalvingHeight(149, 150), 151);
    assert.strictEqual(nextHalvingHeight(150, 150), 151);
    assert.strictEqual(nextHalvingHeight(151, 150), 301);
});

test('and the mainnet one, which is the number people read', () => {
    assert.strictEqual(SUBSIDY_HALVING_INTERVAL, 200000);
    assert.strictEqual(nextHalvingHeight(1), 200001);
    assert.strictEqual(nextHalvingHeight(38089), 200001);
    assert.strictEqual(nextHalvingHeight(200000), 200001);
    assert.strictEqual(nextHalvingHeight(200001), 400001);
});

test('genesis and heights below it do not walk backwards', () => {
    assert.strictEqual(nextHalvingHeight(0, 150), 151);
    assert.strictEqual(nextHalvingHeight(-5, 150), 151);
});

test('the countdown is never zero while the old subsidy is still paid', () => {
    const interval = 150;
    for (let h = 1; h <= 450; h++) {
        const left = nextHalvingHeight(h, interval) - h;
        assert.ok(left >= 1, `height ${h} reported ${left} blocks until halving`);
        if (left === 1) {
            assert.strictEqual(halvingsAt(h + 1, interval), halvingsAt(h, interval) + 1,
                `height ${h} said one block to go and ${h + 1} pays the same`);
        }
    }
});

console.log();
if (fail.length) {
    console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
    fail.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
}
console.log(`${GRN}${BLD}${pass} passed: the countdown ends on the first cheap block${OFF}\n`);
