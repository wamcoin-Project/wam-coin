// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// Drop-in replacement for Bitcoin Core's src/kernel/chainparams.cpp.
// Copied into the build tree by scripts/fetch-upstream.sh, which also applies
// every other change through scripts/patch_upstream.py. Run that with --list
// to read all of them with their reasons.

#include <kernel/chainparams.h>

#include <base58.h>
#include <chainparamsseeds.h>
#include <consensus/amount.h>
#include <consensus/merkle.h>
#include <consensus/params.h>
#include <hash.h>
#include <primitives/block.h>
#include <primitives/transaction.h>
#include <script/interpreter.h>
#include <script/script.h>
#include <uint256.h>
#include <util/chaintype.h>
#include <util/strencodings.h>
#include <wam/wam-params.h>

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

using namespace wam;

// ===========================================================================
//  FOUNDER AND TREASURY ADDRESSES
// ===========================================================================
//
//  Two addresses, deliberately not one.
//
//    FOUNDER   receives the entire 2,000,000 WAM genesis premine, split across
//              five tranches. Every one of them is behind
//              OP_CHECKLOCKTIMEVERIFY; not a coin is spendable at launch.
//              They open one a year from 2027-09-15 to 2031-09-15.
//
//    TREASURY  receives 5% of every block subsidy from height 1 to
//              WAM_DEVFEE_LAST_HEIGHT (400,000) -- 750,000 WAM in total. The
//              fee expires there; it is not perpetual, and from 400,001 miners
//              keep the whole subsidy.
//
//  They were the same address once. That made the two indistinguishable on
//  chain: anyone auditing a spend could not tell operating money paying for a
//  server from the founder selling his reserve. Separating them is what makes
//  treasury spending *provable* rather than merely asserted, which serves the
//  founder before it serves anybody else.
//
//  ---------------------------------------------------------------------------
//  ON PLACEHOLDERS
//  ---------------------------------------------------------------------------
//
//  Where a real address is not yet available, the value here is a burn address
//  whose hash160 is twenty zero bytes. Nobody holds the key -- finding one
//  would mean inverting RIPEMD160(SHA256(.)) -- so anything paid to it is
//  provably destroyed, and provably so to any observer, not only to us.
//
//  It is syntactically VALID on purpose. An earlier revision used the literal
//  string "WAM_FOUNDER_ADDRESS_PLACEHOLDER", which made CChainParams::Main()
//  throw from its constructor. That is the wrong shape of guard: it did not
//  merely stop a bad launch, it made mainnet parameters impossible to
//  construct at all -- so every unit test using the default BasicTestingSetup
//  fixture (which selects MAIN) aborted, and the consensus code could not be
//  verified before a key existed. A placeholder must stop the NODE from
//  launching, not stop the class from being built.
//
//  The guards that refuse a launch while a burn address is still present live
//  in scripts/preflight.sh, scripts/audit_repo.sh and
//  docs/LAUNCH_CHECKLIST.md phase 3.
//
//  Generate a real one with
//      python3 scripts/gen_founder_key.py --network mainnet
//  on an OFFLINE machine, store the printed WIF on paper, and paste only the
//  printed address here.
//
//  No private key belonging to either address may ever appear in this
//  repository, in a build log, or in any chat transcript.
// ===========================================================================

// Generated 2026-08-17 by gen_founder_key.py on a live system running from RAM,
// with the network disabled, on a machine whose disk was never written to. The
// private key exists on paper and nowhere else: four handwritten copies, each
// one read back and checked against this address with --verify-backup while the
// screen still showed the original, before the machine was powered off.
//
// It has never been photographed, never typed into a networked device, and
// never transmitted to anyone.
static const std::string WAM_FOUNDER_ADDRESS_MAINNET = "WWWEvpC98mfzjRMZHtaRaucMjopqH2viQz";
// Testnet founder address, generated 2026-08-06. Testnet coins have no value,
// so this one was generated on an ordinary machine.
static const std::string WAM_FOUNDER_ADDRESS_TESTNET = "TK34fTbuMCXrwnmq72AE1EMMmdrkUtzUvq";

// ---------------------------------------------------------------------------
//  Treasury
// ---------------------------------------------------------------------------
//
//  The 5% operating fee pays here, and it is a DIFFERENT address from the
//  founder reserve above. They used to be one, which made the two
//  indistinguishable on chain: a reader auditing a spend could not tell
//  treasury money paying for a server from the founder selling. Two addresses
//  separate them permanently, and give the founder the ability to *prove*
//  where treasury money went -- which serves him before it serves anyone else.
//
//  The mainnet value below is the real treasury key, not a placeholder. It
//  went in on 23 August 2026 in a79835e, generated on an air-gapped machine
//  from a key that is not the founder key, and it decodes to hash160
//  a101cf17c209638136abe19e14dc4e1c9987370f. Consensus has paid the 5% into it
//  since block 1, scripts/treasury_spend.py spends from it, and every spend it
//  has made is in docs/TREASURY_LEDGER.md with its transaction id.
//
//  THIS PARAGRAPH SAID THE OPPOSITE FOR SEVENTY-SEVEN DAYS.
//
//  It described the value below as "the same unspendable burn address the
//  founder reserve used before its ceremony: hash160 of twenty zero bytes",
//  and told the reader to replace it with a real one -- while the key it was
//  describing had been live since block 1 and had paid five security bounties.
//  The burn address is WNg2svm2qApxheBKndKGQ9sRwporvRgRpT, which decodes to
//  twenty zero bytes, and that string is what scripts/preflight.sh and
//  scripts/audit_repo.sh refuse a launch over. They never look at the value
//  here at all, so the sentence claiming they guard it was wrong twice.
//
//  It survived because a comment is not a value: nothing in the sweep reads
//  prose, and the guards that do read this file were looking for a string
//  that left it on 23 August. The one file a reader opens to find out who
//  controls the treasury called the treasury key a placeholder, and said so
//  in the same paragraph that explains why the two addresses are separate.
//  Reported by bobbyning, 8 November 2026.
static const std::string WAM_TREASURY_ADDRESS_MAINNET = "WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE";
// Testnet treasury, generated 2026-08-19 on the seed node. Deliberately a
// different key from the testnet founder address, so testnet exercises the same
// two-address arrangement mainnet will use.
static const std::string WAM_TREASURY_ADDRESS_TESTNET = "TQkMCz4r2oWuFjAu8mAeGYDMuz4BNkmofz";

/**
 * Locking script for the founder address.
 *
 * This decodes base58check by hand rather than going through key_io's
 * DecodeDestination(). key_io resolves the address version bytes via
 * Params(), and Params() is exactly what is being constructed right now --
 * calling it here would be a use-before-initialisation that happens to work
 * on some builds and crashes on others. Decoding directly sidesteps that
 * entirely and needs no network context.
 *
 * A malformed or placeholder address throws, which stops the node from
 * starting. That is the desired behaviour: a chain whose premine and treasury
 * pay an invalid script would burn 2,000,000 WAM plus every treasury payment up
 * to height 400,000, and there is no way to undo it after launch.
 */
static std::vector<unsigned char> DecodeFounderHash(const std::string& address,
                                                    unsigned char& versionOut)
{
    std::vector<unsigned char> payload;

    if (!DecodeBase58Check(address, payload, 21) || payload.size() != 21) {
        throw std::runtime_error(
            "WAM: the founder address '" + address + "' is not a valid base58check "
            "address.\n"
            "Generate one on an offline machine with:\n"
            "    python3 scripts/gen_founder_key.py --network mainnet\n"
            "then set WAM_FOUNDER_ADDRESS_MAINNET in kernel/chainparams.cpp and mine a "
            "new genesis block with genesis/genesis_generator.py.");
    }

    versionOut = payload[0];
    return std::vector<unsigned char>(payload.begin() + 1, payload.end());
}

/** Plain P2PKH / P2SH script for the founder address. */
static CScript FounderPayToScript(const std::string& address)
{
    unsigned char version{0};
    const std::vector<unsigned char> hash = DecodeFounderHash(address, version);

    // P2PKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
    if (version == 73 || version == 65) {
        return CScript() << OP_DUP << OP_HASH160 << hash << OP_EQUALVERIFY << OP_CHECKSIG;
    }
    // P2SH: OP_HASH160 <20 bytes> OP_EQUAL
    if (version == 135 || version == 128) {
        return CScript() << OP_HASH160 << hash << OP_EQUAL;
    }

    throw std::runtime_error(
        "WAM: founder address '" + address + "' has version byte " +
        std::to_string(version) + ", which is not a WAM address version "
        "(73/135 mainnet, 65/128 testnet).");
}

/**
 * Time-locked founder script:
 *
 *     <nLockTime> OP_CHECKLOCKTIMEVERIFY OP_DROP  <normal pay-to script>
 *
 * `nLockTime` is a Unix timestamp (every value used is far above 500,000,000,
 * which is what makes CLTV read it as a time rather than a block height).
 *
 * The lock is written BARE rather than wrapped in P2SH on purpose. A P2SH
 * output would publish only a hash, and a reader would have to trust a
 * separately distributed redeem script to know when the coins unlock. Bare, the
 * unlock date sits in the scriptPubKey where `wam-cli getblock <genesis> 2`
 * prints it -- the vesting schedule becomes self-evident from block 0 instead
 * of being a promise in a PDF.
 */
static CScript TimeLockedFounderScript(const std::string& address, int64_t nLockTime)
{
    if (nLockTime == 0) return FounderPayToScript(address);

    CScript script;
    script << nLockTime << OP_CHECKLOCKTIMEVERIFY << OP_DROP;

    const CScript payTo = FounderPayToScript(address);
    script.insert(script.end(), payTo.begin(), payTo.end());
    return script;
}

/**
 * The five founder-reserve outputs of the genesis coinbase.
 *
 * All five are time-locked; none is spendable at launch. They unlock on exact
 * calendar anniversaries of the launch date, one a year from 2027 to 2031, and
 * all five remain subject to the ordinary 100-block coinbase maturity as well.
 *
 * Operating money comes from the 5% treasury, which pays from block 1 and stops
 * at height 400,000 -- see WAM_DEVFEE_* in wam-params.h. The reserve is not
 * working capital and is not treated as any.
 */
static std::vector<CTxOut> BuildGenesisOutputs(const std::string& address)
{
    std::vector<CTxOut> outputs;
    outputs.reserve(WAM_PREMINE_TRANCHES);

    CAmount nTotal = 0;
    for (int i = 0; i < WAM_PREMINE_TRANCHES; ++i) {
        const int64_t nLockTime = WAM_PREMINE_UNLOCK_TIMES[i];
        outputs.emplace_back(WAM_PREMINE_TRANCHE_AMOUNT,
                             TimeLockedFounderScript(address, nLockTime));
        nTotal += WAM_PREMINE_TRANCHE_AMOUNT;
    }

    // Belt and braces alongside the static_assert in wam-params.h: if these
    // ever fail to sum to the premine, the genesis block silently mints the
    // wrong amount and the hard cap stops meaning anything.
    if (nTotal != WAM_GENESIS_PREMINE) {
        throw std::runtime_error("WAM: vesting tranches do not sum to the genesis premine");
    }

    return outputs;
}

/** Single-output genesis, used by regtest where vesting only gets in the way. */
static std::vector<CTxOut> SingleGenesisOutput(const CScript& script)
{
    return {CTxOut(WAM_GENESIS_PREMINE, script)};
}

/**
 * Build the genesis block.
 *
 * The coinbase input carries the launch phrase, which is committed into the
 * merkle root and therefore into the genesis hash: it is a permanent,
 * unforgeable proof that the chain was not created before the phrase existed.
 *
 * The outputs pay the 2,000,000 WAM founder reserve, split across the vesting
 * tranches. Note that in stock Bitcoin Core these outputs would be invisible to
 * the UTXO set and thus unspendable -- change WAM-005 fixes exactly that.
 */
static CBlock CreateGenesisBlock(const char* pszTimestamp,
                                 const std::vector<CTxOut>& genesisOutputs,
                                 uint32_t nTime,
                                 uint32_t nNonce,
                                 uint32_t nBits,
                                 int32_t nVersion)
{
    CMutableTransaction txNew;
    txNew.version = 1;
    txNew.vin.resize(1);
    txNew.vin[0].scriptSig = CScript()
        << 486604799
        << CScriptNum(4)
        << std::vector<unsigned char>((const unsigned char*)pszTimestamp,
                                      (const unsigned char*)pszTimestamp + strlen(pszTimestamp));
    txNew.vout = genesisOutputs;

    CBlock genesis;
    genesis.nTime    = nTime;
    genesis.nBits    = nBits;
    genesis.nNonce   = nNonce;
    genesis.nVersion = nVersion;
    genesis.vtx.push_back(MakeTransactionRef(std::move(txNew)));
    genesis.hashPrevBlock.SetNull();
    genesis.hashMerkleRoot = BlockMerkleRoot(genesis);
    return genesis;
}

static CBlock CreateGenesisBlock(uint32_t nTime, uint32_t nNonce, uint32_t nBits,
                                 int32_t nVersion,
                                 const std::vector<CTxOut>& genesisOutputs)
{
    return CreateGenesisBlock(WAM_GENESIS_TIMESTAMP_PHRASE, genesisOutputs,
                              nTime, nNonce, nBits, nVersion);
}

/**
 * ===========================================================================
 *  MAINNET
 * ===========================================================================
 */
class CMainParams : public CChainParams
{
public:
    CMainParams()
    {
        m_chain_type = ChainType::MAIN;

        // -------------------------------------------------------------------
        // Monetary policy -- every value traced back to wam/wam-params.h
        // -------------------------------------------------------------------
        consensus.nSubsidyHalvingInterval = WAM_SUBSIDY_HALVING_INTERVAL; // 200,000
        consensus.nInitialSubsidy         = WAM_INITIAL_BLOCK_SUBSIDY;    // 50 WAM
        consensus.nGenesisPremine         = WAM_GENESIS_PREMINE;          // 2,000,000 WAM
        consensus.nMaxMoney               = WAM_MAX_MONEY;                // 22,000,000 WAM
        consensus.nDevFeePercent          = WAM_DEVFEE_PERCENT;           // 5
        consensus.nDevFeeStartHeight      = WAM_DEVFEE_START_HEIGHT;      // 1
        consensus.nDevFeeLastHeight       = WAM_DEVFEE_LAST_HEIGHT;       // 400,000 (sunset)      // 1
        consensus.devFeeAddress           = WAM_TREASURY_ADDRESS_MAINNET;
        consensus.nCoinbaseMaturity       = WAM_COINBASE_MATURITY;        // 100

        // -------------------------------------------------------------------
        // Proof of work -- RandomX + DarkGravityWave v3
        // -------------------------------------------------------------------
        //
        // powLimit is the *easiest* target the network will ever accept. It is
        // set so that a single modern CPU (~1.5 kH/s on RandomX) needs roughly
        // 10 minutes to find the first blocks; DGW then pulls difficulty up to
        // the real network hash rate within the first hour of life.
        consensus.powLimit = uint256S("00000fffff000000000000000000000000000000000000000000000000000000");

        consensus.nPowTargetSpacing  = WAM_POW_TARGET_SPACING; // 120 s
        consensus.nPowTargetTimespan = WAM_DGW_PAST_BLOCKS * WAM_POW_TARGET_SPACING;
        consensus.fPowAllowMinDifficultyBlocks = false;
        consensus.fPowNoRetargeting            = false;
        consensus.nDgwPastBlocks               = WAM_DGW_PAST_BLOCKS;
        consensus.nRandomXEpochBlocks          = WAM_RANDOMX_EPOCH_BLOCKS;
        consensus.nRandomXEpochLag             = WAM_RANDOMX_EPOCH_LAG;

        // -------------------------------------------------------------------
        // Deployments
        // -------------------------------------------------------------------
        //
        // WAM launches with BIP34/65/66, CSV, SegWit and Taproot active from
        // height 1. There is no legacy chain to be compatible with, so there
        // is no reason to inherit Bitcoin's decade of activation scaffolding
        // -- and every reason not to, since dormant activation code is where
        // consensus bugs hide.
        consensus.BIP34Height = 1;
        consensus.BIP34Hash   = uint256();
        consensus.BIP65Height = 1;
        consensus.BIP66Height = 1;
        consensus.CSVHeight   = 1;
        consensus.SegwitHeight = 1;

        // BIP94: upstream assigns this for every network it defines, and
        // this file replaces that file wholesale -- so the field was
        // declared, read in three consensus paths (validation.cpp,
        // node/miner.cpp, pow.cpp) and never assigned anywhere. It has no
        // default initialiser in Consensus::Params and the params object is
        // heap-allocated, so the reads were indeterminate: it happens to be
        // false on this build, and nothing in the code says so.
        //
        // Upstream's values, kept: false on mainnet, testnet and signet,
        // true on regtest where the timewarp mitigation is exercised.
        //
        // Reported by Alboy on 2026-10-11 as WAM-F6, with the measured
        // consequence: mining_basic.py test_timewarp fails on WAM's regtest
        // on the exact assertion the rule exists to satisfy.
        consensus.enforce_BIP94 = false;
        consensus.MinBIP9WarningHeight = 0;

        consensus.nRuleChangeActivationThreshold = 1815; // 90% of 2016
        consensus.nMinerConfirmationWindow = 2016;

        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].bit = 28;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].nStartTime = Consensus::BIP9Deployment::NEVER_ACTIVE;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].nTimeout = Consensus::BIP9Deployment::NO_TIMEOUT;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].min_activation_height = 0;

        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].bit = 2;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].nStartTime = Consensus::BIP9Deployment::ALWAYS_ACTIVE;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].nTimeout = Consensus::BIP9Deployment::NO_TIMEOUT;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].min_activation_height = 0;

        // A floor under what a new node will follow.
        //
        // Zero until v0.1.9, and that was deliberate twice over.
        //
        // At launch there was no work to point at: a chain with no history
        // cannot have a floor, and shipping a fabricated one would have been
        // theatre. Then on 7 September, setting this on TESTNET stopped every
        // new node syncing -- a non-zero value turns on headerssync.cpp's
        // presync path, and upstream's PermittedDifficultyTransition there is
        // Bitcoin's 2016-block retarget schedule written as an assertion. WAM
        // retargets every block, so that assertion fails at height 1 and a
        // node accepts no headers at all. Setting this on mainnet on 15
        // September would have stopped every newcomer, in the week when
        // newcomers are the entire point, and would have looked like a network
        // outage rather than a parameter.
        //
        // patch_upstream.py (WAM_DGW_TRANSITION_PERMITTED) removes that
        // assertion, testnet has run with a non-zero floor since, and a native
        // Windows build synced 6,029 blocks through the presync path and
        // agreed with the chain. So the trap is gone and the date has come.
        //
        // Set from block 936, about 1,460 behind the tip when it was written
        // and roughly two days of network work, so there is margin. A value
        // ABOVE the real chain's work is how this setting fails badly: every
        // new node stops syncing the real chain. check_min_chain_work.py
        // compares both directions against a running node, and it is the
        // check that found this field still at zero three days into mainnet --
        // because until 18 September it, and most of the sweep, was asking the
        // testnet node.
        //
        // What it buys: a peer can no longer walk a fresh node onto a cheap
        // fabricated history. What it does not buy: anything against an
        // attacker who really does out-work the chain. It is a floor, not a
        // shield.
        //
        // It is NOT a validity rule. A node with this value and a node with
        // zero accept exactly the same blocks and stay on the same chain; they
        // differ only in which header chains they will consider while syncing.
        // A v0.1.8 node needs no update and this release is not MANDATORY --
        // consensus_floor.py excludes the field by name for that reason.
        consensus.nMinimumChainWork = uint256S("0000000000000000000000000000000000000000000000000000002adc39e008");

        // Still zero, and staying zero. defaultAssumeValid tells a node to
        // skip signature checking below a block WE name, which asks the reader
        // to trust us about history. The floor above asks them to trust
        // arithmetic they can recompute. Those are not the same request.
        consensus.defaultAssumeValid = uint256{};

        // -------------------------------------------------------------------
        // Network identity
        // -------------------------------------------------------------------
        pchMessageStart[0] = 0x57; // 'W'
        pchMessageStart[1] = 0x41; // 'A'
        pchMessageStart[2] = 0x4d; // 'M'
        pchMessageStart[3] = 0x21; // '!'
        nDefaultPort = WAM_MAINNET_P2P_PORT; // 9555

        nPruneAfterHeight = 100000;
        // WAM: what the first-run window promises a newcomer it will use.
        //
        // These two are added together and shown in the welcome dialog as
        // "At least N GB of data will be stored in this directory". They said
        // 4 and 1, so a person opening the wallet for the first time was told
        // to set aside five gigabytes -- for a chain that was five MEGAbytes
        // on 2026-09-26, eleven days after genesis, and grows by roughly half
        // a megabyte a day.
        //
        // 1 and 0 is honest and still generous: at the current rate the chain
        // reaches a gigabyte somewhere past its fifth year. Zero for both
        // would render as "At least 0 GB", which reads as a broken dialog
        // rather than as a small chain.
        m_assumed_blockchain_size = 1;
        m_assumed_chain_state_size = 0;

        // -------------------------------------------------------------------
        // Genesis
        // -------------------------------------------------------------------
        //
        // nTime  : 2026-09-15 00:00:00 UTC
        // nBits  : 0x1e0ffff0, matching powLimit above
        // nNonce : mined 2026-08-18 by genesis/genesis_generator.py, 1,258,094
        //          RandomX hashes against the key "WAM/RandomX/epoch-0/2026".
        //
        // The merkle root below is the one check that proves the premine is
        // what it claims to be: it commits to all five outputs and their
        // scripts, so a schedule that does not match this root cannot produce
        // this block. It changed from 51e7dd7b when the first tranche was
        // locked, which is how that change was verified rather than trusted.
        genesis = CreateGenesisBlock(
            /*nTime=*/   WAM_GENESIS_TIME,   // 2026-09-15 00:00:00 UTC
            /*nNonce=*/  1264205,                 // <-- genesis_generator.py
            /*nBits=*/   0x1e0ffff0,
            /*nVersion=*/1,
            /*genesisOutputs=*/ BuildGenesisOutputs(WAM_FOUNDER_ADDRESS_MAINNET));

        consensus.hashGenesisBlock = genesis.GetHash();

        assert(consensus.hashGenesisBlock == uint256S("0xd8d3debea987b62a0934c3980d62bffbb6e16aa797d19891d4fcc9b9fb11d7e9"));
        assert(genesis.hashMerkleRoot     == uint256S("0x230fc579dfbad4cec208c43392e3178760fcd74617e4ef22903eae7bf7fcff29"));

        // -------------------------------------------------------------------
        // Peer discovery
        // -------------------------------------------------------------------
        vSeeds.clear();
        vSeeds.emplace_back("seed1.wamcoin.org.");
        vSeeds.emplace_back("seed2.wamcoin.org.");
        vSeeds.emplace_back("seed3.wamcoin.org.");

        // Fixed seeds: what a node tries when DNS gives it nothing, or gives
        // it a lie.
        //
        // These were absent until 5 September 2026, which meant the three
        // names above were the ONLY way a new node could find this network.
        // Whoever could forge an answer for seed1.wamcoin.org decided who
        // every newcomer met -- without touching a block, a key or a rule.
        // The domain's transfer and delete locks were on; the zone was not
        // signed. That is one forged UDP packet away from a partitioned
        // network, and it is the cheapest attack this project had.
        //
        // Generated from contrib/seeds/nodes_main.txt by
        // contrib/seeds/generate-seeds.py. Only machines this project runs:
        // a fixed seed is compiled into every copy of the software and cannot
        // be withdrawn from the binaries already downloaded, so an
        // independent operator's address does not go here without their
        // explicit consent.
        vFixedSeeds = std::vector<uint8_t>(std::begin(chainparams_seed_main),
                                           std::end(chainparams_seed_main));

        // -------------------------------------------------------------------
        // Address encoding -- version bytes verified by brute force, not guessed.
        // Every 20-byte hash under version 73 encodes to a base58 string
        // beginning with 'W'; see scripts/gen_founder_key.py --selftest.
        // -------------------------------------------------------------------
        base58Prefixes[PUBKEY_ADDRESS] = std::vector<unsigned char>(1, 73);  // 'W'
        base58Prefixes[SCRIPT_ADDRESS] = std::vector<unsigned char>(1, 135); // 'w'
        base58Prefixes[SECRET_KEY]     = std::vector<unsigned char>(1, 190); // 'V' / '7'
        base58Prefixes[EXT_PUBLIC_KEY] = {0x04, 0x88, 0xB2, 0x1E};
        base58Prefixes[EXT_SECRET_KEY] = {0x04, 0x88, 0xAD, 0xE4};

        bech32_hrp = "wam";

        // ------------------------------------------------------------------
        // Checkpoints
        // ------------------------------------------------------------------
        //
        // Exactly one entry: the genesis block. This is NOT a trust claim --
        // the genesis hash is already hardcoded three lines above in an
        // assert(), so checkpointing it asserts nothing new.
        //
        // It has to be here because CCheckpointData::GetHeight() is
        //
        //     return mapCheckpoints.rbegin()->first;
        //
        // and rbegin() on an EMPTY std::map decrements the end sentinel, which
        // is undefined behaviour. An earlier revision left this map empty on
        // the reasoning that inventing checkpoints before the chain exists
        // would be theatre. That reasoning was right; leaving the map empty was
        // not. init.cpp calls Checkpoints().GetHeight() while building the
        // help text for -checkpoints, so wamd segfaulted before it printed a
        // single line -- including on `wamd --version`.
        //
        // Real checkpoints get added in a later release, from a chain that has
        // actually accumulated work.
        checkpointData = {
            {
                {0, consensus.hashGenesisBlock},
            }
        };

        fDefaultConsistencyChecks = false;
        m_is_mockable_chain = false;

        chainTxData = ChainTxData{
            .nTime = 0,
            .tx_count = 0,
            .dTxRate = 0,
        };
    }
};

/**
 * ===========================================================================
 *  TESTNET
 * ===========================================================================
 */
class CTestNetParams : public CChainParams
{
public:
    CTestNetParams()
    {
        m_chain_type = ChainType::TESTNET;

        consensus.nSubsidyHalvingInterval = WAM_SUBSIDY_HALVING_INTERVAL;
        consensus.nInitialSubsidy         = WAM_INITIAL_BLOCK_SUBSIDY;
        consensus.nGenesisPremine         = WAM_GENESIS_PREMINE;
        consensus.nMaxMoney               = WAM_MAX_MONEY;
        consensus.nDevFeePercent          = WAM_DEVFEE_PERCENT;
        consensus.nDevFeeStartHeight      = WAM_DEVFEE_START_HEIGHT;      // 1
        consensus.nDevFeeLastHeight       = WAM_DEVFEE_LAST_HEIGHT;       // 400,000 (sunset)
        consensus.devFeeAddress           = WAM_TREASURY_ADDRESS_TESTNET;
        consensus.nCoinbaseMaturity       = WAM_COINBASE_MATURITY;

        consensus.powLimit = uint256S("00000fffff000000000000000000000000000000000000000000000000000000");
        consensus.nPowTargetSpacing  = WAM_POW_TARGET_SPACING;
        consensus.nPowTargetTimespan = WAM_DGW_PAST_BLOCKS * WAM_POW_TARGET_SPACING;
        consensus.fPowAllowMinDifficultyBlocks = false;
        consensus.fPowNoRetargeting            = false;
        consensus.nDgwPastBlocks               = WAM_DGW_PAST_BLOCKS;

        // Short epochs on testnet so that the epoch-rollover path -- the single
        // most dangerous piece of the RandomX integration -- is exercised every
        // few hours instead of every few days.
        consensus.nRandomXEpochBlocks = 256;
        consensus.nRandomXEpochLag    = 16;

        consensus.BIP34Height = 1;
        consensus.BIP34Hash   = uint256();
        consensus.BIP65Height = 1;
        consensus.BIP66Height = 1;
        consensus.CSVHeight   = 1;
        consensus.SegwitHeight = 1;

        // BIP94, as upstream sets it for this network. See mainnet.
        consensus.enforce_BIP94 = false;
        consensus.MinBIP9WarningHeight = 0;
        consensus.nRuleChangeActivationThreshold = 1512;
        consensus.nMinerConfirmationWindow = 2016;

        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].bit = 28;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].nStartTime = Consensus::BIP9Deployment::NEVER_ACTIVE;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].nTimeout = Consensus::BIP9Deployment::NO_TIMEOUT;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].min_activation_height = 0;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].bit = 2;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].nStartTime = Consensus::BIP9Deployment::ALWAYS_ACTIVE;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].nTimeout = Consensus::BIP9Deployment::NO_TIMEOUT;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].min_activation_height = 0;

        // A floor under how much work a chain must carry before this node will
        // follow it at all.
        //
        // Zero means "follow whoever shows me the heaviest chain", and for a
        // young network that is not a theoretical weakness. On 6 September
        // 2026 this chain carried 6.63 billion hashes of work across 5,897
        // blocks. At the difficulty floor a block costs about 1.05 million
        // hashes, so ten ordinary desktops rebuild the entire history from
        // genesis in under a day -- and a node syncing for the first time
        // would follow that history instead of this one, because it is
        // heavier and nothing told the node otherwise.
        //
        // Set from block 5797, a hundred behind the tip when it was written,
        // so there is margin: a value above the real chain's work would stop
        // new nodes syncing the real chain, which is the way this setting
        // fails badly. check_min_chain_work.py compares both directions
        // against a running node.
        //
        // It is NOT a validity rule. A node with this value and a node with
        // zero accept exactly the same blocks; they differ only in which
        // chains they are willing to consider while syncing. No release
        // carrying it needs to be MANDATORY.
        consensus.nMinimumChainWork = uint256S("00000000000000000000000000000000000000000000000000000001852b0ce7");
        consensus.defaultAssumeValid = uint256{};

        pchMessageStart[0] = 0x77; // 'w'
        pchMessageStart[1] = 0x61; // 'a'
        pchMessageStart[2] = 0x6d; // 'm'
        pchMessageStart[3] = 0x21; // '!'
        nDefaultPort = WAM_TESTNET_P2P_PORT; // 19555

        nPruneAfterHeight = 1000;
        m_assumed_blockchain_size = 1;
        m_assumed_chain_state_size = 1;

        genesis = CreateGenesisBlock(
            /*nTime=*/   WAM_TESTNET_GENESIS_TIME,   // 2026-08-01, ahead of mainnet
            /*nNonce=*/  1851661,             // <-- genesis_generator.py --network testnet
            /*nBits=*/   0x1e0ffff0,
            /*nVersion=*/1,
            /*genesisOutputs=*/ BuildGenesisOutputs(WAM_FOUNDER_ADDRESS_TESTNET));

        consensus.hashGenesisBlock = genesis.GetHash();

        assert(consensus.hashGenesisBlock == uint256S("0xce81c20a59a9586946d46177317658575b9d1c1fc07912b5488ab76202f59bcb"));
        assert(genesis.hashMerkleRoot     == uint256S("0x1b04b1bd7be04b777c1a2371d7990a66592790ed78c02c6f5716e31f0ce147bd"));

        // Same reasoning as mainnet, and the test network is where a stranger
        // meets us first. Generated from contrib/seeds/nodes_test.txt.
        vFixedSeeds = std::vector<uint8_t>(std::begin(chainparams_seed_test),
                                           std::end(chainparams_seed_test));
        vSeeds.clear();
        vSeeds.emplace_back("testnet-seed.wamcoin.org.");

        base58Prefixes[PUBKEY_ADDRESS] = std::vector<unsigned char>(1, 65);  // 'T'
        base58Prefixes[SCRIPT_ADDRESS] = std::vector<unsigned char>(1, 128); // 't'
        base58Prefixes[SECRET_KEY]     = std::vector<unsigned char>(1, 239); // 'c'
        base58Prefixes[EXT_PUBLIC_KEY] = {0x04, 0x35, 0x87, 0xCF};
        base58Prefixes[EXT_SECRET_KEY] = {0x04, 0x35, 0x83, 0x94};

        bech32_hrp = "twam";

        // Genesis only -- see the comment in CMainParams. GetHeight() reads
        // rbegin(), so this map must never be empty.
        checkpointData = {
            {
                {0, consensus.hashGenesisBlock},
            }
        };

        fDefaultConsistencyChecks = false;
        m_is_mockable_chain = false;

        chainTxData = ChainTxData{0, 0, 0};
    }
};

/**
 * ===========================================================================
 *  REGTEST -- deterministic, instant-mining chain for the functional tests
 * ===========================================================================
 */
class CRegTestParams : public CChainParams
{
public:
    explicit CRegTestParams(const RegTestOptions& opts)
    {
        m_chain_type = ChainType::REGTEST;

        // A short halving interval keeps the emission tests fast while still
        // exercising the exact same code path as mainnet.
        //
        // Bitcoin Core v28's RegTestOptions carries only version_bits_parameters,
        // activation_heights and fastprune -- there is no configurable halving
        // interval to read from, so this is fixed here.
        consensus.nSubsidyHalvingInterval = 150;
        consensus.nInitialSubsidy         = WAM_INITIAL_BLOCK_SUBSIDY;
        consensus.nGenesisPremine         = WAM_GENESIS_PREMINE;
        consensus.nMaxMoney               = WAM_MAX_MONEY;
        consensus.nDevFeePercent          = WAM_DEVFEE_PERCENT;
        consensus.nDevFeeStartHeight      = WAM_DEVFEE_START_HEIGHT;      // 1
        consensus.nDevFeeLastHeight       = WAM_DEVFEE_LAST_HEIGHT;       // 400,000 (sunset)
        // A real, decodable address -- NOT an empty string.
        //
        // DevFeeScript() decodes this once and throws if it is not a valid WAM
        // address. An empty string therefore made every call throw, which broke
        // `getdevfeeinfo` outright and would have made CheckDevFeeOutput throw
        // while connecting any regtest block -- i.e. regtest mining could never
        // have worked. The original comment claimed "set by the test harness";
        // nothing set it.
        //
        // The testnet burn address (hash160 = 20 zero bytes) is used so regtest
        // exercises the identical code path as a live network while the coins
        // it pays are provably unspendable.
        consensus.devFeeAddress           = WAM_TREASURY_ADDRESS_TESTNET;
        consensus.nCoinbaseMaturity       = 100;

        consensus.powLimit = uint256S("7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        consensus.nPowTargetSpacing  = WAM_POW_TARGET_SPACING;
        consensus.nPowTargetTimespan = WAM_DGW_PAST_BLOCKS * WAM_POW_TARGET_SPACING;
        consensus.fPowAllowMinDifficultyBlocks = true;
        consensus.fPowNoRetargeting            = true;
        consensus.nDgwPastBlocks               = WAM_DGW_PAST_BLOCKS;
        consensus.nRandomXEpochBlocks          = 64;
        consensus.nRandomXEpochLag             = 4;

        consensus.BIP34Height = 1;
        consensus.BIP34Hash   = uint256();
        consensus.BIP65Height = 1;
        consensus.BIP66Height = 1;
        consensus.CSVHeight   = 1;
        consensus.SegwitHeight = 0;

        // BIP94, as upstream sets it for this network. See mainnet.
        consensus.enforce_BIP94 = true;
        consensus.MinBIP9WarningHeight = 0;
        consensus.nRuleChangeActivationThreshold = 108;
        consensus.nMinerConfirmationWindow = 144;

        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].bit = 28;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].nStartTime = 0;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].nTimeout = Consensus::BIP9Deployment::NO_TIMEOUT;
        consensus.vDeployments[Consensus::DEPLOYMENT_TESTDUMMY].min_activation_height = 0;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].bit = 2;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].nStartTime = Consensus::BIP9Deployment::ALWAYS_ACTIVE;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].nTimeout = Consensus::BIP9Deployment::NO_TIMEOUT;
        consensus.vDeployments[Consensus::DEPLOYMENT_TAPROOT].min_activation_height = 0;

        for (const auto& [dep, height] : opts.activation_heights) {
            switch (dep) {
            case Consensus::BuriedDeployment::DEPLOYMENT_SEGWIT: consensus.SegwitHeight = int{height}; break;
            case Consensus::BuriedDeployment::DEPLOYMENT_HEIGHTINCB: consensus.BIP34Height = int{height}; break;
            case Consensus::BuriedDeployment::DEPLOYMENT_DERSIG: consensus.BIP66Height = int{height}; break;
            case Consensus::BuriedDeployment::DEPLOYMENT_CLTV: consensus.BIP65Height = int{height}; break;
            case Consensus::BuriedDeployment::DEPLOYMENT_CSV: consensus.CSVHeight = int{height}; break;
            }
        }

        // Kept in parity with upstream: the functional test framework drives
        // deployment activation through -vbparams, and dropping this loop would
        // make those tests silently pass against unactivated rules.
        for (const auto& [deployment_pos, version_bits_params] : opts.version_bits_parameters) {
            consensus.vDeployments[deployment_pos].nStartTime = version_bits_params.start_time;
            consensus.vDeployments[deployment_pos].nTimeout = version_bits_params.timeout;
            consensus.vDeployments[deployment_pos].min_activation_height = version_bits_params.min_activation_height;
        }

        consensus.nMinimumChainWork = uint256{};
        consensus.defaultAssumeValid = uint256{};

        pchMessageStart[0] = 0x57;
        pchMessageStart[1] = 0x41;
        pchMessageStart[2] = 0x4d;
        pchMessageStart[3] = 0x52; // 'R'
        nDefaultPort = WAM_REGTEST_P2P_PORT; // 29555

        nPruneAfterHeight = opts.fastprune ? 100 : 1000;
        m_assumed_blockchain_size = 0;
        m_assumed_chain_state_size = 0;

        // regtest carries the SAME five vesting tranches as mainnet.
        //
        // An earlier version used a bare OP_TRUE output so functional tests
        // could spend the premine trivially. That was convenient and wrong:
        // the vesting scripts are the part of the premine most likely to be
        // broken, and the only chain fast enough to actually exercise them was
        // the one chain that did not use them.
        //
        // regtest shares testnet's address version byte (65), so a testnet
        // founder address works here unchanged -- which means the offline
        // signing ritual can be rehearsed with the real key on a chain that
        // mines in milliseconds. `setmocktime` then lets a test jump past an
        // unlock date and prove the lock RELEASES, not merely that it holds.
        genesis = CreateGenesisBlock(
            /*nTime=*/   WAM_REGTEST_GENESIS_TIME,   // 2011 -- safely in the past
            /*nNonce=*/  0,
            /*nBits=*/   0x207fffff,
            /*nVersion=*/1,
            /*genesisOutputs=*/ BuildGenesisOutputs(WAM_FOUNDER_ADDRESS_TESTNET));

        consensus.hashGenesisBlock = genesis.GetHash();

        assert(consensus.hashGenesisBlock == uint256S("0xb88f3d262f285e38e184f50bf3eea1c8e615486ae67d3d9eaf0976fbd6d3d30d"));
        assert(genesis.hashMerkleRoot     == uint256S("0x1b04b1bd7be04b777c1a2371d7990a66592790ed78c02c6f5716e31f0ce147bd"));

        vFixedSeeds.clear();
        vSeeds.clear();

        fDefaultConsistencyChecks = true;
        m_is_mockable_chain = true;

        base58Prefixes[PUBKEY_ADDRESS] = std::vector<unsigned char>(1, 65);
        base58Prefixes[SCRIPT_ADDRESS] = std::vector<unsigned char>(1, 128);
        base58Prefixes[SECRET_KEY]     = std::vector<unsigned char>(1, 239);
        base58Prefixes[EXT_PUBLIC_KEY] = {0x04, 0x35, 0x87, 0xCF};
        base58Prefixes[EXT_SECRET_KEY] = {0x04, 0x35, 0x83, 0x94};

        bech32_hrp = "wamrt";

        // Genesis only -- see the comment in CMainParams. GetHeight() reads
        // rbegin(), so this map must never be empty.
        checkpointData = {
            {
                {0, consensus.hashGenesisBlock},
            }
        };

        chainTxData = ChainTxData{0, 0, 0};
    }
};

std::unique_ptr<const CChainParams> CChainParams::RegTest(const RegTestOptions& options)
{
    return std::make_unique<const CRegTestParams>(options);
}

std::unique_ptr<const CChainParams> CChainParams::Main()
{
    return std::make_unique<const CMainParams>();
}

std::unique_ptr<const CChainParams> CChainParams::TestNet()
{
    return std::make_unique<const CTestNetParams>();
}

/**
 * ===========================================================================
 *  Networks WAM does not use
 * ===========================================================================
 *
 * Bitcoin Core v28 ships five networks: main, testnet3, testnet4, signet and
 * regtest. WAM uses three. The other two still need real definitions.
 *
 * An earlier revision made these throw, on the reasoning that a loud failure
 * beats silently placing an operator on the wrong chain. That was wrong, and
 * the unit tests caught it: SetupServerArgs() constructs EVERY chain type up
 * front in order to generate the help text for -port and -rpcport. Throwing
 * from here therefore did not merely reject `-signet` -- it aborted wamd
 * during argument setup, before it could parse a single option.
 *
 * The safe construction is a network that exists but is isolated: testnet's
 * parameters with a different P2P magic and port, and no seeds at all. A node
 * started with -signet or -testnet4 comes up on an empty network it cannot
 * confuse with any real one, because the differing magic makes the handshake
 * with a genuine WAM peer impossible.
 *
 * The genesis block is inherited unchanged from testnet, so its proof of work
 * is genuinely valid rather than a placeholder that would fail on first use.
 */
class CUnusedNetParams : public CTestNetParams
{
public:
    CUnusedNetParams(ChainType type, uint8_t magic_suffix, int port)
    {
        m_chain_type = type;

        // Same 'wam' prefix, distinct final byte: a peer on this network can
        // never complete a handshake with mainnet, testnet or regtest.
        pchMessageStart[3] = magic_suffix;
        nDefaultPort = port;

        // No discovery of any kind. These networks have no participants by
        // design, and pointing them at WAM's real seeds would be actively
        // harmful.
        vSeeds.clear();
        vFixedSeeds.clear();
    }
};

std::unique_ptr<const CChainParams> CChainParams::SigNet(const SigNetOptions& options)
{
    (void)options;   // WAM has no signet challenge to read
    return std::make_unique<const CUnusedNetParams>(ChainType::SIGNET, 0x53 /* 'S' */, 39555);
}

std::unique_ptr<const CChainParams> CChainParams::TestNet4()
{
    return std::make_unique<const CUnusedNetParams>(ChainType::TESTNET4, 0x34 /* '4' */, 49555);
}

/**
 * Snapshot (assumeutxo) heights. WAM ships none: an assumeutxo snapshot is a
 * hash of a UTXO set at a given height that the software asks users to trust,
 * and there is no honest way to publish one for a chain that has not run yet.
 * Returns empty until a release is cut from a real, long-lived chain.
 */
std::vector<int> CChainParams::GetAvailableSnapshotHeights() const
{
    std::vector<int> heights;
    heights.reserve(m_assumeutxo_data.size());
    for (const auto& data : m_assumeutxo_data) {
        heights.emplace_back(data.height);
    }
    return heights;
}

/**
 * Reverse-lookup of a network from its P2P message prefix.
 *
 * Deliberately checks only WAM's three networks. Upstream also probes
 * TestNet4() and SigNet(), which throw here -- and this function runs while
 * deserializing an untrusted UTXO snapshot header, where an exception would be
 * a denial-of-service rather than a diagnostic.
 */
std::optional<ChainType> GetNetworkForMagic(const MessageStartChars& message)
{
    const auto mainnet_msg = CChainParams::Main()->MessageStart();
    const auto testnet_msg = CChainParams::TestNet()->MessageStart();
    const auto regtest_msg = CChainParams::RegTest({})->MessageStart();

    if (std::equal(message.begin(), message.end(), mainnet_msg.data())) {
        return ChainType::MAIN;
    }
    if (std::equal(message.begin(), message.end(), testnet_msg.data())) {
        return ChainType::TESTNET;
    }
    if (std::equal(message.begin(), message.end(), regtest_msg.data())) {
        return ChainType::REGTEST;
    }
    return std::nullopt;
}
