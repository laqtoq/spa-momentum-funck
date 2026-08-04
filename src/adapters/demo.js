// Demo mode: keyless canned data so the app runs, renders, and is reviewable anywhere (incl. CI).
const seeded = s => () => (s = Math.imul(48271, s) % 2147483647) / 2147483647;
export function demoData(watchlist) {
  const rnd = seeded(42);
  const quotes = {}, hourBars = {}, fiveMin = {}, baselines = {};
  for (const n of watchlist.names) {
    const p0 = n.close_at_screen;
    quotes[n.ticker] = { price: p0 * (1 + (rnd() - 0.5) * 0.04), changePct: (rnd() - 0.45) * 5,
      dayHigh: p0 * 1.03, dayLow: p0 * 0.97, volume: 5e6 * rnd() + 1e6, avgVolume: 4e6,
      ma50: p0 * (n.bias === 'long' ? 0.95 : 1.05), ma200: p0 * (n.bias === 'long' ? 0.9 : 1.1) };
    let px = p0; const hb = [];
    for (let i = 0; i < 40; i++) { px *= 1 + (rnd() - (n.bias === 'long' ? 0.45 : 0.55)) * 0.02;
      hb.push({ t: Date.now() - (40 - i) * 36e5, o: px * 0.999, h: px * 1.006, l: px * 0.994, c: px, v: 1e6 }); }
    hourBars[n.ticker] = hb;
    const fm = []; let q = px;
    for (let i = 0; i < 30; i++) { q *= 1 + (rnd() - 0.48) * 0.004;
      fm.push({ t: Date.now() - (30 - i) * 3e5, o: q * 0.9995, h: q * 1.001, l: q * 0.999, c: q, v: 120000 * (0.8 + rnd() * 0.6) }); }
    fiveMin[n.ticker] = fm;
    baselines[n.ticker] = new Array(78).fill(90000);
    quotes[n.ticker].live = q;
  }
  return { quotes, hourBars, fiveMin, baselines,
    spy: { price: 771, ma20: 760 }, vix: 21.4,
    riskline: { alerts: [{ title: 'Demo: elevated shipping-lane risk, Strait of Hormuz', level: 'medium' }] } };
}
