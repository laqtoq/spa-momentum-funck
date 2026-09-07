# Momentum with Runway — Signal Desk (Repo 3 extension)

Implements FRD v1.7, Module A complete. Runs in DEMO mode with no keys (canned data);
enter free-tier keys in the app to go live.

## Quick start
    npm install
    npm run dev          # http://localhost:5173 — demo mode immediately
    npm run build        # static dist/ for GitHub Pages (existing Actions workflow deploys on push)

## First: run spike v2
Open `public/spike.html` (locally or at https://laqtoq.github.io/spa-momentum-funck/spike.html), paste your
Alpaca key-ID + secret / Twelve Data / FMP / Finnhub keys, press Run. It verifies the FRD v1.6
provider set: Alpaca IEX streaming, Twelve Data depth + quotes on watchlist names, FMP regime
residual (SPY/^VIX), Finnhub earnings-calendar coverage. Best run 15:30–22:00 CET.
(Spike v1, 2026-08-04, exposed free-tier symbol restrictions on Finnhub WS and FMP → provider
pivot recorded as FRD compromise C9.)

## Layout
- `src/engine/` — tested pure signal/sizing engine (shared by live + simulator, NFR-5)
- `src/core/`  — config+hash, session clock, REST queue, tick aggregator, trade journal
- `src/adapters/` — Alpaca WS (L1), Twelve Data (L2), FMP regime + Finnhub earnings (L3), news/Riskline/OpenRouter, demo data
- `test/` — node --test suites (run: `node --test test/core.test.js test/engine/engine.test.js test/engine/indicators.test.js test/adapters.test.js`)
- `public/watchlist.json`, `public/key_dates.json` — versioned screen outputs (FR-A14)

## Status
- [x] Engine (20 tests) · [x] Core (5 tests) · [x] Adapters (9 tests) · [x] Live orchestrator (12 tests) · [x] Monitor (9 tests) · [x] Buckets (9 tests) · [x] KPIs (13 tests) · [x] Simulator (22 tests) · [x] Staged demo (6 tests) · [x] Vite build
- [x] Provider pivot (FRD v1.6, C9) · [x] Spike v2 passed with real keys (2026-08-04)
- [x] Live wiring behind keys (FR-A15–A18; market-hours click-through pending)
- [x] Position monitor + fill capture (FR-A16, FR-D7–D10) · [x] Bucket board + KPI & kill-criteria panel (FR-D3/D4/D11)
- [x] Module B point-in-time simulator + scan mode (FR-B1–B8) · [ ] FR-D6 what-if, FR-D12 trade table · [ ] Module C UI

Demo mode is a staged snapshot frozen at **Tue 4 Aug 2026, 16:30 CET** (inside the entry window), so the
desk demonstrates itself at any hour: DELL LONG, LITE and PWR ARMED, the rest IDLE for a different named
reason each, and every short-bias name held back by the regime gate. The states are produced by the real
signal engine from canned bars — `test/demo.test.js` asserts the whole map — and every panel is labelled
DEMO SNAPSHOT with its as-of moment. Live mode runs on the wall clock as before. See HANDOVER §5 and D9.

Tests: `node --test test/core.test.js test/engine/engine.test.js test/engine/indicators.test.js test/engine/monitor.test.js test/engine/buckets.test.js test/engine/kpis.test.js test/engine/simulate.test.js test/adapters.test.js test/live.test.js test/sim.test.js test/demo.test.js`
