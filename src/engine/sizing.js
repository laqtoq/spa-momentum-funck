// Module D sizing + buckets (FRD 5.6). Pure functions over book state.
export function baseSize(cfg) { return cfg.riskPerTrade / (cfg.stopPct/100 * cfg.leverage) ; } // fraction of equity, e.g. 0.015/(0.008*10)=0.1875
export function atrScale(nameAtrPct, medianAtrPct) { return Math.min(1, medianAtrPct / nameAtrPct); }

// Risk a position puts at the stop, as a fraction of equity — the unit the whole system is built on.
export const riskOf = (cfg, sizeFrac) => sizeFrac * (cfg.stopPct / 100) * cfg.leverage;
// Smallest share of the risk unit worth calling a position. Not a strategy knob: a guard against
// scaling into the rounding dust left when a book fills a cap exactly.
export const MIN_RISK_SHARE = 0.1;

export function allocate(cfg, book, signal) {
  // book: {equity, hwm, open:[{ticker,dir,sizeFrac,beta,cluster}]}; signal: {ticker,dir,beta,cluster,atrPct,medianAtrPct}
  let frac = baseSize(cfg);
  if (cfg.atrScaled) frac *= atrScale(signal.atrPct, signal.medianAtrPct);
  const binding = [];
  if (book.open.length >= cfg.maxConcurrent) binding.push('concurrent');
  const sameCluster = book.open.filter(p => p.cluster === signal.cluster).length;
  let clusterHalved = false;
  if (sameCluster >= 1) { if (cfg.clusterSecondHalf) { frac /= 2; clusterHalved = true; } else binding.push('cluster'); }
  const sameDir = book.open.filter(p => p.dir === signal.dir).length;
  if (sameDir >= cfg.maxPerDirection) binding.push('direction');
  const notional = f => f * cfg.leverage;                       // as fraction of equity
  const bookExp = book.open.reduce((s,p) => s + notional(p.sizeFrac) * p.beta * (p.dir==='long'?1:-1), 0);
  const dirSign = signal.dir==='long' ? 1 : -1;
  let betaScaled = false;
  const total = bookExp + notional(frac) * signal.beta * dirSign;
  if (Math.abs(total) > cfg.betaCap) {
    // scale the new position to exactly exhaust remaining |exposure| headroom (FR-D4: "the size at which it would fit")
    const headroom = cfg.betaCap - Math.abs(bookExp + 0); // conservative: headroom vs current book magnitude
    const fitFrac = headroom > 0 ? headroom / (cfg.leverage * Math.abs(signal.beta)) : 0;
    // A fit that risks a rounding error is not a position. Recorded sizes are rounded to two
    // decimals at the fill, so a book that fills the cap leaves a sliver of headroom behind;
    // scaling into it produced a "position" risking 0.000075% of equity against a 1.5% unit.
    if (fitFrac <= 0 || riskOf(cfg, fitFrac) < cfg.riskPerTrade * MIN_RISK_SHARE) binding.push('betaExposure');
    else if (fitFrac < frac) { frac = fitFrac; betaScaled = true; }
  }
  let ddHalved = false;
  if (book.equity < book.hwm * (1 - cfg.ddThrottle)) { frac /= 2; ddHalved = true; }
  return { sizeFrac: binding.length ? 0 : frac, sizeable: binding.length === 0,
           binding, adjustments: { clusterHalved, betaScaled, ddHalved } };
}

// ---- Bucket board (FR-D3). Consumed vs available for every FRD 5.6 bucket. Pure. ----
// book: {equity, hwm, open:[{ticker,dir,sizeFrac,beta,cluster}]}
// realized: {today, week} as % of equity, signed (losses negative) — from the journal, FRD 5.2.
export function buckets(cfg, book, realized = { today: 0, week: 0 }) {
  const open = book.open ?? [];
  const notional = f => f * cfg.leverage;
  // `bindsAt` defaults to the cap, but the cluster rule is not breached by reaching its cap:
  // one full-size position per cluster is exactly what it permits (FRD 5.6).
  const row = (id, label, consumed, limit, unit, note, bindsAt = limit) => ({
    id, label, consumed, limit, unit, note,
    pct: limit > 0 ? Math.min(1, Math.abs(consumed) / limit) : 0,
    binding: Math.abs(consumed) >= bindsAt - 1e-9,
  });

  // Risk actually at stop, not a count of positions: a beta-scaled position consumes less.
  const riskAtStop = open.reduce((s, p) => s + p.sizeFrac * (cfg.stopPct / 100) * cfg.leverage, 0) * 100;
  const perTradeCap = cfg.riskPerTrade * 100 * cfg.maxConcurrent;

  const clusters = {};
  for (const p of open) clusters[p.cluster] = (clusters[p.cluster] ?? 0) + 1;
  const worstCluster = Object.entries(clusters).sort((a, b) => b[1] - a[1])[0];

  const longs = open.filter(p => p.dir === 'long').length;
  const shorts = open.length - longs;
  const betaExp = Math.abs(open.reduce((s, p) => s + notional(p.sizeFrac) * p.beta * (p.dir === 'long' ? 1 : -1), 0));
  const ddPct = book.hwm > 0 ? (book.hwm - book.equity) / book.hwm * 100 : 0;

  // The daily gauge counts realized loss plus what is still exposed at stop: a book fully
  // committed to two stops is not "0% used" just because nothing has closed yet.
  const dailyUsed = Math.max(0, -realized.today) + riskAtStop;

  return {
    rows: [
      row('risk', 'Risk at stop', riskAtStop, perTradeCap, '%',
          `${open.length} open × ${cfg.riskPerTrade * 100}% per trade`),
      row('concurrent', 'Concurrent positions', open.length, cfg.maxConcurrent, '',
          'attention and correlation control'),
      row('cluster', 'Largest cluster', worstCluster?.[1] ?? 0, 1, '',
          worstCluster ? `${worstCluster[0]}${worstCluster[1] > 1 ? ' — second at half size' : ' — one full-size position permitted'}` : 'none open',
          2),
      row('direction', 'Direction (net)', Math.max(longs, shorts), cfg.maxPerDirection, '',
          `${longs}L / ${shorts}S`),
      row('beta', 'Beta-weighted exposure', betaExp * 100, cfg.betaCap * 100, '%',
          'Σ notional × β × direction'),
      row('drawdown', 'Drawdown throttle', Math.max(0, ddPct), cfg.ddThrottle * 100, '%',
          ddPct >= cfg.ddThrottle * 100 ? 'ACTIVE — new positions at half size' : 'below high-water mark'),
    ],
    daily: { ...row('daily', 'Daily budget', dailyUsed, cfg.dailyLossLimitPct, '%', 'realized loss + open risk at stop'),
             realized: realized.today, atRisk: riskAtStop },
    weekly: row('weekly', 'Weekly circuit breaker', Math.max(0, -realized.week), cfg.weeklyLossLimitPct, '%',
                'written review before resumption'),
  };
}
