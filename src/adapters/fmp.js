// FMP: batch quotes (overview + regime inputs) and earnings dates. Layer 3, provenance DELAYED-OK (C4).
const BASE = 'https://financialmodelingprep.com';
export async function batchQuotes(tickers, apiKey, f = fetch) {
  const r = await f(`${BASE}/stable/batch-quote?symbols=${tickers.join(',')}&apikey=${apiKey}`);
  if (!r.ok) throw new Error(`FMP batch-quote ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  return Object.fromEntries(rows.map(q => [q.symbol, {
    price: q.price, changePct: q.changePercentage ?? q.changesPercentage,
    dayHigh: q.dayHigh, dayLow: q.dayLow, volume: q.volume,
    avgVolume: q.avgVolume, ma50: q.priceAvg50, ma200: q.priceAvg200 }]));
}
export async function nextEarnings(ticker, apiKey, f = fetch) {
  const r = await f(`${BASE}/stable/earnings?symbol=${ticker}&limit=4&apikey=${apiKey}`);
  if (!r.ok) throw new Error(`FMP earnings ${r.status}`);
  const rows = await r.json();
  const today = new Date().toISOString().slice(0, 10);
  const next = rows.map(x => x.date).filter(d => d >= today).sort()[0];
  return next ?? null;   // FRD 4.6: unknown date fails safe → caller badges the name
}
