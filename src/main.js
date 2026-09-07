import { BASELINE, presetHash } from './core/config.js';
import { sessionState } from './core/session.js';
import { evaluate } from './engine/signal.js';
import { allocate, baseSize } from './engine/sizing.js';
import { runway } from './engine/levels.js';
import { monitorPosition, excursion, stopPrice, targetPrice, fmtDuration } from './engine/monitor.js';
import { makeJournal } from './core/store.js';
import { demoData, demoContext, DEMO_ASOF } from './adapters/demo.js';
import { startLive, inBlackout } from './core/live.js';
import { makeQueue } from './core/queue.js';
import { openStream } from './adapters/alpacaStream.js';
import { regimeQuotes } from './adapters/fmp.js';
import { quotes as tdQuotes, bars as tdBars } from './adapters/twelvedata.js';
import { nextEarningsMap } from './adapters/finnhub.js';

const $ = s => document.querySelector(s);
const state = { mode: 'DEMO', wl: null, data: null, cfg: BASELINE, liveHandle: null,
  journal: null, muted: false, form: null, medianAtr: 6.9 };
const L = () => state.liveHandle?.state;
const byT = t => state.wl.names.find(n => n.ticker === t);
// Live mode runs on the wall clock; demo mode runs on the snapshot's as-of moment, so the
// staged states, the session pill and the position clocks all describe the same instant.
const NOW = () => state.mode === 'LIVE' ? new Date() : DEMO_ASOF;
const ASOF_LABEL = DEMO_ASOF.toLocaleString('en-GB',
  { timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

async function boot() {
  state.wl = await (await fetch('./watchlist.json')).json();
  $('#screendate').textContent = `screened ${state.wl.screening_date} · baseline ${presetHash(BASELINE)}`;
  state.data = demoData(state.wl);
  state.journal = makeJournal(localStorage);
  const atrs = state.wl.names.map(n => n.atr_pct_14d).sort((a, b) => a - b);
  state.medianAtr = atrs[Math.floor(atrs.length / 2)];
  $('#mode').textContent = `DEMO MODE — staged snapshot as of ${ASOF_LABEL} CET; enter keys to go live.`;
  $('#go').onclick = goLive;
  $('#equity').onclick = () => openForm({ kind: 'equity' });
  $('#expjson').onclick = exportJournal;
  $('#mute').onclick = () => { state.muted = !state.muted;
    $('#mute').textContent = state.muted ? 'alerts muted' : 'alerts on';
    $('#mute').classList.toggle('on', state.muted); };
  renderAll();
  renderForm();
  setInterval(renderHeader, 2000);
  setInterval(renderMonitor, 15000);          // clocks tick down even when the tape is quiet
}

// ---- LIVE mode (FR-A15–A18) ----
function goLive() {
  const keys = { alpacaId: $('#k_alp_id').value.trim(), alpacaSecret: $('#k_alp_sec').value.trim(),
    td: $('#k_td').value.trim(), fmp: $('#k_fmp').value.trim(), fh: $('#k_fh').value.trim(),
    or: $('#k_or').value.trim(), nd: $('#k_nd').value.trim() };
  if (!keys.alpacaId || !keys.alpacaSecret || !keys.td) {
    $('#mode').textContent = 'LIVE needs at least the Alpaca key pair and a Twelve Data key.'; return;
  }
  const queue = makeQueue();
  const deps = { openStream, regimeQuotes, tdQuotes,
    tdBars: (sym, interval, outputsize) => tdBars(sym, interval, outputsize, keys.td),
    earningsMap: nextEarningsMap, queue, journal: state.journal };
  state.liveHandle = startLive({ keys, watchlist: state.wl, cfg: state.cfg }, deps, throttledRender);
  state.mode = 'LIVE';
  const saved = JSON.parse(sessionStorage.getItem('pause') ?? '{}');   // FR-A9: session persistence
  for (const [t, v] of Object.entries(saved)) L().setPause(t, v.paused, v.override);
  $('#mode').textContent = 'LIVE — baseline config, signals only, human executes. Structure states fill over ~8 min (API budget, C9).';
  renderAll();
}
let renderQueued = false;
function throttledRender() {
  if (renderQueued) return; renderQueued = true;
  setTimeout(() => { renderQueued = false; renderAll(); }, 400);
}
function togglePause(t) {
  const l = L(); if (!l) return;
  const wasPaused = l.paused[t] === true;
  const blackout = l.earnings ? inBlackout(l.earnings[t], new Date(), state.cfg) : false;
  if (wasPaused && blackout) {
    const d = l.earnings?.[t] ?? 'unknown date';
    if (!confirm(`${t} reports on ${d} — trade through the event? (Pause is the default.)`)) return;
  }
  l.setPause(t, !wasPaused, wasPaused && blackout);
  const saved = JSON.parse(sessionStorage.getItem('pause') ?? '{}');
  saved[t] = { paused: !wasPaused, override: wasPaused && blackout };
  sessionStorage.setItem('pause', JSON.stringify(saved));
  renderAll();
}

// DEMO-mode ctx lives in the demo adapter so the staged dataset is asserted through the real
// engine in tests; live-mode ctx is assembled in core/live.js.
const ctxFor = n => demoContext(state.data, n, state.cfg, NOW());

function renderHeader() {
  const live = state.mode === 'LIVE';
  const spyP = live ? (L().spyLive ?? L().spy.price) : state.data.spy.price;
  const ma20 = live ? L().spy.ma20 : state.data.spy.ma20;
  const vix = live ? L().vix : state.data.vix;
  if (live && (ma20 == null || vix == null)) {
    $('#regime').textContent = L().errors.regime ? `REGIME ERR: ${L().errors.regime.slice(0, 60)}` : 'REGIME loading…';
    $('#regime').className = 'pill ' + (L().errors.regime ? 'bad' : 'dim');
  } else {
    const longsOK = spyP > ma20, vixOK = vix < state.cfg.vixCap;
    const reg = !vixOK ? ['STAND DOWN · VIX ' + vix, 'bad'] :
      longsOK ? [`LONGS OK · SPY>${state.cfg.spyMaDays}DMA · VIX ${vix}`, 'ok'] : [`SHORTS OK · VIX ${vix}`, 'warn'];
    $('#regime').textContent = reg[0]; $('#regime').className = 'pill ' + reg[1];
  }
  const ss = sessionState(NOW(), state.cfg);
  $('#session').textContent = ss.replace('_', ' ');
  $('#session').className = 'pill ' + (ss === 'ENTRY_OPEN' ? 'ok' : ss === 'ENTRIES_CLOSED' ? 'warn' : 'dim');
  if (live) {
    const age = L().lastTickAge();
    $('#stream').textContent = `STREAM: ${L().stream.status}${age != null ? ' · ' + Math.round(age / 1000) + 's' : ''}`;
    $('#stream').className = 'pill ' + (L().stream.status === 'CONNECTED' ? 'ok' : L().stream.status === 'DEGRADED' ? 'warn' : 'bad');
    $('#budget').textContent = `API: TD ${L().budget().used}/800`;
  } else {
    $('#stream').textContent = 'STREAM: demo'; $('#stream').className = 'pill';
    $('#budget').textContent = 'API: demo·0/800';
  }
}

function runwayStrip(n, live) {
  const dir = n.bias === 'long' ? 'long' : 'short';
  const daily = state.mode === 'LIVE' && L().daily[n.ticker]
    ? L().daily[n.ticker].map(b => ({ h: b.h, l: b.l, c: b.c }))
    : state.data.hourBars[n.ticker].slice(-10).map(b => ({ h: b.h, l: b.l, c: b.c }));
  const rw = runway(live, dir, daily.at(-2) ?? daily.at(-1), daily);
  const span = live * 0.08;
  const pos = v => Math.max(0, Math.min(100, ((v - (live - span/2)) / span) * 100));
  const lvl = rw.level ? `<i class="lvl" style="left:${pos(rw.level)}%"></i>` : '';
  const zoneEnd = dir === 'long' ? pos(live * 1.03) : pos(live * 0.97);
  const zone = `left:${Math.min(pos(live), zoneEnd)}%;width:${Math.abs(zoneEnd - pos(live))}%`;
  const label = rw.runwayPct === Infinity ? 'open' : rw.runwayPct.toFixed(1) + '%';
  return `<div class="rw" title="runway ${label} to ${rw.name}"><i class="zone" style="${zone}"></i>${lvl}<i class="px" style="left:${pos(live)}%"></i></div>`;
}

function rowData(n) {   // one row's numbers from the active mode
  if (state.mode !== 'LIVE') {
    const q = state.data.quotes[n.ticker];
    return { price: q.live, stale: false, changePct: q.changePct,
      trend: q.ma50 > q.ma200 ? '<span class="up">50>200</span>' : '<span class="dn">50<200</span>',
      earnCell: n.beta_60d > 5 ? '<span class="badge">β-cap</span>' : '—',
      result: evaluate(state.cfg, ctxFor(n)) };
  }
  const l = L(), t = n.ticker;
  const price = l.live[t]?.p ?? l.quotes[t]?.price ?? null;
  const blackout = l.earnings ? inBlackout(l.earnings[t], new Date(), state.cfg) : false;
  const earnDate = l.earnings?.[t];
  const chip = l.paused[t] ? `<span class="badge paused" data-pause="${t}" title="paused — click to override">PAUSED</span>`
    : blackout ? `<span class="badge" data-pause="${t}" title="blackout override active — click to pause">OVERRIDE</span>` : '';
  return { price, stale: !l.live[t], changePct: l.quotes[t]?.changePct ?? null,
    trend: n.bias === 'long' ? '<span class="up" title="above 50-DMA at screen (EOD)">↑50DMA*</span>'
                             : '<span class="dn" title="below 50-DMA at screen (EOD)">↓50DMA*</span>',
    earnCell: `${earnDate ? earnDate.slice(5) : (l.earnings ? '?' : '…')} ${chip}`,
    result: l.states[t] ?? null };
}

function renderAll() {
  renderHeader();
  const tb = $('#overview tbody'); tb.innerHTML = '';
  for (const n of state.wl.names) {
    const d = rowData(n);
    const tr = document.createElement('tr');
    const px = d.price != null ? d.price.toFixed(2) : '—';
    const chg = d.changePct != null ? `${d.changePct.toFixed(1)}%` : '—';
    const st = d.result?.state ?? '…';
    tr.innerHTML = `<td>${n.ticker}</td><td class="num${d.stale ? ' dim' : ''}" title="${d.stale ? 'REST fallback (stale)' : 'live'}">${px}</td>
      <td class="num ${(d.changePct ?? 0) >= 0 ? 'up' : 'dn'}">${chg}</td><td>${d.trend}</td>
      <td>${d.price != null ? runwayStrip(n, d.price) : ''}</td><td class="num">${n.beta_60d.toFixed(1)}</td><td>${n.cluster}</td>
      <td>${d.earnCell}</td>
      <td><span class="state ${st}">${st}</span></td>`;
    if (d.result) tr.onclick = ev => { if (ev.target.dataset?.pause) return; renderDrill(n, d.result); };
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-pause]').forEach(el => { el.onclick = ev => { ev.stopPropagation(); togglePause(el.dataset.pause); }; });
  const livePr = state.mode === 'LIVE';
  $('#prov-price').textContent = livePr ? 'LIVE-VENUE (Alpaca IEX) · REST-CACHED fallback' : `DEMO SNAPSHOT · as-of ${ASOF_LABEL} CET`;
  $('#prov-ref').textContent = livePr ? `FMP DELAYED + Finnhub EOD + screen ${state.wl.screening_date}` : `DEMO SNAPSHOT · screen ${state.wl.screening_date}`;
  renderMonitor();
  renderRisk();
}

function renderDrill(n, r) {
  state.drill = { n, r };
  const rows = r.criteria.map(c => {
    const mark = c.enabled === false ? '<span class="off">off</span>' : c.pass ? '<span class="ok">✓</span>' : '<span class="no">✗</span>';
    const val = typeof c.value === 'number' ? c.value.toFixed(2) : String(c.value);
    return `<div>${c.id}</div><div>${c.detail}</div><div>${mark} ${val}</div>`;
  }).join('');
  const prov = state.mode === 'LIVE'
    ? `Structure: 1h REST-CACHED · Trigger: 5m LIVE-VENUE (IEX)${L().reseeded ? ' · VWAP re-seeded from backfill' : ''}`
    : 'Structure: 1h REST-CACHED · Trigger: 5m LIVE-VENUE (demo)';
  const canRecord = r.state === 'LONG' || r.state === 'SHORT';
  $('#drillbody').innerHTML = `<div class="crit"><div><b>${n.ticker}</b></div><div>${n.sector} · ${n.bias}-bias · β ${n.beta_60d}</div>
    <div><span class="state ${r.state}">${r.state}</span></div>${rows}</div>
    ${canRecord ? '<div class="fillactions"><button class="mini" id="recentry">Record entry fill</button></div>' : ''}
    <div class="prov">${prov}</div>`;
  if (canRecord) $('#recentry').onclick = () =>
    openForm({ kind: 'entry', ticker: n.ticker, dir: r.state.toLowerCase(), snapshot: r });
}

function renderRisk() {
  const cfg = state.cfg;
  const sig = state.wl.names.find(x => x.beta_60d > 5) ?? state.wl.names[0];
  const a = allocate({ ...cfg }, { equity: 100000, hwm: 100000, open: [] },
    { ticker: sig.ticker, dir: sig.bias, beta: sig.beta_60d, cluster: sig.cluster, atrPct: sig.atr_pct_14d, medianAtrPct: 6.9 });
  $('#riskbody').innerHTML = `<div class="crit">
    <div>base</div><div>equal-risk size (r ${cfg.riskPerTrade * 100}% / stop ${cfg.stopPct}% / ${cfg.leverage}x)</div><div>${(baseSize(cfg) * 100).toFixed(2)}%</div>
    <div>ex.</div><div>${sig.ticker} β ${sig.beta_60d} → ${a.adjustments.betaScaled ? 'scaled to β-cap' : 'full size'}</div><div>${(a.sizeFrac * 100).toFixed(2)}%</div>
    <div>caps</div><div>concurrent ${cfg.maxConcurrent} · cluster half · β ≤ ${cfg.betaCap * 100}% · DD −${cfg.ddThrottle * 100}% → ½</div><div></div></div>
    <div class="prov">${state.journal.state().closed.length
      ? `${state.journal.state().closed.length} closed trade(s) journalled — KPI & kill-criteria panel lands with Module D`
      : 'journal empty — record fills to activate KPIs & kill-criteria panel'}</div>`;
}

// ---- Position monitor (FR-A16) + fill capture (FR-D7/D8/D9) ----

const livePriceOf = t => state.mode === 'LIVE'
  ? (L().live[t]?.p ?? L().quotes[t]?.price ?? null)
  : (state.data.quotes[t]?.live ?? null);

function bookRows() {
  if (state.mode === 'LIVE') return L().book();
  const now = NOW();                            // demo has no tape: price the canned quote once per render
  for (const p of state.journal.state().open) {
    const q = livePriceOf(p.ticker) ?? p.entryPrice;
    const e = excursion(p, q);
    state.journal.updateExcursion(p.id, e.mae, e.mfe);
  }
  return state.journal.state().open.map(p => {
    const livePrice = livePriceOf(p.ticker) ?? p.entryPrice;
    return { ...p, livePrice, mon: monitorPosition(p, livePrice, now, state.cfg) };
  });
}
const bookOpen = fill => state.mode === 'LIVE' ? L().openPosition(fill) : state.journal.openPosition(fill);
const bookClose = (id, exit) => state.mode === 'LIVE' ? L().closePosition(id, exit) : state.journal.closePosition(id, exit);

const fmtUsd = v => '$' + Math.round(v).toLocaleString('en-US');
const fmtMin = fmtDuration;
const signed = v => (v >= 0 ? '+' : '') + v.toFixed(2);

// Stop ◄ price ► target, direction-agnostic: 0% is always the stop, 100% always the target.
function posStrip(r) {
  const m = r.mon; if (!m) return '';
  const f = v => Math.max(0, Math.min(100, (v - m.stop) / (m.target - m.stop) * 100));
  return `<div class="ps" title="stop ${m.stop.toFixed(2)} · entry ${r.entryPrice.toFixed(2)} · target ${m.target.toFixed(2)}">
    <i class="stopz"></i><i class="tgtz"></i><i class="entry" style="left:${f(r.entryPrice)}%"></i><i class="px" style="left:${f(r.livePrice)}%"></i></div>`;
}

function renderMonitor() {
  if (!state.journal) return;
  const rows = bookRows();
  const j = state.journal.state();
  const { equity, hwm } = state.journal.equity();
  $('#bookmeta').textContent = j.startingEquity == null
    ? 'starting equity not set — set it to size fills'
    : `equity ${fmtUsd(equity)} · HWM ${fmtUsd(hwm)} · ${rows.length}/${state.cfg.maxConcurrent} concurrent`;
  $('#prov-mon').textContent = state.mode === 'LIVE' ? 'LIVE-VENUE (Alpaca IEX)' : `DEMO SNAPSHOT · clock frozen at ${ASOF_LABEL} CET`;
  fireAlerts(rows);

  if (!rows.length) {
    $('#monbody').className = 'dim';
    $('#monbody').innerHTML = 'No open positions. Select a name with a signal to record an entry fill.';
    return;
  }
  $('#monbody').className = '';
  const body = rows.map(r => {
    const m = r.mon;
    if (!m) return `<tr><td>${r.ticker}</td><td colspan="11" class="dim">awaiting price…</td></tr>`;
    const cls = [m.alerts.stop && 'al-stop', m.alerts.target && 'al-target', m.alerts.time && 'al-time'].filter(Boolean).join(' ');
    const pnlCls = m.openPnlPct >= 0 ? 'up' : 'dn';
    return `<tr class="${cls}">
      <td>${r.ticker}</td>
      <td class="${r.dir === 'long' ? 'up' : 'dn'}">${r.dir}</td>
      <td class="num">${r.entryPrice.toFixed(2)}</td>
      <td class="num">${r.livePrice.toFixed(2)}</td>
      <td class="num ${pnlCls}">${signed(m.openPnlPct)}% <span class="dim">/</span> ${signed(m.openPnlLevered)}%</td>
      <td>${posStrip(r)}</td>
      <td class="num${m.alerts.stop ? ' dn' : ''}">${m.throughStop ? 'THROUGH' : m.toStopPct.toFixed(2) + 'pp'}<br><span class="dim">${m.toStopLevered.toFixed(1)}%</span></td>
      <td class="num${m.alerts.target ? ' up' : ''}">${m.throughTarget ? 'THROUGH' : m.toTargetPct.toFixed(2) + 'pp'}<br><span class="dim">${m.toTargetLevered.toFixed(1)}%</span></td>
      <td class="num">${fmtMin(m.minutesElapsed)}</td>
      <td class="num" title="${m.binding === 'TIME_STOP' ? `${state.cfg.timeStopHours}h time stop` : `hard close ${state.cfg.hardCloseCET} CET`}">
        ${fmtMin(m.minutesToLimit)}<br><span class="dim">${m.binding === 'TIME_STOP' ? 'time' : 'close'}</span></td>
      <td class="num${r.approx ? ' approx' : ''}" title="${r.approx ? 'approximate — a stream gap occurred while open (FR-D8)' : 'tracked from the tape'}">
        ${(r.mae ?? 0).toFixed(2)}/${(r.mfe ?? 0).toFixed(2)}${r.approx ? '~' : ''}</td>
      <td><button class="mini" data-close="${r.id}">close</button></td></tr>`;
  }).join('');
  $('#monbody').innerHTML = `<table><thead><tr>
    <th>Name</th><th>Dir</th><th class="num">Entry</th><th class="num">Live</th><th class="num">Open P&L und/lev</th>
    <th>Stop ◄ ► Target</th><th class="num">To stop</th><th class="num">To target</th>
    <th class="num">Held</th><th class="num">Left</th><th class="num">MAE/MFE</th><th></th>
    </tr></thead><tbody>${body}</tbody></table>`;
  $('#monbody').querySelectorAll('[data-close]').forEach(el => {
    el.onclick = () => openForm({ kind: 'exit', id: el.dataset.close });
  });
}

// Alerts latch per position and threshold: the render loop runs every 400ms, so an unlatched
// beep would be unusable. Re-arms only once price leaves the band.
const latch = {};
let actx = null;
function fireAlerts(rows) {
  let ring = false;
  const live = new Set();
  for (const r of rows) {
    if (!r.mon) continue;
    for (const k of ['stop', 'target', 'time']) {
      const key = `${r.id}:${k}`; live.add(key);
      if (r.mon.alerts[k]) { if (!latch[key]) { latch[key] = true; ring = true; } }
      else latch[key] = false;
    }
  }
  for (const k of Object.keys(latch)) if (!live.has(k)) delete latch[k];
  if (ring && !state.muted) beep();
}
function beep() {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime;
    o.type = 'square'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
    o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + 0.36);
  } catch { /* audio unavailable — the visual alert stands on its own */ }
}

// ---- Fill forms. Rendered into #fillform, which renderAll never touches, so typing survives ticks.
const dtLocal = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const openForm = f => { state.form = f; renderForm(); $('#fillform').scrollIntoView({ block: 'nearest' }); };
const closeForm = () => { state.form = null; renderForm(); };

function prefillSize(n, dir) {
  const { equity, hwm } = state.journal.equity();
  const open = state.journal.state().open.map(p => ({ ticker: p.ticker, dir: p.dir, sizeFrac: p.sizeFrac,
    beta: byT(p.ticker)?.beta_60d ?? 1, cluster: byT(p.ticker)?.cluster ?? '' }));
  return allocate(state.cfg, { equity, hwm, open },
    { ticker: n.ticker, dir, beta: n.beta_60d, cluster: n.cluster, atrPct: n.atr_pct_14d, medianAtrPct: state.medianAtr });
}

function renderForm() {
  const host = $('#fillform');
  const f = state.form;
  if (!f) { host.innerHTML = ''; return; }

  if (f.kind === 'equity') {
    host.innerHTML = `<div class="fillform"><h3>Starting equity</h3>
      <div class="fillgrid"><div><label>account equity (USD)</label>
        <input id="f_eq" type="number" step="100" value="${state.journal.state().startingEquity ?? 100000}" /></div></div>
      <div class="fillactions"><button id="f_save">Save</button><button class="mini" id="f_cancel">Cancel</button></div>
      <div class="fillnote">Sizing is mechanical from this number: risk ${state.cfg.riskPerTrade * 100}% ÷ (stop ${state.cfg.stopPct}% × ${state.cfg.leverage}x) = ${(baseSize(state.cfg) * 100).toFixed(2)}% of equity per full position. Equity and high-water mark then track realized P&L (FR-D1).</div></div>`;
    $('#f_cancel').onclick = closeForm;
    $('#f_save').onclick = () => {
      const v = Number($('#f_eq').value);
      if (!(v > 0)) return;
      state.journal.setStartingEquity(v); closeForm(); renderAll();
    };
    return;
  }

  if (f.kind === 'entry') {
    const n = byT(f.ticker);
    const px = livePriceOf(f.ticker) ?? n.close_at_screen;
    const a = prefillSize(n, f.dir);
    const { equity } = state.journal.equity();
    const eqKnown = state.journal.state().startingEquity != null;
    const frac = a.sizeable ? a.sizeFrac : baseSize(state.cfg);
    // Compare edits against what the operator was *shown*, not the raw float — otherwise the
    // 2-decimal prefill always differs from the tape price and every fill reads as edited.
    const pxShown = Number(px.toFixed(2)), szShown = Number((frac * 100).toFixed(2));
    const derived = { stop: stopPrice({ dir: f.dir, entryPrice: px }, state.cfg), target: targetPrice({ dir: f.dir, entryPrice: px }, state.cfg) };
    const adj = [a.adjustments.clusterHalved && 'cluster-halved', a.adjustments.betaScaled && 'scaled to β-cap',
      a.adjustments.ddHalved && 'drawdown-throttled'].filter(Boolean).join(' · ');
    host.innerHTML = `<div class="fillform"><h3>Entry fill — ${f.ticker} ${f.dir}</h3>
      <div class="fillgrid">
        <div><label>entry time (local)</label><input id="f_ts" type="datetime-local" value="${dtLocal(NOW())}" /></div>
        <div><label>entry price</label><input id="f_px" type="number" step="0.01" value="${pxShown}" /></div>
        <div><label>size (% of equity)</label><input id="f_sz" type="number" step="0.01" value="${szShown}" /></div>
        <div><label>stop</label><input id="f_stop" type="number" step="0.01" value="${derived.stop.toFixed(2)}" /></div>
        <div><label>target</label><input id="f_tgt" type="number" step="0.01" value="${derived.target.toFixed(2)}" /></div>
      </div>
      <div class="fillactions"><button id="f_save">Record entry</button><button class="mini" id="f_cancel">Cancel</button>
        <span class="dim" id="f_calc"></span></div>
      <div class="fillnote">
        ${a.sizeable ? `Mechanical size ${(a.sizeFrac * 100).toFixed(2)}% of equity${adj ? ` (${adj})` : ''}.`
                     : `<b class="dn">NOT SIZEABLE</b> — binding bucket: ${a.binding.join(', ')}. Recording is still permitted: the broker fill is the record of truth (FR-D7), and the signal is never hidden (FR-D4).`}
        ${eqKnown ? '' : ' <b class="dn">Starting equity is not set</b> — units and nominal cannot be computed until it is.'}
        Prefills come from the clock and the ${state.mode === 'LIVE' ? 'Layer 1 live price' : 'demo quote'}; every field is editable and an edit is flagged on the record.
        A signal snapshot (${f.snapshot.criteria.length} criteria, regime, preset ${presetHash(state.cfg)}) is attached automatically (FR-D8).
      </div></div>`;
    const recalc = () => {
      const p = Number($('#f_px').value), s = Number($('#f_sz').value) / 100;
      const nominal = equity * s * state.cfg.leverage;
      $('#f_calc').textContent = eqKnown && p > 0
        ? `${fmtUsd(equity * s)} margin · ${fmtUsd(nominal)} nominal · ${(nominal / p).toFixed(1)} units`
        : '';
    };
    ['#f_px', '#f_sz'].forEach(id => $(id).oninput = recalc);
    recalc();
    $('#f_cancel').onclick = closeForm;
    $('#f_save').onclick = () => {
      const p = Number($('#f_px').value), s = Number($('#f_sz').value) / 100, ts = $('#f_ts').value;
      if (!(p > 0) || !(s > 0) || !ts) return;
      bookOpen({ ticker: f.ticker, dir: f.dir, entryTs: new Date(ts).toISOString(), entryPrice: p,
        sizeFrac: s, leverage: state.cfg.leverage,
        stop: Number($('#f_stop').value), target: Number($('#f_tgt').value),
        edited: p !== pxShown || Number($('#f_sz').value) !== szShown,   // prefill overridden by the operator
        snapshot: { state: f.snapshot.state, criteria: f.snapshot.criteria, presetHash: presetHash(state.cfg),
                    mode: state.mode, regime: $('#regime').textContent } });
      closeForm(); renderAll();
    };
    return;
  }

  if (f.kind === 'exit') {
    const p = state.journal.state().open.find(x => x.id === f.id);
    if (!p) { closeForm(); return; }
    const px = livePriceOf(p.ticker) ?? p.entryPrice;
    const m = monitorPosition(p, px, NOW(), state.cfg);
    const suggested = m.throughStop ? 'STOP' : m.throughTarget ? 'TARGET' : m.minutesToLimit <= 0 ? 'TIME' : 'MANUAL';
    host.innerHTML = `<div class="fillform"><h3>Exit fill — ${p.ticker} ${p.dir}</h3>
      <div class="fillgrid">
        <div><label>exit time (local)</label><input id="f_ts" type="datetime-local" value="${dtLocal(NOW())}" /></div>
        <div><label>exit price</label><input id="f_px" type="number" step="0.01" value="${px.toFixed(2)}" /></div>
        <div><label>reason</label><select id="f_why">
          ${['TARGET', 'STOP', 'TIME', 'MANUAL'].map(r => `<option ${r === suggested ? 'selected' : ''}>${r}</option>`).join('')}
        </select></div>
      </div>
      <div class="fillactions"><button id="f_save">Record exit</button><button class="mini" id="f_cancel">Cancel</button>
        <span class="dim" id="f_calc"></span></div>
      <div class="fillnote">Realized P&L is computed on save in underlying % and leveraged %. The trade then moves to the journal, and an export is offered — localStorage is the only persistence on static hosting (compromise C8).</div></div>`;
    const recalc = () => {
      const x = Number($('#f_px').value);
      const und = (p.dir === 'long' ? 1 : -1) * (x - p.entryPrice) / p.entryPrice * 100;
      $('#f_calc').textContent = `${signed(und)}% underlying · ${signed(und * p.leverage)}% levered`;
    };
    $('#f_px').oninput = recalc; recalc();
    $('#f_cancel').onclick = closeForm;
    $('#f_save').onclick = () => {
      const x = Number($('#f_px').value), ts = $('#f_ts').value;
      if (!(x > 0) || !ts) return;
      bookClose(p.id, { exitTs: new Date(ts).toISOString(), exitPrice: x, exitReason: $('#f_why').value });
      closeForm(); renderAll();
      if (confirm('Trade closed and journalled. Export the journal now? (localStorage is the only persistence — C8)')) exportJournal();
    };
  }
}

function exportJournal() {
  const blob = new Blob([state.journal.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `journal_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

boot();
