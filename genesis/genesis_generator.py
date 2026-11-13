#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 genesis_generator.py -- mine the WAM Coin genesis block
===============================================================================

Produces block 0: the block that mints the entire 2,000,000 WAM founder reserve
and whose hash becomes the permanent identity of the WAM network.

The serialization below mirrors CreateGenesisBlock() in
src/wam/chainparams.cpp byte for byte. If the two ever drift apart the daemon
will refuse to start with an "assert(consensus.hashGenesisBlock == ...)"
failure, which is the intended behaviour: a silent mismatch would be far worse.

Usage
-----
    # 1. verify librandomx matches the reference vector
    python3 genesis/randomx_ffi.py

    # 2. mine mainnet genesis (uses every core, ~2 min on 8 cores)
    python3 genesis/genesis_generator.py \
        --network mainnet \
        --address W7xK9....................... \
        --patch ../src/wam/chainparams.cpp

    # dry run without touching any source file
    python3 genesis/genesis_generator.py --network mainnet --address W... --light

Output
------
    nTime, nBits, nNonce, hashMerkleRoot, hashGenesisBlock

and, with --patch, those values written straight into chainparams.cpp.
===============================================================================
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import struct
import sys
import threading
import time
from dataclasses import dataclass, asdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from randomx_ffi import RandomXContext, RandomXError  # noqa: E402

# ===========================================================================
# Constants -- MUST match src/wam/wam-params.h
# ===========================================================================

COIN = 100_000_000
GENESIS_PREMINE = 2_000_000 * COIN
GENESIS_PHRASE = "WAM Network Launching Next Generation Decentralized Economy 2026"
RANDOMX_BOOTSTRAP_KEY = b"WAM/RandomX/epoch-0/2026"


# THE NODE HASHES THIS STRING. THIS FILE USED TO FEED IT RAW.
#
# wam::GetRandomXBootstrapSeed() is SHA256 of the 24 characters above -- 32
# bytes -- and pool/lib/randomxSeed.js does the same. This generator passed
# the 24 bytes themselves straight into RandomXContext, so it mined against a
# key no node and no pool ever uses.
#
# Measured on 13 November 2026 with the committed mainnet header rebuilt from
# src/wam/chainparams.cpp (nTime 1789430400, nBits 0x1e0ffff0, nNonce
# 1264205, the merkle root matching the assert byte for byte):
#
#   under SHA256(phrase), the node's key : 6a100fd40710e589...  > target
#   under the raw phrase, this file's key : 000007d3483f0c5f... <= target
#
# So the committed genesis nonce satisfies proof of work under this file's old
# key and NOT under the key the network derives. Nothing broke, because
# nothing verifies the genesis block's proof of work -- LoadGenesisBlock
# accepts it as the root of the chain by definition, which is why mainnet has
# run since 15 September without noticing. It is not a vulnerability; it is
# that the one block nobody checks was mined against the wrong key.
#
# wam-params.h said this constant was "mirrored in genesis_generator.py" and
# that verify_supply.py --check-constants asserted all three agreed. The
# string was mirrored. The derivation was not, and --check-constants compared
# string literals, so it could never have seen this.
#
# What changes: this file now derives the key the way the node does, so any
# genesis mined from here is valid under the rule the network applies.
# --legacy-bootstrap-key reproduces the historical derivation, because the
# committed mainnet and testnet nonces came from it and an auditor has to be
# able to arrive at the same numbers.
def bootstrap_seed(legacy: bool = False) -> bytes:
    """The RandomX key for epoch 0, as the node derives it.

    Mirrors wam::GetRandomXBootstrapSeed() and the BOOTSTRAP_SEED in
    pool/lib/randomxSeed.js. scripts/verify_supply.py --check-constants
    compares the three DERIVATIONS now, by computing each one, rather than
    comparing the string they all start from.
    """
    if legacy:
        return RANDOMX_BOOTSTRAP_KEY
    return hashlib.sha256(RANDOMX_BOOTSTRAP_KEY).digest()

# Launch: 2026-09-15 00:00:00 UTC. Mirrors WAM_GENESIS_TIME in wam-params.h.
GENESIS_TIME = 1789430400

# testnet and regtest are dated in the PAST on purpose. Bitcoin Core refuses to
# load a block database containing future blocks, so a chain whose genesis
# carries the launch date cannot run before that date. That is desirable for
# mainnet (a built-in gate against launching early) and useless for the two
# networks that exist to be run during development.
TESTNET_GENESIS_TIME = 1785542400   # 2026-08-01
REGTEST_GENESIS_TIME = 1296688602   # 2011-02-02, Bitcoin's own regtest time

# Founder-reserve vesting. Mirrors WAM_PREMINE_* in wam-params.h.
#
# This table and the C++ one must agree exactly. They are separate copies
# because a Python miner cannot read a C++ header at run time, and if they ever
# disagree the generator mines a genesis block the node then refuses -- the
# hashes will not match and nothing will start. scripts/check_vesting_sync.py
# compares all copies and is the reason a divergence is caught here rather than
# on launch day.
#
# Every tranche is locked; none is spendable at launch. See the note on
# WAM_PREMINE_UNLOCK_TIMES in wam-params.h for why the first one stopped being
# liquid: the 5% treasury is the operating money, so the reserve never needed
# to be.
PREMINE_TRANCHES = 5
PREMINE_TRANCHE_AMOUNT = 400_000 * COIN
PREMINE_UNLOCK_TIMES = [
    1820966400,   # tranche 1 -- 2027-09-15
    1852588800,   # tranche 2 -- 2028-09-15
    1884124800,   # tranche 3 -- 2029-09-15
    1915660800,   # tranche 4 -- 2030-09-15
    1947196800,   # tranche 5 -- 2031-09-15
]

assert len(PREMINE_UNLOCK_TIMES) == PREMINE_TRANCHES
assert PREMINE_TRANCHES * PREMINE_TRANCHE_AMOUNT == GENESIS_PREMINE, \
    "vesting tranches must sum to exactly the genesis premine"
assert all(t > 500_000_000 for t in PREMINE_UNLOCK_TIMES), \
    "every tranche must carry a real time lock -- a value below the CLTV " \
    "threshold would be read as a block height and unlock almost at once"
assert all(t == 0 or t > 500_000_000 for t in PREMINE_UNLOCK_TIMES), \
    "a non-zero lock below 500,000,000 would be read by CLTV as a block height"

OP_CHECKLOCKTIMEVERIFY = 0xB1
OP_DROP = 0x75

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

NETWORKS = {
    #                 nTime          nBits       pubkey_ver  script_ver  label
    "mainnet": dict(time=GENESIS_TIME,         bits=0x1E0FFFF0, pubkey=73, script=135, first="W"),
    "testnet": dict(time=TESTNET_GENESIS_TIME, bits=0x1E0FFFF0, pubkey=65, script=128, first="T"),
    "regtest": dict(time=REGTEST_GENESIS_TIME, bits=0x207FFFFF, pubkey=65, script=128, first="T"),
}


# ===========================================================================
# Primitives
# ===========================================================================

def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def dsha256(b: bytes) -> bytes:
    return sha256(sha256(b))


def base58_decode_check(s: str) -> bytes:
    n = 0
    for ch in s:
        idx = B58_ALPHABET.find(ch)
        if idx < 0:
            raise ValueError(f"invalid base58 character {ch!r} in address")
        n = n * 58 + idx

    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    # Restore leading zero bytes, which base58 encodes as '1'.
    pad = len(s) - len(s.lstrip("1"))
    raw = b"\x00" * pad + raw

    if len(raw) < 5:
        raise ValueError("address too short")
    payload, checksum = raw[:-4], raw[-4:]
    if dsha256(payload)[:4] != checksum:
        raise ValueError("address checksum mismatch -- the address is mistyped")
    return payload


def varint(n: int) -> bytes:
    if n < 0xFD:
        return struct.pack("<B", n)
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFF_FFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def push_data(data: bytes) -> bytes:
    """Bitcoin script push, matching CScript::operator<<(vector)."""
    n = len(data)
    if n < 0x4C:
        return struct.pack("<B", n) + data
    if n <= 0xFF:
        return b"\x4c" + struct.pack("<B", n) + data
    if n <= 0xFFFF:
        return b"\x4d" + struct.pack("<H", n) + data
    return b"\x4e" + struct.pack("<I", n) + data


def script_num(n: int) -> bytes:
    """CScriptNum serialization, then wrapped as a push (matches CScript <<)."""
    if n == 0:
        return b"\x00"
    out = bytearray()
    neg = n < 0
    absn = abs(n)
    while absn:
        out.append(absn & 0xFF)
        absn >>= 8
    if out[-1] & 0x80:
        out.append(0x80 if neg else 0x00)
    elif neg:
        out[-1] |= 0x80
    return bytes(out)


def compact_to_target(nbits: int) -> int:
    exponent = nbits >> 24
    mantissa = nbits & 0x007F_FFFF
    if exponent <= 3:
        return mantissa >> (8 * (3 - exponent))
    return mantissa << (8 * (exponent - 3))


# ===========================================================================
# Genesis block construction
# ===========================================================================

@dataclass
class GenesisResult:
    network: str
    address: str
    phrase: str
    n_time: int
    n_bits: str
    n_nonce: int
    merkle_root: str
    genesis_hash: str
    pow_hash: str
    target: str
    hashes_tried: int
    seconds: float
    hashrate: float


def build_coinbase_scriptsig(phrase: str) -> bytes:
    """
    Mirrors:
        CScript() << 486604799 << CScriptNum(4) << vector<unsigned char>(phrase)

    486604799 == 0x1D00FFFF is Bitcoin's genesis nBits, preserved by convention
    as the first scriptSig element in essentially every UTXO chain.
    """
    return (push_data(script_num(486604799))
            + push_data(script_num(4))
            + push_data(phrase.encode("utf-8")))


def p2pkh_script(pubkey_hash: bytes) -> bytes:
    assert len(pubkey_hash) == 20
    # OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
    return b"\x76\xa9\x14" + pubkey_hash + b"\x88\xac"


def timelocked_script(pubkey_hash: bytes, locktime: int) -> bytes:
    """
    <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP OP_DUP OP_HASH160 <h> OP_EQUALVERIFY OP_CHECKSIG

    Byte-identical to TimeLockedFounderScript() in chainparams.cpp. If these two
    ever disagree by a single byte the merkle root changes, the mined nonce
    becomes meaningless, and the daemon refuses to start on its own genesis
    assertion -- which is the loud failure we want rather than a quiet one.
    """
    if locktime == 0:
        return p2pkh_script(pubkey_hash)
    return (push_data(script_num(locktime))
            + bytes([OP_CHECKLOCKTIMEVERIFY, OP_DROP])
            + p2pkh_script(pubkey_hash))


OP_TRUE_SCRIPT = bytes([0x51])


def build_genesis_outputs(pubkey_hash: bytes, single: bool = False,
                          op_true: bool = False) -> list[tuple[int, bytes]]:
    """
    The five vesting tranches, or one unlocked output.

    `op_true` emits a bare OP_TRUE output, which is what CRegTestParams uses so
    that functional tests can spend the premine without holding a key. It MUST
    match chainparams.cpp exactly: a different script means a different merkle
    root, a different genesis hash, and a node that aborts on its own assertion.
    """
    if op_true:
        return [(GENESIS_PREMINE, OP_TRUE_SCRIPT)]
    if single:
        return [(GENESIS_PREMINE, p2pkh_script(pubkey_hash))]

    outputs = [(PREMINE_TRANCHE_AMOUNT, timelocked_script(pubkey_hash, t))
               for t in PREMINE_UNLOCK_TIMES]

    assert sum(v for v, _ in outputs) == GENESIS_PREMINE
    return outputs


def build_coinbase_tx(outputs: list[tuple[int, bytes]], phrase: str) -> bytes:
    script_sig = build_coinbase_scriptsig(phrase)

    tx = b""
    tx += struct.pack("<i", 1)                       # nVersion
    tx += varint(1)                                  # vin count
    tx += b"\x00" * 32                               # prevout.hash (null)
    tx += struct.pack("<I", 0xFFFF_FFFF)             # prevout.n
    tx += varint(len(script_sig)) + script_sig
    tx += struct.pack("<I", 0xFFFF_FFFF)             # nSequence
    tx += varint(len(outputs))                       # vout count
    for value, script_pubkey in outputs:
        tx += struct.pack("<q", value)               # nValue
        tx += varint(len(script_pubkey)) + script_pubkey
    tx += struct.pack("<I", 0)                       # nLockTime
    return tx


def serialize_header(version: int, prev: bytes, merkle: bytes,
                     n_time: int, n_bits: int, nonce: int) -> bytes:
    return (struct.pack("<i", version)
            + prev
            + merkle
            + struct.pack("<I", n_time)
            + struct.pack("<I", n_bits)
            + struct.pack("<I", nonce))


# ===========================================================================
# Mining
# ===========================================================================

def mine(header_prefix: bytes, target: int, ctx: RandomXContext,
         threads: int, quiet: bool) -> tuple[int, bytes, int]:
    """
    Search the 32-bit nonce space for a header whose RandomX hash <= target.

    Returns (nonce, pow_hash_bytes, total_hashes_tried).

    Each worker owns a private VM and strides through the nonce space by
    `threads`, so no two workers ever test the same nonce and no coordination
    is needed on the hot path.
    """
    found: dict = {}
    stop = threading.Event()
    counters = [0] * threads
    lock = threading.Lock()

    def worker(idx: int) -> None:
        vm = ctx.new_vm()
        nonce = idx
        local = 0
        while not stop.is_set() and nonce <= 0xFFFF_FFFF:
            header = header_prefix + struct.pack("<I", nonce)
            h = ctx.hash_with(vm, header)
            local += 1
            if local % 64 == 0:
                counters[idx] = local
            # RandomX output is compared as a little-endian 256-bit integer,
            # exactly as arith_uint256(uint256) does in the C++ node.
            if int.from_bytes(h, "little") <= target:
                with lock:
                    if not found:
                        found["nonce"] = nonce
                        found["hash"] = h
                stop.set()
                break
            nonce += threads
        counters[idx] = local

    started = time.time()
    workers = [threading.Thread(target=worker, args=(i,), daemon=True)
               for i in range(threads)]
    for t in workers:
        t.start()

    if not quiet:
        while any(t.is_alive() for t in workers):
            time.sleep(2.0)
            total = sum(counters)
            elapsed = max(time.time() - started, 1e-9)
            print(f"\r[mining] {total:,} hashes  "
                  f"{total / elapsed:,.0f} H/s  "
                  f"{elapsed:,.0f}s elapsed", end="", file=sys.stderr, flush=True)
        print("", file=sys.stderr)

    for t in workers:
        t.join()

    if not found:
        raise RuntimeError(
            "exhausted the 32-bit nonce space without finding a valid hash. "
            "Increase --time by one second and try again (this changes the "
            "header and therefore the entire search space)."
        )
    return found["nonce"], found["hash"], sum(counters)


# ===========================================================================
# chainparams.cpp patching
# ===========================================================================

def patch_chainparams(path: str, network: str, result: GenesisResult) -> None:
    """
    Rewrite the nNonce placeholder and the two genesis assertions for the
    requested network. The file is parsed by locating the class body, so the
    three networks can be patched independently and in any order.
    """
    class_name = {"mainnet": "CMainParams",
                  "testnet": "CTestNetParams",
                  "regtest": "CRegTestParams"}[network]

    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()

    start = src.find(f"class {class_name}")
    if start < 0:
        raise SystemExit(f"could not find 'class {class_name}' in {path}")
    end = src.find("\nclass ", start + 1)
    if end < 0:
        end = len(src)
    body = src[start:end]
    original = body

    body, n = re.subn(r"(/\*nNonce=\*/\s*)\d+", rf"\g<1>{result.n_nonce}", body, count=1)
    if n != 1:
        raise SystemExit(f"could not find the /*nNonce=*/ placeholder inside {class_name}")

    body, n = re.subn(
        r"(assert\(consensus\.hashGenesisBlock\s*==\s*uint256S\(\")0x[0-9a-fA-F]+(\"\)\);)",
        rf"\g<1>0x{result.genesis_hash}\g<2>", body, count=1)
    if n != 1:
        raise SystemExit(f"could not find the hashGenesisBlock assertion inside {class_name}")

    body, n = re.subn(
        r"(assert\(genesis\.hashMerkleRoot\s*==\s*uint256S\(\")0x[0-9a-fA-F]+(\"\)\);)",
        rf"\g<1>0x{result.merkle_root}\g<2>", body, count=1)
    if n != 1:
        raise SystemExit(f"could not find the hashMerkleRoot assertion inside {class_name}")

    if body == original:
        raise SystemExit("patch produced no change -- refusing to write")

    backup = path + ".bak"
    if not os.path.exists(backup):
        with open(backup, "w", encoding="utf-8") as fh:
            fh.write(src)
        print(f"  backup written to {backup}")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src[:start] + body + src[end:])
    print(f"  patched {class_name} in {path}")


# ===========================================================================
# Main
# ===========================================================================

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Mine the WAM Coin genesis block.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", choices=sorted(NETWORKS), default="mainnet")
    ap.add_argument("--address", required=True,
                    help="founder address that receives the 2,000,000 WAM premine")
    ap.add_argument("--time", type=int, default=None,
                    help="override the genesis unix timestamp")
    ap.add_argument("--bits", type=lambda s: int(s, 0), default=None,
                    help="override nBits, e.g. 0x1e0ffff0")
    ap.add_argument("--threads", type=int, default=0, help="0 = every core")
    ap.add_argument("--light", action="store_true",
                    help="mine from the 256 MiB cache instead of the 2 GiB dataset "
                         "(about 8x slower; use on memory-constrained machines)")
    ap.add_argument("--op-true", action="store_true",
                    help="emit a bare OP_TRUE premine output instead of paying the "
                         "founder address (always on for regtest, matching "
                         "CRegTestParams, so functional tests can spend it)")
    ap.add_argument("--single-output", action="store_true",
                    help="emit one unlocked premine output instead of the five vesting "
                         "tranches (always on for regtest, where a four-year CLTV would "
                         "make every functional test unrunnable)")
    ap.add_argument("--patch", metavar="CHAINPARAMS_CPP", default=None,
                    help="write the mined values straight into chainparams.cpp")
    ap.add_argument("--json", metavar="FILE", default=None,
                    help="also write the full result as JSON")
    ap.add_argument("--legacy-bootstrap-key", action="store_true",
                    help="mine against the raw 24-byte phrase instead of "
                         "SHA256 of it. This is what this script did until "
                         "2026-11-13 and is the key the committed mainnet "
                         "and testnet genesis nonces were found under, so it "
                         "is how an auditor reproduces them. A genesis mined "
                         "this way does NOT satisfy proof of work under the "
                         "key the node derives.")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    net = NETWORKS[args.network]
    n_time = args.time if args.time is not None else net["time"]
    n_bits = args.bits if args.bits is not None else net["bits"]
    threads = args.threads if args.threads > 0 else (os.cpu_count() or 1)

    # ---- validate the founder address ------------------------------------
    try:
        payload = base58_decode_check(args.address)
    except ValueError as exc:
        return _fail(f"invalid founder address: {exc}")

    version, pubkey_hash = payload[0], payload[1:]
    if len(pubkey_hash) != 20:
        return _fail(f"expected a 20-byte hash, got {len(pubkey_hash)} bytes")
    if version != net["pubkey"]:
        return _fail(
            f"address version byte is {version}, but {args.network} expects "
            f"{net['pubkey']} (addresses beginning with '{net['first']}'). "
            f"Did you generate the key for the wrong network?")

    # ---- build the block -------------------------------------------------
    # Every network, regtest included, pays the founder address across the five
    # vesting tranches. OP_TRUE is available with --op-true but is no longer the
    # regtest default: the vesting scripts are exactly what needs exercising,
    # and regtest is the only chain fast enough to exercise them.
    op_true = args.op_true
    single = args.single_output or op_true
    outputs = build_genesis_outputs(pubkey_hash, single=single, op_true=op_true)
    coinbase = build_coinbase_tx(outputs, GENESIS_PHRASE)

    # A single-transaction block's merkle root is simply that transaction's id.
    merkle = dsha256(coinbase)

    header_prefix = serialize_header(1, b"\x00" * 32, merkle, n_time, n_bits, 0)[:76]
    target = compact_to_target(n_bits)

    # The key this run mines against, decided once.
    seed = bootstrap_seed(args.legacy_bootstrap_key)

    if not args.quiet:
        print("=" * 74)
        print(f" WAM Coin genesis generator -- {args.network}")
        print("=" * 74)
        print(f"  phrase        : {GENESIS_PHRASE}")
        print(f"  founder       : {args.address}")
        print(f"  premine       : {GENESIS_PREMINE // COIN:,} WAM "
              f"in {len(outputs)} output{'s' if len(outputs) != 1 else ''}")
        if not single:
            print("  vesting       :")
            for i, ((value, script), unlock) in enumerate(zip(outputs, PREMINE_UNLOCK_TIMES)):
                when = ("genesis (unlocked)" if unlock == 0 else
                        _dt.datetime.fromtimestamp(unlock, _dt.timezone.utc)
                          .strftime("%Y-%m-%d %H:%M UTC"))
                print(f"      {i + 1}. {value // COIN:>9,} WAM  {when:<24} "
                      f"script {len(script)} bytes")
        print(f"  nTime         : {n_time}  "
              f"({_dt.datetime.fromtimestamp(n_time, _dt.timezone.utc):%Y-%m-%d %H:%M UTC})")
        print(f"  nBits         : 0x{n_bits:08x}")
        print(f"  target        : {target:064x}")
        print(f"  merkle root   : {merkle[::-1].hex()}")
        print(f"  randomx phrase: {RANDOMX_BOOTSTRAP_KEY.decode()}")
        print(f"  randomx key   : {seed.hex()}"
              f"{'  (LEGACY: the raw phrase, not SHA256 of it)' if args.legacy_bootstrap_key else '  = SHA256(phrase), as the node derives it'}")
        print(f"  expected work : ~{(1 << 256) // max(target, 1):,} hashes")
        print(f"  threads       : {threads}   mode: "
              f"{'light (cache)' if args.light else 'full (2 GiB dataset)'}")
        print("-" * 74)

    # ---- mine ------------------------------------------------------------
    started = time.time()
    try:
        with RandomXContext(seed, full_mem=not args.light,
                            threads=threads, verbose=not args.quiet) as ctx:
            nonce, pow_hash, tried = mine(header_prefix, target, ctx, threads, args.quiet)
    except RandomXError as exc:
        return _fail(str(exc))
    elapsed = time.time() - started

    header = header_prefix + struct.pack("<I", nonce)
    block_hash = dsha256(header)

    result = GenesisResult(
        network=args.network,
        address=args.address,
        phrase=GENESIS_PHRASE,
        n_time=n_time,
        n_bits=f"0x{n_bits:08x}",
        n_nonce=nonce,
        merkle_root=merkle[::-1].hex(),
        genesis_hash=block_hash[::-1].hex(),
        pow_hash=pow_hash[::-1].hex(),
        target=f"{target:064x}",
        hashes_tried=tried,
        seconds=round(elapsed, 2),
        hashrate=round(tried / elapsed, 1) if elapsed else 0.0,
    )

    # ---- self-check before we let anyone use this ------------------------
    assert int.from_bytes(pow_hash, "little") <= target, "mined hash does not meet target"
    assert len(header) == 80, "header must be exactly 80 bytes"

    print()
    print("=" * 74)
    print(" GENESIS BLOCK FOUND")
    print("=" * 74)
    print(f"  nTime            = {result.n_time}")
    print(f"  nBits            = {result.n_bits}")
    print(f"  nNonce           = {result.n_nonce}")
    print(f"  hashMerkleRoot   = 0x{result.merkle_root}")
    print(f"  hashGenesisBlock = 0x{result.genesis_hash}")
    print(f"  randomx pow hash = 0x{result.pow_hash}")
    print(f"  {result.hashes_tried:,} hashes in {result.seconds}s "
          f"({result.hashrate:,.0f} H/s)")
    print("=" * 74)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(asdict(result), fh, indent=2)
        print(f"  wrote {args.json}")

    if args.patch:
        patch_chainparams(args.patch, args.network, result)

    print()
    print("  Paste into chainparams.cpp if you did not use --patch:")
    print(f"      /*nNonce=*/ {result.n_nonce},")
    print(f'      assert(consensus.hashGenesisBlock == uint256S("0x{result.genesis_hash}"));')
    print(f'      assert(genesis.hashMerkleRoot     == uint256S("0x{result.merkle_root}"));')
    return 0


def _fail(msg: str) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
