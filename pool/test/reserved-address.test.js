'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  reserved-address.test.js -- nobody mines into an address they cannot spend
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Somebody authorized on this pool with the project's own TREASURY address
//  as their payout address, and mined into it. Measured on 19 November 2026
//  from the pool's own records and from the chain, agreeing to the satoshi:
//  372 payout batches, 666.49347736 WAM, every one of them paid by this pool
//  to an address whose key this project holds and the miner does not.
//
//  It was found from the other end. scripts/check_treasury_ledger.py said
//  the chain held 666.49347736 more than the ledger accounted for, which
//  read as a spend recorded twice. Every one of the ledger's 36 rows then
//  checked out exactly against the chain, and the gap turned out to be
//  income: wam-main:paid held 66649347736 satoshi for the treasury address.
//
//  Two readings, and the chain separates them for nobody. A deliberate gift,
//  or somebody who copied the address off wamcoin.org/security -- where it
//  is printed beside the command for checking its balance -- and took it for
//  the pool's own address. On the second reading they worked for weeks, were
//  paid nothing, and nothing anywhere told them so.
//
//  A pool cannot know whose an address is. It knows this one.
// ===========================================================================

const assert = require('assert');
const StratumServer = require('../lib/stratumServer');
const { ADDRESS_VERSIONS } = require('../lib/constants');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function test(name, fn) {
    try { fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

const TREASURY = 'WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE';
const MINER = 'WfBfRmxKzdgXXMUQBBwSuXM61pPhExYdVr';

// The constructor takes (jobManager, config, log) -- positional, as every
// other suite in this directory builds it. Written with one options object
// it throws on varDiff before reaching anything this file is about.
function server(reserved) {
    return new StratumServer({ on() {} }, {
        network: 'mainnet',
        netVersions: ADDRESS_VERSIONS.mainnet,
        bindAddress: '127.0.0.1',
        ports: [{ port: 0, difficulty: 1000 }],
        startDifficulty: 1000,
        reservedAddresses: reserved
    }, quiet);
}

(async () => {
    console.log(`\n${BLD}  nobody mines into an address they cannot spend${OFF}\n`);

    test('the treasury address is refused as a payout address', () => {
        const s = server([TREASURY]);
        const r = s.validateMinerAddress(TREASURY);
        assert.strictEqual(r.ok, false,
            'the pool accepted its own treasury address as somewhere to pay a '
            + 'miner. Every share that miner submits is work they will never '
            + 'be paid for, and the pool is the only thing in the world that '
            + 'could have told them.');
    });

    test('and the refusal says what to do instead', () => {
        const s = server([TREASURY]);
        const r = s.validateMinerAddress(TREASURY);
        assert.ok(/treasury/i.test(r.reason || ''),
            'the message does not say what the address is, so a miner reads '
            + 'it as the pool being broken and tries again');
        assert.ok(/your own wallet/i.test(r.reason || ''),
            'it does not say what to use instead');
        assert.ok(/directly/i.test(r.reason || ''),
            'somebody who meant to give to the project is told only "no", so '
            + 'they will either stop or go back to mining into it');
    });

    test('an ordinary miner address is untouched', () => {
        const s = server([TREASURY]);
        assert.strictEqual(s.validateMinerAddress(MINER).ok, true,
            'a guard that refuses real miners is worse than the fault it '
            + 'guards against');
    });

    test('and junk is still refused for its own reason', () => {
        const s = server([TREASURY]);
        const r = s.validateMinerAddress('notanaddress');
        assert.strictEqual(r.ok, false);
        assert.ok(!/treasury/i.test(r.reason || ''),
            'every bad address is now blamed on the treasury, which tells a '
            + 'miner with a typo the wrong thing entirely');
    });

    test('a pool with no reserved list still runs', () => {
        // An operator running this software for their own pool has no reason
        // to carry our addresses, and must not be broken by their absence.
        const s = server(undefined);
        assert.strictEqual(s.validateMinerAddress(MINER).ok, true);
        assert.strictEqual(s.validateMinerAddress(TREASURY).ok, true,
            'the list is empty, so nothing should be reserved');
    });

    test('the shipped mainnet config reserves the treasury address', () => {
        // The guard is worth nothing if the list is empty where it runs.
        const cfg = require('../config.mainnet.json');
        assert.ok(Array.isArray(cfg.reservedAddresses),
            'pool/config.mainnet.json has no reservedAddresses, so the live '
            + 'pool would go on accepting it');
        assert.ok(cfg.reservedAddresses.includes(TREASURY),
            'the treasury address is not in the list the live pool reads');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: a miner is paid where they can spend it${OFF}\n`);
})();
