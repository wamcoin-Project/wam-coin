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

const { CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME,
        CREDIT_MATURED_NAME, CREDIT_SHARE_NAME } = require('../lib/atomic');

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
    // The credit script touches a counter and a set that most doubles do
    // not model. They are kept here so every double gets the behaviour
    // without each one growing two more stores it never reads.
    const counters = new Map();
    const setStore = new Map();
    const ownSets = (k) => {
        if (!setStore.has(k)) setStore.set(k, new Set());
        return setStore.get(k);
    };
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
    // members(key) must be THE DOUBLE'S OWN set, not one kept here. A private
    // set lets the credit write a block hash that the double's own sismember
    // cannot see, so a test asking "can this block be paid twice?" reads 0
    // and passes for the wrong reason. maturation-claim.test.js caught that
    // on the first run.
    const sets = (store && store.members) || ownSets;
    // bump(key) must be THE DOUBLE'S OWN counter, for the same reason: a
    // private one lets the credit move blocks:confirmed:count where the
    // double's incr cannot see it, and a test that reads the count then
    // reads zero and believes nothing happened.
    const zadd = (store && store.zadd) || ((k, score, member) => {
        if (!setStore.has('z:' + k)) setStore.set('z:' + k, new Set());
        setStore.get('z:' + k).add(member);
    });
    const bump = (store && store.count)
        || ((key) => counters.set(key, (counters.get(key) || 0) + 1));

    fake[RECORD_BLOCK_NAME] =
        async (pendingKey, roundKey, powKey, feeKey, field, record, amount) => {
            if (hash(pendingKey).has(field)) return 0;
            hash(pendingKey).set(field, record);
            drop(roundKey);
            drop(powKey);
            fee(feeKey, Number(amount));
            return 1;
        };

    // THE MARKER IS TESTED HERE, NOT BY THE CALLER.
    //
    // The double must have the property the script has, or a test of "credit
    // once" passes on a double that cannot count. A second call with the same
    // block hash returns 0 and touches nothing, which is what a re-sent
    // command gets on a real server.
    const credited = new Set();
    fake[CREDIT_MATURED_NAME] =
        async (creditedKey, balancesKey, confirmedKey, countKey,
               hashesKey, maturingKey, blockHash, evidence, limit,
               ...payouts) => {
            // A refusal the way the real script refuses: before anything is
            // written, so the caller sees an error and the state is as it
            // was. `_creditFails` replaces the old `_multiFails` for this
            // path, because the credit is no longer a MULTI to fail inside.
            if (fake._creditFails) {
                throw new Error(typeof fake._creditFails === 'string'
                    ? fake._creditFails : 'the credit was refused');
            }
            if (credited.has(blockHash)) return 0;
            credited.add(blockHash);
            for (let i = 0; i < payouts.length; i += 2) {
                const who = payouts[i];
                const amount = Number(payouts[i + 1]);
                const held = Number(hash(balancesKey).get(who) || 0);
                hash(balancesKey).set(who, String(held + amount));
            }
            list(confirmedKey).unshift(evidence);
            list(confirmedKey).splice(Number(limit));
            bump(countKey);
            sets(hashesKey).add(blockHash);
            const m = list(maturingKey);
            for (let i = m.length - 1; i >= 0; i--) {
                if (m[i] === evidence) m.splice(i, 1);
            }
            return 1;
        };

    // The claim is taken INSIDE this one, which is the whole point of it:
    // a proof already counted returns 0 and writes nothing, whether it
    // arrived twice from a miner, from a race, or from the client re-sending
    // a command whose reply was lost.
    fake[CREDIT_SHARE_NAME] =
        async (powKey, roundKey, pplnsKey, hashrateKey,
               proof, worker, difficulty, entry, windowSize, now) => {
            if (fake._shareFails) {
                throw new Error(typeof fake._shareFails === 'string'
                    ? fake._shareFails : 'the share accounting was refused');
            }
            if (sets(powKey).has(proof)) return 0;
            sets(powKey).add(proof);
            // a number, not a string: this mirrors HINCRBYFLOAT, which is
            // what the doubles that read this field implement themselves
            const held = Number(hash(roundKey).get(worker) || 0);
            hash(roundKey).set(worker, held + Number(difficulty));
            list(pplnsKey).unshift(entry);
            list(pplnsKey).splice(Number(windowSize));
            zadd(hashrateKey, Number(now), entry);
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
    for (const name of which ||
         [CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME, CREDIT_MATURED_NAME,
          CREDIT_SHARE_NAME]) {
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
    CLAIM_AND_RECORD_NAME, RECORD_BLOCK_NAME, CREDIT_MATURED_NAME,
    CREDIT_SHARE_NAME
};
