'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// The API is the only part of the pool a stranger can reach without a miner.
// Two ways that costs us:
//
//   1. The response cache is a Map keyed on the path *and query string*, and
//      /api/miner?address=... is written by whoever is asking. Nothing ever
//      deleted from it. A million distinct addresses is a million entries the
//      process never releases: the pool dies of a request pattern, not a bug.
//
//   2. That same parameter reached Redis unvalidated. Cheap per request, but
//      it is free work done on behalf of someone who is not mining here, and
//      it is what made every junk string a permanent cache entry.
//
// Both are fixed at the door: reject anything that is not an address before it
// becomes a key, and bound the cache so no sequence of requests can grow it
// without limit.
// ---------------------------------------------------------------------------

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

function make(cfg = {}) {
    return new ApiServer({
        config: { netVersions: ADDRESS_VERSIONS.testnet, ...cfg },
        logger: quiet,
        jobManager: {}, stratumServer: {}, shareProcessor: {}, daemon: {}
    });
}

/** Capture what _json would have sent. */
function fakeRes() {
    const res = {
        code: null, body: null, headers: {},
        writeHead(c, h) { res.code = c; Object.assign(res.headers, h || {}); return res; },
        setHeader(k, v) { res.headers[k] = v; },
        end(b) { res.body = b; }
    };
    return res;
}

(async () => {
    console.log('\n=== the cache cannot be grown without limit ===');

    await test('a bounded cache stays bounded under distinct keys', () => {
        const api = make({ apiCacheEntries: 64 });
        for (let i = 0; i < 5000; i++) api._cacheSet(`/api/miner?address=${i}`, { i });
        assert.ok(api.cache.size <= 64,
            `cache grew to ${api.cache.size} entries; an unbounded Map keyed on a `
            + 'query parameter is a memory exhaustion vector');
    });

    await test('the oldest entry is the one evicted', () => {
        const api = make({ apiCacheEntries: 3 });
        api._cacheSet('a', 1); api._cacheSet('b', 2); api._cacheSet('c', 3);
        api._cacheSet('d', 4);
        assert.ok(!api.cache.has('a'), 'the oldest key survived while newer ones were dropped');
        assert.ok(api.cache.has('d'), 'the entry just written was not stored');
    });

    await test('expired entries are reclaimed before a live one is evicted', () => {
        const api = make({ apiCacheEntries: 4, apiCacheMs: 1 });
        api._cacheSet('old1', 1); api._cacheSet('old2', 2);
        api.cache.get('old1').at -= 1000;          // age them past the TTL
        api.cache.get('old2').at -= 1000;
        api._cacheSet('fresh1', 3); api._cacheSet('fresh2', 4);
        api._cacheSet('fresh3', 5);
        assert.ok(api.cache.has('fresh3'), 'the new entry was not stored');
        assert.ok(!api.cache.has('old1') && !api.cache.has('old2'),
            'stale entries were kept while the cache was under pressure');
    });

    await test('the default bound applies when none is configured', () => {
        const api = make();
        for (let i = 0; i < 3000; i++) api._cacheSet(`k${i}`, i);
        assert.ok(api.cache.size <= 512,
            `unconfigured cache reached ${api.cache.size}; the default must bound it`);
    });

    console.log('\n=== a junk address never becomes work, or a key ===');

    await test('validateAddress returns an object, so a truthiness check is wrong', () => {
        const { validateAddress } = require('../lib/util');
        const r = validateAddress('definitely not an address', ADDRESS_VERSIONS.testnet);
        assert.strictEqual(typeof r, 'object', 'the shape changed; the guard must be revisited');
        assert.strictEqual(r.ok, false);
        assert.ok(!(!r), 'the rejected result is truthy -- `if (!validateAddress(..))` never fires');
    });

    await test('garbage is rejected without touching Redis', async () => {
        let redisTouched = false;
        const api = make();
        api.shares = { async getMinerStats() { redisTouched = true; return {}; } };

        for (const bad of ['1', '../../etc/passwd', 'x'.repeat(4000), '%00', 'null']) {
            const res = fakeRes();
            await api._api('/api/miner', new URLSearchParams({ address: bad }), res);
            assert.strictEqual(res.code, 400, `'${bad.slice(0, 20)}' was not rejected`);
        }
        assert.strictEqual(redisTouched, false,
            'an invalid address still reached the share processor');
    });

    await test('a rejected address leaves no cache entry behind', async () => {
        const api = make();
        api.shares = { async getMinerStats() { return {}; } };
        const before = api.cache.size;
        for (let i = 0; i < 500; i++) {
            await api._api('/api/miner', new URLSearchParams({ address: `junk${i}` }), fakeRes());
        }
        assert.strictEqual(api.cache.size, before,
            `${api.cache.size - before} entries were created by addresses that were refused`);
    });

    await test('a missing address is still a 400, not a crash', async () => {
        const api = make();
        const res = fakeRes();
        await api._api('/api/miner', new URLSearchParams(), res);
        assert.strictEqual(res.code, 400);
    });

    console.log('\n=== and the rate the cache said nothing about ===');

    /** One GET through the real entry point, from one address. */
    function get(api, url, ip, headers = {}) {
        const res = fakeRes();
        const req = { method: 'GET', url, headers, socket: { remoteAddress: ip } };
        return api._handle(req, res).then(() => res);
    }

    await test('a dashboard on a timer is not throttled', async () => {
        // 240 a minute is four a second. A page polling /api/stats every five
        // seconds uses twelve, and the limit must not be the thing that
        // breaks a pool's own front page.
        const api = make({ apiRequestsPerMinute: 240, apiLookupsPerMinute: 30 });
        api._stats = async () => ({ ok: true });
        let throttled = 0;
        for (let i = 0; i < 100; i++) {
            const res = await get(api, '/api/stats', '203.0.113.9');
            if (res.code === 429) throttled++;
        }
        assert.strictEqual(throttled, 0,
            `${throttled} of 100 ordinary requests were refused`);
    });

    await test('walking addresses is refused, and says how long to wait', async () => {
        const api = make({ apiLookupsPerMinute: 5 });
        api.shares = { async getMinerStats() { return { balance: 0 }; } };
        const ADDR = 'twam1qtekdutqnwmqwtsh4rddncxru2s0y3vp5ea7ljs';
        const codes = [];
        for (let i = 0; i < 9; i++) {
            const res = await get(api, `/api/miner?address=${ADDR}`, '203.0.113.9');
            codes.push(res.code);
        }
        assert.ok(codes.includes(429),
            'the lookup endpoint answered nine times in a row at a limit of '
            + 'five: the pool publishes its payment txids and the chain names '
            + 'every recipient, so this endpoint can be walked');
        const last = await get(api, `/api/miner?address=${ADDR}`, '203.0.113.9');
        assert.ok(Number(last.headers['Retry-After']) >= 1,
            'a 429 with no Retry-After tells a legitimate client nothing');
    });

    await test('one caller being refused does not refuse another', async () => {
        const api = make({ apiLookupsPerMinute: 2 });
        api.shares = { async getMinerStats() { return {}; } };
        const ADDR = 'twam1qtekdutqnwmqwtsh4rddncxru2s0y3vp5ea7ljs';
        for (let i = 0; i < 6; i++) await get(api, `/api/miner?address=${ADDR}`, '203.0.113.9');
        const other = await get(api, `/api/miner?address=${ADDR}`, '198.51.100.7');
        assert.notStrictEqual(other.code, 429,
            'the limit is global rather than per caller, so one abuser stops '
            + 'every miner reading their own figures');
    });

    await test('the caller map cannot be grown without limit', async () => {
        // The same defect the response cache had, in the thing defending it.
        const api = make({ apiRateCallers: 64 });
        api._stats = async () => ({});
        for (let i = 0; i < 2000; i++) {
            await get(api, '/api/stats', `198.51.100.${i % 256}:${i}`);
        }
        assert.ok(api.limiter.callers.size <= 64,
            `the limiter remembers ${api.limiter.callers.size} callers with a `
            + 'ceiling of 64');
    });

    await test('behind a proxy the limit follows the forwarded client', async () => {
        const api = make({ apiTrustProxy: true, apiLookupsPerMinute: 2 });
        api.shares = { async getMinerStats() { return {}; } };
        const ADDR = 'twam1qtekdutqnwmqwtsh4rddncxru2s0y3vp5ea7ljs';
        const hdr = (ip) => ({ 'x-forwarded-for': `10.0.0.1, ${ip}` });
        for (let i = 0; i < 6; i++) {
            await get(api, `/api/miner?address=${ADDR}`, '127.0.0.1', hdr('203.0.113.9'));
        }
        const victim = await get(api, `/api/miner?address=${ADDR}`, '127.0.0.1',
                                 hdr('198.51.100.7'));
        assert.notStrictEqual(victim.code, 429,
            'every request arrives from the proxy, so one caller throttled '
            + 'the whole pool');
    });

    await test('behind a proxy it does not trust, it limits nobody', async () => {
        // THIS IS THE CASE THAT TOOK THE LIVE DASHBOARD DOWN.
        //
        // The case above proves the limiter works when apiTrustProxy is set.
        // Nothing covered the pool that is behind a proxy and has NOT set
        // it -- which is what pool.wamcoin.org was, because the operator's
        // own config.json never gained the key the shipped
        // config.mainnet.json carries.
        //
        // _caller() returned the socket address, every visitor arrives from
        // 127.0.0.1 through nginx, and the whole internet shared one
        // bucket. The dashboard's own page exhausted it and the site showed
        // "API unreachable: /api/miners -> HTTP 429", flickering red and
        // green as the window refilled. Every reader throttled every other
        // reader, and the busier the pool was the worse it got.
        //
        // Callers that cannot be told apart must not be limited as though
        // they were one. Measured on the live site, 19 November 2026.
        const api = make({ apiLookupsPerMinute: 2 });   // no apiTrustProxy
        api.shares = { async getMinerStats() { return {}; } };
        const ADDR = 'twam1qtekdutqnwmqwtsh4rddncxru2s0y3vp5ea7ljs';
        const codes = [];
        for (let i = 0; i < 10; i++) {
            const res = await get(api, `/api/miner?address=${ADDR}`, '127.0.0.1',
                                  { 'x-forwarded-for': `203.0.113.${i}` });
            codes.push(res.code);
        }
        assert.ok(!codes.includes(429),
            `ten visitors behind one proxy got ${codes.join(',')}. They are `
            + 'ten different people and the pool cannot tell them apart, so '
            + 'it counted them as one and refused them for each other');
    });

    await test('and with nothing in front of it, it still limits', async () => {
        // The other direction: a pool reached directly must still be
        // protected. A fix that turns the limiter off everywhere is not a
        // fix.
        const api = make({ apiLookupsPerMinute: 2 });
        api.shares = { async getMinerStats() { return {}; } };
        const ADDR = 'twam1qtekdutqnwmqwtsh4rddncxru2s0y3vp5ea7ljs';
        let refused = false;
        for (let i = 0; i < 8; i++) {
            const res = await get(api, `/api/miner?address=${ADDR}`, '203.0.113.9');
            if (res.code === 429) refused = true;
        }
        assert.ok(refused,
            'one caller with no proxy in the way was never throttled, so the '
            + 'limiter protects nothing at all');
    });

    await test('a forged forwarded header cannot shed the real client', async () => {
        // nginx APPENDS the real client, so the last entry is the one it
        // wrote. A client may prepend as many lies as it likes.
        const api = make({ apiTrustProxy: true, apiLookupsPerMinute: 2 });
        api.shares = { async getMinerStats() { return {}; } };
        const ADDR = 'twam1qtekdutqnwmqwtsh4rddncxru2s0y3vp5ea7ljs';
        let refused = false;
        for (let i = 0; i < 8; i++) {
            const res = await get(api, `/api/miner?address=${ADDR}`, '127.0.0.1',
                { 'x-forwarded-for': `1.2.3.${i}, 203.0.113.9` });
            if (res.code === 429) refused = true;
        }
        assert.ok(refused,
            'a different first hop on every request was enough to get a fresh '
            + 'budget each time');
    });

    await test('no CORS header unless the operator configured one', async () => {
        const api = make();
        api._stats = async () => ({});
        const res = await get(api, '/api/stats', '203.0.113.9');
        assert.strictEqual(res.headers['Access-Control-Allow-Origin'], undefined,
            'a wildcard CORS header lets any page a miner visits read this '
            + 'API through their browser and from their address');

        const open = make({ apiCorsOrigin: 'https://example.org' });
        open._stats = async () => ({});
        const res2 = await get(open, '/api/stats', '203.0.113.9');
        assert.strictEqual(res2.headers['Access-Control-Allow-Origin'],
                           'https://example.org',
            'a configured origin is no longer sent, which breaks a front end '
            + 'that needs it');
    });

    console.log('\n' + '='.repeat(66));
    if (fail.length === 0) {
        console.log(`\x1b[32m${pass} passed\x1b[0m`);
    } else {
        console.log(`\x1b[31m${fail.length} failed\x1b[0m, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
    }
    console.log('='.repeat(66));
    process.exit(fail.length === 0 ? 0 : 1);
})();
