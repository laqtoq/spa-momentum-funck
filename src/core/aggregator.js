// Trades → deterministic 1m/5m bars + running session VWAP (FR-A15, NFR-7: keyed to exchange ts).
export function makeAggregator() {
  const bars = { 1: new Map(), 5: new Map() };   // minuteKey -> bar
  let pv = 0, vv = 0;
  const key = (ts, m) => Math.floor(ts / (m * 60000)) * m * 60000;
  function addTrade({ p, v, t }) {
    for (const m of [1, 5]) {
      const k = key(t, m); const b = bars[m].get(k);
      if (!b) bars[m].set(k, { t: k, o: p, h: p, l: p, c: p, v });
      else { b.h = Math.max(b.h, p); b.l = Math.min(b.l, p); b.v += v; if (t >= b.lastT || b.lastT === undefined) { b.c = p; b.lastT = t; } }
      const cur = bars[m].get(k); if (cur.lastT === undefined) cur.lastT = t;
    }
    pv += p * v; vv += v;
  }
  const list = m => [...bars[m].values()].sort((a, b) => a.t - b.t);
  return { addTrade, bars1m: () => list(1), bars5m: () => list(5),
           vwap: () => vv > 0 ? pv / vv : NaN,
           seed: (pvSum, vSum) => { pv = pvSum; vv = vSum; } };  // FR-A17 re-seed after backfill
}
