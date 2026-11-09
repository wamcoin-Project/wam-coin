'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  Collector -- polls wamd and keeps one coherent snapshot of network state
// ===========================================================================
//
//  Design notes:
//
//  * The browser NEVER talks to wamd. It talks to this process, which holds a
//    single cached snapshot. Ten open dashboard tabs cost the node the same as
//    one, and the RPC credentials never leave the server.
//
//  * Every WAM-specific RPC is optional. Pointed at a node built before those
//    commands existed -- or at a plain bitcoind -- the explorer shows less
//    rather than falling over. An operator opening this at 3am because
//    something is broken must not be met with a stack trace.
//
//  * A failed poll degrades the snapshot to `nodeOnline: false` and keeps the
//    last good data with a staleness marker, instead of blanking the screen.

const {
    COIN, SUBSIDY_HALVING_INTERVAL, INITIAL_BLOCK_SUBSIDY_WAM, MAX_HALVINGS,
    MAX_MONEY_WAM, GENESIS_PREMINE_WAM, DEVFEE_PERCENT, DEVFEE_LAST_HEIGHT,
    POW_TARGET_SPACING, PREMINE_TRANCHE_AMOUNT_WAM, PREMINE_UNLOCK_TIMES,
    nextHalvingHeight,
} = require('./constants');

const RECENT_BLOCKS = 25;

class Collector {
    constructor(rpc, logger, options = {}) {
        this.rpc = rpc;
        this.log = logger;
        this.intervalMs = (options.pollSeconds || 10) * 1000;

        this.snapshot = this._emptySnapshot();
        this.blockCache = new Map();     // height -> summary
        this.timer = null;
        this.polling = false;
    }

    _emptySnapshot() {
        return {
            nodeOnline: false,
            error: 'not polled yet',
            updatedAt: null,
            staleSeconds: null,
            chain: null,
            supply: null,
            emission: null,
            treasury: null,
            randomx: null,
            mempool: null,
            peers: null,
            blocks: []
        };
    }

    async start() {
        await this.poll();
        this.timer = setInterval(() => {
            this.poll().catch((err) => this.log.error(`poll failed: ${err.message}`));
        }, this.intervalMs);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    get() {
        const s = this.snapshot;
        return {
            ...s,
            staleSeconds: s.updatedAt ? Math.round((Date.now() - s.updatedAt) / 1000) : null
        };
    }

    // -----------------------------------------------------------------------

    async poll() {
        if (this.polling) return;      // a slow node must not stack up polls
        this.polling = true;

        try {
            const chainInfo = await this.rpc.call('getblockchaininfo');

            // THE DEFAULT WINDOW, BECAUSE IT IS WHAT THE REST OF THE CHAIN USES.
            //
            // getmininginfo's networkhashps is getnetworkhashps over its
            // default 120 blocks -- four hours here, and genuinely few to
            // average a Poisson process against a difficulty DGW moves on
            // every block. Asked in one second, the same node gave 547.0 over
            // 120 blocks, 621.7 over 360, 610.2 over 720 and 599.1 over 1440.
            // One quantity, four answers, and the shortest window was the
            // lowest every time it was sampled.
            //
            // So this asked for 720 for a few hours. The arithmetic was
            // right and the decision was wrong, and the founder found out
            // how within the hour. Three pool pages, within three blocks of
            // each other:
            //
            //     veinpool.fr            590.5 kH/s
            //     wampool.vslabs.co.in   590.5 kH/s
            //     pool.wamcoin.org       620.9 kH/s
            //
            // Two pools run by other people agreeing exactly, and this
            // project's own pages alone quoting a bigger network. Both of
            // theirs call getmininginfo, so 120 is the convention on this
            // chain whatever its statistical merit, and a stranger comparing
            // the three does not see a better estimator. He sees the people
            // who made the coin claiming it is stronger than everyone else
            // says it is.
            //
            // That is the one thing this project cannot afford to look like,
            // and five per cent of accuracy does not buy it back. The window
            // is the node's default again, and it is stated rather than
            // hidden -- which was the honest half of the change and costs
            // nothing.
            const [mining, mempool, netInfo, supplyRpc, randomxRpc, devfeeRpc] =
                await Promise.all([
                    this.rpc.tryCall('getmininginfo', [], null),
                    this.rpc.tryCall('getmempoolinfo', [], null),
                    this.rpc.tryCall('getnetworkinfo', [], null),
                    this.rpc.tryCall('getsupplyinfo', [], null),
                    this.rpc.tryCall('getrandomxinfo', [], null),
                    this.rpc.tryCall('getdevfeeinfo', [], null)
                ]);

            const height = chainInfo.blocks;
            const blocks = await this._recentBlocks(height);

            this.snapshot = {
                nodeOnline: true,
                error: null,
                updatedAt: Date.now(),
                staleSeconds: 0,
                chain: this._chain(chainInfo, mining, netInfo),
                supply: this._supply(height, supplyRpc),
                emission: this._emission(height, supplyRpc),
                treasury: this._treasury(height, devfeeRpc),
                randomx: this._randomx(height, randomxRpc),
                mempool: mempool ? {
                    transactions: mempool.size,
                    bytes: mempool.bytes,
                    usage: mempool.usage
                } : null,
                peers: netInfo ? {
                    connections: netInfo.connections,
                    inbound: netInfo.connections_in,
                    outbound: netInfo.connections_out,
                    version: netInfo.subversion,
                    warnings: netInfo.warnings || ''
                } : null,
                blocks
            };
        } catch (err) {
            // Keep the last good snapshot; just mark the node down.
            this.snapshot = {
                ...this.snapshot,
                nodeOnline: false,
                error: err.message
            };
            this.log.warn(`node unreachable: ${err.message}`);
        } finally {
            this.polling = false;
        }
    }

    // -----------------------------------------------------------------------

    _chain(chainInfo, mining, netInfo) {
        const progress = chainInfo.verificationprogress;
        return {
            name: chainInfo.chain,
            blocks: chainInfo.blocks,
            headers: chainInfo.headers,
            bestBlockHash: chainInfo.bestblockhash,
            difficulty: chainInfo.difficulty,
            medianTime: chainInfo.mediantime,
            sizeOnDisk: chainInfo.size_on_disk,
            pruned: chainInfo.pruned === true,
            // A node still catching up must say so loudly -- every number below
            // it is a number about the past, not about the network.
            syncing: chainInfo.blocks < chainInfo.headers ||
                     (progress !== undefined && progress < 0.9999),
            verificationProgress: progress,
            blocksBehind: Math.max(0, (chainInfo.headers || 0) - chainInfo.blocks),
            // getnetworkhashps over its default 120 blocks, which is what
            // every other pool on this chain publishes. The window is carried
            // beside the number rather than left unstated: an average with no
            // scale is how one quantity came to have four different values
            // across two pages, and saying so costs nothing.
            networkHashPerSecond: mining ? (mining.networkhashps || 0) : null,
            networkHashWindowBlocks: 120,
            connections: netInfo ? netInfo.connections : null,
            targetSpacing: POW_TARGET_SPACING
        };
    }

    _supply(height, supplyRpc) {
        // Prefer the node's own answer; it is computed by consensus code.
        if (supplyRpc) {
            const v = supplyRpc.founder_vesting || null;
            return {
                source: 'node',
                circulating: this._toSat(supplyRpc.circulating),
                maxSupply: this._toSat(supplyRpc.max_supply),
                premine: this._toSat(supplyRpc.premine),
                miningAllocation: this._toSat(supplyRpc.mining_allocation),
                percentMined: supplyRpc.percent_mined,
                vesting: v ? {
                    total: this._toSat(v.total),
                    unlocked: this._toSat(v.unlocked),
                    locked: this._toSat(v.locked),
                    schedule: (v.schedule || []).map((t) => ({
                        tranche: t.tranche,
                        amount: this._toSat(t.amount),
                        unlockTime: t.unlock_time,
                        unlocked: t.unlocked
                    }))
                } : this._localVesting()
            };
        }

        // Fallback: recompute locally from the same constants.
        return {
            source: 'explorer',
            circulating: this._localCirculating(height),
            maxSupply: MAX_MONEY_WAM * COIN,
            premine: GENESIS_PREMINE_WAM * COIN,
            miningAllocation: (MAX_MONEY_WAM - GENESIS_PREMINE_WAM) * COIN,
            percentMined: 100 * this._localCirculating(height) / (MAX_MONEY_WAM * COIN),
            vesting: this._localVesting()
        };
    }

    _localVesting() {
        const now = Math.floor(Date.now() / 1000);
        const schedule = PREMINE_UNLOCK_TIMES.map((t, i) => ({
            tranche: i + 1,
            amount: PREMINE_TRANCHE_AMOUNT_WAM * COIN,
            unlockTime: t,
            unlocked: t === 0 || now >= t
        }));
        const unlocked = schedule.filter((t) => t.unlocked).length
                       * PREMINE_TRANCHE_AMOUNT_WAM * COIN;
        return {
            total: GENESIS_PREMINE_WAM * COIN,
            unlocked,
            locked: GENESIS_PREMINE_WAM * COIN - unlocked,
            schedule
        };
    }

    _localCirculating(height) {
        let supply = GENESIS_PREMINE_WAM * COIN;
        if (height < 1) return supply;

        const completed = Math.floor((height - 1) / SUBSIDY_HALVING_INTERVAL);
        for (let e = 0; e < completed && e < MAX_HALVINGS; e++) {
            supply += SUBSIDY_HALVING_INTERVAL * Math.floor(INITIAL_BLOCK_SUBSIDY_WAM * COIN / 2 ** e);
        }
        if (completed < MAX_HALVINGS) {
            const into = ((height - 1) % SUBSIDY_HALVING_INTERVAL) + 1;
            supply += into * Math.floor(INITIAL_BLOCK_SUBSIDY_WAM * COIN / 2 ** completed);
        }
        return supply;
    }

    /**
     * The emission at this height -- from the node wherever possible.
     *
     * This used to recompute the whole schedule locally from
     * SUBSIDY_HALVING_INTERVAL. On mainnet that is right by luck, because the
     * constant happens to match. On every network the project actually tests
     * on it is wrong: regtest halves every 150 blocks, so at height 3,914 the
     * real subsidy had halved 25 times to 149 satoshi while this dashboard
     * cheerfully reported "50.00 WAM" and "next halving in 196,086 blocks".
     *
     * The failure mode is the quiet one. Nobody is misled about a number they
     * were going to check anyway -- they are misled about the number they were
     * checking *with*. `getsupplyinfo` already returns every one of these
     * values from consensus code; there was never a reason to guess.
     */
    _emission(height, supplyRpc) {
        const has = (key) => supplyRpc &&
            supplyRpc[key] !== undefined && supplyRpc[key] !== null;
        const toSat = (wam) => Math.round(Number(wam) * COIN);

        if (has('halving_interval') && has('block_subsidy')) {
            const interval = supplyRpc.halving_interval;
            const subsidy = toSat(supplyRpc.block_subsidy);
            const treasury = has('treasury_subsidy')
                ? toSat(supplyRpc.treasury_subsidy)
                : Math.floor(subsidy * DEVFEE_PERCENT / 100);
            const nextHalving = has('next_halving_height')
                ? supplyRpc.next_halving_height
                : nextHalvingHeight(height, interval);
            const blocksToHalving = has('blocks_until_halving')
                ? supplyRpc.blocks_until_halving
                : nextHalving - height;

            return {
                epoch: has('halving_epoch') ? supplyRpc.halving_epoch : 0,
                subsidy,
                minerSubsidy: has('miner_subsidy')
                    ? toSat(supplyRpc.miner_subsidy) : subsidy - treasury,
                treasurySubsidy: treasury,
                halvingInterval: interval,
                nextHalvingHeight: nextHalving,
                blocksUntilHalving: blocksToHalving,
                secondsUntilHalving: blocksToHalving * POW_TARGET_SPACING,
                emissionEndsAtHeight: MAX_HALVINGS * interval,
                source: 'node'
            };
        }

        // Fallback: an unpatched or unreachable node. Mirrors
        // wam::GetBlockSubsidy + GetDevFeeAmount, and says so, because a
        // number computed here is a guess about what the chain is doing.
        const epoch = height >= 1
            ? Math.floor((height - 1) / SUBSIDY_HALVING_INTERVAL) : 0;
        const subsidy = epoch >= MAX_HALVINGS
            ? 0 : Math.floor(INITIAL_BLOCK_SUBSIDY_WAM * COIN / 2 ** epoch);

        const treasuryActive = height >= 1 && height <= DEVFEE_LAST_HEIGHT;
        const treasury = treasuryActive ? Math.floor(subsidy * DEVFEE_PERCENT / 100) : 0;

        const nextHalving = nextHalvingHeight(height);
        const blocksToHalving = nextHalving - height;

        return {
            epoch,
            subsidy,
            minerSubsidy: subsidy - treasury,
            treasurySubsidy: treasury,
            halvingInterval: SUBSIDY_HALVING_INTERVAL,
            nextHalvingHeight: nextHalving,
            blocksUntilHalving: blocksToHalving,
            secondsUntilHalving: blocksToHalving * POW_TARGET_SPACING,
            emissionEndsAtHeight: MAX_HALVINGS * SUBSIDY_HALVING_INTERVAL,
            source: 'local'
        };
    }

    _treasury(height, devfeeRpc) {
        // Prefer the node's own values. A dashboard showing a different expiry
        // than the chain actually enforces would be worse than showing none,
        // and `last_height` is exactly the sort of constant that drifts.
        const lastHeight = (devfeeRpc && Number.isInteger(devfeeRpc.last_height))
            ? devfeeRpc.last_height : DEVFEE_LAST_HEIGHT;
        const percent = (devfeeRpc && devfeeRpc.percent !== undefined)
            ? devfeeRpc.percent : DEVFEE_PERCENT;

        const active = (devfeeRpc && typeof devfeeRpc.active_now === 'boolean')
            ? devfeeRpc.active_now
            : (height >= 1 && height <= lastHeight);

        const remaining = (devfeeRpc && Number.isInteger(devfeeRpc.blocks_remaining))
            ? devfeeRpc.blocks_remaining
            : Math.max(0, lastHeight - height);

        return {
            source: devfeeRpc ? 'node' : 'explorer',
            address: devfeeRpc ? devfeeRpc.address : null,
            script: devfeeRpc ? devfeeRpc.script : null,
            percent,
            active,
            lastHeight,
            blocksRemaining: remaining,
            secondsRemaining: remaining * POW_TARGET_SPACING,
            requiredNow: devfeeRpc ? this._toSat(devfeeRpc.required_now) : null,
            lifetimeTotal: devfeeRpc ? this._toSat(devfeeRpc.lifetime_total) : null
        };
    }

    _randomx(height, rx) {
        if (!rx) return null;
        return {
            seedHeight: rx.seed_height,
            seedHash: rx.seed_hash,
            bootstrap: rx.bootstrap,
            epochBlocks: rx.epoch_blocks,
            epochLag: rx.epoch_lag,
            blocksUntilRotation: rx.blocks_until_rotation,
            secondsUntilRotation: (rx.blocks_until_rotation || 0) * POW_TARGET_SPACING,
            memoryBytes: rx.memory_bytes
        };
    }

    // -----------------------------------------------------------------------

    async _recentBlocks(tipHeight) {
        const wanted = [];
        for (let h = tipHeight; h > tipHeight - RECENT_BLOCKS && h >= 0; h--) wanted.push(h);

        const out = [];
        for (const h of wanted) {
            if (this.blockCache.has(h)) {
                out.push(this.blockCache.get(h));
                continue;
            }
            try {
                const hash = await this.rpc.call('getblockhash', [h]);
                const block = await this.rpc.call('getblock', [hash, 1]);

                const summary = {
                    height: block.height,
                    hash: block.hash,
                    time: block.time,
                    txCount: block.nTx !== undefined ? block.nTx : (block.tx || []).length,
                    size: block.size,
                    weight: block.weight,
                    difficulty: block.difficulty,
                    bits: block.bits,
                    nonce: block.nonce,
                    version: block.version
                };

                this.blockCache.set(h, summary);
                out.push(summary);
            } catch (err) {
                this.log.debug(`could not read block ${h}: ${err.message}`);
            }
        }

        // Blocks below the tip can still be reorganised out; only cache what is
        // buried deeply enough that re-reading it is wasted work.
        for (const h of this.blockCache.keys()) {
            if (h > tipHeight - 6 || h < tipHeight - 500) this.blockCache.delete(h);
        }

        return out;
    }

    _toSat(v) {
        if (v === null || v === undefined) return null;
        // Bitcoin RPC returns amounts as floating-point WAM. Rounding through
        // an integer here keeps every downstream number exact.
        return Math.round(Number(v) * COIN);
    }

    // -----------------------------------------------------------------------
    // On-demand lookups (not part of the polled snapshot)
    // -----------------------------------------------------------------------

    async lookup(query) {
        const q = String(query).trim();
        if (!q) throw new Error('empty query');

        // A bare number is a height.
        if (/^\d+$/.test(q)) {
            const hash = await this.rpc.call('getblockhash', [parseInt(q, 10)]);
            return { type: 'block', data: await this.rpc.call('getblock', [hash, 1]) };
        }

        if (/^[0-9a-fA-F]{64}$/.test(q)) {
            // A 64-hex string is either a block hash or a txid.
            try {
                return { type: 'block', data: await this.rpc.call('getblock', [q, 1]) };
            } catch {
                const tx = await this.rpc.call('getrawtransaction', [q, true]);
                return { type: 'transaction', data: tx };
            }
        }

        throw new Error('enter a block height, a block hash, or a transaction id');
    }

    /** Audit a block against consensus rule WAM-1. */
    async auditBlock(hashOrHeight) {
        let hash = hashOrHeight;
        if (/^\d+$/.test(String(hashOrHeight))) {
            hash = await this.rpc.call('getblockhash', [parseInt(hashOrHeight, 10)]);
        }
        const result = await this.rpc.tryCall('getdevfeeinfo', [hash], null);
        if (!result || !result.block) {
            throw new Error(
                'this node does not support getdevfeeinfo -- rebuild wamd with the ' +
                'WAM RPC commands to enable treasury auditing');
        }
        return result;
    }
}

module.exports = Collector;
