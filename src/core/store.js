// Trade journal (FRD FR-D7..D12): localStorage persistence + JSON/CSV export. Storage injectable for tests.
export function makeJournal(storage) {
  const KEY = 'mr_journal_v1';
  const load = () => JSON.parse(storage.getItem(KEY) || '{"startingEquity":null,"open":[],"closed":[]}');
  const save = j => storage.setItem(KEY, JSON.stringify(j));
  return {
    state: load,
    setStartingEquity(e) { const j = load(); j.startingEquity = e; save(j); },
    openPosition(fill) { const j = load(); j.open.push({ ...fill, id: `${fill.ticker}-${fill.entryTs}`, mae: 0, mfe: 0, edited: false }); save(j); return j.open.at(-1).id; },
    updateExcursion(id, mae, mfe) { const j = load(); const p = j.open.find(x => x.id === id); if (p) { p.mae = Math.max(p.mae, mae); p.mfe = Math.max(p.mfe, mfe); save(j); } },
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
    kpis() { const c = load().closed; const last30 = c.slice(-30);
      const wins = last30.filter(t => t.underlyingPct > 0);
      return { trades: c.length, hitRate30: last30.length ? wins.length / last30.length : null,
               profitFactor: (() => { const g = c.filter(t=>t.leveredPct>0).reduce((s,t)=>s+t.leveredPct,0); const l = -c.filter(t=>t.leveredPct<0).reduce((s,t)=>s+t.leveredPct,0); return l > 0 ? g/l : null; })(),
               avgMaeWinners: wins.length ? wins.reduce((s,t)=>s+t.mae,0)/wins.length : null }; },
    exportJSON() { return JSON.stringify(load(), null, 2); },
    exportCSV() { const c = load().closed;
      const cols = ['ticker','dir','entryTs','entryPrice','exitTs','exitPrice','exitReason','sizeFrac','underlyingPct','leveredPct','mae','mfe'];
      return [cols.join(','), ...c.map(t => cols.map(k => t[k]).join(','))].join('\n'); },
    importJSON(s) { const j = JSON.parse(s); if (!Array.isArray(j.open) || !Array.isArray(j.closed)) throw new Error('bad journal'); save(j); },
  };
}
