// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.

#include <wam/pow.h>

#include <arith_uint256.h>
#include <chain.h>
#include <consensus/params.h>
#include <primitives/block.h>
#include <uint256.h>
#include <wam/crypto/randomx_hash.h>
#include <wam/wam-params.h>

#include <cassert>

namespace wam {

unsigned int DarkGravityWave(const CBlockIndex* pindexLast, const Consensus::Params& params)
{
    const arith_uint256 bnPowLimit = UintToArith256(params.powLimit);
    const int64_t nPastBlocks = WAM_DGW_PAST_BLOCKS;

    // Not enough history to average over: everyone mines at the minimum
    // difficulty. This window is 24 blocks (~48 minutes) at launch.
    if (pindexLast == nullptr || pindexLast->nHeight < nPastBlocks) {
        return bnPowLimit.GetCompact();
    }

    const CBlockIndex* pindex = pindexLast;
    arith_uint256 bnPastTargetAvg;

    // Running arithmetic mean of the last nPastBlocks targets.
    //
    //   avg_1 = t_1
    //   avg_n = (avg_{n-1} * n + t_n) / (n + 1)
    //
    // This is Dash's exact DGWv3 recurrence. Note that it is deliberately NOT
    // a plain mean -- the (n+1) divisor weights recent blocks slightly more
    // heavily, which is what gives DGW its fast response to hash rate steps.
    for (int64_t nCountBlocks = 1; nCountBlocks <= nPastBlocks; nCountBlocks++) {
        arith_uint256 bnTarget = arith_uint256().SetCompact(pindex->nBits);

        if (nCountBlocks == 1) {
            bnPastTargetAvg = bnTarget;
        } else {
            bnPastTargetAvg = (bnPastTargetAvg * nCountBlocks + bnTarget) / (nCountBlocks + 1);
        }

        if (nCountBlocks != nPastBlocks) {
            assert(pindex->pprev); // guaranteed by the nHeight check above
            pindex = pindex->pprev;
        }
    }

    arith_uint256 bnNew(bnPastTargetAvg);

    // `pindex` now points at the oldest block in the window.
    int64_t nActualTimespan = pindexLast->GetBlockTime() - pindex->GetBlockTime();
    const int64_t nTargetTimespan = nPastBlocks * params.nPowTargetSpacing;

    // Clamp. Without this, a single block carrying a timestamp far in the past
    // (or the future) could move difficulty by an unbounded factor.
    if (nActualTimespan < nTargetTimespan / WAM_DGW_CLAMP_FACTOR) {
        nActualTimespan = nTargetTimespan / WAM_DGW_CLAMP_FACTOR;
    }
    if (nActualTimespan > nTargetTimespan * WAM_DGW_CLAMP_FACTOR) {
        nActualTimespan = nTargetTimespan * WAM_DGW_CLAMP_FACTOR;
    }

    // Retarget: blocks came in fast  -> nActualTimespan small -> target shrinks
    //           blocks came in slow  -> nActualTimespan large -> target grows
    bnNew *= nActualTimespan;
    bnNew /= nTargetTimespan;

    if (bnNew > bnPowLimit) {
        bnNew = bnPowLimit;
    }

    return bnNew.GetCompact();
}

unsigned int GetNextWorkRequired(const CBlockIndex* pindexLast,
                                 const CBlockHeader* pblock,
                                 const Consensus::Params& params)
{
    assert(pindexLast != nullptr || params.fPowNoRetargeting);

    // regtest: difficulty is pinned so functional tests can mine instantly.
    if (params.fPowNoRetargeting) {
        return pindexLast ? pindexLast->nBits
                          : UintToArith256(params.powLimit).GetCompact();
    }

    // WAM has no "minimum difficulty blocks after 20 minutes" rule of the kind
    // Bitcoin testnet uses. DGW retargets every block, which makes that rule
    // both unnecessary and a difficulty-oscillation attack vector.
    (void)pblock;

    return DarkGravityWave(pindexLast, params);
}

bool CheckProofOfWork(const uint256& hash, unsigned int nBits, const Consensus::Params& params)
{
    bool fNegative;
    bool fOverflow;
    arith_uint256 bnTarget;

    bnTarget.SetCompact(nBits, &fNegative, &fOverflow);

    // Reject nonsensical or out-of-range targets before comparing.
    if (fNegative || fOverflow || bnTarget == 0 || bnTarget > UintToArith256(params.powLimit)) {
        return false;
    }

    // `hash` is the RandomX output for this header, produced by
    // wam::GetRandomXPoWHash(). Passing the block's double-SHA256 id here
    // would silently accept every block -- the call sites are the integration
    // point that patches/0002 rewires.
    return UintToArith256(hash) <= bnTarget;
}

void GrindProofOfWork(CBlockHeader& header, const CBlockIndex* pindexPrev,
                      const Consensus::Params& params)
{
    const uint256 seed = GetRandomXSeedHash(pindexPrev, params);
    while (!CheckProofOfWork(GetRandomXPoWHash(header, seed), header.nBits, params)) {
        ++header.nNonce;
        // A wrap means the whole 32-bit space failed, which on a test chain
        // means the target is wrong rather than the search unlucky.
        assert(header.nNonce != 0);
    }
}

} // namespace wam
