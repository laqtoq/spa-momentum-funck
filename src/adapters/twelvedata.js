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
