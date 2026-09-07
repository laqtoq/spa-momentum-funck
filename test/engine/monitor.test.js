import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/core/config.js';
import { monitorPosition, excursion, stopPrice, targetPrice, fmtDuration } from '../../src/engine/monitor.js';

const cfg = BASELINE;
const utc = (h, m) => new Date(Date.UTC(2026, 7, 4, h, m));   // Tue Aug 4, CET = UTC+2
const cet = (h, m) => `2026-08-04T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`;
const long = (entry = 100, at = [16, 0]) => ({ ticker: 'DELL', dir: 'long', entryPrice: entry, leverage: 10, entryTs: cet(...at) });
const short = (entry = 100, at = [16, 0]) => ({ ...long(entry, at), dir: 'short' });
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} !≈ ${b}`);

// FR-A16: the numbers on the panel, both directions
test('monitor: at entry the baseline distances are exactly 0.8pp / 3.0pp, levered 8% / 30%', () => {
  for (const pos of [long(), short()]) {
    const m = monitorPosition(pos, 100, utc(14, 0), cfg);
    near(m.toStopPct, 0.8); near(m.toTargetPct, 3.0);
    near(m.toStopLevered, 8); near(m.toTargetLevered, 30);
    near(m.openPnlPct, 0); near(m.openPnlLevered, 0);
    assert.equal(m.alerts.stop, false);
    assert.equal(m.alerts.target, false);
  }
});

test('monitor: stop and target sit on opposite sides for long vs short', () => {
  near(stopPrice(long(), cfg), 99.2);   near(targetPrice(long(), cfg), 103);
  near(stopPrice(short(), cfg), 100.8); near(targetPrice(short(), cfg), 97);
  // a recorded broker level wins over the derived one (FR-D7)
  near(stopPrice({ ...long(), stop: 99.5 }, cfg), 99.5);
});

test('monitor: open P&L is measured from entry and levered 10x, signed by direction', () => {
  near(monitorPosition(long(), 101, utc(14, 0), cfg).openPnlPct, 1);
  near(monitorPosition(long(), 101, utc(14, 0), cfg).openPnlLevered, 10);
  near(monitorPosition(short(), 101, utc(14, 0), cfg).openPnlPct, -1);
  near(monitorPosition(short(), 99, utc(14, 0), cfg).openPnlLevered, 10);
});

// FR-A16 alerts: proximity is read as percentage points of underlying distance remaining
test('monitor: stop alert arms inside 0.25pp and stays off outside it', () => {
  assert.equal(monitorPosition(long(), 99.6, utc(14, 0), cfg).alerts.stop, false); // 0.40pp away
  assert.equal(monitorPosition(long(), 99.4, utc(14, 0), cfg).alerts.stop, true);  // 0.20pp away
  assert.equal(monitorPosition(short(), 100.4, utc(14, 0), cfg).alerts.stop, false);
  assert.equal(monitorPosition(short(), 100.6, utc(14, 0), cfg).alerts.stop, true);
});

test('monitor: trading through a level alerts regardless of proximity arithmetic', () => {
  const through = monitorPosition(long(), 98, utc(14, 0), cfg);
  assert.equal(through.throughStop, true);
  assert.equal(through.alerts.stop, true);
  const won = monitorPosition(long(), 104, utc(14, 0), cfg);
  assert.equal(won.throughTarget, true);
  assert.equal(won.alerts.target, true);
});

// FR-A16 time limits: 5h time stop vs the 21:45 CET hard close, whichever binds first
test('monitor: binding limit flips at a 16:45 CET entry', () => {
  const early = monitorPosition(long(100, [16, 0]), 100, utc(14, 0), cfg);   // 16:00 CET
  assert.equal(early.binding, 'TIME_STOP');
  near(early.minutesToTimeStop, 300); near(early.minutesToHardClose, 345);
  near(early.minutesToLimit, 300);

  const late = monitorPosition(long(100, [17, 30]), 100, utc(15, 30), cfg);  // 17:30 CET
  assert.equal(late.binding, 'HARD_CLOSE');
  near(late.minutesToTimeStop, 300); near(late.minutesToHardClose, 255);
  near(late.minutesToLimit, 255);
});

test('monitor: time alert arms 15 minutes before the binding limit', () => {
  const pos = long(100, [16, 0]);                                            // time stop at 21:00 CET
  assert.equal(monitorPosition(pos, 100, utc(18, 30), cfg).alerts.time, false); // 20:30 CET, 30 min left
  assert.equal(monitorPosition(pos, 100, utc(18, 50), cfg).alerts.time, true);  // 20:50 CET, 10 min left
  near(monitorPosition(pos, 100, utc(18, 50), cfg).minutesElapsed, 290);
});

test('fmtDuration: rounds before splitting — a fractional 179.5 min is 3h00, not 2h60', () => {
  assert.equal(fmtDuration(179.5), '3h00');
  assert.equal(fmtDuration(180), '3h00');
  assert.equal(fmtDuration(125), '2h05');
  assert.equal(fmtDuration(9.6), '0h10');
  assert.equal(fmtDuration(0), '0h00');        // a just-opened position, not an expired limit
  assert.equal(fmtDuration(-4), 'over');
});

// FR-D8: running MAE/MFE from the stream, positive magnitudes in underlying %
test('excursion: adverse and favorable magnitudes by direction', () => {
  near(excursion(long(), 98.5).mae, 1.5);
  near(excursion(long(), 98.5).mfe, 0);
  near(excursion(long(), 102).mfe, 2);
  near(excursion(short(), 98.5).mfe, 1.5);
  near(excursion(short(), 102).mae, 2);
});
