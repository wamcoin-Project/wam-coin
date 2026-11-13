// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ============================================================================
//  wam-params.h  --  THE SINGLE SOURCE OF TRUTH FOR WAM COIN'S MONETARY POLICY
// ============================================================================
//
//  Every constant that defines WAM Coin's economics lives here and NOWHERE
//  else. chainparams.cpp, subsidy.cpp, devfee.cpp, the genesis generator and
//  the stratum pool all derive their numbers from this file (the Python and
//  JavaScript components parse it, see scripts/verify_supply.py).
//
//  Changing any value below is a hard-forking consensus change.
//
//  ---------------------------------------------------------------------------
//  PROOF OF THE 22,000,000 WAM HARD CAP
//  ---------------------------------------------------------------------------
//
//    Genesis premine .................  2,000,000 WAM   (block 0, one shot)
//    Mining emission .................
//        sum over epochs e = 0..32 of
//        200,000 blocks * (50 WAM >> e)
//      = 200,000 * 50 * 2  (geometric series, exact in the limit)
//      = 20,000,000 WAM    (19,999,999.978 WAM once the integer shift has
//                            truncated every epoch: exactly
//                            1,999,999,997,800,000 base units)
//                                     ------------------
//    Absolute maximum ................ 22,000,000 WAM
//    Terminal supply ................. 21,999,999.978 WAM
//
//  The last block to pay anything is height 6,600,000, which pays one base
//  unit; from 6,600,001 the subsidy is exactly zero and miners are
//  compensated by transaction fees only. That height is epoch 33 --
//  nHalvings is (nHeight - 1) / 200,000, so epoch e covers heights
//  200,000*e + 1 through 200,000*(e+1) -- and ~25.1 years at the 120 s target
//  spacing.
//
//  The truncation figure was published as 19,999,999.99 for the life of the  // wam:quote-line
//  chain, which is wrong by 0.012 WAM: it is the limit of the series rounded,
//  not the sum of the truncated epochs. Reported 13 November 2026.
//  scripts/verify_supply.py computes it, and scripts/check_published_counts.py
//  now compares every published copy of it against that computation.
//
//  MAX_MONEY below is a *strict* upper bound used by the sanity checks in
//  MoneyRange(); the real terminal supply is marginally lower because of the
//  integer right-shift truncation in GetBlockSubsidy(). This is intentional
//  and identical to Bitcoin's behaviour.
// ============================================================================

#ifndef WAM_WAM_PARAMS_H
#define WAM_WAM_PARAMS_H

#include <cstdint>

namespace wam {

// ---------------------------------------------------------------------------
// Base units
// ---------------------------------------------------------------------------

/** Number of indivisible base units ("watoshi") in one WAM. */
static constexpr int64_t WAM_COIN = 100'000'000;

/** Number of decimal places displayed by the wallet and RPC layer. */
static constexpr int WAM_DECIMALS = 8;

// ---------------------------------------------------------------------------
// Supply
// ---------------------------------------------------------------------------

/** Hard, immutable ceiling on the total supply: 22,000,000 WAM. */
static constexpr int64_t WAM_MAX_MONEY = 22'000'000 * WAM_COIN;

/** Founder / development reserve, minted exclusively inside the genesis block. */
static constexpr int64_t WAM_GENESIS_PREMINE = 2'000'000 * WAM_COIN;

/** Portion of the supply reserved for public proof-of-work mining. */
static constexpr int64_t WAM_MINING_ALLOCATION = 20'000'000 * WAM_COIN;

static_assert(WAM_GENESIS_PREMINE + WAM_MINING_ALLOCATION == WAM_MAX_MONEY,
              "premine + mining allocation must equal the hard cap exactly");

// ---------------------------------------------------------------------------
// Emission schedule
// ---------------------------------------------------------------------------

/** Subsidy paid for block 1 through block WAM_SUBSIDY_HALVING_INTERVAL. */
static constexpr int64_t WAM_INITIAL_BLOCK_SUBSIDY = 50 * WAM_COIN;

/**
 * Blocks between successive halvings.
 *
 * 200,000 (not Bitcoin's 210,000) is what makes the arithmetic close exactly:
 *   200,000 * 50 * 2 == 20,000,000 WAM.
 * At a 120 s target this is one halving every ~9.1 months.
 */
static constexpr int WAM_SUBSIDY_HALVING_INTERVAL = 200'000;

/**
 * Number of halvings after which the subsidy is unconditionally zero.
 * 50 WAM == 5e9 base units < 2^33, so 33 right-shifts exhaust it.
 */
static constexpr int WAM_MAX_HALVINGS = 33;

static_assert((WAM_INITIAL_BLOCK_SUBSIDY >> WAM_MAX_HALVINGS) == 0,
              "subsidy must be fully exhausted after WAM_MAX_HALVINGS shifts");

// ---------------------------------------------------------------------------
// Development / treasury fee
// ---------------------------------------------------------------------------

/**
 * Percentage of the *block subsidy* routed to the development treasury.
 *
 * IMPORTANT: this is carved OUT OF the subsidy, it is not added on top of it.
 * A block at epoch 0 therefore pays:
 *     miner    47.5 WAM  + all transaction fees
 *     treasury  2.5 WAM
 *     total     50.0 WAM  <- emission is unchanged, the hard cap still holds.
 *
 * Transaction fees are never touched by the treasury; they belong entirely to
 * the miner. This keeps fee-market incentives clean.
 */
static constexpr int64_t WAM_DEVFEE_PERCENT = 5;

static_assert(WAM_DEVFEE_PERCENT >= 0 && WAM_DEVFEE_PERCENT <= 100,
              "dev fee must be a sane percentage");

/**
 * Height at which dev-fee enforcement becomes a consensus rule.
 * Block 0 is the premine and block 1 is the first mined block, so enforcement
 * starts immediately at height 1.
 */
static constexpr int WAM_DEVFEE_START_HEIGHT = 1;

/**
 * LAST height that pays the treasury. From height 400,001 onward the fee is
 * zero and miners receive 100% of the subsidy plus all fees.
 *
 * This sunset is the whole reason the fee is defensible. A permanent 5% tax
 * reads to a miner as "the founder taxes me for twenty-five years"; the same
 * money collected over a fixed, published window reads as launch funding. The
 * economics barely differ -- because the subsidy halves, epoch 0 alone yields
 * 500,000 of the 750,000 WAM total -- but the incentive story is completely
 * different, and WAM's RandomX audience is precisely the audience that cares.
 *
 *   heights      1 .. 200,000  ->  2.5   WAM/block  =  500,000 WAM
 *   heights 200,001 .. 400,000  ->  1.25  WAM/block  =  250,000 WAM
 *   heights 400,001 ..          ->  0
 *                                   ------------------------------
 *   lifetime treasury income from block rewards       750,000 WAM
 *
 * At a 120 s target this is roughly 18.3 months of funding.
 */
static constexpr int WAM_DEVFEE_LAST_HEIGHT = 400'000;

static_assert(WAM_DEVFEE_LAST_HEIGHT >= WAM_DEVFEE_START_HEIGHT,
              "the dev fee window must be non-empty");

// ---------------------------------------------------------------------------
// BIP-44 coin type
// ---------------------------------------------------------------------------
//
//  Level 2 of the BIP-44 hierarchy: m / 44' / coin_type' / account' / ...
//
//  Bitcoin Core hardcodes 0 for mainnet, and this fork inherited it. A WAM
//  wallet was deriving on Bitcoin's branch -- every WAM seed producing the
//  addresses a Bitcoin wallet would produce for the same words.
//
//  0x57414D is "WAM" read as ASCII. Registries have no room left below a
//  thousand, and the convention among recent entries is exactly this: TNZO
//  holds 0x544E5A4F, Bitcoin-PoCX holds 0x504F4358. Checked against
//  slip-0044.md on 2026-08-20 and unclaimed.
//
//  NOT YET REGISTERED. Registration is a pull request to satoshilabs/slips,
//  whose own condition is that a wallet implementing BIP-44 for the coin must
//  already exist -- which is why this lands before the request rather than
//  after it. If they assign a different number, this changes and every wallet
//  made in the meantime must be discarded.
//
//  THIS CANNOT CHANGE ONCE ANYONE HOLDS COINS. The same seed on a different
//  coin type yields different addresses, so a wallet restored after a change
//  looks empty. That is why it is settled before the first mainnet block and
//  not on the day someone notices.
//
//  Testnet stays 1: SLIP-44 reserves it for every test chain, deliberately, so
//  that test keys can never be confused with real ones.
static constexpr uint32_t WAM_BIP44_COIN_TYPE = 0x57414D;   // 5'718'349

static_assert(WAM_BIP44_COIN_TYPE < 0x80000000,
              "a BIP-44 coin type is the index, not the hardened path component");
static_assert(WAM_BIP44_COIN_TYPE != 0 && WAM_BIP44_COIN_TYPE != 1,
              "0 is Bitcoin and 1 is every testnet; neither is WAM");

// ---------------------------------------------------------------------------
// Founder reserve vesting
// ---------------------------------------------------------------------------

/**
 * Genesis block timestamp: 2026-09-15 00:00:00 UTC.
 *
 * This is the network's launch date, and every vesting unlock below is an exact
 * calendar anniversary of it. Changing it after the genesis block has been
 * mined is a hard fork, so it is fixed here rather than being derived at
 * runtime from anything.
 */
static constexpr int64_t WAM_GENESIS_TIME = 1789430400;

/**
 * Genesis timestamps for the other two networks.
 *
 * These are NOT derived from WAM_GENESIS_TIME, and the reason matters.
 *
 * Bitcoin Core refuses to load a block database whose blocks are in the future
 * ("The block database contains a block which appears to be from the future").
 * Because mainnet's genesis carries the launch date, the mainnet binary
 * physically cannot run before 2026-09-15. That is a useful property -- a
 * built-in gate against launching early by accident -- and it is deliberate.
 *
 * But it also means testnet and regtest would be unrunnable during the entire
 * development period leading up to launch, which is exactly when they are
 * needed. So both are dated in the past:
 *
 *   testnet  2026-08-01  -- the test network runs ahead of mainnet, as it must
 *                           in order to rehearse the launch
 *   regtest  2011-02-02  -- Bitcoin's own regtest genesis time, kept because a
 *                           throwaway dev chain should never be near "now"
 */
static constexpr int64_t WAM_TESTNET_GENESIS_TIME = 1785542400;
static constexpr int64_t WAM_REGTEST_GENESIS_TIME = 1296688602;

static_assert(WAM_TESTNET_GENESIS_TIME < WAM_GENESIS_TIME,
              "testnet must launch before mainnet");

/**
 * The 2,000,000 WAM founder reserve is NOT paid to a single output.
 *
 * It is split into five equal tranches inside the genesis coinbase, and ALL
 * FIVE are locked behind OP_CHECKLOCKTIMEVERIFY until an exact calendar date.
 *
 * This sentence said "four of which are locked" until 18 September. It was
 * wrong, and wrong in the direction that understates what the code does:
 * WAM_PREMINE_UNLOCK_TIMES below carries five dates, 2027 through 2031, and
 * a node reports 2,000,000 locked and nothing unlocked. Nobody was misled to
 * their harm by it -- but this is the file a reader opens to check that the
 * reserve really is locked, and a comment that disagrees with the array under
 * it makes them ask which one to believe. The array and block 0 are the
 * answer; the sentence now agrees with them.
 * The point is not to reduce the founder's share -- it is unchanged -- but to
 * make "the founder cannot dump on you" a property anyone can verify from
 * block 0 rather than a promise they have to believe.
 *
 * The lock scripts are BARE, not wrapped in P2SH. A P2SH output would show
 * only a hash, and a reader would have to trust a separately published redeem
 * script. A bare script puts the unlock date directly in the scriptPubKey,
 * where `wam-cli getblock 0 2` prints it in plain sight.
 *
 * The locks are TIMESTAMP-based, not height-based. A height-based lock of
 * "262,980 blocks" only equals one year if the chain holds exactly 120 s per
 * block forever; if hash rate falls, a four-year promise silently becomes five.
 * Timestamps are what the public will hold this schedule to, so timestamps are
 * what consensus enforces. (The dev-fee sunset above stays height-based,
 * because it is tied to the emission schedule, which is itself height-based.)
 */
static constexpr int WAM_PREMINE_TRANCHES = 5;

static constexpr int64_t WAM_PREMINE_TRANCHE_AMOUNT = 400'000 * WAM_COIN;

/**
 * nLockTime for each tranche; 0 means "spendable immediately" (subject to the
 * normal 100-block coinbase maturity, which still applies to all five).
 *
 * Every non-zero value is far above 500,000,000, which is what makes CLTV
 * interpret it as a Unix timestamp rather than a block height.
 */
// Every tranche is locked. Not one coin of the founder reserve can move on
// launch day, or in the first year.
//
// The first tranche used to be liquid at genesis, described as working capital
// for listings, audits and infrastructure. That justification does not survive
// looking at the other half of the design: the 5% treasury pays from block 1
// and delivers 750,000 WAM over roughly eighteen months, and *that* is the
// operating money. The reserve was never needed for it.
//
// So the only thing an unlocked tranche bought was 400,000 WAM that the founder
// could sell on day one into a market with no liquidity -- which is the exact
// shape of the objection every premine attracts, granted for no benefit. It
// costs nothing to remove: the same coins arrive a year later, and the treasury
// covers the interval.
//
// This is now a rule the network enforces rather than an intention anyone has
// to be believed about.
static constexpr int64_t WAM_PREMINE_UNLOCK_TIMES[WAM_PREMINE_TRANCHES] = {
    1820966400,   // tranche 1 -- 2027-09-15
    1852588800,   // tranche 2 -- 2028-09-15
    1884124800,   // tranche 3 -- 2029-09-15
    1915660800,   // tranche 4 -- 2030-09-15
    1947196800,   // tranche 5 -- 2031-09-15
};

static_assert(WAM_PREMINE_TRANCHES * WAM_PREMINE_TRANCHE_AMOUNT == WAM_GENESIS_PREMINE,
              "the vesting tranches must sum to exactly the genesis premine");

// The inverse of the assertion that used to be here, which required the first
// tranche to be unlocked. Nothing in the reserve may be spendable at launch,
// and 500000000 is the CLTV threshold above which a value is read as a Unix
// time rather than a block height -- a lock below it would be a height, would
// be satisfied almost immediately, and would look like a lock while being none.
static_assert(WAM_PREMINE_UNLOCK_TIMES[0] > 500000000,
              "every founder tranche must carry a real time lock; none is liquid at launch");  // wam:quote-line

// ---------------------------------------------------------------------------
// Block timing and difficulty
// ---------------------------------------------------------------------------

/** Target seconds between blocks. */
static constexpr int64_t WAM_POW_TARGET_SPACING = 120;

/**
 * DarkGravityWave v3 window: the number of previous blocks averaged when
 * retargeting. DGW retargets on EVERY block, so there is no "timespan"
 * parameter in the Bitcoin sense.
 */
static constexpr int64_t WAM_DGW_PAST_BLOCKS = 24;

/**
 * Clamp on the observed timespan, expressed as a divisor/multiplier of the
 * expected timespan. Dash's reference DGWv3 uses 1/3x .. 3x; we keep that.
 */
static constexpr int64_t WAM_DGW_CLAMP_FACTOR = 3;

/** Confirmations before a coinbase output becomes spendable (~3.3 hours). */
static constexpr int WAM_COINBASE_MATURITY = 100;

// ---------------------------------------------------------------------------
// RandomX proof-of-work
// ---------------------------------------------------------------------------

/**
 * Length of a RandomX key epoch in blocks. Every 2048 blocks (~2.8 days) the
 * RandomX key changes, which forces every miner and pool to rebuild the
 * 2 GiB dataset. This is what keeps the algorithm hostile to fixed-function
 * ASICs while remaining cheap for CPUs.
 */
static constexpr int WAM_RANDOMX_EPOCH_BLOCKS = 2048;

/**
 * Lag, in blocks, between the tip and the block whose hash seeds the RandomX
 * key. The lag guarantees that the seed block is deeply buried and therefore
 * final, so a chain reorganisation can never retroactively invalidate the key
 * a miner was using.
 */
static constexpr int WAM_RANDOMX_EPOCH_LAG = 64;

static_assert(WAM_RANDOMX_EPOCH_LAG < WAM_RANDOMX_EPOCH_BLOCKS,
              "the seed lag must be shorter than an epoch");

// ---------------------------------------------------------------------------
// Network identity
// ---------------------------------------------------------------------------

// RPC sits one BELOW the peer-to-peer port, never one above. Bitcoin's own
// 8333/8332 is not an accident either:
//
//     init.cpp:  const uint16_t default_bind_port_onion = default_bind_port + 1;
//
// Core reserves p2p+1 on localhost for the Tor onion service whenever
// -listen=1. RPC on p2p+1 is therefore squatted by the node's own onion
// listener on any machine that actually accepts connections -- which is every
// seed, every pool, and every node worth running.
//
// WAM had exactly that collision. It stayed invisible because every node so
// far ran with -listen=0, where no onion listener binds. The first node
// configured to listen took p2p+1 for Tor, and the RPC server fell back to
// Bitcoin's own 18332 without saying so. Found on the first real deployment.
static constexpr int WAM_MAINNET_P2P_PORT  = 9555;
static constexpr int WAM_MAINNET_RPC_PORT  = 9554;
static constexpr int WAM_TESTNET_P2P_PORT  = 19555;
static constexpr int WAM_TESTNET_RPC_PORT  = 19554;
static constexpr int WAM_REGTEST_P2P_PORT  = 29555;
static constexpr int WAM_REGTEST_RPC_PORT  = 29554;

static_assert(WAM_MAINNET_RPC_PORT == WAM_MAINNET_P2P_PORT - 1
              && WAM_TESTNET_RPC_PORT == WAM_TESTNET_P2P_PORT - 1
              && WAM_REGTEST_RPC_PORT == WAM_REGTEST_P2P_PORT - 1,
              "RPC must be p2p-1: p2p+1 is reserved by Core for the Tor onion listener");

/** Genesis coinbase message, committed forever into block 0. */
static constexpr const char* WAM_GENESIS_TIMESTAMP_PHRASE =
    "WAM Network Launching Next Generation Decentralized Economy 2026";

/**
 * Domain-separation string for the RandomX key used by epoch 0.
 *
 * The obvious choice -- "seed the first epoch with the genesis hash" -- is
 * circular: mining the genesis block requires a RandomX key, and that key
 * would need the genesis hash that mining is trying to produce. Epoch 0 is
 * therefore keyed by SHA256 of this fixed string instead. Every later epoch
 * uses a real, buried block hash as normal.
 *
 * This constant is mirrored in genesis/genesis_generator.py and in
 * pool/lib/randomxSeed.js; scripts/verify_supply.py --check-constants asserts
 * that all three agree.
 */
static constexpr const char* WAM_RANDOMX_BOOTSTRAP_KEY =
    "WAM/RandomX/epoch-0/2026";

} // namespace wam

#endif // WAM_WAM_PARAMS_H
