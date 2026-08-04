# Module A Scaffold Implementation Plan

**Goal:** Buildable Vite SPA on the Spa-Funck base: tested core (queue, aggregator, session, config-hash), data adapters, demo mode (runs keyless on canned data), minimal-but-real UI with the runway-strip signature, plus spike.html for the user's key verification. `vite build` green = done.

**Design tokens:** bg #14171C / panel #1B2027 / ink #E8EAED / muted #8A93A0; LONG/pass #3FB68B; SHORT/fail #D08048; ARMED #C9A961; type: system UI + tabular-numeral mono for all data. Signature: per-name runway strip (support ◄ price ► resistance, 3% zone shaded).

## Tasks
1. Scaffold: copy Spa-Funck build chrome (package.json, vite.config, deploy.yml), engine modules, watchlist/key_dates into public/. VERIFY: tree correct.
2. Core: `config.js` (baseline + FNV-1a preset hash, NFR-6), `session.js` (CET windows, E6), `queue.js` (8/min throttle, TTL cache, budget meter), `aggregator.js` (trades→1m/5m bars + VWAP, exchange-ts keyed, NFR-7), `store.js` (journal, localStorage + export). VERIFY: node tests green (hash determinism, window edges, queue spacing, aggregation determinism incl. out-of-order ticks, journal round-trip).
3. Adapters: fmp.js, twelvedata.js, finnhubStream.js, news.js (env-aware), riskline.js, openrouter.js — thin, mockable; demo.js generates canned quotes/bars/trades. VERIFY: adapter shape tests with mocked fetch.
4. UI + main: overview table w/ runway strips, regime banner, stream badge, drill-down criteria list, risk panel (Module D), session header; demo mode auto-on without keys. VERIFY: `vite build` succeeds.
5. spike.html: standalone page — user pastes keys → PASS/FAIL for Finnhub WS, Twelve Data 5m depth (fetch 5m bars for a 60-day-old date), FMP batch-quote + earnings. VERIFY: static review (runs only with user's keys).
6. Package + handoff.
