# Momentum with Runway — Signal Desk (Repo 3 extension)

Implements FRD v1.5, Module A scaffold. Runs in DEMO mode with no keys (canned data);
enter free-tier keys in the app to go live.

## Quick start
    npm install
    npm run dev          # http://localhost:5173 — demo mode immediately
    npm run build        # static dist/ for GitHub Pages (existing Actions workflow deploys on push)

## First: run the spike
After first deploy, open `https://<user>.github.io/<repo>/spike.html` (or open public/spike.html locally), paste your Finnhub /
Twelve Data / FMP keys, press Run. It verifies the three FRD assumptions
(WS streaming, 5-minute history depth, batch-quote + earnings). Best run 15:30–22:00 CET.

## Layout
- `src/engine/` — tested pure signal/sizing engine (shared by live + simulator, NFR-5)
- `src/core/`  — config+hash, session clock, REST queue, tick aggregator, trade journal
- `src/adapters/` — FMP, Twelve Data, Finnhub WS, news/Riskline/OpenRouter, demo data
- `test/` — node --test suites (run: `node --test test/core.test.js test/engine/*.test.js` )
- `public/watchlist.json`, `public/key_dates.json` — versioned screen outputs (FR-A14)

## Status
- [x] Engine (20 tests) · [x] Core (5 tests) · [x] Demo mode · [x] Vite build
- [ ] Live wiring behind keys (adapters ready) · [ ] Position monitor UI · [ ] Modules B/C UI
