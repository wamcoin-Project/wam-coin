// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  solo_template.h -- getblocktemplate into the job the workers already mine
// ===========================================================================
//
//  The miner's workers, and BuildHeader, take a StratumJob and know nothing
//  about where it came from. So solo mining is not a second mining path: it
//  is a second SOURCE for the same job. Nothing in the hot loop changes, and
//  the code that has produced every share since August is not touched.
//
//  That means building, here, exactly what a pool would have sent:
//
//      coinb1 | extranonce1 | extranonce2 | coinb2      the coinbase
//      merkleBranch                                     folded over its hash
//      version, prevHash, nbits, ntime                  the header fields
//
//  THE COINBASE IS THE PART CONSENSUS CHECKS
//
//  Rule WAM-1 rejects any block whose coinbase does not pay the treasury, so
//  a solo miner who builds his own coinbase can produce a block that is
//  perfectly formed, correctly hashed, and refused by every node on the
//  network. The layout below is a transcription of pool/lib/blockTemplate.js,
//  which has built the coinbase for every block this pool has found:
//
//      output 0   devfee.amount         to devfee.script
//      output 1   coinbasevalue - devfee.amount   to the miner
//      output 2   0                     the segwit commitment, verbatim
//
//  and coinbasevalue is the BIP22 total, fees included, out of which the
//  treasury is paid. Getting that backwards does not error: it silently
//  destroys 5% of every block.
// ===========================================================================

#pragma once

#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "address.h"
#include "json.h"
#include "sha256.h"
#include "stratum.h"
#include "util.h"

namespace wam {

/** A transaction as the template gives it: the bytes to put in the block. */
struct TemplateTx {
    Bytes                  data;      // raw, ready to serialise
    std::array<uint8_t,32> hash{};    // txid, little-endian (merkle order)
};

/** Everything solo mining needs that a StratumJob has no place for. */
struct SoloTemplate {
    StratumJob              job;
    std::vector<TemplateTx> txs;
    int64_t                 coinbaseValue = 0;
    int64_t                 devFeeAmount  = 0;
    std::string             longPollId;
    std::string             prevHashHex;    // as the node states it
};

/**
 * Is this the same work, or only the same moment?
 *
 * A solo miner polls getblocktemplate every few seconds and the node answers
 * every time, whether or not anything changed. Treating each answer as a new
 * job costs a block: the job a worker is hashing goes out of scope while the
 * worker is still on it, and the transactions it was built from are forgotten
 * with it, so a solution that arrives later cannot be turned into a block.
 *
 * That is not theory. On 2026-09-26 a miner solved height 7838 ninety-nine
 * seconds after starting, and this miner refused to send it -- "job 7838.9 is
 * no longer held". Eight job ids had been minted in the meantime out of
 * templates that were byte-for-byte the same work.
 *
 * So the comparison is of the work, not of the reply. Everything that reaches
 * the eighty-byte header or the block body is compared:
 *
 *   prevHash, height   a different chain tip is different work, always
 *   version, nbits     both go in the header
 *   seed               the RandomX key; a new epoch is entirely new work
 *   coinb1, coinb2     the coinbase, which carries the treasury output and
 *                      the witness commitment
 *   merkleBranch, txs  the body, and the merkle root over it
 *
 * ntime is deliberately NOT compared. The node advances it on every call, and
 * it is the one header field a miner may hold or roll on its own: a block is
 * valid while its ntime is above the median of the last eleven and not more
 * than two hours ahead. Comparing it would make every single poll "new work"
 * again, which is the bug this function exists to end.
 *
 * longPollId is not compared either: it identifies the reply, not the work.
 */
inline bool SameWork(const SoloTemplate& a, const SoloTemplate& b)
{
    if (a.prevHashHex   != b.prevHashHex)   return false;
    if (a.job.height    != b.job.height)    return false;
    if (a.job.version   != b.job.version)   return false;
    if (a.job.nbits     != b.job.nbits)     return false;
    if (a.job.seed      != b.job.seed)      return false;
    if (a.job.coinb1    != b.job.coinb1)    return false;
    if (a.job.coinb2    != b.job.coinb2)    return false;
    if (a.job.merkleBranch.size() != b.job.merkleBranch.size()) return false;
    for (size_t i = 0; i < a.job.merkleBranch.size(); i++) {
        if (a.job.merkleBranch[i] != b.job.merkleBranch[i]) return false;
    }
    if (a.txs.size() != b.txs.size()) return false;
    for (size_t i = 0; i < a.txs.size(); i++) {
        if (a.txs[i].hash != b.txs[i].hash) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// small serialisation helpers
// ---------------------------------------------------------------------------

inline void PutLE32(Bytes& b, uint32_t v)
{
    b.push_back(uint8_t(v)); b.push_back(uint8_t(v >> 8));
    b.push_back(uint8_t(v >> 16)); b.push_back(uint8_t(v >> 24));
}

inline void PutLE64(Bytes& b, uint64_t v)
{
    for (int i = 0; i < 8; i++) b.push_back(uint8_t(v >> (8 * i)));
}

inline void PutVarInt(Bytes& b, uint64_t v)
{
    if (v < 0xfd) { b.push_back(uint8_t(v)); return; }
    if (v <= 0xffff) { b.push_back(0xfd); b.push_back(uint8_t(v)); b.push_back(uint8_t(v >> 8)); return; }
    if (v <= 0xffffffffull) { b.push_back(0xfe); PutLE32(b, uint32_t(v)); return; }
    b.push_back(0xff); PutLE64(b, v);
}

inline Bytes FromHex(const std::string& hex)
{
    if (hex.size() % 2) throw std::runtime_error("hex string has an odd length");
    Bytes out;
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        auto nib = [&](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            throw std::runtime_error("'" + std::string(1, c) + "' is not hex");
        };
        out.push_back(uint8_t((nib(hex[i]) << 4) | nib(hex[i + 1])));
    }
    return out;
}

/**
 * BIP34's height, encoded exactly as `CScript() << nHeight` encodes it.
 *
 * Consensus does not compare the height as a number: it builds that script
 * and compares BYTES against the front of the coinbase scriptSig. So this has
 * to match CScript::push_int64, including its two special cases -- which a
 * minimal data push alone does not:
 *
 *     0            OP_0            0x00
 *     1 .. 16      OP_1 .. OP_16   0x51 .. 0x60
 *     17 and up    a data push, little-endian, with a sign byte if the top
 *                  bit is set
 *
 * Written first without the small cases, it passed a proposal on mainnet at
 * height 3351 and was refused on a fresh regtest chain at height 1 with
 * `bad-cb-height`. The bug could only ever appear on the first sixteen blocks
 * of a chain -- which is exactly when nobody is watching.
 */
inline Bytes HeightPush(int64_t height)
{
    Bytes out;
    if (height == 0) { out.push_back(0x00); return out; }            // OP_0
    if (height >= 1 && height <= 16) {
        out.push_back(uint8_t(0x50 + height));                       // OP_N
        return out;
    }

    Bytes n;
    int64_t v = height;
    while (v) { n.push_back(uint8_t(v & 0xff)); v >>= 8; }
    // A high bit would read as negative, so CScriptNum appends a sign byte.
    if (n.back() & 0x80) n.push_back(0x00);

    out.push_back(uint8_t(n.size()));
    out.insert(out.end(), n.begin(), n.end());
    return out;
}

/**
 * The merkle branch for the coinbase, which sits in the implicit slot 0.
 * Transcribed from buildMerkleBranch() in pool/lib/util.js.
 */
inline std::vector<std::array<uint8_t,32>>
BuildMerkleBranch(const std::vector<TemplateTx>& txs)
{
    std::vector<std::array<uint8_t,32>> branch;
    std::vector<std::array<uint8_t,32>> layer;
    layer.reserve(txs.size());
    for (const TemplateTx& t : txs) layer.push_back(t.hash);

    while (!layer.empty()) {
        branch.push_back(layer[0]);
        if (layer.size() == 1) break;
        std::vector<std::array<uint8_t,32>> next;
        // The coinbase owns slot 0, so pairing starts at 1.
        for (size_t i = 1; i < layer.size(); i += 2) {
            const std::array<uint8_t,32>& right =
                (i + 1 < layer.size()) ? layer[i + 1] : layer[i];
            std::array<uint8_t,32> parent{};
            SHA256dPair(layer[i].data(), right.data(), parent.data());
            next.push_back(parent);
        }
        layer.swap(next);
    }
    return branch;
}

/**
 * Turn one getblocktemplate reply into a job the existing workers can mine.
 *
 * `signature` goes in the coinbase scriptSig after the height, the way a pool
 * puts its own name there. Consensus caps the whole scriptSig at 100 bytes.
 */
inline SoloTemplate BuildSoloTemplate(const json::Value& t,
                                      const std::string& address,
                                      const NetAddressParams& net,
                                      const std::string& signature,
                                      const Bytes& extranonce1,
                                      int extranonce2Size)
{
    SoloTemplate out;

    out.coinbaseValue = int64_t(t["coinbasevalue"].AsNumber());
    out.longPollId    = t["longpollid"].AsString();
    out.prevHashHex   = t["previousblockhash"].AsString();

    const json::Value& df = t["devfee"];
    if (df.IsNull()) {
        throw std::runtime_error(
            "getblocktemplate returned no `devfee` field. This node is not a "
            "WAM node, or is older than the treasury rule. A coinbase without "
            "the treasury output is rejected by consensus with "
            "bad-cb-devfee-amount, so every block built from it would be "
            "wasted.");
    }
    out.devFeeAmount = int64_t(df["amount"].AsNumber());
    const Bytes devScript = FromHex(df["script"].AsString());

    if (out.devFeeAmount < 0 || out.devFeeAmount >= out.coinbaseValue) {
        throw std::runtime_error("the node reported a nonsensical treasury amount");
    }

    // ---- transactions ----------------------------------------------------
    const json::Value& txs = t["transactions"];
    int64_t totalFees = 0;
    bool feesKnown = true;
    for (size_t i = 0; i < txs.Size(); i++) {
        const json::Value& tx = txs.At(i);
        TemplateTx entry;
        entry.data = FromHex(tx["data"].AsString());

        // GBT states txids big-endian; the merkle tree works little-endian.
        const std::string idHex = tx["txid"].IsString() ? tx["txid"].AsString()
                                                        : tx["hash"].AsString();
        const Bytes id = FromHex(idHex);
        if (id.size() != 32) throw std::runtime_error("a template txid was not 32 bytes");
        for (size_t k = 0; k < 32; k++) entry.hash[k] = id[31 - k];

        const json::Value& fee = tx["fee"];
        if (fee.IsNull()) feesKnown = false; else totalFees += int64_t(fee.AsNumber());

        out.txs.push_back(std::move(entry));
    }

    // ---- the invariant that catches a daemon reporting the wrong total ----
    //
    // The treasury is a fixed share of the SUBSIDY, and the subsidy is
    // coinbasevalue minus the fees. If a node instead reported the miner's
    // share as coinbasevalue, subtracting the treasury here would subtract it
    // twice and quietly destroy 5% of every block -- with nothing erroring
    // and nothing looking wrong.
    if (feesKnown) {
        const int64_t subsidy  = out.coinbaseValue - totalFees;
        const int64_t expected = (subsidy * 5) / 100;
        if (out.devFeeAmount != expected) {
            throw std::runtime_error(
                "the treasury output does not match the block reward: "
                "coinbasevalue " + std::to_string(out.coinbaseValue) +
                ", fees " + std::to_string(totalFees) +
                ", so 5% of the subsidy is " + std::to_string(expected) +
                " but the node says " + std::to_string(out.devFeeAmount) +
                ". Refusing to build a coinbase on that.");
        }
    }

    // ---- outputs ---------------------------------------------------------
    const Bytes minerScript = AddressToScript(address, net);
    const int64_t minerValue = out.coinbaseValue - out.devFeeAmount;

    Bytes outputs;
    size_t nOutputs = 2;

    Bytes body;
    PutLE64(body, uint64_t(out.devFeeAmount));      // 0: treasury, first so it is
    PutVarInt(body, devScript.size());              //    trivial to audit
    body.insert(body.end(), devScript.begin(), devScript.end());

    PutLE64(body, uint64_t(minerValue));            // 1: the miner
    PutVarInt(body, minerScript.size());
    body.insert(body.end(), minerScript.begin(), minerScript.end());

    const std::string wc = t["default_witness_commitment"].AsString();
    if (!wc.empty()) {                              // 2: verbatim from the node
        const Bytes commitment = FromHex(wc);
        PutLE64(body, 0);
        PutVarInt(body, commitment.size());
        body.insert(body.end(), commitment.begin(), commitment.end());
        nOutputs = 3;
    }
    PutVarInt(outputs, nOutputs);
    outputs.insert(outputs.end(), body.begin(), body.end());

    // ---- scriptSig: height, then the signature, then the extranonce ------
    const int64_t height = int64_t(t["height"].AsNumber());
    const Bytes heightPush = HeightPush(height);

    Bytes sigPush;
    if (!signature.empty()) {
        if (signature.size() > 60) throw std::runtime_error("the coinbase signature is too long");
        sigPush.push_back(uint8_t(signature.size()));
        sigPush.insert(sigPush.end(), signature.begin(), signature.end());
    }

    const size_t scriptSigLen = heightPush.size() + sigPush.size() +
                                extranonce1.size() + size_t(extranonce2Size);
    if (scriptSigLen > 100) {
        throw std::runtime_error("the coinbase scriptSig would be " +
                                 std::to_string(scriptSigLen) +
                                 " bytes; consensus caps it at 100");
    }

    StratumJob& job = out.job;
    job.jobId = std::to_string(height);

    PutLE32(job.coinb1, 1);                          // tx version
    job.coinb1.push_back(0x01);                      // one input
    job.coinb1.insert(job.coinb1.end(), 32, 0x00);   // null prevout hash
    for (int i = 0; i < 4; i++) job.coinb1.push_back(0xff);
    PutVarInt(job.coinb1, scriptSigLen);
    job.coinb1.insert(job.coinb1.end(), heightPush.begin(), heightPush.end());
    job.coinb1.insert(job.coinb1.end(), sigPush.begin(), sigPush.end());
    // extranonce1 + extranonce2 are spliced in here by BuildHeader

    for (int i = 0; i < 4; i++) job.coinb2.push_back(0xff);   // nSequence
    job.coinb2.insert(job.coinb2.end(), outputs.begin(), outputs.end());
    job.coinb2.insert(job.coinb2.end(), 4, 0x00);             // nLockTime

    job.merkleBranch = BuildMerkleBranch(out.txs);

    // ---- header fields ---------------------------------------------------
    const Bytes prev = FromHex(out.prevHashHex);
    if (prev.size() != 32) throw std::runtime_error("previousblockhash was not 32 bytes");
    for (size_t i = 0; i < 32; i++) job.prevHash[i] = prev[31 - i];

    job.version = uint32_t(t["version"].AsNumber());
    job.ntime   = uint32_t(t["curtime"].AsNumber());
    const Bytes nbits = FromHex(t["bits"].AsString());
    if (nbits.size() != 4) throw std::runtime_error("bits was not four bytes");
    job.nbits = (uint32_t(nbits[0]) << 24) | (uint32_t(nbits[1]) << 16) |
                (uint32_t(nbits[2]) << 8)  |  uint32_t(nbits[3]);

    // THE SEED ARRIVES REVERSED, and the two wires disagree about it.
    //
    // getblocktemplate renders randomx_seedhash the way a uint256 prints --
    // big-endian, the order a block hash is quoted in. RandomX is keyed with
    // the internal bytes, which are the other way round. Stratum does not have
    // this problem: mining.set_seedhash carries the key itself, already in
    // internal order, so the pool path takes it verbatim and this path must
    // not.
    //
    // Taking the RPC value as it comes keys every VM with a seed nobody else
    // uses. Nothing complains: the miner hashes, finds what looks like a
    // solution, and the node answers high-hash -- so it reads as bad luck, and
    // on a chain with real difficulty it would read as a machine that simply
    // never finds anything. It cost an evening here, on a regtest chain whose
    // target is half the hash space, where a wrong key still lands a block
    // every other attempt and the failures looked intermittent.
    //
    // pool/lib/jobManager.js says the same thing in its own comment and has
    // reversed it since August.
    Bytes seedWire = FromHex(t["randomx_seedhash"].AsString());
    if (seedWire.size() != 32) {
        throw std::runtime_error(
            "getblocktemplate returned no randomx_seedhash. Without it the "
            "miner cannot know which RandomX key this height needs, and every "
            "hash would be computed against the wrong one.");
    }
    job.seed.assign(seedWire.rbegin(), seedWire.rend());

    job.extranonce1     = extranonce1;
    job.extranonce2Size = extranonce2Size;
    job.height          = height;
    job.cleanJobs       = true;
    job.valid           = true;

    return out;
}

/**
 * The full block, ready for submitblock or for a proposal.
 *
 * `coinbase` is coinb1|extranonce1|extranonce2|coinb2, the same bytes whose
 * hash went into the merkle root -- it must be, or the root will not match
 * the header that was hashed.
 */
inline Bytes SerializeBlock(const uint8_t header[80], const Bytes& coinbase,
                            const std::vector<TemplateTx>& txs)
{
    Bytes block(header, header + 80);
    PutVarInt(block, txs.size() + 1);
    block.insert(block.end(), coinbase.begin(), coinbase.end());
    for (const TemplateTx& t : txs) {
        block.insert(block.end(), t.data.begin(), t.data.end());
    }
    return block;
}

/**
 * The coinbase as the BLOCK must carry it, which is not the form its hash is
 * taken over.
 *
 * A coinbase that pays a witness commitment must itself carry a witness: one
 * stack item of 32 zero bytes, the "witness reserved value". Without it the
 * node answers `bad-witness-nonce-size` and refuses the block -- measured,
 * not assumed: the first block this miner ever proposed was rejected with
 * exactly that, which is what a proposal is for.
 *
 * But the merkle leaf is the TXID, and a txid is the hash of the transaction
 * WITHOUT its witness. So the two forms are both needed and must not be
 * confused:
 *
 *     SerializeCoinbase()             hashed into the merkle root
 *     SerializeCoinbaseWithWitness()  placed in the block
 *
 * Swapping them gives a block whose merkle root does not match its own
 * coinbase, which no amount of hashing can fix.
 *
 * Segwit serialisation puts the marker and flag after the version, and the
 * witness stack between the outputs and the locktime.
 */
inline Bytes SerializeCoinbaseWithWitness(const StratumJob& job,
                                          const Bytes& extranonce2)
{
    if (job.coinb1.size() < 4 || job.coinb2.size() < 4) {
        throw std::runtime_error("the coinbase halves are too short to be real");
    }

    Bytes cb;
    cb.insert(cb.end(), job.coinb1.begin(), job.coinb1.begin() + 4);   // version
    cb.push_back(0x00);                                                // marker
    cb.push_back(0x01);                                                // flag
    cb.insert(cb.end(), job.coinb1.begin() + 4, job.coinb1.end());
    cb.insert(cb.end(), job.extranonce1.begin(), job.extranonce1.end());
    cb.insert(cb.end(), extranonce2.begin(), extranonce2.end());

    // coinb2 is nSequence | outputs | locktime; the witness goes before the
    // locktime, which is its last four bytes.
    cb.insert(cb.end(), job.coinb2.begin(), job.coinb2.end() - 4);

    cb.push_back(0x01);                     // one stack item
    cb.push_back(0x20);                     // of 32 bytes
    cb.insert(cb.end(), 32, 0x00);          // the reserved value

    cb.insert(cb.end(), job.coinb2.end() - 4, job.coinb2.end());       // locktime
    return cb;
}

/** coinb1 | extranonce1 | extranonce2 | coinb2 -- the form the merkle root uses */
inline Bytes SerializeCoinbase(const StratumJob& job, const Bytes& extranonce2)
{
    Bytes cb;
    cb.reserve(job.coinb1.size() + job.extranonce1.size() +
               extranonce2.size() + job.coinb2.size());
    cb.insert(cb.end(), job.coinb1.begin(), job.coinb1.end());
    cb.insert(cb.end(), job.extranonce1.begin(), job.extranonce1.end());
    cb.insert(cb.end(), extranonce2.begin(), extranonce2.end());
    cb.insert(cb.end(), job.coinb2.begin(), job.coinb2.end());
    return cb;
}

}   // namespace wam
