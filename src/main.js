import { BASELINE, presetHash } from './core/config.js';
import { sessionState, minutesToHardClose } from './core/session.js';
import { evaluate } from './engine/signal.js';
import { allocate, baseSize } from './engine/sizing.js';
import { runway } from './engine/levels.js';
import { demoData } from './adapters/demo.js';

const $ = s => document.querySelector(s);
const state = { mode: 'DEMO', wl: null, data: null, cfg: BASELINE };

async function boot() {
  state.wl = await (await fetch('./watchlist.json')).json();
  $('#screendate').textContent = `screened ${state.wl.screening_date} · baseline ${presetHash(BASELINE)}`;
  state.data = demoData(state.wl);
  $('#mode').textContent = 'DEMO MODE — canned data; enter keys to go live.';
  renderAll();
  setInterval(renderHeader, 5000);
}

function ctxFor(n) {
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
  const d = state.data;
  const longsOK = d.spy.price > d.spy.ma20, vixOK = d.vix < state.cfg.vixCap;
  const reg = !vixOK ? ['STAND DOWN · VIX ' + d.vix, 'bad'] :
    longsOK ? [`LONGS OK · SPY>${state.cfg.spyMaDays}DMA · VIX ${d.vix}`, 'ok'] : [`SHORTS OK · VIX ${d.vix}`, 'warn'];
  $('#regime').textContent = reg[0]; $('#regime').className = 'pill ' + reg[1];
  const ss = sessionState(new Date(), state.cfg);
  $('#session').textContent = ss.replace('_', ' ');
  $('#session').className = 'pill ' + (ss === 'ENTRY_OPEN' ? 'ok' : ss === 'ENTRIES_CLOSED' ? 'warn' : 'dim');
  $('#stream').textContent = state.mode === 'DEMO' ? 'STREAM: demo' : 'STREAM: connected';
  $('#budget').textContent = 'API: demo·0/800';
}

function runwayStrip(n, live) {
  const dir = n.bias === 'long' ? 'long' : 'short';
  const hb = state.data.hourBars[n.ticker];
  const daily = hb.slice(-10).map(b => ({ h: b.h, l: b.l, c: b.c }));
  const rw = runway(live, dir, daily.at(-2) ?? daily.at(-1), daily);
  const span = live * 0.08;
  const pos = v => Math.max(0, Math.min(100, ((v - (live - span/2)) / span) * 100));
  const lvl = rw.level ? `<i class="lvl" style="left:${pos(rw.level)}%"></i>` : '';
  const zoneEnd = dir === 'long' ? pos(live * 1.03) : pos(live * 0.97);
  const zone = `left:${Math.min(pos(live), zoneEnd)}%;width:${Math.abs(zoneEnd - pos(live))}%`;
  const label = rw.runwayPct === Infinity ? 'open' : rw.runwayPct.toFixed(1) + '%';
  return `<div class="rw" title="runway ${label} to ${rw.name}"><i class="zone" style="${zone}"></i>${lvl}<i class="px" style="left:${pos(live)}%"></i></div>`;
}

function renderAll() {
  renderHeader();
  const tb = $('#overview tbody'); tb.innerHTML = '';
  for (const n of state.wl.names) {
    const q = state.data.quotes[n.ticker];
    const r = evaluate(state.cfg, ctxFor(n));
    const trend = q.ma50 > q.ma200 ? '<span class="up">50>200</span>' : '<span class="dn">50<200</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${n.ticker}</td><td class="num">${q.live.toFixed(2)}</td>
      <td class="num ${q.changePct >= 0 ? 'up' : 'dn'}">${q.changePct.toFixed(1)}%</td><td>${trend}</td>
      <td>${runwayStrip(n, q.live)}</td><td class="num">${n.beta_60d.toFixed(1)}</td><td>${n.cluster}</td>
      <td>${n.beta_60d > 5 ? '<span class="badge">β-cap</span>' : '—'}</td>
      <td><span class="state ${r.state}">${r.state}</span></td>`;
    tr.onclick = () => renderDrill(n, r);
    tb.appendChild(tr);
  }
  renderRisk();
}

function renderDrill(n, r) {
  const rows = r.criteria.map(c => {
    const mark = c.enabled === false ? '<span class="off">off</span>' : c.pass ? '<span class="ok">✓</span>' : '<span class="no">✗</span>';
    const val = typeof c.value === 'number' ? c.value.toFixed(2) : String(c.value);
    return `<div>${c.id}</div><div>${c.detail}</div><div>${mark} ${val}</div>`;
  }).join('');
  $('#drillbody').innerHTML = `<div class="crit"><div><b>${n.ticker}</b></div><div>${n.sector} · ${n.bias}-bias · β ${n.beta_60d}</div>
    <div><span class="state ${r.state}">${r.state}</span></div>${rows}</div>
    <div class="prov">Structure: 1h REST-CACHED · Trigger: 5m LIVE-VENUE (demo)</div>`;
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
