'use strict';
/* WAM Coin pool dashboard
   Copyright (c) 2026 The WAM Coin developers -- MIT

   Polls the read-only JSON API and repaints. Deliberately dependency-free:
   the dashboard is the first thing an operator loads when something is wrong,
   so it must not depend on a CDN being reachable. */

const COIN = 1e8;
const REFRESH_MS = 8000;

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);

function hashrate(hs) {
  if (!hs || hs <= 0) return '0 H/s';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let i = 0;
  while (hs >= 1000 && i < units.length - 1) { hs /= 1000; i++; }
  return `${hs.toFixed(hs < 10 ? 2 : 1)} ${units[i]}`;
}

/**
 * A difficulty, printed so that a small one is still a number.
 *
 * ONE FUNCTION, BECAUSE THE FIX WAS WRITTEN ONCE AND MISSED TWICE.
 *
 * The network tile below already carried this, with a comment saying why:
 * toLocaleString's default caps fraction digits at 3, and WAM's difficulty
 * at the floor is 0.00024414, so the page said "difficulty 0" on the evening
 * a tester watched the chain fall to minimum.
 *
 * The miners table did `Number(m.difficulty).toLocaleString()` and the
 * payments table did `String(p.difficulty)`. Every vardiff value this pool
 * assigns is far below the floor -- measured live on 14 November 2026 at
 * 1e-6 to 7.7e-5 across 270 rows -- so that column printed "0" for every
 * miner on the page, carrying no information at all.
 *
 * Reported by Radenlingga, 14 November 2026, reproduced twice against the
 * live site.
 */
/**
 * Confirmations a coinbase needs before the pool credits it.
 *
 * COINBASE_MATURITY is 100 and spendable depth is 101 -- the two differ by
 * exactly one, and that one block is what this used to get wrong. See the
 * note at the badge.
 */
const MATURITY = 101;

function difficulty(value) {
  // AN ABSENT FIELD MUST NOT BORROW THE CLAIM THAT "0" MAKES.
  //
  // null, undefined and '' all pass through Number() as 0, and 0 is a
  // statement: it says this miner's target is the easiest the pool hands
  // out. A field the payload did not carry says nothing, and printing a
  // confident 0 for it is the same defect this function exists to fix, one
  // column over. The payments table guarded `== null` at its own call site
  // and the miners table did not, which is the usual reason to move a
  // guard inside: one of the two call sites always forgets.
  if (value === null || value === undefined || value === '') return '—';
  const d = Number(value);
  if (!Number.isFinite(d)) return '—';
  if (d === 0) return '0';
  return d < 1
    ? d.toLocaleString(undefined, { maximumSignificantDigits: 3 })
    : d.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function wam(baseUnits, dp = 8) {
  if (baseUnits === null || baseUnits === undefined) return '—';
  return (baseUnits / COIN).toLocaleString('en-US',
    { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function duration(sec) {
  if (sec === null || sec === undefined || !isFinite(sec)) return '—';
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function ago(ms) {
  if (!ms) return '—';
  return duration((Date.now() - ms) / 1000) + ' ago';
}

/** Always set text, never innerHTML, for anything that came off the wire. */
function text(el, value) { el.textContent = value; }

function cell(row, value, cls) {
  const td = document.createElement('td');
  td.textContent = value;
  if (cls) td.className = cls;
  row.appendChild(td);
  return td;
}

function emptyRow(tbody, cols, message) {
  tbody.replaceChildren();
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = cols;
  td.className = 'empty';
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------ render

function renderStats(s) {
  const pool = s.pool || {};
  const net = s.network || {};

  text($('chainLabel'),
    `${net.chain || '?'} · block ${(net.blocks || 0).toLocaleString()} · ` +
    `${(s.config && s.config.rewardMode || '').toUpperCase()} · ` +
    `pool fee ${s.config ? s.config.poolFeePercent : '?'}% + 5% treasury`);

  text($('poolHashrate'), hashrate(pool.hashrate));
  // The share is F of the last N blocks, counted off the ledger, so it says
  // which N. It used to be this pool's measured hashrate divided by an
  // estimate of the network's, which read "102.057% of network" on 29 October
  // -- a part larger than the whole it is part of.
  text($('poolShare'), pool.poolSharePercent
    ? (pool.shareBasis === 'counted'
        ? `${pool.poolSharePercent.toFixed(1)}% of the last ` +
          `${pool.shareWindowBlocks} blocks (${pool.blocksFoundInWindow} found here)`
        : `about ${pool.poolSharePercent.toFixed(1)}% of network, estimated`)
    : 'no shares in window');

  text($('minerCount'), String(pool.miners ?? 0));
  text($('workerCount'), `${pool.workers ?? 0} active worker${pool.workers === 1 ? '' : 's'}`);

  // The hashrate is an estimate from recent block times, so it lags badly the
  // moment blocks stop. A tester shut every miner down on 5 September and this
  // tile read 24.3 kH/s beside "0 active workers", with the chain frozen for
  // half an hour. The age of the tip cannot lag -- it is the clock minus the
  // block header -- so it is shown next to the estimate, and says plainly when
  // the estimate has stopped meaning anything.
  //
  // AND IT IS THE EXPLORER'S NUMBER, NOT ONE OF OURS THAT RESEMBLES IT.
  //
  // A miner here should not have to open a second page to see how strong the
  // chain is; that is what this tile is for. So it asks the same node the
  // same question over the same 720-block window the explorer uses, and the
  // two agree by construction. For an afternoon this tile carried a total of
  // its own -- our measured hashrate over our counted share -- which read
  // 615.7 while the explorer read 608.3: one quantity, two headlines, and no
  // way for a reader to choose between them.
  //
  // The share below the pool's own hashrate is what had to stop being a
  // division, and it has: it is counted off the ledger now. The total never
  // needed to be.
  const stale = net.secondsSinceBlock != null && net.secondsSinceBlock > 600;
  text($('netHashrate'), hashrate(net.networkHashPerSecond));
  // Two decimal places round WAM's difficulty to "0". At the floor it is
  // 0.00024414, and the floor is exactly when somebody is reading this tile
  // to find out what happened -- the page said "difficulty 0" on the evening
  // a tester watched the chain fall to minimum. Significant digits instead of
  // decimal places, so a small number stays a number and a large one does not
  // grow a tail.
  const d = net.difficulty || 0;
  const diffText = `difficulty ${difficulty(d)}`;
  text($('netDifficulty'), net.secondsSinceBlock == null
    ? diffText
    : stale
      ? `${diffText} · no block for ${duration(net.secondsSinceBlock)} — rate above is stale`
      : `${diffText} · last block ${duration(net.secondsSinceBlock)} ago`);
  $('netDifficulty').classList.toggle('warn', stale);

  text($('blockHeight'), (net.blocks || 0).toLocaleString());
  text($('halvingNote'), net.blocksUntilHalving !== undefined
    ? `${net.blocksUntilHalving.toLocaleString()} blocks to halving ${(net.halvingEpoch ?? 0) + 1}`
    : '');

  text($('blocksFound'), String(pool.blocksConfirmed ?? 0));
  text($('blocksPending'),
    `${pool.blocksPending ?? 0} maturing · ${pool.blocksOrphaned ?? 0} orphaned`);

  text($('ttb'), pool.expectedBlockSeconds ? duration(pool.expectedBlockSeconds) : '—');

  // ---- reward split ------------------------------------------------------
  const subsidy = net.blockSubsidy || 0;
  const treasury = net.treasurySubsidy || 0;
  const afterTreasury = subsidy - treasury;
  const poolFeePct = (s.config && s.config.poolFeePercent) || 0;
  const poolFee = Math.floor(afterTreasury * poolFeePct / 100);
  const miners = afterTreasury - poolFee;

  if (subsidy > 0) {
    $('segMiner').style.width = `${(miners / subsidy) * 100}%`;
    $('segPool').style.width = `${(poolFee / subsidy) * 100}%`;
    $('segTreasury').style.width = `${(treasury / subsidy) * 100}%`;
  }

  text($('rwMiner'), `${wam(miners)} WAM`);
  text($('rwPool'), `${wam(poolFee)} WAM`);
  text($('rwTreasury'), net.treasuryActive === false
    ? '0.00000000 WAM (ended)'
    : `${wam(treasury)} WAM`);
  text($('rwTotal'), `${wam(subsidy)} WAM`);

  // The treasury fee is time-limited; show miners exactly how much of it is left.
  const sunsetNote = $('treasurySunset');
  if (sunsetNote) {
    if (net.treasuryActive === false) {
      text(sunsetNote,
        `Treasury fee ended at block ${(net.treasuryLastHeight || 0).toLocaleString()}. ` +
        'Miners now receive 100% of the subsidy.');
    } else if (net.blocksUntilTreasuryEnds !== undefined) {
      text(sunsetNote,
        `Treasury fee ends at block ${(net.treasuryLastHeight || 0).toLocaleString()} — ` +
        `${net.blocksUntilTreasuryEnds.toLocaleString()} blocks ` +
        `(~${duration(net.blocksUntilTreasuryEnds * 120)}). After that miners take 100%.`);
    }
  }

  // Where the operator's fee goes. A percentage anybody can read is still a
  // claim; an address is a thing they can follow. It is swept out of the pool
  // wallet to an address that receives nothing else, so what stays behind is
  // miners' money and can be checked against what the pool says it owes.
  const feeNote = $('poolFeeAddress');
  if (feeNote) {
    const addr = s.config && s.config.poolFeeAddress;
    if (poolFeePct === 0) {
      text(feeNote, 'The pool takes no fee, so there is nothing to send anywhere.');
    } else if (addr) {
      text(feeNote,
        `The ${poolFeePct}% operator fee is swept to ${addr}, which receives nothing ` +
        'else. Everything left in the pool wallet is miners’ money.');
    } else {
      text(feeNote,
        `The ${poolFeePct}% operator fee stays in the pool wallet; no separate ` +
        'address is configured for it.');
    }
  }

  // ---- ports -------------------------------------------------------------
  const portTable = $('portTable');
  portTable.replaceChildren();
  const head = document.createElement('tr');
  for (const h of ['Port', 'Start diff', 'For']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  portTable.appendChild(head);

  const ports = (s.config && s.config.ports) || [];
  for (const p of ports) {
    const tr = document.createElement('tr');
    cell(tr, p.tls ? `${p.port}  🔒` : String(p.port));
    cell(tr, difficulty(p.difficulty), 'num');
    cell(tr, p.description || '');
    portTable.appendChild(tr);
  }

  // Offer the encrypted port in the example command whenever one exists.
  //
  // On plain stratum anyone on the path can substitute the block template,
  // so a miner spends its electricity on a job that pays a stranger and sees
  // nothing wrong. The command shown here is the one most people paste, so
  // it should be the safe one -- an encrypted port nobody is told about
  // protects nobody.
  const host = (s.config && s.config.stratumHost) || window.location.hostname;
  const tlsPort = ports.find((p) => p.tls);
  const chosen = tlsPort || (ports.length ? ports[0] : { port: 3333, tls: false });
  const scheme = chosen.tls ? 'stratum+ssl' : 'stratum+tcp';
  text($('connectCmd'),
    `xmrig -a rx/wam -o ${scheme}://${host}:${chosen.port} \\\n` +
    `      -u YOUR_W_ADDRESS.rig1 -p x --keepalive`);

  // ---- randomx -----------------------------------------------------------
  const rx = s.randomx || {};
  // A FALLBACK THAT IS NOT USED IS NOT A FALLBACK.
  //
  // This read `(rx.seedHeight ?? '—').toLocaleString ? rx.seedHeight
  // .toLocaleString() : '—'`. The ?? guards the TEST and not the call: with
  // seedHeight absent, the test asks whether the string '—' has
  // toLocaleString -- it does -- and the branch then dereferences undefined.
  // The throw escapes into the surrounding handler, which reports the whole
  // dashboard as unreachable.
  //
  // Reported by Radenlingga, 14 November 2026, as latent: the live payload
  // serves seedHeight normally. Latent is still a crash with a date on it.
  const seed = rx.seedHeight;
  text($('seedHeight'),
    seed === 0 ? 'bootstrap'
      : (typeof seed === 'number' && Number.isFinite(seed))
        ? seed.toLocaleString()
        : '—');
  text($('seedRotate'), rx.nextRotationInBlocks
    ? `${rx.nextRotationInBlocks} blocks (~${duration(rx.nextRotationInBlocks * 120)})`
    : '—');

  text($('updatedAt'), `updated ${new Date(s.updatedAt || Date.now()).toLocaleTimeString()}`);
}

function renderHealth(h) {
  const pill = $('healthPill');
  pill.classList.remove('ok', 'bad');
  if (h.ok) {
    pill.classList.add('ok');
    text($('healthText'), `healthy · up ${duration(h.uptimeSec)}`);
  } else {
    pill.classList.add('bad');
    // Same shape, same reason: `problems` is read without being checked, so
    // a payload that says ok:false and carries no list turns one missing
    // field into a dashboard that reports itself unreachable. The pool
    // always sends an array today; the page must not depend on that to
    // render at all.
    const problems = Array.isArray(h.problems) ? h.problems : [];
    text($('healthText'),
      problems.length ? problems.join(' · ') : 'the pool reports a problem');
  }
}

function renderMiners(miners) {
  const tbody = $('minersTable').querySelector('tbody');
  text($('connectedCount'), miners.length ? `(${miners.length})` : '');

  if (!miners.length) return emptyRow(tbody, 7, 'no miners connected');

  tbody.replaceChildren();
  miners.sort((a, b) => b.validShares - a.validShares);

  for (const m of miners) {
    const tr = document.createElement('tr');
    cell(tr, m.worker || '—', 'mono');
    // ONE MACHINE WITH SIXTY-FOUR CONNECTIONS IS NOT SIXTY-FOUR MINERS.
    //
    // The worker label is the only thing this table showed, and it is
    // redacted to its first and last characters -- so a miner running one
    // process per core appeared as dozens of rows a reader cannot tell
    // apart. Measured live on 14 November 2026: 270 rows for 166 distinct
    // labels, with `wam1q66gen...t2wan.rig1` appearing sixty-four times.
    //
    // The payload already carried the per-connection id and nothing printed
    // it. It is the stratum connection counter -- it identifies a socket on
    // this pool and nothing beyond it, which is exactly what is needed to
    // tell two rows apart without saying anything about anybody.
    //
    // Reported by Radenlingga, 14 November 2026.
    cell(tr, m.id == null ? '—' : String(m.id), 'num');
    cell(tr, m.userAgent || 'unknown');
    cell(tr, difficulty(m.difficulty), 'num');
    cell(tr, String(m.validShares), 'num');
    cell(tr, String(m.invalidShares), 'num');
    cell(tr, duration(m.connectedFor), 'num');
    tbody.appendChild(tr);
  }
}

function renderBlocks(data) {
  const tbody = $('blocksTable').querySelector('tbody');

  const rows = [
    ...(data.pending || []).map((b) => ({ ...b, status: 'pending' })),
    ...(data.confirmed || []).map((b) => ({ ...b, status: 'confirmed' })),
    ...(data.orphaned || []).map((b) => ({ ...b, status: 'orphaned' }))
  ].sort((a, b) => b.height - a.height).slice(0, 40);

  if (!rows.length) return emptyRow(tbody, 7, 'no blocks yet');

  tbody.replaceChildren();
  for (const b of rows) {
    const tr = document.createElement('tr');
    cell(tr, (b.height ?? 0).toLocaleString());

    const td = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${b.status}`;
    // A COINBASE IS SPENDABLE AT 101, NOT 100.
    //
    // Core's wallet computes max(0, (COINBASE_MATURITY + 1) - depth), so the
    // pool credits at 101 -- it was changed to, after crediting at 100 left
    // 47.5 WAM standing between what was owed and what could be sent. This
    // badge kept the old denominator, so a block at exactly 100 showed
    // "100/100" while it was not yet credited: a full bar for a block that
    // had not arrived.
    //
    // Reported by Radenlingga, 14 November 2026, from the live /api/blocks
    // payload: no pending block passes 100, and no confirmed block is below
    // 101.
    badge.textContent = b.status === 'pending'
      ? `${b.confirmations ?? 0}/${MATURITY}` : b.status;
    td.appendChild(badge);
    tr.appendChild(td);

    const finder = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'mono trunc';
    span.textContent = b.finder || '—';
    span.title = b.finder || '';
    finder.appendChild(span);
    tr.appendChild(finder);

    cell(tr, ago(b.time));
    cell(tr, wam(b.minerPot, 4), 'num');
    cell(tr, wam(b.devFeeAmount, 4), 'num');
    cell(tr, String(b.workers ?? '—'), 'num');
    tbody.appendChild(tr);
  }
}

function renderPayments(payments) {
  const tbody = $('paymentsTable').querySelector('tbody');
  if (!payments || !payments.length) return emptyRow(tbody, 4, 'no payouts yet');

  tbody.replaceChildren();
  for (const p of payments) {
    const tr = document.createElement('tr');
    cell(tr, ago(p.time));

    const td = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'mono trunc';
    span.textContent = p.txid || '—';
    span.title = p.txid || '';
    td.appendChild(span);
    tr.appendChild(td);

    cell(tr, String(p.recipients ?? 0), 'num');
    cell(tr, `${wam(p.total, 4)} WAM`, 'num');
    tbody.appendChild(tr);
  }
}

// ------------------------------------------------------------------- miner

$('lookupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const address = $('addressInput').value.trim();
  const out = $('minerResult');
  out.classList.remove('hidden');
  out.replaceChildren();

  if (!address) return;

  const p = document.createElement('p');
  p.textContent = 'looking up…';
  out.appendChild(p);

  try {
    const m = await getJSON(`/api/miner?address=${encodeURIComponent(address)}`);

    out.replaceChildren();
    const table = document.createElement('table');
    table.className = 'kv';

    const rows = [
      ['Address', m.address],
      ['Hashrate', hashrate(m.hashrate)],
      ['Unpaid balance', `${wam(m.balance)} WAM`],
      ['Paid all time', `${wam(m.totalPaid)} WAM`],
      ['Active workers', String(Object.keys(m.workers || {}).length)]
    ];

    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      cell(tr, k);
      cell(tr, v, 'num');
      table.appendChild(tr);
    }
    out.appendChild(table);

    const workers = Object.entries(m.workers || {});
    if (workers.length) {
      const wt = document.createElement('table');
      wt.className = 'kv';
      const head = document.createElement('tr');
      for (const h of ['Worker', 'Hashrate']) {
        const th = document.createElement('th');
        th.textContent = h;
        head.appendChild(th);
      }
      wt.appendChild(head);
      for (const [name, st] of workers) {
        const tr = document.createElement('tr');
        cell(tr, name, 'mono');
        cell(tr, hashrate(st.hashrate), 'num');
        wt.appendChild(tr);
      }
      out.appendChild(wt);
    }
  } catch (err) {
    out.replaceChildren();
    const e2 = document.createElement('p');
    e2.className = 'err';
    e2.textContent = `lookup failed: ${err.message}`;
    out.appendChild(e2);
  }
});

// -------------------------------------------------------------------- loop

async function refresh() {
  try {
    const [stats, health, miners, blocks, payments] = await Promise.all([
      getJSON('/api/stats'),
      getJSON('/api/health'),
      getJSON('/api/miners'),
      getJSON('/api/blocks'),
      getJSON('/api/payments')
    ]);

    renderStats(stats);
    renderHealth(health);
    renderMiners(miners.miners || []);
    renderBlocks(blocks);
    renderPayments(payments.payments || []);
    lastOk = Date.now();
    renderFreshness();
  } catch (err) {
    const pill = $('healthPill');
    pill.classList.remove('ok');
    pill.classList.add('bad');
    text($('healthText'), `API unreachable: ${err.message}`);
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
