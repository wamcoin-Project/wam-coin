'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  seeds.js -- how many DNS seeds this network has, and how many answer
// ===========================================================================
//
//  WHY THIS EXISTS
//
//  The network panel used to count seeds among this node's peers, which can
//  never include the machine it runs on. Served from the Germany seed it saw
//  Singapore and nothing else, and the page said "WAM seed nodes: 1" -- read
//  by a visitor as a network with a single point of failure, when there were
//  two.
//
//  Relabelling it "other WAM seeds reached" made the number honest, and left
//  the question a visitor actually has unanswered: how many seeds does this
//  network have, and are they up?
//
//  So this asks DNS, which is the same thing a new node asks before it has
//  any peers at all. No self-knowledge is involved and nothing is guessed: a
//  seed either resolves and accepts a connection or it does not.
//
//  WHY THE ADDRESSES ARE COUNTED AND NOT THE NAMES
//
//  seed1, seed2 and seed3 all resolve to every machine we run. Three names
//  on two hosts is not three seeds, and a page about decentralisation that
//  counted names would be flattering itself. Distinct addresses that answer
//  is the number that means something, and this paragraph promised it would
//  become 3 on its own the day a third machine existed, with no code change.
//
//  Half of that was true. US-east arrived and the count did move to 3 by
//  itself -- and the page then read "3 WAM seed nodes / Germany · Singapore",
//  because PLACES below is a hand-written map and nobody added the row. The
//  count measures the network; the names are copied from ops/ops.py by hand,
//  and the copy drifted. The founder found it by reading his own panel.
//
//  NO ADDRESS IS EVER RETURNED. Only counts and, for our own seeds, the
//  country. A list of who runs a node is a list of who to attack.
// ===========================================================================

const dns = require('dns').promises;
const net = require('net');

// x9 = NODE_NETWORK | NODE_WITNESS. Bitcoin Core asks for a service-bit
// prefix rather than the bare name, and the bare name has no A record at
// all -- checking it would report a working seed as broken.
const PREFIX = 'x9';

const DEFAULT_SEEDS = ['seed1.wamcoin.org', 'seed2.wamcoin.org', 'seed3.wamcoin.org'];

const P2P_PORT = { main: 9555, test: 19555, regtest: 29555 };

// Places we already publish for our own machines. Anything else stays
// unnamed: this is a public page.
const PLACES = {
    '169.58.159.165': 'Germany',
    '5.223.52.200': 'Singapore',
    '13.140.33.187': 'US'
};

function reachable(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            s.destroy();
            resolve(ok);
        };
        s.setTimeout(timeoutMs);
        s.once('connect', () => finish(true));
        s.once('timeout', () => finish(false));
        s.once('error', () => finish(false));
        s.connect(port, host);
    });
}

class Seeds {
    /**
     * @param {object} opts
     *   hostnames  seed names without the x9. prefix
     *   chain      'main' | 'test' | 'regtest', from getblockchaininfo
     *   ttlMs      how long an answer is reused. A seed does not come and go
     *              minute to minute, and a page refresh must not cost a DNS
     *              query and three TCP connects.
     */
    constructor(opts = {}) {
        this.hostnames = opts.hostnames || DEFAULT_SEEDS;
        this.chain = opts.chain || 'test';
        this.ttlMs = opts.ttlMs || 5 * 60 * 1000;
        this.timeoutMs = opts.timeoutMs || 4000;
        this.last = null;
        this.checkedAt = 0;
        this.inFlight = null;
        // Addresses this node says are its own, from getnetworkinfo. They are
        // never probed, for two reasons found by deploying it without them.
        //
        // It proves nothing. A machine connecting to its own public address
        // succeeds over local routing whether or not the port is open to the
        // internet -- so "2 answering" was one real answer and one testimony
        // about itself.
        //
        // And it is noise. Every five minutes the node logged a connection
        // from its own address, opened and closed in the same second with no
        // handshake, straight into the net log that had just been turned on
        // to study visitors.
        //
        // Its own reachability is known anyway: the explorer is reading from
        // it over RPC, and getnetworkinfo says whether it is listening.
        this.selfAddresses = new Set(opts.selfAddresses || []);
    }

    setSelfAddresses(list) {
        this.selfAddresses = new Set(list || []);
    }

    setChain(chain) {
        if (chain && chain !== this.chain) {
            this.chain = chain;
            this.last = null;          // a different port entirely
            this.checkedAt = 0;
        }
    }

    /** The cached answer, refreshing it in the background when stale. */
    snapshot() {
        const age = Date.now() - this.checkedAt;
        if (!this.inFlight && (this.last === null || age > this.ttlMs)) {
            // Deliberately not awaited. The first page load after a restart
            // gets `null`, which the front end renders as an em dash, and the
            // one after it gets the answer. A dashboard that blocks on the
            // network is a dashboard that hangs when the network is the thing
            // that is broken.
            this.inFlight = this.probe()
                .then((r) => { this.last = r; this.checkedAt = Date.now(); })
                .catch(() => { /* keep the previous answer */ })
                .finally(() => { this.inFlight = null; });
        }
        return this.last;
    }

    async probe() {
        const port = P2P_PORT[this.chain] || P2P_PORT.test;

        const byAddress = new Map();     // address -> { names:Set }
        let resolved = 0;

        for (const name of this.hostnames) {
            let addrs = [];
            try {
                addrs = await dns.resolve4(`${PREFIX}.${name}`);
            } catch {
                addrs = [];
            }
            if (addrs.length) resolved += 1;
            for (const a of addrs) {
                if (!byAddress.has(a)) byAddress.set(a, new Set());
                byAddress.get(a).add(name);
            }
        }

        const addresses = [...byAddress.keys()];
        const toProbe = addresses.filter((a) => !this.selfAddresses.has(a));
        const results = await Promise.all(
            toProbe.map((a) => reachable(a, port, this.timeoutMs)));

        const up = [];
        for (let i = 0; i < toProbe.length; i++) {
            if (results[i]) up.push(toProbe[i]);
        }
        // Our own seed is counted as up without being probed: the explorer is
        // talking to that node right now. What is NOT claimed is that it is
        // reachable from outside -- only a machine elsewhere can say that, and
        // check_reachable.sh in the sweep is what asks.
        const self = addresses.filter((a) => this.selfAddresses.has(a));

        return {
            // The numbers that mean something.
            machines: addresses.length,
            answering: up.length + self.length,
            probed: toProbe.length,
            selfNotProbed: self.length,
            // Names are reported only as a count: three names on two machines
            // is a fact about DNS, not about the network.
            hostnames: this.hostnames.length,
            hostnamesResolving: resolved,
            port,
            // Countries for the ones we publish anyway, in a stable order.
            places: [...up, ...self].map((a) => PLACES[a]).filter(Boolean).sort(),
            checkedAt: Date.now()
        };
    }
}

module.exports = { Seeds, DEFAULT_SEEDS, PLACES, PREFIX };
