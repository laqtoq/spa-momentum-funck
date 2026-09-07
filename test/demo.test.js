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
