import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE, presetHash } from '../src/core/config.js';
import { makeQueue } from '../src/core/queue.js';
import { runSimulation, runScan, momentFromCET, cetOffsetMinutes } from '../src/core/sim.js';

const cfg = BASELINE;
const WL = { names: [
  { ticker: 'DELL', bias: 'long', cluster: 'C1', beta_60d: 2.89, atr_pct_14d: 7.5 },
  { ticker: 'LITE', bias: 'long', cluster: 'C2', beta_60d: 3.5, atr_pct_14d: 6.0 },
  { ticker: 'MU',   bias: 'short', cluster: 'C2', beta_60d: 4.8, atr_pct_14d: 7.0 },
] };
const DATE = '2026-08-04', TIME = '16:00';
const MOMENT = Date.parse('2026-08-04T14:00:00Z');
const instantQueue = () => makeQueue({ perMinute: 100000, now: () => Date.now() });
const bar = (t, c, { o = c, h = c * 1.002, l = c * 0.998, v = 100000 } = {}) => ({ t, o, h, l, c, v });

test('momentFromCET: 16:00 CET in August is 14:00 UTC; in January it is 15:00', () => {
  assert.equal(momentFromCET('2026-08-04', '16:00'), MOMENT);
  assert.equal(cetOffsetMinutes('2026-08-04'), 120);
  assert.equal(cetOffsetMinutes('2026-01-14'), 60);
  assert.equal(momentFromCET('2026-01-14', '16:00'), Date.parse('2026-01-14T15:00:00Z'));
});

function fakeDeps(over = {}) {
  const calls = { bars: [], vix: 0, earnings: 0 };
  const deps = {
    queue: instantQueue(),
    tdBars: async (sym, interval, size, range) => {
      calls.bars.push({ sym, interval, range });
      if (interval === '1day') {
        const out = [];
        for (let i = 40; i >= 1; i--) out.push(bar(Date.parse('2026-08-04T20:00:00Z') - i * 86400000, sym === 'SPY' ? 700 + (40 - i) : 99));
        out.push(bar(Date.parse('2026-08-04T20:00:00Z'), 120, { h: 140, l: 80 }));   // the excluded session
        return out;
      }
      if (interval === '1h') {
        const out = []; let c = 100;
        for (let i = 0; i < 40; i++) { c *= i % 2 ? 0.9955 : 1.0055;
          out.push(bar(MOMENT - (40 - i) * 3600000, c, { h: c * (i === 38 ? 1.06 : 1.006), l: c * (i === 38 ? 0.985 : 0.994), v: 1e6 })); }
        return out;
      }
      const out = [];
      for (let i = 0; i < 40; i++) out.push(bar(Date.parse('2026-08-03T13:30:00Z') + i * 300000, 99, { v: 90000 }));
      const open = Date.parse('2026-08-04T13:30:00Z');
      let q = 98.8;
      for (let i = 0; open + i * 300000 < MOMENT; i++) { q *= 1.0004; out.push(bar(open + i * 300000, q, { v: 95000 })); }
      const last = out.at(-1);
      out.push(bar(MOMENT - 300000, last.h * 1.004, { h: last.h * 1.005, v: 220000 }));
      const entry = out.at(-1).c;
      for (let i = 0; i < 80; i++) out.push(bar(MOMENT + i * 300000, i === 3 ? entry * 1.035 : entry,
        { o: entry, h: i === 3 ? entry * 1.04 : entry * 1.0005, l: entry * 0.999, v: 120000 }));
      return out;
    },
    vixAt: async () => { calls.vix += 1; return 21.4; },
    earningsAt: async () => { calls.earnings += 1; return null; },
    ...over };
  return { deps, calls };
}

test('runSimulation: fetches the right ranges and stamps preset, resolution and provider', async () => {
  const { deps, calls } = fakeDeps();
  const r = await runSimulation({ date: DATE, timeCET: TIME, ticker: 'DELL', cfg, watchlist: WL }, deps);
  assert.equal(r.presetHash, presetHash(cfg));
  assert.equal(r.provider, 'Twelve Data');
  assert.equal(r.resolution, '5min');
  assert.equal(r.ticker, 'DELL');
  const intervals = calls.bars.map(c => c.interval);
  assert.ok(intervals.includes('5min') && intervals.includes('1h') && intervals.includes('1day'));
  const dellRange = calls.bars.find(c => c.sym === 'DELL').range;
  assert.ok(dellRange.start_date < DATE && dellRange.end_date > DATE, 'range straddles the date');
  assert.equal(calls.vix, 1);
});

test('runSimulation: produces a decided episode through the real engine', async () => {
  const { deps } = fakeDeps();
  const r = await runSimulation({ date: DATE, timeCET: TIME, ticker: 'DELL', cfg, watchlist: WL }, deps);
  assert.equal(r.state, 'LONG');
  assert.equal(r.qualified, true);
  assert.equal(r.verdict, 'WIN');
  assert.ok(r.entry.ts >= MOMENT, 'entry never precedes the moment');
  assert.ok(r.episode.length > 10);
  assert.deepEqual(r.errors, {});
});

test('runSimulation: a provider failure is carried on the result, never a silent pass', async () => {
  const { deps } = fakeDeps({ tdBars: async (sym, interval) => {
    if (interval === '5min') throw new Error('TwelveData: API credits exhausted');
    return fakeDeps().deps.tdBars(sym, interval); } });
  const r = await runSimulation({ date: DATE, timeCET: TIME, ticker: 'DELL', cfg, watchlist: WL }, deps);
  assert.match(r.errors['5m'], /credits exhausted/);
  assert.equal(r.resolution, '1h', 'falls back and stamps the fallback');
});

test('runSimulation: no VIX means G2 is not evaluated, not quietly passed', async () => {
  const { deps } = fakeDeps({ vixAt: async () => null });
  const r = await runSimulation({ date: DATE, timeCET: TIME, ticker: 'DELL', cfg, watchlist: WL }, deps);
  const g2 = r.criteria.find(c => c.id === 'G2');
  assert.equal(g2.enabled, false);
  assert.equal(g2.pass, null);
  assert.ok(r.notEvaluated.some(x => x.id === 'G2'));
});

test('runSimulation: an unknown ticker reports NO DATA rather than throwing', async () => {
  const { deps } = fakeDeps();
  const r = await runSimulation({ date: DATE, timeCET: TIME, ticker: 'NOPE', cfg, watchlist: WL }, deps);
  assert.equal(r.state, 'NO DATA');
  assert.match(r.errors.name, /not on the watchlist/);
});

// ---- scan mode (FR-B6) ----

test('runScan: reports progress per name in order and returns one result each', async () => {
  const { deps } = fakeDeps();
  const seen = [];
  const { promise } = runScan({ date: DATE, timeCET: TIME, cfg, watchlist: WL }, deps, p => seen.push(p.done));
  const { results, total, cancelled } = await promise;
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(results.length, 3);
  assert.equal(total, 3);
  assert.equal(cancelled, false);
  assert.deepEqual(results.map(r => r.ticker), ['DELL', 'LITE', 'MU']);
});

test('runScan: cancel stops further fetching, not just the display', async () => {
  const { deps, calls } = fakeDeps();
  const handle = runScan({ date: DATE, timeCET: TIME, cfg, watchlist: WL }, deps,
    p => { if (p.done === 1) handle.cancel(); });
  const { results, cancelled } = await handle.promise;
  assert.equal(results.length, 1);
  assert.equal(cancelled, true);
  assert.equal(calls.bars.filter(c => c.sym === 'MU').length, 0, 'MU was never fetched');
});

test('runScan: one failing name does not abort the scan', async () => {
  const base = fakeDeps().deps;
  const { deps } = fakeDeps({ tdBars: async (sym, interval, size, range) => {
    if (sym === 'LITE') throw new Error('TwelveData: symbol not found');
    return base.tdBars(sym, interval, size, range); } });
  const { promise } = runScan({ date: DATE, timeCET: TIME, cfg, watchlist: WL }, deps);
  const { results } = await promise;
  assert.equal(results.length, 3);
  assert.ok(Object.keys(results[1].errors).length > 0, 'LITE carries its error');
  assert.equal(results[0].qualified, true, 'DELL still ran');
});

test('runScan: SPY dailies are fetched once for the whole scan, not per name', async () => {
  const { deps, calls } = fakeDeps();
  await runScan({ date: DATE, timeCET: TIME, cfg, watchlist: WL }, deps).promise;
  assert.equal(calls.bars.filter(c => c.sym === 'SPY').length, 1);
});
