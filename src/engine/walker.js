// Forward trade walk (FRD FR-B3/B4): what hit first — target, stop, or time stop. Conservative same-bar rule.
export function walkTrade({ entryPrice, dir, bars, targetPct, stopPct, maxBars }) {
  const tgt = dir === 'long' ? entryPrice * (1 + targetPct/100) : entryPrice * (1 - targetPct/100);
  const stp = dir === 'long' ? entryPrice * (1 - stopPct/100)   : entryPrice * (1 + stopPct/100);
  let mae = 0, mfe = 0;
  for (let i = 0; i < Math.min(bars.length, maxBars); i++) {
    const b = bars[i];
    const adverse = dir === 'long' ? (entryPrice - b.l) / entryPrice : (b.h - entryPrice) / entryPrice;
    const favor   = dir === 'long' ? (b.h - entryPrice) / entryPrice : (entryPrice - b.l) / entryPrice;
    mae = Math.max(mae, adverse * 100); mfe = Math.max(mfe, favor * 100);
    const hitT = dir === 'long' ? b.h >= tgt : b.l <= tgt;
    const hitS = dir === 'long' ? b.l <= stp : b.h >= stp;
    if (hitS) return res('STOP', stp, i, mae, mfe);            // conservative: stop wins ties (FR-B4)
    if (hitT) return res('TARGET', tgt, i, mae, mfe);
  }
  const last = bars[Math.min(bars.length, maxBars) - 1];
  return res('TIME', last.c, Math.min(bars.length, maxBars) - 1, mae, mfe);
  function res(reason, exit, barIdx, mae, mfe) {
    const pct = dir === 'long' ? (exit - entryPrice)/entryPrice*100 : (entryPrice - exit)/entryPrice*100;
    return { reason, exitPrice: exit, barIdx, underlyingPct: pct, mae, mfe };
  }
}
