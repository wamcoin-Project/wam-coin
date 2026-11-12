// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// DarkGravityWave, which decides the difficulty of every block on this chain.
//
//     ./src/test/test_wam --run_test=wam_pow_tests
//
// WHY THIS FILE EXISTS
//
// It did not, and that was the finding. DarkGravityWave is consensus -- two
// nodes that disagree about one nBits disagree about the chain -- and nothing
// in the gated test set ran it:
//
//   * no wam_* unit suite mentioned it;
//   * the five functional tests run on regtest, where fPowNoRetargeting makes
//     wam::GetNextWorkRequired return the previous nBits without entering
//     DarkGravityWave at all;
//   * upstream's pow_tests.cpp is not in the install gate (which runs
//     --run_test='wam_*') and could not pass unmodified anyway: it asserts
//     Bitcoin's CalculateNextWorkRequired, a function consensus no longer
//     uses, and expects PermittedDifficultyTransition to reject a transition
//     WAM now always permits.
//
// The safety net was scripts/dgw_model.py --validate, which walks the real
// chain and recomputes every block's nBits from its 24 predecessors. That is
// a strong check and it is a manual one: nothing would have noticed the day
// the model and the C++ stopped agreeing.
//
// Reported by Radenlingga (Discord) on 10 November 2026, who also extracted
// the function verbatim and ran it against the model over 20,010 windows
// without finding a disagreement. The gap was never that DGW is wrong. It is
// that nothing gated would notice if it became wrong.
//
// WHERE THE EXPECTED VALUES COME FROM
//
// Every nBits asserted below was produced by scripts/dgw_model.py -- the
// independent Python implementation that --validate checks against thousands
// of real blocks. They are not copied from this C++ and they are not
// recomputed here: a test that reimplements the function it is testing agrees
// with it by construction.

#include <arith_uint256.h>
#include <chain.h>
#include <chainparams.h>
#include <consensus/params.h>
#include <test/util/setup_common.h>
#include <uint256.h>
#include <wam/pow.h>
#include <wam/wam-params.h>

#include <boost/test/unit_test.hpp>

#include <vector>

using namespace wam;

BOOST_FIXTURE_TEST_SUITE(wam_pow_tests, BasicTestingSetup)

namespace {

/** The mainnet powLimit in compact form -- the easiest target on this chain. */
constexpr unsigned int LIMIT_BITS = 0x1e0fffff;

/**
 * A chain of `gaps.size() + 1` headers, oldest first, with the given inter-
 * block times. Returns the blocks; the caller keeps them alive and passes
 * &blocks.back() as the tip.
 */
std::vector<CBlockIndex> MakeChain(const std::vector<int64_t>& gaps,
                                   const std::vector<unsigned int>& bits,
                                   int firstHeight = 0,
                                   uint32_t startTime = 1800000000)
{
    std::vector<CBlockIndex> blocks(gaps.size() + 1);
    uint32_t t = startTime;
    for (size_t i = 0; i < blocks.size(); ++i) {
        blocks[i].pprev = (i == 0) ? nullptr : &blocks[i - 1];
        blocks[i].nHeight = firstHeight + static_cast<int>(i);
        blocks[i].nTime = t;
        blocks[i].nBits = bits.size() == 1 ? bits[0] : bits[i];
        if (i < gaps.size()) t = static_cast<uint32_t>(static_cast<int64_t>(t) + gaps[i]);
    }
    return blocks;
}

/** 23 gaps -- a full DGW window -- summing to `total`. */
std::vector<int64_t> GapsSummingTo(int64_t total)
{
    const int64_t n = WAM_DGW_PAST_BLOCKS - 1;
    std::vector<int64_t> gaps(n, total / n);
    gaps.back() += total - (total / n) * n;
    return gaps;
}

/**
 * A window ending at height 1000, so the "not enough history" branch is not
 * the thing under test. DGW reads 24 blocks back from the tip, and anything
 * older than that cannot change the answer.
 */
unsigned int Retarget(const std::vector<int64_t>& gaps,
                      const std::vector<unsigned int>& bits = {LIMIT_BITS})
{
    const Consensus::Params& consensus = Params().GetConsensus();
    std::vector<CBlockIndex> blocks = MakeChain(gaps, bits, /*firstHeight=*/1000);
    return DarkGravityWave(&blocks.back(), consensus);
}

} // namespace

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

BOOST_AUTO_TEST_CASE(a_chain_shorter_than_the_window_mines_at_the_limit)
{
    const Consensus::Params& consensus = Params().GetConsensus();
    const unsigned int limit = UintToArith256(consensus.powLimit).GetCompact();

    BOOST_CHECK_EQUAL(DarkGravityWave(nullptr, consensus), limit);

    // Height 23 is the last height with fewer than 24 ancestors to average.
    std::vector<CBlockIndex> blocks =
        MakeChain(GapsSummingTo(2880), {LIMIT_BITS}, /*firstHeight=*/0);
    BOOST_CHECK_EQUAL(blocks.back().nHeight, WAM_DGW_PAST_BLOCKS - 1);
    BOOST_CHECK_EQUAL(DarkGravityWave(&blocks.back(), consensus), limit);

    // One block later there is a full window, and the answer is computed.
    std::vector<CBlockIndex> longer =
        MakeChain(GapsSummingTo(2880), {LIMIT_BITS}, /*firstHeight=*/1);
    BOOST_CHECK_EQUAL(longer.back().nHeight, WAM_DGW_PAST_BLOCKS);
    BOOST_CHECK_EQUAL(DarkGravityWave(&longer.back(), consensus), 0x1e0fffffU);
}

// ---------------------------------------------------------------------------
// The retarget, against scripts/dgw_model.py
// ---------------------------------------------------------------------------

BOOST_AUTO_TEST_CASE(the_fixed_point_is_twenty_three_intervals_not_twenty_four)
{
    // The window holds 24 blocks and therefore 23 intervals, and the target
    // timespan is 24 * 120 = 2880 seconds. So difficulty stops moving when 23
    // blocks take 2880 seconds -- 125.2 seconds a block, not 120. That is
    // Dash's DGWv3 construction, deliberate, identical on every node, and it
    // is asserted here so that "two-minute blocks" is never quietly corrected
    // into this function by somebody who reads the nominal spacing and
    // assumes an off-by-one.
    //
    // THE WINDOW SITS AT HALF THE LIMIT, AND THAT IS THE WHOLE CASE.
    //
    // This ran at powLimit and proved nothing. The off-by-one it is written
    // for makes the target LARGER, powLimit is the ceiling, and a window
    // already at the ceiling cannot move up: with (nPastBlocks - 1) compiled
    // in, this case still returned 0x1e0fffff and still passed. Measured --
    // the change was made in the build tree and the suite run against it.
    //
    // Half the limit is far enough below the cap for an upward move to be
    // visible, and the answer is then exactly the nBits it started from:
    // every target in the window is equal, so the weighted mean is that
    // target exactly, and span == timespan leaves it alone.
    BOOST_CHECK_EQUAL(Retarget(GapsSummingTo(2880), {0x1e07ffff}), 0x1e07ffffU);

    // The same window at the limit, which is a fixed point for a second
    // reason -- the cap -- and is kept only so that the two are never
    // confused again.
    BOOST_CHECK_EQUAL(Retarget(GapsSummingTo(2880)), 0x1e0fffffU);
}

BOOST_AUTO_TEST_CASE(blocks_twice_as_fast_halve_the_target)
{
    BOOST_CHECK_EQUAL(Retarget(GapsSummingTo(1440)), 0x1e07ffffU);
}

BOOST_AUTO_TEST_CASE(the_clamp_holds_at_a_third_of_the_timespan)
{
    // Every block in the same second: without the clamp the target would go
    // to zero and the chain would stop. 2880/3 = 960, and 960/2880 of the
    // limit is the answer.
    BOOST_CHECK_EQUAL(Retarget(std::vector<int64_t>(WAM_DGW_PAST_BLOCKS - 1, 0)),
                      0x1e055555U);

    // And a timestamp before its parent is the same case, not a crash: the
    // timespan goes negative and is clamped by the same branch.
    BOOST_CHECK_EQUAL(Retarget(GapsSummingTo(-100000)), 0x1e055555U);
}

BOOST_AUTO_TEST_CASE(the_clamp_holds_at_three_times_the_timespan)
{
    // A day between blocks. Clamped to 3x, which on a window already at the
    // limit is then capped by the limit itself.
    BOOST_CHECK_EQUAL(
        Retarget(std::vector<int64_t>(WAM_DGW_PAST_BLOCKS - 1, 86400)),
        0x1e0fffffU);

    // The same clamp where the cap is not in the way: a window at a quarter
    // of the limit, mined a day apart, may grow by exactly three and no more.
    //
    // The division is done in place rather than as an expression, because
    // base_uint<256>::operator/ returns a base_uint and GetCompact lives on
    // arith_uint256. `(x / 4).GetCompact()` does not compile, and the
    // compiler is right: the quotient of that expression is not the type
    // that knows how to encode itself.
    arith_uint256 quarter_target = UintToArith256(Params().GetConsensus().powLimit);
    quarter_target /= 4;
    const unsigned int quarter = quarter_target.GetCompact();
    const unsigned int slow =
        Retarget(std::vector<int64_t>(WAM_DGW_PAST_BLOCKS - 1, 86400), {quarter});

    arith_uint256 before = arith_uint256().SetCompact(quarter);
    const arith_uint256 after = arith_uint256().SetCompact(slow);
    arith_uint256 twice = before;   twice *= 2;
    arith_uint256 thrice = before;  thrice *= 3;
    BOOST_CHECK(after > twice);
    BOOST_CHECK(after <= thrice);
}

BOOST_AUTO_TEST_CASE(the_average_weights_the_recent_blocks)
{
    // 23 blocks at the limit and the newest at half of it, at the fixed-point
    // spacing so that only the averaging moves the answer. A plain mean would
    // give 0.979 of the limit; DGW's (n+1) divisor gives 0.96, which is the
    // whole reason the recurrence is written the way it is.
    std::vector<unsigned int> bits(WAM_DGW_PAST_BLOCKS, LIMIT_BITS);
    bits.back() = 0x1e07ffff;                        // half the limit
    BOOST_CHECK_EQUAL(Retarget(GapsSummingTo(2880), bits), 0x1e0f5c27U);
}

BOOST_AUTO_TEST_CASE(a_target_never_exceeds_the_limit)
{
    const Consensus::Params& consensus = Params().GetConsensus();
    const arith_uint256 limit = UintToArith256(consensus.powLimit);

    for (const int64_t span : {0, 60, 1440, 2880, 8640, 100000, 1000000}) {
        const unsigned int got = Retarget(GapsSummingTo(span));
        const arith_uint256 target = arith_uint256().SetCompact(got);
        BOOST_CHECK_MESSAGE(target <= limit,
                            "span " << span << " produced a target above powLimit");
        BOOST_CHECK_MESSAGE(target != 0,
                            "span " << span << " produced a zero target");
    }
}

// ---------------------------------------------------------------------------
// The consensus entry point
// ---------------------------------------------------------------------------

BOOST_AUTO_TEST_CASE(get_next_work_required_delegates_to_dgw)
{
    const Consensus::Params& consensus = Params().GetConsensus();
    BOOST_CHECK(!consensus.fPowNoRetargeting);

    std::vector<CBlockIndex> blocks =
        MakeChain(GapsSummingTo(1440), {LIMIT_BITS}, /*firstHeight=*/1000);
    BOOST_CHECK_EQUAL(GetNextWorkRequired(&blocks.back(), nullptr, consensus),
                      DarkGravityWave(&blocks.back(), consensus));
}

BOOST_AUTO_TEST_CASE(no_retargeting_pins_the_previous_bits)
{
    // regtest's escape hatch, which is why the functional tests cannot
    // exercise anything above this line.
    Consensus::Params consensus = Params().GetConsensus();
    consensus.fPowNoRetargeting = true;

    std::vector<CBlockIndex> blocks =
        MakeChain(GapsSummingTo(1440), {0x1d00ffff}, /*firstHeight=*/1000);
    BOOST_CHECK_EQUAL(GetNextWorkRequired(&blocks.back(), nullptr, consensus),
                      0x1d00ffffU);
    BOOST_CHECK_EQUAL(GetNextWorkRequired(nullptr, nullptr, consensus),
                      UintToArith256(consensus.powLimit).GetCompact());
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

BOOST_AUTO_TEST_CASE(check_proof_of_work_refuses_nonsense_targets)
{
    const Consensus::Params& consensus = Params().GetConsensus();
    const uint256 zero_hash{};

    // A zero target cannot be met by anything, including a zero hash.
    BOOST_CHECK(!CheckProofOfWork(zero_hash, 0, consensus));
    // Negative (the sign bit of the compact encoding).
    BOOST_CHECK(!CheckProofOfWork(zero_hash, 0x00800000, consensus));
    // Overflowing 256 bits.
    BOOST_CHECK(!CheckProofOfWork(zero_hash, 0xff123456, consensus));
    // Easier than the network's own limit: this is what stops a miner
    // choosing his own difficulty.
    BOOST_CHECK(!CheckProofOfWork(zero_hash, 0x1e1fffff, consensus));

    // And the limit itself is allowed.
    BOOST_CHECK(CheckProofOfWork(zero_hash, LIMIT_BITS, consensus));

    // A hash exactly equal to the target passes; one unit above it does not.
    const arith_uint256 target = arith_uint256().SetCompact(LIMIT_BITS);
    BOOST_CHECK(CheckProofOfWork(ArithToUint256(target), LIMIT_BITS, consensus));
    BOOST_CHECK(!CheckProofOfWork(ArithToUint256(target + 1), LIMIT_BITS, consensus));
}

BOOST_AUTO_TEST_SUITE_END()
