// Module B point-in-time core (FRD 7.2). Pure. Reuses evaluate() and walkTrade() unchanged —
// NFR-5 forbids a second simulation code path, so nothing here re-implements a criterion.
//
// The discipline this module exists to demonstrate lives in two places:
//   1. sliceTo() — a bar is visible only once it has *closed*. Provider bars are stamped with
//      their OPEN time, so a 5-minute bar stamped 16:00 is still forming at 16:00 and using it
//      would be look-ahead. Visible means t + interval <= moment.
//   2. completedDaysBefore() — the simulation date's own daily bar contains the whole session's
//      high and low, which at 16:00 CET have not happened yet. It is excluded outright.
import { evaluate } from './signal.js';
import { walkTrade } from './walker.js';
import { runway } from './levels.js';
import { sessionState, minutesToHardClose } from '../core/session.js';
import { nyStamp, nyDay } from '../core/tz.js';

export const INTERVAL_MS = { '5min': 5 * 60000, '1h': 3600000, '1day': 86400000 };

// Bars that had closed at or before the moment.
export function sliceTo(bars, momentMs, intervalMs) {
  return (bars ?? []).filter(b => b.t + intervalMs <= momentMs);
}

// The bar the simulated entry fills on: the first one opening at or after the moment (FR-B3).
// It is by construction a bar the evaluation never saw.
export function entryBar(bars, momentMs) {
  return (bars ?? []).find(b => b.t >= momentMs) ?? null;
}


// Daily bars strictly before the simulation date — the session being simulated has not finished.
export function completedDaysBefore(daily, dateISO) {
  return (daily ?? []).filter(b => nyDay(b.t) < dateISO);
}

// Assemble the engine context from visible data only, and report what could not be evaluated.
// Unavailable inputs disable their criterion through the engine's own `enabled` mechanism, so
// they render as "off" rather than silently passing or failing (FR-B2, FR-B7).
export function simContext({ bars5m, bars1h, daily, spyDaily, vix, earningsDate, moment, name, cfg }) {
  const dateISO = nyDay(moment);
  const use5m = sliceTo(bars5m, moment, INTERVAL_MS['5min']).length >= 2;
  const resolution = use5m ? '5min' : '1h';
  const step = INTERVAL_MS[resolution];

  const hourBars = sliceTo(bars1h, moment, INTERVAL_MS['1h']);
  const visibleTrigger = sliceTo(use5m ? bars5m : bars1h, moment, step);
  // Session VWAP and the relative-volume slot are same-session concepts.
  const sessionBars = visibleTrigger.filter(b => nyDay(b.t) === dateISO);
  const priorBars = visibleTrigger.filter(b => nyDay(b.t) !== dateISO);

  const days = completedDaysBefore(daily, dateISO);
  const dailyBars = days.map(b => ({ h: b.h, l: b.l, c: b.c }));
  const spyDays = completedDaysBefore(spyDaily, dateISO);

  const notEvaluated = [];
  const enabled = { ...(cfg.enabled ?? {}) };
  if (vix == null) { enabled.G2 = false; notEvaluated.push({ id: 'G2', why: 'no VIX history on the free tier' }); }
  if (earningsDate === undefined) { enabled.E7 = false; notEvaluated.push({ id: 'E7', why: 'no earnings history for this date' }); }
  if (spyDays.length < cfg.spyMaDays) { enabled.G1 = false; notEvaluated.push({ id: 'G1', why: `needs ${cfg.spyMaDays} prior SPY closes` }); }
  if (!sessionBars.length) notEvaluated.push({ id: 'E2/E3/E8', why: 'no completed session bars before the moment' });

  const livePrice = (sessionBars.at(-1) ?? visibleTrigger.at(-1))?.c ?? null;
  const spyMa = spyDays.length >= cfg.spyMaDays
    ? spyDays.slice(-cfg.spyMaDays).reduce((s, b) => s + b.c, 0) / cfg.spyMaDays : null;

  const ctx = {
    dir: name.bias === 'long' ? 'long' : 'short',
    hourBars, fiveMinBars: sessionBars,
    slotBaseline: slotBaselineOf(priorBars),
    slotIndex: slotIndexNY(sessionBars.at(-1)?.t ?? moment) ?? 77,
    livePrice, prevDay: dailyBars.at(-1) ?? null, dailyBars,
    spyAboveMA: spyMa != null && spyDays.at(-1) ? spyDays.at(-1).c > spyMa : false,
    vix,
    minutesToTimeStop: Math.min(cfg.timeStopHours * 60, Math.max(0, minutesToHardClose(new Date(moment), cfg))),
    inEntryWindow: sessionState(new Date(moment), cfg) === 'ENTRY_OPEN',
    inBlackout: earningsDate ? inWindow(earningsDate, moment, cfg) : false,
    blackoutOverride: false,
  };
  return { ctx, cfg: { ...cfg, enabled }, resolution, notEvaluated, dateISO,
           sessionBars, hasStructure: hourBars.length >= 15 && !!livePrice && dailyBars.length >= 2 };
}

const inWindow = (earnDate, momentMs, cfg) => {
  const d = Date.parse(earnDate + 'T00:00:00Z');
  return momentMs >= d - cfg.blackoutDays.before * 86400000
      && momentMs < d + (cfg.blackoutDays.after + 1) * 86400000;
};

// 0-based 5-minute slot inside the 09:30–16:00 ET session (mirrors live.js E2 slot basis).
function slotIndexNY(tMs) {
  const s = nyStamp(tMs);
  const rel = (+s.slice(11, 13) * 60 + +s.slice(14, 16)) - (9 * 60 + 30);
  return rel >= 0 && rel < 390 ? Math.floor(rel / 5) : null;
}
function slotBaselineOf(priorBars) {
  const sum = new Array(78).fill(0), cnt = new Array(78).fill(0);
  for (const b of priorBars) {
    const s = slotIndexNY(b.t);
    if (s !== null) { sum[s] += b.v; cnt[s] += 1; }
  }
  return sum.map((v, i) => (cnt[i] ? v / cnt[i] : 0));
}

// One simulated moment, end to end (FR-B2/B3/B4/B5).
export function simulateOne({ cfg, name, data, moment }) {
  const built = simContext({ ...data, moment, name, cfg });
  if (!built.hasStructure) {
    return { ...built, state: 'NO DATA', criteria: [], qualified: false, entry: null, walk: null,
             levels: null, episode: [] };
  }
  const r = evaluate(built.cfg, built.ctx);
  const qualified = r.state === 'LONG' || r.state === 'SHORT';

  const forwardSource = built.resolution === '5min' ? data.bars5m : data.bars1h;
  const eb = entryBar(forwardSource, moment);
  if (!qualified || !eb) {
    return { ...built, state: r.state, criteria: r.criteria, qualified: false, entry: null, walk: null,
             levels: null, episode: episodeAround(forwardSource, moment, built.resolution) };
  }

  const dir = r.state.toLowerCase();
  const forward = forwardSource.filter(b => b.t >= eb.t);
  const barsPerHour = 3600000 / INTERVAL_MS[built.resolution];
  const walk = walkTrade({ entryPrice: eb.o, dir, bars: forward,
    targetPct: cfg.targetPct, stopPct: cfg.stopPct,
    maxBars: Math.max(1, Math.round(cfg.timeStopHours * barsPerHour)) });

  const rw = runway(built.ctx.livePrice, dir, built.ctx.prevDay, built.ctx.dailyBars);
  return { ...built, state: r.state, criteria: r.criteria, qualified: true,
    entry: { ts: eb.t, price: eb.o }, walk,
    levels: {
      stop: dir === 'long' ? eb.o * (1 - cfg.stopPct / 100) : eb.o * (1 + cfg.stopPct / 100),
      target: dir === 'long' ? eb.o * (1 + cfg.targetPct / 100) : eb.o * (1 - cfg.targetPct / 100),
      runway: rw.level, runwayName: rw.name, runwayPct: rw.runwayPct,
    },
    verdict: walk.reason === 'TARGET' ? 'WIN' : walk.reason === 'STOP' ? 'LOSS' : 'TIME-OUT',
    // The chart ends shortly after the verdict; bars the trade never saw are not part of the episode.
    episode: trimAfterExit(episodeAround(forwardSource, moment, built.resolution), eb.t, walk.barIdx),
  };
}

// Bars either side of the moment for the chart: the run-up for context, the outcome for the verdict.
export function episodeAround(bars, moment, resolution, before = 24, after = 72) {
  const step = INTERVAL_MS[resolution];
  const idx = (bars ?? []).findIndex(b => b.t + step > moment);
  if (idx < 0) return (bars ?? []).slice(-before);
  return bars.slice(Math.max(0, idx - before), idx + after);
}

// Cut the episode a few bars past the exit: once the verdict is decided the rest is not the trade.
export function trimAfterExit(episode, entryTs, barIdx, tail = 8) {
  const i = episode.findIndex(b => b.t >= entryTs);
  if (i < 0) return episode;
  return episode.slice(0, Math.min(episode.length, i + barIdx + 1 + tail));
}
