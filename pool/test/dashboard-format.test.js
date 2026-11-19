'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  dashboard-format.test.js -- what the page prints, where it can be asked
// ===========================================================================
//
//  WHAT THIS GUARDS
//
//  Four defects in pool/web/app.js, reported by Radenlingga on 14 November
//  2026 and reproduced twice against the live site:
//
//    the Difficulty column printed "0" for every miner on the page
//    the pending badge counted to 100 while crediting happens at 101
//    two unguarded dereferences could take the whole dashboard down
//    sixty-four connections of one machine were sixty-four identical rows
//
//  app.js runs in a browser and this suite has no DOM. What it can do is
//  drive the pure parts -- which is exactly why the difficulty formatter was
//  pulled out of three places into one -- and read the rest as source, which
//  is weaker and is marked as such.
//
//  The formatter case is the one that matters. The page already had this
//  fix, once, on the network tile, with a comment explaining it; two other
//  call sites were written without it. A single function is the only reason
//  a fourth call site cannot be written the same way.
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GRN = '\x1b[32m', RED = '\x1b[31m', BLD = '\x1b[1m', OFF = '\x1b[0m';
let pass = 0;
const fail = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  ${GRN}ok${OFF}    ${name}`); }
    catch (e) { fail.push(name); console.log(`  ${RED}FAIL${OFF}  ${name}\n        ${e.message}`); }
}

const APP = path.join(__dirname, '..', 'web', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

/**
 * The same file with its full-line comments removed.
 *
 * A CHECK THAT LOOKS FOR THE DEFECT FINDS THE COMMENT ABOUT THE DEFECT.
 *
 * This file's fixes carry comments quoting the broken line they replaced,
 * because the next reader needs to see what was wrong with it. A test that
 * asserts the broken line is GONE then reads its own documentation and
 * reports the fix as missing -- which is what happened here, and what
 * happened to scripts/check_signature_verification.py against deploy.sh,
 * and to submit-verdict.test.js against a comment naming the node's own
 * vocabulary. Three times is a pattern, so this is the house answer:
 * full-line comments are stripped, which leaves every quoted defect free to
 * stay quoted. Trailing comments are left alone -- nothing here needs them,
 * and removing them means deciding whether `//` inside a URL is a comment.
 */
const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

/**
 * Lift one top-level function out of the page and run it here.
 *
 * Not a copy: the text is read from app.js on every run, so a change to the
 * page is a change to what this tests. A copy would have gone stale the
 * first time somebody edited the real one -- which is how the difficulty fix
 * came to exist in one place and not the other two.
 */
function lift(name) {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `pool/web/app.js no longer defines ${name}()`);
    let depth = 0, i = src.indexOf('{', at);
    const start = i;
    do {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    } while (depth > 0 && i < src.length);
    const body = src.slice(at, i);
    const ctx = { module: {} };
    vm.createContext(ctx);
    vm.runInContext(`${body}; module.exports = ${name};`, ctx);
    return ctx.module.exports;
}

(async () => {
    console.log(`\n${BLD}  what the page prints${OFF}\n`);

    const difficulty = lift('difficulty');

    test('a vardiff value is a number, not "0"', () => {
        // The live range on 14 November 2026, measured across 270 rows.
        for (const d of [1e-6, 5e-6, 7.7e-6, 1.2e-5, 7.7e-5]) {
            const shown = difficulty(d);
            assert.notStrictEqual(shown, '0',
                `difficulty ${d} prints as "0" -- that is every miner on the `
                + 'page, and the column carries no information at all');
            assert.ok(/[1-9]/.test(shown),
                `difficulty ${d} prints as ${JSON.stringify(shown)}, which has `
                + 'no significant digit in it');
        }
    });

    test('and the network difficulty still prints as it did', () => {
        // This one was already right, with a comment saying why. The point of
        // one function is that it stayed right.
        assert.notStrictEqual(difficulty(0.00024414), '0');
        assert.strictEqual(difficulty(0), '0');
    });

    test('a large difficulty does not grow a tail', () => {
        // ASKED IN WHATEVER LOCALE THIS RUNS IN.
        //
        // The page prints integers in the reader's own locale -- block
        // heights, blocks-to-halving, all of them -- and pins only WAM
        // amounts to en-US. difficulty() follows the integers, so the
        // separators here are whatever the host decided: this machine
        // formats 123456.79 as "123.456,79". A test that read /\.\d{3}/
        // called that a three-digit fraction and failed, on a correct
        // function, because it had assumed a decimal point.
        const sep = new Intl.NumberFormat().formatToParts(1.5)
            .find((p) => p.type === 'decimal').value;
        const shown = difficulty(123456.789);
        const frac = shown.split(sep)[1] || '';
        assert.ok(frac.length <= 2,
            `${shown} carries ${frac.length} fraction digits; a difficulty `
            + 'column is read at a glance, not audited');
    });

    test('a missing or broken difficulty is a dash, not a crash', () => {
        for (const bad of [undefined, null, NaN, 'abc', {}]) {
            assert.strictEqual(difficulty(bad), '—',
                `difficulty(${JSON.stringify(bad)}) should be a dash`);
        }
    });

    // ---- the three that need the page itself -----------------------------
    //
    // Read as source. That is weaker than running it and is said plainly:
    // these pin the shape, and the shape is what regressed.

    test('the pending badge counts to the height a block is credited at', () => {
        assert.ok(!/\$\{b\.confirmations \?\? 0\}\/100`/.test(code),
            'the badge still counts to 100. A coinbase is spendable at 101 -- '
            + 'the pool credits there, after crediting at 100 once left 47.5 '
            + 'WAM between what was owed and what could be sent -- so a block '
            + 'at exactly 100 showed a full bar while it was not yet credited');
        assert.ok(/\/\$\{MATURITY\}/.test(code),
            'the badge no longer counts to the named constant');
        assert.ok(/MATURITY\s*=\s*101/.test(code),
            'the denominator is no longer named, so the next reader cannot '
            + 'tell what it counts to');
    });

    test('the seed height is read without dereferencing what may be absent', () => {
        assert.ok(!/\(rx\.seedHeight \?\? '—'\)\.toLocaleString \?/.test(code),
            "the ?? guards the TEST and not the call: with seedHeight absent "
            + "the test asks whether '—' has toLocaleString -- it does -- and "
            + 'the branch then dereferences undefined, which the surrounding '
            + 'handler reports as the whole dashboard being unreachable');
        assert.ok(/typeof seed === 'number' && Number\.isFinite\(seed\)/.test(code),
            'nothing establishes that seed is a number before a method is '
            + 'called on it');
    });

    test('a health payload with no problems list does not take the page down', () => {
        assert.ok(!/text\(\$\('healthText'\), h\.problems\.join/.test(code),
            'h.problems is joined without being checked, so one missing field '
            + 'turns into a dashboard that reports itself unreachable');
        assert.ok(/Array\.isArray\(h\.problems\)/.test(code),
            'nothing checks the shape of problems before using it');
    });

    test('the miners table can tell two connections of one machine apart', () => {
        assert.ok(/cell\(tr, m\.id == null \? '—' : String\(m\.id\)/.test(code),
            'the table renders only the redacted worker label, so a miner '
            + 'running one process per core is 64 rows a reader cannot tell '
            + 'apart -- measured at 270 rows for 166 labels, with one label '
            + 'appearing 64 times. The payload already carried a per-'
            + 'connection id and nothing printed it.');
        const header = fs.readFileSync(
            path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
        assert.ok(/<th class="num">Conn<\/th>/.test(header),
            'the column has no header');
    });

    console.log();
    if (fail.length) {
        console.log(`${RED}${BLD}${fail.length} failed${OFF}, ${pass} passed`);
        fail.forEach((f) => console.log(`  - ${f}`));
        process.exit(1);
    }
    console.log(`${GRN}${BLD}  ${pass} checks: the page says what it knows${OFF}\n`);
})();
