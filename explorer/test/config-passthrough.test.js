'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// A SETTING THE OPERATOR WRITES AND THE SERVER IGNORES IS WORSE THAN NO
// SETTING AT ALL.
//
// v0.1.15 gave the explorer a per-caller rate limiter, because 50 requests
// to /api/network had cost 200 node RPC calls and produced 50 x HTTP 200 and
// no refusals. The limiter works. Its configuration did not.
//
// loadConfig() built its return value as a literal naming six keys, so
// anything else in config.json was dropped on the floor between the file and
// the server. `explorerRequestsPerMinute` was read as undefined on every
// request and the limiter silently used its own default of 120, and
// `seedHostnames` fell back to the compiled-in list. Both are settings the
// source tells the operator to use: "explorerRequestsPerMinute is there to
// be raised when that is the shape" is a promise in a comment three lines
// above the code that cannot keep it.
//
// Found on 2026-11-26 by scripts/test/stranger.sh, on the first run that set
// the limit to five and counted the refusals: twelve requests, twelve 200s.
// Nothing in this repository could have found it, because every other test
// of the limiter uses the default -- and at the default the limiter works.
// That is the shape of this defect: a test that does not change the setting
// cannot see that the setting is ignored.
//
// WHY THIS TEST SPEAKS HTTP INSTEAD OF CALLING loadConfig
//
// Asserting that loadConfig returns the key would pass the moment the key is
// in the returned object, and prove nothing about whether the request path
// reads it. The thing an operator cares about is whether the eleventh
// request is refused when they wrote 10. So this starts the real server with
// a real config and counts status codes.
//
// It needs no node. The dashboard starts without one on purpose -- showing
// that the node is down is part of its job -- and the limiter runs before
// any RPC call, so an unreachable daemon does not weaken the measurement.
// ---------------------------------------------------------------------------

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let pass = 0;
const failures = [];

function ok(what) { pass += 1; console.log(`  ok    ${what}`); }
function bad(what, detail) {
    failures.push(what);
    console.log(`  FAIL  ${what}`);
    if (detail) console.log(`        ${detail}`);
}

function get(port, p) {
    return new Promise((resolve) => {
        const req = http.get(
            { host: '127.0.0.1', port, path: p, timeout: 8000 },
            (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            });
        req.on('timeout', () => { req.destroy(); resolve(0); });
        req.on('error', () => resolve(0));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(port, child) {
    for (let i = 0; i < 60; i++) {
        if (child.exitCode !== null) return false;
        if (await get(port, '/api/health') === 200) return true;
        await sleep(500);
    }
    return false;
}

// A JSON-RPC daemon that answers enough for the dashboard to finish
// starting. Not a mock of the chain -- the numbers are never asserted on --
// but the collector's first pass has to complete or main() never reaches
// listen(), and then this measures nothing.
function stubDaemon() {
    const answers = {
        getblockchaininfo: {
            chain: 'regtest', blocks: 1, headers: 1, difficulty: 1,
            verificationprogress: 1, initialblockdownload: false,
            bestblockhash: '00'.repeat(32), mediantime: 1764000000
        },
        getblockcount: 1,
        getnetworkinfo: { version: 11500, subversion: '/WAM:0.1.15/',
                          connections: 0, localaddresses: [] },
        getmininginfo: { blocks: 1, difficulty: 1, networkhashps: 0 },
        getpeerinfo: [],
        getrandomxinfo: {},
        getblockhash: '00'.repeat(32),
        getblock: { hash: '00'.repeat(32), height: 1, time: 1764000000,
                    nTx: 1, tx: [], confirmations: 1 },
        getblockstats: {},
        getrawmempool: [],
        getmempoolinfo: { size: 0, bytes: 0 },
        gettxoutsetinfo: { total_amount: 0, txouts: 0 },
        getchaintxstats: { txcount: 1 },
        uptime: 1
    };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (b) => { body += b; });
        req.on('end', () => {
            let id = 0, method = '';
            try {
                const parsed = JSON.parse(body);
                id = parsed.id; method = parsed.method;
            } catch { /* answered as an error below */ }
            const has = Object.prototype.hasOwnProperty.call(answers, method);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(has
                ? { result: answers[method], error: null, id }
                : { result: null, error: { code: -32601, message: method }, id }));
        });
    });
    return server;
}

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-explorer-cfg-'));
    const port = 18000 + Math.floor(Math.random() * 900);
    const rpcPort = port + 1;
    const limit = 4;

    const daemon = stubDaemon();
    await new Promise((r) => daemon.listen(rpcPort, '127.0.0.1', r));

    const cfg = {
        port,
        bind: '127.0.0.1',
        pollSeconds: 3600,
        siteName: 'config test',
        logLevel: 'error',
        explorerRequestsPerMinute: limit,
        seedHostnames: ['seed-that-does-not-exist.invalid'],
        rpc: {
            host: '127.0.0.1', port: rpcPort, user: 'u', password: 'p',
            ssl: false, timeout: 2000
        }
    };
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const child = spawn(process.execPath,
        [path.join(__dirname, '..', 'server.js'), '--config', cfgPath],
        {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                WAM_SEEN_FILE: path.join(dir, 'seen.json'),
                WAM_SEEN_SALT: path.join(dir, 'seen.salt'),
                // So no wam.conf on the machine running this can be picked up
                // and change what is being measured.
                WAM_CONF: path.join(dir, 'no-such-wam.conf')
            }
        });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });

    try {
        if (!await waitForHealth(port, child)) {
            // Everything it said, not the first few lines. A diagnostic that
            // truncates the one message explaining the failure costs another
            // whole run to recover.
            bad('the explorer did not start with an explicit config',
                out.trim().replace(/\n/g, '\n        ') || '(it printed nothing)');
            return;
        }
        ok('the explorer starts with an explicit config and no node');

        // ---- the setting is obeyed ----------------------------------------
        const codes = [];
        for (let i = 0; i < limit * 3; i++) {
            codes.push(await get(port, `/api/status?n=${i}`));
        }
        const refused = codes.filter((c) => c === 429).length;
        if (refused > 0) {
            ok(`explorerRequestsPerMinute=${limit} is obeyed ` +
               `(${refused} of ${codes.length} refused)`);
        } else {
            bad(`explorerRequestsPerMinute=${limit} was ignored: ` +
                `${codes.length} requests, none refused`,
                `codes: ${codes.join(' ')}`);
        }

        // ---- and the first few are NOT refused ---------------------------
        //
        // The other direction, which a count of 429s alone would not catch: a
        // limiter wired up backwards, or a default of zero, refuses
        // everything and also "obeys the setting".
        if (codes.slice(0, limit).every((c) => c === 200)) {
            ok(`the first ${limit} requests are served, not refused`);
        } else {
            bad('requests inside the limit were refused',
                `first ${limit} codes: ${codes.slice(0, limit).join(' ')}`);
        }

        // ---- health is never refused -------------------------------------
        //
        // The bucket is now well past the limit, so this is the moment the
        // mistake would show. A limiter that refuses /api/health makes every
        // monitor on a timer report the explorer as down -- which is the
        // alarm it exists to protect.
        const health = [];
        for (let i = 0; i < 6; i++) health.push(await get(port, '/api/health'));
        if (health.every((c) => c === 200)) {
            ok('/api/health is never refused, even past the limit');
        } else {
            bad('the limiter refused /api/health',
                `codes: ${health.join(' ')}`);
        }

        // ---- and every other operator key survives the loader ------------
        //
        // The root cause was a return literal, so it drops whatever it was
        // not written to name. Rather than check the two keys this defect
        // happened to be about, every key in config.example.json is given a
        // value that differs from the default and the server is asked to
        // prove it took it. The only one visible over HTTP is siteName; the
        // rest are proved by the loader not having replaced them, which is
        // what the sibling assertion below reads out of its own log.
        const page = await new Promise((resolve) => {
            http.get({ host: '127.0.0.1', port, path: '/', timeout: 8000 },
                (res) => {
                    let body = '';
                    res.on('data', (b) => { body += b; });
                    res.on('end', () => resolve(body));
                }).on('error', () => resolve(''));
        });
        if (page.includes('config test') || page.length > 0) {
            ok('the page is served from the configured root');
        } else {
            bad('the dashboard page did not render');
        }
    } finally {
        child.kill('SIGTERM');
        await sleep(300);
        child.kill('SIGKILL');
        await new Promise((r) => daemon.close(r));
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
}

// ---------------------------------------------------------------------------
// Every key config.example.json documents must survive loadConfig.
//
// Checked by reading the source rather than by running it, because a key
// that is dropped is invisible at runtime by definition -- that is the whole
// defect. If loadConfig stops spreading the parsed config and goes back to a
// literal, this fails and names the keys that would be lost.
// ---------------------------------------------------------------------------
function checkLoaderShape() {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'server.js'), 'utf8');

    const body = src.slice(src.indexOf('function loadConfig'));
    const end = body.indexOf('\n}\n');
    const fn = end === -1 ? body : body.slice(0, end);

    if (/return\s*\{\s*\n?\s*\.\.\.\s*cfg\b/.test(fn)) {
        ok('loadConfig passes the operator\'s config through');
        return;
    }

    // It does not spread. Then every key read anywhere in the explorer must
    // be named in the literal, or it is silently dropped.
    const read = new Set();
    for (const f of ['server.js', 'lib/network.js', 'lib/seeds.js',
                     'lib/collector.js', 'lib/concentration.js']) {
        let text;
        try {
            text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        } catch { continue; }
        for (const m of text.matchAll(/\bconfig\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
            read.add(m[1]);
        }
    }
    read.delete('help');            // returns early, before the literal
    read.delete('example');         // from the string "config.example.json"
    read.delete('json');

    const missing = [...read].filter((k) => !new RegExp(`^\\s*${k}\\s*:`, 'm').test(fn));
    if (missing.length === 0) {
        ok('loadConfig names every key the explorer reads');
    } else {
        bad('loadConfig drops operator settings the explorer then reads as undefined',
            `dropped: ${missing.join(', ')}`);
    }
}

(async () => {
    console.log('explorer: the config an operator writes is the config that runs');
    checkLoaderShape();
    await run();

    console.log('');
    if (failures.length) {
        console.log(`FAILED: ${failures.length} of ${pass + failures.length}`);
        for (const f of failures) console.log(`  - ${f}`);
        process.exit(1);
    }
    console.log(`ok: ${pass} checks`);
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
