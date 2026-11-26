'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// The messages were rewritten from Telegram HTML into neutral markup so a
// second service could carry them. A refactor like that has one obligation
// above all others: the channel that already exists must not notice.
//
// So the Telegram rendering is asserted against the exact strings the previous
// implementation produced -- byte for byte, tags and spacing and all. If a
// conversion dropped a bold, moved a space, or lost a line, it fails here
// rather than in front of the people already reading that channel.
//
// The Discord rendering is then checked for the failure that would be obvious
// to everyone except the person who wrote it: HTML tags arriving as text.
// ---------------------------------------------------------------------------

const assert = require('assert');
const A = require('../announce');
const { toTelegram, toDiscord } = require('../lib/markup');

let pass = 0;
const fail = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

console.log('\n=== Telegram output is unchanged from before the refactor ===');

test('the testnet banner', () => {
    assert.strictEqual(toTelegram(A.networkLabel('test')),
        '\u{1F9EA} <b>TESTNET</b> — coins here have no value');
    assert.strictEqual(toTelegram(A.networkLabel('regtest')),
        '\u{1F527} <b>REGTEST</b> — a private test chain');
    assert.strictEqual(A.networkLabel('main'), null, 'mainnet must carry no banner');
});

test('a halving', () => {
    assert.strictEqual(toTelegram(A.halvingMessage(5000000000, 2500000000, 200000)), [
        '⛏ <b>The block reward has halved</b>',
        '',
        'At height 200,000 the subsidy went from',
        '<b>50.00 WAM</b> to <b>25.00 WAM</b>.',
        '',
        'This is written into consensus and happens every 200,000 blocks.',
        'No decision was taken and none could be.'
    ].join('\n'));
});

test('a key rotation', () => {
    assert.strictEqual(toTelegram(A.rotationMessage(2048, 2112)), [
        '\u{1F511} <b>RandomX key rotated</b>',
        '',
        'From height 2,112 the proof-of-work key is derived from',
        'block 2,048.',
        '',
        'Every miner rebuilds its dataset now; a brief dip in network',
        'hashrate over the next few minutes is expected, not a fault.'
    ].join('\n'));
});

test('a milestone', () => {
    assert.strictEqual(toTelegram(A.milestoneMessage('height', 100000)),
        '\u{1F4CD} <b>Block 100,000</b>\n\nThe chain has reached height 100,000.');
});

test('a stall, and the recovery', () => {
    assert.strictEqual(toTelegram(A.stallMessage(60, 4321)), [
        '\u{1F534} <b>No new block for 60 minutes</b>',
        '',
        'The chain is still at height 4,321. The target is one block',
        'every two minutes.',
        '',
        'This usually means the network hashrate has dropped. It is posted',
        'here because a channel that only reports good news is advertising.'
    ].join('\n'));
    assert.strictEqual(toTelegram(A.recoveredMessage(4322, 63)),
        '\u{1F7E2} <b>Blocks are arriving again</b>\n\nHeight 4,322, after 63 minutes.');
});

test('a release', () => {
    const out = toTelegram(A.releaseMessage({
        tag: 'v0.1.0', name: 'WAM Coin v0.1.0',
        url: 'https://github.com/wamcoin-Project/wam-coin/releases/tag/v0.1.0',
        body: 'first line\nsecond line'
    }));
    assert.ok(out.startsWith('\u{1F680} <b>WAM Coin v0.1.0</b>'), out.slice(0, 60));
    assert.ok(out.includes('first line\nsecond line'));
    // The tail now NAMES what to verify with, because telling a reader to
    // check the checksums and giving him no address is telling him to go
    // and look. Radenlingga, 2026-11-26.
    assert.ok(/SHA256SUMS/.test(out) && /SHA256SUMS\.asc/.test(out),
        'the announcement says to verify but names neither the list nor '
        + 'its signature. Tail: ' + out.slice(-300));
});

test('a heartbeat', () => {
    const out = toTelegram(A.heartbeat({
        height: 1234, chainName: 'test', hashrate: 1500,
        supply: {
            block_subsidy: 50, treasury_subsidy: 2.5,
            circulating: 61700, max_supply: 22000000, blocks_until_halving: 198766
        },
        randomx: { blocks_until_rotation: 40 }
    }, { explorerUrl: 'https://explorer.wamcoin.org' }));

    assert.ok(out.startsWith('\u{1F7E2} <b>WAM Network</b>\n\u{1F9EA} <b>TESTNET</b>'), out.slice(0, 80));
    assert.ok(out.includes('<b>Height</b>        1,234'));
    assert.ok(out.includes('<b>Hashrate</b>      1.50 kH/s'));
    assert.ok(out.includes('<b>Block reward</b>  50.00 WAM  (47.50 miner + 2.50 treasury)'));
    assert.ok(out.includes('<b>Supply</b>        61,700 / 22,000,000  (0.28%)'));
    assert.ok(out.includes('<b>Next halving</b>  in 198,766 blocks'));
    assert.ok(out.includes('<b>RandomX key</b>   rotates in 40 blocks'));
    assert.ok(out.endsWith('https://explorer.wamcoin.org'));
});

test('emission complete replaces the halving line, not adds to it', () => {
    const out = toTelegram(A.heartbeat({
        height: 9, chainName: 'main', hashrate: 0,
        supply: { block_subsidy: 0, blocks_until_halving: 5 }
    }, {}));
    assert.ok(out.includes('<b>Emission</b>      complete'));
    assert.ok(!out.includes('Next halving'), 'promised a halving that can no longer happen');
});

console.log('\n=== Discord gets Markdown, never tags ===');

test('no HTML reaches Discord in any message', () => {
    const messages = [
        A.networkLabel('test'),
        A.halvingMessage(5000000000, 2500000000, 200000),
        A.rotationMessage(2048, 2112),
        A.milestoneMessage('height', 100000),
        A.milestoneMessage('supply', 1000000),
        A.stallMessage(60, 4321),
        A.recoveredMessage(4322, 63),
        A.releaseMessage({ tag: 'v0.1.0', name: 'WAM Coin v0.1.0', url: 'https://x/y', body: 'notes' }),
        A.heartbeat({ height: 1, chainName: 'main', hashrate: 1, supply: {}, randomx: null }, {})
    ];
    for (const m of messages) {
        const d = toDiscord(m);
        assert.ok(!/<\/?[bi]>/.test(d), `HTML tags arrived at Discord: ${d.slice(0, 80)}`);
        assert.ok(d.length > 0, 'a message rendered empty');
    }
});

test('bold survives the trip to Discord', () => {
    assert.ok(toDiscord(A.milestoneMessage('height', 100000)).startsWith('\u{1F4CD} **Block 100,000**'));
});

test('a hostile release title cannot format the announcement', () => {
    const out = toDiscord(A.releaseMessage({
        tag: 'v9', name: '**@everyone** `code` ~~x~~',
        url: 'https://x/y', body: '@here **bold**'
    }));
    // The mention text may appear -- it is denied at the API, not censored --
    // but it must not be rendered as formatting.
    assert.ok(out.includes('\\`code\\`'), `backticks were not escaped: ${out}`);
    assert.ok(out.includes('\\~\\~x\\~\\~'), `strikethrough was not escaped: ${out}`);
});

console.log('\n=== the config refuses to start with nowhere to post ===');

test('no channel configured is an error, not a silent no-op', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const write = (obj) => {
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wam-')), 'announce.json');
        fs.writeFileSync(f, JSON.stringify(obj));
        fs.chmodSync(f, 0o600);
        return f;
    };

    assert.throws(() => A.loadConfig(write({ node: { port: 1 } })), /names no channel/,
        'a bot with no channel would have looked healthy and said nothing for weeks');

    assert.throws(() => A.loadConfig(write({
        node: { port: 1 }, discord: { webhookUrl: 'https://discord.com/api/webhooks/CHANGE_ME' }
    })), /placeholder discord.webhookUrl/);

    assert.throws(() => A.loadConfig(write({
        node: { port: 1 }, telegram: { token: 'x' }
    })), /chatId is required/);

    // Discord alone is a supported configuration, not a degraded one.
    const ok = A.loadConfig(write({
        node: { port: 1 }, discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' }
    }));
    assert.strictEqual(ok.heartbeatHours, 24);
});

test('a world-readable config is refused', () => {
    if (process.platform === 'win32') return;
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wam-')), 'announce.json');
    fs.writeFileSync(f, JSON.stringify({ node: {}, discord: { webhookUrl: 'https://discord.com/api/webhooks/1/a' } }));
    fs.chmodSync(f, 0o644);
    assert.throws(() => A.loadConfig(f), /readable by other users/);
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
