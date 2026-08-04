// Finnhub REST earnings calendar (FR-A7 since FRD v1.6). Browser CORS verified 2026-08-04
// — the FRD v1.5 "REST CORS unreliable" assumption was wrong for this endpoint.
// The Finnhub WS is no longer used (free tier symbol-restricted, C9).
// Queried PER SYMBOL: the bulk calendar caps responses at 1500 rows keeping the rows
// nearest `to`, which silently drops near-term dates (verified 2026-08-04). 20 small
// calls sit well inside the 60/min REST budget.
const BASE = 'https://finnhub.io/api/v1';
export async function nextEarningsMap(tickers, apiKey, f = fetch, today = new Date()) {
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 120 * 86400000).toISOString().slice(0, 10);
  const one = async ticker => {
    const r = await f(`${BASE}/calendar/earnings?from=${from}&to=${to}&symbol=${ticker}&token=${apiKey}`);
    if (!r.ok) throw new Error(`Finnhub earnings ${ticker} ${r.status}: ${(await r.text()).slice(0, 140)}`);
    const rows = (await r.json()).earningsCalendar ?? [];
    const next = rows.map(x => x.date).filter(d => d >= from).sort()[0];
    return [ticker, next ?? null];   // FRD 4.6: unknown fails safe → badge
  };
  return Object.fromEntries(await Promise.all(tickers.map(one)));
}
