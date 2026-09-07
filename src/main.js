import { BASELINE, presetHash } from './core/config.js';
import { sessionState } from './core/session.js';
import { evaluate } from './engine/signal.js';
import { allocate, baseSize, buckets } from './engine/sizing.js';
import { computeKpis, killCriteria, realizedPnl } from './engine/kpis.js';
import { runway } from './engine/levels.js';
import { monitorPosition, excursion, stopPrice, targetPrice, fmtDuration } from './engine/monitor.js';
import { makeJournal } from './core/store.js';
import { demoData, demoContext, DEMO_ASOF, demoSimProviders, DEMO_SIM } from './adapters/demo.js';
import { startLive, inBlackout } from './core/live.js';
import { runSimulation, runScan } from './core/sim.js';
import { PARAM_SPEC, diffFromBaseline, dofCount, overBudget, setPath, readParam,
         makePresetStore, makeLog, promotionInstruction } from './core/presets.js';
import { runBatch, aggregate, LABELS } from './core/batch.js';
import { makeQueue } from './core/queue.js';
import { openStream } from './adapters/alpacaStream.js';
import { regimeQuotes } from './adapters/fmp.js';
import { quotes as tdQuotes, bars as tdBars } from './adapters/twelvedata.js';
import { nextEarningsMap, earningsNear } from './adapters/finnhub.js';

const $ = s => document.querySelector(s);
const state = { mode: 'DEMO', wl: null, data: null, cfg: BASELINE, liveHandle: null,
  journal: null, muted: false, form: null, medianAtr: 6.9, states: {}, keys: null,
  sim: { result: null, scan: null, handle: null, running: false },
  wb: { cfg: null, active: null, store: null, log: null, batch: null, handle: null, running: false } };
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
  bootSim();
  bootWb();
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
  state.keys = keys;
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
    state.states[n.ticker] = d.result;          // reused by the bucket board; avoids a second evaluate pass
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-pause]').forEach(el => { el.onclick = ev => { ev.stopPropagation(); togglePause(el.dataset.pause); }; });
  const livePr = state.mode === 'LIVE';
  $('#prov-price').textContent = livePr ? 'LIVE-VENUE (Alpaca IEX) · REST-CACHED fallback' : `DEMO SNAPSHOT · as-of ${ASOF_LABEL} CET`;
  $('#prov-ref').textContent = livePr ? `FMP DELAYED + Finnhub EOD + screen ${state.wl.screening_date}` : `DEMO SNAPSHOT · screen ${state.wl.screening_date}`;
  renderMonitor();
  renderRisk();
  renderKpis();
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

// ---- Bucket board (FR-D3) + signal sizeability (FR-D4) ----

function bookForRisk() {
  const { equity, hwm } = state.journal.equity();
  const open = state.journal.state().open.map(p => ({
    ticker: p.ticker, dir: p.dir, sizeFrac: p.sizeFrac,
    beta: byT(p.ticker)?.beta_60d ?? 1, cluster: byT(p.ticker)?.cluster ?? '—' }));
  return { equity, hwm, open };
}

const pctBar = (r, extra = '') =>
  `<div class="bb"><i style="width:${(r.pct * 100).toFixed(1)}%" ${extra}></i></div>`;
const level = r => r.binding ? 'binding' : r.pct >= 0.75 ? 'warn' : '';
const num = (v, d = 2) => v == null ? '—' : v.toFixed(d);

function renderRisk() {
  const cfg = state.cfg;
  const book = bookForRisk();
  const realized = realizedPnl(state.journal.state().closed, NOW());
  const b = buckets(cfg, book, realized);
  const eqKnown = state.journal.state().startingEquity != null;

  $('#riskmeta').textContent = eqKnown
    ? `equity ${fmtUsd(book.equity)} · full size ${(baseSize(cfg) * 100).toFixed(2)}% of equity`
    : 'set starting equity to scale the board';

  const g = b.daily;
  const gauge = `<div class="gauge ${level(g)}">
    <div class="gh"><span>DAILY BUDGET — limit −${cfg.dailyLossLimitPct}% (FRD 5.2)</span>
      <span>${g.realized < 0 ? `realized ${num(g.realized)}%` : 'nothing realized'} · at stop ${num(g.atRisk)}%</span></div>
    <div class="gb"><i style="width:${(g.pct * 100).toFixed(1)}%"></i></div>
    <div class="gh" style="margin:6px 0 0"><span class="gv">${num(g.consumed)}% of ${cfg.dailyLossLimitPct}% committed</span>
      <span>week ${num(b.weekly.consumed)}% of ${cfg.weeklyLossLimitPct}%${b.weekly.binding ? ' — CIRCUIT BREAKER' : ''}</span></div></div>`;

  // Order matters: the grid places label and value on the first row, bar and note beneath.
  const rows = b.rows.map(r => `<div class="bkt ${level(r)}">
    <div class="bl">${r.label}</div>
    <div class="bv">${r.unit === '%' ? num(r.consumed) : r.consumed}${r.unit} <span class="dim">/ ${r.limit}${r.unit}</span></div>
    ${pctBar(r)}
    <div class="bn dim">${r.note}</div></div>`).join('');

  // FR-D4: every current signal is listed with its mechanical size, or NOT SIZEABLE and why.
  // The signal is never hidden because it cannot be taken.
  const sigs = state.wl.names
    .map(n => ({ n, r: state.states[n.ticker] }))
    .filter(x => x.r && (x.r.state === 'LONG' || x.r.state === 'SHORT'));
  const sigRows = sigs.map(({ n, r }) => {
    const dir = r.state.toLowerCase();
    const a = allocate(cfg, book, { ticker: n.ticker, dir, beta: n.beta_60d, cluster: n.cluster,
      atrPct: n.atr_pct_14d, medianAtrPct: state.medianAtr });
    const adj = [a.adjustments.clusterHalved && 'cluster-halved', a.adjustments.betaScaled && 'scaled to β-cap',
      a.adjustments.ddHalved && 'drawdown-throttled'].filter(Boolean).join(' · ');
    return `<div class="sig">
      <div class="${dir === 'long' ? 'up' : 'dn'}">${n.ticker}</div>
      <div>${a.sizeable ? `size ${(a.sizeFrac * 100).toFixed(2)}% of equity` : `<span class="notsize">NOT SIZEABLE</span> — binding: ${a.binding.join(', ')}`}</div>
      <div class="num">${a.sizeable && eqKnown ? fmtUsd(book.equity * a.sizeFrac * cfg.leverage) : ''}</div>
      <div class="sn">${a.sizeable ? (adj || `full size · β ${n.beta_60d} · ${n.cluster}`)
        : `would fit at 0% — close a position or wait for the bucket to free (FR-D4)`}</div></div>`;
  }).join('');

  $('#riskbody').innerHTML = gauge + rows +
    `<h2 style="margin:14px 0 4px">Current signals <small>${sigs.length || 'none'}</small></h2>` +
    (sigRows || '<div class="dim" style="font-size:12px">No LONG or SHORT signal right now.</div>');
}

// ---- KPI dashboard + kill criteria (FR-D11) ----

const KPI_WHY = {
  hitRate: 'Direct test against the 21% breakeven and the 15% kill line',
  profitFactor: 'Overall edge, robust to hit-rate noise',
  expectancy: 'The number the IC actually funds',
  avgMaeWinners: 'If winners routinely draw down first, the −0.8% stop is too tight',
  avgMfeLosers: 'If losers routinely reach +2% first, a partial-take rule deserves study',
  stopSlippagePp: 'Feeds the kill criterion; the leverage instruments\' real cost',
  timeInTrade: 'Tests the 3–5h horizon and the 5h time stop',
  exposure: '% of sessions with a position open — detects overtrading',
  sharpe: 'Annualization-free Sharpe on the per-trade return series',
  bookBeta: 'Detects the strategy quietly becoming a leveraged index bet',
};

function kpiCell(id, label, value, sub) {
  const why = KPI_WHY[id] ?? '';
  const body = value == null
    ? `<div class="kv na">n/a — ${sub}</div>`
    : `<div class="kv">${value}</div>${sub ? `<div class="ks">${sub}</div>` : ''}`;
  return `<div class="kpi" title="${why}"><div class="kl">${label}</div>${body}</div>`;
}

function renderKpis() {
  const cfg = state.cfg;
  const closed = state.journal.state().closed;
  const spyDaily = state.mode === 'LIVE' ? L()?.spy?.daily : null;
  const k = computeKpis(closed, { cfg, spyDaily });
  const kill = killCriteria(closed, cfg);

  $('#kpimeta').textContent = k.trades
    ? `${k.trades} closed trade${k.trades === 1 ? '' : 's'} in the journal`
    : 'journal empty — record an exit fill to populate';
  $('#prov-kpi').textContent = state.mode === 'LIVE' ? 'LIVE journal' : 'DEMO journal';

  $('#killstrip').innerHTML = kill.map(c => {
    // Bar fills toward the threshold: full means the line has been reached.
    const span = c.status === 'PENDING' || c.value == null ? 0
      : c.higherIsSafer ? Math.min(1, Math.max(0, 1 - (c.value - c.threshold) / (100 - c.threshold)))
                        : Math.min(1, Math.max(0, c.value / c.threshold));
    return `<div class="kill">
      <div>${c.label}</div>
      <div class="kbar"><i class="${c.status}" style="width:${(span * 100).toFixed(0)}%"></i><u style="left:100%"></u></div>
      <div class="num">${c.value == null ? '—' : num(c.value, c.unit === 'pp' ? 3 : c.unit === '%' ? 1 : 0) + c.unit}
        <span class="dim">/ ${c.threshold}${c.unit}</span></div>
      <div><span class="st ${c.status}">${c.status}</span></div>
      <div class="kn">${c.note}${c.distance != null && c.status !== 'PENDING'
        ? ` · ${c.distance >= 0 ? Math.abs(c.distance).toFixed(c.unit === 'pp' ? 3 : c.unit === '%' ? 1 : 0) + c.unit + ' of room' : 'past the line'}` : ''}</div>
    </div>`;
  }).join('');

  const pct = v => v == null ? null : (v * 100).toFixed(1) + '%';
  const pp = v => v == null ? null : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  $('#kpibody').innerHTML = `<div class="kgrid">
    ${kpiCell('hitRate', `Hit rate (last ${k.hitRateWindow ?? cfg.killHitRateWindow})`,
      pct(k.hitRate), k.hitRate == null ? k.na.all : 'breakeven ≈21%')}
    ${kpiCell('profitFactor', 'Profit factor', k.profitFactor?.toFixed(2),
      k.profitFactor == null ? (k.na.profitFactor ?? k.na.all) : 'gross wins ÷ gross losses')}
    ${kpiCell('expectancy', 'Expectancy / trade', pp(k.expectancy),
      k.expectancy == null ? k.na.all : `of equity · avg win ${pp(k.avgWin) ?? '—'} / loss ${pp(k.avgLoss) ?? '—'}`)}
    ${kpiCell('avgMaeWinners', 'Avg MAE (winners)', k.avgMaeWinners == null ? null : k.avgMaeWinners.toFixed(2) + 'pp',
      k.avgMaeWinners == null ? (k.na.avgMaeWinners ?? k.na.all) : `stop sits at ${cfg.stopPct}pp`)}
    ${kpiCell('avgMfeLosers', 'Avg MFE (losers)', k.avgMfeLosers == null ? null : k.avgMfeLosers.toFixed(2) + 'pp',
      k.avgMfeLosers == null ? (k.na.avgMfeLosers ?? k.na.all) : `target sits at ${cfg.targetPct}pp`)}
    ${kpiCell('stopSlippagePp', 'Stop slippage', k.stopSlippagePp == null ? null : k.stopSlippagePp.toFixed(3) + 'pp',
      k.stopSlippagePp == null ? (k.na.stopSlippagePp ?? k.na.all) : `over ${k.stopCount} stop${k.stopCount === 1 ? '' : 's'} · kill at ${cfg.killSlippagePp}pp`)}
    ${kpiCell('timeInTrade', 'Time in trade', k.timeInTrade == null ? null : fmtDuration(k.timeInTrade.medianMin),
      k.timeInTrade == null ? k.na.all : `median · max ${fmtDuration(k.timeInTrade.maxMin)} · time stop ${cfg.timeStopHours}h`)}
    ${kpiCell('exposure', 'Exposure', k.exposure == null ? null : (k.exposure.pct * 100).toFixed(0) + '%',
      k.exposure == null ? k.na.all : `${k.exposure.activeDays}/${k.exposure.sessionDays} sessions with a position`)}
    ${kpiCell('sharpe', 'Rolling Sharpe', k.sharpe?.toFixed(2),
      k.sharpe == null ? (k.na.sharpe ?? k.na.all) : `per-trade, annualization-free`)}
    ${kpiCell('bookBeta', 'Realized book beta', k.bookBeta?.toFixed(2),
      k.bookBeta == null ? (k.na.bookBeta ?? k.na.all) : 'daily P&L vs SPY')}
  </div>`;
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


// ---- Module B — point-in-time simulator (FR-B1–B8) ----

// Demo and live run the identical orchestrator and the identical engine; only the providers differ.
function simDeps() {
  if (state.mode === 'LIVE') {
    const k = state.keys;
    let vixDead = false;                     // one failed probe is enough — a scan must not retry 20×
    return {
      queue: makeQueue(),                    // the real FR-A5 throttle: a 20-name scan takes minutes
      tdBars: (sym, interval, size, range) => tdBars(sym, interval, size, k.td, fetch, range),
      vixAt: async date => {
        if (vixDead || !k.td) return null;
        try {
          const b = await tdBars('VIX', '1day', 5000, k.td, fetch, { end_date: date });
          return b.at(-1)?.c ?? null;
        } catch { vixDead = true; return null; }   // free tiers rarely carry index history
      },
      earningsAt: k.fh ? (ticker, date) => earningsNear(ticker, date, k.fh) : undefined,
    };
  }
  return { ...demoSimProviders(state.wl), queue: makeQueue({ perMinute: 1e6 }) };
}

function bootSim() {
  $('#s_date').value = DEMO_SIM.date;
  $('#s_time').value = DEMO_SIM.timeCET;
  $('#s_preset').value = `baseline ${presetHash(state.cfg)}`;
  $('#s_ticker').innerHTML = state.wl.names.map(n => `<option>${n.ticker}</option>`).join('');
  $('#s_run').onclick = () => runSim(false);
  $('#s_scan').onclick = () => runSim(true);
  $('#s_cancel').onclick = () => { state.sim.handle?.cancel(); $('#s_progress').textContent = 'cancelling…'; };
  renderSimCaveats();
}

async function runSim(scan) {
  if (state.sim.running) return;
  const args = { date: $('#s_date').value, timeCET: $('#s_time').value, cfg: state.cfg, watchlist: state.wl };
  if (!args.date || !args.timeCET) return;
  state.sim = { result: null, scan: null, handle: null, running: true };
  $('#simbody').className = 'dim';
  $('#simbody').textContent = scan ? 'Scanning the watchlist…' : 'Running…';
  $('#s_progress').textContent = state.mode === 'LIVE'
    ? 'live providers — the FR-A5 queue paces this at 8 calls/min' : '';
  const deps = simDeps();
  try {
    if (scan) {
      const handle = runScan(args, deps, p => {
        $('#s_progress').textContent = `${p.done}/${p.total}${p.cancelled ? ' — cancelled' : ''}`;
        state.sim.scan = { results: [...(state.sim.scan?.results ?? []), p.last], done: p.done, total: p.total };
        renderSim();
      });
      state.sim.handle = handle;
      const out = await handle.promise;
      state.sim.scan = { ...out, done: out.results.length };
    } else {
      state.sim.result = await runSimulation({ ...args, ticker: $('#s_ticker').value }, deps);
    }
  } catch (e) {
    $('#simbody').className = 'dim';
    $('#simbody').textContent = `Simulation failed: ${e.message ?? e}`;
  }
  state.sim.running = false;
  $('#s_progress').textContent = state.sim.scan?.cancelled ? 'cancelled' : '';
  renderSim();
  renderSimCaveats();
}

// Episode chart: candles, with entry, stop, target and the binding runway level drawn in (FR-B5).
function episodeChart(r) {
  const bars = r.episode ?? [];
  if (bars.length < 2) return '';
  const W = 620, H = 190, PAD = 34;
  const lv = r.levels ?? {};
  const prices = bars.flatMap(b => [b.h, b.l])
    .concat([lv.stop, lv.target, lv.runway, r.entry?.price].filter(v => v != null));
  const lo = Math.min(...prices), hi = Math.max(...prices), span = (hi - lo) || 1;
  const y = p => PAD / 2 + (hi - p) / span * (H - PAD);
  const x = i => 4 + i * ((W - 8) / bars.length);
  const bw = Math.max(1.2, (W - 8) / bars.length * 0.62);

  const candles = bars.map((b, i) => {
    const cls = b.c >= b.o ? 'up' : 'dn';
    const cx = x(i) + bw / 2;
    return `<line class="${cls}" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke-width="1"/>`
      + `<rect class="${cls}" x="${x(i).toFixed(1)}" y="${Math.min(y(b.o), y(b.c)).toFixed(1)}" width="${bw.toFixed(1)}"
          height="${Math.max(0.8, Math.abs(y(b.o) - y(b.c))).toFixed(1)}" fill="currentColor" stroke="none" opacity=".55"/>`;
  }).join('');

  const line = (p, colour, label, dash = '4 3') => p == null ? '' :
    `<line x1="0" x2="${W}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" stroke="${colour}" stroke-width="1" stroke-dasharray="${dash}"/>
     <text x="4" y="${(y(p) - 3).toFixed(1)}" fill="${colour}">${label} ${p.toFixed(2)}</text>`;

  const entryIdx = r.entry ? bars.findIndex(b => b.t >= r.entry.ts) : -1;
  const exitIdx = r.entry && r.walk ? entryIdx + r.walk.barIdx : -1;
  const mark = (i, colour, label) => i < 0 || i >= bars.length ? '' :
    `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="0" y2="${H}" stroke="${colour}" stroke-width="1" opacity=".55"/>
     <text x="${(x(i) + 3).toFixed(1)}" y="${H - 4}" fill="${colour}">${label}</text>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="episode chart with entry, stop, target and runway">
    ${line(lv.runway, '#8A93A0', `runway ${r.levels?.runwayName ?? ''}`, '2 4')}
    ${line(lv.target, '#3FB68B', 'target')}
    ${line(lv.stop, '#D08048', 'stop')}
    ${candles}
    ${mark(entryIdx, '#E8EAED', 'entry')}
    ${mark(exitIdx, r.verdict === 'WIN' ? '#3FB68B' : r.verdict === 'LOSS' ? '#D08048' : '#C9A961', 'exit')}
  </svg>`;
}

function simPnl(r) {
  if (!r.walk) return null;
  const n = byT(r.ticker); if (!n) return null;
  const { equity, hwm } = state.journal.equity();
  const a = allocate(state.cfg, { equity, hwm, open: [] },
    { ticker: r.ticker, dir: r.state.toLowerCase(), beta: n.beta_60d, cluster: n.cluster,
      atrPct: n.atr_pct_14d, medianAtrPct: state.medianAtr });
  const levered = r.walk.underlyingPct * state.cfg.leverage;
  const eqKnown = state.journal.state().startingEquity != null;
  return { sizeFrac: a.sizeFrac, levered,
    cash: eqKnown ? equity * a.sizeFrac * levered / 100 : null };
}

function renderSim() {
  const { result: r, scan } = state.sim;
  const body = $('#simbody');
  if (scan) {
    const rows = (scan.results ?? []).map(x => {
      const v = x.verdict ?? (x.state === 'NO DATA' || x.state === 'ERROR' ? x.state : 'no setup');
      const cls = { WIN: 'up', LOSS: 'dn' }[x.verdict] ?? 'dim';
      return `<tr><td>${x.ticker}</td><td><span class="state ${x.state}">${x.state}</span></td>
        <td class="${cls}">${v}</td>
        <td class="num">${x.walk ? x.walk.underlyingPct.toFixed(2) + '%' : '—'}</td>
        <td class="num">${x.walk ? (x.walk.underlyingPct * state.cfg.leverage).toFixed(1) + '%' : '—'}</td>
        <td class="dim">${x.resolution ?? '—'}</td>
        <td class="dim">${Object.keys(x.errors ?? {}).length ? Object.keys(x.errors).join(', ') : ''}</td></tr>`;
    }).join('');
    const q = (scan.results ?? []).filter(x => x.qualified).length;
    body.className = '';
    body.innerHTML = `<div class="simstamp">${scan.done ?? 0}/${scan.total ?? 0} names · ${q} qualifying setup${q === 1 ? '' : 's'}
      · preset ${presetHash(state.cfg)}${scan.cancelled ? ' · CANCELLED' : ''}</div>
      <table><thead><tr><th>Name</th><th>State</th><th>Verdict</th><th class="num">Underlying</th>
      <th class="num">Levered</th><th>Res.</th><th>Errors</th></tr></thead><tbody>${rows}</tbody></table>`;
    return;
  }
  if (!r) return;
  body.className = '';
  const pnl = simPnl(r);
  const errs = Object.entries(r.errors ?? {});
  const verdictCls = r.verdict === 'TIME-OUT' ? 'TIMEOUT' : (r.verdict ?? 'NONE');
  body.innerHTML = `
    <div class="verdict">
      <span class="vd ${verdictCls}">${r.verdict ?? 'NO SETUP'}</span>
      <span class="state ${r.state}">${r.state}</span>
      <span class="simnums">
        ${r.walk ? `<span>underlying <b class="${r.walk.underlyingPct >= 0 ? 'up' : 'dn'}">${r.walk.underlyingPct.toFixed(2)}%</b></span>
          <span>levered <b class="${r.walk.underlyingPct >= 0 ? 'up' : 'dn'}">${(r.walk.underlyingPct * state.cfg.leverage).toFixed(1)}%</b></span>
          <span>MAE ${r.walk.mae.toFixed(2)}pp · MFE ${r.walk.mfe.toFixed(2)}pp</span>
          ${pnl ? `<span>on ${(pnl.sizeFrac * 100).toFixed(2)}% of equity${pnl.cash != null ? ` → <b class="${pnl.cash >= 0 ? 'up' : 'dn'}">${fmtUsd(pnl.cash)}</b>` : ''}</span>` : ''}`
        : '<span class="dim">no qualifying setup at this moment — criteria below</span>'}
      </span>
    </div>
    <div class="simstamp">${r.ticker} · ${r.date} ${r.timeCET} CET · preset ${r.presetHash} · ${r.resolution ?? '—'} bars · ${r.provider}</div>
    ${(r.notEvaluated ?? []).length ? `<div class="notev">not evaluated: ${r.notEvaluated.map(x => `${x.id} (${x.why})`).join(' · ')}</div>` : ''}
    ${errs.length ? `<div class="notev">provider errors: ${errs.map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>` : ''}
    ${episodeChart(r)}
    <div class="crit">${(r.criteria ?? []).map(c => {
      const mark = c.enabled === false ? '<span class="off">off</span>' : c.pass ? '<span class="ok">✓</span>' : '<span class="no">✗</span>';
      const val = typeof c.value === 'number' ? c.value.toFixed(2) : String(c.value);
      return `<div>${c.id}</div><div>${c.detail}</div><div>${mark} ${val}</div>`;
    }).join('')}</div>`;
}

// FR-B7: the caveats are not a footnote, they are part of the result.
function renderSimCaveats() {
  const r = state.sim.result;
  const res = r?.resolution ?? '5min';
  $('#simcaveats').innerHTML = `<div class="caveats">
    <b>This is an illustration of mechanics, not a backtest.</b>
    Today's watchlist is applied to a past date, so the names carry survivorship bias — they were
    selected knowing they survived. Bars are ${res}${res === '1h' ? ' (5-minute history unavailable for this date)' : ''},
    and where one bar's range spans both stop and target the engine assumes <b>the stop was hit first</b>
    — a conservative rule that binds far less often at 5-minute than at 1-hour resolution.
    VWAP is rebuilt from bar data rather than the live tape. No slippage, financing or fee modelling.
    Provider price adjustments for splits and dividends are provider-dependent.
    Every result is stamped with its preset hash and resolution; results under different hashes are not comparable.
  </div>`;
}


// ---- Module C — configuration & optimization workbench (FR-C1–C9) ----
// The governance is the feature. state.cfg (what Module A evaluates) is NEVER touched here:
// FRD 4.7 §1 locks live evaluation to the committed baseline, and experiments live in B and C.

const DOF_BUDGET = 3;

function bootWb() {
  state.wb.cfg = structuredClone(BASELINE);
  state.wb.store = makePresetStore(localStorage);
  state.wb.log = makeLog(localStorage);
  $('#c_exp').onclick = () => download('presets.json', state.wb.store.exportJSON());
  $('#c_imp').onclick = () => $('#c_file').click();
  $('#c_file').onchange = async ev => {
    const f = ev.target.files?.[0]; if (!f) return;
    try {
      const n = state.wb.store.importJSON(await f.text());
      state.wb.log.append({ action: 'imported', preset: `${n} preset(s)`, hash: '—', detail: f.name });
      renderPresets(); renderLog(); renderBatchForm();
    } catch (e) { alertLine(`Import failed: ${e.message}`); }
    ev.target.value = '';
  };
  renderParams(); renderWbSummary(); renderPresets(); renderLog(); renderBatchForm();
}

// #c_warn is the persistent DoF warning (FR-C9) and is rewritten on every edit; transient
// messages therefore need their own container or they are wiped the moment they appear.
const alertLine = msg => { $('#c_msg').innerHTML = `<div class="wbwarn">${msg}</div>`; };

function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

// FR-C1/C2: every parameter editable, each showing its baseline value, deviations marked.
function renderParams() {
  const groups = [...new Set(PARAM_SPEC.map(s => s.group))];
  $('#c_params').innerHTML = groups.map(gname => {
    const rows = PARAM_SPEC.filter(s => s.group === gname).map(spec => {
      const cur = readParam(state.wb.cfg, spec), base = readParam(BASELINE, spec);
      return `<div class="prow" data-row="${spec.key}">
        <div class="plabel">${spec.label}</div>
        <div>${control(spec, cur)}</div>
        <div class="base">${fmtVal(base)}</div></div>`;
    }).join('');
    return `<div class="pgroup">${gname.toUpperCase()}</div>${rows}`;
  }).join('');
  $('#c_params').querySelectorAll('[data-key]').forEach(el => {
    el.oninput = () => onParamEdit(el);
    el.onchange = () => onParamEdit(el);
  });
  markDeviations();
}

const fmtVal = v => Array.isArray(v) ? `[${v.join('–')}]` : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);

function control(spec, cur) {
  const a = `data-key="${spec.key}" data-type="${spec.type}"`;
  const lim = `${spec.min != null ? `min="${spec.min}"` : ''} ${spec.max != null ? `max="${spec.max}"` : ''} ${spec.step != null ? `step="${spec.step}"` : ''}`;
  if (spec.type === 'range2') return `<div class="r2">
    <input type="number" ${a} data-idx="0" ${lim} value="${cur[0]}" />
    <input type="number" ${a} data-idx="1" ${lim} value="${cur[1]}" /></div>`;
  if (spec.type === 'bool' || spec.type === 'criterion')
    return `<input type="checkbox" ${a} ${cur ? 'checked' : ''} />`;
  if (spec.type === 'time') return `<input type="time" ${a} value="${cur}" />`;
  return `<input type="number" ${a} ${lim} value="${cur}" />`;
}

function onParamEdit(el) {
  const key = el.dataset.key, type = el.dataset.type;
  if (type === 'range2') {
    const band = [...readParam(state.wb.cfg, { key, type })];
    band[+el.dataset.idx] = Number(el.value);
    state.wb.cfg = setPath(state.wb.cfg, key, band);
  } else if (type === 'bool' || type === 'criterion') {
    state.wb.cfg = setPath(state.wb.cfg, key, el.checked);
  } else if (type === 'time') {
    state.wb.cfg = setPath(state.wb.cfg, key, el.value);
  } else {
    state.wb.cfg = setPath(state.wb.cfg, key, Number(el.value));
  }
  markDeviations(); renderWbSummary();
}

function markDeviations() {
  const dev = new Set(diffFromBaseline(state.wb.cfg).map(d => d.spec.key));
  $('#c_params').querySelectorAll('[data-row]').forEach(row => {
    row.classList.toggle('dev', dev.has(row.dataset.row));
  });
}

function renderWbSummary() {
  const cfg = state.wb.cfg, n = dofCount(cfg), diff = diffFromBaseline(cfg);
  $('#wbmeta').textContent = `${state.wb.active ?? 'unsaved draft'} · ${presetHash(cfg)} · ${n} deviation${n === 1 ? '' : 's'}`;
  // FR-C9 / FRD 4.7 §4
  $('#c_warn').innerHTML = overBudget(cfg, DOF_BUDGET)
    ? `<div class="wbwarn">DEGREES-OF-FREEDOM BUDGET EXCEEDED — ${n} parameters differ from baseline, the protocol allows ${DOF_BUDGET}.
       Sweeping many parameters at once guarantees a spurious winner somewhere. Batch results for this preset are badged.</div>`
    : '';
  $('#c_diff').innerHTML = diff.length
    ? `<div class="diffgrid">${diff.map(d =>
        `<div class="dk">${d.spec.key}</div><div>${d.spec.label}</div><div class="num">${fmtVal(d.base)} → <b>${fmtVal(d.current)}</b></div>`).join('')}</div>`
    : '<div class="dim" style="font-size:11px">Identical to the committed baseline.</div>';
}

// FR-C3/C4: named presets, hashes, fork-on-edit-when-locked, export/import.
function renderPresets() {
  const list = state.wb.store.list();
  const rows = list.map(p => `<div class="presetrow ${p.name === state.wb.active ? 'on' : ''}">
      <div>${p.name}${p.locked ? '<span class="lockbadge">LOCKED</span>' : ''}
        ${overBudget(p.cfg, DOF_BUDGET) ? '<span class="lockbadge">&gt;DoF</span>' : ''}</div>
      <div>
        <button class="mini" data-load="${p.name}">load</button>
        ${p.locked ? '' : `<button class="mini" data-lock="${p.name}">lock</button>`}
        <button class="mini" data-promote="${p.name}">promote…</button>
        <button class="mini" data-del="${p.name}">×</button>
      </div>
      <div class="pmeta">${p.hash} · ${dofCount(p.cfg)} deviation(s)${p.parent ? ` · forked from ${p.parent}` : ''}</div>
    </div>`).join('');
  $('#c_presets').innerHTML = (rows || '<div class="dim" style="font-size:11px">No presets saved yet.</div>') +
    `<div class="fillactions">
      <input id="c_name" placeholder="preset name" style="flex:1;background:var(--bg);border:1px solid var(--edge);
        color:var(--ink);padding:5px 8px;border-radius:3px;font:11px var(--mono)" />
      <button class="mini" id="c_save">Save current</button></div>`;

  $('#c_save').onclick = () => {
    const name = $('#c_name').value.trim();
    if (!name) return;
    const existing = state.wb.store.get(name);
    try {
      if (!existing) {
        const p = state.wb.store.create(name, structuredClone(state.wb.cfg));
        state.wb.log.append({ action: 'created', preset: p.name, hash: p.hash,
          detail: `${dofCount(p.cfg)} deviation(s) from baseline` });
        state.wb.active = p.name;
      } else {
        const r = state.wb.store.update(name, structuredClone(state.wb.cfg));
        state.wb.active = r.preset.name;
        state.wb.log.append({ action: r.forked ? 'forked (parent was locked)' : 'updated',
          preset: r.preset.name, hash: r.preset.hash, detail: r.forked ? `from ${r.from}` : '' });
        if (r.forked) alertLine(`"${name}" is locked, so the edit became a new preset "${r.preset.name}" —
          results stay attached to the hash that produced them (FR-C4).`);
      }
      $('#c_name').value = '';
      renderPresets(); renderLog(); renderWbSummary(); renderBatchForm();
    } catch (e) { alertLine(e.message); }
  };
  $('#c_presets').querySelectorAll('[data-load]').forEach(el => el.onclick = () => {
    const p = state.wb.store.get(el.dataset.load);
    state.wb.cfg = structuredClone(p.cfg); state.wb.active = p.name;
    renderParams(); renderWbSummary(); renderPresets();
  });
  $('#c_presets').querySelectorAll('[data-lock]').forEach(el => el.onclick = () => {
    const r = state.wb.store.lock(el.dataset.lock);
    if (r.changed) state.wb.log.append({ action: 'locked', preset: r.preset.name, hash: r.preset.hash,
      detail: 'no further edits without becoming a new preset' });
    renderPresets(); renderLog();
  });
  $('#c_presets').querySelectorAll('[data-del]').forEach(el => el.onclick = () => {
    state.wb.store.remove(el.dataset.del);
    if (state.wb.active === el.dataset.del) state.wb.active = null;
    renderPresets(); renderWbSummary(); renderBatchForm();
  });
  // FR-C8: promotion is a repository commit. The UI prints the edit and stops.
  $('#c_presets').querySelectorAll('[data-promote]').forEach(el => el.onclick = () => {
    const p = state.wb.store.get(el.dataset.promote);
    $('#c_msg').innerHTML = `<div class="wbwarn" style="border-color:var(--armed);color:var(--armed);
      background:color-mix(in srgb,var(--armed) 10%,transparent)"><pre style="margin:0;white-space:pre-wrap;font:11px var(--mono)">${promotionInstruction(p)}</pre></div>`;
    state.wb.log.append({ action: 'promotion instruction shown', preset: p.name, hash: p.hash });
    renderLog();
  });
}

function renderLog() {
  const entries = state.wb.log.list();
  $('#c_log').innerHTML =
    (entries.length ? entries.slice().reverse().map(e =>
      `<div class="logentry"><b>${e.action}</b> — ${e.preset} <span class="dim">${e.hash}</span><br>
        <span class="dim">${e.ts.replace('T', ' ').slice(0, 16)}</span>${e.detail ? ` · ${e.detail}` : ''}
        ${e.rationale ? `<br>“${e.rationale}”` : ''}</div>`).join('')
      : '<div class="dim" style="font-size:11px">Empty. Every preset created, locked or promoted lands here.</div>') +
    `<div class="fillactions" style="flex-wrap:wrap">
      <input id="c_rationale" placeholder="rationale — the mechanism, not the metric"
        style="flex:1;min-width:180px;background:var(--bg);border:1px solid var(--edge);color:var(--ink);
        padding:5px 8px;border-radius:3px;font:11px var(--mono)" />
      <button class="mini" id="c_addlog">Record</button>
      <button class="mini" id="c_logjson">JSON</button>
      <button class="mini" id="c_logmd">Markdown</button></div>
    <div class="wbnote">Append-only (FR-C8). The Markdown export is the IC appendix artefact.</div>`;
  $('#c_addlog').onclick = () => {
    const r = $('#c_rationale').value.trim(); if (!r) return;
    const p = state.wb.active ? state.wb.store.get(state.wb.active) : null;
    state.wb.log.append({ action: 'rationale', preset: p?.name ?? 'unsaved draft',
      hash: p?.hash ?? presetHash(state.wb.cfg), rationale: r });
    renderLog();
  };
  $('#c_logjson').onclick = () => download('optimization_log.json', state.wb.log.exportJSON());
  $('#c_logmd').onclick = () => download('optimization_log.md', state.wb.log.exportMarkdown(), 'text/markdown');
}

// FR-C5/C7: the batch runner, and the tuning/validation split it enforces.
function renderBatchForm() {
  const presets = state.wb.store.list();
  $('#c_batch').innerHTML = `
    <div class="fillgrid">
      <div class="wide"><label>dates (one per line or comma-separated)</label>
        <textarea id="c_dates">${defaultDates().join('\n')}</textarea></div>
      <div><label>entry time (CET)</label><input id="c_time" type="time" value="16:00" /></div>
      <div><label>date set</label><select id="c_label">${LABELS.map(l => `<option>${l}</option>`).join('')}</select></div>
    </div>
    <div class="plist">${presets.length
      ? presets.map(p => `<label><input type="checkbox" data-preset="${p.name}" ${p.name === state.wb.active ? 'checked' : ''} /> ${p.name} <span class="dim">${p.hash}</span></label>`).join('')
      : '<span class="dim">Save a preset to run a batch — the runner compares named configurations, it does not search.</span>'}</div>
    <div class="fillactions"><button id="c_run">Run batch</button>
      <button class="mini" id="c_cancel">Cancel</button>
      <span class="dim" id="c_progress"></span></div>
    <div class="wbnote">A <b>validation</b> run locks every selected preset before its first date (FRD 4.7 §3):
      results can never be attributed to a configuration that changed afterwards. Tuning and validation
      outcomes are reported separately and never pooled.</div>`;
  $('#c_run').onclick = runBatchUI;
  $('#c_cancel').onclick = () => { state.wb.handle?.cancel(); $('#c_progress').textContent = 'cancelling…'; };
}

const defaultDates = () => ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'];

async function runBatchUI() {
  if (state.wb.running) return;
  const chosen = [...$('#c_batch').querySelectorAll('[data-preset]')].filter(el => el.checked)
    .map(el => state.wb.store.get(el.dataset.preset));
  if (!chosen.length) { alertLine('Select at least one preset. The runner compares operator-defined presets — it never searches.'); return; }
  const dates = $('#c_dates').value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  if (!dates.length) return;
  const label = $('#c_label').value;

  state.wb.running = true;
  $('#c_results').innerHTML = '';
  const deps = { ...simDeps(), presetStore: state.wb.store };
  const handle = runBatch({ dates, presets: chosen, label, timeCET: $('#c_time').value, watchlist: state.wl },
    deps, p => { $('#c_progress').textContent = `${p.done}/${p.total} — ${p.preset} @ ${p.date}`; });
  state.wb.handle = handle;
  const out = await handle.promise;
  state.wb.running = false;
  $('#c_progress').textContent = out.cancelled ? `cancelled at ${out.done}/${out.total}` : '';
  if (out.locked.length) {
    state.wb.log.append({ action: 'locked for validation', preset: out.locked.join(', '), hash: '—',
      detail: `before running ${dates.length} validation date(s)` });
    alertLine(`Validation run — locked before the first date: ${out.locked.join(', ')}. Editing any of them now creates a new preset (FR-C4).`);
    renderPresets(); renderLog();
  }
  state.wb.batch = [...(state.wb.batch ?? []), ...out.runs];
  renderBatchResults();
}

function renderBatchResults() {
  const rows = aggregate(state.wb.batch ?? [], state.wl);
  if (!rows.length) { $('#c_results').innerHTML = ''; return; }
  const pct = v => v == null ? '—' : (v * 100).toFixed(0) + '%';
  const num = (v, d = 2) => v == null ? '—' : v.toFixed(d);
  const table = label => {
    const rs = rows.filter(r => r.label === label);
    if (!rs.length) return '';
    return `<div class="lbl">${label.toUpperCase()} DATES</div>
      <table><thead><tr><th>Preset</th><th>Hash</th><th class="num">Dates</th><th class="num">Signals</th>
      <th class="num">Hit</th><th class="num">Expectancy</th><th class="num">Avg MAE</th><th class="num">Avg MFE</th>
      <th class="num">Time-out</th><th>Res.</th></tr></thead><tbody>
      ${rs.map(r => `<tr>
        <td>${r.preset}${r.dofOverBudget ? '<span class="lockbadge">&gt;DoF</span>' : ''}</td>
        <td class="dim">${r.hash}</td><td class="num">${r.dates}</td><td class="num">${r.signals}</td>
        <td class="num">${pct(r.hitRate)}</td><td class="num">${r.expectancy == null ? '—' : num(r.expectancy) + '%'}</td>
        <td class="num">${num(r.avgMae)}</td><td class="num">${num(r.avgMfe)}</td>
        <td class="num">${pct(r.timeoutShare)}</td><td class="dim">${r.resolutions.join(', ') || '—'}</td></tr>`).join('')}
      </tbody></table>`;
  };
  $('#c_results').innerHTML = table('tuning') + table('validation') +
    `<div class="wbnote">Expectancy is per trade at Module D sizing, in % of equity, measured by the same
      <code>computeKpis()</code> the live journal uses. Rows under different hashes are different strategies,
      not different runs of one. Tuning and validation are never pooled (FR-C7).</div>`;
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
