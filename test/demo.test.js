import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASELINE } from '../src/core/config.js';
import { evaluate } from '../src/engine/signal.js';
import { sessionState } from '../src/core/session.js';
import { demoData, demoContext, DEMO_ASOF } from '../src/adapters/demo.js';

const WL = JSON.parse(readFileSync(new URL('../public/watchlist.json', import.meta.url)));
const data = demoData(WL);
const stateOf = t => {
  const n = WL.names.find(x => x.ticker === t);
  return evaluate(BASELINE, demoContext(data, n, BASELINE)).state;
};
const critOf = (t, id) => {
  const n = WL.names.find(x => x.ticker === t);
  return evaluate(BASELINE, demoContext(data, n, BASELINE)).criteria.find(c => c.id === id);
};

// The whole point of the as-of anchor: E6 gates on the clock, so a wall-clock demo is IDLE
// 21+ hours a day and every weekend.
test('demo as-of moment sits inside the entry window', () => {
  assert.equal(sessionState(DEMO_ASOF, BASELINE), 'ENTRY_OPEN');
  assert.equal(critOf('DELL', 'E6').pass, true);
});

test('demo dataset stages a LONG that passes every criterion', () => {
  const n = WL.names.find(x => x.ticker === 'DELL');
  const r = evaluate(BASELINE, demoContext(data, n, BASELINE));
  assert.equal(r.state, 'LONG');
  const failed = r.criteria.filter(c => c.enabled && !c.pass).map(c => c.id);
  assert.deepEqual(failed, [], `unexpected failures: ${failed}`);
});

test('demo dataset stages ARMED — structure without a trigger', () => {
  for (const t of ['LITE', 'PWR']) {
    assert.equal(stateOf(t), 'ARMED', `${t} should be ARMED`);
    for (const id of ['E1', 'E4', 'E5']) assert.equal(critOf(t, id).pass, true, `${t} ${id} (structure)`);
    assert.equal(critOf(t, 'E8').pass, false, `${t} E8 should not have triggered`);
  }
  assert.equal(critOf('LITE', 'E2').pass, false);   // no volume behind it either
  assert.equal(critOf('PWR', 'E2').pass, true);     // volume is there, the break is not
});

// Each IDLE name fails for a different, legible reason — the drill-down is the teaching surface.
test('demo dataset stages a distinct failure reason per IDLE long', () => {
  assert.equal(stateOf('CVNA'), 'IDLE');
  assert.equal(critOf('CVNA', 'E1').pass, false, 'CVNA extended: RSI out of band');
  assert.ok(critOf('CVNA', 'E1').value > 65);

  assert.equal(stateOf('VLO'), 'IDLE');
  assert.equal(critOf('VLO', 'E4').pass, false, 'VLO priced into resistance');
  assert.ok(critOf('VLO', 'E4').value < BASELINE.runwayPct);

  assert.equal(stateOf('BSX'), 'IDLE');
  assert.equal(critOf('BSX', 'E5').pass, false, 'BSX too quiet to reach +3% in the time budget');

  assert.equal(stateOf('ETN'), 'IDLE');
});

test('regime gate holds every short-bias name IDLE while SPY is above its 20-DMA', () => {
  const shorts = WL.names.filter(n => n.bias === 'short');
  assert.ok(shorts.length > 0);
  for (const n of shorts) {
    const r = evaluate(BASELINE, demoContext(data, n, BASELINE));
    assert.equal(r.state, 'IDLE', `${n.ticker}`);
    assert.equal(r.criteria.find(c => c.id === 'G1').pass, false, `${n.ticker} G1`);
  }
});

test('demo dataset is deterministic across builds', () => {
  const a = demoData(WL), b = demoData(WL);
  assert.deepEqual(a.quotes, b.quotes);
  assert.deepEqual(a.hourBars.DELL, b.hourBars.DELL);
  assert.equal(a.fiveMin.DELL.at(-1).t, DEMO_ASOF.getTime() - 3e5);
});

// ---- Module B demo episode (decision D9): the panel must demonstrate itself keylessly ----

test('demo simulator stages all three verdicts through the real orchestrator', async () => {
  const { demoSimProviders, DEMO_SIM } = await import('../src/adapters/demo.js');
  const { runSimulation } = await import('../src/core/sim.js');
  const { makeQueue } = await import('../src/core/queue.js');
  const deps = { ...demoSimProviders(WL), queue: makeQueue({ perMinute: 1e6, now: () => Date.now() }) };
  const run = ticker => runSimulation({ ...DEMO_SIM, ticker, cfg: BASELINE, watchlist: WL }, deps);

  const win = await run('DELL');
  assert.equal(win.state, 'LONG', 'DELL sets up');
  assert.equal(win.verdict, 'WIN');
  assert.equal(win.resolution, '5min');
  assert.deepEqual(win.errors, {});

  const loss = await run('LITE');
  assert.equal(loss.verdict, 'LOSS', 'one bar spans both levels — conservative same-bar rule');
  assert.equal(loss.walk.reason, 'STOP');

  const timeout = await run('PWR');
  assert.equal(timeout.verdict, 'TIME-OUT');

  const quiet = await run('MU');
  assert.equal(quiet.qualified, false, 'names without a staged setup do not qualify');
});

test('demo simulator evaluates every criterion — nothing is skipped for want of data', async () => {
  const { demoSimProviders, DEMO_SIM } = await import('../src/adapters/demo.js');
  const { runSimulation } = await import('../src/core/sim.js');
  const { makeQueue } = await import('../src/core/queue.js');
  const deps = { ...demoSimProviders(WL), queue: makeQueue({ perMinute: 1e6, now: () => Date.now() }) };
  const r = await runSimulation({ ...DEMO_SIM, ticker: 'DELL', cfg: BASELINE, watchlist: WL }, deps);
  assert.deepEqual(r.notEvaluated, [], 'demo supplies VIX and earnings, so no criterion is stamped off');
  for (const c of r.criteria) assert.notEqual(c.pass, null, `${c.id} should be evaluated`);
});

test('demo simulator drops the simulated session\'s own daily bar', async () => {
  const { demoSimProviders, DEMO_SIM } = await import('../src/adapters/demo.js');
  const { runSimulation } = await import('../src/core/sim.js');
  const { makeQueue } = await import('../src/core/queue.js');
  const deps = { ...demoSimProviders(WL), queue: makeQueue({ perMinute: 1e6, now: () => Date.now() }) };
  const r = await runSimulation({ ...DEMO_SIM, ticker: 'DELL', cfg: BASELINE, watchlist: WL }, deps);
  // that bar carries a 1.4x high; if it leaked in, the runway level would come from it
  assert.ok(r.levels.runway < r.entry.price * 1.2, `runway ${r.levels.runway} looks like look-ahead`);
});
