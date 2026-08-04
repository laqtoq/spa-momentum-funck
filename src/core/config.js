// Baseline configuration (FRD 4.7: lives once, here) + deterministic preset hashing (NFR-6).
export const BASELINE = {
  enabled: {},                        // all criteria on unless explicitly false
  rsiLong: [45, 65], rsiShort: [35, 55],
  relVolMin: 1.5, runwayPct: 3.0, feasK: 1.5,
  targetPct: 3.0, stopPct: 0.8, timeStopHours: 5,
  entryWindow: { start: '15:45', end: '18:00' },  // CET
  hardCloseCET: '21:45',
  vixCap: 30, spyMaDays: 20,
  blackoutDays: { before: 1, after: 1 },
  alertProximityPct: 0.25, alertTimeMin: 15,
  riskPerTrade: 0.015, leverage: 10, maxConcurrent: 2, maxPerDirection: 2,
  clusterSecondHalf: true, betaCap: 4.5, ddThrottle: 0.04, atrScaled: false,
};
// FNV-1a over canonical (sorted-key) JSON → 8-hex preset id, stable across sessions/machines.
export function presetHash(cfg) {
  const canon = o => o === null || typeof o !== 'object' ? JSON.stringify(o)
    : Array.isArray(o) ? `[${o.map(canon).join(',')}]`
    : `{${Object.keys(o).sort().map(k => `"${k}":${canon(o[k])}`).join(',')}}`;
  let h = 0x811c9dc5;
  for (const ch of canon(cfg)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
