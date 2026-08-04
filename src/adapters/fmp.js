// FMP — REGIME INPUTS ONLY since FRD v1.6. Free tier for post-Aug-2025 keys is
// symbol-restricted (C9): SPY and ^VIX are served, most watchlist names 402.
// Watchlist quotes moved to Twelve Data; earnings moved to Finnhub REST.
const BASE = 'https://financialmodelingprep.com';
async function quote(symbol, apiKey, f) {
  const r = await f(`${BASE}/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`);
  if (!r.ok) throw new Error(`FMP quote ${symbol} ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const [q] = await r.json();
  return { price: q.price, changePct: q.changePercentage, ma50: q.priceAvg50, ma200: q.priceAvg200 };
}
export async function regimeQuotes(apiKey, f = fetch) {
  const [spy, vix] = await Promise.all([quote('SPY', apiKey, f), quote('^VIX', apiKey, f)]);
  return { spy, vix: vix.price };
}
