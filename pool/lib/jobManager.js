'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  JobManager -- template polling, seed rotation, and share validation
// ===========================================================================

const EventEmitter = require('events');

const BlockTemplate = require('./blockTemplate');
const randomx = require('../native');
const { seedHeightFor, blocksUntilNextSeed } = require('./randomxSeed');
const {
    reverseBuffer, hashToBigIntLE, difficultyToTarget, targetToDifficulty
} = require('./util');
const { HEADER_SIZE, EXTRANONCE2_SIZE } = require('./constants');
// What the node meant by its answer is decided in daemon.js and nowhere else.
const { SUBMIT } = require('./daemon');

/** Reject codes, mirroring the stratum convention used by every miner. */
const REJECT = {
    JOB_NOT_FOUND:   [21, 'job not found or stale'],
    DUPLICATE:       [22, 'duplicate share'],
    LOW_DIFFICULTY:  [23, 'share above target'],
    UNAUTHORIZED:    [24, 'unauthorized worker'],
    NOT_SUBSCRIBED:  [25, 'not subscribed'],
    BAD_NTIME:       [26, 'ntime out of range'],
    BAD_NONCE_SIZE:  [27, 'malformed nonce or extranonce2'],
    INTERNAL:        [20, 'internal error'],
    // The share was good and we could not write it down. Told apart from
    // INTERNAL on purpose: this one means "send it again", and the miner's
    // claim on it has been released so that he can.
    UNAVAILABLE:     [20, 'share not recorded, please resubmit'],
    // The verification queue is full. Also "send it again", and also with the
    // claim released -- but told apart from UNAVAILABLE so an operator reading
    // the counters can see the difference between redis failing and the pool
    // being saturated. They need opposite responses.
    BUSY:            [20, 'verification queue full, please resubmit']
};

class JobManager extends EventEmitter {
    constructor(daemon, config, logger) {
        super();
        this.daemon = daemon;
        this.config = config;
        this.log = logger;

        // How a share is made durable before the miner is told it counted.
        //
        // An event cannot be awaited, so this is a hook rather than another
        // emit: server.js sets it to the ordered accounting chain, and
        // processShare waits for it. Left as a resolved promise so a pool
        // assembled without one still runs -- the tests do exactly that -- and
        // so that forgetting to set it degrades to the old behaviour loudly in
        // review rather than silently at runtime.
        this._record = async () => {};

        // How many share verifications may be in flight at once.
        //
        // Sized from the VM count, because that is what actually limits the
        // work: beyond a few per VM the surplus only waits somewhere worse --
        // on a libuv threadpool thread, inside a condition variable, holding a
        // thread the rest of the process needs. The floor of 32 keeps a small
        // pool responsive when vmCount is 1 or 2.
        // THE BOUND STOPPED THE QUEUE GROWING AND NOT THE THREADS BLOCKING.
        //
        // It was max(32, vmCount * 4). With four VMs that admitted 32 workers
        // to the addon while only four could hash -- so twenty-eight sat in
        // cv.wait, each holding a libuv threadpool thread, and the pool has
        // four of those for the whole process. Queue growth was bounded;
        // worker-thread starvation was not.
        //
        // dang150296 (Urriki1502) said exactly that against bb6d521, and he is
        // right: bounding the wrong thing is not bounding it.
        //
        // So there are two numbers now. `_vmSlots` is how many may be inside
        // the addon at once, and it is the VM count, so no worker ever waits on
        // a VM and no threadpool thread is ever held by one. Everything else
        // waits HERE, in JavaScript, where waiting costs a closure and not a
        // thread -- and `_maxVerifying` bounds that queue so the memory is
        // finite too.
        const vms = Math.max(1, config.randomxVmCount || 4);
        this._vmSlots = vms;
        this._inAddon = 0;
        this._waiting = [];
        this._maxVerifying = config.maxPendingVerifications || Math.max(32, vms * 8);
        this._verifying = 0;

        this.currentJob = null;
        this.validJobs = new Map();          // jobId -> BlockTemplate
        this.maxJobHistory = config.maxJobHistory || 4;

        this.extranonce1Counter = 0;
        this.pollTimer = null;
        this.lastTemplateAt = 0;

        this.stats = {
            templates: 0,
            blocksFound: 0,
            seedRotations: 0,
            lastSeedHeight: null,
            // Shares refused because the verification queue was full. A number
            // that is not zero means either a flood or a pool too small for
            // the hash rate pointed at it, and an operator needs to be able to
            // tell those from redis failing.
            verifyRejected: 0
        };
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    async start() {
        randomx.configure({
            // A verification pool stays in LIGHT mode: 256 MiB rather than
            // 2 GiB per live seed. Verifying shares is not throughput-bound.
            fullMemory: this.config.randomxFullMemory === true,
            vmCount: this.config.randomxVmCount || 4,
            maxSeeds: 2
        });

        this.log.info(`RandomX addon self-test: ${randomx.selfTest().slice(0, 16)}...`);

        await this.refreshTemplate(true);

        const interval = this.config.blockRefreshInterval || 1000;
        this.pollTimer = setInterval(() => {
            this.refreshTemplate(false).catch((err) =>
                this.log.error(`template refresh failed: ${err.message}`));
        }, interval);
    }

    stop() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
    }

    /** Pool-assigned per-connection extranonce1. */
    nextExtranonce1() {
        const buf = Buffer.allocUnsafe(4);
        buf.writeUInt32BE((++this.extranonce1Counter) >>> 0, 0);
        return buf;
    }

    // -----------------------------------------------------------------------
    // Templates
    // -----------------------------------------------------------------------

    async refreshTemplate(force) {
        const rpc = await this.daemon.getBlockTemplate();

        const isNewBlock = !this.currentJob ||
                           rpc.previousblockhash !== this.currentJob.previousBlockHash;

        // Rebuild on a new tip, when forced, or periodically so that newly
        // arrived transactions (and their fees) reach miners.
        const stale = Date.now() - this.lastTemplateAt >
                      (this.config.jobRebroadcastTimeout || 55) * 1000;

        if (!force && !isNewBlock && !stale) return;

        // THE CLAIM FOLLOWS THE WORK ACROSS JOBS AT ONE HEIGHT.
        //
        // This rebuilds every jobRebroadcastTimeout seconds even when the tip
        // has not moved, so that newly arrived transactions reach miners --
        // and on this chain the mempool is almost always empty, so the new
        // job's coinbase, merkle root and header come out byte-identical to
        // the old one's. One solution was therefore valid under every live
        // job, and each job's own Set let it be claimed again: up to three
        // credits on mainnet for one unit of electricity, taken out of the
        // other miners in the PPLNS round.
        //
        // Reported by Alboy on 2026-10-11 as WAM-F5.
        //
        // Carrying the Set means the claim is scoped to the work. isNewBlock
        // is the one case that must NOT carry it: a new tip is new work, and
        // reusing the Set there would refuse honest shares for ever.
        const template = new BlockTemplate(rpc, {
            poolAddress: this.config.poolAddress,
            netVersions: this.config.netVersions,
            coinbaseSignature: this.config.coinbaseSignature,
            extranonce1Size: 4,
            submits: isNewBlock ? undefined : (this.currentJob && this.currentJob.submits)
        });

        // ---- RandomX seed for this height ---------------------------------
        //
        // Taken from the daemon verbatim, exactly as the treasury amount is.
        // The epoch rule is consensus: get it wrong by one block and every
        // share the pool accepts is invalid, every block it submits comes back
        // 'high-hash', and the miners are the ones who paid for the
        // electricity. Re-deriving it here would mean a second implementation
        // of a consensus rule, in a second language, drifting from the first.
        //
        // The wire value is a uint256 rendered big-endian; RandomX is keyed
        // with the internal bytes, so it has to be reversed.
        const seedHex = rpc.randomx_seedhash;
        if (typeof seedHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
            throw new Error(
                'getblocktemplate did not return a usable `randomx_seedhash`.\n' +
                'This pool only works against a patched wamd. Guessing the RandomX ' +
                'key would make every share it accepts worthless.');
        }

        const seed = reverseBuffer(Buffer.from(seedHex, 'hex'));
        const seedHeight = typeof rpc.randomx_seedheight === 'number'
            ? rpc.randomx_seedheight
            : null;

        template.seedHash = seed;
        template.seedHeight = seedHeight;

        const bootstrap = seedHeight === 0;

        // Cross-check against our own copy of the epoch constants. The daemon
        // wins either way -- this only tells the operator that lib/constants.js
        // has drifted from the chain, which would make the rotation countdown
        // below a lie.
        if (!this._seedRuleWarned && seedHeight !== null) {
            const derived = seedHeightFor(template.height,
                this.config.randomxEpochBlocks, this.config.randomxEpochLag);
            if (derived !== seedHeight) {
                this._seedRuleWarned = true;
                this.log.warn(
                    `this pool would have derived RandomX seed height ${derived} for ` +
                    `block ${template.height}, but the chain says ${seedHeight}. ` +
                    'Using the chain. Check RANDOMX_EPOCH_BLOCKS and RANDOMX_EPOCH_LAG ' +
                    'in lib/constants.js against src/wam/wam-params.h.');
            }
        }

        if (this.stats.lastSeedHeight !== null && this.stats.lastSeedHeight !== seedHeight) {
            this.stats.seedRotations++;
            this.log.warn(
                `RandomX seed rotated: height ${this.stats.lastSeedHeight} -> ${seedHeight}. ` +
                'Miners will rebuild their datasets; expect a brief hashrate dip.');
        }
        this.stats.lastSeedHeight = seedHeight;

        // ---- publish -------------------------------------------------------
        this.currentJob = template;
        this.lastTemplateAt = Date.now();
        this.stats.templates++;

        this.validJobs.set(template.jobId, template);
        while (this.validJobs.size > this.maxJobHistory) {
            this.validJobs.delete(this.validJobs.keys().next().value);
        }

        if (isNewBlock) {
            // A new tip invalidates everything: old jobs build on a dead parent.
            this.validJobs.clear();
            this.validJobs.set(template.jobId, template);
        }

        this.log.info(
            `job ${template.jobId} height=${template.height} ` +
            `txs=${template.transactions.length} ` +
            `reward=${(template.coinbaseValue / 1e8).toFixed(8)} WAM ` +
            `(devfee ${(template.devFeeAmount / 1e8).toFixed(8)}, ` +
            `miners ${(template.distributableValue / 1e8).toFixed(8)}) ` +
            `seed=${bootstrap ? 'bootstrap' : seedHeight} ` +
            `rotate_in=${blocksUntilNextSeed(template.height,
                this.config.randomxEpochBlocks, this.config.randomxEpochLag)}`);

        this.emit('newJob', template, isNewBlock);
    }

    // -----------------------------------------------------------------------
    // Share validation
    // -----------------------------------------------------------------------

    /**
     * Validate one mining.submit.
     *
     * Returns { valid, error, share } where `share` carries everything the
     * accounting layer needs. This function is the pool's security boundary:
     * every field below arrives from an untrusted miner.
     */
    async processShare(submission) {
        const {
            jobId, extranonce1, extranonce2Hex, nTimeHex, nonceHex,
            workerName, difficulty, ipAddress
        } = submission;

        const job = this.validJobs.get(jobId);
        if (!job) return this._reject(REJECT.JOB_NOT_FOUND, workerName);

        // ---- shape checks --------------------------------------------------
        if (typeof extranonce2Hex !== 'string' ||
            extranonce2Hex.length !== EXTRANONCE2_SIZE * 2 ||
            !/^[0-9a-fA-F]+$/.test(extranonce2Hex)) {
            return this._reject(REJECT.BAD_NONCE_SIZE, workerName);
        }
        if (typeof nonceHex !== 'string' || nonceHex.length !== 8 ||
            !/^[0-9a-fA-F]+$/.test(nonceHex)) {
            return this._reject(REJECT.BAD_NONCE_SIZE, workerName);
        }
        if (typeof nTimeHex !== 'string' || nTimeHex.length !== 8 ||
            !/^[0-9a-fA-F]+$/.test(nTimeHex)) {
            return this._reject(REJECT.BAD_NTIME, workerName);
        }

        const nTime = parseInt(nTimeHex, 16);
        const nonce = parseInt(nonceHex, 16);

        // A miner may roll ntime forward, but not backwards past the template
        // and not more than 2 minutes into the future -- beyond that the block
        // would be rejected by peers for a bad timestamp.
        const nowSec = Math.floor(Date.now() / 1000);
        if (nTime < job.curTime || nTime > nowSec + 120) {
            return this._reject(REJECT.BAD_NTIME, workerName);
        }

        // ---- duplicate detection ------------------------------------------
        const e1hex = extranonce1.toString('hex');
        // The PARSED nTime and nonce, not the hex they arrived as: two
        // spellings of one number must not be two shares. See
        // submitKey in blockTemplate.js.
        if (!job.registerSubmit(e1hex, extranonce2Hex, nTime, nonce)) {
            return this._reject(REJECT.DUPLICATE, workerName);
        }

        // Everything below can reject, and a rejected share must give its claim
        // back -- it was never credited, so nothing needs to remember it, and
        // keeping it would let anyone fill the set for free. `finally` rather
        // than a release call on each path, so a rejection added here later
        // cannot silently reintroduce the leak.
        let credited = false;
        try {
            // ---- rebuild exactly what the miner hashed --------------------
            const extranonce2 = Buffer.from(extranonce2Hex, 'hex');
            const coinbase = job.serializeCoinbase(extranonce1, extranonce2);
            const merkleRoot = job.computeMerkleRoot(coinbase);
            const header = job.serializeHeader(merkleRoot, nTime, nonce);

            if (header.length !== HEADER_SIZE) {
                this.log.error(`built a ${header.length}-byte header; expected ${HEADER_SIZE}`);
                return this._reject(REJECT.INTERNAL, workerName);
            }

            // ---- the expensive part, off the event loop -------------------
            //
            // AND BOUNDED, BECAUSE "OFF THE EVENT LOOP" IS NOT "FREE".
            //
            // randomx.hash queues a Napi::AsyncWorker on the libuv threadpool,
            // and that worker's first act is to wait on a condition variable
            // until one of vmCount RandomX VMs is free. A waiting worker is a
            // BLOCKED THREADPOOL THREAD, and the default pool is four threads
            // for the whole process -- shared with dns, fs and crypto.
            //
            // So an unbounded queue here is not merely memory. Anyone who can
            // open a socket and send syntactically valid submissions can park
            // every threadpool thread in cv.wait and stall everything else the
            // pool does, having spent nothing: sending a share is bytes, and
            // verifying one is milliseconds of a scarce VM.
            //
            // Queueing more than a few per VM buys nothing anyway -- they only
            // wait in a different place -- so the queue is capped and the
            // surplus is refused at the door, with a code that tells the miner
            // to send it again rather than leaving him guessing. The claim is
            // released by the finally below, so he can.
            //
            // Reported by dang150296 (Urriki1502) on 2026-10-04 as a RandomX
            // verification queue with no explicit in-flight bound.
            if (this._verifying >= this._maxVerifying) {
                this.stats.verifyRejected++;
                return this._reject(REJECT.BUSY, workerName);
            }

            let powHash;
            this._verifying++;
            try {
                powHash = await this._hashWithOneVm(job.seedHash, header);
            } catch (err) {
                this.log.error(`RandomX hashing failed: ${err.message}`);
                return this._reject(REJECT.INTERNAL, workerName);
            } finally {
                this._verifying--;
            }

            const hashValue = hashToBigIntLE(powHash);
            const shareTarget = difficultyToTarget(difficulty);
            const shareDiff = targetToDifficulty(hashValue > 0n ? hashValue : 1n);

            // ---- did it solve the block? ----------------------------------
            const isBlockCandidate = hashValue <= job.target;

            if (!isBlockCandidate && hashValue > shareTarget) {
                this.log.debug(
                    `low-difficulty share from ${workerName}: ` +
                    `diff ${shareDiff.toFixed(6)} < required ${difficulty}`);
                return this._reject(REJECT.LOW_DIFFICULTY, workerName, { shareDiff });
            }

            const share = {
                jobId,
                height: job.height,
                worker: workerName,
                ipAddress,
                difficulty,
                shareDiff,
                blockCandidate: isBlockCandidate,
                blockHash: null,
                powHash: powHash.toString('hex'),
                distributableValue: job.distributableValue,
                devFeeAmount: job.devFeeAmount,
                coinbaseValue: job.coinbaseValue,
                time: Date.now()
            };

            // THE SHARE IS CREDITED BEFORE THE BLOCK IS SUBMITTED, AND THE
            // ORDER IS THE WHOLE POINT.
            //
            // _submitBlock emits 'block', whose listener snapshots the PPLNS
            // window and the round and then resets the round. This emitted
            // 'share' afterwards -- so the share that FOUND the block was not
            // in the snapshot of its own block's payout. It landed in the next
            // round instead, which pays it at the next block's rate to
            // whoever is mining then. The miner who found the block is the one
            // the ordering short-changed.
            //
            // Reported by dang150296 (Urriki1502) on 2026-10-04 as winning-
            // share accounting order.
            //
            // Nothing is credited early by this. Every validity check above
            // has already passed; the share met the share target, which is
            // what a share is paid for, and that is true whether or not the
            // block is then accepted by the node. `credited` moves with it so
            // that a throw inside _submitBlock cannot release a claim for work
            // that has already been paid -- which would be the double-credit
            // the claim exists to prevent.
            // A BLOCK GOES TO THE NODE FIRST, BECAUSE SECONDS DECIDE IT.
            //
            // Nothing is recorded or acknowledged before this. A block is
            // worth 47.5 WAM and is lost to whoever is a second quicker, so
            // no accounting may stand in front of it. _submitBlock no longer
            // emits anything -- it submits, records on the share whether the
            // node took it, and returns.
            if (isBlockCandidate) {
                await this._submitBlock(job, header, coinbase, share);
            }

            // THEN THE SHARE IS MADE DURABLE, AND ONLY THEN IS IT CREDITED.
            //
            // The miner used to be told "accepted" while the Redis write was
            // still a promise nobody waited for, with .catch(log) behind it.
            // If that write failed the share was gone: the miner had been
            // told it counted, the pool had no record of it, and the only
            // trace was a line in a log nobody reads.
            //
            // `credited` is set after the record succeeds, so a failure
            // releases the claim through the finally below and the miner can
            // submit the same share again -- which is the whole point of
            // telling him it failed rather than lying and dropping it.
            //
            // Reported by dang150296 (Urriki1502), 2026-10-04.
            try {
                await this._record(share);
            } catch (err) {
                // A DUPLICATE AND A FAILURE NEED OPPOSITE ANSWERS.
                //
                // UNAVAILABLE means "send it again", and for a share whose
                // proof of work is already counted that is wrong twice over:
                // the resubmission cannot be credited, and the miner loops.
                // The record layer tags that case so it can be answered with
                // the code that already exists for it.
                if (err && err.duplicateShare) {
                    return this._reject(REJECT.DUPLICATE, workerName);
                }
                this.log.error(`could not record a share from ${workerName}: ` +
                               `${err.message}`);
                return this._reject(REJECT.UNAVAILABLE, workerName);
            }

            credited = true;
            this.emit('share', share);

            // And the block's payout accounting last of all, so the snapshot
            // it takes of the round already contains the share that found it.
            if (isBlockCandidate && share.blockAccepted) {
                this.emit('block', share);
            }
            return { valid: true, share };
        } finally {
            if (!credited) {
                job.releaseSubmit(e1hex, extranonce2Hex, nTime, nonce);
            }
        }
    }

    // -----------------------------------------------------------------------
    //  The spool: a solved block that outlives this process
    // -----------------------------------------------------------------------
    //
    //  Where it is kept is injected rather than built here. jobManager has no
    //  redis of its own and should not grow one -- server.js passes a pair of
    //  functions, and the tests pass a Map. A jobManager assembled without one
    //  keeps the old behaviour and says so once, loudly, rather than silently
    //  dropping the protection.

    /**
     * Hash, with at most one worker per VM inside the addon at a time.
     *
     * The native worker's first act is to wait on a condition variable until a
     * RandomX VM is free, and a worker waiting there is holding a libuv
     * threadpool thread -- four for the whole process, shared with dns, fs and
     * crypto. Admitting more workers than there are VMs therefore converts
     * surplus submissions into blocked threads, which is the starvation the
     * in-flight bound alone did not prevent.
     *
     * Waiting in JavaScript instead costs a promise and a closure. The queue
     * is still bounded by _maxVerifying at the call site, so this is a
     * different place to wait rather than an unbounded one.
     */
    async _hashWithOneVm(seedHash, header) {
        if (this._inAddon >= this._vmSlots) {
            await new Promise((resolve) => this._waiting.push(resolve));
        }
        this._inAddon++;
        try {
            return await randomx.hash(seedHash, header);
        } finally {
            this._inAddon--;
            const next = this._waiting.shift();
            if (next) next();
        }
    }

    async _spool(entry) {
        if (!this._spoolStore) {
            if (!this._warnedNoSpool) {
                this._warnedNoSpool = true;
                this.log.warn('no block spool is configured: a solved block only ' +
                              'exists in memory until the node accepts it');
            }
            return;
        }
        await this._spoolStore.put(entry.hash, entry);
    }

    async _unspool(hash, refusedReason) {
        if (!this._spoolStore) return;
        await this._spoolStore.remove(hash, refusedReason);
    }

    /**
     * Release a spooled block once its payout record exists.
     *
     * The only caller is the 'block' listener, after recordBlock has
     * returned. Nothing else may remove an accepted block from the spool:
     * the entry IS the evidence that a block reached the chain without being
     * paid for, and it has to outlive every step between those two facts.
     *
     * A failure here is not an error worth propagating -- the entry simply
     * stays, the next drain offers it again, the node answers ALREADY_HAVE,
     * and recordBlock no-ops on the hash it has already recorded. The cost of
     * failing to remove it is one wasted round trip a minute; the cost of
     * removing it too early is a block nobody is paid for.
     */
    async unspoolRecorded(hash) {
        if (!hash) return;
        try {
            await this._unspool(hash);
        } catch (err) {
            this.log.warn(`block ${hash.slice(0, 16)}... is recorded but could ` +
                          `not be removed from the spool: ${err.message} -- the ` +
                          'next drain will offer it again and recordBlock will ' +
                          'no-op');
        }
    }

    /**
     * Offer every spooled block to the node again.
     *
     * Called at start-up and on a timer. The expensive case -- a block sitting
     * here for an hour while a node is down -- is exactly the case the spool
     * exists for, so this does not give up on age: a block is only removed
     * when a node has LOOKED at it and answered, which includes "duplicate",
     * the answer meaning it was already accepted.
     */
    async drainSpool() {
        if (!this._spoolStore) return { offered: 0, settled: 0 };
        let entries;
        try {
            entries = await this._spoolStore.all();
        } catch (err) {
            this.log.error(`could not read the block spool: ${err.message}`);
            return { offered: 0, settled: 0 };
        }

        let settled = 0;
        for (const e of entries) {
            let result;
            try {
                result = await this.daemon.submitBlock(e.hex);
            } catch (err) {
                this.log.warn(`spooled block ${e.height} could not be offered: ` +
                              `${err.message}`);
                continue;
            }
            if (result.accepted) {
                this.log.info(`*** SPOOLED BLOCK ${e.height} ACCEPTED *** ` +
                              `found ${Math.round((Date.now() - e.foundAt) / 1000)}s ` +
                              'ago, by ' + e.worker);
                this.stats.blocksFound++;
                // Not unspooled here. The emit is fire-and-forget -- the
                // listener queues recordBlock and returns -- so removing the
                // entry on this line would delete it while the accounting it
                // is protecting has not run yet, which is the same fault the
                // accept path in _submitBlock had. unspoolRecorded() below is
                // called once the record exists.
                this._emitRecovered(e);
                settled++;
                continue;
            }
            if (result.verdict === SUBMIT.ALREADY_HAVE) {
                // THE NODE ALREADY HAS IT, AND THAT IS NOT THE SAME AS IT
                // HAVING BEEN PAID.
                //
                // The window this spool exists for includes dying between the
                // node accepting a block and the payout being recorded. Coming
                // back, the drain is told "duplicate", and the first version of
                // this treated that as settled and removed the entry without
                // emitting anything -- so the block was on the chain and the
                // miners who earned it were never paid. The one crash the spool
                // was built for was the one it did not cover.
                //
                // Emitting is only safe because recordBlock is idempotent on
                // the block hash now: if the payout was already made, it is a
                // no-op. Without that it would re-run `del(round)` and wipe a
                // live round's contributions, which is worse than the fault.
                //
                // Found by dang150296 (Urriki1502) against bb6d521.
                this.log.info(`spooled block ${e.height} is already on the node; ` +
                              'offering it for payout in case the crash was ' +
                              'between acceptance and accounting');
                // Same reason as the accepted branch: the record does not
                // exist yet when this returns, so the entry is not ours to
                // remove. A block whose payout is already recorded costs one
                // idempotent no-op per drain until the unspool lands.
                this._emitRecovered(e);
                settled++;
            } else if (result.verdict === SUBMIT.REFUSED) {
                this.log.error(`spooled block ${e.height} was read and refused: ` +
                               `${result.reasons.join(' | ')} -- it will not be ` +
                               'offered again');
                await this._unspool(e.hash, result.reasons.join(' | '));
                settled++;
            }
            // Otherwise nothing answered, and it stays for the next drain.
        }
        return { offered: entries.length, settled };
    }

    /**
     * Hand a recovered block to the payout accounting, whole.
     *
     * recordBlock needs the reward values as well as the identity, and the
     * drain is the one caller that cannot get them from a live job -- the job
     * is gone, possibly with the process that held it. They come out of the
     * spool entry, which is why they are written into it.
     *
     * The window and round it will be paid from are TODAY'S, not the ones that
     * existed when the block was found. There is no way back to those: the
     * round moved on. For a restart measured in seconds that is the same set
     * of miners; for a block recovered an hour later it is not, and the log
     * says so rather than leaving it to be worked out from a payout that looks
     * wrong.
     */
    _emitRecovered(e) {
        const age = Math.round((Date.now() - (e.foundAt || Date.now())) / 1000);
        if (age > 300) {
            this.log.warn(`block ${e.height} is being paid ${age}s after it was ` +
                          'found, so its payout is computed from the round as it ' +
                          'stands now, not the round that earned it');
        }
        this.emit('block', {
            height: e.height,
            blockHash: e.hash,
            worker: e.worker,
            blockAccepted: true,
            fromSpool: true,
            coinbaseValue: e.coinbaseValue,
            distributableValue: e.distributableValue,
            devFeeAmount: e.devFeeAmount
        });
    }

    async _submitBlock(job, header, coinbase, share) {
        const blockHex = job.serializeBlock(header, coinbase).toString('hex');
        // Block id is the double-SHA256 of the header, NOT the RandomX hash.
        const blockHash = reverseBuffer(require('./util').sha256d(header)).toString('hex');
        share.blockHash = blockHash;

        this.log.info(`*** BLOCK CANDIDATE at height ${job.height} by ${share.worker} ***`);
        this.log.info(`    hash ${blockHash}`);

        // SPOOLED BEFORE IT IS OFFERED, BECAUSE FIVE SECONDS IS A GUESS.
        //
        // The retry below covers a node that is restarting, and five seconds
        // was chosen because that is how long the restart on 5 September took.
        // A node that takes thirty seconds to load its wallet, or a machine
        // that reboots, still loses the block -- and a block is 47.5 WAM, the
        // largest single loss this pool can suffer. The whole of it lives in a
        // local variable until it is accepted.
        //
        // So the bytes go somewhere durable first. If this process dies, if
        // the node stays down for an hour, if the retries run out -- the block
        // is still there to be sent, by the spool drain or by hand.
        //
        // Reported by dang150296 (Urriki1502) on 2026-10-04: solved-block
        // retry is memory-only.
        //
        // Spooling cannot be allowed to delay the submission, so a failure to
        // spool is logged and the block is offered anyway. Losing the safety
        // net is bad; holding the block while writing to it is worse.
        // EVERYTHING THE PAYOUT WILL NEED, NOT JUST THE BYTES.
        //
        // The first version of this spooled height, hash, hex and worker. The
        // block came back after a restart and recordBlock threw on
        // `blockValue must be a non-negative number of base units, got
        // undefined`, because the reward fields were never written down. The
        // block was recovered onto the chain, removed from the spool, and
        // nobody was paid for it -- the same loss the spool exists to prevent,
        // moved one step later.
        //
        // Found by dang150296 (Urriki1502) against bb6d521, the commit that
        // introduced it, within hours.
        const spooled = { height: job.height, hash: blockHash, hex: blockHex,
                          worker: share.worker, foundAt: Date.now(),
                          coinbaseValue: job.coinbaseValue,
                          distributableValue: job.distributableValue,
                          devFeeAmount: job.devFeeAmount };
        try {
            await this._spool(spooled);
        } catch (err) {
            this.log.error(`could not spool block ${job.height} before ` +
                           `submitting it (${err.message}); submitting anyway`);
        }

        let result = await this.daemon.submitBlock(blockHex);

        // A daemon that could not answer has not rejected the block.
        //
        // submitblock reports two very different things down one channel. An
        // RPC-level failure -- r.ok === false -- means the node never looked
        // at the block: it was starting, loading its wallet, or not
        // listening. A string result means it looked and refused. The first
        // is transient and the block is still worth a full reward. The second
        // is final and retrying it is pointless.
        //
        // On 5 September 2026 the node here was restarted to install v0.1.7
        // while a miner was working. Block 5783 was solved inside that
        // window, came back "REJECTED: Loading wallet...", and was thrown
        // away. One second later the daemon logged "recovered". On testnet
        // that cost nothing. On mainnet it is a miner's block reward, and it
        // would have been discarded by us, during a restart we chose, with
        // nothing but a line in a log to say it had happened.
        //
        // Retried inline, before the share is credited, so blockAccepted is
        // final by the time the record is written and nothing downstream has
        // to learn about a late arrival. Five seconds at the very worst, on a
        // path that is only taken when no daemon is answering at all.
        const RETRIES = 5;
        const GAP_MS = 1000;
        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            // Only silence is worth retrying. An answer -- accepted, already
            // held, or refused -- is an answer, and sending the block again
            // cannot change it. This asked the results directly before, which
            // is a fourth reading of the node's vocabulary waiting to drift.
            if (result.verdict !== SUBMIT.UNANSWERED) break;
            this.log.warn(`block ${job.height}: no daemon could answer ` +
                          `(${result.reasons.join(' | ')}) -- ` +
                          `retrying ${attempt}/${RETRIES}`);
            await new Promise((r) => setTimeout(r, GAP_MS));
            result = await this.daemon.submitBlock(blockHex);
        }

        if (result.accepted) {
            this.stats.blocksFound++;
            share.blockAccepted = true;
            this.log.info(`*** BLOCK ${job.height} ACCEPTED *** ` +
                          `reward ${(job.coinbaseValue / 1e8).toFixed(8)} WAM, ` +
                          `${(job.distributableValue / 1e8).toFixed(8)} WAM to miners, ` +
                          `${(job.devFeeAmount / 1e8).toFixed(8)} WAM to treasury`);
            // The payout accounting for this block is NOT emitted here any
            // more. processShare emits it after the winning share has been
            // recorded, because the listener snapshots the round and the
            // winner has to be in it. What stays here is the only thing that
            // is urgent: getting every miner onto the new tip.
            this.refreshTemplate(true).catch(() => {});
            // THE SPOOL ENTRY STAYS UNTIL THE PAYOUT RECORD EXISTS.
            //
            // This used to unspool here, reasoning that a block on the chain
            // has nothing left to protect. But drainSpool's own comment says
            // what the spool is for: "dying between the node accepting a
            // block and the payout being recorded". Deleting the entry at
            // acceptance threw the evidence away at the START of that window
            // instead of the end of it, and the recovery path below was left
            // with nothing to offer.
            //
            // What that cost: _record() runs after this returns. If it threw
            // -- a redis blip is enough -- processShare returned UNAVAILABLE
            // before `credited`, before emit('share') and before
            // emit('block'). The block was on the chain, no 'block' event
            // ever fired, recordBlock is the only writer of blocks:pending
            // and never ran, the resubmission hit JOB_NOT_FOUND because
            // refreshTemplate(true) had already cleared the job, and the
            // drain found an empty spool. 47.5 WAM on the chain, credited to
            // nobody, with no path back. The one crash the spool was built
            // for was the one it did not cover.
            //
            // The entry is now removed by whoever has seen the payout record
            // exist -- the 'block' listener in server.js, after recordBlock
            // returns. recordBlock is idempotent on the block hash, so an
            // entry offered a second time costs nothing.
            //
            // Reported by 0xkerochan, 2026-11-06, with a harness that drives
            // the real JobManager and ShareProcessor against a redis whose
            // first write throws.
        } else if (result.verdict === SUBMIT.ALREADY_HAVE) {
            // A LOST RACE IS NOT A REJECTION, AND SAYING SO COSTS REAL THINGS.
            //
            // Two of our own miners can solve the same height milliseconds
            // apart; the second is told the node already has one. So can
            // another pool beat us to it. Both are ordinary proof of work,
            // and until 10 October 2026 both were logged at ERROR as "the
            // node read it and refused it" -- which reads, to whoever is
            // watching the pool, as though we were producing bad blocks.
            //
            // The share itself was already credited: in PPLNS a miner is paid
            // for the work he showed, not for who got the block in first.
            share.blockAccepted = false;
            share.blockStale = true;
            this.stats.blocksStale = (this.stats.blocksStale || 0) + 1;
            this.log.info(`block ${job.height} was already taken -- the node has `
                          + `one for that height (${result.reasons.join(' | ')}). `
                          + `A lost race, not a refusal; the share is credited `
                          + `and nothing is owed.`);
            this._unspool(blockHash).catch(() => {});
        } else {
            share.blockAccepted = false;
            share.rejectReasons = result.reasons;
            this.log.error(`block ${job.height} REJECTED: ${result.reasons.join(' | ')}`);
            this.emit('blockRejected', share);

            // A node that LOOKED and named a fault has told us something
            // final, and keeping those bytes forever helps nobody. A node that
            // never answered has told us nothing, so the block stays spooled
            // and the drain will offer it again.
            if (result.verdict === SUBMIT.REFUSED) {
                this.log.error(`    the block is kept for inspection but will not ` +
                               `be retried: the node read it and refused it`);
                this._unspool(blockHash, result.reasons.join(' | ')).catch(() => {});
            } else {
                this.log.error(`    NOT discarded -- it is spooled and will be ` +
                               `offered again when a node answers`);
            }
        }
    }

    _reject([code, message], worker, extra = {}) {
        this.emit('invalidShare', { worker, code, message, ...extra });
        return { valid: false, error: [code, message, null] };
    }

    // -----------------------------------------------------------------------

    getStatus() {
        const job = this.currentJob;
        return {
            ...this.stats,
            currentJob: job ? job.summary() : null,
            validJobs: this.validJobs.size,
            randomx: randomx.stats(),
            nextSeedRotationIn: job
                ? blocksUntilNextSeed(job.height,
                    this.config.randomxEpochBlocks, this.config.randomxEpochLag)
                : null
        };
    }
}

module.exports = JobManager;
module.exports.REJECT = REJECT;
