// Support/resistance levels and runway (FRD 4.3 E4). Pure functions.
export function floorPivots(prevDay) { // {h,l,c}
  const p = (prevDay.h + prevDay.l + prevDay.c) / 3;
  return { P: p, R1: 2*p - prevDay.l, R2: p + (prevDay.h - prevDay.l),
           S1: 2*p - prevDay.h, S2: p - (prevDay.h - prevDay.l) };
}
export function swingExtremes(dailyBars, lookback = 10) {
  const win = dailyBars.slice(-lookback);
  return { swingHigh: Math.max(...win.map(b => b.h)), swingLow: Math.min(...win.map(b => b.l)) };
}
// Nearest level above (long) / below (short) and runway % to it.
export function runway(price, dir, prevDay, dailyBars) {
  const piv = floorPivots(prevDay), sw = swingExtremes(dailyBars);
  const cands = dir === 'long'
    ? [['prevDayHigh', prevDay.h], ['swingHigh', sw.swingHigh], ['R1', piv.R1], ['R2', piv.R2]].filter(([,v]) => v > price)
    : [['prevDayLow',  prevDay.l], ['swingLow',  sw.swingLow ], ['S1', piv.S1], ['S2', piv.S2]].filter(([,v]) => v < price);
  if (!cands.length) return { level: null, name: 'none-above' , runwayPct: Infinity }; // no level in the way
  const [name, level] = cands.reduce((a, b) => Math.abs(b[1]-price) < Math.abs(a[1]-price) ? b : a);
  return { level, name, runwayPct: Math.abs(level - price) / price * 100 };
}
