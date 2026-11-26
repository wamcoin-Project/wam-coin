#!/usr/bin/env node
'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  WAM Network Dashboard -- entry point
// ===========================================================================
//
//      node server.js                      # reads config.json, or auto-detects
//      node server.js --config my.json
//      node server.js --port 8081
//
//  ZERO npm dependencies. Node 18+ and nothing else. This is the tool an
//  operator opens when something is wrong, and "npm install failed" is not an
//  acceptable answer at that moment.
//
//  If config.json is absent the server reads RPC credentials straight out of
//  ~/.wam/wam.conf, which is what install.sh generates. In the normal case
//  there is nothing to configure at all.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const RpcClient = require('./lib/rpc');
const Collector = require('./lib/collector');
const network = require('./lib/network');
const { Seeds } = require('./lib/seeds');
const { Concentration } = require('./lib/concentration');

// ---------------------------------------------------------------------------
// Tiny logger (no dependency)
// ---------------------------------------------------------------------------

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let logLevel = LEVELS.info;

const log = {
    _w(level, msg) {
        if (LEVELS[level] < logLevel) return;
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const colour = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level];
        const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}`;
        console.log(process.stdout.isTTY ? `${colour}${line}\x1b[0m` : line);
    },
    debug(m) { this._w('debug', m); },
    info(m) { this._w('info', m); },
    warn(m) { this._w('warn', m); },
    error(m) { this._w('error', m); }
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_RPC_PORTS = { main: 9554, test: 19554, regtest: 29554 };

/**
 * Read a text file, dropping a UTF-8 byte-order mark if present.
 *
 * Notepad, PowerShell's `Out-File -Encoding utf8` and several Windows editors
 * prepend a BOM. JSON.parse rejects it outright, and an ini parser silently
 * mangles the first key instead -- which is worse, because the failure surfaces
 * later as "wrong rpcuser" rather than as a parse error.
 */
function readTextFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * Parse an ini-style wam.conf. This is how the explorer works with no config
 * of its own: install.sh already wrote credentials there, and duplicating them
 * into a second file is one more thing to get out of sync.
 */
function readWamConf(confPath) {
    if (!fs.existsSync(confPath)) return null;

    const out = {};
    for (const raw of readTextFile(confPath).split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('[')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }

    const network = out.regtest === '1' ? 'regtest' : out.testnet === '1' ? 'test' : 'main';

    if (!out.rpcuser || !out.rpcpassword) return null;

    return {
        host: '127.0.0.1',
        port: parseInt(out.rpcport, 10) || DEFAULT_RPC_PORTS[network],
        user: out.rpcuser,
        password: out.rpcpassword,
        network,
        source: confPath
    };
}

function loadConfig(argv) {
    const args = { config: null, port: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--config' && argv[i + 1]) args.config = argv[++i];
        else if (argv[i] === '--port' && argv[i + 1]) args.port = parseInt(argv[++i], 10);
        else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    }

    if (args.help) return { help: true };

    const explicit = args.config || path.join(__dirname, 'config.json');
    let cfg = {};

    if (fs.existsSync(explicit)) {
        try {
            cfg = JSON.parse(readTextFile(explicit));
            log.info(`configuration: ${explicit}`);
        } catch (err) {
            throw new Error(`${explicit} is not valid JSON: ${err.message}`);
        }
    }

    // Fill any gap from wam.conf.
    if (!cfg.rpc || !cfg.rpc.user || !cfg.rpc.password) {
        const candidates = [
            process.env.WAM_CONF,
            path.join(os.homedir(), '.wam', 'wam.conf'),
            path.join(os.homedir(), '.wamcoin', 'wam.conf'),
            '/etc/wam/wam.conf'
        ].filter(Boolean);

        for (const c of candidates) {
            const found = readWamConf(c);
            if (found) {
                cfg.rpc = { ...found, ...(cfg.rpc || {}) };
                log.info(`RPC credentials auto-detected from ${found.source} ` +
                         `(${found.network}, port ${found.port})`);
                break;
            }
        }
    }

    if (!cfg.rpc || !cfg.rpc.user || !cfg.rpc.password) {
        throw new Error(
            'no RPC credentials found.\n' +
            '  Either run install.sh (which writes ~/.wam/wam.conf), or copy\n' +
            '  config.example.json to config.json and fill in rpcuser/rpcpassword.');
    }

    // THE OPERATOR'S CONFIG GOES THROUGH; THE NAMED KEYS ARE NORMALISED.
    //
    // This was a literal naming six keys, so every other key in config.json
    // was dropped between the file and the server -- read later as undefined
    // and silently replaced by a default. Two settings were lost that way:
    //
    //   explorerRequestsPerMinute  the per-caller rate limit added in
    //                              v0.1.15. The limiter ran at its own
    //                              default of 120 whatever the operator
    //                              wrote, and the comment above it says
    //                              "explorerRequestsPerMinute is there to be
    //                              raised when that is the shape" -- a
    //                              promise three lines above code that could
    //                              not keep it.
    //   seedHostnames              the seed list, which fell back to the
    //                              compiled-in names.
    //
    // Neither is visible at runtime. The limiter still refuses at 120, the
    // seed panel still fills, and every test of both passed -- because every
    // test used the default, and at the default a dropped setting and an
    // honoured one are the same thing. Found on 2026-11-26 by
    // scripts/test/stranger.sh, on the first run that set the limit to five
    // and counted the refusals: twelve requests, twelve 200s.
    //
    // Spreading cfg first is the fix for the class, not for the two keys. A
    // setting added to config.json next year arrives at the server without
    // anybody remembering to widen this list, which is the mistake that was
    // made here and would be made again. The normalised keys follow the
    // spread so they still win.
    return {
        ...cfg,
        rpc: {
            host: cfg.rpc.host || '127.0.0.1',
            port: cfg.rpc.port || DEFAULT_RPC_PORTS.main,
            user: cfg.rpc.user,
            password: cfg.rpc.password,
            ssl: cfg.rpc.ssl === true,
            timeout: cfg.rpc.timeout || 10000
        },
        port: args.port || cfg.port || 8081,
        bind: cfg.bind || '127.0.0.1',
        pollSeconds: cfg.pollSeconds || 10,
        siteName: cfg.siteName || 'WAM Network',
        logLevel: cfg.logLevel || 'info'
    };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

function serveStatic(root, pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(root, rel);

    // Resolve first, then verify containment. This is the only check that
    // actually holds against encoded traversal sequences.
    if (!file.startsWith(path.resolve(root) + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
    }

    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
}

function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text)
    });
    res.end(text);
}

// ---------------------------------------------------------------------------

async function main() {
    let config;
    try {
        config = loadConfig(process.argv);
    } catch (err) {
        console.error(`\x1b[31merror:\x1b[0m ${err.message}\n`);
        process.exit(1);
    }

    if (config.help) {
        console.log(`
WAM Network Dashboard

  node server.js [--config FILE] [--port N]

  With no configuration it reads RPC credentials from ~/.wam/wam.conf,
  which install.sh writes. In the normal case there is nothing to set up.
`);
        return;
    }

    logLevel = LEVELS[config.logLevel] ?? LEVELS.info;

    log.info('='.repeat(62));
    log.info(' WAM Network Dashboard');
    log.info('='.repeat(62));

    const rpc = new RpcClient(config.rpc);
    const collector = new Collector(rpc, log, { pollSeconds: config.pollSeconds });
    const concentration = new Concentration(log);

    // Asked of DNS, the way a node with no peers asks. Cached, because a
    // seed does not appear and vanish minute to minute and a page refresh
    // must not cost three TCP connects.
    const seeds = new Seeds({ hostnames: config.seedHostnames });

    // Probe once so startup says something useful either way, but do NOT refuse
    // to start: the dashboard's job includes showing that the node is down.
    try {
        const info = await rpc.call('getblockchaininfo');
        log.info(`connected to wamd -- chain=${info.chain} blocks=${info.blocks} ` +
                 `difficulty=${info.difficulty}`);
    } catch (err) {
        log.warn(`wamd not reachable yet: ${err.message}`);
        log.warn('the dashboard will start anyway and reconnect automatically.');
    }

    await collector.start();

    const webRoot = path.join(__dirname, 'web');
    const brandRoot = path.join(__dirname, '..', 'brand');

    /**
     * One bucket per socket address, refilled every minute.
     *
     * Deliberately smaller than the pool's: the pool serves miners polling
     * on a schedule, this serves people reading a page. A browser refreshing
     * every six seconds makes ten requests a minute per panel; the default
     * leaves room for several tabs and still bounds a caller who is not
     * reading anything.
     *
     * Keyed on the socket, not on X-Forwarded-For, for the reason the pool
     * learned the hard way: a header anyone can write is a limit anyone can
     * remove. An operator behind a proxy sees one bucket for the proxy, and
     * explorerRequestsPerMinute is there to be raised when that is the shape.
     */
    const limiter = (() => {
        const perMinute = Number(config.explorerRequestsPerMinute) > 0
            ? Number(config.explorerRequestsPerMinute) : 120;
        const maxCallers = 4096;
        const buckets = new Map();
        return {
            take(who) {
                const now = Date.now();
                let b = buckets.get(who);
                if (!b || now - b.start >= 60_000) {
                    if (buckets.size >= maxCallers && !buckets.has(who)) {
                        // Oldest window first: a table that grows without
                        // limit is the denial of service it was meant to stop.
                        let oldestKey = null, oldest = Infinity;
                        for (const [k, v] of buckets) {
                            if (v.start < oldest) { oldest = v.start; oldestKey = k; }
                        }
                        if (oldestKey !== null) buckets.delete(oldestKey);
                    }
                    b = { start: now, n: 0 };
                    buckets.set(who, b);
                }
                b.n++;
                if (b.n <= perMinute) return null;
                return Math.max(1, Math.ceil((b.start + 60_000 - now) / 1000));
            }
        };
    })();

    const server = http.createServer(async (req, res) => {
        // WHATWG URL, not the legacy url.parse(): Node deprecated the latter
        // precisely because its non-standard parsing has produced path-handling
        // CVEs. The base is a throwaway -- only the path and query are used.
        let parsed;
        try {
            parsed = new URL(req.url, 'http://localhost');
        } catch {
            return json(res, 400, { error: 'malformed request URL' });
        }
        const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        const q = (name) => parsed.searchParams.get(name);

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return json(res, 405, { error: 'only GET is supported' });
        }

        // THE EXPLORER HAD NO LIMIT AT ALL, AND ITS ENDPOINTS COST RPC.
        //
        // In the same release the pool API gained a per-caller limiter and
        // this gained none. Measured by Radenlingga on 2026-11-26 against the
        // real server: 30 requests to /api/network cost exactly 120 node RPC
        // calls -- 4 each, uncached by design -- plus a synchronous state
        // file rewrite each; /api/search and /api/audit cost 2 RPC calls each
        // by height; and 50 requests produced 50 x HTTP 200 and zero refusals
        // of any kind.
        //
        // The explorer binds the loopback by default, so this needs the
        // operator to have exposed it -- which the shipped config presents as
        // the public deployment behind a proxy. Wherever it is reachable, an
        // unauthenticated caller could keep the node answering explorer RPCs
        // at whatever rate they chose, against the two pieces of tooling an
        // operator reaches for when something is already wrong.
        //
        // Only the RPC-backed paths are limited. Static files and /api/health
        // cost nothing and refusing them would break the very monitoring this
        // protects.
        if (pathname.startsWith('/api/') && pathname !== '/api/health') {
            const who = (req.socket && req.socket.remoteAddress) || '?';
            const wait = limiter.take(who);
            if (wait !== null) {
                res.setHeader('Retry-After', String(wait));
                return json(res, 429, {
                    error: 'too many requests',
                    retryAfterSec: wait
                });
            }
        }

        try {
            switch (true) {
            case pathname === '/api/status':
                return json(res, 200, {
                    ...collector.get(),
                    siteName: config.siteName,
                    serverUptimeSec: Math.round(process.uptime())
                });

            case pathname === '/api/blocks':
                return json(res, 200, { blocks: collector.get().blocks });

            // How concentrated the hash rate is, published permanently.
            // Not cached with the rest and not hidden behind a flag: on the
            // night mainnet opened, one address found 97.5% of the first 79
            // blocks and the only people who knew were miners who had won
            // nothing. See lib/concentration.js.
            // refresh(), not update(). update() is one fetch pass and this
            // awaited it on every unauthenticated request, so each request
            // was its own pass against the node and nothing was remembered
            // between them. refresh() runs at most one pass at a time and
            // at most one per ten seconds, however many callers there are,
            // which is what the README already promised: ten open tabs cost
            // the node what one does.
            //
            // Reported by Fahrizal, 18 November 2026.
            case pathname === '/api/concentration': {
                const tip = (collector.get().chain || {}).blocks || 0;
                if (tip > 0) await concentration.refresh(collector.rpc, tip);
                return json(res, 200, { tip, ...concentration.snapshot() });
            }

            // Who else is out there. Deliberately not cached with the rest:
            // this is the number people will refresh, and a minute-old answer
            // reads as a dead network rather than a slow page.
            case pathname === '/api/network': {
                const peers = await collector.rpc.tryCall('getpeerinfo', [], []);
                // 0 means "as many as you are willing to hand out", which is
                // NOT the same as "everything you know" -- see the comment on
                // build() in lib/network.js. The address book itself is
                // getaddrmaninfo, and the two differ by a factor of two on a
                // network this small.
                const known = await collector.rpc.tryCall('getnodeaddresses', [0], []);
                const addrman = await collector.rpc.tryCall('getaddrmaninfo', [], null);
                const netInfo = await collector.rpc.tryCall('getnetworkinfo', [], null);
                // What a new node would find before it has any peers: the
                // seed hostnames, resolved, and each distinct machine behind
                // them probed on the p2p port. Counting peers could never
                // include the machine this runs on, so the panel used to say
                // one seed when there are two.
                seeds.setChain((collector.get().chain || {}).name);
                // The node's own addresses, so the probe never dials the
                // machine it is running on. Connecting to your own public
                // address succeeds over local routing whether or not the
                // port is open to the world, so it is not evidence -- and it
                // filled the net log with a self-connection every five
                // minutes.
                seeds.setSelfAddresses(
                    ((netInfo && netInfo.localaddresses) || []).map((a) => a.address));
                const out = network.build(peers, known, netInfo, addrman);
                out.seedNodes = seeds.snapshot();
                return json(res, 200, out);
            }

            case pathname === '/api/search': {
                if (!q('q')) return json(res, 400, { error: 'q is required' });
                try {
                    return json(res, 200, await collector.lookup(q('q')));
                } catch (err) {
                    return json(res, 404, { error: err.message });
                }
            }

            case pathname === '/api/audit': {
                if (!q('block')) return json(res, 400, { error: 'block is required' });
                try {
                    return json(res, 200, await collector.auditBlock(q('block')));
                } catch (err) {
                    return json(res, 400, { error: err.message });
                }
            }

            case pathname === '/api/health': {
                const s = collector.get();
                return json(res, s.nodeOnline ? 200 : 503, {
                    ok: s.nodeOnline,
                    error: s.error,
                    staleSeconds: s.staleSeconds,
                    height: s.chain ? s.chain.blocks : null
                });
            }

            // Serve the real brand assets rather than a second copy that can
            // drift away from brand/.
            case pathname.startsWith('/brand/'):
                return serveStatic(brandRoot, pathname.replace('/brand', ''), res);

            default:
                return serveStatic(webRoot, pathname, res);
            }
        } catch (err) {
            log.error(`${pathname}: ${err.message}`);
            return json(res, 500, { error: 'internal error' });
        }
    });

    server.on('error', (err) => {
        log.error(`listen failed: ${err.message}`);
        if (err.code === 'EADDRINUSE') {
            log.error(`port ${config.port} is already in use -- try --port ${config.port + 1}`);
        }
        process.exit(1);
    });

    server.listen(config.port, config.bind, () => {
        log.info(`dashboard ready on http://${config.bind}:${config.port}/`);
        if (config.bind === '127.0.0.1') {
            log.info('bound to localhost only. To expose it, set "bind": "0.0.0.0" in ' +
                     'config.json -- and put TLS in front of it first.');
        }
    });

    const shutdown = (sig) => {
        log.info(`${sig} received, shutting down`);
        collector.stop();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
