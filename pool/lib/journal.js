'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  journal.js -- the record of what was paid, where redis cannot reach it
// ===========================================================================
//
//  WHY THIS FILE EXISTS
//
//  Everything the pool knows about who has been paid lives in redis, and
//  redis is not built to remember. On its defaults it snapshots to disk
//  every few minutes and appendonly is off. Kill the process, lose power,
//  fail over to a replica that was behind, restore a backup -- and redis
//  comes back a few minutes younger than it was. That is not a fault in
//  redis; it is what redis is.
//
//  Every protection the payment path has is written INTO redis:
//
//    payment:inflight   says a broadcast happened and a commit did not
//    payments:done      says this transaction has already been committed
//    balances           says what is still owed
//
//  A rollback takes all three together. The balances come back owed, the
//  marker that would have paused the pool is gone, the txid that would have
//  refused the second commit is gone, and the next run reads a perfectly
//  consistent state saying these miners have not been paid. They have. The
//  coins left the wallet, and the wallet does not roll back.
//
//  So the one record that must outlive redis cannot live in redis. It lives
//  here: an append-only file, fsynced before the money moves, holding only
//  what is needed to notice that redis has gone backwards.
//
//  Reported by dang150296 (Urriki1502) on 10 November 2026.
//
//  WHY NOT THE WALLET
//
//  The wallet is the true record of what was paid and it needs no new file.
//  It is also the wrong record to reconcile against: it holds every send the
//  operator makes -- fee sweeps, treasury moves, a payment by hand -- and a
//  pool that paused whenever the wallet held a send it did not recognise
//  would pause on the operator's own work. The journal records only what
//  this pool broadcast, which is exactly the set that may not be repeated.
//
//  WHAT IT DOES NOT DO
//
//  It does not make redis durable and it cannot rebuild what a rollback
//  destroyed. A rollback still loses shares, credits and balances; those are
//  recoverable, slowly, from the chain. What it must never do is pay again.
//  This file exists to make that case loud instead of invisible.
// ===========================================================================

const fs = require('fs');
const path = require('path');

/** The states a payment passes through. The first is always written first. */
const BROADCAST = 'broadcast';
const COMMITTED = 'committed';
const ABANDONED = 'abandoned';

/**
 * How much of the tail to read.
 *
 * The file only grows, and what it is asked is always about the recent past:
 * a redis snapshot is minutes old, a replica that was behind is seconds
 * behind, and the oldest restore anybody would perform is hours. 256 KiB is
 * on the order of a thousand payments -- about a week at a ten-minute
 * interval -- which is far beyond any of those, and it keeps the work a
 * payment run does constant rather than growing for the life of the pool.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * How many of those transactions a single reconciliation asks redis about.
 *
 * A payment run happens every ten minutes, so a hundred is more than a day
 * of history re-checked on every tick, and the work a run does stays
 * constant for the life of the pool instead of growing with it.
 *
 * Nothing scrolls out of that window unnoticed, because everything this
 * window is looking for STOPS THE POOL. A rollback or a stranded broadcast
 * is fatal, payments halt, no new entries are written, and the hundred
 * newest stay the hundred newest until a person has dealt with it.
 */
const CHECK_RECENT = 100;

class PaymentJournal {
    /**
     * @param {string} filePath  the append-only file
     * @param {{info,warn,error}} log
     */
    constructor(filePath, log) {
        this.path = filePath;
        this.log = log || { info() {}, warn() {}, error() {} };
    }

    /**
     * Append one line and make it survive a power cut.
     *
     * This throws rather than swallowing. A journal that cannot be written
     * is a payment that must not be broadcast, and the caller treats it that
     * way -- the whole value of the file is that it is there BEFORE the
     * money moves.
     */
    _append(record) {
        const line = JSON.stringify(record) + '\n';
        const existed = fs.existsSync(this.path);
        if (!existed) fs.mkdirSync(path.dirname(this.path), { recursive: true });
        const fd = fs.openSync(this.path, 'a');
        try {
            fs.writeSync(fd, line);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        if (!existed) {
            // The directory entry for a file that has just been created is
            // itself buffered, so the first append needs the directory
            // synced too, or a crash can leave the bytes written and the
            // name missing. Windows will not open a directory as a file and
            // the pool does not run there; on such a platform the file's own
            // fsync is what there is, and it is not worth refusing to pay
            // over.
            try {
                const dir = fs.openSync(path.dirname(this.path), 'r');
                try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
            } catch { /* see above */ }
        }
    }

    /** Written BEFORE the broadcast, with what is needed to settle it. */
    recordBroadcast(txid, total, payouts) {
        this._append({ at: Date.now(), state: BROADCAST, txid, total, payouts });
    }

    /** Written after the commit has been applied, and only then. */
    recordCommitted(txid) {
        this._append({ at: Date.now(), state: COMMITTED, txid });
    }

    /**
     * Written when the node refused the transaction outright, so no coins
     * moved. Without this line a refusal would leave a broadcast that was
     * never committed and never sent, and the reconciliation below would
     * read it as money in the air for ever.
     */
    recordAbandoned(txid, why) {
        this._append({ at: Date.now(), state: ABANDONED, txid, why: String(why).slice(0, 300) });
    }

    /** True if the file has ever been written. */
    exists() {
        return fs.existsSync(this.path);
    }

    /**
     * The transactions in the tail of the journal, newest write last.
     *
     * A line that will not parse is counted and skipped rather than thrown
     * on: a truncated last line is what a power cut during an append looks
     * like, and refusing to read the file at all would turn one lost line
     * into a pool that cannot start.
     */
    read() {
        let fd;
        try {
            fd = fs.openSync(this.path, 'r');
        } catch (err) {
            if (err.code === 'ENOENT') return { entries: new Map(), damaged: 0, partial: false };
            throw err;
        }

        let text;
        let partial = false;
        try {
            const size = fs.fstatSync(fd).size;
            const from = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
            partial = from > 0;
            const buf = Buffer.alloc(size - from);
            fs.readSync(fd, buf, 0, buf.length, from);
            text = buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }

        const lines = text.split('\n');
        // A tail that starts mid-file almost certainly starts mid-line.
        if (partial) lines.shift();

        const entries = new Map();
        let damaged = 0;
        for (const line of lines) {
            if (!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch { damaged++; continue; }
            if (!rec || typeof rec.txid !== 'string') { damaged++; continue; }
            const held = entries.get(rec.txid) || { txid: rec.txid };
            if (rec.state === BROADCAST) {
                held.broadcastAt = rec.at;
                held.total = rec.total;
                held.payouts = rec.payouts;
            } else if (rec.state === COMMITTED) {
                held.committedAt = rec.at;
            } else if (rec.state === ABANDONED) {
                held.abandonedAt = rec.at;
                held.why = rec.why;
            } else {
                damaged++;
                continue;
            }
            entries.set(rec.txid, held);
        }
        return { entries, damaged, partial };
    }
}

/**
 * Has redis gone backwards since the last payment?
 *
 * Returns a list of complaints, each a sentence an operator can act on, each
 * marked fatal or not. A fatal complaint means payments must stop.
 *
 * TWO QUESTIONS, AND THEY FAIL IN DIFFERENT DIRECTIONS.
 *
 *   A transaction the journal says was COMMITTED which redis does not have
 *   in payments:done. Redis has lost a payment it had already recorded, so
 *   the balances it holds are older than the money. That is the rollback.
 *
 *   A transaction the journal says was BROADCAST, never committed and never
 *   abandoned, with no payment:inflight marker in redis to match it. Either
 *   the marker rolled back or a commit applied without the line that follows
 *   it; in both cases redis cannot be trusted to refuse a second payment of
 *   the same balances.
 *
 * The opposite direction -- a journal that is missing while redis holds
 * committed payments -- is a lost or moved file, not lost money. It is
 * reported and it does not stop payments: halting every miner's money over a
 * log file would be a worse answer than the problem.
 */
async function reconcile(journal, redis, doneKey, inflightRaw) {
    const complaints = [];

    if (!journal.exists()) {
        const scard = Number(await redis.scard(doneKey).catch(() => 0));
        if (scard > 0) {
            complaints.push({
                fatal: false,
                text: `redis records ${scard} committed payment(s) and ` +
                      `${journal.path} does not exist. Until the next payment ` +
                      'writes it, nothing outside redis can notice a rollback.'
            });
        }
        return complaints;
    }

    const { entries, damaged } = journal.read();

    if (damaged) {
        complaints.push({
            fatal: false,
            text: `${damaged} line(s) in ${journal.path} could not be read. One ` +
                  'is what a power cut during an append looks like; more than ' +
                  'one means the file has been edited.'
        });
    }

    let inflightTxid = null;
    if (inflightRaw) {
        try {
            inflightTxid = (JSON.parse(inflightRaw) || {}).txid || null;
        } catch { /* the unfinished-run report says this better */ }
    }

    const recent = [...entries.values()].slice(-CHECK_RECENT);

    for (const entry of recent) {
        // The node refused it outright, so no coins moved and there is
        // nothing to reconcile.
        if (entry.abandonedAt) continue;

        // eslint-disable-next-line no-await-in-loop
        const inRedis = Number(await redis.sismember(doneKey, entry.txid)) === 1;

        if (entry.committedAt) {
            if (!inRedis) {
                complaints.push({
                    fatal: true,
                    text: `${entry.txid} was committed on ` +
                          `${new Date(entry.committedAt).toISOString()} and redis ` +
                          `does not have it in ${doneKey}. Redis is older than ` +
                          'the money: balances it still shows as owed have ' +
                          'already been paid.'
                });
            }
            continue;
        }

        // Broadcast, with no line to say what became of it.

        // Redis says it is in flight. That is the ordinary unfinished run,
        // and the marker is what handles it.
        if (entry.txid === inflightTxid) continue;

        // Redis says it was committed. Then the commit applied and the line
        // that follows it did not get written -- redis is AHEAD of the
        // journal, which costs nothing and must not stop payments. Write the
        // missing line so the question is not asked again.
        if (inRedis) {
            let healed = true;
            try { journal.recordCommitted(entry.txid); } catch { healed = false; }
            complaints.push({
                fatal: false,
                text: `${entry.txid} was committed and the journal did not say ` +
                      `so. ${healed ? 'The missing line has been written.'
                                    : 'The missing line could not be written.'}`
            });
            continue;
        }

        // Neither. The money may have left the wallet with nothing in redis
        // knowing it -- which is the state a rollback leaves behind.
        complaints.push({
            fatal: true,
            text: `${entry.txid} was broadcast on ` +
                  `${new Date(entry.broadcastAt).toISOString()}, was never ` +
                  'committed, and redis has no marker for it. The coins may ' +
                  'have left the wallet with nothing in redis knowing it.'
        });
    }

    return complaints;
}

module.exports = {
    PaymentJournal, reconcile, TAIL_BYTES, CHECK_RECENT,
    BROADCAST, COMMITTED, ABANDONED
};
