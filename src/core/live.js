// Live-mode orchestration (FR-A15–A18): all provider calls + live state behind injected deps,
// so the whole data plane is testable with fakes. main.js is DOM glue over `state`.
import { makeAggregator } from './aggregator.js';
import { evaluate } from '../engine/signal.js';
import { sessionState, minutesToHardClose } from './session.js';

const DAY = 86400000;

// FRD 4.6: blackout from T-1 close through T+1 close (calendar-day approximation);
// unknown earnings date fails safe → treated as in blackout so the name gets badged.
export function inBlackout(earnDate, now, cfg) {
  if (!earnDate) return true;
  const d = Date.parse(earnDate + 'T00:00:00Z');
  const start = d - cfg.blackoutDays.before * DAY;
  const end = d + (cfg.blackoutDays.after + 1) * DAY;
  return now.getTime() >= start && now.getTime() < end;
}

const nyParts = tMs => {
  const s = new Date(tMs).toLocaleString('sv-SE', { timeZone: 'America/New_York' });
  return { day: s.slice(0, 10), mins: +s.slice(11, 13) * 60 + +s.slice(14, 16) };
};
const nyDayOf = tMs => nyParts(tMs).day;

// 0-based 5-minute slot inside the 09:30–16:00 ET cash session; null outside (E2 slot basis).
export function slotIndexNY(tMs) {
  const { mins } = nyParts(tMs);
  const rel = mins - (9 * 60 + 30);
  return rel >= 0 && rel < 390 ? Math.floor(rel / 5) : null;
}

// Per-slot average volume across prior sessions (today excluded) — the E2 baseline (FR-A5 24h TTL).
export function slotBaselineFrom(bars5m, todayKeyNY) {
  const sum = new Array(78).fill(0), cnt = new Array(78).fill(0);
  for (const b of bars5m) {
    const { day } = nyParts(b.t);
    if (day === todayKeyNY) continue;
    const s = slotIndexNY(b.t);
    if (s !== null) { sum[s] += b.v; cnt[s] += 1; }
  }
  return sum.map((v, i) => cnt[i] ? v / cnt[i] : 0);
}

// ---- Orchestrator (FR-A15–A18). All I/O via injected deps; UI renders from `state`. ----
export function startLive({ keys, watchlist, cfg }, deps, onUpdate = () => {}) {
  const { openStream, regimeQuotes, tdQuotes, tdBars, earningsMap, queue, now = () => new Date() } = deps;
  const tickers = watchlist.names.map(n => n.ticker);
  const byTicker = Object.fromEntries(watchlist.names.map(n => [n.ticker, n]));
  const aggs = Object.fromEntries([...tickers, 'SPY'].map(t => [t, makeAggregator()]));
  const backfilled = {};                       // {[t]: today's bars5m fetched on reconnect}

  const state = {
    stream: { status: 'CONNECTING' }, lastTickAge: () => stream.lastTickAge(),
    live: {}, spyLive: null,
    quotes: {}, spy: { price: null, changePct: null, ma20: null }, vix: null,
    earnings: null, structure: {}, daily: {}, baselines: {}, states: {},
    paused: {}, overrides: {}, reseeded: false, errors: {},
    budget: () => queue.budget(),
    bars5m: t => [...(backfilled[t] ?? []), ...aggs[t].bars5m()],
    vwap: t => aggs[t].vwap(),
    reeval, setPause,
  };
  const emit = tag => onUpdate(tag, state);

  function assembleCtx(t) {
    const n = byTicker[t], hb = state.structure[t], db = state.daily[t], base = state.baselines[t];
    const live = state.live[t]?.p ?? state.quotes[t]?.price;
    const fm = state.bars5m(t);
    if (!hb || !db || !base || !live || fm.length < 2) return null;
    const lastT = state.live[t]?.t ?? now().getTime();
    const dailyBars = db.map(b => ({ h: b.h, l: b.l, c: b.c }));
    return { dir: n.bias === 'long' ? 'long' : 'short', hourBars: hb, fiveMinBars: fm,
      slotBaseline: base, slotIndex: slotIndexNY(lastT) ?? 77,
      livePrice: live, prevDay: dailyBars.at(-2) ?? dailyBars.at(-1), dailyBars,
      spyAboveMA: (state.spyLive ?? state.spy.price) > state.spy.ma20, vix: state.vix,
      minutesToTimeStop: Math.min(cfg.timeStopHours * 60, Math.max(0, minutesToHardClose(now(), cfg))),
      inEntryWindow: sessionState(now(), cfg) === 'ENTRY_OPEN',
      inBlackout: state.earnings ? inBlackout(state.earnings[t], now(), cfg) : false,
      blackoutOverride: state.overrides[t] === true };
  }
  function reeval() {
    if (!(state.spy.ma20 > 0) || state.vix == null) return;
    for (const t of tickers) {
      if (state.paused[t]) { state.states[t] = { state: 'PAUSED', criteria: state.states[t]?.criteria ?? [] }; continue; }
      const ctx = assembleCtx(t);
      if (ctx) state.states[t] = evaluate(cfg, ctx);
    }
  }
  function setPause(t, paused, isOverride = false) {
    state.paused[t] = paused; state.overrides[t] = isOverride; reeval(); emit('pause');
  }

  // Layer 1 stream (FR-A15)
  let lastStatus = null;
  const stream = openStream([...tickers, 'SPY'], { keyId: keys.alpacaId, secret: keys.alpacaSecret },
    tr => { aggs[tr.sym]?.addTrade({ p: tr.p, v: tr.v, t: tr.t });
      if (tr.sym === 'SPY') state.spyLive = tr.p; else state.live[tr.sym] = { p: tr.p, t: tr.t }; },
    status => { const was = lastStatus; lastStatus = status; state.stream.status = status;
      if (was === 'DEGRADED' && status === 'CONNECTED') backfill();
      emit('stream'); });

  async function backfill() {                  // FR-A17: gap fill + VWAP reseed after reconnect
    for (const t of tickers) {
      try {
        const { value: bars } = await queue.schedule(`bf:${t}:${now().toISOString().slice(0, 13)}`, 0,
          () => tdBars(t, '5min', 78, keys.td));
        const today = nyDayOf(now().getTime());
        backfilled[t] = bars.filter(b => nyDayOf(b.t) === today);
        let pv = 0, vv = 0;
        for (const b of backfilled[t]) { pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; }
        aggs[t].seed(pv, vv);
      } catch (e) { state.errors['backfill:' + t] = String(e.message ?? e); }
    }
    state.reseeded = true; reeval(); emit('backfill');
  }

  // Layer 3 regime (FR-A1/A2) — FMP direct, SPY 20-DMA via one TD daily call
  (async () => {
    try { const rq = await regimeQuotes(keys.fmp);
      state.spy.price = rq.spy.price; state.spy.changePct = rq.spy.changePct; state.vix = rq.vix; }
    catch (e) { state.errors.regime = String(e.message ?? e); }
    try { const { value: d } = await queue.schedule('spy1d', 3600e3, () => tdBars('SPY', '1day', 21, keys.td));
      state.spy.ma20 = d.slice(-20).reduce((s, b) => s + b.c, 0) / 20; }
    catch (e) { state.errors.spyMa = String(e.message ?? e); }
    reeval(); emit('regime');
  })();

  // Overview quotes via TD in ≤8-symbol chunks (FR-A1, C9)
  (async () => {
    for (let i = 0; i < tickers.length; i += 8) {
      const chunk = tickers.slice(i, i + 8);
      try { const { value } = await queue.schedule('q:' + chunk.join(','), 300e3, () => tdQuotes(chunk, keys.td));
        Object.assign(state.quotes, value); }
      catch (e) { state.errors.quotes = String(e.message ?? e); }
      emit('quotes');
    }
  })();

  // Earnings blackout data (FR-A7/A8) — Finnhub direct
  (async () => {
    try { state.earnings = await earningsMap(tickers, keys.fh);
      for (const t of tickers) if (inBlackout(state.earnings[t], now(), cfg) && state.paused[t] === undefined)
        state.paused[t] = true;                // FR-A8: pause is the default; operator may override in UI
    } catch (e) { state.errors.earnings = String(e.message ?? e); }
    reeval(); emit('earnings');
  })();

  // Per-name structure / daily levels / relvol baseline (FR-A4, E1–E5, E2 baseline)
  (async () => {
    for (const t of tickers) {
      try {
        const { value: hb } = await queue.schedule('1h:' + t, 3600e3, () => tdBars(t, '1h', 40, keys.td));
        state.structure[t] = hb;
        const { value: db } = await queue.schedule('1d:' + t, 86400e3, () => tdBars(t, '1day', 11, keys.td));
        state.daily[t] = db;
        const { value: fm } = await queue.schedule('bl:' + t, 86400e3, () => tdBars(t, '5min', 78 * 21, keys.td));
        state.baselines[t] = slotBaselineFrom(fm, nyDayOf(now().getTime()));
      } catch (e) { state.errors['structure:' + t] = String(e.message ?? e); }
      reeval(); emit('structure');
    }
  })();

  return { state, stop: () => stream.close() };
}
