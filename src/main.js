import { BASELINE, presetHash } from './core/config.js';
import { sessionState, minutesToHardClose } from './core/session.js';
import { evaluate } from './engine/signal.js';
import { allocate, baseSize } from './engine/sizing.js';
import { runway } from './engine/levels.js';
import { demoData } from './adapters/demo.js';
import { startLive, inBlackout } from './core/live.js';
import { makeQueue } from './core/queue.js';
import { openStream } from './adapters/alpacaStream.js';
import { regimeQuotes } from './adapters/fmp.js';
import { quotes as tdQuotes, bars as tdBars } from './adapters/twelvedata.js';
import { nextEarningsMap } from './adapters/finnhub.js';

const $ = s => document.querySelector(s);
const state = { mode: 'DEMO', wl: null, data: null, cfg: BASELINE, liveHandle: null };
const L = () => state.liveHandle?.state;

async function boot() {
  state.wl = await (await fetch('./watchlist.json')).json();
  $('#screendate').textContent = `screened ${state.wl.screening_date} · baseline ${presetHash(BASELINE)}`;
  state.data = demoData(state.wl);
  $('#mode').textContent = 'DEMO MODE — canned data; enter keys to go live.';
  $('#go').onclick = goLive;
  renderAll();
  setInterval(renderHeader, 2000);
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
    earningsMap: nextEarningsMap, queue };
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

function ctxFor(n) {   // DEMO-mode ctx (live-mode ctx is assembled in core/live.js)
  const d = state.data, hb = d.hourBars[n.ticker], fm = d.fiveMin[n.ticker];
  const dailyBars = hb.slice(-10).map(b => ({ h: b.h, l: b.l, c: b.c }));
  const prevDay = dailyBars.at(-2) ?? dailyBars.at(-1);
  return { dir: n.bias === 'long' ? 'long' : 'short', hourBars: hb, fiveMinBars: fm,
    slotBaseline: d.baselines[n.ticker], slotIndex: Math.min(77, fm.length - 1),
    livePrice: d.quotes[n.ticker].live, prevDay, dailyBars,
    spyAboveMA: d.spy.price > d.spy.ma20, vix: d.vix,
    minutesToTimeStop: Math.min(300, Math.max(0, minutesToHardClose(new Date(), state.cfg))),
    inEntryWindow: sessionState(new Date(), state.cfg) === 'ENTRY_OPEN',
    inBlackout: false, blackoutOverride: false };
}

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
  const ss = sessionState(new Date(), state.cfg);
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
  $('#prov-price').textContent = livePr ? 'LIVE-VENUE (Alpaca IEX) · REST-CACHED fallback' : 'DEMO';
  $('#prov-ref').textContent = livePr ? `FMP DELAYED + Finnhub EOD + screen ${state.wl.screening_date}` : 'DEMO';
  renderRisk();
}

function renderDrill(n, r) {
  const rows = r.criteria.map(c => {
    const mark = c.enabled === false ? '<span class="off">off</span>' : c.pass ? '<span class="ok">✓</span>' : '<span class="no">✗</span>';
    const val = typeof c.value === 'number' ? c.value.toFixed(2) : String(c.value);
    return `<div>${c.id}</div><div>${c.detail}</div><div>${mark} ${val}</div>`;
  }).join('');
  const prov = state.mode === 'LIVE'
    ? `Structure: 1h REST-CACHED · Trigger: 5m LIVE-VENUE (IEX)${L().reseeded ? ' · VWAP re-seeded from backfill' : ''}`
    : 'Structure: 1h REST-CACHED · Trigger: 5m LIVE-VENUE (demo)';
  $('#drillbody').innerHTML = `<div class="crit"><div><b>${n.ticker}</b></div><div>${n.sector} · ${n.bias}-bias · β ${n.beta_60d}</div>
    <div><span class="state ${r.state}">${r.state}</span></div>${rows}</div>
    <div class="prov">${prov}</div>`;
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
    <div class="prov">journal empty — record fills to activate KPIs & kill-criteria panel</div>`;
}
boot();
