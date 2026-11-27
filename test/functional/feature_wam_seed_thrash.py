#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""A branch we are not on must not evict the key of the chain we are.

WHAT THIS IS AND WHERE IT CAME FROM

The harness is Doms99's, sent with the report on 26 November 2026 and used
here with its measurements intact. What it showed, on a node built from
HEAD 568de66:

    baseline   8 honest headers, one seed:  1 cache initialisation,
               total 1.06 s, 702 ms for the first and 50-51 ms for the rest
    thrash     24 headers rotating three seeds: 24 initialisations,
               total 17.87 s, 745 ms average
    stall      a queued rotation of 24 processed in 15.07 s, and
               getblocktemplate against the busy node took 0.60 s where the
               idle node answers in 1 ms

THE MECHANISM, IN ONE LINE

A block's seed is a property of the BRANCH being verified --
GetRandomXSeedHash walks pindexPrev's ancestors to the seed-height block on
that branch -- so two competing blocks at an epoch-boundary height, both
forks extended past the lag, are two extra live seeds. The verification
cache held two entries on a plain LRU, so rotating three seeds evicted one
on every header, and each miss is a full randomx_init_cache inside
ContextualCheckBlockHeader with cs_main held.

WHAT THIS FILE ASSERTS NOW, WHICH IS NOT WHAT IT ASSERTED THEN

Doms99's version asserted that the thrash happens: 24 of 24 headers
initialising. That was the right assertion for a report and it is the wrong
one for a regression test, because it would now fail on the fixed code and
pass on the broken code.

The fix pins the two seeds the ACTIVE chain legitimately needs, so a branch
the node is not following cannot evict either. It does not make the
attacker's own headers cheap -- with both slots pinned a third seed is
verified and not cached -- and this file says so by measuring both:

    * the honest branch's headers, interleaved with two hostile branches,
      must stay cheap. Before the fix they cost a full initialisation each;
      that is the stall reaching the chain the node is actually following.
    * the hostile branches' headers are still expensive, and that is
      recorded rather than asserted away. Bounding what one peer can spend
      of our time is a separate change, and pretending otherwise here would
      hide it.

Nothing is run against mainnet. Two nodes on the loopback, regtest, and the
victim learns everything through one timed peer connection.
"""

import time
from io import BytesIO

from test_framework.messages import CBlockHeader, msg_headers
from test_framework.p2p import P2PInterface
from test_framework.test_framework import BitcoinTestFramework
from test_framework.util import assert_equal

# Three anyone-can-spend coinbases, one per branch, so the height-64 blocks
# -- and therefore the seeds their descendants verify against -- all differ.
DESC_HONEST = 'raw(51)#8lvh9jxk'
DESC_FORK_A = 'raw(52)#qu92mhx7'
DESC_FORK_B = 'raw(53)#6azp35xp'

EPOCH = 64          # regtest chainparams
LAG = 4             # regtest chainparams
SEED_BLOCK = 64     # the height the branches disagree at
FIRST_SEEDED = SEED_BLOCK + LAG   # 68: the first height keyed by block 64
TOP = 91


def parse_header(raw_hex):
    h = CBlockHeader()
    h.deserialize(BytesIO(bytes.fromhex(raw_hex)))
    h.rehash()
    return h


class WamSeedThrashTest(BitcoinTestFramework):
    def set_test_params(self):
        self.num_nodes = 2
        self.setup_clean_chain = True

    # -- helpers -----------------------------------------------------------

    def capture_headers(self, node, lo, hi):
        out = {}
        for height in range(lo, hi + 1):
            block_hash = node.getblockhash(height)
            out[height] = parse_header(node.getblockheader(block_hash, False))
        return out

    def mine_branch(self, node, descriptor, from_height, to_height):
        self.generatetodescriptor(
            node, to_height - from_height + 1, descriptor,
            sync_fun=self.no_op)

    def count_inits(self, node):
        with open(node.debug_log_path, encoding="utf-8") as f:
            return f.read().count("initialising verification context")

    def feed_one(self, peer, header):
        """Send one header and time until the victim has processed it.

        The pong is answered by the same message loop that processes the
        headers message ahead of it, so the round trip is the processing
        time of that header plus loopback noise in the milliseconds.
        """
        started = time.time()
        peer.send_and_ping(msg_headers([header]))
        return time.time() - started

    def gbt_latency(self, node):
        started = time.time()
        node.getblocktemplate({"rules": ["segwit"]})
        return time.time() - started

    # -- the test ----------------------------------------------------------

    def run_test(self):
        miner, victim = self.nodes

        self.log.info("phase 0: honest chain to %d, victim synced, then cut off",
                      FIRST_SEEDED - 1)
        self.mine_branch(miner, DESC_HONEST, 1, FIRST_SEEDED - 1)
        self.sync_blocks()
        assert_equal(victim.getblockcount(), FIRST_SEEDED - 1)
        self.disconnect_nodes(0, 1)

        self.log.info("phase 0b: three branches sharing 1..63, to height %d", TOP)
        self.mine_branch(miner, DESC_HONEST, FIRST_SEEDED, TOP)
        honest = self.capture_headers(miner, SEED_BLOCK, TOP)
        honest_64 = miner.getblockhash(SEED_BLOCK)

        miner.invalidateblock(honest_64)
        self.mine_branch(miner, DESC_FORK_A, SEED_BLOCK, TOP)
        fork_a = self.capture_headers(miner, SEED_BLOCK, TOP)
        fork_a_64 = miner.getblockhash(SEED_BLOCK)

        miner.invalidateblock(fork_a_64)
        self.mine_branch(miner, DESC_FORK_B, SEED_BLOCK, TOP)
        fork_b = self.capture_headers(miner, SEED_BLOCK, TOP)

        seeds = {fork_a[SEED_BLOCK].rehash(),
                 fork_b[SEED_BLOCK].rehash(),
                 honest[SEED_BLOCK].rehash()}
        assert_equal(len(seeds), 3)
        self.log.info("three distinct height-%d blocks -> three live seeds",
                      SEED_BLOCK)

        peer = victim.add_p2p_connection(P2PInterface())
        idle_gbt = sum(self.gbt_latency(victim) for _ in range(3)) / 3

        # ---- baseline: one seed, eight headers ---------------------------
        inits0 = self.count_inits(victim)
        base_times = [self.feed_one(peer, honest[h])
                      for h in range(FIRST_SEEDED, FIRST_SEEDED + 8)]
        base_inits = self.count_inits(victim) - inits0
        # The first header of the epoch builds the context; the rest are the
        # steady state, and the steady state is what "cheap" means.
        cached_cost = sum(base_times[1:]) / max(1, len(base_times) - 1)
        self.log.info("BASELINE 1 seed: %d init(s), cached header %.0f ms",
                      base_inits, cached_cost * 1000)

        # ---- the fork parents, under the bootstrap seed -------------------
        for h in range(SEED_BLOCK, FIRST_SEEDED):
            self.feed_one(peer, fork_a[h])
            self.feed_one(peer, fork_b[h])

        # ---- the rotation -------------------------------------------------
        honest_times, fork_times = [], []
        inits0 = self.count_inits(victim)
        for i in range(8):
            fork_times.append(self.feed_one(peer, fork_a[FIRST_SEEDED + i]))
            fork_times.append(self.feed_one(peer, fork_b[FIRST_SEEDED + i]))
            honest_times.append(
                self.feed_one(peer, honest[FIRST_SEEDED + 8 + i]))
        rot_inits = self.count_inits(victim) - inits0

        honest_avg = sum(honest_times) / len(honest_times)
        fork_avg = sum(fork_times) / len(fork_times)
        busy_gbt = self.gbt_latency(victim)

        print("\n================ WH-1 MEASUREMENTS ================")
        print(f"idle getblocktemplate                : {idle_gbt * 1000:.0f} ms")
        print(f"baseline, one seed, cached header    : {cached_cost * 1000:.0f} ms"
              f"  ({base_inits} init)")
        print(f"ROTATION, 8 honest headers           : {honest_avg * 1000:.0f} ms each")
        print(f"ROTATION, 16 fork headers            : {fork_avg * 1000:.0f} ms each")
        print(f"cache inits during the rotation      : {rot_inits} of 24 headers")
        print(f"getblocktemplate while busy          : {busy_gbt * 1000:.0f} ms")
        print("===================================================\n")

        # ---- what must be true --------------------------------------------
        #
        # The chain the node is FOLLOWING stays cheap while two branches it
        # is not following rotate against it. Before the fix every one of
        # these eight cost a full initialisation: 745 ms average, measured.
        # Three times the cached cost is a wide margin on a loaded machine
        # and still an order of magnitude below an initialisation.
        assert honest_avg < max(3 * cached_cost, 0.25), (
            f"the honest branch's headers cost {honest_avg * 1000:.0f} ms each "
            f"while two other branches rotated against them, against "
            f"{cached_cost * 1000:.0f} ms when nothing else was arriving. The "
            f"chain this node is following is being evicted by branches it is "
            f"not.")

        # At most one initialisation per honest header would already be the
        # old behaviour; the fix means none of them pay one.
        assert rot_inits <= 16, (
            f"{rot_inits} initialisations for 24 headers: the honest branch "
            f"is paying for initialisations too, so its seed is not pinned")

        # And the node still answers while it is being fed.
        assert busy_gbt < 5.0, (
            f"getblocktemplate took {busy_gbt:.2f} s during the rotation")

        self.log.info("the fork headers still cost %.0f ms each. That is the "
                      "part this fix does not address: bounding what one peer "
                      "can spend of our time is a separate change, and the "
                      "honest answer to it is to stop doing this work under "
                      "cs_main.", fork_avg * 1000)


if __name__ == "__main__":
    WamSeedThrashTest(__file__).main()
