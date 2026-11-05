// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  Hex, byte order, and 256-bit target arithmetic.
// ===========================================================================
//
//  BYTE ORDER IS THE WHOLE GAME
//  ----------------------------
//  Nearly every "my shares are rejected" bug in mining is a byte-order bug,
//  so the conventions are spelled out here once and referred to everywhere:
//
//    * A block header serializes every integer LITTLE-endian, and both hashes
//      inside it (prevhash, merkle root) in INTERNAL order -- which is the
//      byte reverse of how a block explorer displays them.
//
//    * Stratum puts prevhash on the wire with each 4-byte word byte-swapped.
//      Undoing that is not a plain reverse; see StratumPrevHashToHeader().
//
//    * A RandomX digest is compared to the target as a LITTLE-endian number,
//      the Monero convention. We reverse it once into big-endian bytes so that
//      a plain memcmp against a big-endian target is the comparison.
//
//  Getting any of these backwards produces a miner that hashes correctly and
//  finds nothing, which is the most expensive way to be wrong.

#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace wam {

using Bytes = std::vector<uint8_t>;

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

inline int HexDigit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/** Strict hex decode: returns false on odd length or any non-hex character. */
inline bool ParseHex(const std::string& hex, Bytes& out)
{
    if (hex.size() % 2 != 0) return false;
    out.clear();
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        const int hi = HexDigit(hex[i]);
        const int lo = HexDigit(hex[i + 1]);
        if (hi < 0 || lo < 0) return false;
        out.push_back(uint8_t((hi << 4) | lo));
    }
    return true;
}

inline Bytes ParseHexOrEmpty(const std::string& hex)
{
    Bytes out;
    if (!ParseHex(hex, out)) out.clear();
    return out;
}

inline std::string ToHex(const uint8_t* data, size_t len)
{
    static const char* kHex = "0123456789abcdef";
    std::string out;
    out.resize(len * 2);
    for (size_t i = 0; i < len; i++) {
        out[i * 2]     = kHex[data[i] >> 4];
        out[i * 2 + 1] = kHex[data[i] & 0x0F];
    }
    return out;
}

inline std::string ToHex(const Bytes& b) { return ToHex(b.data(), b.size()); }

/** 32-bit value as 8 big-endian hex digits -- what mining.submit expects. */
inline std::string ToHexBE32(uint32_t v)
{
    char buf[9];
    std::snprintf(buf, sizeof(buf), "%08x", v);
    return std::string(buf);
}

// ---------------------------------------------------------------------------
// Byte order
// ---------------------------------------------------------------------------

inline void WriteLE32(uint8_t* p, uint32_t v)
{
    p[0] = uint8_t(v);
    p[1] = uint8_t(v >> 8);
    p[2] = uint8_t(v >> 16);
    p[3] = uint8_t(v >> 24);
}

inline uint32_t ReadBE32(const uint8_t* p)
{
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
           (uint32_t(p[2]) << 8)  |  uint32_t(p[3]);
}

inline Bytes Reversed(const Bytes& in)
{
    return Bytes(in.rbegin(), in.rend());
}

/**
 * Turn the stratum prevhash into the 32 bytes the header wants.
 *
 * The pool sends reverseByteOrder(display_bytes): each 4-byte word swapped.
 * The header wants reverse(display_bytes): the whole 32 bytes reversed.
 *
 * Composing the two comes out as: keep each 4-byte word exactly as received,
 * but emit the eight words in reverse order. Deriving it rather than reversing
 * twice is what keeps this correct -- the two operations do not commute.
 */
inline bool StratumPrevHashToHeader(const Bytes& wire, uint8_t out[32])
{
    if (wire.size() != 32) return false;
    for (int word = 0; word < 8; word++) {
        std::memcpy(out + word * 4, wire.data() + (7 - word) * 4, 4);
    }
    return true;
}

// ---------------------------------------------------------------------------
// 256-bit targets
//
// Held as 32 big-endian bytes, so that comparing a hash to a target is a
// memcmp and nothing more.
// ---------------------------------------------------------------------------

struct Target {
    uint8_t bytes[32];

    bool operator<=(const Target& other) const
    {
        return std::memcmp(bytes, other.bytes, 32) <= 0;
    }
};

/** True when this proof of work satisfies the target. */
inline bool MeetsTarget(const uint8_t hashBE[32], const Target& target)
{
    return std::memcmp(hashBE, target.bytes, 32) <= 0;
}

/** A RandomX digest is little-endian; flip it so memcmp is the comparison. */
inline void PowHashToBigEndian(const uint8_t hashLE[32], uint8_t out[32])
{
    for (int i = 0; i < 32; i++) out[i] = hashLE[31 - i];
}

/**
 * Share difficulty -> target, using RandomX's diff-1 of 2^256 / 2^32.
 *
 * Mirrors pool/lib/util.js difficultyToTarget() exactly, including the
 * scale-by-2^32-first trick that keeps fractional vardiff difficulties from
 * collapsing to zero under integer division.
 */
inline Target DifficultyToTarget(double difficulty)
{
    Target t;

    if (!(difficulty > 0)) {                    // also catches NaN
        std::memset(t.bytes, 0xFF, 32);         // impossible to beat
        return t;
    }

    // DIFF1 << 32, as eight big-endian-ordered 32-bit limbs.
    uint32_t num[8] = { 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu,
                        0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0x00000000u };

    const double scaledF = std::round(difficulty * 4294967296.0);
    uint64_t scaled = (scaledF >= 18446744073709549568.0)
        ? 0xFFFFFFFFFFFFFFFFull
        : uint64_t(scaledF);
    if (scaled == 0) scaled = 1;

    // Long division, most significant limb first. The intermediate is at most
    // 96 bits, so a 128-bit accumulator is exact.
    uint32_t quot[8];
    unsigned __int128 rem = 0;
    for (int i = 0; i < 8; i++) {
        const unsigned __int128 cur = (rem << 32) | num[i];
        quot[i] = uint32_t(cur / scaled);
        rem     = cur % scaled;
    }

    for (int i = 0; i < 8; i++) {
        t.bytes[i * 4 + 0] = uint8_t(quot[i] >> 24);
        t.bytes[i * 4 + 1] = uint8_t(quot[i] >> 16);
        t.bytes[i * 4 + 2] = uint8_t(quot[i] >> 8);
        t.bytes[i * 4 + 3] = uint8_t(quot[i]);
    }
    return t;
}

/** nBits -> target, the compact encoding Bitcoin puts in the header. */
/**
 * The difficulty a set of nBits represents, for display.
 *
 * Bitcoin's definition: difficulty-1 target divided by this one. Computed in
 * floating point from the compact form because it is shown to a person, never
 * compared against a hash -- every comparison in this miner goes through
 * MeetsTarget on the 256-bit values.
 */
inline double ChainDifficulty(uint32_t bits)
{
    const int      shift    = int(bits >> 24);
    const double   mantissa = double(bits & 0x007fffffu);
    if (mantissa <= 0) return 0;
    double d = double(0x0000ffff) / mantissa;
    for (int i = 29; i > shift; i--) d *= 256.0;
    for (int i = shift; i > 29; i--) d /= 256.0;
    return d;
}

inline Target BitsToTarget(uint32_t bits)
{
    Target t;
    std::memset(t.bytes, 0, 32);

    const uint32_t exponent = bits >> 24;
    const uint32_t mantissa = bits & 0x007FFFFF;

    if (exponent <= 3) {
        const uint32_t shifted = mantissa >> (8 * (3 - exponent));
        t.bytes[29] = uint8_t(shifted >> 16);
        t.bytes[30] = uint8_t(shifted >> 8);
        t.bytes[31] = uint8_t(shifted);
        return t;
    }

    // The mantissa's three bytes sit so that its low byte lands at position
    // `exponent` counted from the bottom of the 32-byte string.
    const int lowIndex = 32 - int(exponent);
    for (int k = 0; k < 3; k++) {
        const int idx = lowIndex + k;            // k=0 is the mantissa's top byte
        if (idx < 0 || idx >= 32) continue;
        t.bytes[idx] = uint8_t(mantissa >> (8 * (2 - k)));
    }
    return t;
}

/** Approximate difficulty of a hash or target, for log lines only. */
inline double TargetToDifficulty(const uint8_t be[32])
{
    int i = 0;
    while (i < 32 && be[i] == 0) i++;
    if (i == 32) return std::numeric_limits<double>::infinity();

    long double value = 0;
    const int take = std::min(8, 32 - i);
    for (int k = 0; k < take; k++) value = value * 256.0L + be[i + k];
    value *= powl(2.0L, 8.0L * (32 - i - take));

    const long double diff1 = powl(2.0L, 224.0L) - 1.0L;
    return double(diff1 / value);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

inline int64_t NowMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

inline int64_t NowUnix()
{
    return std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

inline std::string HumanHashrate(double hs)
{
    char buf[64];
    if      (hs >= 1e9) std::snprintf(buf, sizeof(buf), "%.2f GH/s", hs / 1e9);
    else if (hs >= 1e6) std::snprintf(buf, sizeof(buf), "%.2f MH/s", hs / 1e6);
    else if (hs >= 1e3) std::snprintf(buf, sizeof(buf), "%.2f kH/s", hs / 1e3);
    else                std::snprintf(buf, sizeof(buf), "%.1f H/s",  hs);
    return std::string(buf);
}

} // namespace wam
