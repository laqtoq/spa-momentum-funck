import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/core/config.js';
import { sliceTo, entryBar, completedDaysBefore, simContext, simulateOne, INTERVAL_MS }
  from '../../src/engine/simulate.js';

const cfg = BASELINE;
const NAME = { ticker: 'DELL', bias: 'long', beta_60d: 2.89, cluster: 'C1', atr_pct_14d: 7.5 };
const near = (a, b, tol = 1e-6) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} !≈ ${b}`);

// Tue 4 Aug 2026, 16:00 CET = 14:00 UTC = 10:00 ET (inside the US session and the entry window).
const MOMENT = Date.parse('2026-08-04T14:00:00Z');
const bar = (t, c, { o = c, h = c * 1.002, l = c * 0.998, v = 100000 } = {}) => ({ t, o, h, l, c, v });

// ---- Task 1: point-in-time discipline ----

test('sliceTo: a bar is visible only once it has closed, not when it opens', () => {
  const step = INTERVAL_MS['5min'];
  const bars = [bar(MOMENT - 10 * 60000, 100), bar(MOMENT - 5 * 60000, 101), bar(MOMENT, 102), bar(MOMENT + 5 * 60000, 103)];
  const seen = sliceTo(bars, MOMENT, step);
  assert.equal(seen.length, 2, 'the bar stamped at the moment is still forming');
  assert.equal(seen.at(-1).c, 101);
  // the bar opening 5 minutes earlier closes exactly at the moment — it counts
  assert.equal(seen.at(-1).t + step, MOMENT);
});

test('entryBar: fills on the first bar opening at or after the moment — one evaluation never saw', () => {
  const bars = [bar(MOMENT - 5 * 60000, 101), bar(MOMENT, 102, { o: 101.5 }), bar(MOMENT + 5 * 60000, 103)];
  const eb = entryBar(bars, MOMENT);
  assert.equal(eb.o, 101.5);
  assert.ok(eb.t >= MOMENT);
  assert.equal(sliceTo(bars, MOMENT, INTERVAL_MS['5min']).some(b => b.t === eb.t), false);
});

test('completedDaysBefore: the simulated session\'s own daily bar is excluded outright', () => {
  const d = iso => Date.parse(iso + 'T20:00:00Z');
  const daily = [bar(d('2026-08-01'), 10), bar(d('2026-08-03'), 11), bar(d('2026-08-04'), 12)];
  const kept = completedDaysBefore(daily, '2026-08-04');
  assert.equal(kept.length, 2);
  assert.equal(kept.at(-1).c, 11, 'the 4th holds that session\'s full high/low — look-ahead');
});

test('simContext: no array it hands the engine contains a bar later than the moment', () => {
  const data = mkData();
  const { ctx } = simContext({ ...data, moment: MOMENT, name: NAME, cfg });
  for (const [key, arr] of Object.entries({ hourBars: ctx.hourBars, fiveMinBars: ctx.fiveMinBars })) {
    for (const b of arr) assert.ok(b.t < MOMENT, `${key} leaked a bar at/after the moment`);
  }
  assert.ok(ctx.dailyBars.length > 0);
});

test('simContext: unavailable inputs disable their criterion instead of passing it', () => {
  const data = mkData();
  const noVix = simContext({ ...data, vix: null, moment: MOMENT, name: NAME, cfg });
  assert.equal(noVix.cfg.enabled.G2, false);
  assert.ok(noVix.notEvaluated.some(x => x.id === 'G2'));
  const r = simulateOne({ cfg, name: NAME, data: { ...data, vix: null }, moment: MOMENT });
  const g2 = r.criteria.find(c => c.id === 'G2');
  assert.equal(g2.enabled, false);
  assert.equal(g2.pass, null, 'not evaluated is neither pass nor fail');

  const noEarn = simContext({ ...data, earningsDate: undefined, moment: MOMENT, name: NAME, cfg });
  assert.equal(noEarn.cfg.enabled.E7, false);
  // …and unlike live mode, an unknown earnings date must NOT fail safe here, or every
  // historical setup would render IDLE.
  assert.equal(noEarn.ctx.inBlackout, false);
});

// ---- Task 2: episode result ----

test('simulateOne: a qualifying long walks forward to a TARGET win', () => {
  const r = simulateOne({ cfg, name: NAME, data: mkData(), moment: MOMENT });
  assert.equal(r.state, 'LONG');
  assert.equal(r.qualified, true);
  assert.equal(r.resolution, '5min');
  assert.equal(r.verdict, 'WIN');
  assert.equal(r.walk.reason, 'TARGET');
  near(r.walk.underlyingPct, cfg.targetPct, 1e-9);
  near(r.levels.target, r.entry.price * 1.03);
  near(r.levels.stop, r.entry.price * 0.992);
  assert.ok(r.episode.length > 10);
});

test('simulateOne: a bar spanning both levels is a LOSS — conservative same-bar rule (FR-B4)', () => {
  const data = mkData({ outcome: 'both' });
  const r = simulateOne({ cfg, name: NAME, data, moment: MOMENT });
  assert.equal(r.qualified, true);
  assert.equal(r.verdict, 'LOSS');
  assert.equal(r.walk.reason, 'STOP');
});

test('simulateOne: running past the time stop is a TIME-OUT at the configured horizon', () => {
  const r = simulateOne({ cfg, name: NAME, data: mkData({ outcome: 'flat' }), moment: MOMENT });
  assert.equal(r.verdict, 'TIME-OUT');
  assert.equal(r.walk.reason, 'TIME');
  assert.ok(r.walk.barIdx <= cfg.timeStopHours * 12, '5h at 5-minute bars is 60 bars');
});

test('simulateOne: a non-qualifying setup keeps its criteria and takes no entry', () => {
  const r = simulateOne({ cfg, name: NAME, data: mkData({ rsi: 'overbought' }), moment: MOMENT });
  assert.equal(r.qualified, false);
  assert.equal(r.entry, null);
  assert.equal(r.walk, null);
  assert.ok(r.criteria.length >= 9);
  assert.equal(r.criteria.find(c => c.id === 'E1').pass, false);
});

test('simulateOne: falls back to 1-hour resolution and stamps it when 5m is unavailable', () => {
  const data = mkData();
  const r = simulateOne({ cfg, name: NAME, data: { ...data, bars5m: [] }, moment: MOMENT });
  assert.equal(r.resolution, '1h');
});

test('simulateOne: reports NO DATA rather than a verdict when structure is missing', () => {
  const r = simulateOne({ cfg, name: NAME, data: { ...mkData(), bars1h: [] }, moment: MOMENT });
  assert.equal(r.state, 'NO DATA');
  assert.equal(r.qualified, false);
});

// ---- fixture: a series engineered to qualify long at MOMENT ----
function mkData({ outcome = 'win', rsi = 'inband' } = {}) {
  const P = 100;
  // 1h structure: alternating ±, RSI ≈ 55; one wide bar leaves overhead supply for E4
  const g = rsi === 'overbought' ? 0.008 : 0.0055, l = rsi === 'overbought' ? 0.002 : 0.0045;
  const bars1h = []; let c = P;
  for (let i = 0; i < 40; i++) {
    c *= i % 2 ? (1 - l) : (1 + g);
    const wide = i === 38;
    bars1h.push(bar(MOMENT - (40 - i) * 3600000, c,
      { h: c * (wide ? 1.06 : 1.006), l: c * (wide ? 0.985 : 0.994), v: 1e6 }));
  }
  // daily: 12 completed sessions before the 4th, plus the 4th itself (must be excluded)
  const daily = [];
  for (let i = 12; i >= 1; i--) {
    const t = Date.parse('2026-08-04T20:00:00Z') - i * 86400000;
    daily.push(bar(t, P * 0.99, { h: P * 1.05, l: P * 0.96, v: 1e7 }));
  }
  daily.push(bar(Date.parse('2026-08-04T20:00:00Z'), P * 1.2, { h: P * 1.4, l: P * 0.8 }));
  const spyDaily = [];
  for (let i = 30; i >= 1; i--) spyDaily.push(bar(Date.parse('2026-08-04T20:00:00Z') - i * 86400000, 700 + (30 - i)));

  // 5-minute: 40 prior-session bars for the relvol baseline, then today walking up into the moment
  const bars5m = [];
  const prevSession = Date.parse('2026-08-03T13:30:00Z');
  for (let i = 0; i < 40; i++) bars5m.push(bar(prevSession + i * 300000, P * 0.99, { v: 90000 }));
  const open = Date.parse('2026-08-04T13:30:00Z');
  let q = P * 0.988;
  for (let i = 0; open + i * 300000 < MOMENT; i++) { q *= 1.0004; bars5m.push(bar(open + i * 300000, q, { v: 95000 })); }
  const last = bars5m.at(-1);
  // the trigger bar: breaks the prior 5m high on heavy volume, closing at the moment
  bars5m.push(bar(MOMENT - 300000, last.h * 1.004, { h: last.h * 1.005, v: 220000 }));

  const entry = bars5m.at(-1).c;
  const fwd = (h, l, c) => ({ h, l, c });
  const shape = { win: fwd(entry * 1.04, entry * 0.999, entry * 1.035),
                  both: fwd(entry * 1.04, entry * 0.985, entry * 1.02),
                  flat: fwd(entry * 1.001, entry * 0.999, entry) }[outcome];
  for (let i = 0; i < 80; i++) {
    const first = i === 3;
    bars5m.push(bar(MOMENT + i * 300000, first ? shape.c : entry,
      { o: entry, h: first ? shape.h : entry * 1.0005, l: first ? shape.l : entry * 0.9995, v: 120000 }));
  }
  return { bars5m, bars1h, daily, spyDaily, vix: 21.4, earningsDate: null };
}

test('simulateOne: the episode stops shortly after the verdict, not 6 hours later', () => {
  const r = simulateOne({ cfg, name: NAME, data: mkData(), moment: MOMENT });
  const entryIdx = r.episode.findIndex(b => b.t >= r.entry.ts);
  const exitIdx = entryIdx + r.walk.barIdx;
  assert.ok(r.episode.length - exitIdx <= 10, `${r.episode.length - exitIdx} bars trail the exit`);
  assert.ok(entryIdx > 5, 'the run-up into the moment is still shown for context');
});
