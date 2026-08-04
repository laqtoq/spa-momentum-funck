# HANDOVER — Momentum with Runway
### Context document for Claude Code sessions. Read this first, fully, before touching code.

Last updated: 2026-08-04 · Prepared in the claude.ai project where all design work happened (conversation exports must accompany final submission — see §11).

---

## 1. What this project is

**Post-module assignment** for the Executive MBA module *"Generative AI in Finance"* (WU Executive Academy Vienna, instructor Ted Kwartler, module held Aug 3–4, 2026). The student is on the **Finance track** (portfolio optimization optional; a non-optimized stock group is permitted).

**Deadline: Monday, August 31, 2026, 09:00 CEST** — submitted as `SURNAME_POST.pdf` on Moodle. A one-time extension costs 25% of points, so **the week of Aug 25 is a protected buffer: plan to be done by Aug 24.** GitHub repository links must be live and **public** at submission. All work is checked for plagiarism and AI fingerprints; AI-drafted written work must be human-edited and accompanied by full AI conversation exports.

**Graded deliverables (40% of course grade):**
1. Functional Requirements Document — exists as `docs/FRD.md` (v1.5), needs human editing pass
2. Portfolio Construction — done: 20-name screened watchlist (`public/watchlist.json`)
3. Portfolio Dashboard — this repo; vibe-coded SPA, published via GitHub Pages
4. Executive Summary (1 page) — not started
5. Investment Committee Presentation — pitch to a fictitious IC for a $1M USD allocation; live demo URL + recorded narrated demo recommended — not started

## 2. The strategy in one page

**"Momentum with Runway"** — intraday directional momentum (minutes to hours, design center 3–5h, never overnight) in high-volatility S&P 500 names, traded with 10x-leveraged instruments (CFDs/mini futures), signals only — **a human executes every order; the app never does** (Knight Capital 2012 is the course's central case study and our design counter-example).

Core insight: momentum is only tradable with *room left to run* — ≥3% runway to the nearest resistance (long) / support (short), and that runway must be *reachable* given current ATR.

**The numbers (all in `src/core/config.js` BASELINE — the single source of truth):**
- Target +3.0% underlying / stop −0.8% hard / time stop 5h or 21:45 CET → R:R 3.75:1 → **breakeven hit rate ≈ 21%**
- Entries 15:45–18:00 CET only; kill criteria: rolling-30 hit rate < 15%, stop slippage > 0.15pp avg, 3 consecutive daily-limit hits
- Sizing: risk 1.5% equity/trade ÷ (0.8% × 10x) = **18.75% of equity per position**; daily loss limit −3% = exactly two full stop-outs
- Buckets: max 2 concurrent · 1 full-size per correlation cluster (2nd at half) · direction caps · **beta-weighted net exposure ≤ 450% of equity (scale-to-fit, see §9 D4)** · drawdown throttle: −4% below HWM → half size
- Regime gates: longs only if SPY > 20-DMA (shorts inverse); no entries at VIX ≥ 30
- Signal = structure on 1h (RSI 45–65 long / 35–55 short, runway, feasibility) **ARMED** → trigger on 5m + live tape (slot-adjusted relvol ≥ 1.5, VWAP side, break of prior 5m extreme) → **LONG/SHORT**
- Earnings blackout T−1→T+1 close; operator pause dialogue, pause is the default

Original design covered **DAX 40 + S&P 500**; the DAX leg is **deferred (not abandoned)** for free-tier data availability — see FRD §2.2. Do not remove the deferral note; it is graded evidence of scoping judgment.

## 3. Authoritative documents (read order)

| File | Role |
|---|---|
| `docs/FRD.md` | **The spec. v1.5.** Every FR/NFR ID referenced in code and commits comes from here. It has a change log (§11) — every design change goes through it. |
| `docs/screen_report.md` | First screening run (2026-08-04): filter distributions, the three findings that produced FRD v1.5 |
| `public/watchlist.json` | The screened 20 names + bias tags + correlation clusters + 60d betas + thresholds used. Versioned config per FR-A14. Refresh monthly. |
| `public/key_dates.json` | FOMC dates (Sep 16, Oct 28, Dec 9 2026 confirmed); CPI dates still TO VERIFY; earnings come live from FMP |
| `plans/*.md` | Superpowers-style implementation plans for completed phases (screen, engine, Module A scaffold) — the process template to continue |
| `README.md` | Quick start, layout, status checklist |

If `docs/FRD.md` is missing, it was delivered as `FRD_momentum_runway.md` alongside this repo — copy it in before doing anything else.

## 4. Repository landscape

- **This repo** — the deliverable: **github.com/laqtoq/spa-momentum-funck** (public since 2026-08-04), live at **https://laqtoq.github.io/spa-momentum-funck/** (spike: `/spike.html`). Built on the course Vite template. Deploys to GitHub Pages via `.github/workflows/deploy.yml` on every push to `main` (`vite.config.js` uses `base:'./'` for the Pages subpath); deploy verified green.
- **github.com/laqtoq/Spa-Funck** — the student's Repo 1/3 from class (ticker form, Twelve Data fetch, FMP profile, NewsAPI, OpenRouter note). This scaffold descends from it; do not modify Spa-Funck.
- **github.com/laqtoq/genai-vienna-funck-day2** — the **instructor's course repo** (~3k files, public): all slide decks + taught R scripts. Course material is a **toolbox, not a constraint** (explicit user instruction), but reusing it where it fits is graded well. Most relevant:
  - `lessons/day2-datascience/scripts/A_data_prep.R` (quantmod/Yahoo bulk history), `E_rolling_correlation.R` (TTR::runCor — our cluster method), `F_rolling_metrics.R` (rolling Sharpe/beta — adopted as KPIs)
  - `lessons/day2-finance/scripts/FIN_A..G` — the taught LLM-context pipeline; `FIN_C` proves **newsdata.io is course-sanctioned** (env var name used in class: `NEWS_DATA_IO_API_KEY`)
  - `lessons/day1/day1_scripts/H_costar_prompt_finance.txt` — CO-STAR prompt template, already embedded in our desk-note adapter and the right skeleton for the IC deck

## 5. Current build state (verified 2026-08-04)

**Tests: 34/34 green.** Run: `node --test test/core.test.js test/engine/engine.test.js test/engine/indicators.test.js test/adapters.test.js` (do NOT pass a bare directory to `node --test` — it miscounts, see §10). `npm run build` green (~10.4 kB JS).

Done: signal engine (indicators cross-verified vs Python fixtures; levels/runway; evaluate() with per-criterion toggles; walker w/ conservative same-bar rule + MAE/MFE; full sizing/bucket logic) · core (config+FNV-1a preset hash, CET session clock, throttle queue w/ budget meter, deterministic tick aggregator, localStorage trade journal w/ KPIs & CSV/JSON round-trip) · adapters (Alpaca IEX WS, Twelve Data bars+quotes, FMP regime, Finnhub REST earnings, news env-switch, Riskline, OpenRouter CO-STAR, demo) · **demo mode**: app boots keyless on canned data with the real engine · **live wiring (FR-A15/A17/A1/A2/A5/A7/A8/A9/A18)**: `src/core/live.js` orchestrator (all I/O behind injected deps, 9 tests) — stream→per-symbol aggregators→engine, chunked TD quotes, SPY 20-DMA, per-symbol earnings + blackout pause defaults w/ explicit override confirm, reconnect backfill + VWAP reseed, provenance labels, budget meter · UI: mode-aware overview/drill-down/header · `public/spike.html` v2 verification page. **Live mode verified headless (tests) + keyless guard in browser; full click-through with real keys during market hours still pending (next session 15:30–22:00 CET) — expect states to fill over ~8 min (3 TD calls/name through the 8/min queue).

**Spike v1 ran 2026-08-04 (live market) and FAILED as designed — fallbacks activated, FRD amended to v1.6 (see C9):** Finnhub free WS streams only a popular-symbol subset (AAPL/TSLA yes, SPY/MU/DELL silent, no error frames); FMP free tier for post-Aug-2025 keys is symbol-restricted (SPY/^VIX OK, watchlist names 402) with batch + legacy `v3` endpoints dead. Verified working: Twelve Data fully serves watchlist names (1h/5m/60d/`/quote` batch); Finnhub REST `/calendar/earnings` works from the browser (CORS fine — v1.5's contrary assumption was wrong); FMP `stable/quote` for SPY + ^VIX. Pivot implemented and **spike v2 PASSED with the user's keys 2026-08-04 (live market)**: Alpaca IEX WS authenticated and streamed SPY/MU/DELL/AAPL (Layer 1 confirmed); Twelve Data overview quotes + 60d 5m depth on watchlist names confirmed; FMP SPY/^VIX regime pair confirmed (DELL 402 = expected C9 evidence); Finnhub earnings resolved **20/20 watchlist names** — but only via per-symbol calendar calls: the bulk calendar caps at 1500 rows keeping rows nearest `to`, silently dropping near-term dates (adapter + FR-A7 written per-symbol accordingly). **Live wiring (FR-A15–A18) is unblocked.**

## 6. Architecture (condensed — FRD §6–7 is authoritative)

Three data layers: **L1** Alpaca IEX WebSocket (real-time trades → client-side 1m/5m bars + session VWAP + position monitor; WS is CORS-exempt so it works on static Pages; single-venue IEX = compromise C1; replaced Finnhub WS 2026-08-04, see C9) · **L2** Twelve Data REST via the throttle queue (1h structure bars, 5m baselines/backfill, simulator history, overview quotes chunked ≤8/call; 8 credits/min, 800/day) · **L3** FMP regime inputs (SPY, ^VIX only) + Finnhub REST earnings calendar, R-side screening, news/Riskline/OpenRouter context.

Modules: **A** live dashboard · **B** point-in-time simulator (strict point-in-time discipline, conservative same-bar rule, preset-hash stamping) · **C** config workbench (presets, tuning/validation split, batch runner, ≤3-params-off-baseline budget) · **D** allocator + trade journal.

Iron rules (NFRs): one engine code path for A/B/C — never fork simulation logic (NFR-5) · adapters are swappable interfaces (NFR-4) · deterministic preset hashes (NFR-6) and bars keyed to exchange timestamps (NFR-7) · Module A always evaluates the committed **baseline** config; experiments live in B/C only (FRD §4.7) · every panel carries a data-provenance label (FR-A18).

## 7. Keys & secrets

Free-tier keys the user holds: FMP, Twelve Data, newsdata.io, NewsAPI (localhost-only CORS), OpenRouter, Finnhub, Alpaca key-ID + secret pair (paper account; needed since the v1.6 pivot). A gitignored local `.env` (template: `.env.example`) is the user's personal copy-paste store — the app never reads it; never use a `VITE_` prefix there or Vite will inline the value into the public bundle. **Keys are entered in the deployed app's form fields at runtime — never committed, never in `.env` files that ship, never in `.mcp.json`.** `key_dates.json`/`watchlist.json` are the only committed config. NewsAPI is used automatically on localhost (fresher, for demo recordings); newsdata.io when deployed (~12h delayed — labeled in UI, context only, never a trading input).

## 8. Working agreements (how we build)

1. **Superpowers discipline**: every phase gets a plan file in `plans/` (bite-sized tasks, each with a VERIFY step); execute task-by-task; a failing check stops the phase until understood. Three real bugs were caught this way already — keep it.
2. **Spec-code truth**: if tests force a design change (see §9 D4), the FRD is edited in the same phase, with a change-log entry. Commits reference FR IDs ("implement FR-A16 position monitor").
3. **Scope is frozen at FRD v1.5.** The build is at the ambitious edge of the timeline. Cuttable-if-needed, in order: Module C batch runner → Module C beyond preset editing → Module B scan mode. Never cut: journal, position monitor, demo mode, provenance labels.
4. Build order remaining: position monitor UI (FR-A16; journal exists in `store.js`, live inputs ready on `live.js` state: `bars5m()/vwap()/live`) → Module B → Module D bucket board UI → Module C → R port of the screening pipeline (course-facing; Python original in project history) → docs/deck. Live wiring done 2026-08-04 (needs one market-hours click-through).
5. Session times are **CET-anchored** (user is Europe-based; syllabus uses CEST). US cash session 15:30–22:00 CET; entry window 15:45–18:00.

## 9. Decision log (the "why" — do not silently reverse)

- **D1** Intraday 10x momentum kept as the *core* IC thesis (user's explicit choice over safer framings); defended via risk math (21% breakeven), falsifiability clause, Knight-informed human-in-the-loop.
- **D2** "Portfolio" = the screened watchlist + risk budgets (Finance-track allowance); mean-variance optimizers evaluated and rejected with rationale (FRD §4.4) — wrong tool for a 0–2-position tactical book.
- **D3** DAX deferred for data availability; calibrations preserved as a future Module C preset (FRD §2.2).
- **D4** Beta bucket **scales to fit** (not halves): halving a β-5.2 name (18.75%→9.375%) still breaches the 4.5 cap — unit test forced the correction; SNDK enters at 4.5/52 ≈ 8.65%. FRD §5.6 + change log updated. This is a good IC-appendix story.
- **D5** Screen findings → FRD v1.5: **S3 adaptive** ATR floor = max(2.0%, liquid-universe median) [2.0% passed 96% of liquid names — useless]; **S7 sector cap** max 6/GICS sector [unconstrained top-20 was one 17-name AI-hardware cluster]; 450% beta cap confirmed, Module C-configurable.
- **D6** LLM sentiment is **never** in the signal path (course theme: AI as drafting assistant vs authoritative source); commentary layer only, with prompt-injection hygiene (FR-A11).
- **D7** Social funnel (ApeWisdom primary, Tradestie backup, StockTwits/Motley Fool excluded — no viable API) proposes candidates at screening time in R only; filters dispose.
- **D8** Compromises to stay free-tier are *first-class*: FRD §6.3 register C1–C8; surfaced in-UI via provenance labels. Extend the register rather than absorbing new compromises silently.

## 10. Environment gotchas (learned the hard way)

- `node --test <directory>` miscounts/false-fails — always pass explicit test file paths.
- Free-tier symbol restrictions (2026-08-04): FMP and Finnhub WS serve only popular symbols on new free keys — AAPL/SPY tests pass while watchlist names fail silently or 402. **Always verify data assumptions with actual watchlist names, never AAPL.**
- Wikipedia and some APIs 403 the default Python/urllib UA — send a real User-Agent.
- Vite only ships `public/` — anything that must exist on Pages (spike.html, watchlist.json) lives there.
- Fixture files carry 6 decimals — numeric test tolerances ≥ 2e-6 absolute, or regenerate at full precision.
- FMP batch quote lacks a 20-DMA → SPY 20-DMA computed from one Twelve Data daily call (FR-A1).
- Aggregator bars must be keyed to **exchange** timestamps, not arrival time (NFR-7 test exists).
- localStorage is the only persistence (static hosting) — journal export prompts are load-bearing, not nice-to-have (C8).

## 11. Submission checklist (keep current as phases complete)

- [x] Spike v1 run 2026-08-04 → fallbacks activated + FRD amended to v1.6 (C9) · [x] Spike v2 passed with user keys 2026-08-04 (screenshot taken; keep for appendix) · [ ] Spike v2 re-run at deployed URL once Pages exists
- [x] Live wiring FR-A15–A18 (2026-08-04; market-hours click-through pending) · [ ] Position monitor UI · [ ] Module B · [ ] Module D UI · [ ] Module C (minimum: preset editing)
- [ ] R port of screening pipeline committed (`screen/` folder) + rerun close to submission for a fresh watchlist
- [ ] FRD human-edited (name, voice pass, thresholds sanity: VIX 30, 18:00 cutoff, 450% β-cap)
- [ ] Executive summary (1 p.) · [ ] IC deck (CO-STAR skeleton; slides: thesis → risk math → Knight safeguards → live demo → optimization-governance → challenge Q&A incl. "what if hit rate is 15%?" and "why not unlevered momentum basket?") · [ ] Narrated demo recording (record on localhost for fresh NewsAPI headlines)
- [x] Repo public (laqtoq/spa-momentum-funck), Pages green (verified 2026-08-04) · [ ] README kept current through remaining phases
- [ ] **AI conversation exports attached**: the claude.ai project chats AND Claude Code session transcripts
- [ ] Verify CPI dates in key_dates.json · [ ] Optional: verify hagll.com pre-module cross-references in final text
