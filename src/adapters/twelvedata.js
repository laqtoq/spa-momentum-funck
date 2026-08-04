// Twelve Data: structure/trigger bars + simulator history. Layer 2 (C3 budget via queue).
const BASE = 'https://api.twelvedata.com';
const toBars = js => (js.values ?? []).map(v => ({ t: Date.parse(v.datetime + 'Z'),
  o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume ?? 0) })).reverse();
export async function bars(symbol, interval, outputsize, apiKey, f = fetch, range = {}) {
  const qs = new URLSearchParams({ symbol, interval, outputsize, apikey: apiKey, timezone: 'UTC', ...range });
  const r = await f(`${BASE}/time_series?${qs}`);
  const js = await r.json();
  if (js.status === 'error') throw new Error(`TwelveData: ${js.message}`);
  return toBars(js);
}
// Overview quotes since FRD v1.6 (FMP free tier can't serve watchlist names, C9).
// Callers chunk to ≤8 symbols per call via the FR-A5 queue: 1 credit per symbol, 8/min.
export async function quotes(symbols, apiKey, f = fetch) {
  const r = await f(`${BASE}/quote?symbol=${symbols.join(',')}&apikey=${apiKey}`);
  const js = await r.json();
  if (js.status === 'error') throw new Error(`TwelveData: ${js.message}`);
  const rows = symbols.length === 1 ? { [symbols[0]]: js } : js;
  return Object.fromEntries(symbols.map(s => {
    const q = rows[s];
    if (!q || q.status === 'error') return [s, null];
    return [s, { price: +q.close, changePct: +q.percent_change, volume: +(q.volume ?? 0), avgVolume: +(q.average_volume ?? 0) }];
  }));
}
