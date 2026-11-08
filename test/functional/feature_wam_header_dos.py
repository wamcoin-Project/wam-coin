#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""A punished address buys no more proof-of-work verification.

WHAT THIS GUARDS
----------------
Verifying one header costs WAM about twenty milliseconds of RandomX, with
cs_main held, against the microsecond a double-SHA256 costs Bitcoin. Forging
a header that reaches that check costs nothing: the parent is our own tip,
which is public, and nBits is GetNextWorkRequired, which anybody can compute.

The node does punish -- a failed proof of work is BLOCK_INVALID_HEADER, which
is Misbehaving, which discourages the address. What it did not do was stop
SPENDING on an address it had already punished, because CConnman accepts a
discouraged peer's next connection whenever the inbound slots are not nearly
full. Upstream means that leniency and it costs upstream a microsecond. It
cost us the whole defence: reconnect, send another 90-byte header, buy
another twenty milliseconds, without limit.

Reported by bobbyning on 8 November 2026, measured on an isolated regtest
instance at 725 headers in fifteen seconds with one core at 95 per cent.

WHY THIS TEST DOES NOT USE 127.0.0.1
------------------------------------
Every peer in the functional framework connects over the loopback, and
MaybeDiscourageAndDisconnect refuses to discourage a local address -- it
disconnects and logs "disconnecting but not discouraging". So a test that
needs a peer to BE discouraged cannot use the loopback at all, and a test
written on it would pass against the unfixed node for the wrong reason.

It uses this machine's ordinary address instead. Test nodes bind
0.0.0.0:<p2p_port> when no -bind is given, so nothing has to be configured
and no packet leaves the host: both ends of the connection are here. If the
machine has no address but the loopback, the test says so and skips rather
than passing on an untested path.

THE SHAPE OF THE PROOF
----------------------
Two connections from the same address, one bad header each.

    first     the node verifies it, answers high-hash, and discourages
    second    the node ignores it without verifying anything

The second assertion is the fix. Against the unfixed node the second header
is verified exactly like the first, 'high-hash' appears again, and the
unexpected_msgs check fails -- which is how this test was shown to test
something.
"""

import socket
import time

from test_framework.messages import CBlockHeader, msg_headers
from test_framework.p2p import P2PInterface
from test_framework.test_framework import BitcoinTestFramework
from test_framework.util import assert_equal


def routable_address():
    """An address of this machine that Core will not call local.

    Opening a UDP socket towards an address that is routed but never spoken
    to is the ordinary way to ask the kernel which of our addresses it would
    answer from. Nothing is sent.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class WamHeaderDosTest(BitcoinTestFramework):
    def set_test_params(self):
        self.num_nodes = 1
        self.setup_clean_chain = True

    def bad_header(self, tmpl, nonce):
        """A header that costs nothing to make and must be verified to refuse.

        Everything in it is what an honest header would carry except the
        proof: the parent is the tip the node already has, so the cheap
        parent lookup succeeds; nBits is the template's own, so the
        difficulty comparison succeeds; the time is the template's, so both
        timestamp tests succeed. Only the RandomX hash can refuse it, which
        is the point -- twenty milliseconds, bought for ninety bytes.
        """
        h = CBlockHeader()
        h.nVersion = tmpl["version"]
        h.hashPrevBlock = int(tmpl["previousblockhash"], 16)
        h.hashMerkleRoot = 0x1234
        h.nTime = tmpl["curtime"]
        h.nBits = int(tmpl["bits"], 16)
        h.nNonce = nonce
        h.rehash()
        return h

    def run_test(self):
        node = self.nodes[0]

        addr = routable_address()
        if addr.startswith("127."):
            raise AssertionError(
                "this machine has no address but the loopback, and a loopback "
                "peer is never discouraged -- the behaviour under test cannot "
                "be reached from here")
        self.log.info(f"peers will connect over {addr}, which is not local")

        self.generate(node, 1, sync_fun=self.no_op)
        tmpl = node.getblocktemplate({"rules": ["segwit"]})
        self.log.info(f"tip is height {tmpl['height'] - 1}, bits {tmpl['bits']}")

        # ---- one: the node pays, and punishes -----------------------------
        first = node.add_p2p_connection(P2PInterface(), dstaddr=addr)
        started = time.time()
        with node.assert_debug_log(["high-hash"], timeout=30):
            first.send_message(msg_headers([self.bad_header(tmpl, 1)]))
            first.wait_for_disconnect(timeout=30)
        paid = time.time() - started
        self.log.info(f"the first header was verified and refused in {paid * 1000:.0f} ms")

        # The address, not the connection, is what was punished. Without this
        # the next assertion could pass for the wrong reason.
        assert any("discouraging" in line and "not discouraging" not in line
                   for line in open(node.debug_log_path, encoding="utf-8")), \
            "the node disconnected the peer without discouraging the address"
        self.log.info("the address is discouraged")

        # ---- two: the same address pays nothing ---------------------------
        second = node.add_p2p_connection(P2PInterface(), dstaddr=addr)
        started = time.time()
        with node.assert_debug_log(
                expected_msgs=["ignoring 1 header(s) from discouraged peer"],
                unexpected_msgs=["high-hash"],
                timeout=30):
            second.send_and_ping(msg_headers([self.bad_header(tmpl, 2)]))
        free = time.time() - started
        self.log.info(f"the second header was ignored in {free * 1000:.0f} ms, "
                      "with no proof of work verified")

        # ---- and an honest peer is untouched ------------------------------
        #
        # The guard must not be wider than its reason. A node that ignored
        # everybody's headers would also pass the two assertions above.
        self.restart_node(0)
        self.log.info("after a restart the discouragement is gone with the "
                      "node's memory of it, and headers work again")
        honest = node.add_p2p_connection(P2PInterface(), dstaddr=addr)
        tmpl = node.getblocktemplate({"rules": ["segwit"]})
        with node.assert_debug_log(["high-hash"], timeout=30):
            honest.send_message(msg_headers([self.bad_header(tmpl, 3)]))
            honest.wait_for_disconnect(timeout=30)
        self.log.info("  an address we have not punished is still served")

        assert_equal(node.getblockcount(), 1)


if __name__ == "__main__":
    WamHeaderDosTest(__file__).main()
