# Module D — Bucket Board & KPI Panel Implementation Plan (FR-D3, FR-D4, FR-D11)

**Goal:** Turn the risk framework from prose into instruments. Three things land: a **bucket board** showing consumed vs available for every Section 5.6 bucket with the daily loss budget as a gauge (FR-D3); **NOT SIZEABLE** treatment for live signals, naming the binding bucket and the size at which they would fit, with the signal never hidden (FR-D4); and a **KPI dashboard + permanently visible kill-criteria panel** computed from the journal (FR-D11, Sections 5.3 and 5.5).

**Architecture:** All arithmetic goes into pure modules — `buckets()` alongside `allocate()` in `src/engine/sizing.js` (same FRD §5.6 domain, shares the notional/beta convention), and a new `src/engine/kpis.js` over an array of closed trades. `store.js` keeps persistence only and delegates its `kpis()` to the engine, so the journal never grows a second copy of the maths. `main.js` renders; no computation in the DOM layer.

**Tech stack:** Existing. No new dependencies.

## Scope boundary

In: FR-D3 bucket board · FR-D4 sizeability for current signals · FR-D11 KPI dashboard + kill-criteria panel · the Section 5.5 KPIs that the journal can support · daily and weekly P&L against the 5.2 limits.

Out (do not creep): FR-D6 what-if mode · FR-D12 trade table, equity curve and Module B replay · Module B itself · Module C.

## Interpretation calls (record here; FRD amend only if overridden)

- **Daily budget gauge = realized loss today + open risk at stop**, against the −3% limit. The limit in 5.2 is written on realized loss, but a gauge that ignores two open positions each risking 1.5% would read 0% while the book is fully committed. Both components are shown separately, so the operator can see which is which.
- **Per-trade risk consumed is computed, not assumed**: `Σ sizeFrac × stopPct/100 × leverage`. A β-scaled position consumes less than the full 1.5%, and the board must show that rather than counting positions.
- **Rolling Sharpe uses per-trade account return** (`sizeFrac × leveredPct`), not raw leveredPct — that is the series that actually moves equity. Annualization-free, per FRD 5.5.
- **Realized book beta needs SPY daily returns**, which exist only in live mode (`live.js` already fetches 21 daily SPY bars for the 20-DMA). Where the series is unavailable or too short it renders `n/a` with the reason, never a fabricated number.
- **Sessions for the exposure KPI are CET calendar days** derived from journal timestamps, since the journal is the only record of when the desk was actually run.

## Tasks

### Task 1 — Bucket board maths
- [x] `src/engine/sizing.js`: `buckets(cfg, book, day)` → one row per bucket (per-trade risk, concurrent, cluster, direction, beta-weighted net exposure, drawdown throttle) with `{ id, label, consumed, limit, unit, pct, binding }`, plus the daily and weekly budget rows from realized P&L
- [x] VERIFY: `node --test test/engine/buckets.test.js` — empty book gives 0 consumed on every row; two full-size positions consume exactly 3.0% per-trade risk and 2/2 concurrent; a β-5.2 position scaled to 8.65% consumes 450% of the beta bucket exactly, not 975%; equity 4% below HWM flags the throttle; a −3% realized day flags the daily budget

### Task 2 — KPI engine
- [x] `src/engine/kpis.js`: `computeKpis(closed, opts)` covering every FRD 5.5 metric — hit rate (rolling 30), profit factor, expectancy, average MAE of winners, average MFE of losers, stop slippage over the last 20 stops, time-in-trade distribution, exposure, rolling 30-trade Sharpe, and realized book beta when a SPY series is supplied
- [x] `store.js` `kpis()` delegates to it; existing journal test stays green untouched
- [x] VERIFY: `node --test test/engine/kpis.test.js` — hand-computed fixture of 5 trades checks every metric; a null/short SPY series yields `bookBeta: null` with a stated reason, never 0; metrics that need data the journal lacks return null rather than a placeholder

### Task 3 — Kill criteria
- [x] `src/engine/kpis.js`: `killCriteria(closed, cfg)` → the three Section 5.3 rules with current value, threshold, distance and status (OK / WARN / TRIGGERED); consecutive daily-limit hits counted from daily realized P&L
- [x] VERIFY: same suite — a 30-trade run at 13% hit rate reports TRIGGERED on the hit-rate rule; 0.16pp average slippage over 20 stops triggers; three consecutive −3% days trigger; each rule reports OK with a real distance when clear, and null (not OK) before it has enough trades to judge

### Task 4 — Bucket board UI (FR-D3/FR-D4)
- [x] Replace the Risk/Allocator panel body: bucket rows with consumed/limit bars, the daily budget as a prominent gauge, and a live-signal list showing each current LONG/SHORT with its mechanical size or **NOT SIZEABLE** + binding bucket + the size at which it would fit
- [x] VERIFY: in demo mode with DELL LONG staged, the signal row shows the β-cap-scaled size; open a position and the board moves; the signal is still listed when not sizeable

### Task 5 — KPI + kill-criteria panel UI (FR-D11)
- [x] New panel: KPI grid with each 5.5 metric and its purpose on hover, plus the kill-criteria strip with distance-to-threshold bars, always visible; `n/a` states carry their reason
- [x] VERIFY: empty journal renders the panel with honest `n/a` everywhere rather than zeros; after closing a demo trade the KPIs populate; `npm run build` green

### Task 6 — Docs + gate
- [x] README status, HANDOVER §5 and §11, plan outcome; FRD change log only if an interpretation above was overridden
- [x] VERIFY: full suite green including the two new files; browser click-through; commit referencing FR-D3/D4/D11

## Outcome (2026-09-07)

All six tasks executed. **83/83 tests green** (9 new in `test/engine/buckets.test.js`, 13 in `test/engine/kpis.test.js`); build 49.5 kB / 18.8 kB gzip. The journal test was not touched — `store.kpis()` delegates to the engine and keeps `hitRate30` as an alias.

Browser pass against a seeded 8-trade journal with two open positions, every figure hand-checked: equity $109,375 (100k + 3×5.625% − 5×1.5%), hit rate 37.5%, profit factor 2.25, expectancy +1.17%, avg MAE winners 0.40pp, avg MFE losers 1.20pp, exposure 100% of 7 weekday sessions, risk at stop 3.00%/3%, beta-weighted exposure 457.50%/450% flagged binding, and DELL correctly listed as NOT SIZEABLE naming all three binding buckets while remaining visible (FR-D4). Empty journal renders ten honest `n/a`s and zero fabricated zeros.

**Config change:** the FRD 5.2 account limits and 5.3 kill thresholds were quoted in the spec but existed nowhere in code; they now live in `BASELINE`. This moves the baseline preset hash, which is what NFR-6 intends — nothing referenced the old value.

**Three bugs found and fixed in this phase:**
1. Consecutive daily-limit detection missed a day that landed exactly on −3%. FRD 5.6 defines that day as precisely two full-size stop-outs, so accumulated float error was excusing a limit hit; the comparison now carries a tolerance.
2. The cluster row rendered red at one open position. One full-size position per cluster is what the rule *permits* — it now binds on the second name, via an explicit `bindsAt` on the row builder.
3. A count rendered as "3.0 of room" instead of "3".

**Deferred, unchanged:** FR-D6 what-if mode and FR-D12 trade table / equity curve / Module B replay. Realized book beta is implemented but reads `n/a` until live mode supplies the SPY series and ≥5 overlapping days exist.
