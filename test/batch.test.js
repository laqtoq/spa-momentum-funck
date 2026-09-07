import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE, presetHash } from '../src/core/config.js';
import { makeQueue } from '../src/core/queue.js';
import { makePresetStore, setPath } from '../src/core/presets.js';
import { runBatch, aggregate, episodeToTrade } from '../src/core/batch.js';
import { demoSimProviders, DEMO_SIM } from '../src/adapters/demo.js';
import { readFileSync } from 'node:fs';

const WL = JSON.parse(readFileSync(new URL('../public/watchlist.json', import.meta.url)));
const mem = () => { const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const deps = () => ({ ...demoSimProviders(WL), queue: makeQueue({ perMinute: 1e6, now: () => Date.now() }) });
const near = (a, b, tol = 1e-6) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} !≈ ${b}`);
const DATES = [DEMO_SIM.date, '2026-07-27'];

const preset = (name, cfg = BASELINE) => ({ name, cfg, hash: presetHash(cfg) });

// ---- Task 3: the runner ----

test('runBatch: covers every (date × preset) combination and reports progress', async () => {
  const presets = [preset('baseline'), preset('wider runway', setPath(BASELINE, 'runwayPct', 3.5))];
  const seen = [];
  const { promise } = runBatch({ dates: DATES, presets, label: 'tuning', watchlist: WL },
    deps(), p => seen.push(`${p.preset}@${p.date}`));
  const out = await promise;
  assert.equal(out.total, 4);
  assert.equal(out.done, 4);
  assert.equal(out.runs.length, 4);
  assert.deepEqual(seen, ['baseline@2026-07-28', 'baseline@2026-07-27',
                          'wider runway@2026-07-28', 'wider runway@2026-07-27']);
  for (const r of out.runs) {
    assert.equal(r.results.length, WL.names.length);
    assert.equal(r.label, 'tuning');
    assert.equal(r.hash, presetHash(r.cfg));
  }
});

test('runBatch: cancel stops further combinations', async () => {
  const presets = [preset('a'), preset('b', setPath(BASELINE, 'vixCap', 28))];
  const handle = runBatch({ dates: DATES, presets, label: 'tuning', watchlist: WL },
    deps(), p => { if (p.done === 1) handle.cancel(); });
  const out = await handle.promise;
  assert.equal(out.cancelled, true);
  assert.ok(out.runs.length < 4, `ran ${out.runs.length} of 4`);
});

// FRD 4.7 §3 — the whole point of the split.
test('runBatch: a validation run locks its presets BEFORE the first date', async () => {
  const store = makePresetStore(mem());
  store.create('candidate', setPath(BASELINE, 'runwayPct', 3.5));
  assert.equal(store.get('candidate').locked, false);

  const lockedWhenFirstRan = [];
  const d = { ...deps(), presetStore: store };
  const { promise } = runBatch({ dates: DATES, presets: [store.get('candidate')],
    label: 'validation', watchlist: WL }, d,
    () => lockedWhenFirstRan.push(store.get('candidate').locked));
  const out = await promise;

  assert.deepEqual(out.locked, ['candidate']);
  assert.equal(lockedWhenFirstRan[0], true, 'already locked by the time the first date ran');
  assert.equal(store.get('candidate').locked, true);
});

test('runBatch: a tuning run does not lock anything', async () => {
  const store = makePresetStore(mem());
  store.create('draft', BASELINE);
  const d = { ...deps(), presetStore: store };
  const out = await runBatch({ dates: [DEMO_SIM.date], presets: [store.get('draft')],
    label: 'tuning', watchlist: WL }, d).promise;
  assert.deepEqual(out.locked, []);
  assert.equal(store.get('draft').locked, false);
});

// ---- Task 4: aggregation ----

test('episodeToTrade: maps an episode onto the journal shape, without inventing slippage', () => {
  const r = { qualified: true, ticker: 'DELL', state: 'LONG', resolution: '5min',
    entry: { ts: Date.parse('2026-07-28T14:00:00Z'), price: 100 },
    walk: { reason: 'TARGET', exitPrice: 103, barIdx: 6, underlyingPct: 3, mae: 0.2, mfe: 3.1 } };
  const t = episodeToTrade(r, BASELINE, WL);
  near(t.underlyingPct, 3);
  near(t.leveredPct, 30);
  assert.equal(t.exitReason, 'TARGET');
  assert.equal(t.stop, undefined, 'no stop → no fabricated slippage measurement');
  assert.equal(t.exitTs, new Date(Date.parse('2026-07-28T14:00:00Z') + 6 * 300000).toISOString());
  assert.ok(t.sizeFrac > 0 && t.sizeFrac <= 0.1875);
  assert.equal(episodeToTrade({ qualified: false }, BASELINE, WL), null);
});

test('aggregate: computes signals, hit rate, expectancy and shares from episodes', () => {
  const mk = (ticker, reason, pct, mae, mfe) => ({
    ticker, state: 'LONG', qualified: true, resolution: '5min',
    entry: { ts: Date.parse('2026-07-28T14:00:00Z'), price: 100 },
    walk: { reason, exitPrice: 100 * (1 + pct / 100), barIdx: 6, underlyingPct: pct, mae, mfe } });
  const runs = [{ preset: 'p', hash: 'h', cfg: BASELINE, label: 'tuning', date: 'd1', results: [
    mk('DELL', 'TARGET', 3, 0.2, 3.1), mk('LITE', 'STOP', -0.8, 0.9, 1.2),
    mk('PWR', 'TIME', 0.1, 0.4, 1.0), mk('MU', 'STOP', -0.8, 0.85, 0.9),
    { ticker: 'CAT', qualified: false, resolution: '5min' }] }];
  const [a] = aggregate(runs, WL);
  assert.equal(a.signals, 4);
  assert.equal(a.scanned, 5, 'names scanned, including the one that did not set up');
  near(a.hitRate, 0.25);
  near(a.timeoutShare, 0.25);
  near(a.stopShare, 0.5);
  near(a.avgMae, (0.2 + 0.9 + 0.4 + 0.85) / 4);
  near(a.avgMfe, (3.1 + 1.2 + 1.0 + 0.9) / 4);
  assert.deepEqual(a.resolutions, ['5min']);
  assert.equal(a.dofOverBudget, false);
  assert.ok(a.expectancy != null);
});

// FR-C7: the two labels answer different questions and must never be pooled.
test('aggregate: tuning and validation are separate rows for the same preset', () => {
  const one = (label, reason) => ({ preset: 'p', hash: 'h', cfg: BASELINE, label, date: 'd', results: [{
    ticker: 'DELL', state: 'LONG', qualified: true, resolution: '5min',
    entry: { ts: Date.parse('2026-07-28T14:00:00Z'), price: 100 },
    walk: { reason, exitPrice: 103, barIdx: 6, underlyingPct: reason === 'TARGET' ? 3 : -0.8, mae: 0.2, mfe: 3 } }] });
  const rows = aggregate([one('tuning', 'TARGET'), one('validation', 'STOP')], WL);
  assert.equal(rows.length, 2);
  const tuning = rows.find(r => r.label === 'tuning'), val = rows.find(r => r.label === 'validation');
  near(tuning.hitRate, 1);
  near(val.hitRate, 0);
});

test('aggregate: a preset over the DoF budget is badged (FR-C9)', () => {
  let cfg = setPath(BASELINE, 'rsiLong', [40, 65]);
  cfg = setPath(cfg, 'relVolMin', 1.8);
  cfg = setPath(cfg, 'runwayPct', 2.5);
  cfg = setPath(cfg, 'vixCap', 28);
  const [a] = aggregate([{ preset: 'greedy', hash: 'h', cfg, label: 'tuning', date: 'd', results: [] }], WL);
  assert.equal(a.dofOverBudget, true);
  assert.equal(a.signals, 0);
  assert.equal(a.hitRate, null, 'no signals means no hit rate, not zero');
});

// ---- end to end against the demo providers ----

test('runBatch + aggregate: two presets across two dates produce a comparable table', async () => {
  const presets = [preset('baseline'), preset('wider runway', setPath(BASELINE, 'runwayPct', 6.0))];
  const out = await runBatch({ dates: DATES, presets, label: 'tuning', watchlist: WL }, deps()).promise;
  const rows = aggregate(out.runs, WL);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.dates, 2);
    assert.equal(r.scanned, 2 * WL.names.length);
    assert.ok(r.hash.match(/^[0-9a-f]{8}$/));
  }
  assert.notEqual(rows[0].hash, rows[1].hash, 'different configurations, different hashes');
  const base = rows.find(r => r.preset === 'baseline');
  assert.ok(base.signals > 0, 'the staged demo date sets up under baseline');
});
