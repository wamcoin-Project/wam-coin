// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  address.h -- a WAM address to the script that pays it
// ===========================================================================
//
//  The miner never needed this while it only spoke stratum: it hands the
//  address to the pool as a string and the pool builds the coinbase. Mining
//  alone means building the coinbase here, and that means turning the address
//  into a scriptPubKey.
//
//  WHY THIS IS THE PART TO GET RIGHT
//
//  Every other mistake in solo mining announces itself: a bad header is
//  rejected, a bad template is refused, a lost connection reconnects. A wrong
//  output script is accepted by everybody. The block is valid, the chain takes
//  it, and fifty coins are paid to nothing at all -- with no error, at any
//  point, ever. The only symptom is a balance that never arrives.
//
//  So this is a transcription of pool/lib/util.js, which has built the
//  coinbase for every block this pool has found, and it is tested against
//  vectors below rather than trusted.
//
//  WHAT IT ACCEPTS
//
//      wam1...    bech32   witness v0    P2WPKH (20) / P2WSH (32)
//      wam1...    bech32m  witness v1+   P2TR and later
//      W...       base58   P2PKH         version byte 73
//      w...       base58   P2SH          version byte 135
//
//  Anything else throws. A miner who pasted a Bitcoin address is told so by
//  name rather than being handed "invalid base58 character".
// ===========================================================================

#pragma once

#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "sha256.h"
#include "util.h"

namespace wam {

// ---------------------------------------------------------------------------
// bech32
// ---------------------------------------------------------------------------

static const char* kBech32Charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

inline uint32_t Bech32Polymod(const std::vector<uint8_t>& values)
{
    static const uint32_t kGen[5] = {0x3b6a57b2u, 0x26508e6du, 0x1ea119fau,
                                     0x3d4233ddu, 0x2a1462b3u};
    uint32_t chk = 1;
    for (uint8_t v : values) {
        const uint32_t top = chk >> 25;
        chk = ((chk & 0x1ffffffu) << 5) ^ v;
        for (int i = 0; i < 5; i++) {
            if ((top >> i) & 1u) chk ^= kGen[i];
        }
    }
    return chk;
}

inline std::vector<uint8_t> Bech32HrpExpand(const std::string& hrp)
{
    std::vector<uint8_t> out;
    out.reserve(hrp.size() * 2 + 1);
    for (char c : hrp) out.push_back(uint8_t(uint8_t(c) >> 5));
    out.push_back(0);
    for (char c : hrp) out.push_back(uint8_t(uint8_t(c) & 31));
    return out;
}

/**
 * Regroup bits, as BIP173 specifies. Used here only to go from the 5-bit
 * data characters to the 8-bit witness program.
 */
inline bool ConvertBits(const std::vector<uint8_t>& in, int fromBits,
                        int toBits, bool pad, std::vector<uint8_t>& out)
{
    uint32_t acc = 0;
    int bits = 0;
    const uint32_t maxv = (uint32_t(1) << toBits) - 1;
    for (uint8_t value : in) {
        if ((value >> fromBits) != 0) return false;
        acc = (acc << fromBits) | value;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            out.push_back(uint8_t((acc >> bits) & maxv));
        }
    }
    if (pad) {
        if (bits) out.push_back(uint8_t((acc << (toBits - bits)) & maxv));
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
        return false;   // leftover bits must be zero padding and nothing more
    }
    return true;
}

// ---------------------------------------------------------------------------
// base58check
// ---------------------------------------------------------------------------

inline bool Base58Decode(const std::string& s, std::vector<uint8_t>& out)
{
    static const char* kAlphabet =
        "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    std::vector<uint8_t> num;          // big-endian base-256 accumulator
    for (char c : s) {
        const char* p = std::strchr(kAlphabet, c);
        if (!p || c == '\0') return false;
        int carry = int(p - kAlphabet);
        for (size_t i = num.size(); i-- > 0;) {
            const int v = int(num[i]) * 58 + carry;
            num[i] = uint8_t(v & 0xff);
            carry  = v >> 8;
        }
        while (carry) {
            num.insert(num.begin(), uint8_t(carry & 0xff));
            carry >>= 8;
        }
    }
    // Leading '1's are leading zero bytes, which the arithmetic above drops.
    size_t zeros = 0;
    while (zeros < s.size() && s[zeros] == '1') zeros++;
    out.assign(zeros, 0);
    out.insert(out.end(), num.begin(), num.end());
    return true;
}

// ---------------------------------------------------------------------------

struct NetAddressParams {
    std::string hrp;          // "wam", "twam", "wamrt"
    uint8_t     pubkey  = 0;  // base58 version byte for P2PKH
    uint8_t     script  = 0;  // base58 version byte for P2SH
};

/** mainnet / testnet / regtest, from src/wam/chainparams.cpp. */
inline NetAddressParams NetParamsFor(const std::string& network)
{
    if (network == "testnet") return {"twam", 65, 128};
    // regtest shares testnet's version bytes. kernel/chainparams.cpp sets
    // PUBKEY_ADDRESS 65 and SCRIPT_ADDRESS 128 for both. This said 100 and
    // 196 -- Bitcoin's values, carried over and never checked against our
    // own node -- so the miner refused every legacy regtest address the node
    // hands out. It went unseen because the regtest gates mine to a
    // wamrt1... address, which never reaches the version byte at all.
    if (network == "regtest") return {"wamrt", 65, 128};
    return {"wam", 73, 135};
}

/**
 * The witness script for a bech32/bech32m address, or a thrown
 * std::runtime_error naming what is wrong with it.
 *
 * Split out of AddressToScript so that a failure here can be caught and
 * reconsidered rather than ending the attempt. See the call site.
 */
inline Bytes Bech32ToScript(const std::string& address)
{
    std::string lower = address;
    for (char& c : lower) c = char(std::tolower((unsigned char)c));

    {
        if (address != lower) {
            std::string upper = address;
            for (char& c : upper) c = char(std::toupper((unsigned char)c));
            if (address != upper) {
                throw std::runtime_error("bech32 address mixes upper and lower case");
            }
        }
        if (lower.size() < 8 || lower.size() > 90) {
            throw std::runtime_error("bech32 address length is out of range");
        }

        const size_t sep = lower.rfind('1');
        if (sep < 1 || sep + 7 > lower.size()) {
            throw std::runtime_error("bech32 separator is missing or misplaced");
        }
        const std::string hrp = lower.substr(0, sep);

        std::vector<uint8_t> data;
        for (size_t i = sep + 1; i < lower.size(); i++) {
            const char* p = std::strchr(kBech32Charset, lower[i]);
            if (!p) {
                throw std::runtime_error(std::string("'") + lower[i] +
                                         "' is not a bech32 character");
            }
            data.push_back(uint8_t(p - kBech32Charset));
        }
        if (data.size() < 7) throw std::runtime_error("bech32 payload is too short");

        std::vector<uint8_t> values = Bech32HrpExpand(hrp);
        values.insert(values.end(), data.begin(), data.end());

        const uint32_t chk     = Bech32Polymod(values);
        const uint8_t  version = data[0];
        const uint32_t want    = (version == 0) ? 1u : 0x2bc830a3u;   // bech32 / bech32m

        if (chk != want) {
            throw std::runtime_error(
                "bech32 checksum failed -- the address is mistyped, or it is a "
                "witness version that needs the other checksum");
        }
        if (version > 16) throw std::runtime_error("witness version is out of range");

        std::vector<uint8_t> program;
        std::vector<uint8_t> payload(data.begin() + 1, data.end() - 6);
        if (!ConvertBits(payload, 5, 8, false, program)) {
            throw std::runtime_error("bech32 payload is not a whole number of bytes");
        }
        if (program.size() < 2 || program.size() > 40) {
            throw std::runtime_error("witness program length is invalid");
        }
        if (version == 0 && program.size() != 20 && program.size() != 32) {
            throw std::runtime_error("a witness v0 program must be 20 or 32 bytes");
        }

        Bytes script;
        script.push_back(version == 0 ? 0x00 : uint8_t(0x50 + version));
        script.push_back(uint8_t(program.size()));
        script.insert(script.end(), program.begin(), program.end());
        return script;
    }
}

/**
 * The locking script that pays `address`, or a thrown std::runtime_error
 * naming what is wrong with it.
 */
inline Bytes AddressToScript(const std::string& address,
                             const NetAddressParams& net)
{
    std::string lower = address;
    for (char& c : lower) c = char(std::tolower((unsigned char)c));

    // THE HRP PREFIX IS BECH32-ONLY, AND THE RULE IS THE NODE'S, NOT OURS.
    //
    // key_io.cpp, DecodeDestination:
    //
    //     bool is_bech32 = (ToLower(str.substr(0, params.Bech32HRP().size()))
    //                       == params.Bech32HRP());
    //     if (!is_bech32 && DecodeBase58Check(str, data, 21)) { ... }
    //
    // Three characters, case-insensitive, and no '1' required. When they
    // match, the node never attempts base58. So a valid base58check address
    // beginning "wam", "WAM", "WaM" and so on is one the node calls invalid
    // -- about 1 in 1,700 legacy mainnet addresses.
    //
    // This file used hrp + "1", which is narrower, so the miner would build a
    // coinbase paying an address the node refuses to parse. In solo mining
    // that block is still valid and the coins are still paid: to a script the
    // operator's own wallet cannot recognise as his. Nothing would report it
    // except a balance that never arrives.
    //
    // Matching the node exactly is the only safe answer. The node is what
    // pays; being more permissive than it is a debt that cannot be settled.
    const bool isBech32Prefix =
        lower.size() >= net.hrp.size() &&
        lower.compare(0, net.hrp.size(), net.hrp) == 0;

    if (isBech32Prefix) {
        try {
            return Bech32ToScript(address);
        } catch (const std::exception& e) {
            // A real base58 address that merely starts with the prefix is
            // told what is actually wrong. "bech32 checksum failed" sends an
            // operator hunting for a typo in an address that has none.
            std::vector<uint8_t> probe;
            if (Base58Decode(address, probe) && probe.size() == 25) {
                uint8_t p1[32], p2[32];
                SHA256d(probe.data(), 21, p1);
                std::memcpy(p2, p1, 32);
                if (std::memcmp(p2, probe.data() + 21, 4) == 0) {
                    throw std::runtime_error(
                        "that is valid base58check, but it begins with '" +
                        address.substr(0, net.hrp.size()) + "'. The node reads any "
                        "address starting with '" + net.hrp + "' as bech32 and never "
                        "tries base58, so it would call this address invalid and "
                        "could not pay it. Generate another one.");
                }
            }
            throw;
        }
    }

    // ---- base58check ------------------------------------------------------
    //
    // TRIED BEFORE the "is this somebody else's bech32" guess, and the order
    // is the whole point.
    //
    // That guess asks whether there is a '1' with only bech32 characters
    // after it. The treasury address lower-cased is
    // wdmmqw1dcgwz6htyjuemdce6qkkg4ragme -- it has a '1', and every character
    // after it happens to be in the bech32 alphabet. Asked first, the guess
    // rejected this project's own treasury address as belonging to another
    // chain. The address test caught it on the first run.
    //
    // base58check decides instead of guessing: it carries a checksum, and a
    // real bech32 address cannot survive it -- the base58 alphabet has no
    // '0', '1', 'i' or 'l', which segwit addresses are full of. So decode
    // first, and only describe the address if the decode fails.
    std::vector<uint8_t> raw;
    const bool b58 = Base58Decode(address, raw) && raw.size() == 25;

    if (!b58) {
        const size_t other = lower.rfind('1');
        if (other != std::string::npos && other >= 1 && other + 7 <= lower.size() &&
            lower.find_first_not_of("qpzry9x8gf2tvdw0s3jn54khce6mua7l", other + 1) ==
                std::string::npos) {
            const std::string hrp = lower.substr(0, other);
            std::string who = "another chain";
            if (hrp == "bc")   who = "Bitcoin mainnet";
            if (hrp == "tb")   who = "Bitcoin testnet";
            if (hrp == "bcrt") who = "Bitcoin regtest";
            if (hrp == "ltc")  who = "Litecoin";
            throw std::runtime_error("that is a " + who + " address (prefix '" + hrp +
                                     "'), not a WAM one. Expected '" + net.hrp + "1...'");
        }
        throw std::runtime_error("the address is neither a valid " + net.hrp +
                                 "1... bech32 address nor valid base58check");
    }

    uint8_t h1[32], h2[32];
    SHA256d(raw.data(), 21, h1);
    std::memcpy(h2, h1, 32);
    if (std::memcmp(h2, raw.data() + 21, 4) != 0) {
        throw std::runtime_error("base58 checksum failed -- the address is mistyped");
    }

    const uint8_t version = raw[0];
    const uint8_t* hash160 = raw.data() + 1;

    Bytes script;
    if (version == net.pubkey) {
        // OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
        script = {0x76, 0xa9, 0x14};
        script.insert(script.end(), hash160, hash160 + 20);
        script.push_back(0x88);
        script.push_back(0xac);
    } else if (version == net.script) {
        // OP_HASH160 <20> OP_EQUAL
        script = {0xa9, 0x14};
        script.insert(script.end(), hash160, hash160 + 20);
        script.push_back(0x87);
    } else {
        throw std::runtime_error(
            "address version byte " + std::to_string(int(version)) +
            " belongs to another network; this one uses " +
            std::to_string(int(net.pubkey)) + " and " +
            std::to_string(int(net.script)));
    }
    return script;
}

}   // namespace wam
