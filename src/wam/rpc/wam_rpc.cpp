// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// WAM-specific RPC commands. Registered alongside the stock Bitcoin Core set,
// so `wam-cli help` lists them under their own category.
//
// Everything here is read-only. Nothing in this file can move funds or change
// node state -- these are auditing and monitoring commands, and keeping them
// side-effect-free means they are safe to expose to a monitoring system.

#include <chain.h>
#include <chainparams.h>
#include <node/context.h>
#include <rpc/blockchain.h>
#include <rpc/server.h>
#include <rpc/server_util.h>
#include <rpc/util.h>
#include <util/strencodings.h>
#include <validation.h>
#include <wam/consensus/devfee.h>
#include <wam/consensus/subsidy.h>
#include <wam/crypto/randomx_hash.h>
#include <wam/wam-params.h>

#include <univalue.h>

#include <algorithm>

using node::NodeContext;

// ===========================================================================

static RPCHelpMan getsupplyinfo()
{
    return RPCHelpMan{
        "getsupplyinfo",
        "\nReturns WAM Coin's monetary policy and the supply in existence right now.\n"
        "\nEvery figure is derived from consensus code, not from configuration, so it "
        "can be used to independently audit the 22,000,000 WAM cap.\n",
        {},
        RPCResult{
            RPCResult::Type::OBJ, "", "",
            {
                {RPCResult::Type::NUM, "height", "current chain height"},
                {RPCResult::Type::STR_AMOUNT, "circulating", "supply created so far"},
                {RPCResult::Type::STR_AMOUNT, "max_supply", "the hard cap (22,000,000)"},
                {RPCResult::Type::STR_AMOUNT, "premine", "minted in the genesis block"},
                {RPCResult::Type::STR_AMOUNT, "mining_allocation", "reserved for miners"},
                {RPCResult::Type::STR_AMOUNT, "block_subsidy", "subsidy at this height"},
                {RPCResult::Type::STR_AMOUNT, "miner_subsidy", "the miner's share"},
                {RPCResult::Type::STR_AMOUNT, "treasury_subsidy", "the 5% treasury share"},
                {RPCResult::Type::NUM, "halving_epoch", "how many halvings have occurred"},
                {RPCResult::Type::NUM, "halving_interval", "blocks between halvings"},
                {RPCResult::Type::NUM, "next_halving_height", "height of the next halving"},
                {RPCResult::Type::NUM, "blocks_until_halving", ""},
                {RPCResult::Type::NUM, "percent_mined", "percentage of the cap issued"},

                // These two were returned but never declared. Beyond leaving
                // `help getsupplyinfo` silent about the founder disclosure --
                // the part a reader is most likely to be looking for -- an
                // undeclared key makes the call throw "Internal bug detected"
                // under -rpcdoccheck, so no functional test could read the
                // supply at all.
                {RPCResult::Type::OBJ, "founder_vesting", "the founder reserve and how much of it has unlocked",
                {
                    {RPCResult::Type::STR_AMOUNT, "total", "the whole reserve, minted in the genesis block"},
                    {RPCResult::Type::STR_AMOUNT, "unlocked", "spendable as of the tip's timestamp"},
                    {RPCResult::Type::STR_AMOUNT, "locked", "still held by CHECKLOCKTIMEVERIFY"},
                    {RPCResult::Type::NUM, "tranches", "how many tranches the reserve is split into"},
                    {RPCResult::Type::ARR, "schedule", "one entry per tranche",
                    {
                        {RPCResult::Type::OBJ, "", "",
                        {
                            {RPCResult::Type::NUM, "tranche", "1-based index"},
                            {RPCResult::Type::STR_AMOUNT, "amount", "size of this tranche"},
                            {RPCResult::Type::NUM_TIME, "unlock_time", "unix time this tranche unlocks; every founder tranche is locked, so this is never 0 on mainnet"},
                            {RPCResult::Type::BOOL, "unlocked", "whether the tip's timestamp has passed that time"},
                        }},
                    }},
                }},
                {RPCResult::Type::OBJ, "treasury", "the treasury fee and its sunset",
                {
                    {RPCResult::Type::NUM, "percent", "share of the subsidy, as a whole percentage"},
                    {RPCResult::Type::BOOL, "active", "whether the fee applies at this height"},
                    {RPCResult::Type::NUM, "last_height", "the final height at which it applies"},
                    {RPCResult::Type::NUM, "blocks_remaining", "blocks left before it stops, 0 once past"},
                    {RPCResult::Type::STR_AMOUNT, "lifetime_total", "everything the treasury will ever receive"},
                }},
            }},
        RPCExamples{HelpExampleCli("getsupplyinfo", "")
                  + HelpExampleRpc("getsupplyinfo", "")},
        [&](const RPCHelpMan& self, const JSONRPCRequest& request) -> UniValue
        {
            ChainstateManager& chainman = EnsureAnyChainman(request.context);
            LOCK(cs_main);

            const CChain& active = chainman.ActiveChain();
            const Consensus::Params& consensus = Params().GetConsensus();
            const int height = active.Height();

            const CBlockIndex* tip = active.Tip();
            const int64_t nTipTime = tip ? tip->GetBlockTime() : wam::WAM_GENESIS_TIME;

            const CAmount circulating = wam::GetTotalSupplyAtHeight(height, consensus);
            const CAmount subsidy = wam::GetBlockSubsidy(height, consensus);
            const CAmount devFee = wam::GetDevFeeAmount(subsidy, height);

            const CAmount vested = wam::GetVestedPremine(nTipTime);
            const CAmount locked = consensus.nGenesisPremine - vested;

            // THE FIRST BLOCK THAT PAYS LESS, NOT THE LAST THAT PAYS FULL.
            //
            // GetBlockSubsidy counts halvings as (nHeight - 1) / interval,
            // because block 0 mints the premine and would otherwise sit
            // inside epoch 0 and leave that epoch one block short. So epoch
            // e begins at e * interval + 1, and the + 1 below is that same
            // offset read back out.
            //
            // Without it this reported the last block of the CURRENT epoch:
            // on regtest, standing at height 150, "next halving 150" and
            // "0 blocks until halving" -- while block 150 still paid 50 WAM
            // and 151 was the first to pay 25. On mainnet it names 200,000
            // when the subsidy falls at 200,001.
            //
            // It is not a consensus or payout fault; the arithmetic that
            // pays miners was always right. It is a number we publish:
            // explorer/lib/collector.js serves it and bots/announce.js
            // posts "Next halving in N blocks" from it, so the wrong one
            // reaches the channels and the explorer rather than stopping at
            // an RPC nobody calls.
            //
            // Found by dang150296 (Urriki1502) on 9 November 2026, in a
            // second independent review of v0.1.13 that rebuilt the patched
            // Core and ran native regtest. He reported it, priced it at
            // nothing, and was right about the severity and modest about
            // the reach.
            const int epoch = (height >= 1)
                ? (height - 1) / consensus.nSubsidyHalvingInterval : 0;
            const int nextHalving =
                (epoch + 1) * consensus.nSubsidyHalvingInterval + 1;

            UniValue out(UniValue::VOBJ);
            out.pushKV("height", height);
            out.pushKV("circulating", ValueFromAmount(circulating));
            out.pushKV("max_supply", ValueFromAmount(consensus.nMaxMoney));
            out.pushKV("premine", ValueFromAmount(consensus.nGenesisPremine));
            out.pushKV("mining_allocation",
                       ValueFromAmount(consensus.nMaxMoney - consensus.nGenesisPremine));
            out.pushKV("block_subsidy", ValueFromAmount(subsidy));
            out.pushKV("miner_subsidy", ValueFromAmount(subsidy - devFee));
            out.pushKV("treasury_subsidy", ValueFromAmount(devFee));
            out.pushKV("halving_epoch", epoch);
            out.pushKV("halving_interval", consensus.nSubsidyHalvingInterval);
            out.pushKV("next_halving_height", nextHalving);
            out.pushKV("blocks_until_halving", nextHalving - height);
            out.pushKV("percent_mined",
                       100.0 * static_cast<double>(circulating) /
                       static_cast<double>(consensus.nMaxMoney));

            // Founder reserve vesting -- so that "how much can the founder sell
            // today?" is answerable from any node instead of taken on trust.
            UniValue vesting(UniValue::VOBJ);
            vesting.pushKV("total", ValueFromAmount(consensus.nGenesisPremine));
            vesting.pushKV("unlocked", ValueFromAmount(vested));
            vesting.pushKV("locked", ValueFromAmount(locked));
            vesting.pushKV("tranches", wam::WAM_PREMINE_TRANCHES);

            UniValue schedule(UniValue::VARR);
            for (int i = 0; i < wam::WAM_PREMINE_TRANCHES; ++i) {
                const int64_t unlockAt = wam::WAM_PREMINE_UNLOCK_TIMES[i];
                UniValue t(UniValue::VOBJ);
                t.pushKV("tranche", i + 1);
                t.pushKV("amount", ValueFromAmount(wam::WAM_PREMINE_TRANCHE_AMOUNT));
                t.pushKV("unlock_time", unlockAt);
                t.pushKV("unlocked", unlockAt == 0 || nTipTime >= unlockAt);
                schedule.push_back(std::move(t));
            }
            vesting.pushKV("schedule", std::move(schedule));
            out.pushKV("founder_vesting", std::move(vesting));

            // Treasury fee, including its sunset.
            UniValue treasury(UniValue::VOBJ);
            treasury.pushKV("percent", consensus.nDevFeePercent);
            treasury.pushKV("active", wam::IsDevFeeActive(height));
            treasury.pushKV("last_height", consensus.nDevFeeLastHeight);
            treasury.pushKV("blocks_remaining",
                            std::max(0, consensus.nDevFeeLastHeight - height));
            treasury.pushKV("lifetime_total",
                            ValueFromAmount(wam::GetLifetimeDevFee(consensus)));
            out.pushKV("treasury", std::move(treasury));

            return out;
        }};
}

// ===========================================================================

static RPCHelpMan getdevfeeinfo()
{
    return RPCHelpMan{
        "getdevfeeinfo",
        "\nReturns the development treasury parameters enforced by consensus rule WAM-1.\n"
        "\nOptionally verifies a specific block's coinbase against the rule, which lets "
        "anyone confirm the 5% was actually paid without trusting a block explorer.\n",
        {
            {"blockhash", RPCArg::Type::STR_HEX, RPCArg::Optional::OMITTED,
             "audit this block instead of reporting parameters only"},
        },
        RPCResult{
            RPCResult::Type::OBJ, "", "",
            {
                {RPCResult::Type::STR, "address", "the treasury address"},
                {RPCResult::Type::STR_HEX, "script", "its scriptPubKey"},
                {RPCResult::Type::NUM, "percent", "percentage of the subsidy (5)"},
                {RPCResult::Type::NUM, "start_height", "first height the rule applies at"},
                {RPCResult::Type::NUM, "last_height", "LAST height the rule applies at; "
                 "from last_height + 1 the treasury share is zero"},
                {RPCResult::Type::BOOL, "active_now", "whether the fee is still collected"},
                {RPCResult::Type::NUM, "blocks_remaining", "blocks until the fee expires"},
                {RPCResult::Type::STR_AMOUNT, "lifetime_total",
                 "total treasury income from block rewards over the life of the chain"},
                {RPCResult::Type::STR_AMOUNT, "required_now",
                 "the amount required at the current height"},
            }},
        RPCExamples{HelpExampleCli("getdevfeeinfo", "")
                  + HelpExampleCli("getdevfeeinfo", "\"<blockhash>\"")},
        [&](const RPCHelpMan& self, const JSONRPCRequest& request) -> UniValue
        {
            ChainstateManager& chainman = EnsureAnyChainman(request.context);
            const Consensus::Params& consensus = Params().GetConsensus();

            UniValue out(UniValue::VOBJ);
            out.pushKV("address", consensus.devFeeAddress);
            out.pushKV("script", HexStr(wam::DevFeeScript(consensus)));
            out.pushKV("percent", consensus.nDevFeePercent);
            out.pushKV("start_height", consensus.nDevFeeStartHeight);

            // The sunset height is published so that explorers and pools read
            // it from consensus rather than from their own copy of the
            // constant. A dashboard showing a different expiry than the chain
            // enforces is exactly the kind of quiet drift this repository
            // spends effort preventing everywhere else.
            out.pushKV("last_height", consensus.nDevFeeLastHeight);
            out.pushKV("lifetime_total", ValueFromAmount(wam::GetLifetimeDevFee(consensus)));

            {
                LOCK(cs_main);
                const int height = chainman.ActiveChain().Height();
                out.pushKV("required_now",
                    ValueFromAmount(wam::GetDevFeeAmount(
                        wam::GetBlockSubsidy(height, consensus), height)));
                out.pushKV("active_now", wam::IsDevFeeActive(height));
                out.pushKV("blocks_remaining",
                           std::max(0, consensus.nDevFeeLastHeight - height));
            }

            if (!request.params[0].isNull()) {
                const uint256 hash(ParseHashV(request.params[0], "blockhash"));

                const CBlockIndex* pindex{nullptr};
                {
                    LOCK(cs_main);
                    pindex = chainman.m_blockman.LookupBlockIndex(hash);
                }
                if (pindex == nullptr) {
                    throw JSONRPCError(RPC_INVALID_ADDRESS_OR_KEY, "Block not found");
                }

                CBlock block;
                if (!chainman.m_blockman.ReadBlockFromDisk(block, *pindex)) {
                    throw JSONRPCError(RPC_MISC_ERROR, "Block not available on disk");
                }

                const CAmount subsidy = wam::GetBlockSubsidy(pindex->nHeight, consensus);
                const CAmount required = wam::GetDevFeeAmount(subsidy, pindex->nHeight);
                const CAmount paid = wam::GetPaidDevFee(*block.vtx[0], consensus);

                UniValue audit(UniValue::VOBJ);
                audit.pushKV("height", pindex->nHeight);
                audit.pushKV("subsidy", ValueFromAmount(subsidy));
                audit.pushKV("required", ValueFromAmount(required));
                audit.pushKV("paid", ValueFromAmount(paid));
                audit.pushKV("compliant", paid >= required);
                out.pushKV("block", audit);
            }

            return out;
        }};
}

// ===========================================================================

static RPCHelpMan getrandomxinfo()
{
    return RPCHelpMan{
        "getrandomxinfo",
        "\nReturns the RandomX key schedule for the current tip.\n"
        "\nMiners and pools use this to know when they must rebuild their dataset.\n",
        {},
        RPCResult{
            RPCResult::Type::OBJ, "", "",
            {
                {RPCResult::Type::NUM, "height", "current height"},
                {RPCResult::Type::NUM, "seed_height", "height that seeds the key (0 = bootstrap)"},
                {RPCResult::Type::STR_HEX, "seed_hash", "the RandomX key"},
                {RPCResult::Type::BOOL, "bootstrap", "true while inside the first epoch"},
                {RPCResult::Type::NUM, "epoch_blocks", "blocks per key epoch"},
                {RPCResult::Type::NUM, "epoch_lag", "how far behind the tip the seed sits"},
                {RPCResult::Type::NUM, "blocks_until_rotation", ""},
                {RPCResult::Type::NUM, "memory_bytes", "memory held by RandomX right now"},
            }},
        RPCExamples{HelpExampleCli("getrandomxinfo", "")},
        [&](const RPCHelpMan& self, const JSONRPCRequest& request) -> UniValue
        {
            ChainstateManager& chainman = EnsureAnyChainman(request.context);
            const Consensus::Params& consensus = Params().GetConsensus();

            LOCK(cs_main);
            const CBlockIndex* tip = chainman.ActiveChain().Tip();
            const int height = tip ? tip->nHeight : 0;
            const int nextHeight = height + 1;

            const int seedHeight = wam::GetRandomXSeedHeight(nextHeight, consensus);
            const uint256 seed = wam::GetRandomXSeedHash(tip, consensus);

            // Walk forward to the first height whose seed differs.
            int rotation = 0;
            for (int h = nextHeight + 1; h <= nextHeight + consensus.nRandomXEpochBlocks
                                              + consensus.nRandomXEpochLag + 1; ++h) {
                if (wam::GetRandomXSeedHeight(h, consensus) != seedHeight) {
                    rotation = h - nextHeight;
                    break;
                }
            }

            UniValue out(UniValue::VOBJ);
            out.pushKV("height", height);
            out.pushKV("seed_height", seedHeight);
            out.pushKV("seed_hash", seed.GetHex());
            out.pushKV("bootstrap", seedHeight == 0);
            out.pushKV("epoch_blocks", consensus.nRandomXEpochBlocks);
            out.pushKV("epoch_lag", consensus.nRandomXEpochLag);
            out.pushKV("blocks_until_rotation", rotation);
            out.pushKV("memory_bytes", static_cast<int64_t>(wam::GetRandomXMemoryUsage()));
            return out;
        }};
}

// ===========================================================================

static RPCHelpMan getemissionschedule()
{
    return RPCHelpMan{
        "getemissionschedule",
        "\nReturns the complete halving schedule: every epoch, its subsidy, and the "
        "cumulative supply at its end.\n"
        "\nThis is the machine-readable form of the table in WHITEPAPER.md.\n",
        {},
        // The nine fields are named here rather than left as an empty object.
        //
        // This was `{{RPCResult::Type::OBJ, "", "", {}}}`, and clang refuses it:
        //
        //   error: type 'const char[1]' cannot be narrowed to 'bool' in
        //          initializer list [-Wc++11-narrowing]
        //
        // RPCResult has an overload taking (Type, key_name, bool optional,
        // description, ...) and another taking (Type, key_name, description,
        // inner, ...). Four arguments fit both, so "" is a candidate for the
        // bool, and clang reports the narrowing instead of choosing. GCC picks
        // the intended overload silently, which is why this compiled on Linux
        // and on the Windows cross-build -- both GCC -- and failed on the first
        // machine that used clang. Upstream supports clang 16 and later, so
        // anybody building WAM with it on Linux would have hit this too.
        //
        // Declaring the fields removes the ambiguity by having something real
        // to put in `inner`, and it is what the help text is for: the previous
        // form told a caller that getemissionschedule returns an array of
        // objects and nothing whatever about them.
        RPCResult{RPCResult::Type::ARR, "", "The halving schedule, one entry per epoch", {
            {RPCResult::Type::OBJ, "", "", {
                {RPCResult::Type::NUM, "epoch", "0 for the first epoch, counting up"},
                {RPCResult::Type::NUM, "first_height", "first block height in this epoch"},
                {RPCResult::Type::NUM, "last_height", "last block height in this epoch"},
                {RPCResult::Type::STR_AMOUNT, "subsidy", "block subsidy in this epoch"},
                {RPCResult::Type::STR_AMOUNT, "miner_subsidy", "the miner's share, after the treasury fee"},
                {RPCResult::Type::STR_AMOUNT, "treasury_subsidy", "the treasury's share of each block"},
                {RPCResult::Type::BOOL, "treasury_active", "whether the 5% fee still applies in this epoch"},
                {RPCResult::Type::STR_AMOUNT, "epoch_total", "total issued across the whole epoch"},
                {RPCResult::Type::STR_AMOUNT, "cumulative_supply", "supply at the end of this epoch, premine included"},
            }},
        }},
        RPCExamples{HelpExampleCli("getemissionschedule", "")},
        [&](const RPCHelpMan& self, const JSONRPCRequest& request) -> UniValue
        {
            const Consensus::Params& consensus = Params().GetConsensus();
            const int interval = consensus.nSubsidyHalvingInterval;

            UniValue arr(UniValue::VARR);
            CAmount cumulative = consensus.nGenesisPremine;

            for (int epoch = 0; epoch < wam::WAM_MAX_HALVINGS; ++epoch) {
                const CAmount subsidy = consensus.nInitialSubsidy >> epoch;
                if (subsidy == 0) break;

                const CAmount epochTotal = static_cast<CAmount>(interval) * subsidy;
                cumulative += epochTotal;

                const int firstHeight = epoch * interval + 1;
                const int lastHeight = (epoch + 1) * interval;
                const CAmount devFee = wam::GetDevFeeAmount(subsidy, firstHeight);

                UniValue e(UniValue::VOBJ);
                e.pushKV("epoch", epoch);
                e.pushKV("first_height", firstHeight);
                e.pushKV("last_height", lastHeight);
                e.pushKV("subsidy", ValueFromAmount(subsidy));
                e.pushKV("miner_subsidy", ValueFromAmount(subsidy - devFee));
                e.pushKV("treasury_subsidy", ValueFromAmount(devFee));
                e.pushKV("treasury_active", wam::IsDevFeeActive(firstHeight));
                e.pushKV("epoch_total", ValueFromAmount(epochTotal));
                e.pushKV("cumulative_supply", ValueFromAmount(cumulative));
                arr.push_back(std::move(e));
            }

            return arr;
        }};
}

// ===========================================================================

void RegisterWamRPCCommands(CRPCTable& t)
{
    static const CRPCCommand commands[]{
        {"wam", &getsupplyinfo},
        {"wam", &getdevfeeinfo},
        {"wam", &getrandomxinfo},
        {"wam", &getemissionschedule},
    };
    for (const auto& c : commands) {
        t.appendCommand(c.name, &c);
    }
}
