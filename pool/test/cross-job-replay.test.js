'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  One unit of electricity is credited once, whatever job carried it
// ===========================================================================
//
//      node pool/test/cross-job-replay.test.js
//
//  WHAT WAS WRONG
//
//  The pool rebuilds its job every jobRebroadcastTimeout seconds (55 on
//  mainnet) even when the tip has not moved, so that newly arrived
//  transactions reach miners, and keeps maxJobHistory (4) of them
//  submittable. Every job at one height is built from the same
//  previousblockhash and the same mempool -- and on this chain the mempool is
//  almost always empty, so the coinbase, the merkle root and the whole header
//  come out byte-identical.
//
//  One RandomX solution was therefore valid under every live job, and the
//  duplicate-share Set was per job, so the same solution was claimed and
//  credited again under each sibling: up to three credits on mainnet for one
//  unit of electricity. PPLNS pays a miner his weight against everyone
//  else's, so the excess came out of the other miners in the round. One
//  stratum connection and a valid payout address was the whole requirement.
//
//  Reported by Alboy on 2026-10-11 as WAM-F5, reproduced end to end over the
//  stratum socket, and confirmed here against a real mainnet template the
//  same hour.
//
//  WHY IT SURVIVED
//
//  share-claim.test.js builds ONE job -- claimSet() is a bare object with a
//  single Set. It proved the guard refuses a repeat inside a job and never
//  asked what happens across two. The test was written when the hex-case
//  duplicate was fixed, and making the key canonical is precisely what let
//  this one through: the same canonical key now claimed cleanly against every
//  sibling's Set.
//
//  WHAT IS TESTED HERE
//
//  Both gates, against the real modules and a real mainnet template:
//
//    1. the claim is scoped to the work  -- two jobs at one height share one
//       Set, and the previousblockhash is part of the key
//    2. the credit refuses a proof of work it has already paid for, whatever
//       job carried it -- the second gate, which does not care how the first
//       one was got around
//
//  and the fact underneath both: two jobs at one height produce an identical
//  header, so a solution really is interchangeable between them.
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BlockTemplate = require('../lib/blockTemplate');
const ShareProcessor = require('../lib/shareProcessor');
const { attachAtomic, attachUnsupported } = require('./fakeAtomic');
const { attachMulti } = require('./fakeMulti');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

// A real getblocktemplate taken from the mainnet node, with the mempool
// emptied -- which is what every job on this chain has looked like so far.
const RPC = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'blocktemplate.mainnet.json'), 'utf8'));

const OPTS = {
    poolAddress: 'wam1qrulaxxlqf65madsmhqrevf467r6qmgdrxhf9yw',
    netVersions: { bech32: 'wam', pubKeyHash: 0x49, scriptHash: 0x05 },
    coinbaseSignature: '/WAM/',
    extranonce1Size: 4
};

const E1 = 'aabbccdd', E2 = '00000001', NTIME = '68e9c1a0', NONCE = 'deadbeef';

function job(extra) {
    return new BlockTemplate(JSON.parse(JSON.stringify(RPC)),
                             Object.assign({}, OPTS, extra));
}

/** Enough redis for the second gate: SADD with its real return value. */
function fakeRedis() {
    const sets = new Map(), hashes = new Map(), lists = new Map();
    const api = {
        async sadd(k, v) {
            if (!sets.has(k)) sets.set(k, new Set());
            const before = sets.get(k).size;
            sets.get(k).add(v);
            return sets.get(k).size > before ? 1 : 0;
        },
        // The claim is given back when the accounting that should have
        // followed it did not happen, so a resubmission of the same share
        // can actually be credited instead of being refused as a duplicate.
        async srem(k, v) {
            if (!sets.has(k)) return 0;
            return sets.get(k).delete(v) ? 1 : 0;
        },
        // recordShare's accounting is a MULTI now, and attachMulti runs the
        // queued commands through these, so they have to exist at the top
        // level rather than only inside the pipeline below.
        async hincrbyfloat(k, f, v) {
            if (!hashes.has(k)) hashes.set(k, new Map());
            const cur = (hashes.get(k).get(f) || 0) + Number(v);
            hashes.get(k).set(f, cur);
            return cur;
        },
        async lpush(k, v) {
            if (!lists.has(k)) lists.set(k, []);
            lists.get(k).unshift(v);
            return lists.get(k).length;
        },
        async ltrim() { return 'OK'; },
        async zadd() { return 1; },
        async del(k) { sets.delete(k); hashes.delete(k); lists.delete(k); return 1; },
        pipeline() {
            const q = [];
            const p = {};
            for (const n of ['hincrbyfloat', 'lpush', 'ltrim', 'zadd', 'del',
                             'hset', 'incrby', 'sadd', 'hdel', 'lrem', 'decrby',
                             'incr', 'hincrby']) {
                p[n] = (...a) => { q.push([n, a]); return p; };
            }
            p.exec = async () => {
                for (const [n, a] of q) {
                    if (n === 'hincrbyfloat') {
                        const [k, f, v] = a;
                        if (!hashes.has(k)) hashes.set(k, new Map());
                        hashes.get(k).set(f, (hashes.get(k).get(f) || 0) + Number(v));
                    } else if (api[n]) {
                        await api[n](...a);
                    }
                }
                return [];
            };
            return p;
        },
        _credit(worker) {
            const h = hashes.get('wam:round');
            return h ? (h.get(worker) || 0) : 0;
        },
        _powCount() {
            const s = sets.get('wam:round:pow');
            return s ? s.size : 0;
        }
    };
    attachUnsupported(api, 'it models the share-claim sets and nothing of ' +
                           'block accounting');
    attachMulti(api);
    return api;
}

function processor(redis) {
    return new ShareProcessor(
        redis,
        { async getBlock() { return { confirmations: 1, height: 1, tx: ['a'] }; } },
        { redisPrefix: 'wam', coinbaseMaturity: 100 },
        { info() {}, warn() {}, error() {}, debug() {} });
}

(async () => {
    console.log(`\n${BLD}one unit of electricity, one credit${OFF}\n`);

    await test('two jobs at one height produce an identical header', () => {
        // If this ever stops being true the attack stops working, but it is
        // true today and the fix must not depend on it staying that way.
        const a = job(), b = job();
        assert.notStrictEqual(a.jobId, b.jobId, 'the two jobs are the same object');
        assert.strictEqual(a.height, b.height);
        const e1 = Buffer.from(E1, 'hex'), e2 = Buffer.from(E2, 'hex');
        const cbA = a.serializeCoinbase(e1, e2), cbB = b.serializeCoinbase(e1, e2);
        assert.ok(cbA.equals(cbB), 'the coinbases differ, so this test proves nothing');
        const hA = a.serializeHeader(a.computeMerkleRoot(cbA), NTIME, NONCE);
        const hB = b.serializeHeader(b.computeMerkleRoot(cbB), NTIME, NONCE);
        assert.ok(hA.equals(hB),
            'the headers differ; a solution would not carry between jobs');
    });

    await test('the first gate: a sibling job cannot re-claim the same work', () => {
        // The jobs share the Set the way refreshTemplate hands it over when
        // the tip has not moved.
        const a = job();
        const b = job({ submits: a.submits });
        assert.strictEqual(a.registerSubmit(E1, E2, NTIME, NONCE), true);
        assert.strictEqual(a.registerSubmit(E1, E2, NTIME, NONCE), false,
            'the within-job guard stopped working');
        assert.strictEqual(b.registerSubmit(E1, E2, NTIME, NONCE), false,
            'the same solution was claimed again under a sibling job at the '
            + 'same height -- this is WAM-F5, and it pays one miner out of '
            + 'the others in the round');
    });

    await test('a new tip starts a new claim set, so honest shares are not refused', () => {
        // The other direction, and the one that would be a worse bug: if the
        // Set were carried across heights, every miner who reused a nonce
        // would be refused for ever.
        const a = job();
        a.registerSubmit(E1, E2, NTIME, NONCE);
        const next = job();               // no shared Set: a new tip
        assert.strictEqual(next.registerSubmit(E1, E2, NTIME, NONCE), true,
            'a fresh height refused a share because of a claim from the '
            + 'previous one');
    });

    await test('the previousblockhash is part of the key', () => {
        const a = job();
        const other = JSON.parse(JSON.stringify(RPC));
        other.previousblockhash = 'ff'.repeat(32);
        const b = new BlockTemplate(other,
            Object.assign({}, OPTS, { submits: a.submits }));
        assert.strictEqual(a.registerSubmit(E1, E2, NTIME, NONCE), true);
        assert.strictEqual(b.registerSubmit(E1, E2, NTIME, NONCE), true,
            'two different heights collided on one key, which would refuse '
            + 'an honest share');
    });

    await test('the second gate: a proof of work is credited once per round', async () => {
        // This one does not care how the first gate was got around. The hash
        // is the work; the work was paid for.
        const redis = fakeRedis();
        const sp = processor(redis);
        const share = { worker: 'w.1', difficulty: 0.000002, jobId: '1',
                        powHash: 'ab'.repeat(32) };
        await sp.recordShare(share);

        // AND THE REFUSAL IS AN ERROR THE CALLER CAN SEE.
        //
        // These two used to resolve. A bare `return` from the duplicate
        // branch looks exactly like a success to processShare, which then
        // set credited = true and answered the miner `valid: true` for work
        // that went into neither the round nor the PPLNS window -- no error
        // code, nothing in his logs. Tagged rather than generic, because
        // "already counted, do not resend" and "write failed, please
        // resend" need opposite answers and jobManager picks between them
        // on this flag. Reported by bobbyning, 2026-11-07.
        for (const jobId of ['2', '3']) {
            await assert.rejects(
                () => sp.recordShare(Object.assign({}, share, { jobId })),
                (err) => err.duplicateShare === true,
                `a replay under jobId ${jobId} resolved instead of being refused`);
        }

        assert.strictEqual(redis._credit('w.1'), 0.000002,
            `the same proof of work was credited ${redis._credit('w.1') / 0.000002} `
            + 'times; PPLNS takes the excess from every other miner in the round');
        assert.strictEqual(redis._powCount(), 1);
    });

    await test('a failed accounting gives the claim back, so the resubmission lands', async () => {
        // The other half of the same fault. The SADD is written first on
        // purpose -- a redis that cannot answer must not be a free pass --
        // but nothing used to undo it. If the accounting then failed, the
        // proof of work stayed claimed for the rest of the round with
        // nothing credited against it, and the resubmission the miner was
        // invited to send came back "already credited" and was swallowed.
        const redis = fakeRedis();
        const sp = processor(redis);
        const share = { worker: 'w.1', difficulty: 0.000002, jobId: '1',
                        powHash: 'ef'.repeat(32) };

        redis._multiFails = true;
        await assert.rejects(() => sp.recordShare(share),
            'a share whose accounting failed must be refused, not resolved');
        redis._multiFails = undefined;

        assert.strictEqual(redis._powCount(), 0,
            'the claim must be given back when nothing was credited for it');
        assert.strictEqual(redis._credit('w.1'), 0,
            'and nothing may be credited by a transaction that did not apply');

        // Now the miner does what he was told to do.
        await sp.recordShare(share);
        assert.strictEqual(redis._credit('w.1'), 0.000002,
            'the resubmission must be creditable; otherwise "please resubmit" '
            + 'is an instruction the pool refuses to honour');
    });

    await test('two different solutions are still two credits', async () => {
        const redis = fakeRedis();
        const sp = processor(redis);
        await sp.recordShare({ worker: 'w.1', difficulty: 0.000002, jobId: '1',
                               powHash: 'ab'.repeat(32) });
        await sp.recordShare({ worker: 'w.1', difficulty: 0.000002, jobId: '1',
                               powHash: 'cd'.repeat(32) });
        assert.strictEqual(redis._credit('w.1'), 0.000004,
            'honest work stopped being paid');
    });

    await test('a redis that cannot answer refuses the share, it does not wave it through', async () => {
        const redis = fakeRedis();
        redis.sadd = async () => { throw new Error('connection lost'); };
        const sp = processor(redis);
        await assert.rejects(
            sp.recordShare({ worker: 'w.1', difficulty: 1, jobId: '1',
                             powHash: 'ef'.repeat(32) }),
            /connection lost/,
            'a redis failure became a free pass for an uncheckable share');
    });

    await test('refreshTemplate actually hands the claim set over', async () => {
        // The unit tests above prove the mechanism works. This proves the
        // pool USES it, which is a different statement and the one that was
        // false this morning. It drives the real refreshTemplate twice with
        // the tip unchanged, the way the 55-second rebuild does.
        const Module = require('module');
        const orig = Module._load;
        Module._load = function (req, parent, isMain) {
            if (/native$/.test(req)) {
                return { hash: async () => Buffer.alloc(32, 0xff),
                         configure: () => {}, seedForHeight: () => Buffer.alloc(32),
                         stats: () => ({}) };
            }
            return orig(req, parent, isMain);
        };
        let JobManager;
        try {
            JobManager = require('../lib/jobManager');
        } finally {
            Module._load = orig;
        }

        const jm = new JobManager(
            { async getBlockTemplate() { return JSON.parse(JSON.stringify(RPC)); } },
            { poolAddress: OPTS.poolAddress, netVersions: OPTS.netVersions,
              coinbaseSignature: OPTS.coinbaseSignature,
              jobRebroadcastTimeout: 55, maxJobHistory: 4 },
            { info() {}, warn() {}, error() {}, debug() {} });

        await jm.refreshTemplate(true);
        const a = jm.currentJob;
        await jm.refreshTemplate(true);
        const b = jm.currentJob;

        assert.strictEqual(jm.validJobs.size, 2,
            'the older job was dropped, so this says nothing about replay');
        assert.notStrictEqual(a, b, 'refreshTemplate did not build a new job');
        assert.strictEqual(a.height, b.height);
        assert.strictEqual(a.submits, b.submits,
            'refreshTemplate built a sibling job with its own claim set, which '
            + 'is WAM-F5 exactly');
        assert.strictEqual(a.registerSubmit(E1, E2, NTIME, NONCE), true);
        assert.strictEqual(b.registerSubmit(E1, E2, NTIME, NONCE), false,
            'through the real refreshTemplate, one solution is still credited '
            + 'twice');
    });

    await test('the claim set is dropped with the round', () => {
        const src = fs.readFileSync(require.resolve('../lib/shareProcessor'), 'utf8');
        const roundDel = src.indexOf("del(this.k('round'))");
        const powDel = src.indexOf("del(this.k('round:pow'))");
        assert.ok(powDel > -1 && powDel - roundDel < 400 && powDel > roundDel,
            'the proof-of-work set is not deleted where the round is, so it '
            + 'grows without end');
    });

    console.log();
    if (!fail.length) {
        console.log(`${GRN}${BLD}${pass} passed: one solution, one credit${OFF}\n`);
    } else {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
    }
    process.exit(fail.length ? 1 : 0);
})();
