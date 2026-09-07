// Trade journal (FRD FR-D7..D12): localStorage persistence + JSON/CSV export. Storage injectable for tests.
import { computeKpis, killCriteria, realizedPnl } from '../engine/kpis.js';
export function makeJournal(storage) {
  const KEY = 'mr_journal_v1';
  const load = () => JSON.parse(storage.getItem(KEY) || '{"startingEquity":null,"open":[],"closed":[]}');
  const save = j => storage.setItem(KEY, JSON.stringify(j));
  return {
    state: load,
    setStartingEquity(e) { const j = load(); j.startingEquity = e; save(j); },
    openPosition(fill) { const j = load(); j.open.push({ ...fill, id: `${fill.ticker}-${fill.entryTs}`, mae: 0, mfe: 0, edited: fill.edited ?? false }); save(j); return j.open.at(-1).id; },
    updateExcursion(id, mae, mfe) { const j = load(); const p = j.open.find(x => x.id === id); if (p) { p.mae = Math.max(p.mae, mae); p.mfe = Math.max(p.mfe, mfe); save(j); } },
    // FR-D8: excursions measured across a stream gap are approximate; the flag rides with the trade.
    markApprox(id) { const j = load(); const p = j.open.find(x => x.id === id); if (p && !p.approx) { p.approx = true; save(j); } },
    updateOpen(id, patch) { const j = load(); const p = j.open.find(x => x.id === id); if (p) { Object.assign(p, patch, { edited: true }); save(j); } },
    closePosition(id, exit) { const j = load(); const i = j.open.findIndex(x => x.id === id); if (i < 0) return null;
      const p = j.open.splice(i, 1)[0]; const dirSign = p.dir === 'long' ? 1 : -1;
      const underlyingPct = dirSign * (exit.exitPrice - p.entryPrice) / p.entryPrice * 100;
      const closed = { ...p, ...exit, underlyingPct, leveredPct: underlyingPct * p.leverage };
      j.closed.push(closed); save(j); return closed; },
    equity() { const j = load(); const base = j.startingEquity ?? 0;
      const pnl = j.closed.reduce((s, t) => s + base * (t.sizeFrac ?? 0) * t.leveredPct / 100, 0);
      const eq = base + pnl;
      const hwm = j.closed.reduce((m, t, i) => { const partial = base + j.closed.slice(0, i + 1).reduce((s, x) => s + base * (x.sizeFrac ?? 0) * x.leveredPct / 100, 0); return Math.max(m, partial); }, base);
      return { equity: eq, hwm }; },
    // Measurement lives in the engine (FRD 5.5); the journal only supplies the trades.
    // hitRate30 is kept as an alias so existing callers and tests read the same number.
    kpis(cfg) { const k = computeKpis(load().closed, { cfg }); return { ...k, hitRate30: k.hitRate }; },
    killCriteria(cfg) { return killCriteria(load().closed, cfg); },
    realized(cfg, now) { return realizedPnl(load().closed, now); },
    exportJSON() { return JSON.stringify(load(), null, 2); },
    exportCSV() { const c = load().closed;
      const cols = ['ticker','dir','entryTs','entryPrice','exitTs','exitPrice','exitReason','sizeFrac','underlyingPct','leveredPct','mae','mfe'];
      return [cols.join(','), ...c.map(t => cols.map(k => t[k]).join(','))].join('\n'); },
    importJSON(s) { const j = JSON.parse(s); if (!Array.isArray(j.open) || !Array.isArray(j.closed)) throw new Error('bad journal'); save(j); },
  };
}
