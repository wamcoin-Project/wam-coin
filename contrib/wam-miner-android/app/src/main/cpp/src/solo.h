// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  solo.h -- mine for yourself, against your own node
// ===========================================================================
//
//      wam-miner --solo --rpc 127.0.0.1:9554 -u <your address> -t 4
//
//  WHY THIS EXISTS
//
//  Until 19 September 2026 mining alone on this chain meant running the pool
//  software for one person: Redis, a native RandomX addon, node-gyp, and a
//  guide written for somebody serving other people. On Linux that is an
//  evening's work. On Windows it is not practical at all.
//
//  Meanwhile the project's own mining guide says -- correctly -- that a solo
//  miner helps this chain more than joining any pool does, because every solo
//  miner is a distinct finder and a pool is one finder however many people
//  stand behind it. Advice nobody can follow is not advice.
//
//  WHAT IT DOES AND DOES NOT DO
//
//  It replaces the pool, not the miner. The same workers hash the same jobs
//  through the same BuildHeader; only the source of work and the destination
//  of a solution change. There is no share difficulty here and nothing is
//  submitted until a hash meets the BLOCK target -- alone, a share is worth
//  nothing to anybody.
//
//  It polls rather than long-polls. getblocktemplate is cheap against a local
//  node, a stale template costs at most one block interval, and long-polling
//  would mean a second connection whose failure mode is silence.
// ===========================================================================

#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>
#include <deque>
#include <fstream>
#include <mutex>
#include <random>
#include <string>
#include <utility>

#include "rpc.h"
#include "solo_template.h"
#include "util.h"

namespace wam {

class SoloSession {
public:
    SoloSession(RpcClient& rpc, std::string address, NetAddressParams net,
                std::string signature)
        : m_rpc(rpc), m_address(std::move(address)), m_net(std::move(net)),
          m_signature(std::move(signature))
    {
        // extranonce1 is this session's own, the way a pool would assign one:
        // it separates two miners paying the same address from each other.
        std::random_device rd;
        for (int i = 0; i < 4; i++) m_extranonce1.push_back(uint8_t(rd()));
    }

    /** Called when a new template should be fetched. Returns false on error. */
    bool Refresh(std::string& error)
    {
        try {
            const json::Value t =
                m_rpc.Call("getblocktemplate", "[{\"rules\":[\"segwit\"]}]");
            SoloTemplate st = BuildSoloTemplate(t, m_address, m_net, m_signature,
                                                m_extranonce1, 4);
            const bool isNew = st.prevHashHex != m_current.prevHashHex ||
                               st.job.height  != m_current.job.height;

            // A NEW ID ONLY FOR NEW WORK, AND A JOB IS KEPT WHILE IT CAN
            // STILL BE MINED.
            //
            // Two templates at the same height can carry different
            // transactions, so a worker solving the older one must be given
            // the transactions THAT job promised -- hence ids at all. But the
            // node answers every poll whether or not anything moved, and
            // minting an id per reply meant a job that no worker had finished
            // was already being forgotten.
            //
            // What that cost, on 2026-09-26: a miner solved height 7838
            // ninety-nine seconds after starting and this code refused to send
            // the block, because the job it had been hashing was one of eight
            // that had scrolled out of a deque bounded by COUNT. The poll is
            // five seconds, so the memory was forty seconds; a worker holds a
            // job until the tip moves, which is two minutes. Roughly two
            // blocks in three were unsendable, on the feature this release was
            // built for.
            //
            // So: an unchanged template keeps the id it already has and adds
            // nothing, and what is retained is bounded by RELEVANCE instead --
            // every job for the current tip, plus the one before it. Jobs for
            // an older tip are dropped because they cannot be mined any more:
            // a block on a grandparent is not a competitor, it is nothing. The
            // previous tip is kept because a block solved against it moments
            // after the tip moved IS a competitor at the same height, and has
            // won races before.
            if (m_haveTemplate && SameWork(st, m_current)) {
                st.job.jobId = m_current.job.jobId;
            } else {
                st.job.jobId = std::to_string(st.job.height) + "." +
                               std::to_string(++m_serial);
                std::lock_guard<std::mutex> lock(m_mutex);
                m_issued.push_back({st.job.jobId, st.prevHashHex, st.txs});
                if (st.prevHashHex != m_prevTipHex) {
                    // The tip moved. What was current is now the generation
                    // behind it, and anything older than that goes.
                    const std::string grandparent = m_olderTipHex;
                    m_olderTipHex = m_prevTipHex;
                    m_prevTipHex  = st.prevHashHex;
                    if (!grandparent.empty()) {
                        for (auto it = m_issued.begin(); it != m_issued.end(); ) {
                            it = (it->prevHashHex != m_prevTipHex &&
                                  it->prevHashHex != m_olderTipHex)
                                 ? m_issued.erase(it) : it + 1;
                        }
                    }
                }
                // A backstop, not the policy. Two generations of an idle
                // chain is a handful of entries; this only ever fires if a
                // mempool churns hard enough to mint thousands of templates
                // between blocks, and it drops the oldest, which is the least
                // likely to still be under a worker.
                while (m_issued.size() > 4096) m_issued.pop_front();
            }

            m_current = std::move(st);
            m_haveTemplate = true;
            m_isNew = isNew;
            return true;
        } catch (const std::exception& e) {
            error = e.what();
            return false;
        }
    }

    bool HaveTemplate() const { return m_haveTemplate; }

    /**
     * Can a solution for this job still be turned into a block?
     *
     * Submit() answers this implicitly by throwing, which is the wrong moment
     * to find out: by then the proof of work exists and is about to be
     * discarded. Exposed so it can be asserted in a test instead of being
     * discovered by a miner losing a block.
     */
    bool KnowsJob(const std::string& jobId) const
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        for (const auto& e : m_issued) if (e.jobId == jobId) return true;
        return false;
    }

    /** How many jobs are still submittable. For tests and diagnostics. */
    size_t IssuedCount() const
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_issued.size();
    }
    bool WasNew() const { return m_isNew; }
    const SoloTemplate& Current() const { return m_current; }

    /**
     * Build a block from the current template and ask the node whether it is
     * valid -- without hashing anything.
     *
     * getblocktemplate in proposal mode checks everything a block is judged
     * on EXCEPT its proof of work: the coinbase, the treasury output, the
     * witness commitment, the merkle root, the transactions, the height, the
     * timestamps. So it answers the question a solo miner actually has before
     * committing a machine to a chain for hours -- "when I do find a block,
     * will it be accepted?" -- in about a second, and separately from whether
     * the hashing works.
     *
     * A null answer means valid. Anything else is the node's own word for
     * what is wrong.
     */
    std::string Propose(std::string* blockHexOut = nullptr)
    {
        if (!m_haveTemplate) throw std::runtime_error("there is no template to check");

        const StratumJob& job = m_current.job;
        Bytes en2(size_t(job.extranonce2Size), 0);

        uint8_t header[80];
        BuildHeader(job, en2, header);
        WriteLE32(header + 76, 0);          // no proof of work is being claimed

        const Bytes coinbase = SerializeCoinbaseWithWitness(job, en2);
        const Bytes block    = SerializeBlock(header, coinbase, m_current.txs);
        const std::string hex = ToHex(block);
        if (blockHexOut) *blockHexOut = hex;

        const json::Value r = m_rpc.Call(
            "getblocktemplate",
            "[{\"mode\":\"proposal\",\"rules\":[\"segwit\"],\"data\":\"" + hex + "\"}]");
        return r.IsNull() ? std::string() : r.AsString("rejected");
    }

    /**
     * Hand a solved block to the node.
     *
     * `job` is the job the worker actually hashed, which may be older than
     * the template held here if a new block arrived mid-hash. It carries
     * everything the block needs, so it is used rather than m_current: a
     * block built from a different template than the one that was hashed
     * would have a merkle root that does not match its own header.
     *
     * The transactions are looked up by the job's own id for the same reason.
     * Reaching for the CURRENT template's transactions instead builds a block
     * whose body does not match the merkle root in its header -- rare, since
     * it needs the mempool to move between handing out the job and solving
     * it, and silent when it is not rare enough.
     *
     * `blockHexOut` receives the exact bytes sent, whatever the answer. A
     * rejected block is a solved block thrown away; keeping what was sent is
     * the difference between diagnosing it and guessing.
     */
    std::string Submit(const StratumJob& job, const Bytes& extranonce2,
                       uint32_t nonce, const uint8_t hashedHeader[80],
                       std::string* blockHexOut = nullptr)
    {
        std::vector<TemplateTx> txs;
        bool known = false;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            for (const auto& e : m_issued) {
                if (e.jobId == job.jobId) { txs = e.txs; known = true; break; }
            }
        }
        if (!known) {
            throw std::runtime_error(
                "job " + job.jobId + " is no longer held, so the transactions "
                "it was built from are unknown. The block is not sent rather "
                "than sent wrong.");
        }

        uint8_t header[80];
        BuildHeader(job, extranonce2, header);
        WriteLE32(header + 76, nonce);

        // The header is rebuilt here rather than carried, because the block
        // needs the coinbase rebuilt anyway and the two must agree. Rebuilding
        // is only safe if it reproduces the bytes the worker hashed, so that
        // is checked rather than assumed: if they differ, the proof of work
        // belongs to a header nobody will ever see, and the node will refuse
        // the block with a message about the hash being too high -- which
        // sends whoever reads it looking in entirely the wrong place.
        if (hashedHeader && std::memcmp(header, hashedHeader, 80) != 0) {
            throw std::runtime_error(
                "the block does not match the work. The eighty bytes that were "
                "hashed are\n    " + ToHex(hashedHeader, 80) +
                "\nand rebuilding them from the same job gave\n    " +
                ToHex(header, 80) +
                "\nThe block is not sent: its proof of work is for the first "
                "header and it carries the second.");
        }

        const Bytes coinbase = SerializeCoinbaseWithWitness(job, extranonce2);
        const Bytes block    = SerializeBlock(header, coinbase, txs);
        const std::string hex = ToHex(block);
        if (blockHexOut) *blockHexOut = hex;

        const json::Value r = m_rpc.Call("submitblock", "[\"" + hex + "\"]");

        // submitblock answers null when the block is accepted and a reason
        // when it is not. Both arrive down the same channel, which is why the
        // null is checked rather than assumed.
        return r.IsNull() ? std::string() : r.AsString("rejected");
    }

private:
    RpcClient&        m_rpc;
    std::string       m_address;
    NetAddressParams  m_net;
    std::string       m_signature;
    Bytes             m_extranonce1;

    SoloTemplate m_current;
    bool         m_haveTemplate = false;
    bool         m_isNew        = false;

    // Workers submit from their own threads, so the issued list is shared.
    //
    // The tip each job was built on is kept beside it, because what decides
    // whether a job is still worth remembering is whether it can still become
    // a block -- not how many templates have arrived since.
    struct IssuedJob {
        std::string             jobId;
        std::string             prevHashHex;
        std::vector<TemplateTx> txs;
    };
    mutable std::mutex m_mutex;
    std::deque<IssuedJob> m_issued;
    std::string m_prevTipHex;    // tip the newest job was built on
    std::string m_olderTipHex;   // the one before it, still submittable
    uint64_t m_serial = 0;
};

}   // namespace wam
