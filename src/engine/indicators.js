// Pure indicator math over OHLCV arrays. No deps, no I/O. Shared by Modules A/B/C (NFR-4/5).
const wilder = (xs, n) => {
  const out = new Array(xs.length).fill(NaN);
  if (xs.length < n) return out;
  let s = xs.slice(0, n).reduce((a,b)=>a+b,0) / n;
  out[n-1] = s;
  for (let i = n; i < xs.length; i++) { s = (s*(n-1) + xs[i]) / n; out[i] = s; }
  return out;
};

export function rsi(closes, n = 14) {
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    gains.push(d > 0 ? d : 0); losses.push(d < 0 ? -d : 0);
  }
  const ag = wilder(gains, n), al = wilder(losses, n);
  return [NaN, ...ag.map((g, i) => {
    if (Number.isNaN(g)) return NaN;
    if (al[i] === 0) return 100;
    return 100 - 100 / (1 + g / al[i]);
  })];
}

export function atr(bars, n = 14) { // bars: [{h,l,c}]
  const trs = bars.map((b, i) => i === 0 ? b.h - b.l :
    Math.max(b.h - b.l, Math.abs(b.h - bars[i-1].c), Math.abs(b.l - bars[i-1].c)));
  return wilder(trs, n);
}

export function sma(xs, n) {
  const out = new Array(xs.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i-n];
    if (i >= n-1) out[i] = sum / n;
  }
  return out;
}

export function sessionVWAP(bars) { // typical-price VWAP, cumulative over session bars
  let pv = 0, vv = 0;
  return bars.map(b => { pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; return vv > 0 ? pv / vv : NaN; });
}

export function slotRelVol(vol, slotIndex, slotBaseline) {
  const base = slotBaseline[slotIndex];
  return base > 0 ? vol / base : NaN;
}
