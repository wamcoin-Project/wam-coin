'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// The network page must never publish a peer's address.
//
// Someone running a WAM node is doing the project a favour. Publishing where
// they are turns that into a target list -- for a denial of service, for an
// eclipse attempt, or for whoever objects to the software where they live.
// The page exists to show that the network is more than one machine; it must
// not do so at the expense of the people who make that true.
//
// So the whole output is searched for anything that looks like an address,
// with a single exception: our own seeds, whose addresses are already in
// public DNS because we chose to put them there.
//
// A test that checks specific fields would pass while a future field leaks.
// This searches the serialised payload, so it fails whatever route the leak
// takes.
// ---------------------------------------------------------------------------

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('../lib/network');

let pass = 0;
const fail = [];

// A fresh copy of the module over its own state directory, which is how a
// second installation -- or the same one after a deploy -- is modelled. The
// salt is read once per process, so the cache entry has to go with it.
const strays = [];

function run(addrs, dir, saltFile) {
    const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'wam-seen-'));
    if (!dir) strays.push(d);
    const keep = [process.env.WAM_SEEN_FILE, process.env.WAM_SEEN_SALT];
    process.env.WAM_SEEN_FILE = path.join(d, 'seen.json');
    process.env.WAM_SEEN_SALT = saltFile || path.join(d, 'seen.salt');
    const where = require.resolve('../lib/network');
    delete require.cache[where];
    try {
        return require(where).machineId(addrs[0]);
    } finally {
        delete require.cache[where];
        if (keep[0] === undefined) delete process.env.WAM_SEEN_FILE;
        else process.env.WAM_SEEN_FILE = keep[0];
        if (keep[1] === undefined) delete process.env.WAM_SEEN_SALT;
        else process.env.WAM_SEEN_SALT = keep[1];
    }
}

process.on('exit', () => {
    for (const d of strays) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* going away */ }
    }
});

function test(name, fn) {
    try { fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

const now = () => Math.floor(Date.now() / 1000);

const PEERS = [
    { addr: '169.58.159.165:19555', inbound: false, subver: '/WAM:0.1.0/', conntime: now() - 7200 },
    { addr: '5.223.52.200:19555',   inbound: false, subver: '/WAM:0.1.0/', conntime: now() - 3600 },
    { addr: '198.51.100.73:56797',   inbound: true,  subver: '/WAM:0.1.0/', conntime: now() - 600 },
    { addr: '203.0.113.42:19555',   inbound: true,  subver: '/WAM:0.1.0/', conntime: now() - 60 },
    { addr: '[2001:db8::dead]:19555', inbound: true, subver: '/WAM:0.2.0/', conntime: now() - 30 },
    { addr: 'abcdefghijklmnop.onion:19555', inbound: false, subver: '/WAM:0.1.0/', conntime: now() - 10 }
];

console.log('\n=== nothing leaks ===');

test('no third-party address appears anywhere in the payload', () => {
    const out = JSON.stringify(net.build(PEERS, new Array(50), null));
    for (const secret of ['198.51.100.73', '203.0.113.42', '2001:db8::dead',
                          'abcdefghijklmnop.onion']) {
        assert.ok(!out.includes(secret), `payload contains ${secret}`);
    }
});

test('not even a truncated one', () => {
    // "Just the first two octets" is still a location.
    const out = JSON.stringify(net.build(PEERS, [], null));
    for (const prefix of ['41.254', '203.0', '2001:db8']) {
        assert.ok(!out.includes(prefix), `payload contains the prefix ${prefix}`);
    }
});

test('port numbers of third parties do not leak either', () => {
    // A source port plus a timestamp is a correlation handle.
    const out = JSON.stringify(net.build(PEERS, [], null));
    assert.ok(!out.includes('56797'), 'payload contains a peer source port');
});

test('our own seeds ARE named, because their addresses are public DNS', () => {
    const out = net.build(PEERS, [], null);
    const where = out.seeds.map((s) => s.where).sort();
    assert.deepStrictEqual(where, ['Germany', 'Singapore']);
});

test('but even our seeds are named by place, not by address', () => {
    const out = JSON.stringify(net.build(PEERS, [], null));
    assert.ok(!out.includes('169.58.159.165'), 'seed address is in the payload');
    assert.ok(!out.includes('5.223.52.200'), 'seed address is in the payload');
});

test('a seed connected twice is listed once, not twice', () => {
    // Two nodes routinely hold a connection each way, one dialled in each
    // direction. Listing "Singapore, Singapore" makes one seed look like two,
    // on the page whose entire purpose is to report decentralisation
    // honestly. Seen on the live node the first time this ran.
    const both = [
        { addr: '5.223.52.200:19555', inbound: false, subver: '/WAM:0.1.0/', conntime: now() - 3000 },
        { addr: '5.223.52.200:41234', inbound: true,  subver: '/WAM:0.1.0/', conntime: now() - 2900 }
    ];
    const o = net.build(both, [], null);
    assert.strictEqual(o.seeds.length, 1, 'one place, one entry');
    assert.strictEqual(o.seeds[0].connections, 2, 'but both connections counted');
    assert.ok(o.seeds[0].connectedSeconds >= 3000, 'and the longer link is reported');
});

console.log('\n=== the counts are right ===');

test('every peer is counted exactly once', () => {
    const o = net.build(PEERS, [], null);
    const total = o.byType.ipv4 + o.byType.ipv6 + o.byType.onion + o.byType.seed;
    assert.strictEqual(o.connected, PEERS.length);
    assert.strictEqual(total, PEERS.length);
});

test('inbound and outbound add up', () => {
    const o = net.build(PEERS, [], null);
    assert.strictEqual(o.inbound + o.outbound, o.connected);
    assert.strictEqual(o.inbound, 3);
});

test('onion peers are recognised, not counted as ipv4', () => {
    assert.strictEqual(net.classify('abcdefghijklmnop.onion:19555').kind, 'onion');
});

test('ipv6 is recognised, not counted as ipv4', () => {
    assert.strictEqual(net.classify('[2001:db8::1]:19555').kind, 'ipv6');
});

console.log('\n=== one subscriber is one machine ===');

test('two addresses in one /64 are one machine, however they are written', () => {
    // `2001:db8::1` and `2001:db8::abcd` are neighbours in the same /64:
    // `::` stands for the zero groups between. Slicing the text at four
    // groups counted them as two machines, on the page whose whole purpose
    // is to undercount the network rather than overcount it.
    assert.strictEqual(net.machineId('[2001:db8::1]:19555'),
                       net.machineId('[2001:db8::abcd]:19555'));
    assert.strictEqual(net.machineId('[2001:db8::1]:19555'),
                       net.machineId('[2001:db8:0:0:0:0:0:2]:19555'));
});

test('a different /64 is a different machine', () => {
    assert.notStrictEqual(net.machineId('[2001:db8::1]:19555'),
                          net.machineId('[2001:db9::1]:19555'));
});

test('the port is never part of the identity', () => {
    assert.strictEqual(net.machineId('203.0.113.42:19555'),
                       net.machineId('203.0.113.42:56797'));
    assert.strictEqual(net.machineId('[2001:db8::1]:19555'),
                       net.machineId('[2001:db8::1]:19556'));
});

test('an IPv4 /24 is still one machine', () => {
    assert.strictEqual(net.machineId('198.51.100.4:56797'),
                       net.machineId('198.51.100.97:56797'));
    assert.notStrictEqual(net.machineId('198.51.100.4:56797'),
                          net.machineId('41.254.74.4:56797'));
});

test('an unparseable address is still counted, not dropped', () => {
    assert.strictEqual(typeof net.machineId('not-an-address'), 'string');
    assert.strictEqual(net.machineId('not-an-address').length, 16);
});

console.log('\n=== the id cannot be turned back into an address ===');

test('the id is not the bare hash of the /24 anybody can tabulate', () => {
    // THE WHOLE POINT, AND IT WAS MISSING.
    //
    // The id was SHA256(networkOf(host)) truncated, with nothing secret in
    // it. There are 2^24 IPv4 /24 blocks: hashing every one of them and
    // looking an id up in the table takes seconds, so seen.json held the
    // list of networks running a node in an encoding that inverts. The file
    // this module writes is the list it exists to avoid being able to write.
    //
    // Reported 13 November 2026. The guard is this: the id must not be
    // reproducible by anyone who only knows the address.
    const guessable = crypto.createHash('sha256')
        .update(net.networkOf('203.0.113.42')).digest('hex').slice(0, 16);
    assert.notStrictEqual(net.machineId('203.0.113.42:19555'), guessable,
        'the id is SHA256 of the /24 with no secret in it: hash all 2^24 '
        + 'blocks once and seen.json becomes a list of operators');
});

test('two installations give the same address different ids', () => {
    // Two explorers' files cannot be joined, and ours cannot be joined
    // against a table built by anybody else.
    const first = run(['203.0.113.42:19555']);
    const second = run(['203.0.113.42:19555']);
    assert.strictEqual(first.length, 16);
    assert.notStrictEqual(first, second,
        'the same address hashes the same everywhere, so the salt is either '
        + 'absent or shared');
});

test('one installation gives the same id after a restart', () => {
    // The salt is persisted for exactly this: the seven-day memory is the
    // reason this module keeps a file at all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-seen-'));
    const once = run(['203.0.113.42:19555'], dir);
    const twice = run(['203.0.113.42:19555'], dir);
    assert.strictEqual(once, twice,
        'the id changed between two runs over the same state directory, so '
        + 'the week-long memory resets on every deploy');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('an unwritable state directory salts in memory rather than not at all', () => {
    // A read-only filesystem must cost the measurement, never the privacy.
    const missing = path.join(os.tmpdir(),
        'wam-no-such-dir-' + Math.random().toString(36).slice(2), 'deep', 'x');
    const id = run(['203.0.113.42:19555'], null, missing);
    const guessable = crypto.createHash('sha256')
        .update('203.0.113.0/24').digest('hex').slice(0, 16);
    assert.strictEqual(id.length, 16, 'it stopped working instead');
    assert.notStrictEqual(id, guessable,
        'with nowhere to keep a salt it fell back to the hash anyone can '
        + 'tabulate, which is the failure this is about');
});

test('known addresses are reported separately from connected', () => {
    // The honest measure of network size: addresses this node has heard of,
    // whether or not anyone is online right now.
    const o = net.build(PEERS, new Array(137), null);
    assert.strictEqual(o.known, 137);
    assert.notStrictEqual(o.known, o.connected);
});

test('the gossip list and the address book are different numbers', () => {
    // 2026-09-14. The panel printed getnodeaddresses under the label "every
    // address this node has ever heard of", and the founder distrusted it
    // because it moved: 9, then 7, then 6, with nobody joining or leaving.
    // Measured on Germany at one moment: getaddrmaninfo said 11, and
    // getnodeaddresses said 6. Core filters the gossip list by its current
    // opinion of each address; the book does not move for that reason.
    const addrman = {
        ipv4: { new: 8, tried: 2, total: 10 },
        ipv6: { new: 1, tried: 0, total: 1 },
        onion: { new: 0, tried: 0, total: 0 },
        i2p: { new: 0, tried: 0, total: 0 }
    };
    const o = net.build(PEERS, new Array(6), null, addrman);
    assert.strictEqual(o.known, 6, 'known must stay the gossip list');
    assert.strictEqual(o.bookTotal, 11, 'bookTotal must sum addrman totals');
    assert.notStrictEqual(o.known, o.bookTotal);
});

test('a node with no getaddrmaninfo reports no book rather than zero', () => {
    // An older node, or an RPC that failed: null says "not measured", and 0
    // would say "this node knows nobody", which is a different claim.
    const o = net.build(PEERS, new Array(6), null, null);
    assert.strictEqual(o.bookTotal, null);
    assert.strictEqual(o.known, 6);
});

test('versions are tallied', () => {
    const o = net.build(PEERS, [], null);
    const v = Object.fromEntries(o.versions.map((x) => [x.version, x.count]));
    assert.strictEqual(v['/WAM:0.1.0/'], 5);
    assert.strictEqual(v['/WAM:0.2.0/'], 1);
});

console.log('\n=== it survives a node that answers badly ===');

for (const [label, peers, known] of [
    ['no peers at all', [], []],
    ['null from the RPC', null, null],
    ['a peer with no addr', [{ inbound: true }], []],
    ['a peer with no conntime', [{ addr: '198.51.100.1:19555', inbound: true }], []]
]) {
    test(`${label} does not throw`, () => {
        const o = net.build(peers, known, null);
        assert.ok(typeof o.connected === 'number');
    });
}

console.log('\n' + '='.repeat(66));
if (fail.length === 0) {
    console.log(`\x1b[32m${pass} passed\x1b[0m`);
} else {
    console.log(`\x1b[31m${fail.length} failed\x1b[0m, ${pass} passed`);
    fail.forEach((f) => console.log(`  - ${f}`));
}
console.log('='.repeat(66));
process.exit(fail.length === 0 ? 0 : 1);
