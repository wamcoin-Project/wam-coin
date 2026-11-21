#!/usr/bin/env node
'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  resolve_lost_payment.js -- finish the recovery the pool prints
// ===========================================================================
//
//      node pool/scripts/resolve_lost_payment.js [--config pool/config.json]
//      node pool/scripts/resolve_lost_payment.js --dry-run
//
//  WHY THIS EXISTS
//
//  A payment run writes its journal line BEFORE the broadcast, on purpose:
//  if the process dies between those two instants, the line is the only
//  record that money may be in the air. The pool then printed a recovery
//  banner that ended:
//
//      If no such transaction exists, nothing was sent. Clear the
//      marker and the next run will pay normally.
//          redis-cli DEL wam:payment:inflight
//
//  That instruction is half of a recovery, and the half it leaves out is
//  the one the software checks. reconcile() in pool/lib/journal.js reads
//  "broadcast, never committed, and redis has no marker" as FATAL -- on
//  every payment run, for ever -- and _processPayments pauses instead of
//  paying. An operator who did exactly what the screen told them halts all
//  miner payouts, permanently, and the only way out is to hand-write an
//  `abandoned` line into a file format nothing documents.
//
//  The FATAL is correct and is not being softened. "Broadcast, uncommitted,
//  no marker" really can mean the coins left the wallet with nothing in
//  redis knowing it, and a pool that pays on through that state pays twice.
//  What was missing was a way to tell it the truth.
//
//  Reported by Fahrizal, 18 November 2026, with ten runs of a harness over
//  the real PaymentJournal, the real reconcile() and the real
//  _processPayments.
//
//  WHAT THIS DOES
//
//  Asks the NODE, not the operator, whether each unresolved transaction
//  exists. The node is the only thing that knows, and "I checked the
//  wallet" is a human reading a list under pressure at the hour a payment
//  run died.
//
//    the node says it does not exist   -> write the abandoned line, clear
//                                         the marker if it names that txid.
//                                         The next run pays normally, and
//                                         means it this time.
//
//    the node says it DOES exist       -> change nothing, and say so. The
//                                         money left. Balances must be
//                                         deducted by hand, which is the
//                                         other branch of the banner, and
//                                         no tool should do that silently.
//
//    the node cannot be asked, or is   -> change nothing. A transaction
//    still syncing, or answers in a       that cannot be found by a node
//    way this cannot read                 that has not finished syncing is
//                                         not a transaction that does not
//                                         exist.
//
//  EXIT CODES
//
//      0   nothing needed resolving, or everything resolvable was resolved
//      1   something needs a person: a transaction that really was sent, or
//          a node that could not answer
//      2   it could not run at all (no config, no redis, no journal)
// ===========================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { PaymentJournal, reconcile, DEFAULT_JOURNAL } =
    require(path.join(ROOT, 'lib', 'journal'));

const RED = '\x1b[31m', GRN = '\x1b[32m', YLW = '\x1b[33m',
      BLD = '\x1b[1m', DIM = '\x1b[2m', OFF = '\x1b[0m';

function usage(code) {
    console.log(`
  ${BLD}resolve_lost_payment.js${OFF} -- finish the recovery the pool prints

    node pool/scripts/resolve_lost_payment.js [options]

    --config <path>   the pool config (default: pool/config.json)
    --txid <hex>      resolve only this one
    --dry-run         say what would be written, write nothing
    --help

  Run this when the pool has paused and reconcile is complaining that a
  transaction was broadcast, never committed, and redis has no marker for
  it. It asks the node whether that transaction exists and records the
  answer. It never moves money and never deducts a balance.
`);
    process.exit(code);
}

function parseArgs(argv) {
    const out = { config: path.join(ROOT, 'config.json'), txid: null, dryRun: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') usage(0);
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--config') out.config = argv[++i];
        else if (a === '--txid') out.txid = argv[++i];
        else { console.error(`unknown argument: ${a}`); usage(2); }
    }
    return out;
}

/**
 * Does the node have this transaction?
 *
 * true  -- it answered with one.
 * false -- it answered that it has none. An ANSWER, not a timeout.
 * null  -- it could not be asked, or said something else.
 *
 * The distinction is the whole safety of this script. Core's
 * getrawtransaction answers "No such mempool or blockchain transaction" for
 * a transaction it does not have; anything else -- a connection refused, a
 * node still loading the block index, a wallet error -- is not that answer
 * and must not be read as one.
 */
async function nodeHasTx(daemon, txid) {
    try {
        const tx = await daemon.cmd('getrawtransaction', [txid, true]);
        return tx ? true : null;
    } catch (err) {
        const msg = String((err && err.message) || err);
        if (/No such mempool or blockchain transaction/i.test(msg)) return false;
        if (/No such mempool transaction/i.test(msg)) return false;
        console.error(`  ${DIM}the node said: ${msg}${OFF}`);
        return null;
    }
}

(async () => {
    const args = parseArgs(process.argv);

    let config;
    try {
        config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
    } catch (err) {
        console.error(`\n  cannot read ${args.config}: ${err.message}\n`);
        process.exit(2);
    }

    // DEFAULT_JOURNAL, not a second guess at it. This script looked in
    // pool/payment.journal while the pool writes pool/state/payments.journal,
    // so on a live pool it found nothing, said "nothing to resolve" and
    // exited 0 -- telling an operator the recovery had worked when it had
    // not looked at the journal at all.
    const journalPath = config.paymentJournal || DEFAULT_JOURNAL;
    if (!fs.existsSync(journalPath)) {
        console.log(`\n  no journal at ${journalPath}: nothing to resolve\n`);
        process.exit(0);
    }

    // Required lazily so --help works without a redis module present.
    const Redis = require('ioredis');
    const Daemon = require(path.join(ROOT, 'lib', 'daemon'));

    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const prefix = config.redisPrefix || 'wam';
    const k = (...p) => [prefix, ...p].join(':');

    const redis = new Redis(config.redis || {});
    const daemon = new Daemon(config.daemon, quiet);
    const journal = new PaymentJournal(journalPath, quiet);

    let exitCode = 0;
    try {
        const inflightRaw = await redis.get(k('payment:inflight'));
        let inflightTxid = null;
        if (inflightRaw) {
            try { inflightTxid = JSON.parse(inflightRaw).txid || null; }
            catch { inflightTxid = null; }
        }

        const complaints = await reconcile(journal, redis, k('payments:done'),
                                           inflightRaw);
        const fatal = complaints.filter((c) => c.fatal);

        console.log(`\n${BLD}  payments the journal cannot account for${OFF}\n`);
        if (!fatal.length) {
            console.log(`  ${GRN}nothing is unresolved${OFF}`);
            for (const c of complaints) console.log(`  ${DIM}${c.text}${OFF}`);
            console.log();
            return;
        }

        for (const c of fatal) {
            const m = /^([0-9a-f]{64})/.exec(c.text);
            const txid = m && m[1];
            if (!txid) {
                console.log(`  ${YLW}!!${OFF}  ${c.text}`);
                console.log('      this one names no transaction, so it needs a person');
                exitCode = 1;
                continue;
            }
            if (args.txid && txid !== args.txid) continue;

            console.log(`  ${txid}`);
            const has = await nodeHasTx(daemon, txid);

            if (has === true) {
                console.log(`  ${RED}THE NODE HAS THIS TRANSACTION. IT WAS SENT.${OFF}`);
                console.log('      Nothing has been changed. The miners in it were paid');
                console.log('      and their balances still show the amounts as owed, so');
                console.log('      the next run would pay them again. Deduct by hand,');
                console.log('      then clear the marker -- that is the other branch of');
                console.log('      the banner and no tool should do it for you.\n');
                exitCode = 1;
                continue;
            }

            if (has === null) {
                console.log(`  ${YLW}the node could not answer about it.${OFF}`);
                console.log('      Nothing has been changed. A node that is still syncing,');
                console.log('      or not reachable, has not told you the transaction does');
                console.log('      not exist. Run this again when it can answer.\n');
                exitCode = 1;
                continue;
            }

            if (args.dryRun) {
                console.log(`  ${DIM}--dry-run: would write an abandoned line for it` +
                            `${inflightTxid === txid ? ', and clear the marker' : ''}${OFF}\n`);
                continue;
            }

            journal.recordAbandoned(txid,
                'operator ran resolve_lost_payment.js; the node answered that ' +
                'no such transaction exists');
            if (inflightTxid === txid) {
                await redis.del(k('payment:inflight'));
                console.log(`  ${GRN}resolved${OFF}: abandoned in the journal, marker cleared`);
            } else {
                console.log(`  ${GRN}resolved${OFF}: abandoned in the journal` +
                            `${inflightRaw ? ' (the marker names another txid and was left alone)' : ''}`);
            }
            console.log('      Nothing left this wallet for it. The next payment run');
            console.log('      will pay the balances that are still owed.\n');
        }

        // Say what the pool will see on its next run, rather than leaving
        // the operator to find out by watching it pause again.
        const after = await reconcile(journal, redis, k('payments:done'),
                                      await redis.get(k('payment:inflight')));
        const stillFatal = after.filter((c) => c.fatal);
        if (stillFatal.length) {
            console.log(`  ${YLW}${stillFatal.length} complaint(s) remain, so the pool ` +
                        `will still pause${OFF}`);
            for (const c of stillFatal) console.log(`      ${c.text}`);
            exitCode = 1;
        } else if (!args.dryRun) {
            console.log(`  ${GRN}${BLD}the journal reconciles; the next payment run will ` +
                        `pay${OFF}`);
        }
        console.log();
    } finally {
        redis.disconnect();
    }
    process.exit(exitCode);
})().catch((err) => {
    console.error(`\n  ${RED}${err.stack || err.message}${OFF}\n`);
    process.exit(2);
});
