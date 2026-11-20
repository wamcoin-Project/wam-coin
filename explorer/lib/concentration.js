'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// Who is writing this chain?
//
// Mainnet opened at 00:00 UTC on 2026-09-15. By 00:19 one payout address had
// found 77 of the first 79 blocks -- 97.5% -- and the first people to notice
// were miners who had won nothing, in a chat, at half past two in the
// morning. They concluded the coin was rigged and left. The number that would
// have explained it was published nowhere: not on this explorer, not on the
// ops panel, not in any of the fifty-four launch checks.
//
// So it is published here, permanently, high or low. A reader should never
// have to take our word for how concentrated the hash rate is, and a miner
// deciding which pool to point at should be able to see which pool needs
// them. Concentration is fixed by miners choosing, and by nothing else, so
// the number has to be in front of the people doing the choosing.
//
// WHAT IS COUNTED
//
// The largest output of each coinbase. That is always the miner's: the
// treasury takes 5% of the subsidy by consensus, and the miner takes the
// other 95% plus every fee in the block, so no halving or fee spike can swap
// them round.
//
// One address is not one person. A pool pays its own address and then
// distributes, so the COINS spread out while the HASH RATE stays under one
// operator's hand -- and it is the operator's hand that decides whether the
// chain gets rewritten. That is why this counts addresses and says plainly
// that it counts addresses.
// ---------------------------------------------------------------------------

// How many blocks back the published share is measured over. 50 is about an
// hour at the 120-second target: long enough that one lucky pool does not
// look like a majority, short enough that a real shift shows the same day.
const WINDOW = 50;

// And the long one, because the short one is not the number the project's own
// public condition is written against.
//
// The founder published a target of no finder above 35% OF BLOCKS OVER SEVEN
// DAYS. A second condition -- no application to any exchange above 50% --
// stood beside it and was withdrawn on 20 November 2026 as having been
// written for the opening weeks; see docs/CONCENTRATION.md, which says so
// rather than dropping the sentence. The seven-day window is what either
// one is measured over, which is why this module publishes it.
// This module published 48 blocks -- an hour and a half. Within one day that
// short window read 100% and then 54%, while the share over the whole chain
// moved from 97% to 72%. A reader shown only the short figure gets a picture
// worse than the truth in one direction and better in the other, and cannot
// tell which.
//
// 5040 blocks is seven days at the 120-second target. On a chain younger than
// that it covers every block there has ever been, which is what makes it the
// honest denominator today.
const LONG_WINDOW = 5040;

// Heights fetched per refresh. The explorer answers page loads on the same
// event loop, and a cold start asking for fifty blocks at once is a page that
// hangs. It fills in over a few cycles instead.
//
// The long window needs a bigger bite or it would take hours to fill: at 12 a
// cycle, 5040 blocks is 420 cycles. Blocks on this chain carry one
// transaction, so the cost is a round trip rather than parsing.
const MAX_FETCH_PER_CYCLE = 12;
const MAX_BACKFILL_PER_CYCLE = 250;

// How long a height that could not be read stays unread.
//
// On a PRUNED NODE -- a configuration this project supports and this very
// panel displays -- every height below the prune horizon fails, for ever.
// Without this, each one is retried on every single pass.
//
// An hour, because the one thing that changes the answer is an operator
// re-indexing the node, and nobody does that twice in an hour.
const UNREADABLE_FOR_MS = 60 * 60 * 1000;

// The least time between two fetch passes, however often the endpoint is
// asked.
//
// /api/concentration awaited update() inline on EVERY request, with no
// cache and nothing in front of it, so each request was its own fetch pass
// against the node. The dashboard refreshes every six seconds per open tab
// and the explorer's README states the invariant this broke: "Ten open tabs
// cost the node exactly what one does."
//
// Ten seconds matches the collector's own snapshot interval, so a reader
// sees data no staler than the rest of the page already is.
const MIN_REFRESH_MS = 10 * 1000;

class Concentration {
    constructor(log) {
        this.log = log;
        this.finders = new Map();      // height -> payout address
        this.unreadable = new Map();   // height -> when it last failed
        this.tip = 0;
        this._lastPass = 0;
        this._inFlight = null;
    }

    /**
     * What the endpoint calls. At most one pass at a time, and at most one
     * per MIN_REFRESH_MS however many callers there are.
     *
     * THE HANDLER USED TO BE THE RATE LIMIT, AND IT WAS NOT ONE.
     *
     * explorer/server.js awaited update() directly on every unauthenticated
     * GET. Two things followed. Concurrent requests each started their own
     * pass, and repeated requests each paid the full cost again, because a
     * height that failed was never remembered as having failed.
     *
     * The guard is here rather than in the handler so that it cannot be
     * forgotten by the next caller -- and there is a next caller, since the
     * collector refreshes this too.
     *
     * Reported by Fahrizal, 18 November 2026: one GET against an explorer
     * attached to a pruned node drove 9,986 sequential RPC calls, and the
     * repeat drove 9,986 more.
     */
    async refresh(rpc, tipHeight) {
        if (this._inFlight) return this._inFlight;
        const now = Date.now();
        if (now - this._lastPass < MIN_REFRESH_MS) return;
        this._inFlight = this.update(rpc, tipHeight)
            .catch((err) => {
                this.log.debug(`concentration: refresh failed: ${err.message}`);
            })
            .finally(() => {
                this._lastPass = Date.now();
                this._inFlight = null;
            });
        return this._inFlight;
    }

    /**
     * Fetch any heights in the window we have not seen. Cheap after the first
     * pass: only new blocks are unknown.
     */
    async update(rpc, tipHeight) {
        this.tip = tipHeight;
        let fetched = 0;

        // The recent window first and always: it is what a miner refreshing
        // the page is looking at. Only once it is complete does the long one
        // get the rest of this cycle's budget.
        const recentComplete = this._complete(tipHeight, WINDOW);
        const budget = recentComplete ? MAX_BACKFILL_PER_CYCLE : MAX_FETCH_PER_CYCLE;
        const depth = recentComplete ? LONG_WINDOW : WINDOW;

        const now = Date.now();
        for (let h = tipHeight; h > tipHeight - depth && h >= 1; h--) {
            if (this.finders.has(h)) continue;

            // A height that just failed is not asked about again yet.
            const failedAt = this.unreadable.get(h);
            if (failedAt !== undefined && now - failedAt < UNREADABLE_FOR_MS) continue;

            // THE BUDGET COUNTS ATTEMPTS, BECAUSE IT IS A BUDGET.
            //
            // `fetched++` sat at the bottom of the try, so it only ever
            // counted SUCCESSES, and the catch swallowed a failed height
            // without counting it at all. On a healthy node that is a
            // distinction without a difference. On a pruned node -- where
            // getblock fails for every height below the prune horizon --
            // `fetched` stays near zero, the break never fires, and one
            // pass walks all 5040 heights of the long window at two RPC
            // calls each.
            //
            // Measured by Fahrizal, 18 November 2026: 500 calls for a
            // healthy cold request, where the budget binds, against 9,986
            // on a pruned node.
            if (fetched >= budget) break;
            fetched++;

            try {
                const hash = await rpc.call('getblockhash', [h]);
                const block = await rpc.call('getblock', [hash, 2]);
                const outs = ((block.tx || [])[0] || {}).vout || [];
                if (!outs.length) continue;
                const biggest = outs.reduce((a, b) => (b.value > a.value ? b : a));
                const addr = (biggest.scriptPubKey || {}).address;
                // THE TIME IS KEPT BECAUSE THE PAGE WAS ASSUMING IT.
                //
                // The summary read "47 blocks, about 2h", and the hours were
                // blocksRead x 2 / 60 -- the target interval, multiplied out.
                // It is not a measurement, and on a chain running slower or
                // faster than target it states a span that never happened. The
                // block already carries its own timestamp and it is already
                // fetched here, so the honest number costs nothing.
                if (addr) this.finders.set(h, { addr, time: block.time || null });
                this.unreadable.delete(h);
            } catch (err) {
                // A height we cannot read is left out of the denominator, not
                // guessed at. The snapshot says how many it actually read.
                //
                // And it is remembered as unreadable, so the next pass does
                // not pay for it again. Nothing was remembered before, which
                // is why a repeat request cost exactly what the first one did.
                this.unreadable.set(h, now);
                this.log.debug(`concentration: block ${h}: ${err.message}`);
            }
        }

        // Anything below the LONG window is no longer part of any answer.
        // Blocks near the tip can still be reorganised away, so they are
        // re-read.
        for (const h of this.finders.keys()) {
            if (h < tipHeight - LONG_WINDOW || h > tipHeight - 3) this.finders.delete(h);
        }
        // The same bound for the failures, so this map cannot outgrow the
        // window it describes.
        for (const h of this.unreadable.keys()) {
            if (h < tipHeight - LONG_WINDOW || h > tipHeight - 3) this.unreadable.delete(h);
        }
    }

    /** Have we read every height in the last `depth` blocks? */
    _complete(tipHeight, depth) {
        for (let h = tipHeight - 3; h > tipHeight - depth && h >= 1; h--) {
            if (!this.finders.has(h)) return false;
        }
        return true;
    }

    /** Tally over the last `depth` heights we hold. */
    _tally(depth) {
        const tally = new Map();
        let total = 0;
        let first = null, last = null;
        let lowest = null, highest = null;
        for (const [h, rec] of this.finders) {
            if (h <= this.tip - depth) continue;
            const addr = rec.addr;
            tally.set(addr, (tally.get(addr) || 0) + 1);
            total++;
            if (lowest === null || h < lowest) lowest = h;
            if (highest === null || h > highest) highest = h;
            if (rec.time) {
                if (first === null || rec.time < first) first = rec.time;
                if (last === null || rec.time > last) last = rec.time;
            }
        }
        const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
        return {
            window: depth,
            blocksRead: total,
            // WHICH BLOCKS, NOT JUST HOW MANY.
            //
            // The long window is capped at 5040, so once the chain passed
            // that height "5037 blocks" became a constant and has printed
            // the same number every day since. It rolls -- heights below the
            // window are dropped on every update -- but nothing on the page
            // showed that, so the founder watched it for days and concluded
            // the panel had frozen and was lying to readers.
            //
            // A count cannot show movement. A range can: the heights move
            // every two minutes, in front of whoever is watching.
            // The heights actually tallied, not the window's arithmetic
            // bounds. The newest three blocks are held back because they can
            // still be reorganised away, so `tip` is not in this answer and
            // printing it as the end of the range would state a block that
            // was never counted.
            fromHeight: lowest,
            toHeight: highest,
            // Measured from the oldest and newest block in the window, in
            // seconds, or null when fewer than two blocks carry a time.
            spanSeconds: (first !== null && last !== null && last > first)
                ? last - first : null,
            distinct: ranked.length,
            topPercent: total ? (100 * ranked[0][1]) / total : null,
            top: ranked.slice(0, 5).map(([addr, n]) => ({
                finder: addr.length > 16 ? `${addr.slice(0, 10)}…${addr.slice(-4)}` : addr,
                blocks: n,
                percent: (100 * n) / total
            }))
        };
    }

    /**
     * {window, blocksRead, distinct, top[], topPercent} -- or blocksRead 0
     * before the first pass has anything, which the page must not draw as 0%.
     */
    snapshot() {
        // The recent window stays at the top level, so nothing that already
        // reads this endpoint breaks. The seven-day figure -- the one the
        // published condition is actually written against -- sits beside it,
        // named, with how much of it has been read so far.
        //
        // Addresses are shortened for the same reason the pool API redacts
        // workers: the question is how concentrated the chain is, not who
        // exactly is mining it, and a published list of miners is a published
        // list of targets.
        const recent = this._tally(WINDOW);
        const long = this._tally(LONG_WINDOW);
        return {
            ...recent,
            sevenDay: {
                ...long,
                complete: this._complete(this.tip, LONG_WINDOW),
                // What the founder committed to in public, so the number and
                // the rule it is judged against are never separated.
                noApplicationAbove: 50,
                targetBelow: 35
            }
        };
    }
}

module.exports = { Concentration, WINDOW };
