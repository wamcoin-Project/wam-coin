'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// Consensus constants mirrored from src/wam/wam-params.h.
// `scripts/verify_supply.py --check-constants` fails the build if these drift.
//
// The explorer only uses these as a FALLBACK, for the case where it is pointed
// at a node that predates the WAM RPC commands. Whenever `getsupplyinfo` is
// available its answer wins, because that one comes from consensus code rather
// than from a copy of it.

const COIN = 100000000;

const SUBSIDY_HALVING_INTERVAL = 200000;

/**
 * The first block that pays the reduced subsidy, for a chain standing at
 * `height` with this halving interval.
 *
 * THE + 1 IS THE WHOLE OF IT, AND IT WAS WRITTEN OUT FOUR TIMES WITHOUT IT.
 *
 * The node counts halvings as (height - 1) / interval, because block 0 mints
 * the premine and would otherwise sit inside epoch 0 and leave that epoch one
 * block short. So epoch e begins at e * interval + 1, and the last block of
 * an epoch still pays the old amount.
 *
 * src/wam/rpc/wam_rpc.cpp got this wrong until 9 November 2026 -- found by
 * dang150296 (Urriki1502) -- and so did every copy of the arithmetic that
 * runs when the node cannot be asked: two here and two in the pool's API, all
 * four naming the last block of the current epoch and counting down to zero a
 * block early. He found those too, a few hours after the first.
 *
 * It is a function now because the same expression written in five places is
 * one that will be written wrong in a sixth.
 */
function nextHalvingHeight(height, interval = SUBSIDY_HALVING_INTERVAL) {
    const epoch = height >= 1 ? Math.floor((height - 1) / interval) : 0;
    return (epoch + 1) * interval + 1;
}

module.exports = {
    COIN,

    SUBSIDY_HALVING_INTERVAL,
    nextHalvingHeight,
    INITIAL_BLOCK_SUBSIDY_WAM: 50,
    MAX_HALVINGS: 33,
    MAX_MONEY_WAM: 22000000,
    GENESIS_PREMINE_WAM: 2000000,

    DEVFEE_PERCENT: 5,
    DEVFEE_LAST_HEIGHT: 400000,

    POW_TARGET_SPACING: 120,
    // The consensus constant. A coinbase is SPENDABLE one block later, at
    // depth 101: Core's wallet asks for (COINBASE_MATURITY + 1) - depth.
    // Anything deciding whether a coin can move must use the second number.
    COINBASE_MATURITY: 100,

    // Founder reserve vesting -- exact calendar anniversaries of the launch.
    // Every tranche is time-locked; none is spendable at launch.
    //
    // A third copy of the table in wam-params.h, kept in step by
    // scripts/check_vesting_sync.py. The explorer showing a different schedule
    // from the one the chain enforces would be worse than showing none: people
    // check this page precisely because they do not want to take our word for
    // it, and a stale number here reads as a lie rather than a bug.
    GENESIS_TIME: 1789430400,
    PREMINE_TRANCHES: 5,
    PREMINE_TRANCHE_AMOUNT_WAM: 400000,
    PREMINE_UNLOCK_TIMES: [
        1820966400,  // tranche 1 -- 2027-09-15
        1852588800,  // tranche 2 -- 2028-09-15
        1884124800,  // tranche 3 -- 2029-09-15
        1915660800,  // tranche 4 -- 2030-09-15
        1947196800   // tranche 5 -- 2031-09-15
    ],

    RANDOMX_EPOCH_BLOCKS: 2048,
    RANDOMX_EPOCH_LAG: 64
};
