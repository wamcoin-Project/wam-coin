// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.

#include <wam/consensus/devfee.h>

#include <chainparams.h>
#include <consensus/params.h>
#include <consensus/validation.h>
#include <key_io.h>
#include <primitives/transaction.h>
#include <script/solver.h>
#include <tinyformat.h>
#include <wam/consensus/subsidy.h>
#include <wam/wam-params.h>

#include <map>
#include <mutex>
#include <string>

namespace wam {

namespace {

// The treasury script never changes for the lifetime of a chain, and
// CheckDevFeeOutput() runs for every connected block, so it is built once per
// chain and a const reference is handed out thereafter.
//
// ONCE PER CHAIN, NOT ONCE PER PROCESS.
//
// This was a std::once_flag and a single CScript, so the FIRST parameters a
// process touched won for its lifetime. In production that is harmless --
// one chain per process -- and the argument "harmless in production" is the
// one this project has been wrong about most often. A unit-test process that
// constructs more than one network, or any future tool that does, would be
// served another chain's treasury script and told it was this one's.
//
// The map is never erased from, and std::map keeps references to its
// elements valid across every insertion, so the const reference handed out
// here stays valid for the life of the process even while another thread
// adds a different chain. The lock covers the lookup and the insert; the
// cost is one uncontended mutex per connected block.
//
// Reported by Radenlingga (Discord), 10 November 2026.
std::mutex g_devfee_mutex;
std::map<std::string, CScript> g_devfee_scripts;

CScript BuildDevFeeScript(const Consensus::Params& consensusParams)
{
    const CTxDestination dest = DecodeDestination(consensusParams.devFeeAddress);

    // A malformed treasury address is a build-time configuration error, not a
    // runtime condition. Refusing to start is far safer than silently mining a
    // chain whose 5% is burned to an unspendable script.
    if (!IsValidDestination(dest)) {
        throw std::runtime_error(strprintf(
            "WAM consensus: the configured development treasury address '%s' is not a "
            "valid WAM address. Run scripts/gen_founder_key.py and set the result in "
            "kernel/chainparams.cpp before building.",
            consensusParams.devFeeAddress));
    }

    return GetScriptForDestination(dest);
}

} // namespace

const CScript& DevFeeScript(const Consensus::Params& consensusParams)
{
    std::lock_guard<std::mutex> lock(g_devfee_mutex);
    auto it = g_devfee_scripts.find(consensusParams.devFeeAddress);
    if (it == g_devfee_scripts.end()) {
        it = g_devfee_scripts.emplace(consensusParams.devFeeAddress,
                                      BuildDevFeeScript(consensusParams)).first;
    }
    return it->second;
}

CAmount GetPaidDevFee(const CTransaction& coinbase, const Consensus::Params& consensusParams)
{
    const CScript& devScript = DevFeeScript(consensusParams);

    CAmount nPaid = 0;
    for (const CTxOut& out : coinbase.vout) {
        if (out.scriptPubKey == devScript) {
            nPaid += out.nValue;
        }
    }
    return nPaid;
}

bool CheckDevFeeOutput(const CTransaction& coinbase,
                       int nHeight,
                       CAmount nBlockSubsidy,
                       const Consensus::Params& consensusParams,
                       BlockValidationState& state)
{
    // The genesis block *is* the premine; there is nothing to split.
    if (nHeight < WAM_DEVFEE_START_HEIGHT) return true;

    // The sunset: from height 400,001 the treasury has no claim on the subsidy
    // at all, and a block that pays it anyway is still perfectly valid -- the
    // rule only ever sets a floor, never a ceiling.
    if (nHeight > WAM_DEVFEE_LAST_HEIGHT) return true;

    const CAmount nRequired = GetDevFeeAmount(nBlockSubsidy, nHeight);

    // Once the subsidy has decayed far enough that 5% truncates to zero there
    // is no meaningful output to demand, and requiring a 0-value output would
    // only bloat the UTXO set.
    if (nRequired <= 0) return true;

    if (!coinbase.IsCoinBase() || coinbase.vout.empty()) {
        return state.Invalid(BlockValidationResult::BLOCK_CONSENSUS,
                             "bad-cb-devfee-missing",
                             "coinbase has no outputs to carry the development fee");
    }

    const CAmount nPaid = GetPaidDevFee(coinbase, consensusParams);

    if (nPaid < nRequired) {
        return state.Invalid(
            BlockValidationResult::BLOCK_CONSENSUS,
            "bad-cb-devfee-amount",
            strprintf("coinbase pays %d.%08d WAM to the development treasury but "
                      "consensus requires at least %d.%08d WAM (%d%% of the %d.%08d WAM subsidy) "
                      "to be sent to %s. This rule applies to heights %d..%d; "
                      "after height %d the treasury share is zero.",
                      nPaid / WAM_COIN, nPaid % WAM_COIN,
                      nRequired / WAM_COIN, nRequired % WAM_COIN,
                      WAM_DEVFEE_PERCENT,
                      nBlockSubsidy / WAM_COIN, nBlockSubsidy % WAM_COIN,
                      consensusParams.devFeeAddress,
                      WAM_DEVFEE_START_HEIGHT, WAM_DEVFEE_LAST_HEIGHT,
                      WAM_DEVFEE_LAST_HEIGHT));
    }

    return true;
}

} // namespace wam
