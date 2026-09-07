// Strategy monitoring KPIs (FRD 5.5) and kill criteria (FRD 5.3), computed from closed journal
// trades. Pure — the journal stores, this measures. A metric the journal cannot yet support
// returns null with a stated reason; it never returns 0, because 0 is a claim and null is not.

import { cetDay as cetDayOf } from '../core/tz.js';

// Per-trade account return in % of equity: the series that actually moves the book.
const ret = t => (t.sizeFrac ?? 0) * (t.leveredPct ?? 0);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const cetDay = ts => cetDayOf(new Date(ts).getTime());
const isWeekday = day => { const d = new Date(day + 'T12:00:00Z').getUTCDay(); return d !== 0 && d !== 6; };

// Adverse distance beyond the recorded stop, in percentage points of the entry price.
// Positive means the fill was worse than the stop — the number FRD 5.3 puts a kill line on.
export function stopSlippagePp(t) {
  if (t.exitReason !== 'STOP' || !t.stop || !t.entryPrice) return null;
  const dirSign = t.dir === 'long' ? 1 : -1;
  return dirSign * (t.stop - t.exitPrice) / t.entryPrice * 100;
}

// Realized P&L in % of equity, grouped by CET session day.
export function dailyPnl(closed) {
  const by = {};
  for (const t of closed) {
    if (!t.exitTs) continue;
    const d = cetDay(t.exitTs);
    by[d] = (by[d] ?? 0) + ret(t);
  }
  return by;
}

// Today's and the current CET week's realized P&L, for the FRD 5.2 gauges.
export function realizedPnl(closed, now = new Date()) {
  const by = dailyPnl(closed);
  const today = cetDay(now);
  const dow = new Date(today + 'T12:00:00Z').getUTCDay();
  const monday = new Date(Date.parse(today + 'T12:00:00Z') - ((dow + 6) % 7) * 86400000)
    .toISOString().slice(0, 10);
  let week = 0;
  for (const [d, v] of Object.entries(by)) if (d >= monday && d <= today) week += v;
  return { today: by[today] ?? 0, week };
}

export function computeKpis(closed = [], opts = {}) {
  const cfg = opts.cfg ?? {};
  const window = cfg.killHitRateWindow ?? 30;
  const slipWindow = cfg.killSlippageWindow ?? 20;
  const na = {};
  const n = closed.length;
  if (!n) {
    return { trades: 0, hitRate: null, profitFactor: null, expectancy: null, avgWin: null, avgLoss: null,
      avgMaeWinners: null, avgMfeLosers: null, stopSlippagePp: null, stopCount: 0,
      timeInTrade: null, exposure: null, sharpe: null, bookBeta: null,
      na: { all: 'no closed trades yet' } };
  }

  const last = closed.slice(-window);
  const winners = closed.filter(t => t.underlyingPct > 0);
  const losers = closed.filter(t => t.underlyingPct <= 0);
  const hitRate = last.filter(t => t.underlyingPct > 0).length / last.length;

  const rets = closed.map(ret);
  const wins = rets.filter(r => r > 0), losses = rets.filter(r => r < 0);
  const grossWin = wins.reduce((s, x) => s + x, 0), grossLoss = -losses.reduce((s, x) => s + x, 0);
  const avgWin = mean(wins), avgLoss = losses.length ? -mean(losses) : null;
  if (!losses.length) na.profitFactor = 'no losing trade yet';

  // FRD 5.5 formula, computed literally rather than as mean(r) so the parts are displayable.
  const expectancy = avgWin != null || avgLoss != null
    ? hitRate * (avgWin ?? 0) - (1 - hitRate) * (avgLoss ?? 0) : null;

  const maeW = winners.map(t => t.mae).filter(v => v != null);
  const mfeL = losers.map(t => t.mfe).filter(v => v != null);
  if (!maeW.length) na.avgMaeWinners = 'no winning trade yet';
  if (!mfeL.length) na.avgMfeLosers = 'no losing trade yet';

  const slips = closed.map(stopSlippagePp).filter(v => v != null).slice(-slipWindow);
  if (!slips.length) na.stopSlippagePp = 'no stopped-out trade yet';

  const holds = closed.filter(t => t.entryTs && t.exitTs)
    .map(t => (Date.parse(t.exitTs) - Date.parse(t.entryTs)) / 60000).sort((a, b) => a - b);
  const timeInTrade = holds.length
    ? { medianMin: holds[Math.floor(holds.length / 2)], meanMin: mean(holds), maxMin: holds.at(-1), n: holds.length }
    : null;

  // Exposure: weekday sessions on which a position was open, over the sessions the desk has run.
  const activeDays = new Set(), spanned = new Set();
  let lo = null, hi = null;
  for (const t of closed) {
    if (!t.entryTs || !t.exitTs) continue;
    for (let d = Date.parse(cetDay(t.entryTs) + 'T12:00:00Z'); d <= Date.parse(cetDay(t.exitTs) + 'T12:00:00Z'); d += 86400000) {
      const day = new Date(d).toISOString().slice(0, 10);
      if (isWeekday(day)) activeDays.add(day);
    }
    lo = lo == null ? cetDay(t.entryTs) : (cetDay(t.entryTs) < lo ? cetDay(t.entryTs) : lo);
    hi = hi == null ? cetDay(t.exitTs) : (cetDay(t.exitTs) > hi ? cetDay(t.exitTs) : hi);
  }
  if (lo && hi) for (let d = Date.parse(lo + 'T12:00:00Z'); d <= Date.parse(hi + 'T12:00:00Z'); d += 86400000) {
    const day = new Date(d).toISOString().slice(0, 10);
    if (isWeekday(day)) spanned.add(day);
  }
  const exposure = spanned.size ? { activeDays: activeDays.size, sessionDays: spanned.size, pct: activeDays.size / spanned.size } : null;

  // Annualization-free Sharpe on the last `window` per-trade returns (FRD 5.5).
  const sr = rets.slice(-window);
  let sharpe = null;
  if (sr.length < 2) na.sharpe = `needs ≥2 closed trades (have ${sr.length})`;
  else {
    const m = mean(sr);
    const sd = Math.sqrt(sr.reduce((s, x) => s + (x - m) ** 2, 0) / (sr.length - 1));
    if (sd === 0) na.sharpe = 'no variance in the return series yet';
    else sharpe = m / sd;
  }

  const bb = bookBeta(closed, opts.spyDaily);
  if (bb.value == null) na.bookBeta = bb.reason;

  return { trades: n, hitRate, hitRateWindow: last.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy, avgWin, avgLoss,
    avgMaeWinners: mean(maeW), avgMfeLosers: mean(mfeL),
    stopSlippagePp: mean(slips), stopCount: slips.length,
    timeInTrade, exposure, sharpe, bookBeta: bb.value, na };
}

// Beta of daily strategy P&L vs SPY daily returns (FRD 5.5). Needs a SPY series, which exists
// only in live mode — where it is absent, say so rather than reporting a number.
export function bookBeta(closed, spyDaily, minDays = 5) {
  if (!spyDaily?.length) return { value: null, reason: 'needs a SPY daily series — live mode only' };
  const pnl = dailyPnl(closed);
  const spyRet = {};
  for (let i = 1; i < spyDaily.length; i++) {
    const prev = spyDaily[i - 1].c, cur = spyDaily[i].c;
    if (prev > 0) spyRet[cetDay(spyDaily[i].t)] = (cur - prev) / prev * 100;
  }
  const days = Object.keys(pnl).filter(d => d in spyRet);
  if (days.length < minDays) return { value: null, reason: `needs ≥${minDays} days overlapping SPY (have ${days.length})` };
  const x = days.map(d => spyRet[d]), y = days.map(d => pnl[d]);
  const mx = mean(x), my = mean(y);
  const varX = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  if (varX === 0) return { value: null, reason: 'SPY had no variance over the window' };
  const cov = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  return { value: cov / varX, reason: null };
}

// The three FRD 5.3 rules, each with its live distance to the line (FR-D11).
export function killCriteria(closed = [], cfg = {}) {
  const k = computeKpis(closed, { cfg });
  const hitWindow = cfg.killHitRateWindow ?? 30;
  const slipWindow = cfg.killSlippageWindow ?? 20;
  const hitLine = (cfg.killHitRate ?? 0.15) * 100;
  const slipLine = cfg.killSlippagePp ?? 0.15;
  const dayLine = cfg.killConsecutiveDailyLimits ?? 3;

  // Consecutive most-recent session days that hit the daily loss limit.
  const by = dailyPnl(closed);
  const days = Object.keys(by).sort();
  // FRD 5.6: the −3% day is exactly two full-size stop-outs, so the limit is reached *at* the
  // boundary. Compare with a tolerance — accumulated float error must not excuse a limit hit.
  const dayLimit = cfg.dailyLossLimitPct ?? 3;
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (by[days[i]] <= -dayLimit + 1e-9) streak += 1; else break;
  }

  const hitVal = k.hitRate == null ? null : k.hitRate * 100;
  return [
    { id: 'hitRate', label: `Rolling-${hitWindow} hit rate`, value: hitVal, threshold: hitLine, unit: '%',
      distance: hitVal == null ? null : hitVal - hitLine, higherIsSafer: true,
      status: k.trades < hitWindow ? 'PENDING' : hitVal < hitLine ? 'TRIGGERED' : hitVal < hitLine + 5 ? 'WARN' : 'OK',
      note: k.trades < hitWindow ? `${k.trades}/${hitWindow} trades — value shown is the partial window` : `breakeven is ≈21%` },
    { id: 'slippage', label: `Avg stop slippage (last ${slipWindow})`, value: k.stopSlippagePp, threshold: slipLine, unit: 'pp',
      distance: k.stopSlippagePp == null ? null : slipLine - k.stopSlippagePp, higherIsSafer: false,
      status: k.stopCount < slipWindow ? 'PENDING'
        : k.stopSlippagePp > slipLine ? 'TRIGGERED' : k.stopSlippagePp > slipLine * 0.8 ? 'WARN' : 'OK',
      note: k.stopCount < slipWindow ? `${k.stopCount}/${slipWindow} stops recorded` : 'at 0.15pp breakeven moves to ≈24%' },
    { id: 'dailyLimits', label: 'Consecutive daily-limit hits', value: streak, threshold: dayLine, unit: '',
      distance: dayLine - streak, higherIsSafer: false,
      status: streak >= dayLine ? 'TRIGGERED' : streak === dayLine - 1 ? 'WARN' : 'OK',
      note: `a day counts at −${cfg.dailyLossLimitPct ?? 3}% realized` },
  ];
}
