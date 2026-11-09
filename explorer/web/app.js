'use strict';
/* WAM Network Dashboard
   Copyright (c) 2026 The WAM Coin developers -- MIT

   Polls /api/status and repaints. Dependency-free: the page that tells you the
   node is down must not itself depend on a CDN being up.

   Every value that came off the wire is written with textContent, never
   innerHTML. Block hashes and node subversion strings are attacker-influenced. */

const COIN = 1e8;
const REFRESH_MS = 6000;

const $ = (id) => document.getElementById(id);
const text = (el, v) => { if (el) el.textContent = v; };

// ---------------------------------------------------------------- format

function wam(sat, dp = 2) {
  if (sat === null || sat === undefined) return '—';

  // Two decimals is right for ordinary amounts and a lie for small ones: deep
  // into the halvings a block reward of 74 satoshi renders as "0.00 WAM",
  // which reads as "nothing" rather than "something small". Widen rather than
  // round away a number someone is checking.
  if (sat !== 0 && Math.abs(sat) < COIN / 10 ** dp) {
    return (sat / COIN).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  }

  return (sat / COIN).toLocaleString('en-US',
    { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function hashrate(hs) {
  if (!hs || hs <= 0) return '0 H/s';
  const u = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let i = 0;
  while (hs >= 1000 && i < u.length - 1) { hs /= 1000; i++; }
  return `${hs.toFixed(hs < 10 ? 2 : 1)} ${u[i]}`;
}

function bytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function duration(sec) {
  if (sec === null || sec === undefined || !isFinite(sec)) return '—';
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  const d = Math.floor(sec / 86400);
  // Days AND hours, not days alone.
  //
  // Everything below a day is printed to the minute and then, at exactly the
  // point where the number starts to mean "is that node gone or not", the
  // resolution drops to 24 hours and rounds DOWN. A /WAM:0.1.5/ machine last
  // seen 44.8 hours ago was shown as "seen 1d ago" -- nearly two days
  // reported as one, in a field whose only job is to say how stale the
  // sighting is. An indicator of staleness that understates staleness is
  // pointing the wrong way; it makes an old observation look fresher than it
  // is, which is the direction that misleads.
  if (d < 60) return `${d}d ${Math.floor((sec % 86400) / 3600)}h`;
  const mo = d / 30.44;
  return mo < 24 ? `${mo.toFixed(1)} months` : `${(d / 365.25).toFixed(1)} years`;
}

function ago(unixSec) {
  if (!unixSec) return '—';
  return duration(Date.now() / 1000 - unixSec) + ' ago';
}

function utcDate(unixSec) {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

function cell(row, value, cls) {
  const td = document.createElement('td');
  td.textContent = value;
  if (cls) td.className = cls;
  row.appendChild(td);
  return td;
}

function emptyRow(tbody, cols, msg) {
  tbody.replaceChildren();
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = cols; td.className = 'empty'; td.textContent = msg;
  tr.appendChild(td); tbody.appendChild(tr);
}

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---------------------------------------------------------------- render

function renderNodeState(s) {
  const pill = $('nodePill');
  const banner = $('banner');
  pill.classList.remove('ok', 'bad', 'warn');
  banner.classList.add('hidden');
  banner.classList.remove('warn');

  if (!s.nodeOnline) {
    pill.classList.add('bad');
    text($('nodeText'), 'node offline');
    banner.classList.remove('hidden');
    text(banner, `Cannot reach wamd: ${s.error || 'unknown error'}` +
      (s.updatedAt ? ` — showing data from ${duration(s.staleSeconds)} ago.` : ''));
    return;
  }

  // A syncing node reports real numbers about a stale tip. Say so, loudly:
  // every figure below is about the past until this clears.
  if (s.chain && s.chain.syncing) {
    pill.classList.add('warn');
    text($('nodeText'), `syncing — ${s.chain.blocksBehind.toLocaleString()} behind`);
    banner.classList.remove('hidden');
    banner.classList.add('warn');
    const pct = s.chain.verificationProgress !== undefined
      ? ` (${(s.chain.verificationProgress * 100).toFixed(2)}% verified)` : '';
    text(banner, `This node is still syncing${pct}. Every figure below describes ` +
      'the chain up to its current tip, not the network head.');
    return;
  }

  pill.classList.add('ok');
  text($('nodeText'), `synced · updated ${s.staleSeconds}s ago`);
}

function renderTiles(s) {
  const c = s.chain, e = s.emission, sup = s.supply;
  if (!c) return;

  text($('tHeight'), c.blocks.toLocaleString());
  text($('tHeightNote'), c.bestBlockHash
    ? `tip ${c.bestBlockHash.slice(0, 10)}…` : '');

  text($('tHashrate'), hashrate(c.networkHashPerSecond));
  text($('tDifficulty'), `difficulty ${Number(c.difficulty || 0)
    .toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

  if (sup) {
    text($('tSupply'), `${wam(sup.circulating, 0)} WAM`);
    text($('tSupplyNote'), `${(sup.percentMined || 0).toFixed(2)}% of 22,000,000`);
  }

  if (e) {
    text($('tReward'), `${wam(e.subsidy, 2)} WAM`);
    text($('tRewardNote'), e.treasurySubsidy > 0
      ? `${wam(e.minerSubsidy, 2)} miner + ${wam(e.treasurySubsidy, 2)} treasury`
      : `${wam(e.minerSubsidy, 2)} to miner — 100%`);

    text($('tHalving'), duration(e.secondsUntilHalving));
    text($('tHalvingNote'),
      `${e.blocksUntilHalving.toLocaleString()} blocks → ${wam(e.subsidy / 2, 2)} WAM`);
  }

  text($('tPeers'), c.connections !== null && c.connections !== undefined
    ? String(c.connections) : '—');
  text($('tMempool'), s.mempool
    ? `${s.mempool.transactions} tx in mempool` : '');
}

function renderSupply(s) {
  const sup = s.supply;
  if (!sup) return;

  const max = sup.maxSupply;
  const v = sup.vesting || { unlocked: 0, locked: 0, total: 0 };

  // Circulating includes the whole premine, so the publicly mined portion is
  // circulating minus the premine. Showing the premine inside "mined" would
  // overstate what miners actually produced.
  const mined = Math.max(0, sup.circulating - sup.premine);
  const unmined = Math.max(0, max - sup.circulating);

  const pct = (x) => `${(100 * x / max).toFixed(4)}%`;
  $('segMined').style.width = pct(mined);
  $('segVested').style.width = pct(v.unlocked);
  $('segLocked').style.width = pct(v.locked);
  $('segUnmined').style.width = pct(unmined);

  text($('sMined'), `${wam(mined, 0)} WAM`);
  text($('sVested'), `${wam(v.unlocked, 0)} WAM`);
  text($('sLocked'), `${wam(v.locked, 0)} WAM`);
  text($('sUnmined'), `${wam(unmined, 0)} WAM`);
  text($('sMax'), `${wam(max, 0)} WAM`);

  text($('supplySource'), sup.source === 'node'
    ? 'Figures come from the node\'s own getsupplyinfo, i.e. from consensus code.'
    : 'This node does not expose getsupplyinfo; figures are recomputed by the ' +
      'dashboard from the same constants.');
}

function renderVesting(s) {
  const tbody = $('vestTable').querySelector('tbody');
  const v = s.supply && s.supply.vesting;
  if (!v || !v.schedule || !v.schedule.length) {
    return emptyRow(tbody, 4, 'no vesting data');
  }

  tbody.replaceChildren();
  for (const t of v.schedule) {
    const tr = document.createElement('tr');
    cell(tr, String(t.tranche));
    cell(tr, `${wam(t.amount, 0)} WAM`, 'num');
    cell(tr, t.unlockTime === 0 ? 'genesis' : utcDate(t.unlockTime));

    const td = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${t.unlocked ? 'ok' : 'warn'}`;
    badge.textContent = t.unlocked ? 'unlocked' : 'locked';
    td.appendChild(badge);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function renderTreasury(s) {
  const t = s.treasury;
  if (!t) return;

  text($('trStatus'), t.active ? 'collecting' : 'ended');
  text($('trPercent'), t.active ? `${t.percent}%` : '0% (expired)');
  text($('trEnd'), t.lastHeight.toLocaleString());
  text($('trRemaining'), t.active
    ? `${t.blocksRemaining.toLocaleString()} (~${duration(t.secondsRemaining)})`
    : 'miners now take 100%');
}

function renderRandomX(s) {
  const rx = s.randomx;
  if (!rx) {
    text($('rxSeedHeight'), 'unavailable');
    text($('rxSeedHash'), 'node lacks getrandomxinfo');
    return;
  }
  text($('rxSeedHeight'), rx.bootstrap ? 'bootstrap epoch'
    : rx.seedHeight.toLocaleString());
  text($('rxSeedHash'), rx.seedHash || '—');
  $('rxSeedHash').title = rx.seedHash || '';
  text($('rxEpoch'), `${rx.epochBlocks.toLocaleString()} blocks (lag ${rx.epochLag})`);
  text($('rxRotation'), `${rx.blocksUntilRotation} blocks (~${duration(rx.secondsUntilRotation)})`);
  text($('rxMemory'), bytes(rx.memoryBytes));
}

function renderBlocks(blocks) {
  const tbody = $('blocksTable').querySelector('tbody');
  if (!blocks || !blocks.length) return emptyRow(tbody, 6, 'no blocks yet');

  tbody.replaceChildren();
  for (const b of blocks) {
    const tr = document.createElement('tr');
    cell(tr, b.height.toLocaleString());
    cell(tr, ago(b.time));
    cell(tr, String(b.txCount ?? '—'), 'num');
    cell(tr, bytes(b.size), 'num');
    cell(tr, Number(b.difficulty || 0).toLocaleString(undefined,
      { maximumFractionDigits: 2 }), 'num');

    const td = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'mono trunc';
    span.textContent = b.hash;
    span.title = b.hash;
    td.appendChild(span);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------- forms

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('searchResult');
  out.classList.remove('hidden');
  out.replaceChildren();

  const q = $('searchInput').value.trim();
  if (!q) return;

  try {
    const r = await getJSON(`/api/search?q=${encodeURIComponent(q)}`);
    const h = document.createElement('p');
    h.textContent = r.type === 'block'
      ? `Block ${r.data.height?.toLocaleString() ?? ''}`
      : 'Transaction';
    h.style.fontWeight = '650';
    out.appendChild(h);

    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(r.data, null, 2);
    out.appendChild(pre);
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = err.message;
    out.appendChild(p);
  }
});

$('auditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('auditResult');
  out.classList.remove('hidden');
  out.replaceChildren();

  const q = $('auditInput').value.trim();
  if (!q) return;

  try {
    const r = await getJSON(`/api/audit?block=${encodeURIComponent(q)}`);
    const b = r.block;

    const table = document.createElement('table');
    table.className = 'kv';
    const rows = [
      ['Height', b.height.toLocaleString()],
      ['Block subsidy', `${b.subsidy} WAM`],
      ['Treasury required', `${b.required} WAM`],
      ['Treasury paid', `${b.paid} WAM`],
      ['Treasury address', r.address || '—']
    ];
    for (const [k, val] of rows) {
      const tr = document.createElement('tr');
      cell(tr, k); cell(tr, String(val), 'num');
      table.appendChild(tr);
    }
    out.appendChild(table);

    const verdict = document.createElement('p');
    const badge = document.createElement('span');
    badge.className = `badge ${b.compliant ? 'ok' : 'bad'}`;
    badge.textContent = b.compliant
      ? 'COMPLIANT — consensus rule WAM-1 satisfied'
      : 'NON-COMPLIANT — this block underpaid the treasury';
    verdict.appendChild(badge);
    out.appendChild(verdict);
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = err.message;
    out.appendChild(p);
  }
});

// ---------------------------------------------------------------- loop

// ---------------------------------------------------------------- network

// Fetched on its own rather than folded into /api/status, because the status
// payload is a cached snapshot and this is the number a visitor refreshes to
// watch. A minute-old peer count reads as a dead network.
//
// A failure here must not blank the rest of the page: the network card is the
// least important thing on it and the chain data is the most.
// How concentrated the hash rate is. Its own request, because it is the one
// number on this page that a miner might act on within the minute.
async function renderConcentration() {
  let c;
  try {
    c = await getJSON('/api/concentration');
  } catch {
    text($('concSummary'), 'could not be read just now');
    return;
  }
  if (!c.blocksRead) {
    text($('concSummary'), 'reading the last blocks…');
    return;
  }
  const pc = c.topPercent;
  const sd = c.sevenDay;

  // NEITHER LINE IS THE HEADLINE.
  //
  // The seven-day figure was printed first and the short one second, until
  // the founder pointed out what an order does: the reader remembers whoever
  // the first line names, and we are the party that benefits from one of the
  // two orders. Today the long window names the other pool and the short one
  // names ours. So both lines now carry the same grammar, the same shape and
  // the same weight, and the sentence under them says that neither is the
  // number.
  const line = (label, span, top, distinct) => {
    if (top === null || top === undefined) return `${label}: reading…`;
    // THIS LINE USED TO JUDGE THE NUMBER. NOW IT ONLY REPORTS IT.
    //
    // It carried a threshold ladder, and the top rung carried a promise:
    // "above the 50% line \u2014 no exchange application is made at this
    // level", written 2026-09-17 on launch week. By 2026-10-24 it was false.
    // Block DX #199, BasicSwap #743 and NBitcoin #1362 were all opened above
    // that line, and the coin has traded on Komodo's DEX since 22 September.
    // A stranger on Bitcointalk quoted the sentence back at us as our policy,
    // which is what any sentence on a live page eventually becomes.
    //
    // The thresholds went with it. "The 35% target" is an intention too, and
    // an intention on a page nobody revisits is a promise waiting to expire.
    // check_stale_denials.py exempts sentences about our own conduct as
    // "a rule we keep", and that exemption is only sound while we keep it.
    //
    // What is left cannot go stale: a measurement, and how many parties it
    // was spread across. A number changes, which is what numbers are for.
    // Whoever reads it can judge it themselves, which was always their job.
    return `${label} (${span}): largest finder ${top.toFixed(1)}%, `
         + `${distinct} distinct`;
  };

  // THE SPAN IS MEASURED NOW, NOT MULTIPLIED OUT.
  //
  // This said "about ${blocksRead * 2 / 60}h" -- the target interval times
  // the number of blocks. That is an assumption printed as a fact, and on a
  // chain running slower or faster than two minutes it names a stretch of
  // time that never happened. The same assumption sat behind calling the long
  // window "last seven days": 5040 blocks IS seven days only if every one of
  // them took exactly the target.
  //
  // Both now read the first and last timestamps of the blocks actually in the
  // window, and say "reading…" rather than guess when they cannot.
  const span = (secs) => {
    if (!secs || secs <= 0) return null;
    const h = secs / 3600;
    if (h < 1) return `${Math.round(secs / 60)} min`;
    if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
    return `${(h / 24).toFixed(1)} days`;
  };

  // WHICH BLOCKS, BECAUSE A COUNT CANNOT SHOW MOVEMENT.
  //
  // This printed "5037 blocks" for the long window, and 5037 is what a
  // window capped at 5040 reads every single day once the chain is past
  // that height. It rolls, but nothing here said so, and the founder
  // watched the same number for days and concluded the panel had frozen
  // and was lying to readers. He was right about what it looked like.
  //
  // The heights move every two minutes. Printing them turns "is this
  // thing even running" into something a reader settles by looking twice.
  const blocks = (w) => {
    if (!w.fromHeight || !w.toHeight) return `${w.blocksRead} blocks`;
    const n = (x) => x.toLocaleString('en-US');
    return `blocks ${n(w.fromHeight)}–${n(w.toHeight)}`;
  };

  const sevenSpan = sd && span(sd.spanSeconds);
  text($('concSeven'), sd && sd.blocksRead
    ? line(sd.complete ? 'the long window' : 'the whole chain so far',
           sevenSpan ? `${blocks(sd)}, ${sevenSpan}` : blocks(sd),
           sd.topPercent, sd.distinct)
    : 'the long window: reading…');

  const nowSpan = span(c.spanSeconds);
  text($('concSummary'),
    line('right now',
         nowSpan ? `${blocks(c)}, ${nowSpan}` : blocks(c),
         pc, c.distinct));

  const t = $('concTable');
  if (t) {
    t.innerHTML = '';
    for (const row of c.top) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.className = 'mono';
      td1.textContent = row.finder;
      const td2 = document.createElement('td');
      td2.className = 'num';
      td2.textContent = `${row.blocks} block(s) · ${row.percent.toFixed(1)}%`;
      tr.appendChild(td1);
      tr.appendChild(td2);
      t.appendChild(tr);
    }
  }
}

async function renderNetwork() {
  let n;
  try {
    n = await getJSON('/api/network');
  } catch {
    text($('netKnown'), '—');
    text($('netConnected'), '—');
    return;
  }

  text($('netKnown'), n.known === null ? '—' : n.known.toLocaleString());
  text($('netBook'), (n.bookTotal === null || n.bookTotal === undefined)
    ? '\u00a0'
    : `${n.bookTotal} in its address book, new and tried`);
  text($('netConnected'), n.connected.toLocaleString());
  text($('netInOut'), `${n.outbound} out · ${n.inbound} in`
    + (n.connectedOwn ? ` · ${n.connectedOwn} of them a WAM seed` : ''));

  // The address book only grows. It went from four to five when a node in
  // Germany appeared and stayed at five when that node vanished the same
  // day, which reads as a network that never loses anybody. So the count is
  // shown with the part of it that has actually been heard from lately --
  // that number does fall -- and with how much of it is our own machines.
  if (n.knownRecent !== null && n.knownRecent !== undefined) {
    const bits = [`${n.knownRecent} heard from in the last ${n.knownRecentHours}h`];
    if (n.knownOwn) bits.push(`${n.knownOwn} of them ours`);
    text($('netKnownFine'), bits.join(' · '));
  }

  // Measured from DNS, the way a node with no peers finds the network --
  // so it includes the machine serving this page, which counting peers
  // never could. That is why the panel used to say one seed when there
  // were two.
  //
  // A null snapshot is the first load after a restart, before the probe
  // has come back. An em dash is the honest thing to show then; a zero
  // would say the network has no seeds.
  const sn = n.seedNodes;
  if (sn && typeof sn.answering === 'number') {
    text($('netSeeds'), String(sn.answering));
    const parts = [];
    if (sn.answering < sn.machines) {
      parts.push(`${sn.answering} of ${sn.machines} answering`);
    }
    if (sn.places && sn.places.length) parts.push(sn.places.join(' · '));
    text($('netSeedWhere'), parts.join(' — ') || 'none answering');
  } else if (sn === null || sn === undefined) {
    text($('netSeeds'), '—');
    text($('netSeedWhere'), 'checking');
  } else {
    // Older server, or the probe is unavailable: fall back to the peer
    // count rather than showing nothing, and say what it is counting.
    text($('netSeeds'), String((n.seeds || []).length));
    text($('netSeedWhere'), (n.seeds || []).length
      ? `${n.seeds.map((s) => s.where).join(' · ')} (peers only)`
      : 'none reachable');
  }

  const t = n.byType || {};
  text($('netIpv4'), String(t.ipv4 || 0));
  text($('netIpv6'), String(t.ipv6 || 0));
  text($('netOnion'), String(t.onion || 0));

  // Connected right now, and separately what has been on this network over
  // the past week. A version that vanishes from the first list has not
  // necessarily left: an intermittent node is absent most of the time and
  // present when it matters, and on 2026-08-30 this panel showed only
  // v0.1.6 for hours while a v0.1.4 node had introduced itself three and a
  // half hours earlier. Absent is not gone, and the two are worth different
  // words.
  const h = n.history;
  if (h && h.versions && h.versions.length) {
    const now = h.versions.filter((v) => v.connectedNow)
      .map((v) => {
        const c = (n.versions.find((x) => x.version === v.version) || {}).count;
        return c ? `${v.version} ×${c}` : v.version;
      });
    // With the machine count, not without it. "also on this network:
    // /WAM:0.1.5/" reads as a stranger running an old build, and every
    // /WAM:0.1.5/ handshake in the seven days to 1 September 2026 came from
    // one machine -- the founder's own laptop, started on an old binary.
    // Saying "on 1 machine" does not name anybody and stops the sentence
    // implying a crowd.
    const away = h.versions.filter((v) => !v.connectedNow)
      .map((v) => `${v.version} on ${v.machines} machine${v.machines === 1 ? '' : 's'}`
                + ` (seen ${duration(v.ageSeconds)} ago)`);
    text($('netVersions'),
      (now.length ? now.join('  ') : 'none connected')
      + (away.length ? '   —   also on this network: ' + away.join('  ') : ''));
  } else {
    text($('netVersions'), n.versions.length
      ? n.versions.map((v) => `${v.version} ×${v.count}`).join('  ')
      : '—');
  }

  text($('netLongest'), n.longestConnectionSeconds
    ? duration(n.longestConnectionSeconds)
    : '—');
}

async function refresh() {
  try {
    const s = await getJSON('/api/status');

    renderNodeState(s);
    if (s.chain) {
      text($('chainLine'),
        `${s.chain.name} · height ${s.chain.blocks.toLocaleString()} · ` +
        `${s.chain.pruned ? 'pruned' : bytes(s.chain.sizeOnDisk)} on disk`);
    }
    renderTiles(s);
    renderSupply(s);
    renderVesting(s);
    renderTreasury(s);
    renderRandomX(s);
    renderBlocks(s.blocks);
    renderNetwork();
    renderConcentration();

    text($('footerStatus'), `dashboard up ${duration(s.serverUptimeSec)}`);
    lastOk = Date.now();
    renderFreshness();
  } catch (err) {
    const pill = $('nodePill');
    pill.classList.remove('ok', 'warn');
    pill.classList.add('bad');
    text($('nodeText'), 'dashboard API unreachable');
    const banner = $('banner');
    banner.classList.remove('hidden');
    text(banner, `Cannot reach the dashboard server: ${err.message}`);
  }
}


// ---------------------------------------------------------------------------
// HOW OLD IS WHAT YOU ARE LOOKING AT
//
// A page that fetches every few seconds and renders numbers has no way to
// say that it stopped fetching. A browser freezes a background tab, a laptop
// sleeps, a network drops -- and the last figures sit there looking current.
// On 22 September that cost an hour: the founder watched frozen numbers while
// the server was answering in one millisecond with data that changed on every
// request, and nothing on the page could tell him which of the two was stuck.
//
// So the age of the data is on the page, it advances once a second, and it
// turns amber and then red when it stops advancing. A frozen tab announces
// itself instead of lying. It also costs nothing: the fetch interval is
// unchanged, and this is arithmetic in the browser.
// ---------------------------------------------------------------------------

let lastOk = 0;

function renderFreshness() {
  const el = $('freshness');
  if (!el) return;
  if (!lastOk) { el.textContent = 'waiting for the first answer'; el.className = 'freshness warn'; return; }
  const age = Math.round((Date.now() - lastOk) / 1000);
  el.textContent = age <= 1 ? 'updated just now' : `updated ${age}s ago`;
  el.className = 'freshness ' +
    (age < REFRESH_MS / 400 ? 'ok' : age < REFRESH_MS / 150 ? 'warn' : 'bad');
}

setInterval(renderFreshness, 1000);

refresh();
setInterval(refresh, REFRESH_MS);
