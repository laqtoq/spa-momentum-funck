// Demo mode: a staged, deterministic snapshot of the desk. Keyless canned data so the app runs,
// renders, and — unlike the earlier noise generator — actually demonstrates its own states
// (ARMED / LONG / IDLE, criteria passing and failing) anywhere, at any hour, including CI.
//
// The dataset is anchored to DEMO_ASOF, a fixed moment inside the entry window, because E6 gates
// on the clock: a wall-clock demo is IDLE 21+ hours a day and every weekend. "Canned data" already
// means a captured moment; the clock is part of that capture. Every panel still carries a DEMO
// provenance label, and the engine is untouched — states here are produced by the real evaluate().
import { sessionState, minutesToHardClose } from '../core/session.js';
import { cetStamp } from '../core/tz.js';

// Tue 4 Aug 2026, 16:30 CET — inside the 15:45–18:00 entry window, US cash session open,
// and the screening date of the committed watchlist.
export const DEMO_ASOF = new Date('2026-08-04T16:30:00+02:00');

// One scripted scenario per long-bias name. The regime gate (SPY > 20-DMA) is set long-friendly,
// so the 13 short-bias names sit IDLE on G1 — that is the gate doing its job, and it is worth
// showing. rsi drives E1; shelf leaves overhead supply for E4; relvol drives E2; breakout drives E8.
const SCENARIO = {
  DELL: { rsi: 56, shelf: true,  relvol: 2.4, breakout: true },                 // LONG  — structure + trigger
  LITE: { rsi: 53, shelf: true,  relvol: 0.9, breakout: false },                // ARMED — no volume, no break
  PWR:  { rsi: 58, shelf: true,  relvol: 1.8, breakout: false },                // ARMED — volume there, no break yet
  CVNA: { rsi: 72, shelf: true,  relvol: 1.9, breakout: true },                 // IDLE  — extended, E1 out of band
  VLO:  { rsi: 55, shelf: false, relvol: 1.7, breakout: true },                 // IDLE  — E4, priced into resistance
  BSX:  { rsi: 54, shelf: true,  relvol: 1.6, breakout: true, quiet: true },    // IDLE  — E5, too quiet to reach +3%
  ETN:  { rsi: 51, shelf: false, relvol: 1.1, breakout: false },                // IDLE  — neither structure nor trigger
};
// Unscripted names (all short-bias here) get deterministic per-ticker variation, so the tape reads
// like 20 different stocks rather than 13 copies of the same drift. G1 holds them IDLE either way.
const hash = t => [...t].reduce((h, ch) => (Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0), 0x811c9dc5);
const varied = ticker => {
  const h = hash(ticker);
  return { rsi: 42 + h % 17, shelf: h % 3 === 0, relvol: 0.7 + (h >> 4) % 14 / 10, breakout: h % 5 === 0 };
};

const HOUR = 36e5, FIVE = 3e5;

// Alternating gains/losses of g and l make Wilder RSI(14) converge on 100·g/(g+l), so a target RSI
// is just a choice of g:l. `shelf` widens the second-to-last bar into a failed rally, which is what
// puts a resistance level ≥3% overhead for E4 — without it the nearest level sits ~0.6% away.
function hourly(p0, { rsi, shelf, quiet }, tEnd) {
  const k = quiet ? 0.0015 : 0.01, g = k * rsi / 100, l = k * (1 - rsi / 100);
  const wick = quiet ? [1.035, 0.998] : [1.06, 0.985];
  const body = quiet ? [1.0004, 0.9996] : [1.006, 0.994];
  const bars = [];
  let c = p0;
  for (let i = 0; i < 40; i++) {
    c *= i % 2 ? (1 - l) : (1 + g);
    const w = shelf && i === 38 ? wick : body;
    bars.push({ t: tEnd - (39 - i) * HOUR, o: c * 0.999, h: c * w[0], l: c * w[1], c, v: 1e6 });
  }
  return bars;
}

// 30 five-minute bars walking gently up into the as-of moment. The closing bar either breaks the
// prior bar's high (E8) or fades just under it, and carries the volume that decides E2.
function fiveMinute(pEnd, { relvol, breakout }, tEnd) {
  const bars = [];
  let c = pEnd * 0.988;
  for (let i = 0; i < 29; i++) {
    c *= 1.0004;
    bars.push({ t: tEnd - (30 - i) * FIVE, o: c * 0.9995, h: c * 1.0012, l: c * 0.9988, c, v: 95000 + (i % 5) * 4000 });
  }
  const prior = bars.at(-1);
  const close = breakout ? prior.h * 1.004 : prior.c * 0.999;
  bars.push({ t: tEnd - FIVE, o: prior.c, h: Math.max(close, prior.c) * 1.0002,
              l: Math.min(close, prior.c) * 0.9992, c: close, v: Math.round(90000 * relvol) });
  return bars;
}

export function demoData(watchlist) {
  const t = DEMO_ASOF.getTime();
  const quotes = {}, hourBars = {}, fiveMin = {}, baselines = {};
  for (const n of watchlist.names) {
    const s = SCENARIO[n.ticker] ?? varied(n.ticker);
    const p0 = n.close_at_screen;
    const hb = hourly(p0, s, t);
    const fm = fiveMinute(hb.at(-1).c, s, t);
    const live = Math.round(fm.at(-1).c * 100) / 100;   // snapshot prices sit on the tick, like a real quote
    hourBars[n.ticker] = hb;
    fiveMin[n.ticker] = fm;
    baselines[n.ticker] = new Array(78).fill(90000);
    quotes[n.ticker] = { price: live, live, changePct: (live / p0 - 1) * 100,
      dayHigh: Math.max(...hb.slice(-10).map(b => b.h)), dayLow: Math.min(...hb.slice(-10).map(b => b.l)),
      volume: fm.reduce((a, b) => a + b.v, 0), avgVolume: 90000 * 78,
      ma50: p0 * (n.bias === 'long' ? 0.95 : 1.05), ma200: p0 * (n.bias === 'long' ? 0.9 : 1.1) };
  }
  return { asOf: DEMO_ASOF, quotes, hourBars, fiveMin, baselines,
    spy: { price: 771, ma20: 760 }, vix: 21.4,
    riskline: { alerts: [{ title: 'Demo: elevated shipping-lane risk, Strait of Hormuz', level: 'medium' }] } };
}

// The demo-mode engine context. Lives here rather than in main.js so the staged dataset can be
// asserted through the real evaluate() in tests, with no second copy of this shape to drift.
export function demoContext(data, n, cfg, now = DEMO_ASOF) {
  const hb = data.hourBars[n.ticker], fm = data.fiveMin[n.ticker];
  const dailyBars = hb.slice(-10).map(b => ({ h: b.h, l: b.l, c: b.c }));
  return { dir: n.bias === 'long' ? 'long' : 'short', hourBars: hb, fiveMinBars: fm,
    slotBaseline: data.baselines[n.ticker], slotIndex: Math.min(77, fm.length - 1),
    livePrice: data.quotes[n.ticker].live, prevDay: dailyBars.at(-2) ?? dailyBars.at(-1), dailyBars,
    spyAboveMA: data.spy.price > data.spy.ma20, vix: data.vix,
    minutesToTimeStop: Math.min(cfg.timeStopHours * 60, Math.max(0, minutesToHardClose(now, cfg))),
    inEntryWindow: sessionState(now, cfg) === 'ENTRY_OPEN',
    inBlackout: false, blackoutOverride: false };
}

// ---- Module B demo episode (decision D9) ----
// A staged historical moment so the simulator demonstrates itself keylessly. These providers
// have the same shape as the live ones, so demo and live run the identical orchestrator and
// the identical engine — only the bytes differ.

export const DEMO_SIM = { date: '2026-07-28', timeCET: '16:00' };   // Tue, 30 min into the US session
// Outcomes staged on the canonical demo date so all three verdicts are demonstrable; other dates
// vary deterministically per (ticker, date) so a Module C batch across five dates is not five
// identical rows.
const SIM_OUTCOME = { DELL: 'win', LITE: 'both', PWR: 'flat' };
const dayShift = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function outcomeFor(ticker, dateISO) {
  if (dateISO === DEMO_SIM.date) return SIM_OUTCOME[ticker] ?? null;
  const h = hash(ticker + dateISO);
  if (h % 5 !== 0) return null;                       // most names do not set up on most days
  return ['win', 'both', 'flat'][(h >> 3) % 3];
}

function simSeries(ticker, p0, dateISO) {
  const moment = Date.parse(`${dateISO}T${DEMO_SIM.timeCET}:00Z`) - cetOffsetMin(dateISO) * 60000;
  const outcome = outcomeFor(ticker, dateISO);
  const setsUp = !!outcome;
  const b = (t, c, o, h, l, v) => ({ t, o, h, l, c, v });

  // 1h structure: RSI ≈ 55 when the name sets up, ≈ 78 (overbought, E1 fails) when it does not.
  const g = setsUp ? 0.0055 : 0.0078, l = setsUp ? 0.0045 : 0.0022;
  const bars1h = []; let c = p0;
  for (let i = 0; i < 60; i++) {
    c *= i % 2 ? (1 - l) : (1 + g);
    bars1h.push(b(moment - (60 - i) * HOUR, c, c * 0.999, c * 1.006, c * 0.994, 1e6));
  }
  // Daily: completed sessions leaving overhead supply for E4, then the simulated session's own
  // bar — which simContext must drop, since its high has not happened yet at 16:00 CET.
  const dayClose = Date.parse(dateISO + 'T20:00:00Z');
  const daily = [];
  for (let i = 25; i >= 1; i--) daily.push(b(dayClose - i * 86400000, p0 * 0.99, p0 * 0.98, p0 * 1.06, p0 * 0.96, 1e7));
  daily.push(b(dayClose, p0 * 1.25, p0, p0 * 1.4, p0 * 0.8, 1e7));

  // 5-minute: the prior session for the relative-volume baseline, then today into the moment.
  const bars5m = [];
  const sessionOpen = Date.parse(dateISO + 'T13:30:00Z');
  const prior = sessionOpen - 86400000;
  for (let i = 0; i < 78; i++) bars5m.push(b(prior + i * FIVE, p0 * 0.99, p0 * 0.99, p0 * 0.992, p0 * 0.988, 90000));
  let q = p0 * 0.994;
  for (let i = 0; sessionOpen + i * FIVE < moment - FIVE; i++) {
    q *= 1.0006;
    bars5m.push(b(sessionOpen + i * FIVE, q, q * 0.9995, q * 1.0012, q * 0.9988, 96000));
  }
  const last = bars5m.at(-1);
  const trigger = setsUp ? last.h * 1.004 : last.c * 0.998;      // break the prior 5m high, or fade
  bars5m.push(b(moment - FIVE, trigger, last.c, Math.max(trigger, last.c) * 1.0005,
    Math.min(trigger, last.c) * 0.9995, setsUp ? 230000 : 70000));

  // Forward bars — the outcome the walk discovers.
  const e = bars5m.at(-1).c;
  for (let i = 0; i < 90; i++) {
    const t = moment + i * FIVE;
    if (outcome === 'win' && i === 6)       bars5m.push(b(t, e * 1.035, e, e * 1.041, e * 0.9995, 150000));
    else if (outcome === 'both' && i === 4) bars5m.push(b(t, e * 1.02,  e, e * 1.041, e * 0.985,  180000));
    else                                     bars5m.push(b(t, e, e, e * 1.0008, e * 0.9992, 120000));
  }
  return { bars5m, bars1h, daily };
}

// Europe/Berlin offset on a date, so the demo moment lands at 16:00 CET year-round.
function cetOffsetMin(dateISO) {
  const probe = Date.parse(dateISO + 'T12:00:00Z');
  return (Date.parse(cetStamp(probe).replace(' ', 'T') + 'Z') - probe) / 60000;
}

export function demoSimProviders(watchlist) {
  const priceOf = t => watchlist.names.find(n => n.ticker === t)?.close_at_screen ?? 100;
  const cache = {};
  // RANGE_AFTER_DAYS mirrors sim.js: the orchestrator asks for bars a few days past the
  // simulated date, so the date under test is end_date minus that pad.
  const AFTER = 6;
  return {
    tdBars: async (sym, interval, size, range) => {
      if (sym === 'SPY') {
        const end = range?.end_date ?? DEMO_SIM.date;
        const out = [];
        for (let i = 40; i >= 1; i--)                            // rising, so G1 lets longs through
          out.push({ t: Date.parse(end + 'T20:00:00Z') - i * 86400000, o: 700, h: 705, l: 695,
                     c: 700 + (40 - i) * 0.6, v: 1e8 });
        return out;
      }
      const dateISO = range?.end_date ? dayShift(range.end_date, -AFTER) : DEMO_SIM.date;
      const s = (cache[`${sym}|${dateISO}`] ??= simSeries(sym, priceOf(sym), dateISO));
      return interval === '5min' ? s.bars5m : interval === '1h' ? s.bars1h : s.daily;
    },
    vixAt: async () => 19.8,
    earningsAt: async () => null,       // known-empty window, so E7 is evaluated rather than skipped
  };
}
