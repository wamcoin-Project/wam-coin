// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.

#ifndef WAM_CRYPTO_RANDOMX_HASH_H
#define WAM_CRYPTO_RANDOMX_HASH_H

#include <uint256.h>

#include <cstddef>
#include <cstdint>

class CBlockHeader;
class CBlockIndex;
namespace Consensus { struct Params; }

namespace wam {

/**
 * ---------------------------------------------------------------------------
 *  RandomX proof-of-work for a Bitcoin-shaped 80-byte header
 * ---------------------------------------------------------------------------
 *
 *  RandomX is a VM that compiles a program derived from the *key* and executes
 *  it against the input. Two things follow that a SHA256 chain never has to
 *  worry about:
 *
 *    1. The key must be agreed on by consensus. We derive it from a block hash
 *       far enough behind the tip that it can be treated as final:
 *
 *           seed_height = floor((H - LAG) / EPOCH) * EPOCH
 *           key         = block_hash(seed_height)
 *
 *       with EPOCH = 2048 blocks (~2.8 days) and LAG = 64 blocks (~2.1 hours).
 *       The lag is what makes the scheme reorg-safe: by the time a height
 *       becomes a seed, burying it 64 deep means no realistic reorganisation
 *       can change it, so nobody ever has to throw away a dataset because of
 *       a chain reorganisation.
 *
 *    2. Initialising a RandomX dataset costs ~2 GiB of RAM and several seconds
 *       of CPU. Doing that per block would be fatal, so VMs are pooled and
 *       keyed by seed. The cache below keeps the current and previous epoch
 *       alive simultaneously, which is exactly what is needed at an epoch
 *       boundary when blocks from both sides are still arriving.
 *
 *  Verification (what a node does) uses the light "cache" mode: ~256 MiB and
 *  a few milliseconds per hash. Mining (what a pool or miner does) uses the
 *  full "dataset" mode: ~2 GiB and roughly 8x the hash rate. Both produce
 *  bit-identical results.
 */

/** Size in bytes of a serialized block header fed to RandomX. */
static constexpr size_t RANDOMX_INPUT_SIZE = 80;

/**
 * Height whose block hash seeds the RandomX key for a block at `nHeight`.
 * Returns 0 for every height inside the bootstrap epoch, in which case the
 * caller must use GetRandomXBootstrapSeed() rather than a block hash.
 *
 * The epoch length and lag come from consensus, not from the compile-time
 * constants. They differ per network -- 2048/64 on mainnet, 256/16 on testnet,
 * 64/4 on regtest -- and this function read the mainnet constants regardless
 * until 2026-08-09. The consequence was not a wrong chain: it was a chain that
 * behaved one way while `getrandomxinfo` reported another, and a regtest that
 * needed 2,112 blocks to exercise a rotation the parameters said would happen
 * at 68.
 */
int GetRandomXSeedHeight(int nHeight, const Consensus::Params& params);

/**
 * The fixed epoch-0 key: SHA256(WAM_RANDOMX_BOOTSTRAP_KEY).
 *
 * Using a constant here rather than the genesis hash breaks the circular
 * dependency that would otherwise make the genesis block unmineable -- see
 * the comment on WAM_RANDOMX_BOOTSTRAP_KEY in wam/wam-params.h.
 */
uint256 GetRandomXBootstrapSeed();

/**
 * The RandomX key for a block that will be built on top of `pindexPrev`.
 * `pindexPrev` may be null, in which case the bootstrap seed is returned.
 */
uint256 GetRandomXSeedHash(const CBlockIndex* pindexPrev, const Consensus::Params& params);

/**
 * The proof-of-work hash of `header` under `seed`.
 *
 * This is NOT the block identifier. The block id remains the double-SHA256 of
 * the header, so txid/blockhash semantics, the block index and every RPC that
 * reports hashes are untouched. Only the PoW comparison uses this value.
 *
 * Thread-safe. Uses light verification mode.
 */
uint256 GetRandomXPoWHash(const CBlockHeader& header, const uint256& seed);

/**
 * Raw form used by the stratum pool's native binding and by the genesis
 * generator: hash `len` bytes of `input` under `seed`.
 */
uint256 GetRandomXHashRaw(const unsigned char* input, size_t len, const uint256& seed);

/** Bytes currently held by RandomX structures; surfaced by `getrandomxinfo`. */
size_t GetRandomXMemoryUsage();

// WHAT USED TO BE DECLARED HERE, AND WHY IT IS NOT.
//
//     void SetRandomXMiningMode(bool fMining);   // full-dataset mode
//     void FlushRandomXCaches();                 // "called on shutdown"
//
// Neither had a caller anywhere in this repository, and the switch they
// existed for -- `-randomxmining=1`, described in their own comments, in
// README.md, in docs/BUILD.md and written into every operator's wam.conf by
// install.sh -- is not an option this software has. wamd ignores it in the
// configuration file and refuses to start if it is passed on the command
// line, so the mode could never be entered and the ~2 GiB dataset path
// below them could never run.
//
// Removed rather than wired up, because a node verifies and a miner mines:
// the dataset belongs to wam-miner, which has its own RandomX in its own
// process. Keeping a mode switch that no option reaches means keeping a
// function which, if ever called, drops every cached verification context
// and makes the next header pay for a 256 MiB cache rebuild while holding
// cs_main.
//
// Reported as dead code by Radenlingga (Discord), 10 November 2026. The
// documentation it contradicted is corrected in the same change.

} // namespace wam

#endif // WAM_CRYPTO_RANDOMX_HASH_H
