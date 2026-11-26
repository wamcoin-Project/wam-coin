'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  web-tier.test.js -- the page a miner reads his own figures on
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Seven defects on the pool dashboard and its JSON API, reported by
//  Radenlingga on 14 November 2026, each reproduced twice against the live
//  site with ordinary GET requests. None of them touches a payout, and the
//  payout-address redaction was checked and found intact -- which is worth
//  saying, because that is the part that would matter most.
//
//  The ones this file can reach are the API's: a miner who pastes the name
//  the pool taught him to authorize with, replies that were never
//  compressed, the headers a browser acts on, and a health endpoint that
//  told a stranger how much memory the process was using.
//
//  The dashboard's four -- the difficulty column that printed "0" for every
//  miner, the badge counting to 100 when crediting is at 101, two unguarded
//  dereferences, and 64 identical rows for one machine -- live in
//  pool/web/app.js, which runs in a browser. They are held here the only way
//  a test without a DOM can hold them: by driving the pure functions the
//  page uses, which is why the formatter was pulled out into one.
// ===========================================================================

const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const ApiServer = require('../lib/api');
const { ADDRESS_VERSIONS } = require('../lib/constants');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

/** A real server on the loopback, so the headers are the ones a browser gets. */
function listen(cfg = {}) {
    const api = new ApiServer({
        config: {
            netVersions: ADDRESS_VERSIONS.mainnet,
            apiPort: 0, apiBind: '127.0.0.1', ...cfg
        },
        logger: quiet,
        jobManager: {
            currentJob: { height: 1 }, lastTemplateAt: Date.now(),
            getStatus: () => ({ currentJob: { height: 1 } })
        },
        stratumServer: {
            clients: new Map([['1', {}]]),
            getConnectedMiners: () => []
        },
        shareProcessor: {
            async getMinerStats(a) { return { address: a, balance: 0 }; },
            async getPoolStats() { return { recentBlocks: [], pendingBlocks: [], orphanedBlocks: [], recentPayments: [] }; },
            async getHashrateStats() { return { workers: {} }; }
        },
        daemon: { async cmd() { return null; } }
    });
    api.listen();
    return new Promise((resolve) => {
        api.server.once('listening', () =>
            resolve({ api, port: api.server.address().port }));
    });
}

function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                raw: Buffer.concat(chunks)
            }));
        });
        req.on('error', reject);
    });
}

const ADDR = 'WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE';

(async () => {
    console.log(`\n${BLD}  the page a miner reads his own figures on${OFF}\n`);

    // ---- 04: the name the pool taught him --------------------------------
    await test('a lookup takes the <address>.<worker> the pool teaches', async () => {
        const { api, port } = await listen();
        const withLabel = await get(port, `/api/miner?address=${ADDR}.rig1`);
        const bare = await get(port, `/api/miner?address=${ADDR}`);
        api.close();

        assert.strictEqual(withLabel.status, 200,
            `it answered ${withLabel.status}: ${withLabel.raw.toString().slice(0, 90)}`
            + ' -- that is the name this pool tells a miner to authorize with,'
            + ' and the name its own table prints back at him');
        assert.deepStrictEqual(JSON.parse(withLabel.raw.toString()),
                               JSON.parse(bare.raw.toString()),
            'the label changed the answer; balances are per address');
    });

    await test('and a lookup that is not an address is still refused', async () => {
        const { api, port } = await listen();
        const junk = await get(port, '/api/miner?address=notanaddress.rig1');
        api.close();
        assert.strictEqual(junk.status, 400,
            'stripping the label must not turn the validator off');
    });

    // ---- 03: two gigabytes a day, per open tab ---------------------------
    await test('a large reply is compressed when the caller asks', async () => {
        const { api, port } = await listen();
        // A payload worth compressing, the shape /api/miners has.
        api.stratum.getConnectedMiners = () => Array.from({ length: 400 }, (_, i) => ({
            id: String(i), worker: `${ADDR}.rig${i}`, userAgent: '/wam-miner/1.0.0/',
            difficulty: 0.0000077, validShares: i, invalidShares: 0, connectedFor: 60
        }));

        const packed = await get(port, '/api/miners', { 'Accept-Encoding': 'gzip' });
        const plain = await get(port, '/api/miners');
        api.close();

        assert.strictEqual(packed.headers['content-encoding'], 'gzip',
            'no Content-Encoding: one dashboard refresh moves ~184 KB and the '
            + 'page refreshes every eight seconds -- about 2 GB a day for a '
            + 'tab left open, paid by the miner and by this pool both');
        assert.ok(/accept-encoding/i.test(packed.headers.vary || ''),
            'compressed without Vary: Accept-Encoding, so a cache can serve '
            + 'gzip to a client that cannot read it');
        const body = zlib.gunzipSync(packed.raw).toString();
        assert.deepStrictEqual(JSON.parse(body), JSON.parse(plain.raw.toString()),
            'the compressed reply is not the same payload');
        assert.ok(packed.raw.length * 4 < plain.raw.length,
            `${packed.raw.length} compressed against ${plain.raw.length} plain `
            + '-- repetitive JSON should give far more than that');
    });

    await test('a tiny reply is not', async () => {
        const { api, port } = await listen();
        const r = await get(port, '/api/health', { 'Accept-Encoding': 'gzip' });
        api.close();
        assert.ok(r.raw.length < 1024, 'the fixture health payload grew');
        assert.strictEqual(r.headers['content-encoding'], undefined,
            'compressing a hundred bytes costs more than it saves');
    });

    await test('and a client that did not ask is not sent gzip', async () => {
        const { api, port } = await listen();
        api.stratum.getConnectedMiners = () => Array.from({ length: 400 }, (_, i) => ({
            id: String(i), worker: `${ADDR}.rig${i}`, userAgent: 'x',
            difficulty: 1, validShares: i, invalidShares: 0, connectedFor: 1
        }));
        const r = await get(port, '/api/miners', { 'Accept-Encoding': 'identity' });
        api.close();
        assert.strictEqual(r.headers['content-encoding'], undefined);
        JSON.parse(r.raw.toString());        // throws if it is not plain JSON
    });

    // ---- 07: the headers a browser acts on -------------------------------
    await test('the page cannot be framed, and says what it may load', async () => {
        const { api, port } = await listen();
        const r = await get(port, '/api/health');
        api.close();

        const csp = r.headers['content-security-policy'];
        assert.ok(csp, 'no Content-Security-Policy at all');
        assert.ok(/frame-ancestors\s+'none'/.test(csp),
            "no frame-ancestors 'none': any page can frame the dashboard a "
            + 'miner reads his own figures on');
        assert.ok(/default-src\s+'none'/.test(csp), 'the policy has no default');
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
    });

    await test('HSTS is not sent over a plain connection', async () => {
        // A pool on a LAN, or one a developer runs on localhost, must not be
        // pinned to https for six months by its own dashboard.
        const { api, port } = await listen();
        const r = await get(port, '/api/health');
        api.close();
        assert.strictEqual(r.headers['strict-transport-security'], undefined,
            'a plain-HTTP dashboard pinned the browser to https -- a foot-gun '
            + 'with a six-month memory');
    });

    // ---- 07: what a health check is for ----------------------------------
    await test('a stranger is told whether the pool works, and not how it feels',
               async () => {
        const { api, port } = await listen();
        // A request that did not come from this machine.
        const asked = await new Promise((resolve, reject) => {
            const req = http.get({ host: '127.0.0.1', port, path: '/api/health' },
                                 (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
            });
            req.on('error', reject);
        });
        api.close();
        // The loopback IS the operator here, so this one carries the detail;
        // what matters is that the decision exists and is not "everyone".
        assert.ok('ok' in asked && 'problems' in asked,
            'a health check must still answer the question it is for');
    });

    await test('and from behind the proxy it carries none of it', async () => {
        // THE SHAPE THIS POOL IS ACTUALLY DEPLOYED IN.
        //
        // nginx sits in front, so every request reaches the API from
        // 127.0.0.1. The first version of this case called _health() with a
        // hand-made object carrying a public remoteAddress, which no real
        // request ever has here -- it passed while the live site went on
        // serving memoryMb, uptimeSec and connections to anyone who asked,
        // measured against pool.wamcoin.org on 19 November 2026.
        //
        // A real request with the header nginx sends is the only version of
        // this test worth having.
        const { api, port } = await listen();
        const r = await get(port, '/api/health',
                            { 'X-Forwarded-For': '203.0.113.9' });
        api.close();
        const body = JSON.parse(r.raw.toString());

        assert.ok('uptimeSec' in body,
            'uptime was withheld from a stranger. This pool prints it on its '
            + 'own front page -- "healthy . up 6d 12h" -- and the page reads '
            + 'it from here, so withholding it showed "up --" to every '
            + 'visitor on the live site. A number we publish ourselves is '
            + 'not a secret we are keeping.');
        for (const leak of ['memoryMb', 'connections']) {
            assert.ok(!(leak in body),
                `/api/health tells anyone who asks the pool's ${leak}. Behind `
                + 'a reverse proxy the socket address is the proxy, so a check '
                + 'written against it calls the whole internet the operator -- '
                + 'resident memory says how hard the pool is working, uptime '
                + 'says when it last restarted, and the connection count says '
                + 'how many miners would notice');
        }
        assert.ok('ok' in body && 'problems' in body,
            'it stopped answering the question it exists for');
    });

    await test('and a loopback caller gets no more, because it may not be '
               + 'the operator', async () => {
        // THIS CASE USED TO ASSERT THE OPPOSITE, AND THAT WAS THE FOURTH LEAK.
        //
        // It required that a request with no forwarded header carried
        // memoryMb and connections, on the reasoning that such a request
        // "really did come from this machine". It does not. nginx only sets
        // X-Forwarded-For when it is configured to, and when apiBind is
        // 127.0.0.1 a remote caller can ONLY arrive through a local proxy --
        // so a loopback socket with no header is exactly as likely to be a
        // stranger as the operator, and nothing in the request can tell them
        // apart.
        //
        // Two fixes narrowed that condition and it leaked both times.
        // Reported a third time by mpit on 26 November 2026. The condition
        // is gone: detail is opt-in through apiHealthDetail, and the case
        // below proves an operator who asks for it still gets it.
        const { api, port } = await listen();
        const r = await get(port, '/api/health');
        api.close();
        const body = JSON.parse(r.raw.toString());
        for (const leak of ['memoryMb', 'connections']) {
            assert.ok(!(leak in body),
                `a caller with no forwarded header got the pool's ${leak}. `
                + 'Behind a proxy that does not set X-Forwarded-For -- which '
                + 'is nginx\'s default -- that is every stranger on the '
                + 'internet.');
        }
        assert.ok('ok' in body && 'problems' in body && 'uptimeSec' in body,
            'it stopped answering the question it exists for');
    });

    await test('and the operator\'s own reply is not then handed to a stranger',
               async () => {
        // THE CACHE DOES NOT KNOW WHO ASKED.
        //
        // The TTL cache is keyed on the path and the query. _health decides
        // what to include from the CALLER. So the operator's monitoring, on
        // a timer, writes the detailed body into the cache and every request
        // from the internet for the next cacheMs is served it -- marked
        // X-Cache: HIT, which is how it would be found.
        //
        // This is the third time these fields have leaked. The first fix
        // read the socket address, which behind nginx is the proxy. The
        // second read the forwarded caller, correctly, and the cache in
        // front of it handed the answer out anyway.
        // AND THE HAZARD IS GONE RATHER THAN GUARDED, which is the point of
        // the change above: _health no longer decides anything from the
        // caller, so there is no caller-specific body for a shared cache to
        // hand to the wrong person. The assertion is the strong one -- the
        // two replies are the same -- because "the stranger did not get the
        // detail" would also pass if the operator never got it and the cache
        // were still caller-dependent.
        const { api, port } = await listen({ apiCacheMs: 3000 });
        const loopback = JSON.parse(
            (await get(port, '/api/health')).raw.toString());
        const stranger = JSON.parse(
            (await get(port, '/api/health',
                       { 'X-Forwarded-For': '203.0.113.9' })).raw.toString());
        api.close();

        assert.deepStrictEqual(
            Object.keys(loopback).sort(), Object.keys(stranger).sort(),
            'the health body still depends on who asked, so a shared cache '
            + 'can serve one caller\'s answer to another');
        for (const leak of ['memoryMb', 'connections']) {
            assert.ok(!(leak in stranger) && !(leak in loopback),
                `/api/health served the pool's ${leak} without apiHealthDetail`);
        }
    });

    await test('and an operator behind a proxy can still ask for it', async () => {
        // apiHealthDetail is the way back for monitoring that does sit
        // behind something. Without it, such an operator has no route at
        // all and will reach for a worse one.
        const { api, port } = await listen({ apiHealthDetail: true });
        const r = await get(port, '/api/health',
                            { 'X-Forwarded-For': '203.0.113.9' });
        api.close();
        const body = JSON.parse(r.raw.toString());
        assert.ok('memoryMb' in body,
            'apiHealthDetail no longer does anything, so a proxied operator '
            + 'has no way to read their own pool');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: the web tier answers what it is asked${OFF}\n`);
})();
