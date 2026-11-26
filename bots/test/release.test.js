'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// The release check silently did nothing for the only release that exists.
//
// GitHub's /repos/{repo}/releases/latest excludes pre-releases by design and
// answers 404 when every release is one. This project marks everything below
// 1.0 as a pre-release -- the release workflow does it automatically from the
// version string -- so that endpoint would have answered 404 for the entire
// pre-1.0 life of the project, and not one release would have been announced.
//
// The failure is invisible from the outside: a 404 there is indistinguishable
// from "no releases published yet", which is a legitimate state a bot must
// tolerate quietly. It was found by asking why lastReleaseTag was missing from
// the state file, not by anything going wrong.
// ---------------------------------------------------------------------------

const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

let pass = 0;
const fail = [];

async function test(name, fn) {
    try { await fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

/** Answer the next https.request with this status and body, and record the path. */
function stubGithub(status, body) {
    const seen = {};
    const original = https.request;
    https.request = (opts, cb) => {
        seen.path = opts.path;
        seen.host = opts.host;
        const res = new EventEmitter();
        res.statusCode = status;
        const req = new EventEmitter();
        req.end = () => {
            setImmediate(() => {
                cb(res);
                res.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
                res.emit('end');
            });
        };
        req.destroy = () => {};
        return req;
    };
    return { seen, restore: () => { https.request = original; } };
}

(async () => {
    console.log('\n=== a pre-release is still a release ===');

    await test('the list endpoint is used, not /releases/latest', async () => {
        const g = stubGithub(200, []);
        try {
            delete require.cache[require.resolve('../lib/clients')];
            await require('../lib/clients').latestRelease('a/b');
        } finally { g.restore(); }
        assert.ok(!/\/releases\/latest$/.test(g.seen.path),
            `still calling ${g.seen.path}, which 404s when every release is a pre-release`);
        assert.ok(/\/releases\?/.test(g.seen.path), `unexpected path: ${g.seen.path}`);
    });

    await test('a pre-release is returned and flagged', async () => {
        const g = stubGithub(200, [{
            tag_name: 'v0.1.0', name: 'WAM Coin v0.1.0', html_url: 'https://x/y',
            body: 'notes', prerelease: true, draft: false
        }]);
        let r;
        try {
            delete require.cache[require.resolve('../lib/clients')];
            r = await require('../lib/clients').latestRelease('a/b');
        } finally { g.restore(); }
        assert.ok(r, 'a published pre-release was treated as no release at all');
        assert.strictEqual(r.tag, 'v0.1.0');
        assert.strictEqual(r.prerelease, true, 'the pre-release flag was dropped');
    });

    await test('a stable release is not flagged', async () => {
        const g = stubGithub(200, [{
            tag_name: 'v1.0.0', name: 'v1.0.0', html_url: 'https://x/y',
            body: 'what changed in this release', prerelease: false, draft: false
        }]);
        let r;
        try {
            delete require.cache[require.resolve('../lib/clients')];
            r = await require('../lib/clients').latestRelease('a/b');
        } finally { g.restore(); }
        assert.strictEqual(r.prerelease, false);
    });

    await test('drafts are skipped in favour of the newest published one', async () => {
        const g = stubGithub(200, [
            { tag_name: 'v0.2.0-draft', draft: true, prerelease: true, html_url: 'x', body: '' },
            { tag_name: 'v0.1.0', draft: false, prerelease: true, html_url: 'y', body: '' }
        ]);
        let r;
        try {
            delete require.cache[require.resolve('../lib/clients')];
            r = await require('../lib/clients').latestRelease('a/b');
        } finally { g.restore(); }
        assert.strictEqual(r.tag, 'v0.1.0', 'an unpublished draft was announced');
    });

    console.log('\n=== the quiet failures stay quiet ===');

    await test('no releases yet is null, not an error', async () => {
        const g = stubGithub(200, []);
        let r;
        try {
            delete require.cache[require.resolve('../lib/clients')];
            r = await require('../lib/clients').latestRelease('a/b');
        } finally { g.restore(); }
        assert.strictEqual(r, null);
    });

    await test('rate limiting is null, not a crash', async () => {
        const g = stubGithub(403, { message: 'API rate limit exceeded' });
        let r;
        try {
            delete require.cache[require.resolve('../lib/clients')];
            r = await require('../lib/clients').latestRelease('a/b');
        } finally { g.restore(); }
        assert.strictEqual(r, null, 'a GitHub outage must never stop the chain announcements');
    });

    await test('a non-array body does not throw', async () => {
        const g = stubGithub(200, { message: 'Not Found' });
        let r;
        try {
            delete require.cache[require.resolve('../lib/clients')];
            r = await require('../lib/clients').latestRelease('a/b');
        } finally { g.restore(); }
        assert.strictEqual(r, null);
    });

    console.log('\n=== the announcement says which kind it is ===');

    await test('a pre-release announcement says so', () => {
        const { toTelegram } = require('../lib/markup');
        const A = require('../announce');
        const out = toTelegram(A.releaseMessage({
            tag: 'v0.1.0', name: 'WAM Coin v0.1.0', url: 'https://x/y',
            body: 'notes', prerelease: true
        }));
        // The wording this asserted until 2026-09-24 was "Pre-release --
        // testnet software", which stopped being true the moment mainnet
        // started and was then announced to every channel on three releases.
        // GitHub's flag means pre-1.0 and nothing about which chain is live.
        assert.ok(out.includes('<i>Pre-1.0 — the chain is live, the software is still young.</i>'),
            `a pre-release was announced as though it were stable:\n${out}`);
        assert.ok(!/testnet/i.test(out),
            `a mainnet release was announced as testnet software:\n${out}`);
    });

    await test('a stable release carries no such line', () => {
        const { toTelegram } = require('../lib/markup');
        const A = require('../announce');
        const out = toTelegram(A.releaseMessage({
            tag: 'v1.0.0', name: 'v1.0.0', url: 'https://x/y', body: 'what changed in this release', prerelease: false
        }));
        assert.ok(!out.includes('Pre-release'), out);
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
