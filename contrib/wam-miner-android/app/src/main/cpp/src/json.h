// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  A minimal JSON reader, sized for stratum.
// ===========================================================================
//
//  Stratum is newline-delimited JSON-RPC and nothing more: objects, arrays,
//  strings, numbers, booleans, null. This parses exactly that.
//
//  It is deliberately strict. A miner talks to a pool it does not control, so
//  malformed input is a protocol error to be reported, not something to guess
//  around. Every accessor returns a default rather than throwing, so the call
//  sites stay readable; Parse() is the single place that reports failure.

#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace wam {
namespace json {

enum class Type { Null, Bool, Number, String, Array, Object };

class Value {
public:
    Type type = Type::Null;
    bool boolean = false;
    double number = 0;
    std::string string;
    std::vector<Value> array;
    std::map<std::string, Value> object;

    bool IsNull()   const { return type == Type::Null; }
    bool IsArray()  const { return type == Type::Array; }
    bool IsObject() const { return type == Type::Object; }
    bool IsString() const { return type == Type::String; }

    /** Object lookup. Returns a static null value when absent. */
    const Value& operator[](const std::string& key) const
    {
        static const Value kNull;
        if (type != Type::Object) return kNull;
        auto it = object.find(key);
        return it == object.end() ? kNull : it->second;
    }

    /** Array lookup, bounds-checked. */
    const Value& At(size_t i) const
    {
        static const Value kNull;
        if (type != Type::Array || i >= array.size()) return kNull;
        return array[i];
    }

    size_t Size() const { return type == Type::Array ? array.size() : 0; }

    std::string AsString(const std::string& fallback = "") const
    {
        return type == Type::String ? string : fallback;
    }

    double AsNumber(double fallback = 0) const
    {
        return type == Type::Number ? number : fallback;
    }

    int64_t AsInt(int64_t fallback = 0) const
    {
        return type == Type::Number ? int64_t(number) : fallback;
    }

    bool AsBool(bool fallback = false) const
    {
        if (type == Type::Bool)   return boolean;
        if (type == Type::Number) return number != 0;
        return fallback;
    }
};

// ---------------------------------------------------------------------------

class Parser {
public:
    explicit Parser(const std::string& text) : m_text(text) {}

    bool Parse(Value& out)
    {
        SkipSpace();
        if (!ParseValue(out)) return false;
        SkipSpace();
        if (m_pos != m_text.size()) {
            m_error = "trailing data after the JSON value";
            return false;
        }
        return true;
    }

    const std::string& Error() const { return m_error; }

private:
    void SkipSpace()
    {
        while (m_pos < m_text.size()) {
            const char c = m_text[m_pos];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') m_pos++;
            else break;
        }
    }

    bool Fail(const char* why) { m_error = why; return false; }

    bool ParseValue(Value& out)
    {
        if (++m_depth > 32) return Fail("JSON nested too deeply");
        const bool ok = ParseValueInner(out);
        m_depth--;
        return ok;
    }

    bool ParseValueInner(Value& out)
    {
        SkipSpace();
        if (m_pos >= m_text.size()) return Fail("unexpected end of input");

        switch (m_text[m_pos]) {
        case '{': return ParseObject(out);
        case '[': return ParseArray(out);
        case '"': out.type = Type::String; return ParseString(out.string);
        case 't':
            if (m_text.compare(m_pos, 4, "true") != 0) return Fail("bad literal");
            m_pos += 4; out.type = Type::Bool; out.boolean = true;  return true;
        case 'f':
            if (m_text.compare(m_pos, 5, "false") != 0) return Fail("bad literal");
            m_pos += 5; out.type = Type::Bool; out.boolean = false; return true;
        case 'n':
            if (m_text.compare(m_pos, 4, "null") != 0) return Fail("bad literal");
            m_pos += 4; out.type = Type::Null; return true;
        default:  return ParseNumber(out);
        }
    }

    bool ParseObject(Value& out)
    {
        out.type = Type::Object;
        m_pos++;                                    // '{'
        SkipSpace();
        if (m_pos < m_text.size() && m_text[m_pos] == '}') { m_pos++; return true; }

        for (;;) {
            SkipSpace();
            if (m_pos >= m_text.size() || m_text[m_pos] != '"') return Fail("expected a key");

            std::string key;
            if (!ParseString(key)) return false;

            SkipSpace();
            if (m_pos >= m_text.size() || m_text[m_pos] != ':') return Fail("expected ':'");
            m_pos++;

            Value child;
            if (!ParseValue(child)) return false;
            out.object[key] = std::move(child);

            SkipSpace();
            if (m_pos >= m_text.size()) return Fail("unterminated object");
            if (m_text[m_pos] == ',') { m_pos++; continue; }
            if (m_text[m_pos] == '}') { m_pos++; return true; }
            return Fail("expected ',' or '}'");
        }
    }

    bool ParseArray(Value& out)
    {
        out.type = Type::Array;
        m_pos++;                                    // '['
        SkipSpace();
        if (m_pos < m_text.size() && m_text[m_pos] == ']') { m_pos++; return true; }

        for (;;) {
            Value child;
            if (!ParseValue(child)) return false;
            out.array.push_back(std::move(child));

            SkipSpace();
            if (m_pos >= m_text.size()) return Fail("unterminated array");
            if (m_text[m_pos] == ',') { m_pos++; continue; }
            if (m_text[m_pos] == ']') { m_pos++; return true; }
            return Fail("expected ',' or ']'");
        }
    }

    bool ParseString(std::string& out)
    {
        m_pos++;                                    // opening quote
        out.clear();

        while (m_pos < m_text.size()) {
            const char c = m_text[m_pos++];

            if (c == '"') return true;

            if (c != '\\') { out.push_back(c); continue; }

            if (m_pos >= m_text.size()) return Fail("unterminated escape");
            const char esc = m_text[m_pos++];
            switch (esc) {
            case '"':  out.push_back('"');  break;
            case '\\': out.push_back('\\'); break;
            case '/':  out.push_back('/');  break;
            case 'b':  out.push_back('\b'); break;
            case 'f':  out.push_back('\f'); break;
            case 'n':  out.push_back('\n'); break;
            case 'r':  out.push_back('\r'); break;
            case 't':  out.push_back('\t'); break;
            case 'u': {
                if (m_pos + 4 > m_text.size()) return Fail("truncated \\u escape");
                unsigned code = 0;
                for (int i = 0; i < 4; i++) {
                    const char h = m_text[m_pos++];
                    code <<= 4;
                    if      (h >= '0' && h <= '9') code |= unsigned(h - '0');
                    else if (h >= 'a' && h <= 'f') code |= unsigned(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') code |= unsigned(h - 'A' + 10);
                    else return Fail("bad \\u escape");
                }
                // UTF-8 encode. Surrogate pairs are not stitched: nothing in
                // stratum carries astral-plane text, and a lone surrogate
                // becoming U+FFFD is better than a parser that guesses.
                if (code < 0x80) {
                    out.push_back(char(code));
                } else if (code < 0x800) {
                    out.push_back(char(0xC0 | (code >> 6)));
                    out.push_back(char(0x80 | (code & 0x3F)));
                } else {
                    out.push_back(char(0xE0 | (code >> 12)));
                    out.push_back(char(0x80 | ((code >> 6) & 0x3F)));
                    out.push_back(char(0x80 | (code & 0x3F)));
                }
                break;
            }
            default: return Fail("unknown escape character");
            }
        }
        return Fail("unterminated string");
    }

    bool ParseNumber(Value& out)
    {
        const size_t start = m_pos;
        if (m_pos < m_text.size() && (m_text[m_pos] == '-' || m_text[m_pos] == '+')) m_pos++;

        bool digits = false;
        while (m_pos < m_text.size()) {
            const char c = m_text[m_pos];
            if ((c >= '0' && c <= '9')) { digits = true; m_pos++; }
            else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') m_pos++;
            else break;
        }
        if (!digits) return Fail("expected a value");

        try {
            out.number = std::stod(m_text.substr(start, m_pos - start));
        } catch (...) {
            return Fail("malformed number");
        }
        out.type = Type::Number;
        return true;
    }

    const std::string& m_text;
    size_t      m_pos = 0;
    int         m_depth = 0;
    std::string m_error;
};

/** Parse one line. Returns false and fills `error` on malformed input. */
inline bool ParseLine(const std::string& line, Value& out, std::string& error)
{
    Parser p(line);
    if (p.Parse(out)) return true;
    error = p.Error();
    return false;
}

/** Escape a string for embedding in a request we build by hand. */
inline std::string Escape(const std::string& in)
{
    std::string out;
    out.reserve(in.size() + 8);
    for (const char c : in) {
        switch (c) {
        case '"':  out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n";  break;
        case '\r': out += "\\r";  break;
        case '\t': out += "\\t";  break;
        default:
            if (static_cast<unsigned char>(c) < 0x20) {
                static const char* kHex = "0123456789abcdef";
                out += "\\u00";
                out += kHex[(c >> 4) & 0xF];
                out += kHex[c & 0xF];
            } else {
                out.push_back(c);
            }
        }
    }
    return out;
}

} // namespace json
} // namespace wam
