'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  fakeAtomic.js -- one definition of the atomic claim for the test doubles
// ===========================================================================
//
//  WHY THIS FILE EXISTS
//
//  Six test files build their own Redis double, each knowing the subset of
//  commands its own test needs. On 2026-10-12 the pool started requiring one
//  more -- wamClaimAndRecord, the script that moves a block out of
//  blocks:pending and records the evidence in the same breath -- and all six
//  stopped at the constructor with the same message.
//
//  That is the guard working: pool/lib/atomic.js refuses a client that cannot
//  run the script, because a fallback to the two-command version is the
//  defect reachable by configuration. But six copies of the fix would be six
//  chances to write it differently, in doubles whose whole job is to behave
//  like the thing they stand in for.
//
//  So the command has one definition here, and two shapes:
//
//    attachAtomic      -- the real behaviour, over the double's own store
//    attachUnsupported -- a method that THROWS when called
//
//  The second is for doubles that do not model blocks:pending at all. A stub
//  that quietly returned 1 would let a test pass while proving nothing, which
//  is the failure this project has been bitten by more than once: a check
//  that could not look, reporting that it had looked. If one of those tests
//  ever does reach maturation, it stops and says the double is the problem.
// ===========================================================================

const { CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME } = require('../lib/atomic');

/**
 * Give a double the real commands, over the maps it already uses.
 *
 * @param fake    the double
 * @param hash    (key) => Map, the double's own hash store
 * @param list    (key) => Array, the double's own list store
 * @param store   optional hooks for the keys wamRecordBlock destroys and
 *                counts, for doubles that do not keep them as hashes:
 *
 *                  drop(key)     remove a key from every store this double
 *                                has. Default: hash(key).clear().
 *                  fee(key, n)   add n to a plain integer key. Default:
 *                                nothing, which is honest only because a
 *                                double with no fee store has nothing that
 *                                could read a fake answer back.
 *
 * Atomic for free: there is no await inside either of them, so nothing can
 * interleave between the lines. That is exactly the property the Lua scripts
 * buy on a real server, and it is the whole point of both.
 */
function attachAtomic(fake, hash, list, store) {
    if (typeof hash !== 'function' || typeof list !== 'function') {
        throw new Error('attachAtomic needs the double\'s hash and list accessors');
    }
    fake[CLAIM_AND_RECORD_NAME] =
        async (pendingKey, listKey, field, evidence) => {
            if (!hash(pendingKey).delete(field)) return 0;
            list(listKey).unshift(evidence);
            return 1;
        };

    // WHAT THIS ONE IS STANDING IN FOR.
    //
    // Nothing in this directory had ever RUN recordBlock's commit. Two files
    // call recordBlock and both are turned back by its idempotency checks
    // before they reach it, and the pipeline double they share implements
    // neither del nor incrby, so the commit would have died on "pipe.del is
    // not a function" if either had got that far. The one test that claimed
    // to be about those lines searched shareProcessor.js for two literal
    // strings and checked they were near each other.
    //
    // So a fault lived in four lines for the whole life of this pool with a
    // green suite over it, and an outsider found it by reading. The double
    // below models the order the script fixes, and
    // record-block-commit.test.js drives the failures through it.
    const drop = (store && store.drop) || ((key) => hash(key).clear());
    const fee = (store && store.fee) || (() => {});

    fake[RECORD_BLOCK_NAME] =
        async (pendingKey, roundKey, powKey, feeKey, field, record, amount) => {
            if (hash(pendingKey).has(field)) return 0;
            hash(pendingKey).set(field, record);
            drop(roundKey);
            drop(powKey);
            fee(feeKey, Number(amount));
            return 1;
        };
    return fake;
}

/**
 * Give a double commands that refuse to pretend.
 *
 * @param why    what this double does not model, in the error a reader sees
 * @param which  which commands to refuse; all of them by default
 */
function attachUnsupported(fake, why, which) {
    for (const name of which || [CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME]) {
        fake[name] = async () => {
            throw new Error(
                `${name} was called on a double that does not model it: ` +
                `${why}. Nothing was asserted. Use attachAtomic from ` +
                'pool/test/fakeAtomic.js with this double\'s own stores, ' +
                'rather than trusting whatever this call would have returned.');
        };
    }
    return fake;
}

module.exports = {
    attachAtomic, attachUnsupported,
    CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME
};
