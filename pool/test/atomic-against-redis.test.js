'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  atomic-against-redis.test.js -- the five scripts, run by redis itself
// ===========================================================================
//
//  WHY THIS EXISTS, WHEN THERE IS ALREADY A DOUBLE
//
//  pool/test/fakeAtomic.js reimplements these scripts in JavaScript, and
//  every other suite in this directory runs against it. That double is
//  useful and it cannot answer the one question this file is about: whether
//  a script leaves state behind when redis REFUSES a command partway.
//
//  It cannot answer it because it is a reimplementation. The maturation
//  credit took its exactly-once marker before the type checks that can
//  refuse, and the double took the same marker AFTER its own refusal check
//  -- the correct order, written by hand, next to a script that did the
//  opposite. So the suite was green while the shipped script would mark a
//  block credited with nobody paid. A double can only disagree with the
//  thing it doubles if something runs both.
//
//  This runs the real text of all five scripts, read from pool/lib/atomic.js
//  at the top of this file, inside a throwaway redis-server of its own.
//  Nothing here touches a configured instance: it starts one on a free port
//  with persistence off, uses a key prefix of its own, and shuts it down.
//
//  WHAT IT HOLDS DOWN
//
//  One rule, in five places: everything that can be refused is checked
//  BEFORE the first write, because redis does not roll a script back when a
//  command inside it fails at run time. It keeps what already ran and hands
//  the error back.
//
//  Four of the five learned that one at a time, each from a report. The
//  fifth -- wamClaimAndRecord, the oldest, the one guarding the only
//  surviving statement of what a round's miners are owed -- was written
//  before the rule existed and was never revisited. It is covered here too.
//
//  And one deliberate exception, asserted so that nobody tidies it away:
//  wamRecordBlock writes its payout table FIRST and increments a counter
//  last, because a fee counter short by one block is repairable from
//  blocks:pending and a destroyed payout table is not.
//
//  EXIT CODES
//
//      0   every case passed
//      1   a case failed
//      2   no redis-server could be started, so nothing was checked --
//          which is not a pass. run-all.js prints that as its own status.
// ===========================================================================

const assert = require('assert');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { SCRIPTS } = require('../lib/atomic');

const GRN = '\x1b[32m', RED = '\x1b[31m', YLW = '\x1b[33m',
      BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

// ---------------------------------------------------------------------------
//  A redis client of about eighty lines.
//
//  ioredis is the pool's client and is not installed in this checkout, and a
//  test of what redis does with a script should not depend on a library's
//  idea of what the reply meant. RESP is simple enough to read directly:
//  an error arrives as an Error here, like any other value, because half of
//  these cases are about what is true AFTER one.
// ---------------------------------------------------------------------------

class Redis {
    constructor(port) {
        this.port = port;
        this.buf = Buffer.alloc(0);
        this.waiting = [];
    }

    connect(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const sock = net.connect(this.port, '127.0.0.1');
            const timer = setTimeout(() => {
                sock.destroy();
                reject(new Error(`no redis on 127.0.0.1:${this.port}`));
            }, timeoutMs);
            sock.on('connect', () => { clearTimeout(timer); this.sock = sock; resolve(this); });
            sock.on('error', (e) => { clearTimeout(timer); reject(e); });
            sock.on('data', (d) => this._feed(d));
        });
    }

    _feed(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            const got = parse(this.buf, 0);
            if (!got) return;
            this.buf = this.buf.slice(got.end);
            const w = this.waiting.shift();
            if (w) w(got.value);
        }
    }

    cmd(...args) {
        const parts = args.map(String);
        let out = `*${parts.length}\r\n`;
        for (const p of parts) out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
        return new Promise((resolve) => {
            this.waiting.push(resolve);
            this.sock.write(out);
        });
    }

    /** Run one of the pool's own scripts, by the name the pool calls it. */
    script(name, keys, args) {
        const s = SCRIPTS.find((x) => x.name === name);
        assert.ok(s, `pool/lib/atomic.js no longer defines ${name}`);
        assert.strictEqual(keys.length, s.numberOfKeys,
            `${name} takes ${s.numberOfKeys} keys, not ${keys.length}`);
        return this.cmd('EVAL', s.lua, s.numberOfKeys, ...keys, ...args);
    }

    close() { if (this.sock) this.sock.destroy(); }
}

/** One RESP value out of buf at i, or null while it is still arriving. */
function parse(buf, i) {
    if (i >= buf.length) return null;
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) return null;
    const kind = String.fromCharCode(buf[i]);
    const head = buf.toString('utf8', i + 1, nl);
    const after = nl + 2;

    if (kind === '+') return { value: head, end: after };
    if (kind === '-') return { value: new Error(head), end: after };
    if (kind === ':') return { value: Number(head), end: after };
    if (kind === '$') {
        const n = Number(head);
        if (n === -1) return { value: null, end: after };
        if (buf.length < after + n + 2) return null;
        return { value: buf.toString('utf8', after, after + n), end: after + n + 2 };
    }
    if (kind === '*') {
        const n = Number(head);
        if (n === -1) return { value: null, end: after };
        const items = [];
        let at = after;
        for (let k = 0; k < n; k++) {
            const got = parse(buf, at);
            if (!got) return null;
            items.push(got.value);
            at = got.end;
        }
        return { value: items, end: at };
    }
    throw new Error(`unreadable RESP byte ${JSON.stringify(kind)}`);
}

// ---------------------------------------------------------------------------
//  Somewhere to run it.
//
//  On this project's own Windows machine there is no native redis-server and
//  WSL has one -- the same place the node is built. A port listening on the
//  loopback inside WSL is reachable from Windows on 127.0.0.1, so the only
//  difference is the command.
// ---------------------------------------------------------------------------

function haveNative() {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which',
                        ['redis-server'], { stdio: 'ignore' });
    return r.status === 0;
}

function haveWsl() {
    if (process.platform !== 'win32') return false;
    const r = spawnSync('wsl.exe', ['-e', 'bash', '-lc',
                                    'command -v redis-server >/dev/null'],
                        { stdio: 'ignore' });
    return r.status === 0;
}

/** A port nothing is listening on, asked of the system rather than guessed. */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

async function startRedis() {
    const native = haveNative();
    const wsl = native ? false : haveWsl();
    if (!native && !wsl) return null;

    // Three attempts: a port free on this side can still be taken on the
    // other side of WSL, and that is a race, not a failure.
    for (let attempt = 0; attempt < 3; attempt++) {
        const port = await freePort();
        const args = ['--port', String(port), '--bind', '127.0.0.1',
                      '--save', '', '--appendonly', 'no'];
        const child = native
            ? spawn('redis-server', args, { stdio: 'ignore' })
            : spawn('wsl.exe', ['-e', 'redis-server', ...args], { stdio: 'ignore' });
        child.on('error', () => {});

        for (let tick = 0; tick < 40; tick++) {
            await new Promise((r) => setTimeout(r, 100));
            try {
                const c = await new Redis(port).connect(1000);
                const pong = await c.cmd('PING');
                if (pong === 'PONG') return { client: c, port, child };
                c.close();
            } catch { /* not up yet */ }
        }
        try { child.kill(); } catch { /* already gone */ }
    }
    return null;
}

// ---------------------------------------------------------------------------

const ADDR = 'WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE';
const OTHER = 'WbQpcN7ScDMm8Mb7vJbDsGmPTAXyDcoB1x';
const HASH = '0000000000000000000000000000000000000000000000000000000000000abc';
const TXID = 'f'.repeat(64);
const RECORD = JSON.stringify({ hash: HASH, height: 41000, reward: 4750000000 });

/** Keys for one case, so no case can be polluted by the one before it. */
let caseNo = 0;
function keyset() {
    const p = `wam-test:${process.pid}:${++caseNo}`;
    return {
        pending: `${p}:blocks:pending`,
        maturing: `${p}:blocks:maturing`,
        credited: `${p}:blocks:credited`,
        balances: `${p}:balances`,
        confirmed: `${p}:blocks:confirmed`,
        count: `${p}:blocks:confirmed:count`,
        hashes: `${p}:blocks:confirmed:hashes`,
        round: `${p}:round`,
        pow: `${p}:round:pow`,
        pplns: `${p}:pplns`,
        hashrate: `${p}:hashrate`,
        poolfees: `${p}:poolfees`,
        done: `${p}:payments:done`,
        paid: `${p}:paid`,
        payments: `${p}:payments`,
        inflight: `${p}:payment:inflight`,
        postponed: `${p}:payment:postponed`
    };
}

function isError(v, what) {
    assert.ok(v instanceof Error,
        `${what}: the script returned ${JSON.stringify(v)} instead of refusing`);
    return v.message;
}

(async () => {
    console.log(`\n${BLD}  the five scripts, run by redis itself${OFF}\n`);

    const up = await startRedis();
    if (!up) {
        console.log(`  ${YLW}!!${OFF}    no redis-server could be started, so the five`);
        console.log('        scripts were not run at all. On Windows this looks');
        console.log('        in WSL, where the node is built.\n');
        process.exit(2);
    }
    const r = up.client;

    // ---- the oldest script, and the most expensive failure ---------------
    //
    // blocks:pending holds the only statement of what every miner in the
    // round is owed; the round that could rebuild it was deleted in the same
    // breath that wrote it. HDEL there, with the LPUSH after it refused,
    // destroys that statement outright.

    await test('a refused maturation claim leaves the payout table where it was',
               async () => {
        const k = keyset();
        await r.cmd('HSET', k.pending, HASH, RECORD);
        await r.cmd('SET', k.maturing, 'not-a-list');

        const said = await r.script('wamClaimAndRecord',
                                    [k.pending, k.maturing], [HASH, RECORD]);
        const msg = isError(said, 'wamClaimAndRecord with a wrong-typed evidence list');

        // THE STATE FIRST, THE MESSAGE SECOND.
        //
        // Asserted the other way round, this case failed against the old
        // script by complaining about the wording of a WRONGTYPE -- true,
        // and not what is wrong. What is wrong is one line down.
        const still = await r.cmd('HGET', k.pending, HASH);
        assert.strictEqual(still, RECORD,
            'the HDEL ran and the LPUSH after it was refused, so the block is '
            + 'gone from blocks:pending, absent from blocks:maturing and not '
            + 'credited -- the only surviving statement of what the round is '
            + 'owed, destroyed by a refusal. redis does not roll a script '
            + 'back; it keeps what already ran.');

        assert.ok(/not a list/.test(msg),
            `refused with ${JSON.stringify(msg)} -- correct, and it names no `
            + 'key, so an operator reading it at three in the morning cannot '
            + 'tell which of the two is wrong');
    });

    await test('and a sound one still claims exactly once', async () => {
        const k = keyset();
        await r.cmd('HSET', k.pending, HASH, RECORD);

        const first = await r.script('wamClaimAndRecord',
                                     [k.pending, k.maturing], [HASH, RECORD]);
        const second = await r.script('wamClaimAndRecord',
                                      [k.pending, k.maturing], [HASH, RECORD]);
        assert.strictEqual(first, 1, 'the first caller did not win');
        assert.strictEqual(second, 0,
            'two callers both claimed one block -- the HDEL return value is '
            + 'what makes exactly one of them the winner');
        const kept = await r.cmd('LRANGE', k.maturing, 0, -1);
        assert.deepStrictEqual(kept, [RECORD],
            'the evidence was written twice, or not at all');
    });

    // ---- the maturation credit -------------------------------------------
    //
    // Reported 13 November 2026 against the published script, and again on
    // 17 November by a second reader working from the same published text.

    await test('a refused credit marks nothing as credited', async () => {
        const k = keyset();
        await r.cmd('SET', k.balances, 'not-a-hash');

        const said = await r.script('wamCreditMatured',
            [k.credited, k.balances, k.confirmed, k.count, k.hashes, k.maturing],
            [HASH, RECORD, '100', ADDR, '4750000000']);
        const msg = isError(said, 'wamCreditMatured with a wrong-typed balances');
        assert.ok(/balances is not a hash/.test(msg), `refused with ${JSON.stringify(msg)}`);

        const marked = await r.cmd('SISMEMBER', k.credited, HASH);
        assert.strictEqual(marked, 0,
            'the block is marked credited and nobody was paid. The marker is '
            + 'what makes the credit exactly-once, so every retry now answers '
            + '0 and skips the payout: the miners stay uncredited until an '
            + 'operator goes in by hand.');
    });

    await test('and the retry after the state is repaired pays in full', async () => {
        const k = keyset();
        await r.cmd('SET', k.balances, 'not-a-hash');
        await r.script('wamCreditMatured',
            [k.credited, k.balances, k.confirmed, k.count, k.hashes, k.maturing],
            [HASH, RECORD, '100', ADDR, '4750000000']);

        await r.cmd('DEL', k.balances);                 // the operator's repair
        const again = await r.script('wamCreditMatured',
            [k.credited, k.balances, k.confirmed, k.count, k.hashes, k.maturing],
            [HASH, RECORD, '100', ADDR, '4750000000', OTHER, '250000000']);

        assert.strictEqual(again, 1,
            'the retry returned 0: the earlier refusal left a claim behind, '
            + 'and the payout is now unreachable by any ordinary path');
        assert.strictEqual(await r.cmd('HGET', k.balances, ADDR), '4750000000');
        assert.strictEqual(await r.cmd('HGET', k.balances, OTHER), '250000000');
        assert.strictEqual(await r.cmd('SISMEMBER', k.hashes, HASH), 1);
        assert.strictEqual(await r.cmd('GET', k.count), '1');
    });

    await test('a second delivery of the same credit changes nothing', async () => {
        const k = keyset();
        const argv = [HASH, RECORD, '100', ADDR, '4750000000'];
        const keys = [k.credited, k.balances, k.confirmed, k.count, k.hashes, k.maturing];

        assert.strictEqual(await r.script('wamCreditMatured', keys, argv), 1);
        assert.strictEqual(await r.script('wamCreditMatured', keys, argv), 0,
            'ioredis replays a command whose reply never arrived, and every '
            + 'write in this script is an increment');
        assert.strictEqual(await r.cmd('HGET', k.balances, ADDR), '4750000000',
            'the balance was credited twice');
        assert.strictEqual(await r.cmd('LLEN', k.confirmed), 1);
    });

    // ---- the share credit, and the money going out ------------------------

    await test('a refused share credit takes no claim on the proof', async () => {
        const k = keyset();
        await r.cmd('SET', k.pplns, 'not-a-list');

        const said = await r.script('wamCreditShare',
            [k.pow, k.round, k.pplns, k.hashrate],
            [HASH, ADDR, '0.0000077', 'entry', '100', String(Date.now())]);
        isError(said, 'wamCreditShare with a wrong-typed pplns');

        assert.strictEqual(await r.cmd('SISMEMBER', k.pow, HASH), 0,
            'the proof is claimed and the work was not credited; the miner is '
            + 'told to resubmit and the resubmission answers 0 forever');
    });

    await test('a refused payment commit keeps the marker that pauses the pool',
               async () => {
        const k = keyset();
        await r.cmd('SET', k.inflight, TXID);
        await r.cmd('HSET', k.balances, ADDR, 'not-an-integer');

        const said = await r.script('wamCommitPayment',
            [k.done, k.balances, k.paid, k.payments, k.inflight, k.postponed],
            [TXID, RECORD, '100', ADDR, '4750000000']);
        const msg = isError(said, 'wamCommitPayment with a wrong-typed balance');
        assert.ok(/balance for/.test(msg), `refused with ${JSON.stringify(msg)}`);

        assert.strictEqual(await r.cmd('EXISTS', k.inflight), 1,
            'the marker the pause depends on was deleted by a commit that '
            + 'failed -- the restart finds nothing, rebuilds the same batch '
            + 'from the same balances, and pays it a second time');
        assert.strictEqual(await r.cmd('SISMEMBER', k.done, TXID), 0,
            'the txid was recorded as committed by a commit that did not run');
    });

    // ---- the one that is deliberately the other way round -----------------

    await test('a found block is recorded even when the fee counter refuses',
               async () => {
        // NOT A DEFECT, AND ASSERTED SO THAT IT STAYS THAT WAY.
        //
        // wamRecordBlock writes the payout table first on purpose: it is the
        // only statement of who is owed what, and the INCRBY that can refuse
        // is last precisely so that the refusal lands after it. A fee
        // counter short by one block is repairable from blocks:pending. The
        // reverse order would trade a cheap loss for an unrecoverable one.
        const k = keyset();
        await r.cmd('SET', k.poolfees, 'not-an-integer');
        await r.cmd('HSET', k.round, ADDR, '12');

        const said = await r.script('wamRecordBlock',
            [k.pending, k.round, k.pow, k.poolfees], [HASH, RECORD, '47500000']);
        isError(said, 'wamRecordBlock with a wrong-typed fee counter');

        assert.strictEqual(await r.cmd('HGET', k.pending, HASH), RECORD,
            'the payout table was not written, and the round it could be '
            + 'rebuilt from is gone: this is the expensive direction, and the '
            + 'order of this script exists to avoid it');
    });

    // ---- and the double, measured against what it doubles ------------------

    await test('every script checks what can refuse before it writes', async () => {
        // The rule itself, read off the scripts rather than demonstrated one
        // fault at a time -- so a sixth script added later is covered on the
        // day it is added. wamRecordBlock is the documented exception above.
        for (const s of SCRIPTS) {
            if (s.name === 'wamRecordBlock') continue;
            const lines = s.lua.split('\n').map((l) => l.trim());
            const firstWrite = lines.findIndex((l) =>
                /redis\.call\('(SADD|HSET|HSETNX|HDEL|HINCRBY|HINCRBYFLOAT|LPUSH|LTRIM|INCR|INCRBY|DEL|ZADD|LREM|SET)'/.test(l));
            const lastCheck = lines.reduce((acc, l, i) =>
                /error_reply/.test(l) ? i : acc, -1);
            assert.ok(firstWrite > lastCheck,
                `${s.name} writes at line ${firstWrite + 1} and still has a `
                + `refusal at line ${lastCheck + 1}. redis keeps what ran `
                + 'before the refusal, so that write survives an error the '
                + 'caller reads as "nothing happened".');
        }
    });

    await r.cmd('SHUTDOWN', 'NOSAVE').catch(() => {});
    r.close();
    try { up.child.kill(); } catch { /* already gone */ }

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks against a real redis: a refusal leaves nothing behind${OFF}\n`);
    process.exit(0);
})();
