// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  A self-contained SHA-256.
// ===========================================================================
//
//  A miner is a binary that strangers download and run. Every dependency it
//  carries is one more thing they have to trust, and one more thing that can
//  fail to build on their machine. SHA-256 is 150 lines, so it lives here
//  rather than pulling in OpenSSL for two calls.
//
//  It is used only for the merkle root and the block id -- never for proof of
//  work, which is RandomX. Speed is therefore irrelevant: this runs once per
//  job, not once per nonce.

#pragma once

#include <cstdint>
#include <cstddef>
#include <cstring>

namespace wam {

class SHA256 {
public:
    SHA256() { Reset(); }

    void Reset()
    {
        m_h[0] = 0x6a09e667; m_h[1] = 0xbb67ae85;
        m_h[2] = 0x3c6ef372; m_h[3] = 0xa54ff53a;
        m_h[4] = 0x510e527f; m_h[5] = 0x9b05688c;
        m_h[6] = 0x1f83d9ab; m_h[7] = 0x5be0cd19;
        m_buflen = 0;
        m_total  = 0;
    }

    void Update(const uint8_t* data, size_t len)
    {
        m_total += len;

        if (m_buflen > 0) {
            size_t take = 64 - m_buflen;
            if (take > len) take = len;
            std::memcpy(m_buf + m_buflen, data, take);
            m_buflen += take;
            data += take;
            len  -= take;
            if (m_buflen == 64) {
                Transform(m_buf);
                m_buflen = 0;
            }
        }

        while (len >= 64) {
            Transform(data);
            data += 64;
            len  -= 64;
        }

        if (len > 0) {
            std::memcpy(m_buf, data, len);
            m_buflen = len;
        }
    }

    void Final(uint8_t out[32])
    {
        const uint64_t bits = m_total * 8;

        // The 0x80 terminator, then zeros, then the length -- always landing
        // on a 64-byte boundary.
        uint8_t pad[72];
        std::memset(pad, 0, sizeof(pad));
        pad[0] = 0x80;
        const size_t padlen = (m_buflen < 56) ? (56 - m_buflen) : (120 - m_buflen);
        Update(pad, padlen);
        m_total -= padlen;      // padding is not message length

        uint8_t lenbuf[8];
        for (int i = 0; i < 8; i++) lenbuf[i] = uint8_t(bits >> (56 - i * 8));
        Update(lenbuf, 8);

        for (int i = 0; i < 8; i++) {
            out[i * 4 + 0] = uint8_t(m_h[i] >> 24);
            out[i * 4 + 1] = uint8_t(m_h[i] >> 16);
            out[i * 4 + 2] = uint8_t(m_h[i] >> 8);
            out[i * 4 + 3] = uint8_t(m_h[i]);
        }
    }

private:
    static uint32_t Ror(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

    void Transform(const uint8_t* chunk)
    {
        static const uint32_t K[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
            0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
            0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
            0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
            0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        };

        uint32_t w[64];
        for (int i = 0; i < 16; i++) {
            w[i] = (uint32_t(chunk[i * 4 + 0]) << 24) | (uint32_t(chunk[i * 4 + 1]) << 16) |
                   (uint32_t(chunk[i * 4 + 2]) << 8)  |  uint32_t(chunk[i * 4 + 3]);
        }
        for (int i = 16; i < 64; i++) {
            const uint32_t s0 = Ror(w[i - 15], 7) ^ Ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = Ror(w[i - 2], 17) ^ Ror(w[i - 2], 19)  ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }

        uint32_t a = m_h[0], b = m_h[1], c = m_h[2], d = m_h[3];
        uint32_t e = m_h[4], f = m_h[5], g = m_h[6], h = m_h[7];

        for (int i = 0; i < 64; i++) {
            const uint32_t S1    = Ror(e, 6) ^ Ror(e, 11) ^ Ror(e, 25);
            const uint32_t ch    = (e & f) ^ (~e & g);
            const uint32_t temp1 = h + S1 + ch + K[i] + w[i];
            const uint32_t S0    = Ror(a, 2) ^ Ror(a, 13) ^ Ror(a, 22);
            const uint32_t maj   = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t temp2 = S0 + maj;

            h = g; g = f; f = e; e = d + temp1;
            d = c; c = b; b = a; a = temp1 + temp2;
        }

        m_h[0] += a; m_h[1] += b; m_h[2] += c; m_h[3] += d;
        m_h[4] += e; m_h[5] += f; m_h[6] += g; m_h[7] += h;
    }

    uint32_t m_h[8];
    uint8_t  m_buf[64];
    size_t   m_buflen;
    uint64_t m_total;
};

/** Bitcoin's SHA256d: SHA256(SHA256(x)). */
inline void SHA256d(const uint8_t* data, size_t len, uint8_t out[32])
{
    uint8_t first[32];
    SHA256 a; a.Update(data, len); a.Final(first);
    SHA256 b; b.Update(first, 32); b.Final(out);
}

/** SHA256d over two concatenated 32-byte hashes -- one merkle step. */
inline void SHA256dPair(const uint8_t left[32], const uint8_t right[32], uint8_t out[32])
{
    uint8_t joined[64];
    std::memcpy(joined, left, 32);
    std::memcpy(joined + 32, right, 32);
    SHA256d(joined, 64, out);
}

/** Plain SHA256, used to derive the RandomX bootstrap key. */
inline void SHA256Once(const uint8_t* data, size_t len, uint8_t out[32])
{
    SHA256 h; h.Update(data, len); h.Final(out);
}

} // namespace wam
