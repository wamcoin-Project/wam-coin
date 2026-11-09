'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// What the network looks like from here.
//
// The pool dashboard answers "is anyone mining with me". This answers a
// different and, at launch, a more important question: is this a network, or
// one person's laptop? The measure of that is not hashrate -- it is how many
// independent machines validate the chain for themselves, because a node
// operator is someone who has chosen not to trust anybody, including us.
//
// WHAT IS NOT PUBLISHED, AND WHY
//
// No addresses. Not truncated, not hashed, not "just the first two octets".
// Someone running a WAM node is doing us a favour, and publishing where they
// are turns that into a target list -- for a denial-of-service, for an eclipse
// attempt, or for whoever objects to the software in their country. The one
// thing this page exists to celebrate is the one thing it must not expose.
//
// No geolocation either, which was the original plan. Resolving a country
// means sending every peer's address to a third-party service, which is the
// same disclosure wearing a different coat. Our own seeds are the exception:
// their addresses are already in public DNS, we chose to publish them, and
// nobody else's privacy is ours to spend.
//
// What is left -- counts, versions, direction, how long connections have held
// -- is enough to see the network grow and gives an observer nothing to aim at.
// ---------------------------------------------------------------------------

// Our own seeds. Published in DNS already, so naming them costs nobody
// anything and lets a reader see the network is not all in one place.
const OWN_SEEDS = {
    '169.58.159.165': { label: 'seed', where: 'Germany' },
    '5.223.52.200':   { label: 'seed', where: 'Singapore' }
};

/**
 * Split "host:port" into the host, for the three shapes a peer address takes.
 *
 * Getting this wrong is not cosmetic: an onion address carries a port too, so
 * testing the whole string for a .onion suffix never matches and every Tor
 * peer is silently counted as IPv4 -- which would misreport the one statistic
 * that says whether anyone values their privacy on this network.
 */
function hostOf(addr) {
    const s = String(addr || '');
    if (s.startsWith('[')) return s.slice(1).split(']')[0];   // [2001:db8::1]:19555
    const colons = (s.match(/:/g) || []).length;
    if (colons > 1) return s;                                  // bare IPv6, no port
    return s.split(':')[0];                                    // 1.2.3.4:19555, x.onion:19555
}

/** Reduce an address to something countable but not locatable. */
// ---------------------------------------------------------------------------
// Who is on this network, as opposed to who is connected this second.
//
// The founder watches the versions panel daily and asked the question it
// could not answer: when the counts shift -- two on v0.1.4, then one on
// v0.1.6, then one on v0.1.5 -- is that one operator changing version, or
// different people arriving and leaving? A count of versions cannot tell
// them apart, and the difference decides whether anyone forks off on 15
// September.
//
// So machines are remembered, not addresses. Each peer's address is hashed
// and truncated before anything is written down: the file on disk holds no
// address, this module never returns one, and the panel shows counts. A
// list of who runs a node is a list of who can be attacked, and it is not
// ours to publish or to keep.
//
// Persisted because the explorer restarts on every deploy, and a memory
// that resets every deploy would answer the same question the peer list
// already answers badly.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SEEN_FILE = process.env.WAM_SEEN_FILE
    || path.join(process.env.WAM_STATE_DIR || '/var/lib/wam-explorer', 'seen.json');
const SEEN_WINDOW_SEC = 7 * 24 * 3600;

let seenCache = null;

// The network an address sits in, not the address.
//
// This page said eight machines had been on the network in seven days. Six
// of those eight were one laptop on a home line that changes its last octet
// -- 41.254.73.4, .29, .35, .68, .85, .97 -- and it belongs to the founder.
// Counting addresses counted his router's mood as seven strangers, on a
// public page whose entire purpose is to answer "is this a real network or
// one person's laptop" honestly.
//
// Keyed on the /24 (or the IPv6 /64, which is what a subscriber is given),
// that laptop is one machine. Two operators behind the same /24 would count
// as one, which is rare and errs downward -- and a page about
// decentralisation should undercount itself, never the reverse.
//
// THE /64 CANNOT BE READ OFF THE TEXT. This took `host.split(':').slice(0, 4)`
// for a while, which is only the first four groups when the address has no
// `::` inside them. Write `2001:db8::1` and `2001:db8::abcd` -- one host and
// its neighbour in the same /64, because `::` stands for the zero groups in
// between -- and the slice gives `2001:db8::1` and `2001:db8::abcd`. Two
// machines, from one subscriber. That is the error this page cannot make:
// it exists to undercount itself, and a compressed prefix made it overcount.
// So expand first, then cut at the fourth hextet.
function expandIPv6(host) {
    let text = String(host || '').toLowerCase().split('%')[0];
    if (!text.includes(':')) return null;

    // An embedded IPv4 tail (::ffff:192.0.2.1) is the last two hextets.
    const lastColon = text.lastIndexOf(':');
    const tail = text.slice(lastColon + 1);
    if (tail.includes('.')) {
        const octets = tail.split('.').map(Number);
        if (octets.length !== 4 ||
            octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
            return null;
        }
        const hi = ((octets[0] << 8) | octets[1]).toString(16);
        const lo = ((octets[2] << 8) | octets[3]).toString(16);
        text = text.slice(0, lastColon + 1) + hi + ':' + lo;
    }

    const halves = text.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const groups = [...left, ...right];
    if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;

    if (halves.length === 2) {
        // `::` must stand for at least one zero group.
        if (groups.length > 7) return null;
        const zeros = new Array(8 - groups.length).fill('0');
        return [...left, ...zeros, ...right].map((g) => g.padStart(4, '0'));
    }
    return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')) : null;
}

function networkOf(host) {
    if (host.includes(':')) {
        const groups = expandIPv6(host);
        // An unparseable address is hashed as written rather than dropped.
        return groups ? groups.slice(0, 4).join(':') + '::/64' : host;
    }
    const p = host.split('.');
    return p.length === 4 ? p.slice(0, 3).join('.') + '.0/24' : host;
}

function machineId(addr) {
    // hostOf() already knows the three shapes a peer address takes; the old
    // inline version stripped `:\d+$` from the whole string, which is also
    // how a bare IPv6 address ends, so `2001:db8::1` became `2001:db8:`.
    // Two neighbours collided there for the wrong reason, and a hextet that
    // was not all digits did not collide at all.
    return crypto.createHash('sha256').update(networkOf(hostOf(addr)))
        .digest('hex').slice(0, 16);
}

function loadSeen() {
    if (seenCache) return seenCache;
    try {
        seenCache = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    } catch { seenCache = {}; }
    return seenCache;
}

function saveSeen(data) {
    try {
        fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
        // Written to a temporary name and renamed, so a crash mid-write
        // cannot leave a half-file that parses as an empty history.
        const tmp = SEEN_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(tmp, SEEN_FILE);
    } catch { /* a dashboard must not fall over because a cache is unwritable */ }
}

function rememberVersions(list) {
    const now = Math.floor(Date.now() / 1000);
    const seen = loadSeen();

    for (const p of list) {
        if (!p.subver) continue;
        const id = machineId(p.addr);
        const rec = seen[id] || (seen[id] = { v: {}, last: 0 });
        rec.v[p.subver] = now;
        rec.last = now;
    }

    for (const [id, rec] of Object.entries(seen)) {
        if (now - (rec.last || 0) > SEEN_WINDOW_SEC) { delete seen[id]; continue; }
        for (const [v, t] of Object.entries(rec.v)) {
            if (now - t > SEEN_WINDOW_SEC) delete rec.v[v];
        }
    }

    saveSeen(seen);
    return seen;
}

function summariseSeen(seen, connectedNow) {
    const now = Math.floor(Date.now() / 1000);
    const machines = Object.values(seen);
    const byVersion = new Map();
    let movers = 0;

    for (const rec of machines) {
        const vs = Object.keys(rec.v);
        if (vs.length > 1) movers++;
        for (const v of vs) {
            const e = byVersion.get(v) || { version: v, machines: 0, lastSeen: 0 };
            e.machines++;
            e.lastSeen = Math.max(e.lastSeen, rec.v[v]);
            byVersion.set(v, e);
        }
    }

    return {
        windowDays: SEEN_WINDOW_SEC / 86400,
        machines: machines.length,
        // Machines that have appeared under more than one version string.
        // This is the answer to "is it one person moving, or several
        // people": if it is zero, every version belongs to a different
        // machine.
        changedVersion: movers,
        versions: [...byVersion.values()]
            .map((e) => ({
                version: e.version,
                machines: e.machines,
                ageSeconds: now - e.lastSeen,
                connectedNow: connectedNow.has(e.version)
            }))
            .sort((a, b) => a.ageSeconds - b.ageSeconds)
    };
}

function classify(addr) {
    const host = hostOf(addr);
    if (OWN_SEEDS[host]) return { kind: 'seed', ...OWN_SEEDS[host], host };
    if (/\.onion$/i.test(host)) return { kind: 'onion' };
    if (host.includes(':')) return { kind: 'ipv6' };
    return { kind: 'ipv4' };
}

/**
 * Build the public view.
 *
 * `peers` is getpeerinfo. `known` is getnodeaddresses, and `addrman` is
 * getaddrmaninfo.
 *
 * THE TWO ARE NOT THE SAME NUMBER, and this panel claimed they were until
 * 2026-09-14. The founder said the figure looked false because it moved --
 * 9, then 7, then 6 -- and he was right to distrust it. Measured on the
 * Germany node at one moment:
 *
 *     getaddrmaninfo   ipv4 new 8 + tried 2, ipv6 new 1   =  11
 *     getnodeaddresses 0                                  =   6
 *
 * getnodeaddresses is what the node is willing to GOSSIP: Core filters out
 * addresses it currently considers terrible -- recently failed, too many
 * attempts, too old -- so its verdict on the same address changes as those
 * timestamps change, with nobody joining or leaving. On a network of six
 * machines each flip is a visible jump.
 *
 * So `known` is now labelled for what it is, and `bookTotal` carries the
 * address book. Neither is a census: a book does not forget quickly and a
 * gossip list is a filtered sample. The number that actually falls when a
 * node goes away is knownRecent, below.
 */
function build(peers, known, netInfo, addrman) {
    const list = Array.isArray(peers) ? peers : [];

    // Keyed by place, not by connection. Two nodes routinely hold a pair of
    // connections to each other -- one dialled each way -- and listing
    // "Singapore, Singapore" makes one seed look like two, which is the
    // opposite of what a page about decentralisation should do.
    //
    // This counts seeds among this node's PEERS, so it can never include the
    // machine it runs on. Served from the Germany seed it reports Singapore
    // and nothing else, and the page used to label that "WAM seed nodes: 1"
    // -- which a reader takes as "this network has one seed", a single point
    // of failure, when there are two.
    //
    // The label now reads "other WAM seeds reached", so the number means what
    // it counts. Do not make it self-aware instead: a node deciding whether
    // it is itself a seed is a guess, and a wrong guess here overstates the
    // network rather than understating it.
    const seedsByPlace = new Map();
    const counts = { ipv4: 0, ipv6: 0, onion: 0, seed: 0 };
    const versions = new Map();
    let inbound = 0;
    let longest = 0;

    // Remember which versions have been seen, not only which are connected.
    //
    // The founder watches this panel daily and had followed one operator on
    // v0.1.4 for weeks. On 2026-08-30 the panel showed only v0.1.6 for
    // hours, which was true and read as "he is gone" -- while that node had
    // completed a handshake three and a half hours earlier and was simply
    // intermittent. The same blind spot was in check_peer_versions.py and
    // was fixed there the same day: a panel that answers "who is here at
    // this instant" cannot answer "who is on this network", and those are
    // different questions with different consequences on 15 September.
    rememberVersions(list);

    for (const p of list) {
        const c = classify(p.addr);
        counts[c.kind] = (counts[c.kind] || 0) + 1;

        if (c.kind === 'seed') {
            const held = p.conntime
                ? Math.max(0, Math.floor(Date.now() / 1000 - p.conntime)) : null;
            const prev = seedsByPlace.get(c.where);
            seedsByPlace.set(c.where, {
                where: c.where,
                connections: (prev ? prev.connections : 0) + 1,
                version: p.subver || (prev ? prev.version : null),
                // The longest-held of the pair: how long this link has
                // actually stood, not how long its newest strand has.
                connectedSeconds: Math.max(prev ? prev.connectedSeconds || 0 : 0, held || 0)
            });
        }

        if (p.inbound) inbound++;
        if (p.subver) versions.set(p.subver, (versions.get(p.subver) || 0) + 1);

        const held = p.conntime ? Math.floor(Date.now() / 1000 - p.conntime) : 0;
        if (held > longest) longest = held;
    }

    const history = summariseSeen(loadSeen(), new Set(versions.keys()));
    const nowSec = Math.floor(Date.now() / 1000);

    return {
        // Connected right now, from this node's point of view. A node behind a
        // home router shows as inbound here because it dialled out to us --
        // which is why "inbound" is not the same as "someone else's server".
        connected: list.length,
        inbound,
        outbound: list.length - inbound,

        // Who has been on this network over the past week, which is a
        // different question from who is on it this second and the one that
        // actually decides whether anybody forks off on 15 September.
        //
        // machines        distinct machines seen, by hashed address
        // changedVersion  how many of them have appeared under more than one
        //                 version string. Zero means every version belongs to
        //                 a different machine; anything else means at least
        //                 one operator has been changing versions, which is
        //                 the question a count of versions cannot answer.
        history,

        // Addresses this node has learned of, whether or not it has ever
        // spoken to them. The closest thing to a network size we can report
        // without crawling, and it does not require anyone to be online now.
        //
        // It is also the number most easily misread, and was misread. It
        // went from four to five when a node in Germany appeared, and stayed
        // at five when that node vanished ten hours later -- because an
        // address book does not forget. It also holds this node's own
        // address, self-advertised, and both WAM seeds. So the count alone
        // says almost nothing about how many machines are up, and the page
        // now carries the two numbers that do.
        known: Array.isArray(known) ? known.length : null,

        // The address book, summed across ipv4/ipv6/onion, new + tried. This
        // is the count that does not depend on how Core feels about each
        // address this minute.
        bookTotal: addrman && typeof addrman === 'object'
            ? Object.values(addrman).reduce(
                (t, n) => t + ((n && typeof n.total === 'number') ? n.total : 0), 0)
            : null,

        // How many of those have actually been heard from in the last day.
        // This one falls when a node goes away, which is the property the
        // number above does not have. A day, not the seven used for version
        // history: the question here is whether the network is up now, and
        // a week-long window would have gone on counting the French node
        // for six days after it disappeared.
        knownRecent: Array.isArray(known)
            ? known.filter((a) => nowSec - (a.time || 0) <= 86400).length
            : null,
        knownRecentHours: 24,

        // How many of the known addresses are WAM's own machines. Naming
        // them costs nobody anything -- they are in public DNS -- and
        // leaving them silently inside the total is how "five addresses"
        // reads as five strangers.
        knownOwn: Array.isArray(known)
            ? known.filter((a) => OWN_SEEDS[hostOf(a.address)]).length
            : null,

        // Of the peers connected right now, how many are our own seeds. The
        // headline number counts every connection, and on a two-seed network
        // that is mostly us talking to ourselves.
        connectedOwn: counts.seed,

        byType: counts,
        versions: [...versions.entries()]
            .map(([version, count]) => ({ version, count }))
            .sort((a, b) => b.count - a.count),

        // Ours, named, because they are already public. One entry per place.
        seeds: [...seedsByPlace.values()].sort((a, b) => a.where.localeCompare(b.where)),

        longestConnectionSeconds: longest,

        // Said in the payload rather than only in the page, so anyone reading
        // the API sees the policy too.
        privacy: 'Peer addresses are never published. Only WAM\'s own seed nodes, '
               + 'which are already listed in public DNS, are named.'
    };
}

module.exports = { build, classify, OWN_SEEDS, networkOf, machineId };
