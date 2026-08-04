# Momentum with Runway — Signal Desk (Repo 3 extension)

Implements FRD v1.6, Module A scaffold. Runs in DEMO mode with no keys (canned data);
enter free-tier keys in the app to go live.

## Quick start
    npm install
    npm run dev          # http://localhost:5173 — demo mode immediately
    npm run build        # static dist/ for GitHub Pages (existing Actions workflow deploys on push)

## First: run spike v2
Open `public/spike.html` (locally or at `https://<user>.github.io/<repo>/spike.html`), paste your
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
- [x] Engine (20 tests) · [x] Core (5 tests) · [x] Adapters (9 tests) · [x] Demo mode · [x] Vite build
- [x] Provider pivot (FRD v1.6, C9) · [ ] Spike v2 pass with Alpaca keys
- [ ] Live wiring behind keys (adapters ready) · [ ] Position monitor UI · [ ] Modules B/C UI
