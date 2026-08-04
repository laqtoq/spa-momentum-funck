# Data-Provider Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire the data layer after the 2026-08-04 spike revealed free-tier symbol restrictions on Finnhub WS and FMP: Alpaca IEX WS becomes Layer 1, Finnhub REST carries earnings, FMP shrinks to regime-only, Twelve Data absorbs overview quotes — with spike v2 verifying all of it and FRD v1.6 recording it.

**Architecture:** Same three-layer shape as FRD §6.1; only providers move. All adapters keep the established interface conventions (injectable `fetch`/`WebSocket` for tests, `{sym,p,v,t}` trade shape, thrown Errors carrying provider status text per the "actual error" global constraint).

**Tech Stack:** Vanilla ES modules, `node:test` + `assert`, Vite (static, `public/` passthrough).

## Global Constraints

- Static hosting only; no backend (NFR-1). Keys at runtime via form fields, never committed (FRD §6.2).
- Every external call degrades with the provider's actual error message (FRD §7 global constraints).
- Adapters are swappable pure interfaces (NFR-4); one engine code path (NFR-5).
- Tests run as `node --test test/core.test.js test/engine/engine.test.js test/engine/indicators.test.js test/adapters.test.js` — never a bare directory (HANDOVER §10).
- Spec-code truth: FRD edited in the same phase as the code change, with change-log entry (HANDOVER §8.2). Commits reference FR IDs.
- Evidence for this pivot (probe transcripts, 2026-08-04): Finnhub WS free streams only a popular-symbol subset (AAPL/TSLA yes; SPY/MU/DELL no, no error frames). FMP `stable/*` free tier is symbol-restricted (AAPL/SPY/^VIX yes; DELL/MU 402) and batch/legacy endpoints are gone for post-Aug-2025 keys. Finnhub REST `/calendar/earnings` works from the browser (CORS OK, broad coverage). Twelve Data serves watchlist names fully (1h/5m/60d/quote). Alpaca `wss://stream.data.alpaca.markets/v2/iex` reachable from browser, auth pending user keys.

---

### Task 0: Local git baseline

**Files:** none created (repo metadata only)

- [x] **Step 1: Initialize the repo and commit the current verified state**

```bash
cd "/Users/sven/Documents/Claude-Projekte/WU SPA Havard/dashboard_scaffold"
git init
git add -A
git commit -m "Baseline: engine+core+adapters+demo scaffold, 25 tests green, pre-pivot

State as verified 2026-08-04: FRD v1.5, spike v1 run results in HANDOVER.
GitHub remote + Pages deferred pending user go-ahead."
```

- [x] **Step 2: Verify**

Run: `git log --oneline` → exactly one commit; `git status` → clean.

### Task 1: Spike v2 (`public/spike.html` rewrite)

**Files:**
- Modify: `public/spike.html` (full replacement)

**Interfaces:** none consumed by code; produces the go/no-go evidence for Tasks 2–5 assumptions (Alpaca auth+stream with the user's keys).

Fixes over v1: every code path logs a verdict (v1 was silent for 1–4 trades); all REST responses read as text first, JSON-parsed defensively (v1 crashed on FMP's plain-text 402); checks target watchlist names, not AAPL. New checks: Alpaca WS auth+stream (the new Layer 1), Finnhub REST calendar coverage, FMP regime-residual including the *expected* DELL restriction, informational Finnhub WS symbol-restriction documenter.

- [x] **Step 1: Replace `public/spike.html`** with:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Data Spike v2 — post-pivot free-tier verification</title>
<style>
body{font:14px/1.5 ui-monospace,Menlo,monospace;background:#14171C;color:#E8EAED;max-width:760px;margin:30px auto;padding:0 16px}
input{background:#1B2027;border:1px solid #262D36;color:#E8EAED;padding:7px;border-radius:4px;width:100%;margin:4px 0}
button{background:#3FB68B;border:none;color:#0c211a;font-weight:700;padding:9px 16px;border-radius:4px;cursor:pointer;margin-top:8px}
.pass{color:#3FB68B}.fail{color:#D08048}.warn{color:#C9A961}.info{color:#8b98a9}
#log div{border-bottom:1px solid #262D36;padding:6px 0}
</style></head>
<body>
<h2>Data spike v2 — post-pivot verification</h2>
<p>Verifies the FRD v1.6 provider set from <em>this</em> browser. Keys are used in-page only, never stored or sent anywhere except the providers themselves.</p>
<input id="apk" placeholder="Alpaca API key ID (paper ok)">
<input id="aps" placeholder="Alpaca API secret">
<input id="td" placeholder="Twelve Data key">
<input id="fmp" placeholder="FMP key">
<input id="fh" placeholder="Finnhub key (REST earnings; also runs WS-restriction documenter)">
<button onclick="run()">Run all checks</button>
<div id="log"></div>
<script>
const log = (msg, cls='') => { const d = document.createElement('div'); d.className = cls; d.textContent = msg; document.getElementById('log').appendChild(d); };
const jfetch = async url => {            // never throws on non-JSON: returns status + raw text + parsed-if-possible
  const r = await fetch(url); const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};

async function run() {
  document.getElementById('log').innerHTML = '';
  const apk = document.getElementById('apk').value.trim(), aps = document.getElementById('aps').value.trim();
  const td = document.getElementById('td').value.trim(), fmp = document.getElementById('fmp').value.trim();
  const fh = document.getElementById('fh').value.trim();
  const wl = await (await fetch('./watchlist.json')).json();
  const tickers = wl.names.map(n => n.ticker);

  // ---- CHECK 1: Alpaca IEX WS — the new Layer 1 (FR-A15, C1) ----
  if (apk && aps) {
    log('1) Alpaca WS: connecting…');
    await new Promise(done => {
      let auth = false, trades = 0, by = {};
      const ws = new WebSocket('wss://stream.data.alpaca.markets/v2/iex');
      const finish = verdict => { try { ws.close(); } catch {} done(); verdict(); };
      const timer = setTimeout(() => {
        if (!auth) finish(() => log('1) FAIL — no successful auth in 25s (keys? paper vs live endpoint?)', 'fail'));
        else if (trades === 0) finish(() => log('1) PASS(conditional) — authenticated + subscribed, 0 trades in 25s. Expected if market CLOSED; rerun 15:30–22:00 CET.', 'warn'));
        else finish(() => log(`1) PASS — authenticated, ${trades} trades in 25s: ${JSON.stringify(by)}. Layer 1 confirmed on watchlist names.`, 'pass'));
      }, 25000);
      ws.onopen = () => ws.send(JSON.stringify({ action: 'auth', key: apk, secret: aps }));
      ws.onmessage = ev => { for (const m of JSON.parse(ev.data)) {
        if (m.T === 'success' && m.msg === 'authenticated') { auth = true;
          log('   authenticated; subscribing DELL, MU, SPY, AAPL…');
          ws.send(JSON.stringify({ action: 'subscribe', trades: ['DELL','MU','SPY','AAPL'] })); }
        else if (m.T === 'error') { clearTimeout(timer);
          finish(() => log(`1) FAIL — Alpaca error ${m.code}: ${m.msg}`, 'fail')); }
        else if (m.T === 't') { trades++; by[m.S] = (by[m.S] || 0) + 1;
          if (trades >= 40) { clearTimeout(timer);
            finish(() => log(`1) PASS — authenticated, ${trades} trades (early exit): ${JSON.stringify(by)}. Layer 1 confirmed.`, 'pass')); } } } };
      ws.onerror = () => {};
      ws.onclose = () => {};
    });
  } else log('1) SKIPPED — no Alpaca key pair', 'warn');

  // ---- CHECK 2: Twelve Data on WATCHLIST names (Layer 2 + overview quotes) ----
  if (td) {
    const past = new Date(Date.now() - 60*24*3600*1000).toISOString().slice(0,10);
    const a = await jfetch(`https://api.twelvedata.com/time_series?symbol=DELL&interval=5min&start_date=${past}&end_date=${past} 23:59:00&outputsize=200&timezone=UTC&apikey=${td}`);
    if (a.json?.values?.length >= 70) log(`2a) PASS — ${a.json.values.length} 5m DELL bars for ${past} (60d back). Simulator depth OK on a watchlist name.`, 'pass');
    else log(`2a) FAIL — HTTP ${a.status}: ${a.text.slice(0,180)}`, 'fail');
    const q = await jfetch(`https://api.twelvedata.com/quote?symbol=DELL,MU,SPY&apikey=${td}`);
    if (q.json?.DELL?.close) log(`2b) PASS — /quote batch OK (DELL ${q.json.DELL.close}, SPY ${q.json.SPY?.close}). Overview quotes can move to Twelve Data (8 credits/min → chunked via queue).`, 'pass');
    else log(`2b) FAIL — HTTP ${q.status}: ${q.text.slice(0,180)}`, 'fail');
  } else log('2) SKIPPED — no Twelve Data key', 'warn');

  // ---- CHECK 3: FMP regime residual — SPY + ^VIX must work; DELL expected 402 (C9) ----
  if (fmp) {
    const spy = await jfetch(`https://financialmodelingprep.com/stable/quote?symbol=SPY&apikey=${fmp}`);
    const vix = await jfetch(`https://financialmodelingprep.com/stable/quote?symbol=^VIX&apikey=${fmp}`);
    if (spy.json?.[0]?.price && vix.json?.[0]?.price)
      log(`3a) PASS — regime inputs OK (SPY ${spy.json[0].price}, ^VIX ${vix.json[0].price}).`, 'pass');
    else log(`3a) FAIL — SPY ${spy.status}: ${spy.text.slice(0,90)} | ^VIX ${vix.status}: ${vix.text.slice(0,90)}`, 'fail');
    const dell = await jfetch(`https://financialmodelingprep.com/stable/quote?symbol=DELL&apikey=${fmp}`);
    if (dell.status === 402) log('3b) EXPECTED-RESTRICTED — DELL 402 on FMP free tier (compromise C9 documented; watchlist quotes come from Twelve Data).', 'info');
    else if (dell.json?.[0]?.price) log(`3b) SURPRISE — DELL now served (${dell.json[0].price}); C9 may be liftable, note in FRD.`, 'warn');
    else log(`3b) INFO — DELL ${dell.status}: ${dell.text.slice(0,120)}`, 'info');
  } else log('3) SKIPPED — no FMP key', 'warn');

  // ---- CHECK 4: Finnhub REST earnings calendar coverage (FR-A7) ----
  if (fh) {
    const from = new Date().toISOString().slice(0,10);
    const to = new Date(Date.now() + 120*24*3600*1000).toISOString().slice(0,10);
    const c = await jfetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${fh}`);
    const rows = c.json?.earningsCalendar ?? [];
    const covered = [...new Set(rows.filter(r => tickers.includes(r.symbol)).map(r => r.symbol))];
    if (covered.length >= 10) log(`4) PASS — earnings calendar covers ${covered.length}/${tickers.length} watchlist names in next 120d (${covered.sort().join(', ')}). Uncovered names fail safe → badge (FRD 4.6).`, 'pass');
    else if (rows.length) log(`4) PARTIAL — calendar returned ${rows.length} rows but only ${covered.length}/${tickers.length} watchlist names: ${covered.sort().join(', ') || 'none'}`, 'warn');
    else log(`4) FAIL — HTTP ${c.status}: ${c.text.slice(0,180)}`, 'fail');
  } else log('4) SKIPPED — no Finnhub key', 'warn');

  // ---- CHECK 5 (informational): Finnhub WS symbol restriction — appendix evidence for the pivot ----
  if (fh) {
    log('5) Finnhub WS restriction documenter: 12s sample…', 'info');
    await new Promise(done => {
      let by = {}, opened = false;
      const ws = new WebSocket('wss://ws.finnhub.io?token=' + fh);
      const timer = setTimeout(() => { try { ws.close(); } catch {}
        log(`5) INFO — opened=${opened}; per-symbol trades in 12s: ${JSON.stringify(by)} (subscribed SPY, AAPL, DELL). Empty SPY/DELL vs active AAPL = free-tier symbol restriction → why Layer 1 moved to Alpaca.`, 'info');
        done(); }, 12000);
      ws.onopen = () => { opened = true;
        ['SPY','AAPL','DELL'].forEach(s => ws.send(JSON.stringify({ type: 'subscribe', symbol: s }))); };
      ws.onmessage = ev => { const m = JSON.parse(ev.data);
        if (m.type === 'trade') m.data.forEach(t => { by[t.s] = (by[t.s] || 0) + 1; }); };
      ws.onerror = () => {};
    });
  }
  log('Done. Screenshot this page for the submission appendix.');
}
</script>
</body>
</html>
```

- [x] **Step 2: Verify it serves and renders**

Dev server already running → load `http://localhost:5173/spike.html`, confirm five input fields and the button render, no console errors.

- [x] **Step 3: Commit**

```bash
git add public/spike.html
git commit -m "Spike v2: Alpaca WS + Finnhub calendar + regime-residual checks, verdict on every path

Fixes v1 silent-verdict bug (1-4 trades logged nothing) and non-JSON crash on
FMP 402 text responses. Targets watchlist names instead of AAPL. Evidence page
for the FRD v1.6 provider pivot."
```

- [ ] **Step 4: CHECKPOINT — user runs spike v2 with keys** (market hours 15:30–22:00 CET). Read results from the page; Task 2 proceeds regardless (adapter is testable offline), but PASS on check 1 is required before the live-wiring phase.

### Task 2: Alpaca stream adapter

**Files:**
- Create: `src/adapters/alpacaStream.js`
- Create: `test/adapters.test.js`

**Interfaces:**
- Produces: `openStream(tickers, {keyId, secret}, onTrade, onStatus, WS = WebSocket)` → `{ close(), lastTickAge() }`. Trade callback shape `{sym, p, v, t}` (t = ms epoch), status values `'CONNECTED' | 'DEGRADED' | 'DOWN'` — identical contract to `finnhubStream.openStream` so `main.js` can swap providers (NFR-4).

- [x] **Step 1: Write the failing tests** — create `test/adapters.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStream } from '../src/adapters/alpacaStream.js';

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.onclose?.({}); }
  open() { this.onopen?.(); }
  msg(arr) { this.onmessage?.({ data: JSON.stringify(arr) }); }
}

test('alpaca: auth handshake then subscribe, trades mapped to {sym,p,v,t}', () => {
  FakeWS.all = [];
  const trades = [], statuses = [];
  openStream(['DELL', 'SPY'], { keyId: 'K', secret: 'S' }, t => trades.push(t), s => statuses.push(s), FakeWS);
  const ws = FakeWS.all[0];
  assert.equal(ws.url, 'wss://stream.data.alpaca.markets/v2/iex');
  ws.open();
  assert.deepEqual(ws.sent[0], { action: 'auth', key: 'K', secret: 'S' });
  ws.msg([{ T: 'success', msg: 'authenticated' }]);
  assert.deepEqual(statuses, ['CONNECTED']);
  assert.deepEqual(ws.sent[1], { action: 'subscribe', trades: ['DELL', 'SPY'] });
  ws.msg([{ T: 't', S: 'DELL', p: 470.1, s: 100, t: '2026-08-04T19:00:00.500Z' }]);
  assert.deepEqual(trades, [{ sym: 'DELL', p: 470.1, v: 100, t: Date.parse('2026-08-04T19:00:00.500Z') }]);
});

test('alpaca: auth failure → DOWN, no reconnect', () => {
  FakeWS.all = [];
  const statuses = [];
  openStream(['DELL'], { keyId: 'bad', secret: 'bad' }, () => {}, s => statuses.push(s), FakeWS);
  const ws = FakeWS.all[0];
  ws.open();
  ws.msg([{ T: 'error', code: 402, msg: 'auth failed' }]);
  assert.deepEqual(statuses, ['DOWN']);
  assert.equal(FakeWS.all.length, 1);   // close() fired but no reconnect socket created
});

test('alpaca: unexpected close → DEGRADED and reconnect socket opened', async () => {
  FakeWS.all = [];
  const statuses = [];
  openStream(['DELL'], { keyId: 'K', secret: 'S' }, () => {}, s => statuses.push(s), FakeWS);
  const ws = FakeWS.all[0];
  ws.open();
  ws.msg([{ T: 'success', msg: 'authenticated' }]);
  ws.close();   // simulate drop
  assert.deepEqual(statuses, ['CONNECTED', 'DEGRADED']);
  await new Promise(r => setTimeout(r, 1100));   // first backoff is 1000ms
  assert.equal(FakeWS.all.length, 2);
});
```

- [x] **Step 2: Run to verify failure**

Run: `node --test test/adapters.test.js` — Expected: FAIL, cannot find module `alpacaStream.js`.

- [x] **Step 3: Implement** — create `src/adapters/alpacaStream.js`:

```js
// Alpaca IEX WebSocket — Layer 1 primary since FRD v1.6 (C1: still single-venue, now IEX).
// Replaces Finnhub WS, whose free tier stopped streaming most watchlist names (C9, spike 2026-08-04).
// Same contract as finnhubStream.openStream so providers stay swappable (NFR-4).
export function openStream(tickers, { keyId, secret }, onTrade, onStatus, WS = WebSocket) {
  let ws, closed = false, backoff = 1000, lastTick = 0;
  const connect = () => {
    ws = new WS('wss://stream.data.alpaca.markets/v2/iex');
    ws.onopen = () => ws.send(JSON.stringify({ action: 'auth', key: keyId, secret }));
    ws.onmessage = ev => {
      for (const m of JSON.parse(ev.data)) {
        if (m.T === 'success' && m.msg === 'authenticated') {
          backoff = 1000; onStatus('CONNECTED');
          ws.send(JSON.stringify({ action: 'subscribe', trades: tickers }));
        } else if (m.T === 'error') {          // auth/limit errors: stop, surface, no retry storm
          closed = true; onStatus('DOWN'); ws.close();
        } else if (m.T === 't') {
          lastTick = Date.now();
          onTrade({ sym: m.S, p: m.p, v: m.s, t: Date.parse(m.t) });
        }
      }
    };
    ws.onclose = () => { if (closed) return; onStatus('DEGRADED');
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); };
    ws.onerror = () => ws.close();
  };
  connect();
  return { close: () => { closed = true; ws?.close(); }, lastTickAge: () => lastTick ? Date.now() - lastTick : null };
}
```

- [x] **Step 4: Run to verify pass**

Run: `node --test test/adapters.test.js` — Expected: 3 pass.

- [x] **Step 5: Commit**

```bash
git add src/adapters/alpacaStream.js test/adapters.test.js
git commit -m "Implement FR-A15 stream adapter on Alpaca IEX WS (Layer 1 pivot, C9)"
```

### Task 3: FMP adapter → regime-only

**Files:**
- Modify: `src/adapters/fmp.js` (full replacement — `batchQuotes` and `nextEarnings` are dead on post-2025 free keys)
- Modify: `test/adapters.test.js` (append)

**Interfaces:**
- Produces: `regimeQuotes(apiKey, f = fetch)` → `{ spy: {price, changePct, ma50, ma200}, vix: number }`. Callers: future live wiring (FR-A1/A2 G1–G2 inputs). SPY 20-DMA still comes from Twelve Data daily bars (HANDOVER §10), unchanged.

- [x] **Step 1: Append failing tests** to `test/adapters.test.js`:

```js
import { regimeQuotes } from '../src/adapters/fmp.js';

const fakeFetch = table => async url => {
  for (const [needle, resp] of Object.entries(table)) if (url.includes(needle))
    return { ok: resp.status === 200, status: resp.status,
             json: async () => resp.body, text: async () => JSON.stringify(resp.body) };
  throw new Error('unexpected url ' + url);
};

test('fmp: regimeQuotes maps SPY quote and VIX level', async () => {
  const f = fakeFetch({
    'symbol=SPY': { status: 200, body: [{ symbol: 'SPY', price: 772.85, changePercentage: 2.0, priceAvg50: 750.1, priceAvg200: 700.2 }] },
    'symbol=%5EVIX': { status: 200, body: [{ symbol: '^VIX', price: 16.47 }] },
  });
  const r = await regimeQuotes('key', f);
  assert.deepEqual(r, { spy: { price: 772.85, changePct: 2.0, ma50: 750.1, ma200: 700.2 }, vix: 16.47 });
});

test('fmp: regimeQuotes surfaces provider error text', async () => {
  const f = async () => ({ ok: false, status: 402, text: async () => 'Restricted Endpoint: upgrade', json: async () => null });
  await assert.rejects(() => regimeQuotes('key', f), /402.*Restricted Endpoint/s);
});
```

- [x] **Step 2: Run to verify failure** — `node --test test/adapters.test.js` → FAIL (`regimeQuotes` not exported).

- [x] **Step 3: Replace `src/adapters/fmp.js`**:

```js
// FMP — REGIME INPUTS ONLY since FRD v1.6. Free tier for post-Aug-2025 keys is
// symbol-restricted (C9): SPY and ^VIX are served, most watchlist names 402.
// Watchlist quotes moved to Twelve Data; earnings moved to Finnhub REST.
const BASE = 'https://financialmodelingprep.com';
async function quote(symbol, apiKey, f) {
  const r = await f(`${BASE}/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`);
  if (!r.ok) throw new Error(`FMP quote ${symbol} ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const [q] = await r.json();
  return { price: q.price, changePct: q.changePercentage, ma50: q.priceAvg50, ma200: q.priceAvg200 };
}
export async function regimeQuotes(apiKey, f = fetch) {
  const [spy, vix] = await Promise.all([quote('SPY', apiKey, f), quote('^VIX', apiKey, f)]);
  return { spy, vix: vix.price };
}
```

- [x] **Step 4: Run to verify pass** — `node --test test/adapters.test.js` → all pass.

- [x] **Step 5: Commit**

```bash
git add src/adapters/fmp.js test/adapters.test.js
git commit -m "Shrink FMP adapter to regime inputs (FR-A1/A2); watchlist quotes/earnings moved off FMP (C9)"
```

### Task 4: Finnhub REST earnings adapter

**Files:**
- Create: `src/adapters/finnhub.js`
- Modify: `test/adapters.test.js` (append)

**Interfaces:**
- Produces: `nextEarningsMap(tickers, apiKey, f = fetch, today = new Date())` → `{ [ticker]: 'YYYY-MM-DD' | null }`. `null` = unknown → caller badges the name (FRD 4.6 fail-safe). One call covers the whole watchlist (vs. v1's per-name FMP calls).

- [x] **Step 1: Append failing tests**:

```js
import { nextEarningsMap } from '../src/adapters/finnhub.js';

test('finnhub: nextEarningsMap picks earliest future date per ticker, null when absent', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ earningsCalendar: [
    { symbol: 'MU', date: '2026-09-24' }, { symbol: 'MU', date: '2026-12-17' },
    { symbol: 'DELL', date: '2026-08-27' }, { symbol: 'XXXX', date: '2026-08-10' },
  ] }) });
  const map = await nextEarningsMap(['MU', 'DELL', 'SNDK'], 'key', f, new Date('2026-08-04'));
  assert.deepEqual(map, { MU: '2026-09-24', DELL: '2026-08-27', SNDK: null });
});

test('finnhub: nextEarningsMap surfaces HTTP errors', async () => {
  const f = async () => ({ ok: false, status: 429, text: async () => 'rate limit' });
  await assert.rejects(() => nextEarningsMap(['MU'], 'key', f), /429/);
});
```

- [x] **Step 2: Run to verify failure** — `node --test test/adapters.test.js` → FAIL (module missing).

- [x] **Step 3: Create `src/adapters/finnhub.js`**:

```js
// Finnhub REST earnings calendar (FR-A7 since FRD v1.6). Browser CORS verified 2026-08-04
// — the FRD v1.5 "REST CORS unreliable" assumption was wrong for this endpoint.
// The Finnhub WS is no longer used (free tier symbol-restricted, C9).
const BASE = 'https://finnhub.io/api/v1';
export async function nextEarningsMap(tickers, apiKey, f = fetch, today = new Date()) {
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 120 * 86400000).toISOString().slice(0, 10);
  const r = await f(`${BASE}/calendar/earnings?from=${from}&to=${to}&token=${apiKey}`);
  if (!r.ok) throw new Error(`Finnhub earnings ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const rows = (await r.json()).earningsCalendar ?? [];
  const map = Object.fromEntries(tickers.map(t => [t, null]));   // FRD 4.6: unknown fails safe → badge
  for (const row of rows) if (row.symbol in map && row.date >= from)
    if (map[row.symbol] === null || row.date < map[row.symbol]) map[row.symbol] = row.date;
  return map;
}
```

- [x] **Step 4: Run to verify pass** — `node --test test/adapters.test.js` → all pass.

- [x] **Step 5: Commit**

```bash
git add src/adapters/finnhub.js test/adapters.test.js
git commit -m "Implement FR-A7 earnings via Finnhub REST calendar (one call, fail-safe nulls)"
```

### Task 5: Twelve Data quote batch

**Files:**
- Modify: `src/adapters/twelvedata.js` (append export)
- Modify: `test/adapters.test.js` (append)

**Interfaces:**
- Produces: `quotes(symbols, apiKey, f = fetch)` → `{ [symbol]: {price, changePct, volume, avgVolume} | null }`. Callers must chunk to ≤8 symbols per call through the FR-A5 queue (8 credits/min — a symbol costs one credit even inside a batch request).

- [x] **Step 1: Append failing tests**:

```js
import { quotes } from '../src/adapters/twelvedata.js';

test('twelvedata: quotes maps batch response, null for failed symbols', async () => {
  const f = async () => ({ json: async () => ({
    DELL: { close: '470.435', percent_change: '-4.4', volume: '9000000', average_volume: '8000000' },
    MU: { code: 404, status: 'error', message: 'symbol not found' },
  }) });
  const q = await quotes(['DELL', 'MU'], 'key', f);
  assert.deepEqual(q, { DELL: { price: 470.435, changePct: -4.4, volume: 9000000, avgVolume: 8000000 }, MU: null });
});

test('twelvedata: quotes handles single-symbol unwrapped response', async () => {
  const f = async () => ({ json: async () => ({ symbol: 'SPY', close: '772.48', percent_change: '2.0', volume: '50', average_volume: '40' }) });
  const q = await quotes(['SPY'], 'key', f);
  assert.deepEqual(q, { SPY: { price: 772.48, changePct: 2.0, volume: 50, avgVolume: 40 } });
});
```

- [x] **Step 2: Run to verify failure** — `node --test test/adapters.test.js` → FAIL (`quotes` not exported).

- [x] **Step 3: Append to `src/adapters/twelvedata.js`**:

```js
// Overview quotes since FRD v1.6 (FMP free tier can't serve watchlist names, C9).
// Callers chunk to ≤8 symbols per call via the FR-A5 queue: 1 credit per symbol, 8/min.
export async function quotes(symbols, apiKey, f = fetch) {
  const r = await f(`${BASE}/quote?symbol=${symbols.join(',')}&apikey=${apiKey}`);
  const js = await r.json();
  if (js.status === 'error') throw new Error(`TwelveData: ${js.message}`);
  const rows = symbols.length === 1 ? { [symbols[0]]: js } : js;
  return Object.fromEntries(symbols.map(s => {
    const q = rows[s];
    if (!q || q.status === 'error') return [s, null];
    return [s, { price: +q.close, changePct: +q.percent_change, volume: +(q.volume ?? 0), avgVolume: +(q.average_volume ?? 0) }];
  }));
}
```

- [x] **Step 4: Run to verify pass** — `node --test test/adapters.test.js` → all pass, then full suite: `node --test test/core.test.js test/engine/engine.test.js test/engine/indicators.test.js test/adapters.test.js` → 25 + new all green.

- [x] **Step 5: Commit**

```bash
git add src/adapters/twelvedata.js test/adapters.test.js
git commit -m "Add Twelve Data quote batch for FR-A1 overview (chunked 8/min via FR-A5 queue)"
```

### Task 6: Key fields in `index.html`

**Files:**
- Modify: `index.html` (keys panel only)

**Interfaces:** field ids consumed by future live wiring: `#key-fmp`, `#key-td`, `#key-alpaca-id`, `#key-alpaca-secret`, `#key-fh`, `#key-or`, `#key-nd` (verify current ids in `index.html` first and keep the existing naming scheme if it differs).

- [x] **Step 1:** In the keys panel, replace the single Finnhub field with an Alpaca key-ID + secret pair, and relabel Finnhub as "Finnhub key (earnings)". Keep FMP, Twelve Data, OpenRouter, newsdata.io fields unchanged. Placeholder texts: `Alpaca key ID (stream)`, `Alpaca secret`, `Finnhub key (earnings)`.
- [x] **Step 2: Verify** — `npm run build` green; load `http://localhost:5173/`, demo mode still boots, six/seven key fields render.
- [x] **Step 3: Commit** — `git add index.html && git commit -m "Key panel: Alpaca pair for Layer 1 stream, Finnhub relabeled to earnings role"`

### Task 7: FRD v1.6 amendment

**Files:**
- Modify: `docs/FRD.md`

Spec-code truth (HANDOVER §8.2): same phase as the code changes. Edits, all justified by the 2026-08-04 spike evidence:

- [x] **Step 1: §6.1 Layer 1** — replace Finnhub with Alpaca IEX WS (free tier: real-time IEX trades, browser WS verified; 30-symbol subscription cap fits 20 names + SPY). State Finnhub WS was dropped because its free tier streams only a restricted popular-symbol set (verified: AAPL/TSLA stream, SPY/MU/DELL silent, no error frames).
- [x] **Step 2: §6.1 Layer 3 + §6.2 source table** — FMP row: regime-only (SPY, ^VIX), note symbol restriction + dead batch/legacy endpoints for post-Aug-2025 keys. Finnhub row: REST `/calendar/earnings` (CORS verified from browser 2026-08-04, correcting the v1.5 assumption), WS deprecated. Alpaca row: promoted from "documented alternative" to Layer 1 primary. Twelve Data row: add `/quote` for the overview table (chunked ≤8 symbols/call through the FR-A5 queue; ~21 credits/refresh inside the 800/day budget).
- [x] **Step 3: §6.3 register** — C1: reword to name IEX as the single venue (Alpaca). Add **C9**: "Free-tier symbol restrictions (discovered 2026-08-04): FMP serves only a popular-symbol subset on new keys (watchlist names 402) and Finnhub WS streams only that subset. Consequence: FMP demoted to regime inputs; Layer 1 moved to Alpaca; overview quotes moved to Twelve Data, making the initial table fill progressive (~3 min for 20 names at 8 credits/min) rather than 3 REST calls. Mitigation: live stream overtakes REST quotes within seconds during market hours; Phase 2 exit: any paid tier."
- [x] **Step 4: §7 FR text** — FR-A1: overview quotes via Twelve Data chunked batches + FMP regime pair; progressive fill, regime banner within 3s (NFR-2 unchanged, table fills as chunks land). FR-A7: earnings via one Finnhub calendar call. FR-A15: Alpaca WS, unchanged behavior otherwise.
- [x] **Step 5: §11 change log** — add v1.6 entry naming the spike as trigger, the three provider moves, C9, and the FR-A1 fill-behavior change.
- [x] **Step 6: Commit** — `git add docs/FRD.md && git commit -m "FRD v1.6: provider pivot after free-tier spike (C9; FR-A1/A7/A15 amended)"`

### Task 8: HANDOVER + README refresh & final verification

**Files:**
- Modify: `HANDOVER.md` (§5 build state + spike status, §7 keys incl. Alpaca pair, §10 add symbol-restriction gotcha)
- Modify: `README.md` (status checklist)

- [x] **Step 1:** Update HANDOVER §5 (spike v1 findings + v2 status), §7 (Alpaca key pair; `.env.example` exists; never `VITE_` prefix), §10 (add: "Free-tier symbol restrictions: FMP + Finnhub WS serve only popular symbols on new keys — verify with watchlist names, not AAPL").
- [x] **Step 2:** Full verification: `node --test test/core.test.js test/engine/engine.test.js test/engine/indicators.test.js test/adapters.test.js` all green; `npm run build` green; demo mode boots in browser.
- [x] **Step 3: Commit** — `git add HANDOVER.md README.md && git commit -m "Docs: record provider pivot and spike v2 protocol"`

---

## Self-review notes

- Spec coverage: spike (HANDOVER §5 blocker) → Task 1; NFR-4 swap → Task 2; FR-A1/A2 → Tasks 3+5; FR-A7 → Task 4; spec-code truth → Task 7; docs → Task 8. Live wiring (FR-A15–A18 in `main.js`) is deliberately NOT in this plan — it is the next phase, gated on spike v2 check 1 passing with real keys.
- Type consistency: trade shape `{sym,p,v,t}` identical in Task 1 evidence, Task 2 adapter/test; `regimeQuotes`/`nextEarningsMap`/`quotes` signatures match between test and implementation steps.
- Deferred decisions: GitHub remote + Pages (user go/no-go pending); Finnhub WS adapter file (`finnhubStream.js`) is kept in-tree as the documented fallback interface, not deleted.
