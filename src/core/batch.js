// Module C batch runner + aggregation (FR-C5/C6/C7/C9). Runs Module B's scan across
// (date × preset) combinations; it never evaluates a criterion itself.
//
// Two governance rules are enforced here rather than trusted to the operator:
//   - a validation run LOCKS each preset before its first date (FRD 4.7 §3), so results can
//     never be attributed to a configuration that changed afterwards;
//   - tuning and validation outcomes are aggregated under separate keys and never merged.
import { runScan } from './sim.js';
import { presetHash } from './config.js';
import { overBudget } from './presets.js';
import { computeKpis } from '../engine/kpis.js';
import { allocate } from '../engine/sizing.js';
import { INTERVAL_MS } from '../engine/simulate.js';

export const LABELS = ['tuning', 'validation'];

export function runBatch({ dates, presets, label = 'tuning', timeCET = '16:00', watchlist },
                         deps, onProgress = () => {}) {
  let cancelled = false;
  const total = dates.length * presets.length;
  const promise = (async () => {
    const runs = [];
    const locked = [];
    // FRD 4.7 §3: lock first, then run. Locking after the fact would prove nothing.
    if (label === 'validation' && deps.presetStore) {
      for (const p of presets) {
        const r = deps.presetStore.lock(p.name);
        if (r.changed) locked.push(p.name);
      }
    }
    let done = 0;
    for (const preset of presets) {
      for (const date of dates) {
        if (cancelled) break;
        const scan = runScan({ date, timeCET, cfg: preset.cfg, watchlist }, deps);
        const out = await scan.promise;
        runs.push({ preset: preset.name, hash: presetHash(preset.cfg), cfg: preset.cfg,
                    label, date, results: out.results });
        done += 1;
        onProgress({ done, total, preset: preset.name, date, cancelled, locked });
      }
      if (cancelled) break;
    }
    return { runs, cancelled, total, done, locked, label };
  })();
  return { promise, cancel: () => { cancelled = true; } };
}

// A simulated episode in the shape computeKpis() already measures, so tuning results and the
// live journal are scored by one code path and cannot disagree about what expectancy means.
// `stop` is deliberately omitted: Module B models no slippage (FR-B7), and supplying the stop
// would manufacture a tidy 0.000pp slippage that reads as a measurement.
export function episodeToTrade(result, cfg, watchlist) {
  if (!result?.qualified || !result.walk) return null;
  const n = watchlist.names.find(x => x.ticker === result.ticker);
  const a = allocate(cfg, { equity: 1, hwm: 1, open: [] },
    { ticker: result.ticker, dir: result.state.toLowerCase(), beta: n?.beta_60d ?? 1,
      cluster: n?.cluster ?? '', atrPct: n?.atr_pct_14d ?? 5, medianAtrPct: medianAtr(watchlist) });
  const step = INTERVAL_MS[result.resolution] ?? INTERVAL_MS['5min'];
  const underlyingPct = result.walk.underlyingPct;
  return {
    ticker: result.ticker, dir: result.state.toLowerCase(),
    entryTs: new Date(result.entry.ts).toISOString(),
    exitTs: new Date(result.entry.ts + result.walk.barIdx * step).toISOString(),
    entryPrice: result.entry.price, exitPrice: result.walk.exitPrice,
    exitReason: result.walk.reason,
    sizeFrac: a.sizeable ? a.sizeFrac : 0,
    leverage: cfg.leverage,
    underlyingPct, leveredPct: underlyingPct * cfg.leverage,
    mae: result.walk.mae, mfe: result.walk.mfe,
  };
}
const medianAtr = wl => {
  const a = wl.names.map(n => n.atr_pct_14d).sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)] ?? 5;
};

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Per preset per label (FR-C6). Never across labels (FR-C7).
export function aggregate(runs, watchlist) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.preset}|${run.label}`;
    const gEntry = groups.get(key) ?? { preset: run.preset, label: run.label, hash: run.hash,
      cfg: run.cfg, dates: new Set(), resolutions: new Set(), episodes: [], scanned: 0 };
    gEntry.dates.add(run.date);
    for (const r of run.results) {
      gEntry.scanned += 1;
      if (r.resolution) gEntry.resolutions.add(r.resolution);
      const t = episodeToTrade(r, run.cfg, watchlist);
      if (t) gEntry.episodes.push(t);
    }
    groups.set(key, gEntry);
  }

  return [...groups.values()].map(gr => {
    const k = computeKpis(gr.episodes, { cfg: gr.cfg });
    const outcomes = gr.episodes.map(e => e.exitReason);
    const n = outcomes.length;
    return {
      preset: gr.preset, label: gr.label, hash: gr.hash,
      dates: gr.dates.size, scanned: gr.scanned,
      signals: n,
      hitRate: n ? outcomes.filter(o => o === 'TARGET').length / n : null,
      expectancy: k.expectancy,
      avgMae: mean(gr.episodes.map(e => e.mae)),
      avgMfe: mean(gr.episodes.map(e => e.mfe)),
      timeoutShare: n ? outcomes.filter(o => o === 'TIME').length / n : null,
      stopShare: n ? outcomes.filter(o => o === 'STOP').length / n : null,
      resolutions: [...gr.resolutions].sort(),
      dofOverBudget: overBudget(gr.cfg),
    };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.preset.localeCompare(b.preset));
}
