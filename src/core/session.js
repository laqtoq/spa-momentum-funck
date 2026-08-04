// Session-window state in CET (FRD E6, FR-A13). Pure over a Date.
const cetParts = d => { const s = d.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }); return { hm: s.slice(11,16), dow: new Date(s.slice(0,10)).getUTCDay() }; };
export function sessionState(now, cfg) {
  const { hm, dow } = cetParts(now);
  if (dow === 0 || dow === 6) return 'CLOSED';
  if (hm < '15:30') return 'PRE_MARKET';
  if (hm >= cfg.entryWindow.start && hm < cfg.entryWindow.end) return 'ENTRY_OPEN';
  if (hm < '22:00') return 'ENTRIES_CLOSED';
  return 'CLOSED';
}
export function minutesToHardClose(now, cfg) {
  const { hm } = cetParts(now);
  const [h1,m1] = hm.split(':').map(Number), [h2,m2] = cfg.hardCloseCET.split(':').map(Number);
  return (h2*60+m2) - (h1*60+m1);
}
