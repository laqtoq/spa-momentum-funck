# Screening Pipeline Implementation Plan

**Goal:** Produce `watchlist.json` (20 names + bias tags + correlation clusters + betas) and a screen report showing per-filter pass/fail distributions, validating the FRD's S1–S6 thresholds against real data.

**Architecture:** Staged Python pipeline (keyless Yahoo daily data) run in-container with a checkpoint after every stage; each stage's output is verified before the next runs. An R port for the course-facing repo is a fast follow, not part of this run.

**Tech stack:** Python 3, yfinance, pandas, numpy. No API keys required for any stage in this run.

## Global constraints (from FRD v1.4)
- S2: close ≥ USD 20 | S3: 14d Wilder ATR ≥ 2.0% of price | S4: 20d avg dollar volume ≥ USD 500M
- S5: bias = price vs 50-DMA; record 50/200 state | S6: top 20 by z(ATR%) + z(|126d return|)
- Clusters: 60d return correlation ≥ 0.7 | Betas: 60d vs SPY
- Funnel (S0): ApeWisdom candidates merged before filters; filters always dispose.

## Tasks

### Task 1 — Environment + data-access smoke test
- [ ] Install yfinance; fetch 1y daily for AAPL + SPY only
- [ ] VERIFY: ≥ 240 rows each, no NaN closes in last 30 rows, latest date within 3 trading days

### Task 2 — Universe list
- [ ] Pull S&P 500 constituents from Wikipedia table
- [ ] VERIFY: 500–505 tickers, spot-check AAPL/MSFT/NVDA present; normalize tickers (BRK.B → BRK-B)

### Task 3 — Bulk history download (chunked, cached)
- [ ] Download ~15 months daily OHLCV for all constituents + SPY in chunks of 50 with retry/backoff; cache to disk
- [ ] VERIFY: coverage report — % tickers with ≥ 260 rows; fail task if < 95%

### Task 4 — Metrics + filters S1–S5
- [ ] Compute ATR14% (Wilder), 20d avg dollar volume, 126d return, SMA50/SMA200 states
- [ ] Apply S2–S4; tag S5 bias
- [ ] VERIFY: hand-check one ticker's ATR% against manual calc; report per-filter pass counts and the S3 sensitivity curve (pass counts at ATR ≥ 1.5/2.0/2.5/3.0%) — the FRD-validation deliverable

### Task 5 — Funnel (S0)
- [ ] Fetch ApeWisdom trending (all-stocks); intersect with S&P membership; report which funnel names already pass / newly enter consideration
- [ ] VERIFY: endpoint returns JSON with ≥ 50 rows; graceful skip with note if unreachable

### Task 6 — Rank, clusters, betas
- [ ] Composite z-score among survivors → top 20; 60d correlation matrix → union-find clusters at ≥ 0.7; 60d betas vs SPY
- [ ] VERIFY: exactly 20 names; each name has bias, cluster id, beta; betas plausible (0.3–3.5); clusters symmetric

### Task 7 — Emit artifacts
- [ ] Write `watchlist.json` (schema per FRD: tickers, bias, cluster, beta, screening date, thresholds used) + `key_dates.json` skeleton (FOMC dates; CPI marked to-verify; earnings left to FMP at runtime)
- [ ] Write `screen_report.md` (distributions, sensitivity curve, funnel notes, decisions taken)
- [ ] VERIFY: JSON parses; 20 entries; report renders

### Task 8 — Review gate
- [ ] Present artifacts; flag any FRD threshold that data says should change (esp. S3) for the user's decision → possible FRD v1.4 → v1.5 edit
