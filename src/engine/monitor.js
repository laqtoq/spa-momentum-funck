// Position monitor math (FRD 4.5, FR-A16 / FR-D8). Pure over (position, live price, now, cfg)
// so Module A and a Module B replay share one code path (NFR-5). No DOM, no I/O, no clock of its own.
import { minutesToHardClose } from '../core/session.js';

const sign = dir => (dir === 'long' ? 1 : -1);

// Broker-recorded levels win when present (FR-D7: the record of truth is the fill, not the app);
// otherwise derive from the baseline stop/target.
export function stopPrice(pos, cfg) {
  return pos.stop ?? pos.entryPrice * (1 - sign(pos.dir) * cfg.stopPct / 100);
}
export function targetPrice(pos, cfg) {
  return pos.target ?? pos.entryPrice * (1 + sign(pos.dir) * cfg.targetPct / 100);
}

// Adverse / favorable excursion of one price, as positive magnitudes in underlying %
// (matches the accumulate-by-Math.max contract of store.updateExcursion).
export function excursion(pos, price) {
  const movePct = sign(pos.dir) * (price - pos.entryPrice) / pos.entryPrice * 100;
  return { mae: Math.max(0, -movePct), mfe: Math.max(0, movePct) };
}

// Minutes → "2h05". Rounds to whole minutes *before* splitting, so 179.5 reads 3h00, never 2h60.
// Only a negative value is "over": zero is a freshly opened position, not an expired limit.
export function fmtDuration(minutes) {
  if (minutes < 0) return 'over';
  const t = Math.round(minutes);
  return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}`;
}

export function monitorPosition(pos, livePrice, now, cfg) {
  const lev = pos.leverage ?? cfg.leverage;
  const stop = stopPrice(pos, cfg), target = targetPrice(pos, cfg);

  // Distance still to travel from *here*, as % of the current price. At entry this is exactly
  // the baseline stop/target distance (0.8pp / 3.0pp), and it shrinks as price approaches.
  const toStopPct = Math.abs(livePrice - stop) / livePrice * 100;
  const toTargetPct = Math.abs(livePrice - target) / livePrice * 100;

  // Open P&L is measured from the entry fill, not from here.
  const openPnlPct = sign(pos.dir) * (livePrice - pos.entryPrice) / pos.entryPrice * 100;

  const minutesElapsed = (now.getTime() - Date.parse(pos.entryTs)) / 60000;
  const toTimeStop = cfg.timeStopHours * 60 - minutesElapsed;
  const toHardClose = minutesToHardClose(now, cfg);
  const binding = toTimeStop <= toHardClose ? 'TIME_STOP' : 'HARD_CLOSE';
  const minutesToLimit = Math.min(toTimeStop, toHardClose);

  // Price has already traded through the level — the operator is past warning and into acting.
  const throughStop = sign(pos.dir) * (livePrice - stop) <= 0;
  const throughTarget = sign(pos.dir) * (livePrice - target) >= 0;

  return {
    stop, target, toStopPct, toTargetPct,
    toStopLevered: toStopPct * lev, toTargetLevered: toTargetPct * lev,
    openPnlPct, openPnlLevered: openPnlPct * lev,
    minutesElapsed, minutesToTimeStop: toTimeStop, minutesToHardClose: toHardClose,
    binding, minutesToLimit, throughStop, throughTarget,
    alerts: {
      stop: throughStop || toStopPct <= cfg.alertProximityPct,
      target: throughTarget || toTargetPct <= cfg.alertProximityPct,
      time: minutesToLimit <= cfg.alertTimeMin,
    },
  };
}
