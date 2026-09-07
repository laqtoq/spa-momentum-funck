import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/core/config.js';
import { buckets, baseSize, allocate } from '../../src/engine/sizing.js';

const cfg = BASELINE;
const pos = (ticker, dir, sizeFrac, beta, cluster) => ({ ticker, dir, sizeFrac, beta, cluster });
const full = baseSize(cfg);                                   // 0.1875
const rowOf = (b, id) => b.rows.find(r => r.id === id);
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} !≈ ${b}`);

test('buckets: an empty book consumes nothing anywhere', () => {
  const b = buckets(cfg, { equity: 100000, hwm: 100000, open: [] });
  for (const r of b.rows) {
    assert.equal(r.consumed, 0, r.id);
    assert.equal(r.binding, false, r.id);
  }
  assert.equal(b.daily.consumed, 0);
});

test('buckets: risk is measured at the stop, not counted per position', () => {
  const b = buckets(cfg, { equity: 100000, hwm: 100000, open: [
    pos('DELL', 'long', full, 2.0, 'C1'), pos('HUM', 'long', full, 0.4, 'C4')] });
  // two full-size positions × 1.5% risk each = 3.0% of equity at stop
  near(rowOf(b, 'risk').consumed, 3.0);
  near(rowOf(b, 'risk').limit, 3.0);
  assert.equal(rowOf(b, 'risk').binding, true);
  assert.equal(rowOf(b, 'concurrent').consumed, 2);
  assert.equal(rowOf(b, 'concurrent').binding, true);
});

test('buckets: a half-size position consumes half the risk, not half a slot', () => {
  const b = buckets(cfg, { equity: 100000, hwm: 100000, open: [pos('DELL', 'long', full / 2, 2, 'C1')] });
  near(rowOf(b, 'risk').consumed, 0.75);
  assert.equal(rowOf(b, 'concurrent').consumed, 1);
});

// The D4 story: the allocator scales a beta-5.2 name to fit, and the board must show it fitting.
test('buckets: a beta-scaled position exhausts the beta cap exactly, not 975%', () => {
  const a = allocate(cfg, { equity: 100000, hwm: 100000, open: [] },
    { ticker: 'SNDK', dir: 'long', beta: 5.2, cluster: 'C2', atrPct: 7, medianAtrPct: 7 });
  assert.equal(a.adjustments.betaScaled, true);
  assert.ok(Math.abs(a.sizeFrac - 0.0865) < 0.0002, `sizeFrac ${a.sizeFrac}`);
  const b = buckets(cfg, { equity: 100000, hwm: 100000, open: [pos('SNDK', 'long', a.sizeFrac, 5.2, 'C2')] });
  near(rowOf(b, 'beta').consumed, 450, 1e-6);
  near(rowOf(b, 'beta').limit, 450);
  assert.equal(rowOf(b, 'beta').binding, true);
  // …whereas full size would have been 975%
  const unscaled = buckets(cfg, { equity: 100000, hwm: 100000, open: [pos('SNDK', 'long', full, 5.2, 'C2')] });
  near(rowOf(unscaled, 'beta').consumed, 975, 1e-6);
});

test('buckets: opposing directions net down the beta bucket, same direction adds', () => {
  const same = buckets(cfg, { equity: 1e5, hwm: 1e5, open: [
    pos('A', 'long', full, 2, 'C1'), pos('B', 'long', full, 2, 'C2')] });
  const opposed = buckets(cfg, { equity: 1e5, hwm: 1e5, open: [
    pos('A', 'long', full, 2, 'C1'), pos('B', 'short', full, 2, 'C2')] });
  near(rowOf(same, 'beta').consumed, 750);
  near(rowOf(opposed, 'beta').consumed, 0);
  assert.equal(rowOf(same, 'direction').consumed, 2);
  assert.equal(rowOf(opposed, 'direction').consumed, 1);
});

// One full-size position per cluster is what the rule permits, so a single name must not
// read as a breach; the second name is what the rule bites on.
test('buckets: cluster binds on the second name in a cluster, not the first', () => {
  const one = buckets(cfg, { equity: 1e5, hwm: 1e5, open: [pos('MU', 'long', full, 2, 'C2')] });
  assert.equal(rowOf(one, 'cluster').consumed, 1);
  assert.equal(rowOf(one, 'cluster').binding, false);
  assert.match(rowOf(one, 'cluster').note, /C2.*one full-size/);

  const two = buckets(cfg, { equity: 1e5, hwm: 1e5, open: [
    pos('MU', 'long', full, 2, 'C2'), pos('WDC', 'long', full / 2, 2, 'C2')] });
  assert.equal(rowOf(two, 'cluster').consumed, 2);
  assert.equal(rowOf(two, 'cluster').binding, true);
  assert.match(rowOf(two, 'cluster').note, /C2.*half size/);

  // spread across two clusters, neither is crowded
  const spread = buckets(cfg, { equity: 1e5, hwm: 1e5, open: [
    pos('HUM', 'long', full, 0.4, 'C4'), pos('COIN', 'long', full, 2, 'C5')] });
  assert.equal(rowOf(spread, 'cluster').consumed, 1);
  assert.equal(rowOf(spread, 'cluster').binding, false);
});

test('buckets: drawdown throttle arms exactly at 4% below the high-water mark', () => {
  const clear = buckets(cfg, { equity: 96500, hwm: 100000, open: [] });
  assert.equal(rowOf(clear, 'drawdown').binding, false);
  const armed = buckets(cfg, { equity: 96000, hwm: 100000, open: [] });
  assert.equal(rowOf(armed, 'drawdown').binding, true);
  assert.match(rowOf(armed, 'drawdown').note, /ACTIVE/);
});

test('buckets: daily gauge adds realized loss to risk still open, weekly tracks the breaker', () => {
  const book = { equity: 1e5, hwm: 1e5, open: [pos('DELL', 'long', full, 2, 'C1')] };
  const b = buckets(cfg, book, { today: -1.5, week: -4.0 });
  near(b.daily.consumed, 3.0);            // 1.5% realized + 1.5% still at stop
  near(b.daily.realized, -1.5);
  near(b.daily.atRisk, 1.5);
  assert.equal(b.daily.binding, true);    // the day is fully committed
  near(b.weekly.consumed, 4.0);
  near(b.weekly.limit, 6);
  assert.equal(b.weekly.binding, false);
});

test('buckets: a profitable day does not credit the daily budget', () => {
  const b = buckets(cfg, { equity: 1e5, hwm: 1e5, open: [] }, { today: +2.0, week: +2.0 });
  assert.equal(b.daily.consumed, 0);
  assert.equal(b.weekly.consumed, 0);
});
