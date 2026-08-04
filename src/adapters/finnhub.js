// Finnhub REST earnings calendar (FR-A7 since FRD v1.6). Browser CORS verified 2026-08-04
// — the FRD v1.5 "REST CORS unreliable" assumption was wrong for this endpoint.
// The Finnhub WS is no longer used (free tier symbol-restricted, C9).
const BASE = 'https://finnhub.io/api/v1';
export async function nextEarningsMap(tickers, apiKey, f = fetch, today = new Date()) {
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 120 * 86400000).toISOString().slice(0, 10);
  const r = await f(`${BASE}/calendar/earnings?from=${from}&to=${to}&token=${apiKey}`);
  if (!r.ok) throw new Error(`Finnhub earnings ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const rows = (await r.json()).earningsCalendar ?? [];
  const map = Object.fromEntries(tickers.map(t => [t, null]));   // FRD 4.6: unknown fails safe → badge
  for (const row of rows) if (row.symbol in map && row.date >= from)
    if (map[row.symbol] === null || row.date < map[row.symbol]) map[row.symbol] = row.date;
  return map;
}
