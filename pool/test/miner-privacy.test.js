'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  miner-privacy.test.js -- the pool does not write down who lives where
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  A pool sees two things about every miner that nobody else sees: the
//  address they are paid at, and the address they connect from. Separately
//  each is ordinary. Together, written down and kept, they are a list of
//  which person at which house holds how much WAM -- and a pool's log file
//  gets rotated for months, shipped to whoever is helping debug something,
//  and pasted into support threads.
//
//  Two places wrote the pair, and both wrote it as a matter of course rather
//  than for any reason:
//
//    stratumServer.js  label() returned `<address>.<rig>@<ip>` and seven log
//                      lines used it, one at INFO on every authorize. The
//                      pool itself needs the IP live, in memory -- the rate
//                      limiter, the per-IP connection cap, the ban list --
//                      and not one of those reads it back from a file.
//
//    shareProcessor.js a block whose reward computation failed was parked in
//                      redis as `{ ...share }`, and a share carries
//                      ipAddress. So the finder's IP sat beside their payout
//                      address in a hash nothing prunes.
//
//  Reported 13 November 2026 against v0.1.14.
//
//  The fix is to separate the two facts: the log names a connection by its
//  own id, and the id is tied to an IP once, at debug, for the operator who
//  needs to trace one. The exception is a ban, where the operator cannot act
//  on what they cannot locate, and that line says so.
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const Logger = require('../lib/logger');
const StratumServer = require('../lib/stratumServer');
const ShareProcessor = require('../lib/shareProcessor');
const { ADDRESS_VERSIONS } = require('../lib/constants');
const { attachAtomic, attachUnsupported,
        CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME,
        CREDIT_MATURED_NAME, CREDIT_SHARE_NAME,
        COMMIT_PAYMENT_NAME } = require('./fakeAtomic');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-miner-privacy-'));
let seq = 0;
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }));

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

function makeLogger(level) {
    const file = path.join(DIR, `pool${++seq}.log`);
    const log = new Logger({ level, file, color: false });
    return {
        log,
        async lines() {
            await new Promise((r) => setTimeout(r, 60));
            const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            return text.split('\n').filter((l) => l !== '');
        }
    };
}

function makeStratum(log) {
    const jobManager = new EventEmitter();
    jobManager.currentJob = null;
    jobManager._en = 0;
    jobManager.nextExtranonce1 = function nextExtranonce1() {
        const buf = Buffer.allocUnsafe(4);
        buf.writeUInt32BE((++this._en) >>> 0, 0);
        return buf;
    };
    const stratum = new StratumServer(jobManager, {
        network: 'mainnet',
        netVersions: ADDRESS_VERSIONS.mainnet,
        bindAddress: '127.0.0.1',
        ports: [{ port: 0, difficulty: 1000 }],
        startDifficulty: 1000
    }, log);
    stratum.listen();
    return stratum;
}

function authorize(stratum, address, rig) {
    return new Promise((resolve, reject) => {
        const port = stratum.servers[0].address().port;
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(JSON.stringify({
                id: 1, method: 'mining.authorize', params: [`${address}.${rig}`, 'x']
            }) + '\n');
            setTimeout(() => { sock.destroy(); resolve(); }, 150);
        });
        sock.on('error', reject);
    });
}

// The treasury address: public, already a fixture in this directory, and a
// valid mainnet address so authorize succeeds.
const ADDR = 'WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE';
const IP = '127.0.0.1';

/** Enough redis for the failed-reward path. */
function fakeRedis() {
    const hashes = {}, lists = {}, sets = {}, strings = {};
    const own = (k) => { if (!sets[k]) sets[k] = new Set(); return sets[k]; };
    const r = {
        _hashes: hashes, _lists: lists,
        async hgetall(k) { return { ...(hashes[k] || {}) }; },
        async hset(k, f, v) { (hashes[k] = hashes[k] || {})[f] = v; return 1; },
        async hdel(k, f) { if (hashes[k]) delete hashes[k][f]; return 1; },
        async hexists(k, f) {
            return hashes[k] && Object.prototype.hasOwnProperty.call(hashes[k], f)
                ? 1 : 0;
        },
        async hget(k, f) { return (hashes[k] || {})[f] ?? null; },
        async srem(k, v) { own(k).delete(v); return 1; },
        async zrangebyscore() { return []; },
        async hincrbyfloat(k, f, n) {
            (hashes[k] = hashes[k] || {});
            hashes[k][f] = String(Number(hashes[k][f] || 0) + Number(n));
            return hashes[k][f];
        },
        async get(k) { return strings[k] ?? null; },
        async del(k) { delete strings[k]; return 1; },
        async sismember(k, v) { return own(k).has(v) ? 1 : 0; },
        async scard(k) { return own(k).size; },
        async lrange(k, a, b) {
            const l = lists[k] || [];
            return l.slice(a, b < 0 ? l.length + b + 1 : b + 1);
        },
        async lrem() { return 1; },
        async zadd() { return 1; },
        async zremrangebyscore() { return 1; },
        async zcard() { return 0; }
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
    attachUnsupported(r, 'it models the failed-reward path only',
                      [CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME,
                       CREDIT_MATURED_NAME, CREDIT_SHARE_NAME,
                       COMMIT_PAYMENT_NAME]);
    return r;
}

(async () => {
    console.log(`\n${BLD}  the pool does not write down who lives where${OFF}\n`);

    await test('an authorize does not pair the IP with the payout address', async () => {
        const L = makeLogger('info');
        const stratum = makeStratum(L.log.scope('stratum'));
        await new Promise((r) => setTimeout(r, 80));
        await authorize(stratum, ADDR, 'rig1');
        stratum.close();

        const lines = await L.lines();
        assert.ok(lines.some((l) => l.includes(ADDR)),
            'nothing was logged at all, so nothing was asserted');
        const paired = lines.filter((l) => l.includes(ADDR) && l.includes(IP));
        assert.deepStrictEqual(paired, [],
            'the log pairs a payout address with the IP it connected from, '
            + 'on every authorize, in a file kept for months');
    });

    await test('and the IP is still there for an operator who turns on debug', async () => {
        // Separated, not removed. A pool operator tracing one connection has
        // to be able to; what changed is that it is not written for everybody.
        const L = makeLogger('debug');
        const stratum = makeStratum(L.log.scope('stratum'));
        await new Promise((r) => setTimeout(r, 80));
        await authorize(stratum, ADDR, 'rig1');
        stratum.close();

        const lines = await L.lines();
        assert.ok(lines.some((l) => l.includes(IP)),
            'the IP is now nowhere at all, so an operator cannot trace an '
            + 'abusive connection even deliberately');
    });

    await test('a parked block keeps no IP address', async () => {
        const redis = fakeRedis();
        const sp = new ShareProcessor(redis, { async cmd() { return null; } }, {
            redisPrefix: 'wam', rewardMode: 'pplns'
        }, quiet);

        // Make the reward computation refuse, which is the path that parks
        // the record. Its own strongest guard does it: a distributable value
        // that is not coinbaseValue - devFeeAmount, which is the misuse that
        // would hand the consensus treasury output to miners.

        await sp.recordBlock({
            height: 40690,
            blockHash: 'ab'.repeat(32),
            worker: `${ADDR}.rig1`,
            ipAddress: '203.0.113.42',
            difficulty: 1000,
            powHash: 'cd'.repeat(32),
            coinbaseValue: 5000000000,
            devFeeAmount: 250000000,
            distributableValue: 5000000000,       // refused: see above
            time: Date.now()
        });

        const parked = redis._hashes['wam:blocks:failed'] || {};
        const bodies = Object.values(parked);
        assert.strictEqual(bodies.length, 1,
            'the block was not parked, so nothing was asserted');
        assert.ok(!bodies[0].includes('203.0.113.42'),
            'the parked record holds the finder\'s IP next to their payout '
            + 'address, in a redis hash nothing prunes');
        assert.ok(bodies[0].includes(ADDR),
            'the record lost the worker too -- an operator cannot act on it');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: the two facts stay apart${OFF}\n`);
})();
