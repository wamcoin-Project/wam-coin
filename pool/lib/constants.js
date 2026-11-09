'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ---------------------------------------------------------------------------
// Consensus constants, mirrored from src/wam/wam-params.h.
//
// These MUST stay in lockstep with the C++ header. `scripts/verify_supply.py
// --check-constants` parses both files and fails the build if they disagree --
// a pool that believes the halving is at 210,000 while the chain halves at
// 200,000 would silently overpay every miner for months.
//
// Nothing here is a tunable. Operator settings live in config.json.
// ---------------------------------------------------------------------------

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

    // Monetary policy
    SUBSIDY_HALVING_INTERVAL,
    nextHalvingHeight,
    INITIAL_BLOCK_SUBSIDY_WAM: 50,
    MAX_HALVINGS: 33,
    MAX_MONEY_WAM: 22000000,
    GENESIS_PREMINE_WAM: 2000000,

    // Treasury: carved out of the subsidy by consensus, never added on top.
    // The pool NEVER pays this itself -- the daemon puts it in the coinbase and
    // the pool simply must not distribute it. See lib/blockTemplate.js.
    DEVFEE_PERCENT: 5,

    // The fee sunsets: heights 1..400,000 pay the treasury, and from 400,001
    // miners keep 100% of the subsidy.
    //
    // The pool does NOT act on this value -- it reads `devfee.amount` from
    // getblocktemplate, which the daemon already reports as 0 past the sunset.
    // It is here purely so the dashboard can show a countdown, and so
    // verify_supply.py can prove the pool and the chain agree.
    DEVFEE_LAST_HEIGHT: 400000,

    // Timing
    POW_TARGET_SPACING: 120,
    // The consensus constant, matching src/consensus/consensus.h. It is NOT
    // the depth at which a coinbase can be spent: Core's wallet asks for
    // (COINBASE_MATURITY + 1) - depth, so the coin moves at 101, not 100.
    // Anything deciding whether the pool can pay must use the second number.
    COINBASE_MATURITY: 100,

    // RandomX
    RANDOMX_EPOCH_BLOCKS: 2048,
    RANDOMX_EPOCH_LAG: 64,
    RANDOMX_BOOTSTRAP_KEY: "WAM/RandomX/epoch-0/2026",
    RANDOMX_HASH_SIZE: 32,

    // Stratum
    HEADER_SIZE: 80,
    EXTRANONCE1_SIZE: 4,
    EXTRANONCE2_SIZE: 4,

    // Difficulty 1 target for share accounting: 2^224 - 1.
    //
    // So a share of difficulty d costs 2^32 * d hashes on average, and
    // rewards.js multiplies by exactly that 2^32 to turn accepted shares into
    // a hashrate. Change one without the other and every number on the
    // dashboard is wrong.
    //
    // This sits on the SAME scale as the chain's own difficulty -- Bitcoin's
    // diff-1 target, 0x00000000FFFF0000..., is also ~2^224 -- and that is the
    // point. PPLNS sizes its window as a multiple of network difficulty, which
    // is only meaningful if a share and a block are measured in the same unit.
    //
    // It is NOT Monero's convention, where difficulty 1 means one hash and
    // network difficulties run into the hundreds of billions. A miner used to
    // those numbers will find WAM's difficulties very small; that is expected.
    DIFF1: BigInt('0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),

    // Address versions (verified by scripts/gen_founder_key.py --selftest)
    // `bech32` is the segwit HRP. It matters as much as the base58 bytes:
    // `getnewaddress` returns bech32 by default on modern Bitcoin Core, so a
    // pool that only knows base58 rejects nearly every miner that connects.
    ADDRESS_VERSIONS: {
        mainnet: { pubkey: 73,  script: 135, firstChar: 'W', bech32: 'wam' },
        testnet: { pubkey: 65,  script: 128, firstChar: 'T', bech32: 'twam' },
        regtest: { pubkey: 65,  script: 128, firstChar: 'T', bech32: 'wamrt' }
    }
};
