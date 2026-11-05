'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  ShareProcessor -- share accounting, block tracking, and payouts
// ===========================================================================
//
//  Storage layout (Redis, all keys prefixed with `coin:`):
//
//    <p>:round            HASH   worker -> difficulty accumulated this round
//    <p>:pplns            LIST   newest-first JSON shares, trimmed to the window
//    <p>:hashrate         ZSET   score = unix seconds, member = JSON share
//    <p>:blocks:pending   HASH   blockHash -> JSON {height, payouts, ...}
//    <p>:blocks:confirmed LIST   newest-first JSON block records
//    <p>:blocks:orphaned  LIST   newest-first JSON block records
//    <p>:balances         HASH   address -> base units owed (matured)
//    <p>:paid             HASH   address -> base units paid all time
//    <p>:payments         LIST   newest-first JSON payment batches
//    <p>:poolfees         STRING base units collected by the operator
//
//  THE CRITICAL ORDERING RULE
//  --------------------------
//  PPLNS payouts are computed AT THE MOMENT THE BLOCK IS FOUND and frozen into
//  the pending-block record. They are NOT recomputed at maturity. Recomputing
//  100 blocks later would use a share buffer that has completely turned over,
//  paying people who were not mining when the block was won -- which is both
//  unfair and, once miners notice, fatal to the pool's reputation.
//
//  Balances are only credited once a block's coinbase is SPENDABLE -- more
//  than COINBASE_MATURITY confirmations, which is 101 and not 100, because
//  Core's wallet asks for (COINBASE_MATURITY + 1) - depth -- AND is still on
//  the main chain. An orphaned block pays nobody; its record moves to
//  <p>:blocks:orphaned so the loss is auditable rather than silent.

const EventEmitter = require('events');

const { computeBlockRewards, estimateHashrate, pplnsWindowDifficulty } = require('./rewards');
const { COIN, COINBASE_MATURITY } = require('./constants');
const { defineAtomicCommands, CLAIM_AND_RECORD_NAME } = require('./atomic');

class ShareProcessor extends EventEmitter {
    /**
     * @param {import('ioredis')} redis
     * @param {import('./daemon')} daemon
     */
    constructor(redis, daemon, config, logger) {
        super();
        // Before anything else, because a pool that cannot make the
        // pending-to-evidence transition atomic must not start. See
        // pool/lib/atomic.js for what the two-command version cost.
        this.redis = defineAtomicCommands(redis);
        this.daemon = daemon;
        this.config = config;
        this.log = logger;

        this.prefix = config.redisPrefix || 'wam';
        this.mode = (config.rewardMode || 'pplns').toLowerCase();
        // ?? and not ||. A zero fee is a real configuration -- this pool
        // ran at 0% from launch night onward -- and `0 || 1` is 1, so the
        // operator's choice was silently replaced with a charge and every
        // report agreed it was 1%.
        this.poolFeePercent = config.poolFeePercent ?? 1;
        this.pplnsMultiplier = config.pplnsMultiplier || 2;
        this.maturity = config.coinbaseMaturity || COINBASE_MATURITY;

        if (!['pplns', 'prop'].includes(this.mode)) {
            throw new Error(`rewardMode must be 'pplns' or 'prop', got '${config.rewardMode}'`);
        }

        this.networkDifficulty = 1;
        this.timers = [];

        // A payment run must never overlap itself. processPayments is driven by
        // setInterval, and a slow one -- a daemon that takes thirty seconds to
        // answer, a batch of two hundred outputs, a wallet rescan -- lets the
        // next tick start while the first is still between reading balances and
        // clearing them. Both runs read the same balances, build the same batch
        // and call sendmany. Everyone is paid twice, out of the pool's own
        // wallet, and nothing in the logs looks wrong.
        //
        // The collector in the explorer has had `if (this.polling) return` since
        // it was written, for the far less costly problem of stacked RPC polls.
        this.paying = false;

        // And the same guard for maturation, missing until 2026-09-14 and
        // found by an outside reviewer reading the code rather than by
        // anything going wrong. checkPendingBlocks() is called from a 60-second
        // interval AND from the shutdown handler in server.js -- "one last
        // payment run so miners are not left waiting on a restart" -- so an
        // operator restarting while a maturation check was awaiting getblock
        // ran both at once. Both read the same blocks:pending, both saw
        // 100 confirmations, both credited. Every miner on that block was paid
        // twice out of the operator's wallet.
        this.checking = false;
    }

    k(...parts) { return [this.prefix, ...parts].join(':'); }

    /**
     * Did a previous run die with money in the air?
     *
     * Called before the payment timer starts. If an intent record survives, the
     * process stopped between sendmany returning and the balances being
     * cleared, and nobody but a human can tell which. Paying again would double
     * the payout; clearing the record blindly would rob whoever was not paid.
     *
     * So it stops, prints what to check and how to resolve it, and refuses to
     * pay. A pool that pauses is a support ticket. A pool that pays twice is
     * the operator's own money, and a pool that skips a payment is a reputation.
     */
    /**
     * The broadcast's answer was lost. Did the transaction arrive?
     *
     * This is only answerable because the transaction was built and signed
     * before it was sent, so it had a txid and a body before anybody could
     * have seen it. With sendmany there was nothing to ask about and the only
     * safe response was to stop and wait for a person.
     *
     * Returns true if the payment is known to be out there, false if the pool
     * has been paused and a human has been told why. It never returns true on
     * a guess: everything it does not understand ends in a pause.
     */
    async _settleUnknownPayment(txid, hex, cause) {
        // Is it already known to this node -- mempool or chain?
        try {
            const tx = await this.daemon.cmd('getrawtransaction', [txid, true]);
            if (tx && tx.txid === txid) return true;
        } catch (err) {
            // "No such mempool or blockchain transaction" is the node
            // answering the question, not failing to. Anything else is a
            // failure to ask, and is handled below by not guessing.
            if (err.ambiguous !== false) {
                this.paused = true;
                this.log.error('could not ask the node whether the payment exists ' +
                               `(${err.message}). PAYMENTS ARE PAUSED. The intent, ` +
                               `with txid ${txid} and the exact bytes, is at ` +
                               `${this.k('payment:inflight')}.`);
                return false;
            }
        }

        // Not known. Re-broadcasting the SAME bytes is safe by construction:
        // same inputs, same outputs, same txid. The node either accepts it or
        // tells us it already has it, and both answers mean the payment is
        // out there. This is the one case where retrying a money RPC is not
        // only allowed but correct, which is why sendrawtransaction is
        // deliberately absent from MONEY_RPCS in daemon.js.
        try {
            await this.daemon.cmd('sendrawtransaction', [hex]);
            this.log.warn(`re-broadcast ${txid} after a lost answer; the bytes ` +
                          'were identical, so this cannot pay anybody twice');
            return true;
        } catch (err) {
            const msg = String(err.message || '');
            if (/already in block chain|txn-already|already have/i.test(msg)) {
                return true;        // somebody else's copy got there first
            }
            this.paused = true;
            this.log.error('=========================================================');
            this.log.error('PAYMENT OUTCOME UNKNOWN AND NOT RECOVERABLE HERE.');
            this.log.error(`  first failure : ${cause.message}`);
            this.log.error(`  on retry      : ${msg}`);
            this.log.error(`  txid          : ${txid}`);
            this.log.error('');
            this.log.error('  Balances have NOT been cleared. The signed bytes are');
            this.log.error(`  in ${this.k('payment:inflight')}; the transaction can be`);
            this.log.error('  looked up or sent again by hand:');
            this.log.error('');
            this.log.error(`    wam-cli getrawtransaction ${txid} true`);
            this.log.error('=========================================================');
            return false;
        }
    }

    async startupReconcile() {
        const raw = await this.redis.get(this.k('payment:inflight'));
        if (!raw) {
            // The only path that releases payments. start() pauses them before
            // calling this, so reaching here is the single proof that the last
            // run finished cleanly.
            this.paused = false;
            return true;
        }

        let intent;
        try {
            intent = JSON.parse(raw);
        } catch {
            intent = { total: 0, payouts: {} };
        }

        const when = intent.startedAt ? new Date(intent.startedAt).toISOString() : 'unknown';
        const names = Object.keys(intent.payouts || {});

        this.log.error('=========================================================');
        this.log.error('A PAYMENT RUN DID NOT FINISH. PAYMENTS ARE PAUSED.');
        this.log.error(`  started    ${when}`);
        this.log.error(`  total      ${(intent.total / COIN).toFixed(8)} WAM`);
        this.log.error(`  recipients ${names.length}`);
        this.log.error('');
        this.log.error('  The transaction may or may not have been broadcast, and the');
        this.log.error('  balances may or may not have been cleared. Check the wallet:');
        this.log.error('');
        this.log.error('    wam-cli listtransactions "*" 20');
        this.log.error('');
        this.log.error('  If a matching send exists, the miners were paid. Deduct the');
        this.log.error('  balances by hand, then clear the marker:');
        this.log.error('');
        this.log.error(`    redis-cli DEL ${this.k('payment:inflight')}`);
        this.log.error('');
        this.log.error('  If no such transaction exists, nothing was sent. Clear the');
        this.log.error('  marker and the next run will pay normally.');
        this.log.error('=========================================================');

        this.paused = true;
        return false;
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    start() {
        this.log.info(`reward mode: ${this.mode.toUpperCase()}` +
            (this.mode === 'pplns' ? ` (window = ${this.pplnsMultiplier}x network difficulty)` : '') +
            `, pool fee ${this.poolFeePercent}%`);
        this.log.info('the chain\'s 5% treasury output is paid by the coinbase itself and is ' +
                      'never part of the miner pot');

        // Did the last run leave money in the air?
        //
        // This used to say "before any timer fires", and it was not true. The
        // call is not awaited, and its rejection was only logged -- so a Redis
        // hiccup on that one GET left `paused` unset, the payment timer
        // installed, and the single check that stops a duplicate payment after
        // a crash silently skipped. The check failed open, which is the one
        // direction it must never fail.
        //
        // Fixed by construction rather than by awaiting: payments start PAUSED
        // and only a reconcile that completed and found nothing may release
        // them. Then an exception, a hang, or a caller that forgets to await
        // all land on "do not pay" without anybody having to remember.
        //
        // Reported by dang150296 (Urriki1502) on 2026-10-03 as a startup
        // reconciliation fail-open. He placed it inside startupReconcile(),
        // which actually fails closed correctly; it was one level up, here.
        this.paused = true;
        this.startupReconcile().catch((e) =>
            this.log.error(`could not check for an unfinished payment, so payments ` +
                           `stay paused: ${e.message}`));

        const blockCheck = (this.config.blockCheckIntervalSec || 60) * 1000;
        const payoutCheck = (this.config.paymentIntervalSec || 600) * 1000;
        const pruneCheck = 300 * 1000;

        this.timers.push(setInterval(() => this.checkPendingBlocks()
            .catch((e) => this.log.error(`block check failed: ${e.message}`)), blockCheck));

        this.timers.push(setInterval(() => this.processPayments()
            .catch((e) => this.log.error(`payment run failed: ${e.message}`)), payoutCheck));

        this.timers.push(setInterval(() => this.pruneHashrateWindow()
            .catch(() => {}), pruneCheck));
    }

    stop() {
        for (const t of this.timers) clearInterval(t);
        this.timers = [];
    }

    setNetworkDifficulty(d) {
        if (Number.isFinite(d) && d > 0) this.networkDifficulty = d;
    }

    // -----------------------------------------------------------------------
    // Shares
    // -----------------------------------------------------------------------

    async recordShare(share) {
        // ONE PROOF OF WORK IS PAID FOR ONCE, WHATEVER DOOR IT CAME THROUGH.
        //
        // The claim in blockTemplate.js is the first gate and it is scoped to
        // the work now. This is the second, and it exists because the first
        // one has been got around twice by two different routes: once by the
        // spelling of the key (hex case, 2026-10-04) and once by its scope
        // (a sibling job at the same height, 2026-10-11). Both were found by
        // somebody outside this project, and both were the same sentence --
        // one unit of electricity, credited more than once, paid for by the
        // other miners in the round.
        //
        // A third route is not worth waiting for. The RandomX hash IS the
        // work: it cannot be produced twice without doing the work twice, it
        // does not depend on which job carried it, and the pool already has
        // it in hand here. SADD returns 0 if the member was already present,
        // and it is atomic, so two shares racing cannot both pass.
        //
        // Scoped to the round and deleted with it, so the set is bounded by
        // the shares in one block and never grows without end.
        if (share.powHash) {
            let fresh;
            try {
                fresh = await this.redis.sadd(this.k('round:pow'), share.powHash);
            } catch (err) {
                // A redis that cannot answer must not become a free pass: the
                // share is refused rather than credited blind.
                this.log.error(`could not check the proof of work for a share `
                                  + `from ${share.worker}: ${err.message}`);
                throw err;
            }
            if (fresh === 0) {
                this.log.warn(`share from ${share.worker} carries a proof of `
                                 + `work already credited this round `
                                 + `(${share.powHash.slice(0, 16)}...) -- not `
                                 + `credited again`);
                this.stats = this.stats || {};
                this.stats.replayedShares = (this.stats.replayedShares || 0) + 1;
                return;
            }
        }

        const now = Math.floor(Date.now() / 1000);
        const entry = JSON.stringify({
            w: share.worker,
            d: share.difficulty,
            t: now,
            // A unique suffix: ZSET members must be distinct or identical
            // shares would silently overwrite each other in the hashrate window.
            n: `${share.jobId}-${Math.random().toString(36).slice(2, 8)}`
        });

        const windowSize = this._pplnsBufferSize();

        const pipe = this.redis.pipeline();
        pipe.hincrbyfloat(this.k('round'), share.worker, share.difficulty);
        pipe.lpush(this.k('pplns'), entry);
        pipe.ltrim(this.k('pplns'), 0, windowSize - 1);
        pipe.zadd(this.k('hashrate'), now, entry);
        await pipe.exec();
    }

    /**
     * How many share entries to retain.
     *
     * The window is defined in units of difficulty, but Redis trims by count,
     * so we keep a generous multiple of the expected share count and let
     * selectPplnsWindow() do the exact difficulty accounting. Being too
     * generous costs a little memory; being too stingy would silently truncate
     * the window and underpay long-running miners.
     */
    _pplnsBufferSize() {
        const configured = this.config.pplnsMaxShares;
        if (configured) return configured;
        // THE SAME NUMBER THE PAYOUT ASKS FOR, NOT A SECOND OPINION ON IT.
        //
        // This used `networkDifficulty * pplnsMultiplier` while rewards.js
        // used `Math.max(1, ...)` of the same product. One floor, present in
        // one file, and the buffer ended up a tenth of the window it feeds --
        // see pplnsWindowDifficulty, which both now call.
        const avgShareDiff = this.config.startDifficulty || 1000;
        const needed = pplnsWindowDifficulty(this.networkDifficulty,
                                             this.pplnsMultiplier) / avgShareDiff;
        return Math.max(10000, Math.min(2000000, Math.ceil(needed * 4)));
    }

    async getPplnsShares() {
        const raw = await this.redis.lrange(this.k('pplns'), 0, this._pplnsBufferSize() - 1);
        return raw.map((s) => {
            const o = JSON.parse(s);
            return { worker: o.w, difficulty: o.d, time: o.t };
        });
    }

    async getRoundContributions() {
        const hash = await this.redis.hgetall(this.k('round'));
        const out = new Map();
        for (const [worker, diff] of Object.entries(hash)) {
            const d = parseFloat(diff);
            if (d > 0) out.set(worker, d);
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Blocks
    // -----------------------------------------------------------------------

    /**
     * Called the instant a block is accepted by the daemon.
     * Freezes the payout table and resets the round.
     */
    async recordBlock(share) {
        // ONE BLOCK, ONE PAYOUT, HOWEVER MANY TIMES THIS IS CALLED.
        //
        // This was not safe to call twice, and nothing stopped it being. The
        // pending record is keyed on the block hash so a second call merely
        // overwrites it -- but the same call also runs `del(round)` and
        // `incrby(poolfees)`, so a repeat WIPES A LIVE ROUND'S CONTRIBUTIONS
        // and double-counts the fee. Every miner in that round loses the work
        // they had done since the last block.
        //
        // It matters now because the spool drain has to offer a recovered
        // block for payout without knowing whether the crash happened before
        // or after the original accounting. The honest answer to "was this
        // already paid" is to look, and the only safe way to let the drain ask
        // is for asking twice to cost nothing.
        //
        // Both lists are checked, not just the pending one: a block recovered
        // after it had already matured would otherwise be paid a second time.
        //
        // Found by dang150296 (Urriki1502) against bb6d521.
        if (share.blockHash) {
            const [pending, confirmed] = await Promise.all([
                this.redis.hexists(this.k('blocks:pending'), share.blockHash),
                this.redis.sismember(this.k('blocks:confirmed:hashes'), share.blockHash)
            ]);
            if (pending || confirmed) {
                this.log.info(`block ${share.height} is already accounted for ` +
                              `(${pending ? 'pending' : 'confirmed'}); nothing to do`);
                return null;
            }
        }

        const [shares, roundContributions] = await Promise.all([
            this.mode === 'pplns' ? this.getPplnsShares() : Promise.resolve([]),
            this.getRoundContributions()
        ]);

        let rewards;
        try {
            rewards = computeBlockRewards({
                mode: this.mode,
                blockValue: share.distributableValue,
                coinbaseValue: share.coinbaseValue,
                devFeeAmount: share.devFeeAmount,
                poolFeePercent: this.poolFeePercent,
                shares,
                roundContributions,
                networkDifficulty: this.networkDifficulty,
                pplnsMultiplier: this.pplnsMultiplier
            });
        } catch (err) {
            // Never lose a block over an accounting bug: park it for manual
            // review rather than dropping it on the floor.
            this.log.error(`reward computation failed for block ${share.height}: ${err.message}`);
            await this.redis.hset(this.k('blocks:failed'), share.blockHash,
                JSON.stringify({ ...share, error: err.message }));
            return null;
        }

        const record = {
            height: share.height,
            blockHash: share.blockHash,
            finder: share.worker,
            time: Date.now(),
            coinbaseValue: share.coinbaseValue,
            devFeeAmount: share.devFeeAmount,
            distributableValue: share.distributableValue,
            poolFee: rewards.poolFee,
            minerPot: rewards.minerPot,
            payouts: Object.fromEntries(rewards.payouts),
            workers: rewards.workers,
            window: rewards.window,
            mode: this.mode,
            confirmations: 0
        };

        const pipe = this.redis.pipeline();
        pipe.hset(this.k('blocks:pending'), share.blockHash, JSON.stringify(record));
        pipe.del(this.k('round'));           // PROP round closes here
        // The proof-of-work set belongs to the round and dies with it. Left
        // behind it would grow for ever and start refusing honest shares in
        // the astronomically unlikely case of a repeat across rounds.
        pipe.del(this.k('round:pow'));
        pipe.incrby(this.k('poolfees'), rewards.poolFee);
        await pipe.exec();

        this.log.info(
            `block ${share.height} recorded: ${(record.minerPot / COIN).toFixed(8)} WAM to ` +
            `${record.workers} workers, ${(record.poolFee / COIN).toFixed(8)} WAM pool fee, ` +
            `${(record.devFeeAmount / COIN).toFixed(8)} WAM treasury (paid by consensus)`);

        this.emit('blockRecorded', record);
        return record;
    }

    /**
     * Move matured blocks into balances and discard orphans.
     */
    async checkPendingBlocks() {
        if (this.checking) return;
        this.checking = true;
        try {
            await this._checkPendingBlocks();
        } finally {
            this.checking = false;
        }
    }

    async _checkPendingBlocks() {
        const pending = await this.redis.hgetall(this.k('blocks:pending'));
        const hashes = Object.keys(pending);
        if (hashes.length === 0) return;

        for (const hash of hashes) {
            let record;
            try {
                record = JSON.parse(pending[hash]);
            } catch {
                await this.redis.hdel(this.k('blocks:pending'), hash);
                continue;
            }

            let block;
            try {
                block = await this.daemon.getBlock(hash, 1);
            } catch (err) {
                // getblock throws "Block not found" for an orphan the node has
                // already discarded -- that is a definitive orphan signal.
                if (/not found/i.test(err.message)) {
                    await this._orphan(hash, record, 'block not found on the node');
                } else {
                    this.log.warn(`could not check block ${record.height}: ${err.message}`);
                }
                continue;
            }

            if (block.confirmations === -1) {
                await this._orphan(hash, record, 'chain reorganisation');
                continue;
            }

            record.confirmations = block.confirmations;

            // Spendable, not mature: the two differ by exactly one block.
            //
            // COINBASE_MATURITY is 100, and reading that as "credit at 100
            // confirmations" is wrong. Core's own wallet computes
            //
            //     max(0, (COINBASE_MATURITY + 1) - depth)          wallet.cpp
            //
            // so a coinbase output is spendable at depth 101, not 100. The
            // pool credited at 100 and then could not spend what it had just
            // credited, so it believed it held one block more than the node
            // would let it move -- 47.5 WAM standing between what is owed and
            // what can be sent, permanently, for the whole life of the chain.
            //
            // Nothing was lost by it and nobody was paid twice; the arithmetic
            // reconciles to 0.1 WAM of accumulated transaction fees. What it
            // cost was time: every payment run that landed in the gap
            // postponed, and a 10-minute payout interval became 20 to 40
            // minutes for miners who had done nothing wrong.
            //
            // Credit when the coin can actually move. A pool that credits
            // earlier is promising money it cannot send.
            if (block.confirmations <= this.maturity) {
                await this.redis.hset(this.k('blocks:pending'), hash, JSON.stringify(record));
                continue;
            }

            await this._mature(hash, record);
        }
    }

    async _orphan(hash, record, reason) {
        this.log.warn(`block ${record.height} ORPHANED (${reason}); ` +
                      `${(record.minerPot / COIN).toFixed(8)} WAM will not be paid`);

        record.orphanedAt = Date.now();
        record.orphanReason = reason;

        // THE SAME TRANSITION, SO THE SAME ATOM.
        //
        // This was a pipeline, which is one round trip and not a transaction:
        // HDEL could land and LPUSH not, and then the block had been dropped
        // from pending with no orphan record anywhere. Less costly than the
        // maturation case -- an orphan pays nobody -- but it is the identical
        // mistake, and the orphan count and the pool-fee reversal below both
        // depend on this having happened exactly once.
        //
        // It also now checks that it won the claim. It never did, so two runs
        // could each orphan the same block and decrement poolfees twice.
        const claimed = Number(await this.redis[CLAIM_AND_RECORD_NAME](
            this.k('blocks:pending'), this.k('blocks:orphaned'),
            hash, JSON.stringify(record)));
        if (claimed !== 1) {
            this.log.warn(`block ${record.height} was already orphaned by ` +
                          'another run; not counting it again');
            return;
        }

        // Everything below is repairable from blocks:orphaned if it is lost:
        // a capped list, a counter and a fee reversal, all derivable from the
        // evidence the atom above has already written. Only the payout table
        // was irreplaceable, and it is now safe.
        const pipe = this.redis.pipeline();
        pipe.ltrim(this.k('blocks:orphaned'), 0, 999);
        // Same reason as blocks:confirmed:count below. This list is capped at
        // 1000, so the orphan total would freeze there too -- later, quieter,
        // and in the number that tells a miner how often his work was wasted.
        pipe.incr(this.k('blocks:orphaned:count'));
        pipe.decrby(this.k('poolfees'), record.poolFee);
        await pipe.exec();

        this.emit('blockOrphaned', record);
    }

    async _mature(hash, record) {
        // THE CLAIM AND THE EVIDENCE ARE ONE OPERATION, OR NEITHER HAPPENS.
        //
        // The claim is still the delete: HDEL reports how many fields it
        // removed, so of any number of concurrent callers exactly one gets 1
        // and only that one credits. The guard above stops two runs in this
        // process; this stops two processes.
        //
        // What changed on 2026-10-12 is that the delete and the evidence are
        // no longer two awaits. They were, and between them this block
        // belonged to no state at all: gone from pending, absent from
        // maturing, not credited. An interruption there destroyed the payout
        // table, and because recordBlock deletes the round's shares in the
        // same breath that writes it, there was nothing left to rebuild it
        // from -- not for the pool and not for an operator by hand.
        //
        // The comment that used to sit here said losing a credit was
        // recoverable. It was not. Reported by Smooth Jazz Crypto; see pool/lib/atomic.js.
        record.maturedAt = Date.now();
        const evidence = JSON.stringify(record);

        const claimed = Number(await this.redis[CLAIM_AND_RECORD_NAME](
            this.k('blocks:pending'), this.k('blocks:maturing'),
            hash, evidence));
        if (claimed !== 1) {
            this.log.warn(`block ${record.height} was already claimed for ` +
                          'maturation by another run; not crediting it again');
            return;
        }

        const pipe = this.redis.pipeline();

        for (const [worker, amount] of Object.entries(record.payouts)) {
            if (amount <= 0) continue;
            // Workers authorize as "<address>.<label>"; balances are per address.
            const address = worker.split('.')[0];
            pipe.hincrby(this.k('balances'), address, amount);
        }

        pipe.lpush(this.k('blocks:confirmed'), evidence);
        pipe.ltrim(this.k('blocks:confirmed'), 0, 4999);
        // A COUNT CANNOT COME OUT OF A LIST THAT IS TRIMMED.
        //
        // This is the third time this project has published a block count
        // that stopped moving, and each time the count was the size of a
        // bounded thing:
        //
        //   lrange(blocks:confirmed, 0, 49).length   froze at 50
        //   llen(blocks:confirmed)                   froze at 5000, here
        //
        // llen was the right answer to the first bug and the wrong answer in
        // general: it reports the length of a list that the line above
        // deliberately caps. On 1 October the dashboard had read BLOCKS FOUND
        // 5000 for two days while blocks kept arriving, and the founder saw it
        // the same way he saw the first one -- by watching a number that
        // should have moved.
        //
        // Raising the cap would put the same bug further away, which is the
        // shape of fix this project does not accept. A counter is not a
        // collection: it is incremented once per event and nothing trims it.
        // The list stays, because the page also wants the recent blocks to
        // show, and a sample and a count are two different questions.
        pipe.incr(this.k('blocks:confirmed:count'));
        // AND A SET OF THE HASHES, FOR THE QUESTION "WAS THIS ALREADY PAID?"
        //
        // The list above is trimmed at 5000 and the counter is a number, so
        // neither can answer it. recordBlock has to be able to: the spool
        // drain offers a recovered block for payout without knowing whether
        // the crash happened before or after the original accounting, and
        // "already in pending" only covers a block that has not matured yet.
        // Without this, a block recovered after maturing would be paid twice.
        //
        // A set of 32-byte hex strings, one per block ever confirmed. At 720
        // blocks a day that is about 1.7 MB a year, which is the cheapest
        // honest answer available.
        pipe.sadd(this.k('blocks:confirmed:hashes'), record.blockHash);
        pipe.lrem(this.k('blocks:maturing'), 0, evidence);

        await pipe.exec();

        this.log.info(`block ${record.height} matured (${record.confirmations} confs); ` +
                      `${(record.minerPot / COIN).toFixed(8)} WAM credited to ` +
                      `${record.workers} miners`);
        this.emit('blockMatured', record);
    }

    // -----------------------------------------------------------------------
    // Payments
    // -----------------------------------------------------------------------

    async processPayments() {
        if (this.paused) return;              // an unfinished run needs a human
        if (this.paying) {
            this.log.warn('a payment run is still in progress; skipping this tick');
            return;
        }
        this.paying = true;
        try {
            await this._processPayments();
        } finally {
            // finally, not after: an exception must not leave the flag set, or
            // the pool stops paying anyone and only says so once.
            this.paying = false;
        }
    }

    async _processPayments() {
        const threshold = Math.round((this.config.minimumPayoutWam ?? 1) * COIN);
        const balances = await this.redis.hgetall(this.k('balances'));

        const due = Object.entries(balances)
            .map(([address, amount]) => [address, parseInt(amount, 10)])
            .filter(([, amount]) => amount >= threshold);

        if (due.length === 0) return;

        // ---- cap the batch --------------------------------------------------
        //
        // One sendmany per payment round works until the pool succeeds. A
        // transaction carrying thousands of outputs stops being relayed: a
        // P2WPKH output is 31 bytes plus overhead, so somewhere around three
        // thousand miners the transaction passes 100 kB and every node drops
        // it as non-standard. The pool would then retry the same oversized
        // payment every round, forever, and nobody would be paid at all.
        //
        // Whatever does not fit stays in `balances` untouched and goes out in
        // the next round. Raised by an external reviewer, 2026-08-09.
        const maxRecipients = this.config.maxPaymentRecipients || 200;
        const maxPerBatch = Math.round(
            (this.config.maxWamPerPaymentBatch || 100000) * COIN);

        const batch = [];
        let batchTotal = 0;

        for (const [address, amount] of due) {
            if (batch.length >= maxRecipients) break;

            if (batchTotal + amount > maxPerBatch) {
                // A single balance larger than the whole cap would otherwise
                // block the queue for ever. Pay what the cap allows; the
                // remainder is still owed and still recorded.
                if (batch.length === 0) {
                    this.log.warn(
                        `${address} is owed ${(amount / COIN).toFixed(8)} WAM, more than the ` +
                        `${(maxPerBatch / COIN).toFixed(8)} WAM batch cap. Paying the cap now, ` +
                        'the rest next round.');
                    batch.push([address, maxPerBatch]);
                    batchTotal = maxPerBatch;
                }
                break;
            }

            batch.push([address, amount]);
            batchTotal += amount;
        }

        if (batch.length < due.length) {
            this.log.info(
                `payment split: ${batch.length} of ${due.length} miners this round ` +
                `(${(batchTotal / COIN).toFixed(8)} WAM). The rest keep their balances ` +
                'and are paid next run.');
        }

        // Never attempt a payment the wallet cannot cover: a partially failed
        // sendmany is far harder to reconcile than a postponed one.
        const walletBalance = Math.round((await this.daemon.getBalance()) * COIN);
        const reserve = Math.round((this.config.txFeeReserveWam ?? 0.01) * COIN);

        if (walletBalance < batchTotal + reserve) {
            this.log.warn(
                `payment run postponed: wallet holds ${(walletBalance / COIN).toFixed(8)} WAM ` +
                `but ${((batchTotal + reserve) / COIN).toFixed(8)} WAM is due in this batch. ` +
                'This is normal if blocks are still maturing.');
            // Say so where something other than a log reader can see it.
            //
            // A postponement and a stoppage look identical from outside: owed
            // climbs, the last payment ages, and nothing is paid. They are not
            // the same fault -- one is the wallet waiting on 100 confirmations
            // and the other is payments broken -- and a monitor that cannot
            // tell them apart reports the safe one as an emergency until the
            // operator learns to ignore the colour red. The pool is the only
            // party that knows the reason, so it publishes it.
            await this.redis.set(this.k('payment:postponed'), JSON.stringify({
                at: Date.now(),
                held: walletBalance,
                due: batchTotal + reserve,
                shortfall: (batchTotal + reserve) - walletBalance,
                recipients: batch.length
            }));
            return;
        }

        const sendMany = {};
        for (const [address, amount] of batch) {
            sendMany[address] = Number((amount / COIN).toFixed(8));
        }

        this.log.info(`paying ${batch.length} miners a total of ` +
                      `${(batchTotal / COIN).toFixed(8)} WAM`);

        // Record the intent BEFORE the money moves.
        //
        // Between sendmany returning and the balances being cleared there is a
        // window of milliseconds. A crash inside it -- and this project has
        // already lost power twice in one day -- leaves the coins spent and the
        // balances intact, so the next run pays the same people again out of
        // the pool's own wallet. Milliseconds times years is not never.
        //
        // The record is written first and cleared last, so an interrupted run
        // leaves evidence. startupReconcile() reads it and refuses to pay until
        // an operator has checked the wallet, because the safe failure here is
        // a delayed payment and the unsafe one is a duplicate.
        const intent = {
            startedAt: Date.now(),
            total: batchTotal,
            payouts: Object.fromEntries(batch)
        };
        await this.redis.set(this.k('payment:inflight'), JSON.stringify(intent));

        // BUILD IT AND SIGN IT FIRST, SO IT HAS A NAME BEFORE IT HAS A FATE.
        //
        // sendmany creates and broadcasts in one call, so when the reply is
        // lost there is nothing to ask about: no txid, no bytes, nothing to
        // look up and nothing to send again. The only safe response was to
        // pause and fetch a human, which is what the block below used to do
        // every time -- correct, and it stops payouts until somebody is awake.
        //
        // Doing it in three steps gives the transaction an identity before
        // anybody could have seen it. If the broadcast's answer is then lost,
        // the recovery is a question with an answer: is this txid known? If
        // yes, it was sent. If no, send these exact bytes again --
        // sendrawtransaction is idempotent, same txid, same outputs, so
        // re-sending cannot pay anyone twice.
        //
        // Reported by dang150296 (Urriki1502) on 2026-10-04: payout identity
        // is created inside sendmany, with no deterministic txid or raw
        // transaction stored before broadcast.
        //
        // The wallet still chooses the inputs and the change, through
        // fundrawtransaction. Nothing about coin selection moves into this
        // file; what moves is only WHEN the identity exists.
        let txid;
        let signedHex;
        try {
            const raw = await this.daemon.cmd('createrawtransaction', [[], sendMany]);
            const funded = await this.daemon.cmd('fundrawtransaction', [raw]);
            const signed = await this.daemon.cmd('signrawtransactionwithwallet',
                                                 [funded.hex]);
            if (!signed || !signed.complete) {
                throw Object.assign(
                    new Error('the wallet could not fully sign the payment: ' +
                              JSON.stringify((signed && signed.errors) || []).slice(0, 300)),
                    { ambiguous: false });
            }
            signedHex = signed.hex;
            const decoded = await this.daemon.cmd('decoderawtransaction', [signedHex]);
            txid = decoded.txid;

            // Written down BEFORE the broadcast, which is the whole point.
            intent.txid = txid;
            intent.hex = signedHex;
            await this.redis.set(this.k('payment:inflight'), JSON.stringify(intent));

            await this.daemon.cmd('sendrawtransaction', [signedHex]);
        } catch (err) {
            // THIS BLOCK USED TO ASSUME. Its comment read "the call failed, so
            // nothing was spent and the intent is stale", and it deleted the
            // intent on every error -- including a timeout, which is the one
            // case where the node may be signing and broadcasting at that very
            // moment. The marker written eight lines above exists for exactly
            // that case, and the error path threw it away.
            //
            // So the question is no longer "did it throw" but "do we know".
            // daemon.js answers it at the point where the evidence is.
            //
            // `!== false` and not `=== true`: only an error that has been
            // positively classified as a refusal may clear the intent. An
            // error from somewhere that does not classify -- a future call
            // site, a wrapper, a bug -- is unknown by default, because the
            // default has to be the direction that cannot lose money.
            if (err.ambiguous !== false) {
                // An unknown outcome is now a QUESTION, not a dead end -- but
                // only if the transaction got far enough to have a name. If it
                // failed while being built or signed, nothing was broadcast
                // and there is nothing to ask about.
                if (txid) {
                    const settled = await this._settleUnknownPayment(txid, signedHex, err);
                    if (settled) {
                        this.log.warn(`the payment's answer was lost (${err.message}) ` +
                                      `but ${txid} is on the node. Continuing.`);
                    } else {
                        return;     // _settleUnknownPayment has paused and said why
                    }
                } else {
                    this.paused = true;
                    this.log.error('=========================================================');
                    this.log.error('PAYMENT OUTCOME UNKNOWN BEFORE IT HAD A TXID.');
                    this.log.error(`  ${err.message}`);
                    this.log.error('');
                    this.log.error('  It failed while being built or signed, so almost');
                    this.log.error('  certainly nothing was broadcast -- but "almost" is');
                    this.log.error('  not a word this pays miners on.');
                    this.log.error('');
                    this.log.error('    wam-cli listtransactions "*" 20');
                    this.log.error('');
                    this.log.error(`  The intent is kept at ${this.k('payment:inflight')}.`);
                    this.log.error('=========================================================');
                    return;
                }
            } else {

                // A refusal from the node itself: it parsed the request and
                // said no, so no transaction exists and the intent really is
                // stale. Clearing it here is safe; leaving it would halt
                // payments over a transient RPC error.
                await this.redis.del(this.k('payment:inflight'));
                this.log.error(`the payment was refused, balances left ` +
                               `untouched: ${err.message}`);
                return;
            }
        }

        // Only now is it safe to clear balances. Doing it before the RPC
        // returned would lose every miner's money if the call failed.
        // Deduct exactly what was sent, not what was owed. For a balance that
        // hit the cap those differ, and the difference is the miner's money.
        // multi(), not pipeline(). ioredis pipelines are a batch, not a
        // transaction: the commands go out together and redis applies them one
        // by one, so a connection lost halfway leaves the first few applied and
        // the rest not. The comment on the del below used to claim that its
        // survival implied the deduction survived, and with a pipeline that is
        // simply untrue -- the deduction and the del could be split. MULTI/EXEC
        // is applied as one unit, which is what the claim needs to be worth
        // making.
        const pipe = this.redis.multi();
        for (const [address, amount] of batch) {
            pipe.hincrby(this.k('balances'), address, -amount);
            pipe.hincrby(this.k('paid'), address, amount);
        }
        pipe.lpush(this.k('payments'), JSON.stringify({
            txid, time: Date.now(), total: batchTotal, recipients: batch.length,
            payouts: Object.fromEntries(batch)
        }));
        pipe.ltrim(this.k('payments'), 0, 999);
        // Cleared in the same pipeline that clears the balances: if this
        // survives, so did the deduction, and if neither did the intent record
        // is still there to be found.
        pipe.del(this.k('payment:inflight'));
        // A run that paid clears the postponement: the record means "the last
        // run did not pay, and here is why", never "it once did not pay".
        pipe.del(this.k('payment:postponed'));
        await pipe.exec();

        this.log.info(`payment sent, txid ${txid}`);
        this.emit('payment', {
            txid,
            total: batchTotal,
            recipients: batch.length,
            deferred: due.length - batch.length
        });
    }

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------

    async pruneHashrateWindow() {
        const cutoff = Math.floor(Date.now() / 1000) - (this.config.hashrateWindowSec || 600);
        await this.redis.zremrangebyscore(this.k('hashrate'), '-inf', cutoff);
    }

    async getHashrateStats() {
        // ONE WINDOW, ONE READ, SHARED BY EVERY CALLER.
        //
        // This answer is pool-wide. It does not depend on who asked, and two
        // callers a millisecond apart get the same numbers. It was being
        // computed per caller anyway, and getMinerStats() below calls it --
        // so every miner opening his own page pulled the WHOLE pool's share
        // window out of redis and JSON.parsed all of it to find his own line.
        //
        // On 2026-11-05 that took the pool down. With ~200 workers the reply
        // is tens of megabytes; the main thread could not drain them as fast
        // as they were asked for, so redis buffered reply after reply for one
        // client. Measured at the time: dataset 56 MB, output buffer 4.4 GB
        // and still climbing, with client-output-buffer-limit normal 0 0 0
        // and maxmemory 0 -- no brake anywhere. The kernel OOM-killed redis
        // twice in four minutes, took wam-electrumx@testnet with it once, and
        // between kills the saturated main thread filled the verification
        // queue, so miners got "share rejected: verification queue full" --
        // one miner reported 49 rejected and 0 accepted -- while the public
        // pool page showed "API unreachable: HTTP 504".
        //
        // Three symptoms, one cause. The memo turns N callers into one read.
        const ttl = this.config.hashrateCacheMs ?? this.config.apiCacheMs ?? 3000;
        const memo = this._hashrateMemo || (this._hashrateMemo = {});
        if (memo.value && Date.now() - memo.at < ttl) return memo.value;
        // A read already running is the read this caller wants. Awaiting it
        // is what stops a burst of requests becoming a burst of queries.
        if (memo.inFlight) return memo.inFlight;

        memo.inFlight = this._computeHashrateStats()
            .then((v) => { memo.value = v; memo.at = Date.now(); return v; })
            .finally(() => { memo.inFlight = null; });
        return memo.inFlight;
    }

    async _computeHashrateStats() {
        const windowSec = this.config.hashrateWindowSec || 600;
        const since = Math.floor(Date.now() / 1000) - windowSec;
        const raw = await this.redis.zrangebyscore(this.k('hashrate'), since, '+inf');

        const shares = raw.map((s) => JSON.parse(s));
        const perWorker = new Map();

        for (const s of shares) {
            const list = perWorker.get(s.w) || [];
            list.push({ difficulty: s.d });
            perWorker.set(s.w, list);
        }

        const workers = {};
        for (const [worker, list] of perWorker) {
            workers[worker] = {
                hashrate: estimateHashrate(list, windowSec),
                shares: list.length
            };
        }

        return {
            windowSeconds: windowSec,
            poolHashrate: estimateHashrate(shares.map((s) => ({ difficulty: s.d })), windowSec),
            totalShares: shares.length,
            workers
        };
    }

    async getPoolStats() {
        // A COUNT IS NOT THE LENGTH OF A WINDOW.
        //
        // This read lrange(blocks:confirmed, 0, 49) and reported
        // confirmedBlocks.length as blocksConfirmed. lrange returns at most
        // fifty entries, so once the pool had matured fifty blocks the number
        // on the dashboard was 50 for ever. The founder caught it by watching
        // for a day: "maturing" climbed 46 -> 64 while "BLOCKS FOUND 50" never
        // moved once.
        //
        // llen asks redis for the real length. The lrange stays, because the
        // page also wants the most recent blocks to show -- a sample and a
        // count are two different questions and the bug was answering the
        // second with the first.
        const [confirmed, confirmedTotal, orphaned, orphanedTotal,
               payments, balances, paid, fees, pendingRaw, postponedRaw] =
            await Promise.all([
                this.redis.lrange(this.k('blocks:confirmed'), 0, 4999),
                this.redis.get(this.k('blocks:confirmed:count')),
                this.redis.lrange(this.k('blocks:orphaned'), 0, 999),
                this.redis.get(this.k('blocks:orphaned:count')),
                this.redis.lrange(this.k('payments'), 0, 24),
                this.redis.hgetall(this.k('balances')),
                this.redis.hgetall(this.k('paid')),
                this.redis.get(this.k('poolfees')),
                this.redis.hgetall(this.k('blocks:pending')),
                this.redis.get(this.k('payment:postponed'))
            ]);

        const parse = (arr) => arr.map((s) => { try { return JSON.parse(s); } catch { return null; } })
                                  .filter(Boolean);

        const confirmedBlocks = parse(confirmed);
        const pendingBlocks = parse(Object.values(pendingRaw));

        // The counters, with the list length as the floor rather than as the
        // answer.
        //
        // A pool that has been running since before the counters existed has
        // no key to read, and a pool whose counter was seeded from a trimmed
        // list cannot be below what the list still holds. Taking the larger
        // of the two is right in both cases and wrong in neither: the counter
        // wins once it is ahead, which is from the first block after this
        // ships, and until then the old number is shown rather than a zero
        // that would read as "this pool has never found a block".
        const confirmedCount = Math.max(parseInt(confirmedTotal || '0', 10),
                                        confirmedBlocks.length);
        const orphanedCount = Math.max(parseInt(orphanedTotal || '0', 10),
                                       parse(orphaned).length);

        const totalPaid = Object.values(paid).reduce((a, b) => a + parseInt(b, 10), 0);
        const totalOwed = Object.values(balances).reduce((a, b) => a + parseInt(b, 10), 0);
        // Summed over every confirmed block the list still holds, plus every
        // pending one. blocks:confirmed is trimmed at 5000 entries, so beyond
        // that this understates -- and a money figure that quietly understates
        // is the fault this whole change is about. So it says whether it is
        // complete rather than leaving a reader to assume.
        const treasuryPaid = [...confirmedBlocks, ...pendingBlocks]
            .reduce((a, b) => a + (b.devFeeAmount || 0), 0);
        const treasuryPaidComplete = confirmedCount <= confirmedBlocks.length;

        return {
            rewardMode: this.mode,
            poolFeePercent: this.poolFeePercent,
            chainDevFeePercent: 5,
            blocksConfirmed: confirmedCount,
            blocksPending: pendingBlocks.length,
            blocksOrphaned: orphanedCount,
            totalPaid,
            totalOwed,
            poolFeesCollected: parseInt(fees || '0', 10),
            treasuryPaidByConsensus: treasuryPaid,
            treasuryPaidComplete,
            recentBlocks: confirmedBlocks.slice(0, 25).map(summariseBlock),
            pendingBlocks: pendingBlocks.map(summariseBlock),
            orphanedBlocks: parse(orphaned).map(summariseBlock),
            recentPayments: parse(payments),
            // null when the last run paid. An object when it did not, carrying
            // the two numbers that decide whether that is normal.
            paymentPostponed: (() => {
                try { return postponedRaw ? JSON.parse(postponedRaw) : null; }
                catch { return null; }
            })()
        };
    }

    async getMinerStats(address) {
        const [balance, paid, hashrate] = await Promise.all([
            this.redis.hget(this.k('balances'), address),
            this.redis.hget(this.k('paid'), address),
            this.getHashrateStats()
        ]);

        const workers = {};
        let total = 0;
        for (const [worker, stats] of Object.entries(hashrate.workers)) {
            if (worker.split('.')[0] !== address) continue;
            workers[worker] = stats;
            total += stats.hashrate;
        }

        return {
            address,
            balance: parseInt(balance || '0', 10),
            totalPaid: parseInt(paid || '0', 10),
            hashrate: total,
            workers
        };
    }
}

function summariseBlock(b) {
    return {
        height: b.height,
        hash: b.blockHash,
        finder: b.finder,
        time: b.time,
        confirmations: b.confirmations,
        coinbaseValue: b.coinbaseValue,
        devFeeAmount: b.devFeeAmount,
        minerPot: b.minerPot,
        poolFee: b.poolFee,
        workers: b.workers,
        orphanReason: b.orphanReason || null
    };
}

module.exports = ShareProcessor;
