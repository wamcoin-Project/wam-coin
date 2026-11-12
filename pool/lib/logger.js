'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

// ===========================================================================
//  A LOG LINE IS ONE LINE, AND THAT IS NOT A FORMATTING PREFERENCE
// ===========================================================================
//
//  _write built the line by interpolating `message` verbatim and appending a
//  newline. Nothing in between removed anything. So any string that reached
//  a log call carrying a newline did not produce one log line; it produced
//  two, and the second one was written by whoever supplied the string.
//
//  On a mining pool that string is supplied by strangers. mining.authorize
//  happens before any authentication, and the stratum server logs both the
//  address it was given and the worker label. A label of
//
//      "a\n2026-11-11 08:00:00 [ERROR]"
//
//  put the line `2026-11-11 08:00:00 [ERROR]` in the operator's log, by
//  itself, in this logger's exact format -- a timestamped error that no code
//  in this repository wrote.
//
//  Nothing is stolen by that, and the log is not decoration. It is the record
//  an operator reads to find out whether miners were paid, and this project
//  has used it exactly that way: the payment path writes banners to it and
//  this file's own history is a list of faults found by reading it. A stranger
//  who can add lines to it can manufacture an incident, or bury a real one
//  under a hundred forged ones, from an unauthenticated TCP connection.
//
//  Reported by 0xpack (managementpackaging@gmail.com) on 11 November 2026,
//  with a self-contained reproduction that drives this logger and the real
//  stratum server over a loopback port.
//
//  THE FIX IS HERE AND NOT AT THE CALL SITES, which is the reporter's own
//  recommendation and the right one. There are forty-odd log calls in this
//  pool and more will be written; a rule that each must remember is a rule
//  that is kept until somebody is in a hurry. One line cannot become two
//  after this function, so no call site can reintroduce it.
//
//  WHAT IS REPLACED, AND WHY EACH ONE
//
//    C0 controls (00-1f) and DEL      -- newline and carriage return forge a
//                                        line; ESC starts an ANSI sequence
//                                        that can repaint or erase what an
//                                        operator sees in a terminal; the
//                                        rest are not text.
//    C1 controls (80-9f)              -- a second escape vocabulary, which
//                                        some terminals still honour.
//    U+2028, U+2029                   -- Unicode line and paragraph
//                                        separators. Not newlines to `wc -l`,
//                                        and newlines to plenty of editors
//                                        and log viewers.
//    U+202A-202E, U+2066-U+2069       -- the bidirectional overrides. They
//                                        change nothing in the bytes and
//                                        reverse what a reader sees, so a
//                                        line can display as the opposite of
//                                        what it says. Cheaper to refuse than
//                                        to reason about.
//
//  Each becomes a printable escape rather than being dropped, because a line
//  that silently loses characters is a line that lies about what arrived.
// Built from a string, not written as a regex literal: two of the
// characters it names ARE line separators, and writing them as literals in
// this file put a line break inside the pattern and stopped the module
// loading. The class of character this function exists for, demonstrating
// itself in the source of the function.
const FORBIDDEN = new RegExp('[' + '\u0000-\u001f\u007f-\u009f' + '\u2028\u2029\u202a-\u202e\u2066-\u2069' + ']', 'g');
const NAMED = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\u001b': '\\e' };

// Long enough for every banner this pool writes, short enough that a stranger
// cannot turn one connection into a 16 KB log line. The stratum reader caps a
// message at 16384 bytes, and the address inside it was logged whole.
const MAX_FIELD = 2000;

/** One line, whatever was handed in. */
function oneLine(value) {
    const s = String(value);
    const clipped = s.length > MAX_FIELD
        ? `${s.slice(0, MAX_FIELD)}...[${s.length} chars]`
        : s;
    return clipped.replace(FORBIDDEN, (ch) =>
        NAMED[ch] || `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

class Logger {
    constructor(options = {}) {
        this.level = LEVELS[options.level || 'info'];
        this.useColor = process.stdout.isTTY && options.color !== false;
        this.stream = null;

        if (options.file) {
            fs.mkdirSync(path.dirname(options.file), { recursive: true });
            this.stream = fs.createWriteStream(options.file, { flags: 'a' });
        }
    }

    _write(level, component, message) {
        if (LEVELS[level] < this.level) return;

        const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
        const line = `${ts} [${level.toUpperCase().padEnd(5)}] `
                   + `[${oneLine(component)}] ${oneLine(message)}`;

        if (this.useColor) {
            console.log(`${COLORS[level]}${line}${RESET}`);
        } else {
            console.log(line);
        }
        // The file always gets the uncoloured line -- escape codes in a log file
        // that ops will grep are pure noise.
        if (this.stream) this.stream.write(line + '\n');
    }

    debug(c, m) { this._write('debug', c, m); }
    info(c, m)  { this._write('info', c, m); }
    warn(c, m)  { this._write('warn', c, m); }
    error(c, m) { this._write('error', c, m); }

    /** Bind a component name so call sites read log.info('...') */
    scope(component) {
        return {
            debug: (m) => this.debug(component, m),
            info:  (m) => this.info(component, m),
            warn:  (m) => this.warn(component, m),
            error: (m) => this.error(component, m)
        };
    }
}

module.exports = Logger;
module.exports.oneLine = oneLine;
module.exports.MAX_FIELD = MAX_FIELD;
