#!/usr/bin/env node
'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  WAM Coin Stratum Pool -- entry point
// ===========================================================================
//
//    node server.js [--config config.json]
//
//  Startup order matters and is enforced:
//    1. load and validate config (fail fast on anything nonsensical)
//    2. connect to Redis and to at least one wamd
//    3. verify the pool's own payout address against THIS network
//    4. self-test the RandomX addon
//    5. pull the first block template (proves the daemon is patched)
//    6. only then open the stratum port
//
//  A pool that opens its port before step 5 will happily accept shares it can
//  never turn into a block.

const fs = require('fs');
const path = require('path');

const Redis = require('ioredis');

const Logger = require('./lib/logger');
const DaemonInterface = require('./lib/daemon');
const JobManager = require('./lib/jobManager');
const StratumServer = require('./lib/stratumServer');
const ShareProcessor = require('./lib/shareProcessor');
const ApiServer = require('./lib/api');
const { ADDRESS_VERSIONS, RANDOMX_EPOCH_BLOCKS, RANDOMX_EPOCH_LAG } = require('./lib/constants');
const { validateAddress } = require('./lib/util');

// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = { config: path.join(__dirname, 'config.json') };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--config' && argv[i + 1]) out.config = argv[++i];
        else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    }
    return out;
}

function loadConfig(file) {
    if (!fs.existsSync(file)) {
        throw new Error(
            `config file not found: ${file}\n` +
            'Copy config.example.json to config.json and edit it.');
    }

    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`config.json is not valid JSON: ${err.message}`);
    }

    // ---- required ---------------------------------------------------------
    const required = ['poolAddress', 'daemons'];
    for (const key of required) {
        if (!cfg[key]) throw new Error(`config is missing required key '${key}'`);
    }

    cfg.network = cfg.network || 'mainnet';
    if (!ADDRESS_VERSIONS[cfg.network]) {
        throw new Error(`unknown network '${cfg.network}'`);
    }
    cfg.netVersions = ADDRESS_VERSIONS[cfg.network];

    // The epoch rule is the same on every network -- src/wam/pow.cpp does not
    // special-case regtest -- so these are not per-network settings. They were,
    // once: the pool assumed short epochs off mainnet, rotated its key 1,840
    // blocks early, and every block it found came back 'high-hash'. They exist
    // now only to size the rotation countdown on the dashboard; the key itself
    // always comes from the daemon.
    cfg.randomxEpochBlocks = cfg.randomxEpochBlocks || RANDOMX_EPOCH_BLOCKS;
    cfg.randomxEpochLag = cfg.randomxEpochLag || RANDOMX_EPOCH_LAG;

    // ---- sanity -----------------------------------------------------------
    if (cfg.poolFeePercent !== undefined &&
        (cfg.poolFeePercent < 0 || cfg.poolFeePercent >= 100)) {
        throw new Error('poolFeePercent must be in [0, 100)');
    }

    if ((cfg.minimumPayoutWam || 1) <= 0) {
        throw new Error('minimumPayoutWam must be positive');
    }

    // Redis holds every miner's balance. Anything that can talk to it can
    // rewrite what the pool owes and to whom, and Redis answers anyone who
    // asks unless it has been told not to.
    //
    // Binding it to localhost is not the same as securing it: every process
    // and every user on the host is still "local", and the single most common
    // Redis incident in the wild is an operator widening `bind` for a second
    // machine and forgetting that nothing else was ever in the way.
    //
    // Found by an external reviewer of this repository, 2026-08-09. The pool
    // had been running against an unauthenticated Redis since the day it was
    // written.
    if (!cfg.redis || !cfg.redis.password) {
        throw new Error(
            'redis.password is missing.\n' +
            'Redis stores miner balances, and without a password anything on ' +
            'this machine can change them. Set `requirepass` in redis.conf and ' +
            'put the same value in config.json under redis.password.\n' +
            'install.sh generates one for you.');
    }
    if (/^(CHANGE_ME|password|redis|test|)$/i.test(String(cfg.redis.password).trim())) {
        throw new Error('redis.password is a placeholder. Use a real one; ' +
                        'install.sh will generate it.');
    }

    for (const d of cfg.daemons) {
        for (const key of ['host', 'port', 'user', 'password']) {
            if (d[key] === undefined) {
                throw new Error(`daemon entry is missing '${key}'`);
            }
        }
        if (d.password === 'CHANGE_ME' || d.password === '') {
            throw new Error('refusing to start with a placeholder RPC password');
        }
    }

    return cfg;
}

// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);

    if (args.help) {
        console.log('usage: node server.js [--config path/to/config.json]');
        return 0;
    }

    const config = loadConfig(args.config);

    const logger = new Logger({
        level: config.logLevel || 'info',
        file: config.logFile || null
    });
    const log = logger.scope('pool');

    log.info('='.repeat(66));
    log.info(' WAM Coin Stratum Pool');
    log.info('='.repeat(66));
    log.info(`network        : ${config.network}`);
    log.info(`pool address   : ${config.poolAddress}`);
    log.info(`reward mode    : ${(config.rewardMode || 'pplns').toUpperCase()}`);
    // `?? 1`, not `|| 1`. A configured fee of 0 is falsy, so `||` printed "1%"
    // on a pool that was charging nothing -- the same fault that made 0
    // impossible to configure at all until 2026-09-15 (shareProcessor.js:63),
    // fixed there and left here, where it survived as a startup banner that
    // disagreed with the pool it was announcing.
    log.info(`pool fee       : ${config.poolFeePercent ?? 1}%`);
    log.info('chain dev fee  : 5% (enforced by consensus, paid by the coinbase)');

    // ---- 1. pool payout address ------------------------------------------
    // Checked before anything expensive: a wrong-network address here means
    // every block the pool ever finds pays into a void.
    {
        const check = validateAddress(config.poolAddress, config.netVersions);
        if (!check.ok) {
            log.error(
                `poolAddress '${config.poolAddress}' is not usable on ${config.network}: ` +
                `${check.reason}`);
            log.error(`${config.network} addresses start with '${config.netVersions.firstChar}' ` +
                      `(base58) or '${config.netVersions.bech32}1' (bech32).`);
            return 1;
        }
        log.info(`pool address is a valid ${check.kind} address`);
    }

    // ---- 2. Redis ---------------------------------------------------------
    const redisHost = (config.redis && config.redis.host) || '127.0.0.1';

    // A password stops someone reading the balances; it does not stop them
    // reading the password. Off-host Redis without TLS puts both on the wire.
    if (redisHost !== '127.0.0.1' && redisHost !== 'localhost' && !config.redis.tls) {
        log.warn(`redis is at ${redisHost}, off this machine, with no TLS. ` +
                 'Miner balances and the Redis password both cross the network ' +
                 'in the clear. Set redis.tls, or keep Redis on the pool host.');
    }

    const redis = new Redis({
        host: redisHost,
        port: (config.redis && config.redis.port) || 6379,
        password: config.redis.password,
        db: (config.redis && config.redis.db) || 0,
        tls: config.redis.tls ? {} : undefined,
        maxRetriesPerRequest: 3,
        lazyConnect: true
    });

    redis.on('error', (err) => logger.scope('redis').error(err.message));

    try {
        await redis.connect();
        await redis.ping();
        log.info('redis connected');
    } catch (err) {
        log.error(`redis unavailable: ${err.message}`);
        return 1;
    }

    // ---- 3. daemons -------------------------------------------------------
    const daemon = new DaemonInterface(config.daemons, logger.scope('daemon'));
    try {
        await daemon.init();
    } catch (err) {
        log.error(err.message);
        return 1;
    }

    // Confirm the daemon agrees about which chain we are on.
    const chainInfo = await daemon.getBlockchainInfo();
    const expectedChain = config.network === 'mainnet' ? 'main'
                        : config.network === 'testnet' ? 'test' : 'regtest';
    if (chainInfo.chain !== expectedChain) {
        log.error(`config says network='${config.network}' but wamd reports ` +
                  `chain='${chainInfo.chain}'. Refusing to start.`);
        return 1;
    }

    // ---- 3b. can this pool actually pay anyone? --------------------------
    // The coinbase pays poolAddress, and payouts are `sendmany` from the
    // daemon's wallet. If that wallet does not hold poolAddress, the pool will
    // mine perfectly and then be unable to move a single coin -- a failure
    // that stays invisible until the first block matures, hours later, with
    // miners already owed money. Better to refuse to start.
    {
        let info;
        try {
            info = await daemon.cmd('getaddressinfo', [config.poolAddress]);
        } catch (err) {
            log.error(`could not check the payout address: ${err.message}`);
            log.error('The pool needs a loaded wallet to pay miners. Load one on ' +
                      'wamd and name it in config.json as daemons[].wallet.');
            return 1;
        }

        if (!info.ismine) {
            log.error(`the wallet does not own ${config.poolAddress}, so this pool ` +
                      'could never pay a miner.');
            log.error('Either set poolAddress to an address from the daemon wallet, ' +
                      'or point daemons[].wallet at the wallet that holds it.');
            return 1;
        }

        const walletName = config.daemons[0].wallet;
        log.info(`payout wallet   : ${walletName ? `'${walletName}'` : '(default)'} ` +
                 `holds the pool address`);
    }

    // ---- 3c. the RandomX epoch, from the chain ----------------------------
    // The epoch length differs per network -- 2048/64 on mainnet, 256/16 on
    // testnet, 64/4 on regtest -- and the pool has no business assuming which
    // one it is talking to. It used the mainnet constants everywhere, so on
    // testnet its "next rotation" countdown was out by 1,840 blocks.
    //
    // The seed itself already comes from getblocktemplate and was never at
    // risk. This is the countdown, the dashboard, and the drift warning.
    {
        const rx = await daemon.cmd('getrandomxinfo', []).catch(() => null);

        if (rx && Number.isInteger(rx.epoch_blocks) && Number.isInteger(rx.epoch_lag)) {
            if (rx.epoch_blocks !== config.randomxEpochBlocks ||
                rx.epoch_lag !== config.randomxEpochLag) {
                log.info(`randomx epoch   : ${rx.epoch_blocks} blocks, ${rx.epoch_lag} lag ` +
                         `(from the chain, not lib/constants.js)`);
            }
            config.randomxEpochBlocks = rx.epoch_blocks;
            config.randomxEpochLag = rx.epoch_lag;
        } else {
            log.warn('getrandomxinfo is unavailable; falling back to the epoch in ' +
                     'lib/constants.js. The rotation countdown may be wrong on a ' +
                     'network that does not use the mainnet epoch.');
        }
    }

    // ---- 4/5. job manager (self-tests RandomX, pulls the first template) --
    const jobManager = new JobManager(daemon, config, logger.scope('jobs'));

    try {
        await jobManager.start();
    } catch (err) {
        log.error(`could not start the job manager: ${err.message}`);
        return 1;
    }

    // ---- 6. accounting ----------------------------------------------------
    const shareProcessor = new ShareProcessor(redis, daemon, config, logger.scope('shares'));
    shareProcessor.setNetworkDifficulty(chainInfo.difficulty);
    shareProcessor.start();

    // ACCOUNTING HAPPENS IN THE ORDER IT WAS EMITTED, NOT IN THE ORDER REDIS
    // HAPPENS TO FINISH.
    //
    // These were two independent fire-and-forget calls. jobManager now emits
    // 'share' before 'block' for a block-finding share, but that only fixes
    // the order the two were STARTED in -- recordBlock reads the PPLNS window
    // and the round immediately, and recordShare writes to them, so the read
    // could still land first and take a snapshot without the winning share in
    // it. An ordering that holds only when Redis is fast is not an ordering.
    //
    // One chain, so each waits for the one before it. A failure is logged and
    // the chain continues -- an error must not stop every later share from
    // being recorded, which is what an uncaught rejection in the chain would
    // do.
    //
    // Serial rather than parallel is affordable here and would not be in a
    // large pool: these are small Redis writes at the rate miners find shares.
    // Correctness in the money path is worth more than the concurrency.
    let accounting = Promise.resolve();
    const inOrder = (what, fn) => {
        // The caller gets the real outcome; the chain gets a version that
        // cannot reject, so one failure never stops everything after it.
        const run = accounting.then(fn);
        accounting = run.catch((err) =>
            log.error(`failed to record ${what}: ${err.message}`));
        return run;
    };

    // The share is written down BEFORE the miner is told it counted.
    //
    // processShare awaits this, so a Redis failure reaches the miner as
    // "resubmit" instead of becoming a logged line about work he believes he
    // was paid for. A hook and not a listener, because an event cannot be
    // waited on.
    jobManager._record = (share) => inOrder('a share',
        () => shareProcessor.recordShare(share));

    // Where a solved block waits if the node cannot take it yet.
    //
    // A block is 47.5 WAM and used to exist only in a local variable until it
    // was accepted: a node down longer than the five-second retry, or this
    // process dying, lost it outright. Redis is already the thing this pool
    // trusts with miners' balances, so it is where the bytes go.
    //
    // A refused block is moved rather than deleted. The node read it and said
    // no, so it will never be worth anything -- but it is the only copy of
    // something a miner's electricity produced, and the reason it was refused
    // is worth more beside it than in a log that rotates.
    const spoolKey = `${config.redisPrefix || 'wam'}:blocks:unsent`;
    const refusedKey = `${config.redisPrefix || 'wam'}:blocks:refused`;
    jobManager._spoolStore = {
        async put(hash, entry) {
            await redis.hset(spoolKey, hash, JSON.stringify(entry));
        },
        async remove(hash, refusedReason) {
            if (refusedReason) {
                const raw = await redis.hget(spoolKey, hash);
                if (raw) {
                    await redis.hset(refusedKey, hash,
                        JSON.stringify({ ...JSON.parse(raw), refusedReason,
                                         refusedAt: Date.now() }));
                }
            }
            await redis.hdel(spoolKey, hash);
        },
        async all() {
            const map = await redis.hgetall(spoolKey);
            return Object.values(map || {}).map((v) => JSON.parse(v));
        }
    };

    // Before anything else, and then on a timer: offer whatever is still
    // sitting there. The start-up pass is the one that matters -- it is the
    // case where this process died holding a block.
    jobManager.drainSpool()
        .then((r) => { if (r.offered) log.warn(`block spool: ${r.offered} waiting, ${r.settled} settled`); })
        .catch((err) => log.error(`block spool drain failed: ${err.message}`));
    const drainEvery = (config.blockSpoolDrainSec || 60) * 1000;
    const spoolTimer = setInterval(() => {
        jobManager.drainSpool().catch((err) =>
            log.error(`block spool drain failed: ${err.message}`));
    }, drainEvery);
    spoolTimer.unref?.();

    jobManager.on('block', (share) => {
        inOrder(`block ${share.height}`, () => shareProcessor.recordBlock(share));
    });

    // ---- 7. stratum -------------------------------------------------------
    const stratum = new StratumServer(jobManager, config, logger.scope('stratum'));
    // Before listen(), so the first miner to connect is already handed a share
    // difficulty the chain can actually produce.
    stratum.setNetworkDifficulty(chainInfo.difficulty);
    stratum.listen();

    // ---- 8. dashboard -----------------------------------------------------
    const api = new ApiServer({
        config, logger: logger.scope('api'), jobManager,
        stratumServer: stratum, shareProcessor, daemon
    });
    api.listen();

    // Keep the difficulty used for PPLNS window sizing -- and for capping the
    // share difficulty -- fresh. A chain whose difficulty moves by orders of
    // magnitude in its first weeks will otherwise be measured against the
    // number it had when the pool booted.
    const diffTimer = setInterval(async () => {
        try {
            const info = await daemon.getBlockchainInfo();
            shareProcessor.setNetworkDifficulty(info.difficulty);
            stratum.setNetworkDifficulty(info.difficulty);
        } catch { /* the daemon layer already logged it */ }
    }, 60000);

    log.info('pool is up');

    // ---- shutdown ---------------------------------------------------------
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`${signal} received, shutting down`);

        clearInterval(diffTimer);
        stratum.close();
        api.close();
        jobManager.stop();
        shareProcessor.stop();

        try {
            // One last payment run so miners are not left waiting on a restart.
            await shareProcessor.checkPendingBlocks();
        } catch { /* best effort */ }

        await redis.quit().catch(() => {});
        log.info('goodbye');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason) => {
        log.error(`unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
    });
    process.on('uncaughtException', (err) => {
        log.error(`uncaught exception: ${err.stack || err.message}`);
        // A pool in an unknown state must not keep taking shares.
        shutdown('uncaughtException');
    });

    return new Promise(() => {});   // run until a signal arrives
}

main().then((code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code);
}).catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
