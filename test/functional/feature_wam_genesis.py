#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""The genesis premine: five tranches, every one of them time-locked.

Bitcoin's genesis coinbase is deliberately unspendable -- it was never added to
the UTXO set. WAM patches that, because the genesis block *is* the premine. If
that patch ever silently stopped working, the chain would start with two
million WAM that exist in the block and nowhere else: `getsupplyinfo` would
report them, an explorer would show them, and they could never be spent. The
failure would look exactly like success until someone tried.

So this checks the outputs are real UTXOs, not just bytes in a block.

It also checks all five locked tranches carry CHECKLOCKTIMEVERIFY with the
dates the whitepaper promises. Those dates are the whole basis of the founder
disclosure; they are readable from block 0 by anyone, and this makes sure they
stay that way.
"""

from test_framework.test_framework import BitcoinTestFramework
from test_framework.util import assert_equal, assert_greater_than

COIN = 100_000_000

# From src/wam/wam-params.h. Kept as literals on purpose: a test that imports
# the value it is testing proves nothing.
PREMINE_TOTAL = 2_000_000 * COIN
TRANCHE_AMOUNT = 400_000 * COIN
TRANCHE_COUNT = 5
# Every tranche is locked; the first opens 2027-09-15, a year after launch.
#
# This list read [0, 2027, 2028, 2029, 2030] until it was first executed, on
# 2026-09-14 -- nine hours before mainnet. The prose above it had already been
# rewritten for the change that locked the first tranche, and the assertions
# below it too, but the dates themselves were left shifted by one. Run against
# the deployed v0.1.8 binary it failed on the first output with
#
#     AssertionError: not(1820966400 == 0)
#
# which is the binary being right and the test being a year behind. The source
# of truth is WAM_PREMINE_UNLOCK_TIMES in src/wam/wam-params.h; the dates are
# still copied here as literals rather than imported, because a test that
# reads the value it is checking proves nothing.
UNLOCK_TIMES = [
    1820966400,  # tranche 1 -- 2027-09-15
    1852588800,  # tranche 2 -- 2028-09-15
    1884124800,  # tranche 3 -- 2029-09-15
    1915660800,  # tranche 4 -- 2030-09-15
    1947196800,  # tranche 5 -- 2031-09-15
]

OP_CHECKLOCKTIMEVERIFY = 0xb1
OP_DROP = 0x75


class WamGenesisTest(BitcoinTestFramework):
    def set_test_params(self):
        self.num_nodes = 1
        self.setup_clean_chain = True

    def run_test(self):
        node = self.nodes[0]

        genesis_hash = node.getblockhash(0)
        genesis = node.getblock(genesis_hash, 2)
        coinbase = genesis['tx'][0]

        self.log.info('the genesis coinbase carries five outputs')
        assert_equal(len(coinbase['vout']), TRANCHE_COUNT)

        self.log.info('each tranche is 400,000 WAM and they total two million')
        total = 0
        for i, out in enumerate(coinbase['vout']):
            value = int(round(out['value'] * COIN))
            assert_equal(value, TRANCHE_AMOUNT)
            total += value
        assert_equal(total, PREMINE_TOTAL)

        self.log.info('not one tranche is spendable at launch')
        for i in range(TRANCHE_COUNT):
            script = bytes.fromhex(coinbase['vout'][i]['scriptPubKey']['hex'])
            assert OP_CHECKLOCKTIMEVERIFY in script, (
                f'tranche {i + 1} carries no time lock. This test used to require '
                'the opposite of exactly this for the first output, which was the '
                'launch working capital; nothing in the reserve is liquid now.')  # wam:quote-line
            assert len(script) != 25, (
                f'tranche {i + 1} is a bare 25-byte P2PKH, which means it can be '
                'spent on launch day')

        self.log.info('every tranche is locked to a promised date')
        for i in range(TRANCHE_COUNT):
            script = bytes.fromhex(coinbase['vout'][i]['scriptPubKey']['hex'])

            # <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <p2pkh...>
            push_len = script[0]
            assert 1 <= push_len <= 5, \
                f'tranche {i + 1} does not begin with a locktime push'
            locktime = int.from_bytes(script[1:1 + push_len], 'little')
            assert_equal(locktime, UNLOCK_TIMES[i])
            assert_equal(script[1 + push_len], OP_CHECKLOCKTIMEVERIFY)
            assert_equal(script[2 + push_len], OP_DROP)

            # A timestamp, not a height. CLTV compares against one or the other
            # depending on which side of 500,000,000 the value falls, and a
            # lock that was meant for 2030 but reads as height 1,820,966,400
            # would never open at all.
            assert_greater_than(locktime, 500_000_000)
            self.log.info(f'  tranche {i + 1}: locked until {locktime}')

        self.log.info('every tranche is a real, spendable-in-principle UTXO')
        for i in range(TRANCHE_COUNT):
            utxo = node.gettxout(coinbase['txid'], i)
            assert utxo is not None, (
                f'tranche {i + 1} is in the genesis block but not in the UTXO set. '
                'The premine would be unspendable forever.')
            assert_equal(int(round(utxo['value'] * COIN)), TRANCHE_AMOUNT)

        self.log.info('getsupplyinfo agrees with the block')
        info = node.getsupplyinfo()
        assert_equal(info['height'], 0)
        assert_equal(int(round(info['premine'] * COIN)), PREMINE_TOTAL)
        assert_equal(int(round(info['circulating'] * COIN)), PREMINE_TOTAL)

        self.log.info('the emission schedule the node reports is its own, not a guess')
        assert_greater_than(info['halving_interval'], 0)
        # THE FIRST BLOCK THAT PAYS LESS, NOT THE LAST THAT PAYS FULL.
        #
        # This asserted next_halving_height == halving_interval, which is
        # what the RPC said until 9 November 2026 and what it said wrongly:
        # GetBlockSubsidy counts halvings as (height - 1) / interval, so
        # epoch e begins at e * interval + 1 and the block AT the interval
        # still pays the old subsidy. The test agreed with the defect, so it
        # could not have found it -- and when the defect was fixed, this line
        # was what failed.
        #
        # Reported by dang150296 (Urriki1502), who ran this test against the
        # released v0.1.14 daemon and read the failure for what it was.
        assert_equal(info['next_halving_height'], info['halving_interval'] + 1)
        self.log.info(f"  halving interval {info['halving_interval']}, "
                      f"next at {info['next_halving_height']}")

        self.log.info('mining does not disturb the premine')
        self.generatetodescriptor(node, 5, 'raw(51)#8lvh9jxk')
        after = node.getsupplyinfo()
        assert_equal(int(round(after['premine'] * COIN)), PREMINE_TOTAL)
        assert_greater_than(after['circulating'], info['circulating'])

        for i in range(TRANCHE_COUNT):
            assert node.gettxout(coinbase['txid'], i) is not None, \
                f'tranche {i + 1} vanished from the UTXO set after mining'


if __name__ == '__main__':
    WamGenesisTest(__file__).main()
