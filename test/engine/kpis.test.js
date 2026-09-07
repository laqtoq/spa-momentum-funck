import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/core/config.js';
import { computeKpis, killCriteria, stopSlippagePp, dailyPnl, realizedPnl, bookBeta } from '../../src/engine/kpis.js';

const cfg = BASELINE;
const near = (a, b, tol = 1e-6) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} !≈ ${b}`);

// One trade: entry/exit in CET, size 18.75% at 10x, so account return = sizeFrac × leveredPct.
const trade = ({ day = '2026-08-04', dir = 'long', entry = 100, exit = 103, reason = 'TARGET',
                 size = 0.1875, mae = 0.3, mfe = 3.0, stop = 99.2, hours = 2 }) => {
  const und = (dir === 'long' ? 1 : -1) * (exit - entry) / entry * 100;
  return { ticker: 'X', dir, entryPrice: entry, exitPrice: exit, exitReason: reason, stop,
    entryTs: `${day}T16:00:00+02:00`, exitTs: `${day}T${String(16 + hours).padStart(2, '0')}:00:00+02:00`,
    sizeFrac: size, leverage: 10, underlyingPct: und, leveredPct: und * 10, mae, mfe };
};
const winner = o => trade({ ...o, exit: 103, reason: 'TARGET' });          // +3% und → +30% lev → +5.625% equity
const stopped = o => trade({ ...o, exit: 99.2, reason: 'STOP' });          // −0.8% und → −8% lev → −1.5% equity

test('kpis: an empty journal reports null everywhere with a reason, never zeros', () => {
  const k = computeKpis([], { cfg });
  assert.equal(k.trades, 0);
  for (const key of ['hitRate', 'profitFactor', 'expectancy', 'sharpe', 'bookBeta', 'timeInTrade', 'exposure']) {
    assert.equal(k[key], null, key);
  }
  assert.equal(k.na.all, 'no closed trades yet');
});

test('kpis: hit rate, profit factor and expectancy on a hand-computed set', () => {
  // 2 winners (+5.625% each), 3 stops (−1.5% each)
  const closed = [winner({ day: '2026-08-03' }), stopped({ day: '2026-08-04' }), stopped({ day: '2026-08-05' }),
                  winner({ day: '2026-08-06' }), stopped({ day: '2026-08-07' })];
  const k = computeKpis(closed, { cfg });
  assert.equal(k.trades, 5);
  near(k.hitRate, 2 / 5);
  near(k.avgWin, 5.625);
  near(k.avgLoss, 1.5);
  near(k.profitFactor, (2 * 5.625) / (3 * 1.5));                   // 11.25 / 4.5 = 2.5
  near(k.expectancy, 0.4 * 5.625 - 0.6 * 1.5);                     // = 1.35% of equity per trade
  // the formula must agree with the plain mean of the return series
  near(k.expectancy, (2 * 5.625 - 3 * 1.5) / 5);
});

test('kpis: MAE is averaged over winners and MFE over losers, per FRD 5.5', () => {
  const closed = [winner({ mae: 0.4, mfe: 3.0 }), winner({ mae: 0.6, mfe: 3.0 }),
                  stopped({ mae: 0.8, mfe: 1.2 }), stopped({ mae: 0.8, mfe: 2.0 })];
  const k = computeKpis(closed, { cfg });
  near(k.avgMaeWinners, 0.5);      // winners' drawdown — validates the 0.8% stop
  near(k.avgMfeLosers, 1.6);       // losers' run-up — validates the 3% target
});

test('stopSlippagePp: positive when the fill is worse than the stop, both directions', () => {
  near(stopSlippagePp({ exitReason: 'STOP', dir: 'long', entryPrice: 100, stop: 99.2, exitPrice: 99.05 }), 0.15);
  near(stopSlippagePp({ exitReason: 'STOP', dir: 'short', entryPrice: 100, stop: 100.8, exitPrice: 100.95 }), 0.15);
  near(stopSlippagePp({ exitReason: 'STOP', dir: 'long', entryPrice: 100, stop: 99.2, exitPrice: 99.3 }), -0.10); // better than stop
  assert.equal(stopSlippagePp({ exitReason: 'TARGET', dir: 'long', entryPrice: 100, stop: 99.2, exitPrice: 103 }), null);
});

test('kpis: time in trade, exposure and Sharpe come off the recorded timestamps', () => {
  const closed = [trade({ day: '2026-08-03', hours: 1 }), trade({ day: '2026-08-05', hours: 3 }),
                  trade({ day: '2026-08-07', hours: 5 })];
  const k = computeKpis(closed, { cfg });
  near(k.timeInTrade.medianMin, 180);
  near(k.timeInTrade.maxMin, 300);
  assert.equal(k.timeInTrade.n, 3);
  // Mon 3rd, Wed 5th, Fri 7th traded out of five weekday sessions in the span
  assert.equal(k.exposure.activeDays, 3);
  assert.equal(k.exposure.sessionDays, 5);
  near(k.exposure.pct, 0.6);
  assert.equal(k.sharpe, null);                    // three identical returns → no variance
  assert.match(k.na.sharpe, /no variance/);
});

test('kpis: Sharpe is the annualization-free mean/sd of per-trade account returns', () => {
  const closed = [winner({ day: '2026-08-03' }), stopped({ day: '2026-08-04' }), winner({ day: '2026-08-05' })];
  const k = computeKpis(closed, { cfg });
  const r = [5.625, -1.5, 5.625], m = (5.625 - 1.5 + 5.625) / 3;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / 2);
  near(k.sharpe, m / sd);
});

test('bookBeta: null with a reason until a SPY series overlaps enough days', () => {
  const closed = [winner({ day: '2026-08-03' })];
  assert.equal(bookBeta(closed, null).value, null);
  assert.match(bookBeta(closed, null).reason, /live mode only/);
  const shortSpy = [{ t: Date.parse('2026-08-03T20:00:00Z'), c: 700 }, { t: Date.parse('2026-08-04T20:00:00Z'), c: 707 }];
  assert.equal(bookBeta(closed, shortSpy).value, null);
  assert.match(bookBeta(closed, shortSpy).reason, /≥5 days/);
});

test('bookBeta: recovers a known beta from a clean series', () => {
  // strategy P&L = 2 × SPY return each day → beta 2
  const spyPct = [1, -2, 3, -1, 2, 1];
  const spy = [{ t: Date.parse('2026-08-02T20:00:00Z'), c: 100 }];
  for (let i = 0; i < spyPct.length; i++) {
    spy.push({ t: Date.parse(`2026-08-0${3 + i}T20:00:00Z`), c: spy.at(-1).c * (1 + spyPct[i] / 100) });
  }
  const closed = spyPct.map((p, i) => ({ ...trade({ day: `2026-08-0${3 + i}` }),
    sizeFrac: 1, leveredPct: 2 * p, underlyingPct: p }));
  near(bookBeta(closed, spy).value, 2, 1e-6);
});

test('dailyPnl / realizedPnl: grouped by CET day, week runs Monday to today', () => {
  const closed = [winner({ day: '2026-08-03' }), stopped({ day: '2026-08-05' }), stopped({ day: '2026-08-05' })];
  const by = dailyPnl(closed);
  near(by['2026-08-03'], 5.625);
  near(by['2026-08-05'], -3.0);
  const r = realizedPnl(closed, new Date('2026-08-05T20:00:00+02:00'));   // Wed
  near(r.today, -3.0);
  near(r.week, 2.625);                                                    // Mon +5.625, Wed −3.0
});

// ---- kill criteria (FRD 5.3, FR-D11) ----

test('kill: rules stay PENDING until their window is full, but still show the value', () => {
  const closed = Array.from({ length: 10 }, (_, i) => stopped({ day: '2026-08-03' }));
  const [hit, slip] = killCriteria(closed, cfg);
  assert.equal(hit.status, 'PENDING');
  near(hit.value, 0);
  assert.match(hit.note, /10\/30 trades/);
  assert.equal(slip.status, 'PENDING');
  assert.match(slip.note, /10\/20 stops/);
});

test('kill: hit rate below 15% over a full window triggers', () => {
  const closed = [];
  for (let i = 0; i < 27; i++) closed.push(stopped({ day: '2026-08-03' }));
  for (let i = 0; i < 3; i++) closed.push(winner({ day: '2026-08-04' }));   // 3/30 = 10%
  const [hit] = killCriteria(closed, cfg);
  assert.equal(hit.status, 'TRIGGERED');
  near(hit.value, 10);
  near(hit.distance, -5);
  const healthy = killCriteria([...Array(20).fill(stopped({})), ...Array(10).fill(winner({}))], cfg)[0];
  near(healthy.value, 100 / 3);
  assert.equal(healthy.status, 'OK');
  assert.ok(healthy.distance > 0);
});

test('kill: average stop slippage above 0.15pp over 20 stops triggers', () => {
  const bad = Array.from({ length: 20 }, () => trade({ exit: 99.04, reason: 'STOP' }));   // 0.16pp
  const [, slip] = killCriteria(bad, cfg);
  near(slip.value, 0.16, 1e-9);
  assert.equal(slip.status, 'TRIGGERED');
  assert.ok(slip.distance < 0);
  const ok = Array.from({ length: 20 }, () => trade({ exit: 99.2, reason: 'STOP' }));     // 0pp
  assert.equal(killCriteria(ok, cfg)[1].status, 'OK');
});

// FRD 5.6: two full-size stop-outs *are* the −3% day, so the boundary itself must count.
test('kill: three consecutive daily-limit days trigger, two only warn', () => {
  const heavy = day => [stopped({ day, size: 0.1875 }), stopped({ day, size: 0.1875 })];  // −3.0% that day
  const three = killCriteria([...heavy('2026-08-03'), ...heavy('2026-08-04'), ...heavy('2026-08-05')], cfg)[2];
  assert.equal(three.value, 3);
  assert.equal(three.status, 'TRIGGERED');
  const two = killCriteria([...heavy('2026-08-04'), ...heavy('2026-08-05')], cfg)[2];
  assert.equal(two.status, 'WARN');
  const broken = killCriteria([...heavy('2026-08-03'), ...heavy('2026-08-04'),
                               stopped({ day: '2026-08-05' })], cfg)[2];               // last day only −1.5%
  assert.equal(broken.value, 0);
  assert.equal(broken.status, 'OK');
});
