// Signal evaluation (FRD 4.2/4.3): gates + structure + trigger under a config object. One code path for A/B/C (NFR-5).
import { rsi, atr, sessionVWAP, slotRelVol } from './indicators.js';
import { runway } from './levels.js';

export function evaluate(cfg, ctx) {
  // ctx: {dir, hourBars, fiveMinBars, slotBaseline, slotIndex, livePrice, prevDay, dailyBars,
  //       spyAboveMA, vix, minutesToTimeStop, inEntryWindow, inBlackout, blackoutOverride}
  const crit = []; const on = k => cfg.enabled[k] !== false;
  const add = (id, pass, value, detail) => crit.push({ id, enabled: on(id), pass: on(id) ? pass : null, value, detail });

  // Gates
  const gLong = ctx.spyAboveMA, gShort = !ctx.spyAboveMA;
  add('G1', ctx.dir === 'long' ? gLong : gShort, ctx.spyAboveMA, 'SPY vs 20-DMA');
  add('G2', ctx.vix < cfg.vixCap, ctx.vix, `VIX < ${cfg.vixCap}`);

  // Structure (1h)
  const r = rsi(ctx.hourBars.map(b => b.c), 14).at(-1);
  const band = ctx.dir === 'long' ? cfg.rsiLong : cfg.rsiShort;
  add('E1', r >= band[0] && r <= band[1], r, `RSI in [${band}]`);
  const rw = runway(ctx.livePrice, ctx.dir, ctx.prevDay, ctx.dailyBars);
  add('E4', rw.runwayPct >= cfg.runwayPct, rw.runwayPct, `to ${rw.name}`);
  const atrPct = atr(ctx.hourBars, 14).at(-1) / ctx.hourBars.at(-1).c * 100;
  const feasible = cfg.targetPct <= cfg.feasK * atrPct * (ctx.minutesToTimeStop / 60);
  add('E5', feasible, atrPct, 'ATR-hrs feasibility');

  // Trigger (5m + live)
  const rv = slotRelVol(ctx.fiveMinBars.at(-1).v, ctx.slotIndex, ctx.slotBaseline);
  add('E2', rv >= cfg.relVolMin, rv, `relVol >= ${cfg.relVolMin}`);
  const vw = sessionVWAP(ctx.fiveMinBars).at(-1);
  add('E3', ctx.dir === 'long' ? ctx.livePrice > vw : ctx.livePrice < vw, vw, 'VWAP side');
  const prior = ctx.fiveMinBars.at(-2);
  add('E8', ctx.dir === 'long' ? ctx.livePrice > prior.h : ctx.livePrice < prior.l,
      ctx.dir === 'long' ? prior.h : prior.l, 'break prior 5m extreme');

  // Context
  add('E6', ctx.inEntryWindow, ctx.inEntryWindow, 'entry window');
  add('E7', !ctx.inBlackout || ctx.blackoutOverride === true, ctx.inBlackout, 'event blackout');

  const enabled = crit.filter(c => c.enabled);
  const gates = enabled.filter(c => c.id.startsWith('G')).every(c => c.pass);
  const structure = enabled.filter(c => ['E1','E4','E5'].includes(c.id)).every(c => c.pass);
  const trigger = enabled.filter(c => ['E2','E3','E8'].includes(c.id)).every(c => c.pass);
  const context = enabled.filter(c => ['E6','E7'].includes(c.id)).every(c => c.pass);
  const state = !gates || !context ? 'IDLE'
    : structure && trigger ? (ctx.dir === 'long' ? 'LONG' : 'SHORT')
    : structure ? 'ARMED' : 'IDLE';
  return { state, criteria: crit };
}
