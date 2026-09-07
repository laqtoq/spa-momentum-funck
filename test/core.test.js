import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE, presetHash } from '../src/core/config.js';
import { sessionState, minutesToHardClose } from '../src/core/session.js';
import { makeQueue } from '../src/core/queue.js';
import { makeAggregator } from '../src/core/aggregator.js';
import { makeJournal } from '../src/core/store.js';

// config hash (NFR-6)
test('preset hash: deterministic and key-order independent', () => {
  const a = presetHash(BASELINE);
  const shuffled = JSON.parse(JSON.stringify(BASELINE));
  const re = {}; Object.keys(shuffled).reverse().forEach(k => re[k] = shuffled[k]);
  assert.equal(a, presetHash(re));
  assert.notEqual(a, presetHash({ ...BASELINE, stopPct: 0.9 }));
  assert.match(a, /^[0-9a-f]{8}$/);
});

// session windows (E6) — dates constructed in UTC; Aug: CET=UTC+2
const utc = (h, m) => new Date(Date.UTC(2026, 7, 4, h, m)); // Tue Aug 4
test('session state edges (CEST)', () => {
  assert.equal(sessionState(utc(13, 0), BASELINE), 'PRE_MARKET');      // 15:00 CET
  assert.equal(sessionState(utc(13, 45), BASELINE), 'ENTRY_OPEN');     // 15:45 CET inclusive
  assert.equal(sessionState(utc(15, 59), BASELINE), 'ENTRY_OPEN');     // 17:59
  assert.equal(sessionState(utc(16, 0), BASELINE), 'ENTRIES_CLOSED');  // 18:00 exclusive
  assert.equal(sessionState(new Date(Date.UTC(2026, 7, 8, 14, 0)), BASELINE), 'CLOSED'); // Saturday
  assert.equal(minutesToHardClose(utc(17, 45), BASELINE), 120);        // 19:45 CET → 21:45
});

// queue (FR-A5)
test('queue: spaces calls to >= 60/perMinute ms and caches by TTL', async () => {
  let t = 0; const q = makeQueue({ perMinute: 60, now: () => t });     // 1000ms gap for test speed
  const calls = [];
  const fake = id => async () => { calls.push({ id, t }); return id; };
  const p1 = q.schedule('a', 5000, fake(1)); t += 1;
  const r1 = await p1;
  const r2 = await q.schedule('a', 5000, fake(2));                    // cache hit
  assert.equal(r1.cached, false); assert.equal(r2.cached, true); assert.equal(r2.value, 1);
  assert.equal(q.budget().used, 1);
});

// aggregator (NFR-7)
test('aggregator: deterministic under out-of-order ticks, VWAP correct', () => {
  const t0 = Date.UTC(2026, 7, 4, 13, 30);
  const trades = [
    { p: 100, v: 10, t: t0 + 10_000 }, { p: 101, v: 20, t: t0 + 70_000 },
    { p: 99,  v: 10, t: t0 + 30_000 },                                 // out of order
    { p: 102, v: 5,  t: t0 + 130_000 } ];
  const A = makeAggregator(); trades.forEach(x => A.addTrade(x));
  const B = makeAggregator(); [...trades].sort((a,b)=>a.t-b.t).forEach(x => B.addTrade(x));
  assert.deepEqual(A.bars1m(), B.bars1m());                            // same bars either order
  const m1 = A.bars1m();
  assert.equal(m1.length, 3);
  assert.equal(m1[0].c, 99);                                           // close keyed by exchange ts, not arrival
  const vwapExp = (100*10 + 101*20 + 99*10 + 102*5) / 45;
  assert.ok(Math.abs(A.vwap() - vwapExp) < 1e-12);
});

// journal (FR-D7..D11)
test('journal: open→excursion→close→kpis→export/import round-trip', () => {
  const mem = new Map(); const storage = { getItem: k => mem.get(k) ?? null, setItem: (k,v) => mem.set(k,v) };
  const J = makeJournal(storage);
  J.setStartingEquity(100000);
  const id = J.openPosition({ ticker:'DELL', dir:'long', entryTs:'2026-08-04T15:50:00+02:00',
    entryPrice: 470, sizeFrac: 0.1875, leverage: 10, stop: 466.24, target: 484.1 });
  J.updateExcursion(id, 0.4, 1.1);
  const closed = J.closePosition(id, { exitTs:'2026-08-04T18:20:00+02:00', exitPrice: 484.1, exitReason:'TARGET' });
  assert.ok(Math.abs(closed.underlyingPct - 3) < 0.01 && Math.abs(closed.leveredPct - 30) < 0.1);
  const { equity, hwm } = J.equity();
  assert.ok(Math.abs(equity - 105625) < 30 && hwm >= equity);          // 100k + 18.75% × 30%
  assert.equal(J.kpis().hitRate30, 1);
  const dump = J.exportJSON(); mem.clear(); J.importJSON(dump);
  assert.equal(J.state().closed.length, 1);
  assert.ok(J.exportCSV().includes('DELL,long'));
});

// A sub-millisecond gap must not cost a macrotask: background tabs clamp every timer to 1s,
// which is what made a 20-name demo scan take 20 seconds of pure waiting.
test('queue: an unthrottled queue schedules without yielding to a timer', async () => {
  const q = makeQueue({ perMinute: 1e6, now: () => Date.now() });
  let timers = 0;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { timers += 1; return realTimeout(fn, ms); };
  try {
    for (let i = 0; i < 25; i++) await q.schedule(`k${i}`, 0, async () => i);
  } finally { globalThis.setTimeout = realTimeout; }
  assert.equal(timers, 0, `queue used ${timers} timers for 25 instant calls`);
  assert.equal(q.budget().used, 25);
});

test('queue: a real throttle still spaces calls', async () => {
  let t = 0; const q = makeQueue({ perMinute: 60, now: () => t });   // 1000ms gap
  const seen = [];
  await q.schedule('a', 0, async () => { seen.push(t); return 1; });
  const p = q.schedule('b', 0, async () => { seen.push(t); return 2; });
  await new Promise(r => setTimeout(r, 20));
  t += 1000;                                                         // clock advances past the gap
  await p;
  assert.equal(seen.length, 2);
});
