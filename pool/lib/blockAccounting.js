'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  blockAccounting.js -- what happens between finding a block and owing for it
// ===========================================================================
//
//  WHY THIS IS A FILE AND NOT SIX LINES IN server.js
//
//  It was six lines in server.js, and the one test that cared about those
//  six lines could not run them: a suite that needs a jobManager, a
//  shareProcessor and a redis cannot start the whole server, so it wrote
//  the listener out again beside the fixtures. Two copies, and the copy
//  under test was the one that already had the fix.
//
//  That was caught by reverting the real file and watching the suite stay
//  green. A double can only disagree with the thing it doubles if
//  something runs both, which is the same lesson pool/test/fakeAtomic.js
//  taught on 18 November about the Lua scripts.
//
//  So the decision lives here, server.js calls this, and the test calls
//  this. There is one of it.
// ===========================================================================

/**
 * Wire the 'block' event to the payout accounting.
 *
 *   jobManager     emits 'block' for a share that found one, and for every
 *                  block the spool drain recovers
 *   shareProcessor writes the payout table, or does not
 *   log            where an operator will read it
 *   inOrder        runs the body on the caller's ordered chain, so block
 *                  accounting cannot interleave with share accounting
 *
 * THE SPOOL ENTRY IS RELEASED ONLY WHEN A RECORD REALLY EXISTS.
 *
 * The entry IS the evidence that a block reached the chain without being
 * paid for, and it has to outlive every step between those two facts. If
 * recordBlock throws, the release is skipped, the entry stays, and the
 * drain offers it again.
 *
 * That much was always true. What was assumed and not checked is the case
 * where recordBlock does NOT throw and does not record either: when
 * computeBlockRewards refuses -- the blockValue guard in rewards.js
 * tripping on a template whose fee fields drifted is enough, and a daemon
 * mid-upgrade is also what fills the spool, so the two windows coincide --
 * the block is parked in blocks:failed and the function returns null. The
 * release then ran anyway and deleted the only copy the drain could
 * re-offer, at the exact moment the accounting path was broken, which is
 * the one moment the spool exists for. Nothing in this repository reads
 * blocks:failed again; its only two references are the two places that
 * write it.
 *
 * The state is READ rather than inferred from a return value, because the
 * condition the spool protects is a record that exists -- not a function
 * that returned a particular thing. It also catches a record written and
 * then lost.
 *
 * Reported by Fahrizal, 18 November 2026.
 */
function attachBlockAccounting({ jobManager, shareProcessor, log, inOrder }) {
    jobManager.on('block', (share) => {
        inOrder(`block ${share.height}`, async () => {
            await shareProcessor.recordBlock(share);

            if (await shareProcessor.isAccountedFor(share.blockHash)) {
                await jobManager.unspoolRecorded(share.blockHash);
                return;
            }

            log.error(
                `block ${share.height} has no payout record anywhere this pool ` +
                `reads, so its spool entry is being KEPT. Look in ` +
                `${shareProcessor.k('blocks:failed')} for why the accounting ` +
                `was refused. The drain will offer the block again, and once ` +
                `the accounting works its payout is computed from the round as ` +
                `it stands then.`);
        });
    });
}

module.exports = { attachBlockAccounting };
