// Module D sizing + buckets (FRD 5.6). Pure functions over book state.
export function baseSize(cfg) { return cfg.riskPerTrade / (cfg.stopPct/100 * cfg.leverage) ; } // fraction of equity, e.g. 0.015/(0.008*10)=0.1875
export function atrScale(nameAtrPct, medianAtrPct) { return Math.min(1, medianAtrPct / nameAtrPct); }

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
    if (fitFrac <= 0) binding.push('betaExposure');
    else if (fitFrac < frac) { frac = fitFrac; betaScaled = true; }
  }
  let ddHalved = false;
  if (book.equity < book.hwm * (1 - cfg.ddThrottle)) { frac /= 2; ddHalved = true; }
  return { sizeFrac: binding.length ? 0 : frac, sizeable: binding.length === 0,
           binding, adjustments: { clusterHalved, betaScaled, ddHalved } };
}
