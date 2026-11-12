'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  Stratum server
// ===========================================================================
//
//  Wire protocol: newline-delimited JSON-RPC over raw TCP.
//
//  Methods handled:
//      mining.subscribe              -> [[notifications], extranonce1, en2size]
//      mining.authorize              -> true/false
//      mining.submit                 -> true, or [code, message, null]
//      mining.extranonce.subscribe   -> true
//      mining.multi_version          -> true (ignored; some miners insist)
//
//  Notifications sent:
//      mining.set_difficulty
//      mining.notify                 (10th param carries the RandomX seed)
//      mining.set_seedhash           (WAM extension, sent on rotation)
//
//  Hostile-input posture: this port faces the open internet. Every socket is
//  bounded in buffer size, message rate, and time-to-authorize, and a single
//  malformed line closes the connection rather than being tolerated.

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const EventEmitter = require('events');

const VarDiff = require('./varDiff');
const { validateAddress } = require('./util');

let connectionCounter = 0;

class StratumClient extends EventEmitter {
    constructor(socket, server) {
        super();
        this.id = (++connectionCounter).toString(36);
        this.socket = socket;
        this.server = server;
        this.log = server.log;

        this.ip = socket.remoteAddress ? socket.remoteAddress.replace('::ffff:', '') : '?';
        this.subscribed = false;
        this.authorized = false;
        this.workerName = null;
        this.userAgent = null;
        this.extranonce1 = server.jobManager.nextExtranonce1();
        this.varDiffState = server.varDiff.createState(server.config.startDifficulty || 1000);
        this.lastSeedHash = null;

        this.shares = { valid: 0, invalid: 0 };
        this.connectedAt = Date.now();
        this.lastActivity = Date.now();

        this._buffer = '';
        this._messageTimes = [];

        socket.setKeepAlive(true, 60000);
        socket.setNoDelay(true);
        socket.setEncoding('utf8');

        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._onError(err));
        // The timer goes when the socket does. It was only ever cleared in
        // disconnect() and on a successful authorize, so a connection that
        // opened and closed on its own -- a port scanner, a miner whose
        // network dropped, anything that hangs up before authorizing -- left
        // a live 30-second timer holding this client, its socket and its
        // buffer. Bounded and small, and one per connection, from a stranger
        // who never authenticated. Found while writing the test above, where
        // it kept the process alive for thirty seconds after everything had
        // been shut down.
        socket.on('close', () => {
            clearTimeout(this._authTimer);
            this.emit('close');
        });

        // A connection that never authorizes is a scanner, not a miner.
        this._authTimer = setTimeout(() => {
            if (!this.authorized) {
                this.log.debug(`${this.ip} did not authorize within 30s; closing`);
                this.disconnect();
            }
        }, 30000);
    }

    // -----------------------------------------------------------------------

    _onData(chunk) {
        this.lastActivity = Date.now();
        this._buffer += chunk;

        // Cap the buffer: without this, a peer that never sends a newline can
        // grow our heap until the process dies.
        if (this._buffer.length > 16384) {
            this.log.warn(`${this.ip} sent an oversized line; closing`);
            return this.disconnect();
        }

        if (this._buffer.indexOf('\n') === -1) return;

        const lines = this._buffer.split('\n');
        this._buffer = lines.pop();          // keep the trailing partial line

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (!this._rateLimitOk()) {
                this.log.warn(`${this.ip} exceeded the message rate limit; closing`);
                return this.disconnect();
            }

            let message;
            try {
                message = JSON.parse(trimmed);
            } catch {
                this.log.warn(`${this.ip} sent malformed JSON; closing`);
                return this.disconnect();
            }
            this._handle(message).catch((err) => {
                this.log.error(`handler error for ${this.label()}: ${err.message}`);
            });
        }
    }

    _rateLimitOk() {
        const now = Date.now();
        this._messageTimes.push(now);
        while (this._messageTimes.length && now - this._messageTimes[0] > 10000) {
            this._messageTimes.shift();
        }
        return this._messageTimes.length <= (this.server.config.maxMessagesPer10s || 240);
    }

    _onError(err) {
        // ECONNRESET is how miners disconnect; it is not worth a log line.
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            this.log.debug(`socket error from ${this.label()}: ${err.message}`);
        }
    }

    // -----------------------------------------------------------------------

    async _handle(message) {
        const { id, method, params } = message;

        switch (method) {
        case 'mining.subscribe':
            return this._onSubscribe(id, params);
        case 'mining.authorize':
            return this._onAuthorize(id, params);
        case 'mining.submit':
            return this._onSubmit(id, params);
        case 'mining.extranonce.subscribe':
            return this.reply(id, true);
        case 'mining.multi_version':
            return this.reply(id, true);
        case 'mining.get_transactions':
            return this.reply(id, []);
        default:
            this.log.debug(`${this.label()} sent unknown method '${method}'`);
            return this.replyError(id, [20, `unknown method ${method}`, null]);
        }
    }

    _onSubscribe(id, params) {
        this.userAgent = Array.isArray(params) && params[0] ? String(params[0]).slice(0, 64) : null;
        this.subscribed = true;

        const sid = this.id.padStart(8, '0');
        this.reply(id, [
            [['mining.set_difficulty', sid], ['mining.notify', sid]],
            this.extranonce1.toString('hex'),
            4                                   // extranonce2 size
        ]);

        this.log.debug(`${this.ip} subscribed (${this.userAgent || 'unknown miner'})`);
    }

    _onAuthorize(id, params) {
        const raw = Array.isArray(params) ? String(params[0] || '') : '';
        // Convention: "<payout address>.<worker label>"
        const [address, worker] = raw.split('.');

        const check = this.server.validateMinerAddress(address);
        if (!check.ok) {
            this.reply(id, false);
            // JSON.stringify, not the bare string: it quotes, it escapes, and
            // it is the one function in the language whose whole job is to
            // render an arbitrary string as text that cannot be mistaken for
            // anything around it. Logger will not let this become a second
            // line either; both are here because this is the call site a
            // stranger reaches without authenticating, and a defence that
            // exists in one place is a defence that moved there by accident.
            this.log.warn(`${this.ip} tried to authorize with an invalid address ` +
                          `${JSON.stringify(address.slice(0, 120))}: ${check.reason}`);
            return this.disconnect();
        }

        // A RIG NAME, AND NOTHING THAT IS NOT ONE.
        //
        // The label was sliced to 32 characters and otherwise taken as it
        // came. 32 characters is enough for a newline and a convincing
        // timestamp, and the label is written to the operator's log, to the
        // PPLNS window, to redis field names and to the dashboard. Logger now
        // refuses to let any of it become a second log line -- that is the
        // fix, and it is one layer.
        //
        // This is the other: a worker label names a machine, and a machine's
        // name is letters, digits, and the three separators people actually
        // use. Everything else is dropped rather than refused, because a
        // miner whose config has an accented rig name should mine, not be
        // disconnected and left guessing.
        this.address = address;
        const label = worker ? worker.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : '';
        this.workerName = label ? `${address}.${label}` : address;
        this.authorized = true;
        clearTimeout(this._authTimer);

        this.reply(id, true);
        this.log.info(`${this.ip} authorized as ${this.workerName}`);

        this.sendDifficulty(this.varDiffState.difficulty);
        const job = this.server.jobManager.currentJob;
        if (job) this.sendJob(job, true);

        this.emit('authorized');
    }

    async _onSubmit(id, params) {
        if (!this.authorized) return this.replyError(id, [24, 'unauthorized worker', null]);
        if (!this.subscribed) return this.replyError(id, [25, 'not subscribed', null]);
        if (!Array.isArray(params) || params.length < 5) {
            return this.replyError(id, [20, 'malformed mining.submit', null]);
        }

        const [, jobId, extranonce2, nTime, nonce] = params;

        const result = await this.server.jobManager.processShare({
            jobId: String(jobId),
            extranonce1: this.extranonce1,
            extranonce2Hex: String(extranonce2),
            nTimeHex: String(nTime),
            nonceHex: String(nonce),
            workerName: this.workerName,
            difficulty: this.varDiffState.difficulty,
            ipAddress: this.ip
        });

        if (result.valid) {
            this.shares.valid++;
            this.reply(id, true);

            const next = this.server.varDiff.onShare(this.varDiffState);
            if (next !== null) this.sendDifficulty(next);
        } else {
            this.shares.invalid++;
            this.replyError(id, result.error);

            // Persistent garbage is either a broken miner or an attacker.
            if (this.shares.invalid > 50 &&
                this.shares.invalid > this.shares.valid * 4) {
                this.log.warn(`${this.label()} banned: ${this.shares.invalid} invalid shares`);
                this.server.ban(this.ip);
                this.disconnect();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Outbound
    // -----------------------------------------------------------------------

    send(obj) {
        if (this.socket.destroyed) return;
        try {
            this.socket.write(JSON.stringify(obj) + '\n');
        } catch (err) {
            this.log.debug(`write failed to ${this.label()}: ${err.message}`);
        }
    }

    reply(id, result)      { this.send({ id, result, error: null }); }
    replyError(id, error)  { this.send({ id, result: null, error }); }
    notify(method, params) { this.send({ id: null, method, params }); }

    sendDifficulty(difficulty) {
        this.varDiffState.difficulty = difficulty;
        this.notify('mining.set_difficulty', [difficulty]);
    }

    sendJob(job, cleanJobs) {
        const seedHex = job.seedHash ? job.seedHash.toString('hex') : null;

        // Tell the miner about a key change BEFORE the job that needs it,
        // so it can start rebuilding its dataset a beat earlier.
        if (seedHex && seedHex !== this.lastSeedHash) {
            this.notify('mining.set_seedhash', [seedHex, job.seedHeight, job.height]);
            this.lastSeedHash = seedHex;
        }

        this.notify('mining.notify', job.getJobParams(cleanJobs));
    }

    label() { return this.workerName ? `${this.workerName}@${this.ip}` : this.ip; }

    disconnect() {
        clearTimeout(this._authTimer);
        try { this.socket.destroy(); } catch { /* already gone */ }
    }

    summary() {
        return {
            id: this.id,
            worker: this.workerName,
            ip: this.server.config.exposeMinerIps ? this.ip : null,
            userAgent: this.userAgent,
            difficulty: this.varDiffState.difficulty,
            validShares: this.shares.valid,
            invalidShares: this.shares.invalid,
            connectedFor: Math.round((Date.now() - this.connectedAt) / 1000)
        };
    }
}

// ===========================================================================

class StratumServer extends EventEmitter {
    constructor(jobManager, config, logger) {
        super();
        this.jobManager = jobManager;
        this.config = config;
        this.log = logger;

        this.clients = new Map();
        this.varDiff = new VarDiff(config.varDiff || {});
        this.bans = new Map();      // ip -> expiry timestamp
        this.servers = [];

        jobManager.on('newJob', (job, isNewBlock) => this.broadcastJob(job, isNewBlock));
    }

    /**
     * Cap share difficulty against what a block currently costs.
     *
     * Without this the configured minDiff is an absolute number, and on a young
     * chain it can exceed the network difficulty -- at which point the easiest
     * share the pool will accept is harder than a block, no share is ever
     * submitted, and PPLNS has nothing to divide.
     */
    setNetworkDifficulty(d) {
        this.varDiff.setNetworkDifficulty(d);
    }

    listen() {
        const ports = this.config.ports || [{ port: 3333 }];

        for (const portCfg of ports) {
            // Plain stratum is not merely unencrypted -- it is unauthenticated.
            //
            // Anyone on the path between a miner and this pool can replace the
            // block template with their own. The miner then spends its
            // electricity on a job that pays a stranger, finds a block, and
            // sees nothing wrong: the pool never learns of it and the
            // dashboard shows a worker doing honest work. Miners connect to
            // this pool from Spain and the United States across the open
            // internet.
            //
            // The plain ports stay open. Turning them off would disconnect
            // every miner already here, and a pool that punishes people for
            // not upgrading loses them. This adds a port; it does not take
            // one away.
            let server;
            if (portCfg.tls) {
                let creds;
                try {
                    creds = {
                        cert: fs.readFileSync(portCfg.cert || this.config.tlsCert),
                        key: fs.readFileSync(portCfg.key || this.config.tlsKey),
                        // Stratum clients are miners, not browsers: no client
                        // certificates, and nothing below TLS 1.2.
                        minVersion: 'TLSv1.2',
                        honorCipherOrder: true,
                    };
                } catch (err) {
                    // Refusing to start beats listening in the clear on a port
                    // people were told is encrypted. A miner who connects to
                    // 3336 believes the wire is protected.
                    this.log.error(`stratum port ${portCfg.port} is configured for TLS but ` +
                                   `the certificate could not be read: ${err.message}`);
                    this.log.error('refusing to open it unencrypted -- fix the paths or ' +
                                   'remove "tls": true from that port');
                    process.exit(1);
                }
                server = tls.createServer(creds,
                    (socket) => this._onConnection(socket, portCfg));
                server.on('tlsClientError', (err, sock) => {
                    // Handshake failures are ordinary: port scanners, a plain
                    // miner pointed at the wrong port. Debug, not error.
                    this.log.debug(`tls handshake failed on ${portCfg.port} from ` +
                                   `${sock && sock.remoteAddress}: ${err.message}`);
                });
            } else {
                server = net.createServer((socket) => this._onConnection(socket, portCfg));
            }

            server.on('error', (err) => {
                this.log.error(`stratum port ${portCfg.port}: ${err.message}`);
                if (err.code === 'EADDRINUSE') process.exit(1);
            });

            server.listen(portCfg.port, this.config.bindAddress || '0.0.0.0', () => {
                this.log.info(`stratum listening on ${this.config.bindAddress || '0.0.0.0'}:` +
                              `${portCfg.port}${portCfg.tls ? ' (TLS)' : ''} (start diff ` +
                              `${portCfg.difficulty || this.config.startDifficulty || 1000})`);
            });

            this.servers.push(server);
        }

        // Rescue miners whose difficulty is too high to ever submit.
        this._idleTimer = setInterval(() => {
            for (const client of this.clients.values()) {
                if (!client.authorized) continue;
                const next = this.varDiff.onIdle(client.varDiffState);
                if (next !== null) client.sendDifficulty(next);
            }
        }, 30000);

        this._banTimer = setInterval(() => {
            const now = Date.now();
            for (const [ip, until] of this.bans) if (until < now) this.bans.delete(ip);
        }, 60000);
    }

    _onConnection(socket, portCfg) {
        const ip = socket.remoteAddress ? socket.remoteAddress.replace('::ffff:', '') : '?';

        const bannedUntil = this.bans.get(ip);
        if (bannedUntil && bannedUntil > Date.now()) {
            socket.destroy();
            return;
        }

        if (this.clients.size >= (this.config.maxConnections || 5000)) {
            this.log.warn(`connection limit reached; refusing ${ip}`);
            socket.destroy();
            return;
        }

        // A global cap alone is a denial of service with no cost to the
        // attacker. Authorising needs nothing but a valid WAM address, which is
        // free, and an authorised connection is exempt from the 30-second
        // timeout and never trips the invalid-share ban because it submits
        // nothing. One host opens five thousand connections, holds them, and
        // every real miner is refused.
        //
        // The cap has to allow a farm behind one NAT -- hundreds of rigs on one
        // address is ordinary -- so it is generous, and it is a limit on one
        // address rather than on everyone.
        const perIp = this.config.maxConnectionsPerIp || 128;
        let fromThisIp = 0;
        for (const c of this.clients.values()) {
            if (c.ip === ip && ++fromThisIp >= perIp) break;
        }
        if (fromThisIp >= perIp) {
            this.log.warn(`${ip} already holds ${fromThisIp} connections; refusing`);
            socket.destroy();
            return;
        }

        const client = new StratumClient(socket, this);
        if (portCfg.difficulty) {
            client.varDiffState = this.varDiff.createState(portCfg.difficulty);
        }

        this.clients.set(client.id, client);

        client.on('close', () => {
            this.clients.delete(client.id);
            if (client.authorized) {
                this.log.debug(`${client.label()} disconnected ` +
                               `(${client.shares.valid} valid / ${client.shares.invalid} invalid)`);
                this.emit('minerDisconnected', client.summary());
            }
        });

        client.on('authorized', () => this.emit('minerConnected', client.summary()));
    }

    broadcastJob(job, isNewBlock) {
        let sent = 0;
        for (const client of this.clients.values()) {
            if (!client.authorized) continue;
            client.sendJob(job, isNewBlock);
            sent++;
        }
        if (sent > 0) {
            this.log.debug(`broadcast job ${job.jobId} to ${sent} miners` +
                           (isNewBlock ? ' (new block)' : ''));
        }
    }

    /**
     * A miner authorizes with the address it wants to be paid at, so this is
     * the pool's only defence against paying out to a typo -- or to an address
     * on the wrong network, which would burn the payment.
     */
    validateMinerAddress(address) {
        // Accepts base58 (P2PKH/P2SH) and bech32/bech32m (P2WPKH/P2WSH/P2TR).
        // Rejecting segwit here would turn away most miners, since that is what
        // a default `getnewaddress` produces.
        return validateAddress(address, this.config.netVersions);
    }

    ban(ip) {
        this.bans.set(ip, Date.now() + (this.config.banDurationMs || 600000));
    }

    getConnectedMiners() {
        return [...this.clients.values()]
            .filter((c) => c.authorized)
            .map((c) => c.summary());
    }

    close() {
        clearInterval(this._idleTimer);
        clearInterval(this._banTimer);
        for (const client of this.clients.values()) client.disconnect();
        for (const server of this.servers) server.close();
    }
}

module.exports = StratumServer;
