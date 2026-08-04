# Live Wiring (FR-A15–A18 + FR-A1/A2/A5/A7/A8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Start live" boots the real data plane — Alpaca stream → per-symbol aggregators → engine evaluation → overview/drill-down, with regime banner, earnings blackout badges + pause default, stream status with tick age, budget meter, backfill on reconnect, and provenance labels.

**Architecture:** A new testable orchestrator `src/core/live.js` owns all live state and provider calls behind injected deps (adapters + queue + clock); `main.js` stays DOM glue that renders from either demo data or the live state. Engine path unchanged (NFR-5): live mode assembles the same `ctx` shape `evaluate()` already consumes.

**Tech Stack:** unchanged (ES modules, node:test, Vite).

## Global Constraints

- One engine code path (NFR-5) — live mode calls the same `evaluate(cfg, ctx)`; no forked logic.
- Every provider failure stores the provider's actual error message in `state.errors.*` and the UI shows it (FRD §7 global constraint).
- Twelve Data calls ONLY through the FR-A5 queue (8 credits/min, TTL cache); FMP/Finnhub calls are direct (own budgets: 250/day, 60/min).
- Baseline config only in Module A (FRD §4.7): `BASELINE` is the evaluation config, always.
- Tests: `node --test test/core.test.js test/engine/engine.test.js test/engine/indicators.test.js test/adapters.test.js test/live.test.js` — explicit paths.
- Initial fill budget (C3/C9, document in UI, not a bug): regime <3 s (2 FMP calls + 1 TD call); quote chunks ~3 TD calls; per-name structure (1h, TTL 1h) + relvol baseline (5m×21 sessions, TTL 24h) + daily levels (11 daily bars, TTL 24h) = 3 TD calls/name → full ARMED/IDLE states fill progressively over ~8 min at 8 credits/min. Live prices tick from the stream within seconds regardless.

---

### Task 1: Branch

- [x] `git checkout -b live-wiring` (from main, clean tree)

### Task 2: Blackout + slot helpers in `src/core/live.js`

**Files:**
- Create: `src/core/live.js` (helpers first; orchestrator added in Task 3)
- Create: `test/live.test.js`

**Interfaces:**
- Produces: `inBlackout(earnDate: 'YYYY-MM-DD'|null, now: Date, cfg) → boolean` (T−1 through T+1, calendar days vs `cfg.blackoutDays`; `null` → `true`, FRD 4.6 fail-safe).
- Produces: `slotIndexNY(tMs: number) → number|null` — 0-based 5-minute slot within the 09:30–16:00 ET cash session (0..77), null outside; DST-safe via `Intl` with `America/New_York`.
- Produces: `slotBaselineFrom(bars5m, todayKeyNY?) → number[78]` — per-slot average volume across prior sessions (bars from the current NY day excluded).

- [x] **Step 1: failing tests** — create `test/live.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inBlackout, slotIndexNY, slotBaselineFrom } from '../src/core/live.js';
import { BASELINE } from '../src/core/config.js';

test('blackout: T-1 through T+1 inclusive, unknown fails safe', () => {
  const cfg = BASELINE;
  assert.equal(inBlackout('2026-08-05', new Date('2026-08-04T18:00:00Z'), cfg), true);   // T-1
  assert.equal(inBlackout('2026-08-05', new Date('2026-08-06T18:00:00Z'), cfg), true);   // T+1
  assert.equal(inBlackout('2026-08-05', new Date('2026-08-07T18:00:00Z'), cfg), false);  // T+2
  assert.equal(inBlackout('2026-08-05', new Date('2026-08-02T18:00:00Z'), cfg), false);  // T-3
  assert.equal(inBlackout(null, new Date('2026-08-04T18:00:00Z'), cfg), true);           // unknown → badge
});

test('slotIndexNY: session boundaries in EDT', () => {
  assert.equal(slotIndexNY(Date.parse('2026-08-04T13:30:00Z')), 0);    // 09:30 ET
  assert.equal(slotIndexNY(Date.parse('2026-08-04T13:34:59Z')), 0);
  assert.equal(slotIndexNY(Date.parse('2026-08-04T19:55:00Z')), 77);   // 15:55 ET
  assert.equal(slotIndexNY(Date.parse('2026-08-04T20:00:00Z')), null); // 16:00 ET = closed
  assert.equal(slotIndexNY(Date.parse('2026-08-04T13:00:00Z')), null); // pre-market
});

test('slotBaselineFrom: averages same slot across sessions, excludes today', () => {
  const mk = (iso, v) => ({ t: Date.parse(iso), o: 1, h: 1, l: 1, c: 1, v });
  const bars = [
    mk('2026-08-01T13:30:00Z', 100), mk('2026-08-02T13:30:00Z', 300),  // slot 0, two prior days
    mk('2026-08-02T13:35:00Z', 50),                                     // slot 1, one prior day
    mk('2026-08-04T13:30:00Z', 999),                                    // today → excluded
  ];
  const base = slotBaselineFrom(bars, '2026-08-04');
  assert.equal(base[0], 200);
  assert.equal(base[1], 50);
  assert.equal(base[2], 0);
});
```

- [x] **Step 2:** Run `node --test test/live.test.js` → FAIL (module missing).
- [x] **Step 3: implement** — create `src/core/live.js` (helpers only for now):

```js
// Live-mode orchestration (FR-A15–A18): all provider calls + live state behind injected deps.
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
```

- [x] **Step 4:** `node --test test/live.test.js` → 3 pass.
- [x] **Step 5:** Commit: `git add src/core/live.js test/live.test.js && git commit -m "Live helpers: blackout window (FR-A8), NY slot index + relvol baseline (E2)"`

### Task 3: `startLive` orchestrator

**Files:**
- Modify: `src/core/live.js` (append)
- Modify: `test/live.test.js` (append)

**Interfaces:**
- Produces: `startLive({ keys, watchlist, cfg }, deps, onUpdate) → { state, stop() }`.
  - `keys`: `{ alpacaId, alpacaSecret, td, fmp, fh }` (strings; or/nd handled by existing context adapter later).
  - `deps`: `{ openStream, regimeQuotes, tdQuotes, tdBars, earningsMap, queue, now? }` — exact adapter signatures from the pivot phase; `tdBars(symbol, interval, outputsize, key)`; `queue` from `makeQueue`.
  - `state` (mutated in place, re-rendered via `onUpdate(tag)` calls): `{ stream: {status}, lastTickAge(), live: {[t]: {p, t}}, spyLive, quotes: {[t]: {...}|null}, spy: {price, changePct, ma20}, vix, earnings: {[t]: date|null}|null, structure: {[t]: bars1h}, daily: {[t]: barsDaily}, baselines: {[t]: number[78]}, states: {[t]: {state, criteria}}, paused: {[t]: bool}, overrides: {[t]: bool}, reseeded: bool, errors: {}, budget() }`.
  - Evaluation: for each name with structure+daily+baseline+live data present, assembles the same ctx as demo mode (real daily bars for E4 instead of the demo's hour-bar approximation) and stores `evaluate(cfg, ctx)`.
  - `setPause(ticker, paused, isOverride)` mutates `paused/overrides` and re-evaluates (FR-A9 persistence is main.js's job via sessionStorage).

- [x] **Step 1: failing tests** — append to `test/live.test.js`:

```js
import { startLive } from '../src/core/live.js';
import { makeQueue } from '../src/core/queue.js';

const WL = { names: [
  { ticker: 'AA', bias: 'long', cluster: 'C1', beta_60d: 2, atr_pct_14d: 5 },
  { ticker: 'BB', bias: 'short', cluster: 'C2', beta_60d: 3, atr_pct_14d: 6 },
] };
const KEYS = { alpacaId: 'k', alpacaSecret: 's', td: 't', fmp: 'f', fh: 'h' };
const instantQueue = () => makeQueue({ perMinute: 100000, now: () => Date.now() });

function fakeDeps(over = {}) {
  const calls = { stream: null, tdQuotes: [], tdBars: [], earnings: 0 };
  const deps = {
    openStream: (tickers, key, onTrade, onStatus) => {
      calls.stream = { tickers, key, onTrade, onStatus };
      return { close() {}, lastTickAge: () => 1000 };
    },
    regimeQuotes: async () => ({ spy: { price: 700, changePct: 1, ma50: 650, ma200: 600 }, vix: 18 }),
    tdQuotes: async symbols => { calls.tdQuotes.push(symbols);
      return Object.fromEntries(symbols.map(s => [s, { price: 10, changePct: 1, volume: 5, avgVolume: 4 }])); },
    tdBars: async (sym, interval) => { calls.tdBars.push([sym, interval]);
      if (interval === '1day') return Array.from({ length: 21 }, (_, i) => ({ t: i * 86400000, o: 9, h: 12, l: 8, c: 10 + (i % 3), v: 100 }));
      if (interval === '1h') return Array.from({ length: 40 }, (_, i) => ({ t: i * 3600000, o: 9, h: 11, l: 9, c: 10, v: 100 }));
      return Array.from({ length: 156 }, (_, i) => ({ t: Date.parse('2026-08-03T13:30:00Z') + i * 300000, o: 9, h: 11, l: 9, c: 10, v: 100 }));
    },
    earningsMap: async () => { calls.earnings += 1; return { AA: '2026-09-01', BB: null }; },
    queue: instantQueue(), ...over,
  };
  return { deps, calls };
}
const settle = () => new Promise(r => setTimeout(r, 50));

test('startLive: subscribes watchlist+SPY, routes trades to live prices and aggregators', async () => {
  const { deps, calls } = fakeDeps();
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: (await import('../src/core/config.js')).BASELINE }, deps);
  assert.deepEqual(calls.stream.tickers, ['AA', 'BB', 'SPY']);
  assert.deepEqual(calls.stream.key, { keyId: 'k', secret: 's' });
  calls.stream.onTrade({ sym: 'AA', p: 11.5, v: 10, t: Date.parse('2026-08-04T14:00:01Z') });
  calls.stream.onTrade({ sym: 'SPY', p: 701, v: 1, t: Date.parse('2026-08-04T14:00:02Z') });
  assert.equal(state.live.AA.p, 11.5);
  assert.equal(state.spyLive, 701);
  assert.equal(state.bars5m('AA').length, 1);
  await settle();
});

test('startLive: chunks TD quotes ≤8 symbols per call and fills regime + earnings', async () => {
  const wl20 = { names: Array.from({ length: 20 }, (_, i) => ({ ticker: 'T' + i, bias: 'long', cluster: 'C1', beta_60d: 1, atr_pct_14d: 5 })) };
  const { deps, calls } = fakeDeps();
  const { state } = startLive({ keys: KEYS, watchlist: wl20, cfg: (await import('../src/core/config.js')).BASELINE }, deps);
  await settle();
  assert.ok(calls.tdQuotes.length >= 3);
  assert.ok(calls.tdQuotes.every(chunk => chunk.length <= 8));
  assert.equal(state.quotes.T0.price, 10);
  assert.equal(state.spy.price, 700);
  assert.equal(state.vix, 18);
  assert.ok(state.spy.ma20 > 0);
});

test('startLive: provider failure stores actual error, rest continues', async () => {
  const { deps } = fakeDeps({ regimeQuotes: async () => { throw new Error('FMP quote SPY 402: Restricted'); } });
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: (await import('../src/core/config.js')).BASELINE }, deps);
  await settle();
  assert.match(state.errors.regime, /402.*Restricted/);
  assert.equal(state.quotes.AA.price, 10);          // quotes unaffected
  assert.deepEqual(state.earnings, { AA: '2026-09-01', BB: null });
});

test('startLive: evaluates states once structure+daily+baseline+live present', async () => {
  const { deps, calls } = fakeDeps();
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: (await import('../src/core/config.js')).BASELINE }, deps);
  await settle();
  calls.stream.onTrade({ sym: 'AA', p: 11.5, v: 10, t: Date.parse('2026-08-04T14:00:01Z') });
  calls.stream.onTrade({ sym: 'AA', p: 11.6, v: 10, t: Date.parse('2026-08-04T14:06:01Z') });
  state.reeval();
  assert.ok(state.states.AA, 'AA evaluated');
  assert.ok(['IDLE', 'ARMED', 'LONG'].includes(state.states.AA.state));
  assert.ok(state.states.AA.criteria.length >= 9);
});

test('startLive: reconnect triggers 5m backfill + VWAP reseed flag (FR-A17)', async () => {
  const { deps, calls } = fakeDeps();
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: (await import('../src/core/config.js')).BASELINE }, deps);
  await settle();
  const before = calls.tdBars.filter(c => c[1] === '5min').length;
  calls.stream.onStatus('DEGRADED');
  calls.stream.onStatus('CONNECTED');
  await settle();
  assert.ok(calls.tdBars.filter(c => c[1] === '5min').length > before, 'backfill fetched 5m bars');
  assert.equal(state.reseeded, true);
});
```

- [x] **Step 2:** Run → FAIL (`startLive` not exported).
- [x] **Step 3: implement** — append to `src/core/live.js`:

```js
// ---- Orchestrator (FR-A15–A18). All I/O via injected deps; UI renders from `state`. ----
export function startLive({ keys, watchlist, cfg }, deps, onUpdate = () => {}) {
  const { openStream, regimeQuotes, tdQuotes, tdBars, earningsMap, queue, now = () => new Date() } = deps;
  const tickers = watchlist.names.map(n => n.ticker);
  const byTicker = Object.fromEntries(watchlist.names.map(n => [n.ticker, n]));
  const aggs = Object.fromEntries([...tickers, 'SPY'].map(t => [t, makeAggregator()]));
  const backfilled = {};                       // {[t]: bars5m fetched on reconnect}

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

const nyDayOf = tMs => new Date(tMs).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10);
```

- [x] **Step 4:** `node --test test/live.test.js` → 8 pass. (If `nyDayOf` hoisting bites — it's a `const` arrow used inside `startLive` before definition at module bottom — move it up next to `nyParts`.)
- [x] **Step 5:** Commit: `git commit -m "Implement FR-A15/A17 live orchestrator: stream->aggregators->engine, chunked REST, backfill+reseed"`

### Task 4: `main.js` live mode + provenance UI

**Files:**
- Modify: `src/main.js`
- Modify: `index.html` (only if a hook id is missing)

Wiring (no unit tests — verified in browser; logic already tested in live.js):

- [x] **Step 1:** Imports + Start-live handler:

```js
import { startLive } from './core/live.js';
import { makeQueue } from './core/queue.js';
import { openStream } from './adapters/alpacaStream.js';
import { regimeQuotes } from './adapters/fmp.js';
import { quotes as tdQuotes, bars as tdBars } from './adapters/twelvedata.js';
import { nextEarningsMap } from './adapters/finnhub.js';

$('#go').onclick = () => {
  const keys = { alpacaId: $('#k_alp_id').value.trim(), alpacaSecret: $('#k_alp_sec').value.trim(),
    td: $('#k_td').value.trim(), fmp: $('#k_fmp').value.trim(), fh: $('#k_fh').value.trim(),
    or: $('#k_or').value.trim(), nd: $('#k_nd').value.trim() };
  if (!keys.alpacaId || !keys.alpacaSecret || !keys.td) {
    $('#mode').textContent = 'LIVE needs at least Alpaca key+secret and Twelve Data key.'; return; }
  const queue = makeQueue();
  const deps = { openStream, regimeQuotes, tdQuotes,
    tdBars: (sym, interval, outputsize, key) => tdBars(sym, interval, outputsize, keys.td),
    earningsMap: nextEarningsMap, queue };
  state.liveHandle = startLive({ keys, watchlist: state.wl, cfg: state.cfg }, deps, throttledRender);
  state.mode = 'LIVE';
  // FR-A9: pause decisions survive reloads within the session
  const saved = JSON.parse(sessionStorage.getItem('pause') ?? '{}');
  for (const [t, v] of Object.entries(saved)) state.liveHandle.state.setPause(t, v.paused, v.override);
  $('#mode').textContent = 'LIVE — baseline config, signals only, human executes.';
  renderAll();
};
let renderQueued = false;
function throttledRender() { if (renderQueued) return; renderQueued = true;
  setTimeout(() => { renderQueued = false; renderAll(); }, 400); }
```

- [x] **Step 2:** Make renderers mode-aware. Introduce `const L = () => state.liveHandle?.state;` and in each renderer branch on `state.mode === 'LIVE'`:
  - `renderHeader`: regime from `L().spyLive ?? L().spy.price` vs `L().spy.ma20` and `L().vix` (show `regime pending…` while ma20/vix null, plus `L().errors.regime` if set); stream pill `STREAM: ${L().stream.status} · ${Math.round(L().lastTickAge()/1000)}s` (age `—` when null); budget pill `API: ${used}/800`.
  - `renderAll` rows: live price `L().live[t]?.p` (class `up/dn` vs prior) falling back to `L().quotes[t]?.price` with a `stale` marker, `—` while neither; day% from `L().quotes[t]`; trend chip from screen bias: `n.bias === 'long' ? '↑50DMA*' : '↓50DMA*'` (`*` = at screen date, provenance EOD); earnings column: date from `L().earnings?.[t]` + blackout badge + `PAUSED` chip when `L().paused[t]`, click chip → `setPause(t, !paused, true)` + persist to sessionStorage + `confirm()` when unpausing inside a blackout ("TICKER reports DATE — trade through the event?", FR-A8 override is explicit); state cell from `L().states[t]?.state ?? '…'`.
  - `renderDrill`: use `L().states[t].criteria` (same shape as demo); provenance line `Structure: 1h REST-CACHED · Trigger: 5m LIVE-VENUE (IEX)` + ` · VWAP re-seeded` when `L().reseeded`.
  - Overview provenance footer: `Prices: LIVE-VENUE (Alpaca IEX), REST fallback · Reference: FMP DELAYED + Finnhub EOD + screen 2026-08-04` (FR-A18).
  - Keep a 2 s `setInterval` re-render in LIVE mode for tick ages (reuse the existing header interval — call `renderAll` only on data events, header every 2 s).
- [x] **Step 3:** `npm run build` green; browser: demo boot unchanged (no keys), then with keys (if user present / market open): header goes CONNECTED, quotes fill progressively, budget meter climbs, SNDK/WDC show PAUSED blackout chips.
- [x] **Step 4:** Commit: `git commit -m "Wire FR-A1/A2/A8/A9/A16-prep live UI: mode-aware renderers, pause chips, provenance labels (FR-A18)"`

### Task 5: Docs + verify + merge

- [x] **Step 1:** HANDOVER §5: live wiring done, what's verified headless vs. what needs a market-hours click-through; README status checkboxes.
- [x] **Step 2:** Full suite (all five test files) + `npm run build` + browser demo screenshot.
- [x] **Step 3:** Merge `live-wiring` → main (no-ff), push (auto-deploys), verify Pages run green.

## Self-review notes
- NFR-5 held: live mode calls `evaluate()` with the same ctx shape; no engine changes anywhere in this plan.
- FR-A16 (position monitor) intentionally NOT here — next phase, needs journal UI; `bars5m()`/`vwap()`/`live` on the state object are its designed inputs.
- FR-A4's "structure computed from Twelve Data 1h bars" — satisfied via `state.structure` fetched through the queue with 1h TTL.
- E7/blackout: unknown-earnings fail-safe produces badge+pause, matching FRD 4.6; override path is explicit and logged (sessionStorage).
- Type check: `tdBars` dep signature `(sym, interval, outputsize, key)` matches `twelvedata.bars(symbol, interval, outputsize, apiKey)`; `earningsMap(tickers, key)` matches `nextEarningsMap`; stream key `{keyId, secret}` matches `alpacaStream.openStream`.
