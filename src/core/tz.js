// Cached zoned-time formatting. `Date#toLocaleString` with a timeZone constructs a fresh
// Intl.DateTimeFormat on every call, which costs ~1ms. These helpers sit on per-bar paths —
// session grouping, 5-minute slot indexing, daily P&L buckets — where a simulation makes
// hundreds of calls, so the formatters are built once per zone and reused.
// Output is the sortable 'YYYY-MM-DD HH:MM:SS' that the sv-SE locale gives.
const fmts = {};
const fmt = tz => (fmts[tz] ??= new Intl.DateTimeFormat('sv-SE', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));

export const zoned = (tMs, tz) => fmt(tz).format(tMs).replace(',', '');
export const nyStamp = tMs => zoned(tMs, 'America/New_York');
export const cetStamp = tMs => zoned(tMs, 'Europe/Berlin');
export const nyDay = tMs => nyStamp(tMs).slice(0, 10);
export const cetDay = tMs => cetStamp(tMs).slice(0, 10);

// Minutes past midnight in the zone.
export const nyMinutes = tMs => +nyStamp(tMs).slice(11, 13) * 60 + +nyStamp(tMs).slice(14, 16);
