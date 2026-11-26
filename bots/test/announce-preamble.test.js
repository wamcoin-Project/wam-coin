// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  announce-preamble.test.js -- the channels get the release, not the file's
//                               editing instructions
// ===========================================================================
//
//      node bots/test/announce-preamble.test.js
//
//  WHY THIS EXISTS
//
//  posts/<version>/TAG_MESSAGE.txt opens with four paragraphs addressed to
//  whoever edits it: "THIS IS THE FILE THE ANNOUNCEMENT BOT READS", the git
//  command, and the warning that the first two paragraphs are what the
//  channels see. A rule of dashes separates that from the release.
//
//  release.yml built the release body with `tail -n +2`, which drops the
//  title and keeps the preamble. announce.js then sends the first whole
//  paragraphs that fit in twelve lines, and the preamble costs exactly
//  twelve: 1, then 1+1, then 5+1, then 2+1.
//
//  So the Telegram and Discord announcements for v0.1.14 and v0.1.15 were
//  the editing instructions and "Full notes at the link below". Nothing
//  about either release reached anybody. Reported by Radenlingga on
//  2026-11-26.
//
//  The two things meant to catch it -- docs/RELEASING.md's render command
//  and test_announcement_covers_release.py -- split the tag file on the
//  dashes first, so they rendered a body production never built. That is
//  the fault this file is shaped against: it starts from the tag file and
//  the workflow's own construction, and asserts on what comes out the far
//  end.
// ===========================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'bots', 'announce.js'));
const { toPlain } = require(path.join(ROOT, 'bots', 'lib', 'markup.js'));

let pass = 0;
const fail = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  \x1b[32mok\x1b[0m    ${name}`); }
    catch (e) { fail.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${e.message}`); }
}

/** What .github/workflows/release.yml hands the bot: the tag message
 *  without its first line. The preamble is still in it; dropping that is
 *  the bot's job, and this is the point of the test. */
function workflowBody(file) {
    return fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n');
}

function sent(file, tag) {
    return toPlain(A.releaseMessage({
        tag, name: `WAM Coin ${tag}`,
        url: `https://wamcoin.org/releases/${tag}`,
        body: workflowBody(file), prerelease: true
    }));
}

const posts = path.join(ROOT, 'posts');
const tags = fs.readdirSync(posts)
    .filter((d) => /^v\d+\.\d+\.\d+$/.test(d))
    .filter((d) => fs.existsSync(path.join(posts, d, 'TAG_MESSAGE.txt')))
    .sort();

console.log('\n\x1b[1m  the channels get the release, not the preamble\x1b[0m\n');

assert.ok(tags.length > 0, 'no tag messages were found to check');

for (const tag of tags) {
    const file = path.join(posts, tag, 'TAG_MESSAGE.txt');
    const out = sent(file, tag);

    test(`${tag}: no editing instruction reaches the channel`, () => {
        for (const giveaway of [
            'THIS IS THE FILE THE ANNOUNCEMENT BOT READS',
            'Read the warning before editing',
            'git tag -a',
            'Nobody reviews',
            'Everything after them is for the release page'
        ]) {
            assert.ok(!out.includes(giveaway),
                `the announcement contains "${giveaway}" -- that paragraph is `
                + 'addressed to whoever edits the tag file, not to the channel');
        }
    });

    test(`${tag}: the release's own first paragraph is in it`, () => {
        const raw = fs.readFileSync(file, 'utf8');
        const i = raw.split('\n').findIndex((l) => /^-{20,}\s*$/.test(l));
        assert.ok(i >= 0, 'the tag file has no rule of dashes under its preamble');
        // A MANDATORY: line is lifted out of the body and printed above the
        // title, so it is not the opening the channel reads. Skip past it
        // and any paragraph of the tag file's own warning about it.
        const paras = raw.split('\n').slice(i + 1).join('\n')
            .replace(/^\s*\n+/, '').split('\n\n')
            .map((p) => p.trim()).filter(Boolean)
            .filter((p) => !/^MANDATORY:/.test(p)
                        && !/^THERE IS NO MANDATORY/.test(p));
        const first = (paras[0] || '').split('\n')[0].trim();
        assert.ok(first.length > 0, 'nothing follows the rule of dashes');
        assert.ok(out.includes(first.slice(0, 40)),
            `the announcement does not contain the release's opening line:\n`
            + `        ${first.slice(0, 70)}`);
    });

    test(`${tag}: it says more than "full notes at the link"`, () => {
        // The whole failure, reduced to one number: a preamble-only
        // announcement had nothing between the title and that sentence.
        const marker = 'Full notes at the link below.';
        const head = out.split(marker)[0];
        const words = head.split(/\s+/).filter(Boolean).length;
        assert.ok(words > 40,
            `only ${words} words reached the channel before "${marker}" -- `
            + 'that is a release announced by its own filing instructions');
    });
}

console.log();
if (fail.length) {
    console.log(`\x1b[31m\x1b[1m  ${fail.length} failed\x1b[0m`);
    for (const f of fail) console.log(`        ${f}`);
    process.exit(1);
}
console.log(`\x1b[32m\x1b[1m  ${pass} passed across ${tags.length} release(s)\x1b[0m\n`);
