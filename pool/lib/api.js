'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// Read-only HTTP API + static file server for the dashboard.
//
// No framework: the surface is eight endpoints and a handful of static files,
// and an unpatched Express in a pool's public-facing process is a liability
// nobody needs. Everything here is GET, everything is read-only, and nothing
// accepts a body.

const http = require('http');
const fs = require('fs');
const path = require('path');

const {
    COIN, SUBSIDY_HALVING_INTERVAL, INITIAL_BLOCK_SUBSIDY_WAM, MAX_HALVINGS,
    DEVFEE_PERCENT, DEVFEE_LAST_HEIGHT,
    // the local variable below is called nextHalvingHeight, so the
    // shared rule comes in under a name that does not shadow it
    nextHalvingHeight: nextHalving
} = require('./constants');

// The same validator the stratum server authorizes with. Two address checks in
// one process drift apart, and the day they disagree the API answers for a
// string no miner could ever have used -- or refuses one that is paying out.
const { validateAddress } = require('./util');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8'
};


// twam1qtekdutq...a7ljs.server -- recognisable to its owner, useless for
// building a list. The suffix after the dot is a label the miner chose for his
// own machine and identifies nothing on the chain, so it is kept intact.
function redactWorker(worker) {
    if (typeof worker !== 'string' || !worker) return '—';
    const dot = worker.indexOf('.');
    const addr = dot === -1 ? worker : worker.slice(0, dot);
    const rest = dot === -1 ? '' : worker.slice(dot);
    if (addr.length <= 16) return addr + rest;
    return addr.slice(0, 10) + '…' + addr.slice(-5) + rest;
}


// Redaction happens once, on the way out, and not endpoint by endpoint.
//
// Reported 2026-09-13 by an independent reviewer, and every line of it was
// true: /api/miners ran redactWorker() and its three siblings did not.
// /api/hashrate handed out `<payout address>.<rig label>` as the keys of its
// workers map, /api/blocks named the finding address of every retained block,
// and /api/payments returned full addresses beside their txids. One
// unauthenticated GET through pool.wamcoin.org returned the founder's own
// testnet address and the label he gave his machine.
//
// The control existed and was applied at one call site out of four. Worse,
// site/pool/index.html already told the world the addresses were truncated
// and that "nothing enumerates the others" -- a published claim ahead of the
// code, which is the one kind of defect this project treats as urgent.
//
// So the rule is structural now: identity fields are redacted where the
// response leaves the process, which is the only place that cannot be
// forgotten when a fifth endpoint is added.
//
// Two deliberate exemptions, both stated rather than implied:
//   /api/miner?address=X   the caller supplied X. It is a lookup, not an
//                          enumeration, and redacting it would break the one
//                          endpoint a miner uses to read his own figures.
//   labels after the dot   a rig name identifies nothing on the chain.
const IDENTITY_FIELDS = new Set(['worker', 'finder']);
const IDENTITY_MAPS = new Set(['workers', 'payouts']);

function redactIdentities(value, keyName = null) {
    if (Array.isArray(value)) {
        return value.map((v) => redactIdentities(v, keyName));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            // A map keyed BY identity: the address is the key itself.
            const key = IDENTITY_MAPS.has(keyName) ? redactWorker(k) : k;
            out[key] = redactIdentities(v, k);
        }
        return out;
    }
    if (typeof value === 'string' && IDENTITY_FIELDS.has(keyName)) {
        return redactWorker(value);
    }
    return value;
}

class ApiServer {
    constructor({ config, logger, jobManager, stratumServer, shareProcessor, daemon }) {
        this.config = config;
        this.log = logger;
        this.jobManager = jobManager;
        this.stratum = stratumServer;
        this.shares = shareProcessor;
        this.daemon = daemon;

        this.webRoot = path.join(__dirname, '..', 'web');
        this.cache = new Map();          // endpoint -> {at, body}
        this.cacheMs = config.apiCacheMs ?? 3000;
    }

    listen() {
        this.server = http.createServer((req, res) => {
            this._handle(req, res).catch((err) => {
                this.log.error(`api error on ${req.url}: ${err.message}`);
                this._json(res, 500, { error: 'internal error' });
            });
        });

        const port = this.config.apiPort || 8080;
        const bind = this.config.apiBind || '0.0.0.0';

        this.server.on('error', (err) => {
            this.log.error(`api port ${port}: ${err.message}`);
            if (err.code === 'EADDRINUSE') process.exit(1);
        });

        this.server.listen(port, bind, () => {
            this.log.info(`dashboard and API on http://${bind}:${port}/`);
        });
    }

    close() { if (this.server) this.server.close(); }

    // -----------------------------------------------------------------------

    async _handle(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return this._json(res, 405, { error: 'only GET is supported' });
        }

        // WHATWG URL, not the legacy url.parse(): Node deprecated the latter
        // precisely because its non-standard parsing has produced path-handling
        // CVEs. The base is a throwaway -- only the path and query are used.
        let parsed;
        try {
            parsed = new URL(req.url, 'http://localhost');
        } catch {
            return this._json(res, 400, { error: 'malformed request URL' });
        }
        const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

        res.setHeader('Access-Control-Allow-Origin', this.config.apiCorsOrigin || '*');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');

        if (pathname.startsWith('/api/')) {
            return this._api(pathname, parsed.searchParams, res);
        }
        return this._static(pathname, res);
    }

    async _api(pathname, query, res) {
        // Small TTL cache: a dashboard open in fifty tabs must not turn into
        // fifty Redis round trips per second.
        const cacheKey = pathname + '?' + query.toString();
        const hit = this.cache.get(cacheKey);
        if (hit && Date.now() - hit.at < this.cacheMs) {
            return this._json(res, 200, hit.body, true);
        }

        let body;
        switch (pathname) {
        case '/api/stats':
            body = await this._stats();
            break;
        case '/api/blocks':
            body = (await this.shares.getPoolStats());
            body = {
                confirmed: body.recentBlocks,
                pending: body.pendingBlocks,
                orphaned: body.orphanedBlocks
            };
            break;
        case '/api/miners':
            // Truncated, always. This endpoint used to return every connected
            // miner's full payout address, publicly and without a password:
            //
            //     "worker": "twam1qtekdutqnwmqwtsh4rddncxru2s0y3vp5ea7ljs.server"
            //
            // An address on a public chain reveals everything it has ever
            // received and everything it holds, so anyone could produce a list
            // of who mines here and what each of them has earned -- and the
            // largest earner is the one worth attacking first. It is the same
            // rule this project already applies to node operators: a list of
            // who runs a node is a list of who gets attacked.
            //
            // What the big pools do, and what this does now: aggregate totals
            // are public, and an individual looks up his own numbers by giving
            // his own address to /api/miner. Knowing your address finds your
            // row; nothing lets you enumerate everybody else's.
            //
            // Enough of the address is kept for a miner to recognise his own
            // line on the page, which is the only thing the listing is for.
            // Our own tooling reads the machine directly and never needed this.
            body = { miners: this.stratum.getConnectedMiners().map((m) => ({
                ...m,
                worker: redactWorker(m.worker)
            })) };
            break;
        case '/api/hashrate':
            body = await this.shares.getHashrateStats();
            break;
        case '/api/payments':
            body = { payments: (await this.shares.getPoolStats()).recentPayments };
            break;
        case '/api/miner': {
            const address = query.get('address');
            if (!address) return this._json(res, 400, { error: 'address required' });

            // Reject before doing any work, and before this string becomes a
            // cache key. Anything that is not shaped like an address cannot
            // have mined here, so answering it costs a Redis round trip and a
            // cache entry to tell someone what they already knew.
            // validateAddress returns {ok, reason}, never a boolean: `!result`
            // is always false and would wave everything through.
            const check = validateAddress(address, this.config.netVersions);
            if (!check.ok) {
                return this._json(res, 400, { error: check.reason });
            }
            body = await this.shares.getMinerStats(address);
            break;
        }
        case '/api/network':
            body = await this._network();
            break;
        case '/api/health':
            body = await this._health();
            break;
        default:
            return this._json(res, 404, { error: 'unknown endpoint' });
        }

        // Before the cache, so a cached hit cannot serve what a fresh
        // response would not. /api/miner is the stated exemption above.
        if (pathname !== '/api/miner') {
            body = redactIdentities(body);
        }
        this._cacheSet(cacheKey, body);
        return this._json(res, 200, body);
    }

    /**
     * Store, and keep the cache from becoming the attack.
     *
     * The key contains the query string, and /api/miner?address=... is written
     * by whoever is asking. An unbounded Map keyed on that is a memory
     * exhaustion vector: a million distinct addresses is a million entries the
     * process never releases, and the pool dies of a request pattern rather
     * than of a bug.
     *
     * Bounded with the oldest evicted first. A Map iterates in insertion order,
     * so the first key is the oldest -- no library, no timestamp scan.
     */
    _cacheSet(key, body) {
        const max = this.config.apiCacheEntries || 512;
        if (this.cache.size >= max) {
            // Drop expired entries first; only fall back to evicting a live one
            // if everything in there is still warm.
            const now = Date.now();
            for (const [k, v] of this.cache) {
                if (now - v.at >= this.cacheMs) this.cache.delete(k);
            }
            while (this.cache.size >= max) {
                this.cache.delete(this.cache.keys().next().value);
            }
        }
        this.cache.set(key, { at: Date.now(), body });
    }

    async _stats() {
        const [pool, hashrate, network] = await Promise.all([
            this.shares.getPoolStats(),
            this.shares.getHashrateStats(),
            this._network()
        ]);

        const miners = this.stratum.getConnectedMiners();
        const job = this.jobManager.getStatus();

        // THE POOL'S SHARE IS COUNTED, NOT A MEASUREMENT DIVIDED BY AN ESTIMATE.
        //
        // It was:
        //     poolShare = hashrate.poolHashrate / network.networkHashPerSecond
        //
        // The numerator is MEASURED -- every share the pool's miners actually
        // submitted in the last ten minutes, proven work. The denominator is
        // ESTIMATED -- getnetworkhashps infers a rate from how fast the last
        // 120 blocks arrived. Two numbers from two sources that know nothing
        // of each other, and dividing them crosses 100% whenever they drift.
        //
        // On 2026-10-29 this page read:
        //
        //     POOL HASHRATE     560.6 kH/s    102.057% of network
        //     NETWORK HASHRATE  549.3 kH/s
        //
        // A part larger than the whole it belongs to. The network hashrate is
        // the sum of everyone mining -- this pool, other pools, people mining
        // alone -- so a pool contributes to it and cannot exceed it, whatever
        // either number says. The founder watches this panel and said so.
        //
        // The fault was always here. It was hidden while the pool found half
        // the blocks, because an understated estimate was still larger than
        // our measurement. At 78% of blocks it stopped being larger. The
        // pool's growth did not cause this; it exposed it.
        //
        // WHAT IS COUNTED
        //
        // blocks:pending holds every block this pool found that has not yet
        // reached COINBASE_MATURITY confirmations -- which is exactly the
        // pool's blocks inside the last `maturity` blocks of chain, complete
        // by construction, with nothing sliced or trimmed. So F of the last N
        // blocks are ours, and F/N is the share: a count off the public
        // ledger, incapable of exceeding 1.
        //
        // The total is then built from the part we can actually measure:
        //
        //     network = our measured hashrate / our counted share
        //
        // which equals our hashrate when we find every block and grows as our
        // share falls. It cannot come out below its own part. That is the
        // whole point, and it is also the better number: the estimate read
        // 566 kH/s while this construction read 715, and 159 kH/s of other
        // people's miners -- who were demonstrably finding 32 blocks in every
        // 144 -- were missing from the panel.
        const maturity = this.config.coinbaseMaturity ?? 100;
        const tip = network.blocks || 0;
        const windowBlocks = Math.max(1, Math.min(maturity, tip));
        const lowest = tip - windowBlocks + 1;
        const ours = new Set();
        for (const b of pool.pendingBlocks || []) {
            if (b.height >= lowest && b.height <= tip && !b.orphanReason) {
                ours.add(b.height);
            }
        }
        const foundByPool = ours.size;
        const estimate = network.networkHashPerSecond || 0;

        // Below ten blocks the count is too thin to divide by: at F=2 of 100 a
        // single lucky block moves the implied total by half. The estimate is
        // the better answer there, floored at our own hashrate so that the
        // part still cannot exceed the whole while we wait for the count.
        const COUNT_FLOOR = 10;
        const counted = foundByPool >= COUNT_FLOOR;
        const poolShare = counted ? foundByPool / windowBlocks
                                  : (estimate > 0
                                     ? Math.min(1, hashrate.poolHashrate / estimate)
                                     : 0);
        const expectedBlockSeconds = poolShare > 0 ? 120 / poolShare : null;

        return {
            pool: {
                ...pool,
                hashrate: hashrate.poolHashrate,
                miners: miners.length,
                workers: Object.keys(hashrate.workers).length,
                poolSharePercent: poolShare * 100,
                expectedBlockSeconds,
                // How the share was arrived at, so the page can say so and a
                // reader is never asked to trust a number whose provenance is
                // hidden. "counted" is F of N blocks off the ledger;
                // "estimated" is the old inference, used only until the count
                // is thick enough to divide by.
                shareBasis: counted ? 'counted' : 'estimated',
                shareWindowBlocks: windowBlocks,
                blocksFoundInWindow: foundByPool
            },
            network: {
                ...network,
                // Everyone on the chain who is not us, from the one network
                // figure both pages publish. Briefly this tile carried a
                // total of its own -- measured hashrate over counted share --
                // which was a defensible number and a second headline for a
                // quantity that may only have one. The share is what had to
                // stop being a division; the total never did.
                othersHashPerSecond: Math.max(
                    0, (network.networkHashPerSecond || 0) - hashrate.poolHashrate)
            },
            job: job.currentJob,
            randomx: {
                seedHeight: job.currentJob ? job.currentJob.seedHeight : null,
                nextRotationInBlocks: job.nextSeedRotationIn,
                seedRotations: job.stats ? job.stats.seedRotations : job.seedRotations
            },
            config: {
                rewardMode: pool.rewardMode,
                poolFeePercent: pool.poolFeePercent,
                chainDevFeePercent: 5,
                minimumPayoutWam: this.config.minimumPayoutWam ?? 1,
                ports: (this.config.ports || []).map((p) => ({
                    port: p.port,
                    difficulty: p.difficulty || this.config.startDifficulty,
                    description: p.description || null,
                    // The dashboard has to say which port is encrypted, or
                    // nobody uses it. An encrypted port that is never
                    // mentioned protects nobody.
                    tls: Boolean(p.tls)
                })),
                stratumHost: this.config.publicHost || null,
                // Where the operator's fee goes, so that "1%" is a thing
                // anybody can follow to an address instead of a number they
                // are asked to believe. Null when no address is configured,
                // which the page reads as "the fee stays in the pool wallet"
                // -- the honest description of that state, not a blank.
                poolFeeAddress: this.config.poolFeeAddress || null
            },
            updatedAt: Date.now()
        };
    }

    async _network() {
        // THE SAME QUESTION THE EXPLORER ASKS, OF THE SAME NODE.
        //
        // A miner on this pool should not have to open a second page to see
        // how strong the chain is -- that is what the third tile is for. So
        // it has to be the explorer's number, not a number of our own that
        // happens to be near it: 615.7 here beside 608.3 there is one
        // quantity with two headlines, and a reader has no way to choose.
        //
        // AND THE SAME QUESTION EVERY OTHER POOL ON THIS CHAIN ASKS.
        //
        // getmininginfo answers over getnetworkhashps's default 120 blocks --
        // four hours, which nobody chose; it came with Bitcoin Core. For a few
        // hours this asked for 720 instead, on the reasoning that four hours
        // is too few blocks to average a Poisson process against a difficulty
        // DGW moves every block. The reasoning is sound and the change was
        // still wrong.
        //
        // On 2026-10-29, within three blocks of each other:
        //
        //     veinpool.fr            590.5 kH/s
        //     wampool.vslabs.co.in   590.5 kH/s
        //     pool.wamcoin.org       620.9 kH/s
        //
        // Our own node, asked both ways at one instant, gave 594.7 over 120
        // and 622.5 over 720. So the chain data was identical to theirs and
        // the entire difference was a window we had picked for ourselves.
        //
        // Every other operator calls getmininginfo, so 120 is the convention
        // on this chain whether or not it is the better estimator. A stranger
        // comparing three pool pages does not read ours as better reasoned.
        // He reads the project's own pool quoting a bigger network than
        // everybody else's -- and for a project whose only asset is being
        // checkable, looking like we inflate our own numbers costs more than
        // five per cent of estimator accuracy is worth.
        //
        // The defect this was meant to help never needed it either: a part
        // exceeding its whole was cured by counting the pool's share off the
        // ledger, not by changing the denominator's window.
        const [chain, mining] = await Promise.all([
            this.daemon.getBlockchainInfo(),
            this.daemon.getMiningInfo()
        ]);

        this.shares.setNetworkDifficulty(chain.difficulty);

        const height = chain.blocks;

        // The emission comes from the node, not from a constant here.
        //
        // This used to recompute the halving schedule locally from
        // SUBSIDY_HALVING_INTERVAL, and was wrong on every network except
        // mainnet: at regtest height 3,944 it reported a 50.00 WAM block reward
        // and "196,056 blocks to halving 1" while the chain's real subsidy had
        // halved 25 times to 74 satoshi with the next halving 106 blocks away.
        //
        // That was the fourth time this project reimplemented a consensus rule
        // in JavaScript beside a daemon that already returned the answer -- the
        // treasury maths, the RandomX epoch, the network dashboard, and this.
        // The rule, stated once: if the daemon returns it, do not recompute it.
        const supply = await this.daemon.cmd('getsupplyinfo', []).catch(() => null);
        const fromNode = (key) =>
            supply && supply[key] !== undefined && supply[key] !== null;
        const toSat = (wam) => Math.round(Number(wam) * COIN);

        let subsidy, treasurySubsidy, nextHalvingHeight, halvings, emissionSource;

        if (fromNode('halving_interval') && fromNode('block_subsidy')) {
            subsidy = toSat(supply.block_subsidy);
            treasurySubsidy = fromNode('treasury_subsidy')
                ? toSat(supply.treasury_subsidy)
                : Math.floor(subsidy * DEVFEE_PERCENT / 100);
            nextHalvingHeight = fromNode('next_halving_height')
                ? supply.next_halving_height
                : nextHalving(height, supply.halving_interval);
            halvings = fromNode('halving_epoch') ? supply.halving_epoch : 0;
            emissionSource = 'node';
        } else {
            // An unpatched or unreachable daemon. Mirrors wam::GetBlockSubsidy,
            // and says so, because these figures are then a guess.
            halvings = height >= 1
                ? Math.floor((height - 1) / SUBSIDY_HALVING_INTERVAL) : 0;
            subsidy = halvings >= MAX_HALVINGS
                ? 0 : Math.floor(INITIAL_BLOCK_SUBSIDY_WAM * COIN / Math.pow(2, halvings));
            nextHalvingHeight = nextHalving(height);
            treasurySubsidy = (height >= 1 && height <= DEVFEE_LAST_HEIGHT)
                ? Math.floor(subsidy * DEVFEE_PERCENT / 100) : 0;
            emissionSource = 'local';
        }

        const treasuryActive = treasurySubsidy > 0;

        return {
            emissionSource,
            chain: chain.chain,
            blocks: chain.blocks,
            headers: chain.headers,
            difficulty: chain.difficulty,
            // getmininginfo's own figure, which is getnetworkhashps over its
            // default 120 blocks -- the same number every other pool on this
            // chain publishes. The window still travels with it, because an
            // average shown without its scale is how one quantity came to
            // have four different values across two pages, and saying "120
            // blocks" costs nothing and makes ours the only panel that says
            // what it measured over.
            networkHashPerSecond: mining.networkhashps || 0,
            networkHashWindowBlocks: 120,

            // The tip's own timestamp, and how long ago that was.
            //
            // networkhashps above is an ESTIMATE derived from how fast recent
            // blocks arrived. When blocks stop arriving it keeps reporting the
            // rate of the blocks before the stall, so it is least truthful at
            // the exact moment it matters most. On 5 September 2026 a tester
            // shut down every miner he had; this page read 24.3 kH/s while
            // showing 0 active workers, and the chain had not moved in half an
            // hour. Both numbers were on screen together.
            //
            // This one cannot be estimated: it is the clock minus the block
            // header. The page shows it beside the hashrate so a reader can
            // see when the estimate has gone stale.
            tipTime: chain.time || null,
            secondsSinceBlock: chain.time
                ? Math.max(0, Math.floor(Date.now() / 1000) - chain.time)
                : null,
            connections: mining.connections !== undefined ? mining.connections : null,
            blockSubsidy: subsidy,
            minerSubsidy: subsidy - treasurySubsidy,
            treasurySubsidy,
            treasuryActive,
            // From the chain where it says so. It happens to agree with
            // DEVFEE_LAST_HEIGHT today, and the whole lesson of this file is
            // that "happens to agree" is not a property you can rely on.
            treasuryLastHeight: fromNode('treasury') && supply.treasury.last_height !== undefined
                ? supply.treasury.last_height : DEVFEE_LAST_HEIGHT,
            blocksUntilTreasuryEnds: fromNode('treasury') &&
                                     supply.treasury.blocks_remaining !== undefined
                ? supply.treasury.blocks_remaining
                : Math.max(0, DEVFEE_LAST_HEIGHT - height),
            halvingEpoch: halvings,
            nextHalvingHeight,
            blocksUntilHalving: nextHalvingHeight - height,
            targetSpacing: 120
        };
    }

    async _health() {
        const job = this.jobManager.getStatus();
        const templateAgeSec = (Date.now() - this.jobManager.lastTemplateAt) / 1000;

        const problems = [];
        if (!job.currentJob) problems.push('no block template');
        if (templateAgeSec > 120) problems.push(`template is ${Math.round(templateAgeSec)}s old`);
        if (this.stratum.clients.size === 0) problems.push('no miners connected');

        return {
            ok: problems.length === 0,
            problems,
            templateAgeSec: Math.round(templateAgeSec),
            connections: this.stratum.clients.size,
            uptimeSec: Math.round(process.uptime()),
            memoryMb: Math.round(process.memoryUsage().rss / 1048576)
        };
    }

    // -----------------------------------------------------------------------

    _static(pathname, res) {
        const rel = pathname === '/' ? 'index.html' : pathname.slice(1);

        // Resolve and then verify containment: this is the only defence that
        // actually works against encoded traversal sequences.
        const filePath = path.resolve(this.webRoot, rel);
        if (!filePath.startsWith(path.resolve(this.webRoot) + path.sep)) {
            return this._json(res, 403, { error: 'forbidden' });
        }

        fs.readFile(filePath, (err, data) => {
            if (err) return this._json(res, 404, { error: 'not found' });
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
                'Cache-Control': 'public, max-age=60'
            });
            res.end(data);
        });
    }

    _json(res, status, body, cached = false) {
        const text = JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(text),
            'X-Cache': cached ? 'HIT' : 'MISS'
        });
        res.end(text);
    }
}

module.exports = ApiServer;

// Exported so the redaction can be tested as the pure question it is, without
// Redis, a node or a config. The first version of that test pulled these two
// out of the source with eval() -- which fails under 'use strict', and would
// have kept passing against a stale copy of the code if it had not.
module.exports.redactWorker = redactWorker;
module.exports.redactIdentities = redactIdentities;
