// Module B orchestration (FR-B1/B2/B6). Every provider call is an injected dep, so the whole
// data plane is testable with fakes — the same shape live.js uses. The engine work happens in
// src/engine/simulate.js; nothing here evaluates a criterion.
import { simulateOne } from '../engine/simulate.js';
import { presetHash } from './config.js';
import { cetStamp } from './tz.js';

// CET wall-clock → epoch ms, honouring the summer/winter offset on that date without a tz library.
export function cetOffsetMinutes(dateISO) {
  const probe = new Date(dateISO + 'T12:00:00Z');
  const local = Date.parse(cetStamp(probe.getTime()).replace(' ', 'T') + 'Z');
  return (local - probe.getTime()) / 60000;
}
export function momentFromCET(dateISO, hhmm) {
  return Date.parse(`${dateISO}T${hhmm}:00Z`) - cetOffsetMinutes(dateISO) * 60000;
}

const shift = (dateISO, days) => new Date(Date.parse(dateISO + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
// 30 trading days back and 2 forward, in calendar days with slack for weekends and holidays.
export const RANGE_BEFORE_DAYS = 46, RANGE_AFTER_DAYS = 6;

// Shared across a scan: SPY dailies are the same for every name on a given date.
export async function fetchSpyDaily({ date, cfg }, deps) {
  const { queue, tdBars } = deps;
  const { value } = await queue.schedule(`sim:spy:${date}`, 86400e3,
    () => tdBars('SPY', '1day', 5000, { start_date: shift(date, -RANGE_BEFORE_DAYS), end_date: date }));
  return value;
}

// One (date, time, ticker, preset) simulation. Returns a result even when providers fail —
// the failure is carried on the result, never swallowed into a silent pass (FR-B7).
export async function runSimulation({ date, timeCET, ticker, cfg, watchlist, spyDaily }, deps) {
  const { queue, tdBars, vixAt, earningsAt } = deps;
  const name = watchlist.names.find(n => n.ticker === ticker);
  const moment = momentFromCET(date, timeCET);
  const range = { start_date: shift(date, -RANGE_BEFORE_DAYS), end_date: shift(date, RANGE_AFTER_DAYS) };
  const stamp = { ticker, date, timeCET, presetHash: presetHash(cfg), provider: 'Twelve Data' };
  if (!name) return { ...stamp, state: 'NO DATA', qualified: false, criteria: [], errors: { name: `${ticker} is not on the watchlist` } };

  const errors = {};
  const get = async (key, ttl, fn, fallback) => {
    try { const { value } = await queue.schedule(key, ttl, fn); return value; }
    catch (e) { errors[key.split(':')[1]] = String(e.message ?? e); return fallback; }
  };

  const bars5m = await get(`sim:5m:${ticker}:${date}`, 86400e3, () => tdBars(ticker, '5min', 5000, range), []);
  const bars1h = await get(`sim:1h:${ticker}:${date}`, 86400e3, () => tdBars(ticker, '1h', 5000, range), []);
  const daily = await get(`sim:1d:${ticker}:${date}`, 86400e3, () => tdBars(ticker, '1day', 5000, range), []);
  const spy = spyDaily ?? await fetchSpyDaily({ date, cfg }, deps).catch(e => { errors.spy = String(e.message ?? e); return []; });

  // Unavailable → null (VIX) / undefined (earnings): simContext disables the criterion and says so.
  let vix = null, earningsDate;
  try { vix = vixAt ? await vixAt(date) : null; } catch (e) { errors.vix = String(e.message ?? e); }
  try { earningsDate = earningsAt ? await earningsAt(ticker, date) : undefined; }
  catch (e) { errors.earnings = String(e.message ?? e); earningsDate = undefined; }

  const result = simulateOne({ cfg, name, moment,
    data: { bars5m, bars1h, daily, spyDaily: spy, vix, earningsDate } });
  return { ...stamp, ...result, moment, errors };
}

// Scan mode (FR-B6): the whole watchlist through the FR-A5 queue, with progress and a cancel
// that actually stops further fetching rather than just hiding the results.
export function runScan({ date, timeCET, cfg, watchlist }, deps, onProgress = () => {}) {
  let cancelled = false;
  const total = watchlist.names.length;
  const promise = (async () => {
    const results = [];
    let spyDaily = null;
    try { spyDaily = await fetchSpyDaily({ date, cfg }, deps); } catch { /* per-name errors will say so */ }
    for (const n of watchlist.names) {
      if (cancelled) break;
      let r;
      try { r = await runSimulation({ date, timeCET, ticker: n.ticker, cfg, watchlist, spyDaily }, deps); }
      catch (e) { r = { ticker: n.ticker, date, timeCET, presetHash: presetHash(cfg), state: 'ERROR',
                        qualified: false, criteria: [], errors: { run: String(e.message ?? e) } }; }
      results.push(r);
      onProgress({ done: results.length, total, cancelled, last: r });
    }
    return { results, cancelled, total };
  })();
  return { promise, cancel: () => { cancelled = true; } };
}
