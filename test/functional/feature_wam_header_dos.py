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

from test_framework.messages import (
    CBlockHeader,
    P2PHeaderAndShortIDs,
    msg_cmpctblock,
    msg_headers,
)
from test_framework.p2p import P2PInterface
from test_framework.test_framework import BitcoinTestFramework
from test_framework.util import assert_equal, p2p_port


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
        # The framework writes bind=127.0.0.1 into every node's config, so a
        # node listens on the loopback only and a peer cannot reach it from
        # the address this test needs. A second bind is added for that one
        # address -- not 0.0.0.0, which would take the port before the
        # config's loopback bind could have it and stop the node with
        # "Unable to bind ... already running". Two addresses, one port, one
        # machine, for the length of one test.
        self.routable = routable_address()

    def setup_network(self):
        # The bind is built here and not in set_test_params, because the port
        # is only decided once the framework has applied --portseed. Run on
        # its own the two agreed by luck; run inside test_runner.py, which
        # gives every test a different seed, they did not, and the peer
        # dialled a port nothing was listening on.
        self.extra_args = [[f"-bind={self.routable}:{p2p_port(0)}"]]
        super().setup_network()

    def bad_header(self, tmpl, nonce):
        """A header the node must refuse, and refuse every time.

        The parent is the tip the node already has, so the cheap parent
        lookup succeeds and the header reaches the contextual checks -- which
        is the whole shape of the attack: ninety bytes that cost nothing and
        buy a place in the expensive part of validation.

        What makes it invalid is the timestamp, not the proof of work, and
        that is deliberate. On regtest the target is about 2**255, so roughly
        half of all nonces satisfy RandomX: a header built to fail the proof
        is a coin toss, and a test that depends on a coin toss is not a test.
        A timestamp of 1 is older than the median of any chain with a block
        in it, so "time-too-old" is certain -- and it is BLOCK_INVALID_HEADER
        either way, which is what discourages the address.
        """
        h = CBlockHeader()
        h.nVersion = tmpl["version"]
        h.hashPrevBlock = int(tmpl["previousblockhash"], 16)
        h.hashMerkleRoot = 0x1234
        h.nTime = 1
        h.nBits = int(tmpl["bits"], 16)
        h.nNonce = nonce
        h.rehash()
        return h

    def run_test(self):
        node = self.nodes[0]

        addr = self.routable
        if addr.startswith("127."):
            raise AssertionError(
                "this machine has no address but the loopback, and a loopback "
                "peer is never discouraged -- the behaviour under test cannot "
                "be reached from here")
        self.log.info(f"peers will connect over {addr}, which is not local")

        self.generate(node, 1, sync_fun=self.no_op)
        tmpl = node.getblocktemplate({"rules": ["segwit"]})
        self.log.info(f"tip is height {tmpl['height'] - 1}, bits {tmpl['bits']}")

        # ---- one: the address is punished ---------------------------------
        first = node.add_p2p_connection(P2PInterface(), dstaddr=addr)
        with node.assert_debug_log(["Disconnecting and discouraging"], timeout=30):
            first.send_message(msg_headers([self.bad_header(tmpl, 1)]))
            first.wait_for_disconnect(timeout=30)
        self.log.info("the first header was refused and the address discouraged")

        # Not "disconnecting but not discouraging", which is what the node
        # says about a loopback peer. Without this line the next assertion
        # could pass for a reason that has nothing to do with the fix.
        log = open(node.debug_log_path, encoding="utf-8").read()
        assert "not discouraging" not in log,             "the node disconnected the peer without discouraging the address, "             "so nothing below tests what it claims to"

        # ---- two: and buys nothing afterwards ------------------------------
        #
        # This is the fix. Against the unfixed node this header is verified
        # exactly like the first one and neither assertion holds: the
        # "ignoring" line is never written, and the twenty milliseconds are
        # spent.
        second = node.add_p2p_connection(P2PInterface(), dstaddr=addr)
        started = time.time()
        with node.assert_debug_log(
                expected_msgs=["ignoring 1 header(s) from discouraged peer"],
                unexpected_msgs=["high-hash"],
                timeout=30):
            second.send_and_ping(msg_headers([self.bad_header(tmpl, 2)]))
        self.log.info("the second header was ignored in "
                      f"{(time.time() - started) * 1000:.0f} ms, nothing verified")

        # ---- three: an address we have not punished is still served --------
        #
        # The guard must not be wider than its reason. A node that ignored
        # every peer's headers would pass both assertions above.
        self.restart_node(0)
        third = node.add_p2p_connection(P2PInterface(), dstaddr=addr)
        tmpl = node.getblocktemplate({"rules": ["segwit"]})
        # send_message and wait for the disconnect, not send_and_ping: a peer
        # whose header is refused is disconnected, so there is nobody left to
        # answer a ping. Being disconnected is the proof -- the node read the
        # header and judged it, which is what an unpunished address gets.
        with node.assert_debug_log(
                expected_msgs=["received: headers"],
                unexpected_msgs=["ignoring 1 header(s) from discouraged peer"],
                timeout=30):
            third.send_message(msg_headers([self.bad_header(tmpl, 3)]))
            third.wait_for_disconnect(timeout=30)
        self.log.info("after the restart cleared the discouragement, headers "
                      "from the same address are read again")

        # ---- four: and the other door -------------------------------------
        #
        # HEADERS is not the only way a peer hands us an arbitrary header.
        # The CMPCTBLOCK handler calls ProcessNewBlockHeaders directly and
        # never passes through ProcessHeadersMessage, so the first version of
        # this guard -- written inside that function -- did not cover it. A
        # discouraged peer kept its twenty milliseconds by announcing a
        # compact block instead: about a kilobyte, the same cost to us.
        #
        # Its two cheap pre-checks do not help. The parent is the node's own
        # tip, which is public, and the anti-DoS work threshold only rejects
        # forks far behind that tip.
        #
        # This step is why the test exists in this shape at all: the first
        # three steps pass against a node with the hole in it, because they
        # only ever send msg_headers.
        #
        # Reported by Radenlingga on 10 November 2026, against v0.1.14.
        #
        # Step three already put the address back in the discouragement set --
        # it sent a bad header and was disconnected for it -- so nothing has
        # to punish it again here. Trying to would hang: a discouraged peer's
        # headers are now ignored rather than judged, so there is no
        # disconnection to wait for. That is the guard working, and it cost a
        # thirty-second timeout to learn.
        fifth = node.add_p2p_connection(P2PInterface(), dstaddr=addr)
        tmpl = node.getblocktemplate({"rules": ["segwit"]})
        started = time.time()
        with node.assert_debug_log(
                expected_msgs=["ignoring 1 header(s) from discouraged peer"],
                unexpected_msgs=["high-hash"],
                timeout=30):
            fifth.send_and_ping(
                msg_cmpctblock(self.compact(self.bad_header(tmpl, 5))))
        self.log.info("the compact block was ignored in "
                      f"{(time.time() - started) * 1000:.0f} ms, nothing verified")

        assert_equal(node.getblockcount(), 1)

    def compact(self, header):
        """The smallest compact-block announcement that carries a header.

        No short ids and no prefilled transactions: the header is the whole
        point of this test, because the header is what reaches
        ProcessNewBlockHeaders and costs twenty milliseconds of RandomX. The
        node never gets far enough to want the transactions.
        """
        cmpct = P2PHeaderAndShortIDs()
        cmpct.header = header
        cmpct.nonce = 1
        cmpct.shortids_length = 0
        cmpct.shortids = []
        cmpct.prefilled_txn_length = 0
        cmpct.prefilled_txn = []
        return cmpct


if __name__ == "__main__":
    WamHeaderDosTest(__file__).main()
