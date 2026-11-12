'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  log-injection.test.js -- one log call, one log line, whoever is talking
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Logger._write interpolated its message verbatim and appended a newline.
//  Nothing in between removed anything. So a string carrying a newline did
//  not produce one log line; it produced two, and a stranger wrote the
//  second.
//
//  On a mining pool the strings come from strangers before anybody
//  authenticates. mining.authorize is the first message a connection sends,
//  and the stratum server logged both the address it was given and the
//  worker label. A 30-character label --
//
//      "a\n2026-11-11 08:00:00 [ERROR]"
//
//  -- put `2026-11-11 08:00:00 [ERROR]` in the operator's log, on its own
//  line, in this logger's exact format. A timestamped error nothing in this
//  repository wrote, in the file the operator reads to find out whether
//  miners were paid.
//
//  Reported by 0xpack (managementpackaging@gmail.com) on 11 November 2026
//  against v0.1.14, with a reproduction that drives the real stratum server
//  and the real logger over a loopback port. The two cases named VECTOR
//  below are his, including his markers and his label, kept exactly as he
//  sent them so that his script and this file are asking the same question.
//
//  The fix is in Logger, not at the call sites: there are forty-odd log
//  calls in this pool and more will be written, and a rule each one has to
//  remember is a rule that holds until somebody is in a hurry.
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const Logger = require('../lib/logger');
const StratumServer = require('../lib/stratumServer');
const { ADDRESS_VERSIONS } = require('../lib/constants');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-log-injection-'));
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }));
let seq = 0;

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

/** A logger writing to its own file, and a way to read what it wrote. */
function makeLogger() {
    const file = path.join(DIR, `pool${++seq}.log`);
    const log = new Logger({ level: 'debug', file, color: false });
    return {
        log,
        file,
        async lines() {
            await new Promise((r) => setTimeout(r, 60));
            const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            return text.split('\n').filter((l) => l !== '');
        }
    };
}

// Every line this logger writes starts with its own timestamp and level. A
// line that does not is a line it did not write -- which is the whole of the
// finding, stated as something a test can check.
const OURS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[(DEBUG|INFO |WARN |ERROR)\] \[/;

(async () => {
    console.log(`\n${BLD}  one log call, one log line${OFF}\n`);

    await test('a message carrying a newline stays one line', async () => {
        const L = makeLogger();
        L.log.info('stratum', 'authorized as W1.a\n2026-11-11 08:00:00 [ERROR]');
        const lines = await L.lines();
        assert.strictEqual(lines.length, 1,
            `one log call wrote ${lines.length} lines; the second was written `
            + 'by whoever supplied the string');
        assert.ok(lines[0].includes('\\n'),
            'the newline was dropped rather than escaped -- a line that loses '
            + 'characters lies about what arrived');
    });

    await test('and so does one carrying a carriage return', async () => {
        // \r writes no new line and is worse in a terminal: it returns the
        // cursor, so the rest of the message overwrites what came before it.
        const L = makeLogger();
        L.log.warn('stratum', 'real message\rforged');
        const lines = await L.lines();
        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].includes('real message\\rforged'),
            'the carriage return was not escaped');
    });

    await test('an ANSI escape cannot repaint the operator\'s terminal', async () => {
        const L = makeLogger();
        L.log.error('shares', 'ok\u001b[2K\u001b[1A\u001b[31mPAYMENT FAILED');
        const lines = await L.lines();
        assert.strictEqual(lines.length, 1);
        assert.ok(!lines[0].includes('\u001b'),
            'an ESC reached the log file, so a stranger can erase lines and '
            + 'recolour them on any terminal that tails it');
    });

    await test('and neither can a line separator or a bidi override', async () => {
        const L = makeLogger();
        L.log.info('stratum', 'a b c‮d');
        const lines = await L.lines();
        assert.strictEqual(lines.length, 1);
        for (const ch of [' ', ' ', '‮']) {
            assert.ok(!lines[0].includes(ch),
                'U+' + ch.charCodeAt(0).toString(16) + ' reached the log file');
        }
    });

    await test('a very long message is clipped and says so', async () => {
        const L = makeLogger();
        L.log.info('stratum', 'A'.repeat(50000));
        const lines = await L.lines();
        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].length < 2200,
            `a stranger turned one connection into a ${lines[0].length}-character `
            + 'log line');
        assert.ok(lines[0].includes('[50000 chars]'),
            'the line was truncated without saying that it was');
    });

    await test('the component name is on the same leash', async () => {
        const L = makeLogger();
        L.log.info('strat\num]', 'hello');
        const lines = await L.lines();
        assert.strictEqual(lines.length, 1);
    });

    await test('an ordinary line is untouched', async () => {
        const L = makeLogger();
        L.log.info('stratum', '1.2.3.4 authorized as W1abc.rig1');
        const lines = await L.lines();
        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].endsWith('[stratum] 1.2.3.4 authorized as W1abc.rig1'),
            `escaping changed a line that had nothing wrong with it: ${lines[0]}`);
    });

    // -----------------------------------------------------------------------
    //  The reporter's two vectors, through the real stratum server
    // -----------------------------------------------------------------------

    console.log(`\n${BLD}  and the same thing over a socket, unauthenticated${OFF}\n`);

    /** The real StratumServer on a loopback port, with a stub job manager. */
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

    function send(stratum, message) {
        return new Promise((resolve, reject) => {
            const port = stratum.servers[0].address().port;
            const sock = net.connect(port, '127.0.0.1', () => {
                sock.write(JSON.stringify(message) + '\n');
                setTimeout(() => { sock.destroy(); resolve(); }, 120);
            });
            sock.on('error', reject);
        });
    }

    // A real mainnet address, so the second vector gets past validation. It
    // is the treasury address, which is public and already a fixture here.
    const ADDR = 'WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE';

    await test('VECTOR 1: an invalid address cannot forge a line', async () => {
        const L = makeLogger();
        const stratum = makeStratum(L.log.scope('stratum'));
        await new Promise((r) => setTimeout(r, 80));
        await send(stratum, { id: 1, method: 'mining.authorize', params: [
            'notanaddress\nFORGED-V1-MARKER-9d41c7 [ERROR] [shares] fake payment failure',
            'x'] });
        stratum.close();

        const lines = await L.lines();
        for (const line of lines) {
            assert.ok(OURS.test(line),
                `a line in the operator's log was not written by the logger:\n`
                + `        ${JSON.stringify(line)}`);
        }
        const forged = lines.filter((l) => l.includes('FORGED-V1-MARKER-9d41c7')
                                        && !l.includes('tried to authorize'));
        assert.strictEqual(forged.length, 0,
            'the reporter\'s marker landed on a line of its own');
    });

    await test('VECTOR 2: a worker label cannot forge a line', async () => {
        const L = makeLogger();
        const stratum = makeStratum(L.log.scope('stratum'));
        await new Promise((r) => setTimeout(r, 80));
        // His label, exactly: 'a', a newline, and a full fake log line.
        await send(stratum, { id: 1, method: 'mining.subscribe', params: ['wam-miner/0.1.14'] });
        await send(stratum, { id: 2, method: 'mining.authorize',
                              params: [`${ADDR}.a\n2026-11-11 08:00:00 [ERROR]`, 'x'] });
        stratum.close();

        const lines = await L.lines();
        for (const line of lines) {
            assert.ok(OURS.test(line),
                `a line in the operator's log was not written by the logger:\n`
                + `        ${JSON.stringify(line)}`);
        }
        assert.strictEqual(lines.filter((l) => l === '2026-11-11 08:00:00 [ERROR]').length, 0,
            'the forged timestamped ERROR line is in the log');
    });

    await test('and an honest rig still authorizes under its own name', async () => {
        const L = makeLogger();
        const stratum = makeStratum(L.log.scope('stratum'));
        await new Promise((r) => setTimeout(r, 80));
        await send(stratum, { id: 1, method: 'mining.authorize',
                              params: [`${ADDR}.rig1`, 'x'] });
        stratum.close();

        const lines = await L.lines();
        assert.strictEqual(
            lines.filter((l) => l.includes(`authorized as ${ADDR}.rig1`)).length, 1,
            'a miner with an ordinary rig name was not authorized under it -- '
            + 'the charset filter is too strict and every dashboard entry, '
            + 'PPLNS row and payout label changed with it');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: nobody else writes in our log${OFF}\n`);
})();
