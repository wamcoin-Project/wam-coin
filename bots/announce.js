#!/usr/bin/env node
'use strict';
// Copyright (c) 2026 The WAM Coin developers
// Distributed under the MIT software license, see COPYING.
//
// ===========================================================================
//  The WAM announcement bot
// ===========================================================================
//
//      node bots/announce.js [--config FILE] [--once] [--dry-run]
//
//  WHAT IT IS FOR
//  --------------
//  The founder of this project does not make public statements. That is a
//  deliberate position and a defensible one, but it leaves a channel with
//  nothing in it, and a silent channel reads as a dead project.
//
//  So the chain speaks instead. Everything this bot posts is a number read
//  from a node over RPC, which anyone can check against their own node. No
//  opinions, no promises, no price -- and nothing that requires a human to
//  write it.
//
//  WHAT IT POSTS
//  -------------
//      a heartbeat        once a day: height, hashrate, supply, next halving
//      halvings           the moment the block subsidy changes
//      key rotations      when the RandomX epoch turns over
//      releases           when a new version is published on GitHub
//      milestones         round heights and round millions of supply
//
//  and to the OPERATOR only, never to the public channel:
//
//      stalls             when no block has arrived for too long
//      recoveries         when they start arriving again
//
//  Stalls used to be public, on the reasoning that a channel which only
//  carries good news is advertising while one that reports its own outages is
//  a source. That reasoning holds for a live chain and this is not one yet.
//
//  Measured over the channel's whole life to 4 September 2026: 147 posts, 21
//  of them the daily heartbeat and 126 the chain reporting that it had
//  stopped. Eighty-six per cent of everything WAM had ever said in public was
//  "no new block for an hour" -- about a test network whose entire hashrate is
//  one laptop and one server, which therefore stops whenever the founder's
//  power does. It informed nobody and taught every reader that the project
//  stops constantly.
//
//  The alert still fires, every time, and still reaches a person within a
//  minute. It goes to the operator's own chat. Nothing is silenced, and when
//  mainnet is live this belongs in public again.
//
//  It does NOT post commits. Anyone who wants those has GitHub's Watch button,
//  and a stream of "fix X" messages tells a non-developer that a project is
//  unstable when the opposite is true.
//
//  WHERE IT POSTS
//  --------------
//  Telegram, Discord, or both -- whichever the config names. Every message is
//  written once in the neutral markup from lib/markup.js and rendered per
//  service on the way out, so the two channels can never drift apart in
//  content, and a message added later needs no work to reach both.
//
//  Discord is reached through a webhook rather than a bot token. A webhook can
//  post to one channel and do nothing else: it cannot read messages, list
//  members, or touch another channel. An announcement needs none of those, and
//  a credential that cannot do them cannot be made to.

const fs = require('fs');
const path = require('path');

const { NodeRpc, latestRelease } = require('./lib/clients');
const { buildSinks, TelegramSink } = require('./lib/sinks');
const { loadConfig, resolveConfig } = require('./lib/config');
const { b, i, t, code, kbd, toTelegram, toDiscord, toPlain } = require('./lib/markup');

const COIN = 100000000;

// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = { config: null, once: false, dry: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--config' && argv[i + 1]) out.config = argv[++i];
        else if (argv[i] === '--once') out.once = true;
        else if (argv[i] === '--dry-run') out.dry = true;
        else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    }
    return out;
}


// ---------------------------------------------------------------------------
// State. A flat file, written atomically: the bot must never announce the same
// halving twice because it was restarted at the wrong moment.
// ---------------------------------------------------------------------------

function loadState(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(file, state) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const num = (n) => Number(n).toLocaleString('en-US');

function wam(sat, dp = 2) {
    const v = Number(sat) / COIN;
    // Below the chosen precision, widen rather than render a real amount as
    // "0.00" -- deep into the halvings the subsidy is a handful of satoshi.
    if (v !== 0 && Math.abs(v) < 1 / 10 ** dp) {
        return v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    }
    return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function hashrate(hs) {
    if (!hs || hs <= 0) return '0 H/s';
    const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'];
    let i = 0;
    while (hs >= 1000 && i < units.length - 1) { hs /= 1000; i++; }
    return `${hs.toFixed(2)} ${units[i]}`;
}

function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const d = Math.floor(seconds / 86400);
    if (d >= 365) return `~${(d / 365).toFixed(1)} years`;
    if (d >= 1)   return `~${d} days`;
    const h = Math.floor(seconds / 3600);
    if (h >= 1)   return `~${h} hours`;
    return `~${Math.max(1, Math.round(seconds / 60))} minutes`;
}

// ---------------------------------------------------------------------------
// Reading the chain
// ---------------------------------------------------------------------------

async function snapshot(rpc) {
    // getsupplyinfo carries the emission; the RandomX epoch lives in its own
    // RPC. Reaching for randomx_seedheight in getsupplyinfo, where it does not
    // exist, meant key rotations were silently never announced.
    const [chain, mining, supply, randomx] = await Promise.all([
        rpc.call('getblockchaininfo'),
        rpc.call('getmininginfo').catch(() => ({})),
        rpc.call('getsupplyinfo').catch(() => null),
        rpc.call('getrandomxinfo').catch(() => null)
    ]);

    const tipHeader = await rpc.call('getblockheader', [chain.bestblockhash]).catch(() => null);

    // Everything about emission comes from the node. Recomputing the halving
    // schedule locally is the mistake this project has now made four times.
    return {
        height: chain.blocks,
        chainName: chain.chain,
        difficulty: chain.difficulty,
        hashrate: mining.networkhashps || 0,
        tipTime: tipHeader ? tipHeader.time : null,
        supply,
        randomx
    };
}

// ---------------------------------------------------------------------------
// Messages
//
// Built in the neutral markup: b() for bold, i() for italic, t() for anything
// that came from outside this file. No service is named here, and none of these
// functions can produce broken output on one service while working on another.
// ---------------------------------------------------------------------------

/**
 * Which chain these numbers describe.
 *
 * Not decoration. A channel published before launch shows testnet figures, and
 * a reader who assumes they are mainnet concludes the coin is already live at
 * height 198. Every message says which chain it came from, and anything that
 * is not mainnet says so loudly enough that it cannot be skimmed past.
 */
function networkLabel(chainName) {
    switch (chainName) {
    case 'main':    return null;                          // no banner needed
    case 'test':    return `\u{1F9EA} ${b('TESTNET')} — coins here have no value`;
    case 'regtest': return `\u{1F527} ${b('REGTEST')} — a private test chain`;
    default:        return `⚠️ ${b(String(chainName).toUpperCase())}`;
    }
}

function heartbeat(s, cfg) {
    const sup = s.supply || {};
    const banner = networkLabel(s.chainName);
    const lines = [
        `\u{1F7E2} ${b('WAM Network')}`,
        ...(banner ? [banner] : []),
        ``,
        `${b('Height')}        ${num(s.height)}`,
        `${b('Hashrate')}      ${hashrate(s.hashrate)}`
    ];

    if (sup.block_subsidy !== undefined) {
        const subsidy = Math.round(Number(sup.block_subsidy) * COIN);
        const treasury = Math.round(Number(sup.treasury_subsidy || 0) * COIN);
        lines.push(`${b('Block reward')}  ${wam(subsidy)} WAM` +
                   (treasury > 0 ? `  (${wam(subsidy - treasury)} miner + ${wam(treasury)} treasury)` : ''));
    }

    if (sup.circulating !== undefined && sup.max_supply !== undefined) {
        const pct = (Number(sup.circulating) / Number(sup.max_supply) * 100).toFixed(2);
        lines.push(`${b('Supply')}        ${num(Math.round(Number(sup.circulating)))} / ` +
                   `${num(Math.round(Number(sup.max_supply)))}  (${pct}%)`);
    }

    // Do not promise a halving that can no longer happen. Once the subsidy has
    // decayed to zero the node still reports a next_halving_height, but there
    // is nothing left to halve.
    const subsidySat = sup.block_subsidy !== undefined
        ? Math.round(Number(sup.block_subsidy) * COIN) : null;

    if (subsidySat === 0) {
        lines.push(`${b('Emission')}      complete — miners are paid by fees alone`);
    } else if (sup.blocks_until_halving > 0) {
        lines.push(`${b('Next halving')}  in ${num(sup.blocks_until_halving)} blocks ` +
                   `(${duration(sup.blocks_until_halving * 120)})`);
    }

    const rx = s.randomx;
    if (rx && rx.blocks_until_rotation > 0) {
        lines.push(`${b('RandomX key')}   rotates in ${num(rx.blocks_until_rotation)} blocks`);
    }

    if (cfg.explorerUrl) lines.push(``, t(cfg.explorerUrl));
    return lines.join('\n');
}

function halvingMessage(before, after, height) {
    return [
        `⛏ ${b('The block reward has halved')}`,
        ``,
        `At height ${num(height)} the subsidy went from`,
        `${b(wam(before) + ' WAM')} to ${b(wam(after) + ' WAM')}.`,
        ``,
        `This is written into consensus and happens every 200,000 blocks.`,
        `No decision was taken and none could be.`
    ].join('\n');
}

function rotationMessage(seedHeight, height) {
    return [
        `\u{1F511} ${b('RandomX key rotated')}`,
        ``,
        `From height ${num(height)} the proof-of-work key is derived from`,
        `block ${num(seedHeight)}.`,
        ``,
        `Every miner rebuilds its dataset now; a brief dip in network`,
        `hashrate over the next few minutes is expected, not a fault.`
    ].join('\n');
}

/**
 * Turn a GitHub release body into marked-up message text.
 *
 * The body is Markdown written for GitHub's own renderer. It used to be passed
 * through untouched, which is why the v0.1.1 announcement arrived on Telegram
 * showing three literal backticks above and below the verification command:
 * Telegram messages are sent as HTML, where a fence means nothing at all.
 *
 * Fenced blocks become code() and inline spans become kbd(), so each service
 * renders them in its own syntax. Every branch below emits a matched pair of
 * marks, so an unbalanced fence in someone's release note -- or a body cut off
 * mid-block by the line limit -- can never leave a tag hanging open.
 */
function fromMarkdown(text) {
    // Odd indexes are the insides of fenced blocks; even indexes are prose.
    return String(text || '')
        .split(/```[a-zA-Z0-9_-]*\n?/)
        .map((part, idx) => {
            if (idx % 2 === 1) return code(part.replace(/\n+$/, ''));
            // Same alternation again, for single-backtick spans in prose.
            return part.split(/`([^`\n]+)`/)
                .map((seg, j) => (j % 2 === 1 ? kbd(seg) : t(seg)))
                .join('');
        })
        .join('');
}

// A release whose notes begin a line with "MANDATORY:" is one that changes a
// consensus rule. Everything after the colon, on that line, is the reason.
//
//     MANDATORY: every earlier release enforces a different treasury address
//
// WHY THIS EXISTS
//
// v0.1.5 changed the mainnet treasury address, which is consensus. A node
// left on v0.1.4 will reject every valid block on 15 September and fork
// itself off at height 1 -- and it will not say so. It syncs, it mines, it
// reports itself healthy, alone on a chain nobody else is on.
//
// The bot announced that release in exactly the tone it announces every
// other: "a new version exists, here is how to verify it". It cannot tell
// the difference, because nothing told it. Somebody then has to remember to
// write the warning by hand, and the day they forget is the day it matters.
//
// So the release notes carry the distinction and the bot repeats it loudly.
const MANDATORY = /^[ \t>*_]*MANDATORY:[ \t]*(.+)$/im;

// The project's own download page, and every place the source is published.
//
// Both are overridable from the environment so that moving a host is a
// config change. The last move was not: it took thirty-two files.
const DOWNLOADS_URL = process.env.WAM_DOWNLOADS_URL
    || 'https://wamcoin.org/downloads/';
// The second name, empty on purpose, named before it is needed. See the block
// that prints it for why a message nobody can edit must carry both.
const RESERVE_URL = process.env.WAM_RESERVE_URL || 'https://wamcoin.net';

const SOURCES = (process.env.WAM_SOURCES || [
    'https://gitlab.com/WAMCoin/wam-coin',
    'https://github.com/wamcoin-Project/wam-coin',
    'https://gitea.com/WAMCoin/wam-coin',
].join(',')).split(',').map((x) => x.trim()).filter(Boolean);


/**
 * Is the published release actually signed, and does the signature cover what
 * is on the page?
 *
 * This calls scripts/check_release_signed.sh rather than verifying in JS, on
 * purpose. That script is the project's one definition of the question -- it
 * asks GitHub what the release carries, downloads SHA256SUMS and its
 * signature, and checks them against the fingerprint in SECURITY.md. A second
 * implementation here would be a second answer to the same question, and this
 * repository has been bitten three times by one fact living in two places.
 *
 * Its exit codes are this project's convention:
 *     0  verified
 *     1  a finding -- it is published and it does not verify
 *     2  the check could not run (no curl, no gpg, GitHub unreachable)
 *
 * 2 is not a pass and is not a finding. It returns ok:false with a reason
 * that says so, and the caller neither announces nor records the tag, so the
 * question is asked again on the next tick.
 */
function verifyPublishedRelease(tag, scriptPath) {
    const script = scriptPath
        || path.join(__dirname, '..', 'scripts', 'check_release_signed.sh');
    if (!fs.existsSync(script)) {
        return { ok: false, reason: `check_release_signed.sh is not at ${script}, `
                                    + `so nothing could be verified.` };
    }
    let r;
    try {
        // 180s: it downloads two small files over whatever link the host has.
        r = require('child_process').spawnSync('bash', [script, tag], {
            timeout: 180000, encoding: 'utf8'
        });
    } catch (e) {
        return { ok: false, reason: `could not run the check: ${e.message}` };
    }
    if (r.error) return { ok: false, reason: `could not run the check: ${r.error.message}` };
    if (r.status === 0) return { ok: true, reason: 'verified' };

    // The script's own words, stripped of colour, are more use than a summary
    // of them -- it names which asset is wrong.
    const said = String((r.stdout || '') + (r.stderr || ''))
        .replace(/\[[0-9;]*m/g, '')
        .split('\n').filter((l) => /FAIL|!!|could not/i.test(l))
        .slice(0, 4).map((l) => l.trim()).join('\n');

    return {
        ok: false,
        reason: (r.status === 2
                 ? 'The check could not run, which is not a pass:\n'
                 : 'check_release_signed.sh says:\n') + (said || `exit ${r.status}`)
    };
}

/**
 * The first whole paragraphs of a release body that fit inside `maxLines`.
 *
 * Paragraphs are separated by a blank line, which is how the release notes in
 * this repository are written. A paragraph that would not fit is left out
 * entirely rather than cut, and if anything was left out the caller is told in
 * the text, because silence there is what produced a truncated sentence.
 *
 * If the very first paragraph is longer than the budget there is nothing to be
 * done but cut it -- at a line, never inside one -- since a message with no
 * body at all would be worse.
 */
function headParagraphs(text, maxLines) {
    const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (!paras.length) return '';

    const kept = [];
    let lines = 0;
    for (const p of paras) {
        const n = p.split('\n').length;
        // +1 for the blank line between paragraphs, once there is one to
        // separate from.
        const cost = n + (kept.length ? 1 : 0);
        if (lines + cost > maxLines) break;
        kept.push(p);
        lines += cost;
    }

    if (!kept.length) {
        kept.push(paras[0].split('\n').slice(0, maxLines).join('\n'));
    }

    if (kept.length < paras.length) {
        kept.push('Full notes at the link below.');
    }
    return kept.join('\n\n');
}


function releaseMessage(release) {
    const raw = String(release.body || '');
    const flag = raw.match(MANDATORY);

    // The marker line is removed from the body it is quoted from, so the
    // reason is not printed twice.
    const cleaned = flag ? raw.replace(MANDATORY, '').replace(/^\s*\n/, '') : raw;

    // Truncated by line before conversion, never after: the marks are single
    // characters and slicing a rendered string can cut one off from its pair.
    //
    // And truncated at a PARAGRAPH boundary, not at line 12.
    //
    // A flat slice(0, 12) cut every release this project has published in the
    // middle of a sentence, and twice in the middle of a word. v0.1.9's
    // announcement ended "On 15 September there was no h" -- in every channel,
    // to everybody, automatically. A message that stops mid-word reads as
    // broken software, which is a strange thing to advertise in the post
    // announcing the software.
    //
    // So: take whole paragraphs while they fit, and if anything was left
    // behind say so rather than trailing off. The release URL is printed
    // below regardless, so the rest is always one click away.
    const body = fromMarkdown(headParagraphs(cleaned, 12));

    return [
        flag
            // Above the title, not below it: a warning under the fold is a
            // warning nobody read.
            ? `\u{26A0}\u{FE0F} ${b('UPDATE REQUIRED')} \u{2014} ${b(release.name || release.tag)}`
            : `\u{1F680} ${b(release.name || release.tag)}`,
        ...(flag ? [
            ``,
            b('This release changes a consensus rule.'),
            t(flag[1].trim()),
            t('A node left on an earlier version will be rejected by the network '
              + 'and will not be told. It keeps running, and mines a chain with '
              + 'nobody else on it.'),
        ] : []),
        // Said plainly rather than left for the reader to notice on the page.
        // Every release before 1.0 is a pre-release, and a channel that
        // announces one without saying so is describing the project as further
        // along than it is.
        // "Pre-release" on GitHub means pre-1.0, and that is what this line
        // must say. It used to say "testnet software", which was true until
        // 2026-09-15 and false from the moment mainnet started -- so every
        // mainnet release since has been announced to every channel as testnet
        // software, automatically, by us. The flag did not change meaning; the
        // chain did, and this sentence did not follow it.
        ...(release.prerelease
            ? [i('Pre-1.0 — the chain is live, the software is still young.')]
            : []),
        ``,
        body,
        ``,
        // Where to get it, and it is not one place.
        //
        // This printed the release page and nothing else. On 2026-09-24 that
        // page's account was suspended and every announcement this bot had
        // ever posted became a link to a 404 -- in channels, permanently,
        // where nobody can go back and edit them.
        //
        // So the download line is our own domain, served from machines this
        // project owns, and the source is named in all three places it is
        // published. A reader who finds one of them gone does not have to ask
        // anybody where to go next.
        // AND THE NAME THAT IS HELD IN RESERVE, WHICH WAS MISSING.
        //
        // The reasoning above goes one level short. It moved the download
        // line off a host account and onto our own domain -- and then named
        // that domain alone, in a message that cannot be edited afterwards.
        // wamcoin.net exists for the day wamcoin.org does not, and
        // CHANNELS.txt revision 5 gives the reason: a name that first appears
        // during an outage cannot be told from an impostor's, and an outage
        // is exactly when a reader can check least. It has to be written
        // where people already are, before it is needed. Every release
        // announcement this bot has sent named one domain.
        ...(DOWNLOADS_URL ? [b('Download'), t(DOWNLOADS_URL), ``] : []),
        b('Source, in three places'),
        ...SOURCES.map((u) => t(u)),
        ``,
        ...(RESERVE_URL ? [b('If this project\'s name is ever lost, it moves here and nowhere else'),
                           t(RESERVE_URL), ``] : []),
        t(release.url),
        ``,
        i('Verify the checksums before you run it.')
    ].join('\n');
}

function milestoneMessage(kind, value) {
    if (kind === 'height') {
        return `\u{1F4CD} ${b('Block ' + num(value))}\n\nThe chain has reached height ${num(value)}.`;
    }
    return `\u{1F4CD} ${b(num(value) + ' WAM mined')}\n\nOut of a hard cap of 22,000,000.`;
}

function stallMessage(minutes, height) {
    return [
        `\u{1F534} ${b('No new block for ' + minutes + ' minutes')}`,
        ``,
        `The chain is still at height ${num(height)}. The target is one block`,
        `every two minutes.`,
        ``,
        `This usually means the network hashrate has dropped. It is posted`,
        `here because a channel that only reports good news is advertising.`
    ].join('\n');
}

function recoveredMessage(height, minutes) {
    return `\u{1F7E2} ${b('Blocks are arriving again')}\n\nHeight ${num(height)}, after ${minutes} minutes.`;
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

/**
 * Put the chain banner on every message, and carry the operator-only marking
 * across as it goes.
 *
 * Every event message carries the banner, not just the heartbeat. A halving
 * announcement is the message most likely to be screenshotted and forwarded,
 * and it is the one where "which chain?" matters most.
 *
 * THE SECOND HALF OF THIS IS WHY IT IS A FUNCTION
 *
 * This rewrites each message, which makes a NEW string. result.opsOnly is a
 * Set of the OLD ones, so after this ran every operator-only message failed
 * its lookup in the send loop and was published to the channel anyway.
 *
 * That is exactly what happened on 4 September 2026: stalls went out publicly
 * at 07:51, 08:51, 09:51 and 09:52, hours after the routing was deployed and
 * while bots/test/routing.test.js reported six passes. The test called tick()
 * and checked the marking there -- it never reached this line. A test that
 * stops one layer above the bug proves the bug is absent, in the layer that
 * does not have it.
 *
 * It is exported so the test can exercise the composition rather than the
 * half of it that was already right.
 */
function applyBanner(result) {
    const banner = networkLabel(result.snapshot && result.snapshot.chainName);
    if (!banner) return result;
    const remarked = new Set();
    result.messages = result.messages.map((m) => {
        const out = m.includes(banner) ? m : `${banner}\n\n${m}`;
        if (result.opsOnly && result.opsOnly.has(m)) remarked.add(out);
        return out;
    });
    result.opsOnly = remarked;
    return result;
}


async function tick(cfg, rpc, state, log) {
    const s = await snapshot(rpc);
    const now = Date.now();
    const out = [];
    // Messages that go to the operator instead of the public channel.
    // A Set of the exact strings pushed, rather than a new message shape,
    // because bots/test/messages.test.js calls stallMessage() directly and
    // expects a string back.
    const opsOnly = new Set();

    const sup = s.supply || {};
    const subsidy = sup.block_subsidy !== undefined
        ? Math.round(Number(sup.block_subsidy) * COIN) : null;

    // ---- halving -----------------------------------------------------------
    if (subsidy !== null && state.lastSubsidy !== undefined && subsidy !== state.lastSubsidy) {
        // Only announce a decrease. An increase would mean the node changed
        // chains under us, which is a bug report, not an announcement.
        if (subsidy < state.lastSubsidy) {
            out.push(halvingMessage(state.lastSubsidy, subsidy, s.height));
        } else {
            log(`subsidy went UP (${state.lastSubsidy} -> ${subsidy}); not announcing`);
        }
    }
    if (subsidy !== null) state.lastSubsidy = subsidy;

    // ---- RandomX key -------------------------------------------------------
    const seedHeight = s.randomx ? s.randomx.seed_height : null;
    if (seedHeight !== null && state.lastSeedHeight !== undefined && seedHeight !== state.lastSeedHeight) {
        out.push(rotationMessage(seedHeight, s.height));
    }
    if (seedHeight !== null) state.lastSeedHeight = seedHeight;

    // ---- milestones --------------------------------------------------------
    const seen = new Set(state.milestonesSeen || []);
    for (const h of cfg.milestoneHeights) {
        if (s.height >= h && !seen.has(`h${h}`)) {
            // Do not shout about milestones the chain passed while the bot was
            // switched off; only ones crossed since the last observation.
            if (state.lastHeight !== undefined && state.lastHeight < h) {
                out.push(milestoneMessage('height', h));
            }
            seen.add(`h${h}`);
        }
    }
    state.milestonesSeen = [...seen];

    // ---- stall -------------------------------------------------------------
    //
    // These go to the operator, not to the public channel.
    //
    // Measured on 4 September 2026, over the channel's whole life: 147 posts,
    // of which 21 were the daily heartbeat and 126 were the chain reporting
    // that it had stopped. Eighty-six per cent of everything WAM has ever said
    // in public was "no new block for an hour".
    //
    // The original reasoning still stands for a live chain -- a channel that
    // only carries good news is advertising, and an operator should learn
    // about a stalled chain from the same place everyone else does. But this
    // is a TEST network whose entire hashrate is the founder's laptop and one
    // server, so it stops whenever his power does, which in Libya is most
    // days. Publishing that 126 times does not inform anybody; it teaches a
    // reader that the project stops constantly, which is true of the test
    // chain and says nothing about the one that launches on 15 September.
    //
    // So the alert still fires, still every time, and still reaches a person
    // within a minute -- it goes to the operator's own chat. Nothing is
    // silenced. When mainnet is live this belongs in public again, and the
    // line below is the only thing that has to change.
    if (s.height === state.lastHeight) {
        const stalledFor = Math.round((now - (state.lastHeightAt || now)) / 60000);
        if (stalledFor >= cfg.stallMinutes && !state.stallAnnounced) {
            const m = stallMessage(stalledFor, s.height);
            out.push(m); opsOnly.add(m);
            state.stallAnnounced = true;
        }
    } else {
        if (state.stallAnnounced) {
            const wasDown = Math.round((now - (state.lastHeightAt || now)) / 60000);
            // Same audience as the stall it answers: telling the public a
            // chain recovered, when they were never told it stopped, reads
            // as an announcement about nothing.
            const r = recoveredMessage(s.height, wasDown);
            out.push(r); opsOnly.add(r);
            state.stallAnnounced = false;
        }
        state.lastHeight = s.height;
        state.lastHeightAt = now;
    }

    // ---- releases ----------------------------------------------------------
    if (cfg.githubRepo) {
        const release = await latestRelease(cfg.githubRepo);
        if (release && release.tag && release.tag !== state.lastReleaseTag) {
            // Nothing is said about a release until what the world can
            // actually download has been verified.
            //
            // On 12 September v0.1.8 was published with the Windows archives
            // added by hand. SHA256SUMS.asc was uploaded and SHA256SUMS was
            // not replaced, so the signature covered a four-line list and the
            // page carried the runner's two-line one. This bot announced it to
            // Telegram and Discord SIXTY-ONE SECONDS later, and for as long as
            // that stood, every reader who followed our own instructions was
            // told:
            //
            //     FAIL  the signature over SHA256SUMS is NOT valid
            //           Do not run the binaries.
            //
            // Which is the verifier working correctly and is the worst sentence
            // a coin project can put in front of a stranger. The upload is a
            // manual step -- check_release_signed.sh has said in its own header
            // since it was written that manual steps get half-done -- and the
            // detector for exactly this existed the whole time and ran only
            // when somebody ran the sweep.
            //
            // So the announcement waits for it. Deliberately fail-closed: an
            // unverifiable release is not announced at all, the tag is NOT
            // marked as seen, and the operator is told. When the page is fixed
            // the next tick announces it normally, once.
            const v = verifyPublishedRelease(release.tag);

            if (v.ok) {
                // The first observation is not news: it is whatever was already
                // published before the bot existed.
                if (state.lastReleaseTag !== undefined) out.push(releaseMessage(release));
                state.lastReleaseTag = release.tag;
            } else if (state.releaseHeldTag !== release.tag) {
                // Once per tag, to the operator, not to the public. Repeating
                // it every minute would bury it in its own noise.
                state.releaseHeldTag = release.tag;
                const m = [
                    `\u{1F6D1} ${b('a release was published that does not verify')}`,
                    ``,
                    t(`${release.tag} is on the releases page and has NOT been announced.`),
                    t(v.reason),
                    ``,
                    t('Nothing was said in the channels, and nothing will be until '
                      + 'this passes. Check it by hand with:'),
                    code(`bash scripts/check_release_signed.sh ${release.tag}`),
                    ``,
                    t('The usual cause is a half-finished upload: SHA256SUMS.asc '
                      + 'replaced while SHA256SUMS was not, or an archive named in '
                      + 'the list that was never attached.')
                ].join('\n');
                out.push(m); opsOnly.add(m);
            }
        }
    }

    // ---- heartbeat ---------------------------------------------------------
    //
    // At a fixed hour, not "heartbeatHours since the last one".
    //
    // The interval version drifts. Every restart of this bot -- a reboot, a
    // deploy, a crash -- pushes the daily post later by however long it was
    // down, and it never comes back. By 2 September the post was landing at
    // 04:53 UTC, which is before dawn where the founder is, so the channel
    // looked silent to him for a whole day while the bot was working
    // perfectly. He watches this channel to see that the test network is
    // alive, and other people in it do the same. A daily post nobody is awake
    // for does not do that job.
    //
    // A fixed hour also makes silence mean something. If the post is due at a
    // known time and does not arrive, that is a fact anyone in the channel can
    // notice, without knowing anything about the machine.
    const beatHour = cfg.heartbeatHourUtc ?? 12;
    const last = state.lastHeartbeatAt || 0;
    const d = new Date(now);
    const dueToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
                              beatHour, 0, 0);
    // Due if today's slot has passed and nothing has been sent since it. The
    // "since it" is what stops a restart at 12:05 from posting a second time.
    if (now >= dueToday && last < dueToday) {
        out.push(heartbeat(s, cfg));
        state.lastHeartbeatAt = now;
    } else if (last && now - last >= 36 * 3600 * 1000) {
        // A machine that was off across its slot would otherwise wait for
        // tomorrow. Thirty-six hours of silence in a public channel is long
        // enough to look like a dead project, so it speaks late rather than
        // not at all.
        out.push(heartbeat(s, cfg));
        state.lastHeartbeatAt = now;
    }
    state.nextHeartbeatDueAt = (now >= dueToday ? dueToday + 86400000 : dueToday);

    return { messages: out, opsOnly, snapshot: s };
}

// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);

    if (args.help) {
        console.log('usage: node bots/announce.js [--config FILE] [--once] [--dry-run]');
        return 0;
    }

    const configFile = resolveConfig(args.config);

    const cfg = loadConfig(configFile);
    const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    const log = (m) => console.log(`${stamp()}  ${m}`);

    const rpc = new NodeRpc(cfg.node);
    const sinks = buildSinks(cfg);

    // A second Telegram sink pointed at the operator's own chat, for the
    // messages that must not be published. Same token, different room.
    let opsSink = null;
    if (cfg.opsChatId && cfg.telegram && cfg.telegram.token) {
        opsSink = new TelegramSink({ token: cfg.telegram.token,
                                     chatId: cfg.opsChatId });
    }
    const state = loadState(cfg.stateFile);

    log(`WAM announcement bot`);
    log(`node      ${cfg.node.host}:${cfg.node.port}`);
    log(`channels  ${sinks.map((s) => s.name).join(', ')}`);
    log(`daily post at ${String(cfg.heartbeatHourUtc).padStart(2, '0')}:00 UTC, stall alert after ${cfg.stallMinutes}m`);
    if (args.dry) log(`DRY RUN -- messages are printed, not sent`);

    const runOnce = async () => {
        let result;
        try {
            result = await tick(cfg, rpc, state, log);
        } catch (err) {
            log(`could not read the node: ${err.message}`);
            return;
        }

        // Every event message carries the chain banner, not just the
        // heartbeat. A halving announcement is the message most likely to be
        // screenshotted and forwarded, and it is the one where "which chain?"
        // matters most. The heartbeat adds its own, so it is skipped here.
        applyBanner(result);

        // A dry run must not touch the state file. It did once, and the effect
        // was exactly the wrong shape: the operator tested the bot, saw the
        // message it *would* send, and then the real run announced nothing --
        // because the test had already marked it as announced.
        //
        // A rehearsal that changes the thing it is rehearsing is not a
        // rehearsal.
        if (args.dry) {
            for (const message of result.messages) {
                for (const [service, render] of [['telegram', toTelegram], ['discord', toDiscord]]) {
                    console.log(`\n---8<--- ${service}\n` + render(message) + '\n--->8---');
                }
            }
            if (result.messages.length === 0) {
                log(`height ${result.snapshot.height}, nothing to announce`);
            }
            log('dry run: the state file was not written');
            return;
        }

        for (const message of result.messages) {
            const label = toPlain(message).split('\n')[0];

            // Operator-only messages go to one place and are not published.
            // If there is no ops chat configured they are logged and dropped
            // rather than falling through to the public channel -- a message
            // marked private must never be published by a missing setting.
            if (result.opsOnly && result.opsOnly.has(message)) {
                if (opsSink) {
                    try {
                        await opsSink.send(message);
                        log(`sent to the operator (${label})`);
                    } catch (err) {
                        log(`operator send failed: ${err.message}`);
                    }
                } else {
                    log(`operator-only, and no opsChatId is set -- NOT sent (${label})`);
                }
                continue;
            }

            // Each channel independently. One service being down, rate limited
            // or misconfigured must not cost the announcement on the other --
            // and must not stop the loop, since the next message may be the
            // one that matters most.
            for (const sink of sinks) {
                try {
                    await sink.send(message);
                    log(`sent to ${sink.name} (${label})`);
                } catch (err) {
                    log(`${sink.name} send failed: ${err.message}`);
                }
            }
        }

        saveState(cfg.stateFile, state);
        if (result.messages.length === 0) {
            log(`height ${result.snapshot.height}, nothing to announce`);
        }
    };

    await runOnce();
    if (args.once) return 0;

    setInterval(runOnce, cfg.pollSeconds * 1000);

    const shutdown = (sig) => {
        log(`${sig} received, saving state`);
        saveState(cfg.stateFile, state);
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    return new Promise(() => {});
}

module.exports = {
    heartbeat, halvingMessage, rotationMessage, releaseMessage, headParagraphs,
    milestoneMessage, stallMessage, recoveredMessage, networkLabel, applyBanner,
    loadConfig, tick, num, wam, hashrate, duration,
    verifyPublishedRelease
};

if (require.main === module) {
    main().then((code) => {
        if (typeof code === 'number' && code !== 0) process.exit(code);
    }).catch((err) => {
        console.error(err.stack || err.message);
        process.exit(1);
    });
}
