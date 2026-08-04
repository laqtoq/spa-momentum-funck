# Functional Requirements Document
## "Momentum with Runway" — Intraday Momentum Strategy & Signal Dashboard

| | |
|---|---|
| **Course** | Generative AI in Finance — Executive MBA, WU Executive Academy |
| **Assignment** | Post-Module Deliverable 1: Functional Requirements Document |
| **Author** | *[Your name]* — Finance track |
| **Version** | 1.6 (draft for human editing; change log in Section 11) |
| **Date** | August 2026 |
| **Application** | Single-page application (SPA), extending course Repo 3 (Vite template), published via GitHub Pages |

---

## 1. Purpose and scope

This document specifies a quantitative investment thesis and the functional behavior of the web application that implements it. The application consists of four modules: **Module A**, a live decision-support dashboard with a real-time streaming layer and position monitor; **Module B**, a point-in-time simulator that replays the strategy at a user-selected historical moment; **Module C**, a configuration and optimization workbench governing which criteria, at which thresholds, produce signals; and **Module D**, a risk allocator and trade journal that translates live signals into position sizes and risk-bucket utilization during a trading period, and records the actual book — which stocks were bought and sold, at what time, and at what price.

The application signals, simulates, monitors, and sizes — it does not execute trades. All execution is performed by a human operator under the risk framework in Section 5; this separation is deliberate and is discussed in Section 5.4 with reference to the Knight Capital Group failure (2012).

Course scripts and material are reused only where they serve this strategy; the design is not constrained to course-taught tools or providers. Where free-tier data licensing forces a compromise against the ideal design, the compromise is recorded explicitly in the register in Section 6.3 rather than silently absorbed.

Per the assignment brief, the document covers the chosen equity universe and selection criteria (Sections 3–4), data sources (Section 6), and the application behavior needed to implement the thesis (Section 7). Section 8 states what is out of scope; Section 10 defines testable acceptance criteria per module.

## 2. Investment thesis

### 2.1 Core thesis

The strategy trades short-horizon intraday directional momentum — positions held for minutes to hours, never overnight, with a design center of 3–5 hours — in high-volatility S&P 500 constituents, using leveraged instruments (CFDs / mini futures, nominal 10x), under strict mechanical risk limits and a market-regime gate. **Structure** is read on the hourly timeframe; **entries and exits are timed on minutes**, using 5-minute bars and a live trade stream.

The core insight is that intraday momentum is only tradable when there is *room left to run*. A stock may show textbook momentum confirmation — directional RSI, elevated volume, price on the right side of VWAP — and still be a poor entry if it sits directly beneath significant resistance. The strategy therefore combines two filters that are usually applied separately:

1. **Momentum confirmation** — the move is real and underway (RSI in a directional band on the structure timeframe, session-adjusted relative volume elevated on the trigger timeframe, price on the controlling side of the live session VWAP).
2. **Runway** — at least 3 percentage points of distance remain between the current price and the nearest significant resistance (long) or support (short), and that distance is *reachable* given current volatility (Section 4.3, E5).

The economics rest on payoff asymmetry rather than predictive accuracy. Each position targets a +3% move in the underlying with a hard stop at −0.8%. At 10x leverage this is +30% versus −8% per position — a reward-to-risk ratio of 3.75:1, with a breakeven hit rate of approximately **21%** (0.8 ÷ 3.8). At this stop distance, minute-level price awareness is not a luxury: a −0.8% stop can be reached inside a single hourly bar, so the live layer (Section 6.1, Layer 1) exists to keep the operator ahead of the stop, not to admire prices. The claim put to the investment committee is not superior market prediction; it is disciplined harvesting of a structurally asymmetric payoff, with capital preservation enforced by the limits in Section 5, position sizing made mechanical by Module D, and every signal reproducible in Module B under a governed configuration (Section 4.7).

### 2.2 Strategy lineage and the DAX deferral

The strategy was originally designed as a **dual-index system covering the DAX 40 and the S&P 500**, with index-specific calibrations (DAX: XETRA session, prime window 10:00–14:00 CET, RSI band 42–63, relative volume ≥ 1.3; S&P 500: RSI 45–65, relative volume ≥ 1.5) and the 15:30–17:30 CET overlap identified as the peak momentum window, when both markets trade simultaneously.

The DAX leg is **deferred, not abandoned**, for a data-availability reason: no assessed provider offers free real-time or minute-grade XETRA data of usable quality (the free tiers of Twelve Data and Alpaca streaming cover US symbols; FMP's free tier does not reliably serve XETRA). Implementing the DAX leg today would require a paid data plan — cost and complexity that a first deployment does not justify. The signal logic is provider-agnostic by design (Section 7, NFR-4), and index calibrations are ordinary configuration presets under Module C, so the DAX leg can be reactivated as a Phase 2 extension by adding an EU-capable data adapter and loading the documented DAX preset.

### 2.3 Falsifiability

The thesis fails, and the strategy is suspended, if the realized hit rate over any rolling 30-trade window falls below 15%, or if average adverse slippage on stops exceeds 0.15 percentage points (Section 5.3). Section 5.5 defines the KPIs on which this judgment is made. All live trading runs on the **locked baseline configuration** (Section 4.7); falsifiability applies to that baseline, not to whichever preset most recently simulated well.

## 3. Equity universe and candidate funnel

### 3.1 Universe

The candidate universe is the **S&P 500**. Membership itself is the first quality gate: constituents satisfy exchange listing, liquidity, and market-capitalization standards, and all are covered by the free tiers of the data providers in Section 6.

### 3.2 Candidate funnel (attention sources)

Before quantitative screening, a funnel of *attention signals* surfaces candidates that pure price screens can lag on. The funnel runs **at screening time, in R, on the analyst's machine** — never in the browser and never as a trade trigger. Its output is a candidate list that still must pass every filter in Section 4.1.

| Source | Access | What it contributes | Constraints |
|---|---|---|---|
| FMP biggest gainers / most actives | REST, API key (free tier) | Market-data attention: names with unusual price/volume action | Same 250 req/day budget |
| ApeWisdom | Public REST, **no key** (`apewisdom.io/api/v1.0/filter/{filter}`) | Retail attention: mention counts, 24h mention deltas, and upvotes across r/wallstreetbets, r/stocks, r/options | Mentions only, no sentiment scoring; commercial-use terms unpublished — acceptable for a monthly academic screen |
| Tradestie WSB API | Public REST, no key | Top-50 WSB list with rules-based sentiment labels | Reliability reports of the endpoint failing (403); treated as optional backup only |

Sources assessed and **excluded**: StockTwits (API frozen to new developers), Motley Fool (no public API; editorial content, not structured data), the official Reddit API (OAuth overhead plus self-built NLP for what the aggregators already provide). Social attention is a *funnel input, never a signal*: a heavily-mentioned name that fails the ATR, liquidity, or trend filters is discarded. Attention proposes, quantitative filters dispose.

### 3.3 Watchlist

From the funneled and screened universe, a **watchlist of 20 names** is maintained and committed to the repository as versioned configuration (`watchlist.json`), including per-name directional bias tags, the correlation-cluster map, and per-name 60-day rolling betas vs. SPY used by Module D (Section 5.6). Because this is a tactical trading strategy rather than a buy-and-hold portfolio, the watchlist is the "portfolio" in the sense of the assignment: capital is allocated to it via the risk-budget rules of Sections 5.2 and 5.6 rather than via mean-variance optimization (permitted for the Finance track, which allows a non-optimized portfolio group; mean-variance methods were assessed and judged the wrong tool for a book of hours-long tactical positions).

## 4. Selection criteria

### 4.1 Screening filters (universe → watchlist)

All filters are computed from daily bars over the trailing periods stated. The screen is re-run monthly (first trading day) and the result committed, so screening history is auditable through Git. Thresholds S3 and S7 were empirically validated (and in S3's case corrected) by the first full screening run on 2026-08-04; the run report accompanies the repository.

| # | Criterion | Threshold | Rationale |
|---|---|---|---|
| S0 | Candidate sourcing | S&P 500 full list, plus funnel candidates (3.2) | Attention proposes; filters dispose |
| S1 | Index membership | S&P 500 constituent | Liquidity and quality gate |
| S2 | Price level | Close ≥ USD 20 | Availability and pricing quality of leveraged instruments |
| S3 | Volatility (adaptive) | 14-day ATR ≥ max(2.0%, median ATR% of the liquid universe [S2∩S4 survivors]), recomputed at each monthly screen — 3.28% at the 2026-08-04 screen | A fixed floor is regime-blind: the first screening run showed 2.0% passing 96% of liquid names in the current high-volatility regime; the adaptive floor always selects the more volatile half |
| S4 | Liquidity | 20-day average dollar volume ≥ USD 500M | Tight spreads; slippage control is critical at 10x |
| S5 | Trend state | Price above 50-DMA (long-bias) or below 50-DMA (short-bias); 50/200-DMA cross state recorded | Only names in an established trend are candidates |
| S6 | Composite rank | Ranked by combined z-score of ATR% and absolute 6-month price return | Prefer names that are both volatile and in motion |
| S7 | Sector diversification cap | Top 20 filled greedily by S6 rank with at most 6 names per GICS sector | The first screening run showed the unconstrained top-20 collapsing into one 17-name correlation cluster (2 sectors) — operationally ~2 tradeable slots under the Module D cluster rule; the cap restored 7 sectors and 11 clusters. Residual cross-sector concentration (the AI-infrastructure trade) is handled by the trade-time cluster rule (5.6) |

At screening time the R pipeline additionally computes, and writes into `watchlist.json`: the 60-day pairwise return correlations among selected names (names with pairwise correlation ≥ 0.7 share a cluster) and each name's 60-day rolling beta vs. SPY. Module D consumes both at run time; the browser never computes them. The pipeline reuses course techniques where they fit — bulk daily history via quantmod/Yahoo Finance (keyless, R-side, zero browser API budget), indicators via TTR, rolling correlation and rolling beta adapted from the Day 2 quantitative scripts — as tools, not as constraints.

### 4.2 Market-regime gate (portfolio-level, evaluated before any signal)

At 10x leverage, single-name momentum must not be traded against a hostile tape. Two gates apply globally; when either fails, the dashboard displays **STAND DOWN** and suppresses all new-entry signals for the affected direction or entirely:

| # | Gate | Rule |
|---|---|---|
| G1 | Index trend | Long entries only when SPY closed above its 20-DMA; short entries only when below |
| G2 | Volatility regime | No new entries in either direction when VIX ≥ 30 (panic regimes break the runway logic: levels stop holding and slippage explodes) |

### 4.3 Intraday signal criteria (watchlist → trade signal)

Signals are evaluated on two timeframes. **Structure criteria** establish that a tradable move with room exists; they are computed on 1-hour bars. **Trigger criteria** time the entry; they are computed on 5-minute bars and the live trade stream. All times CET. The values below constitute the **baseline configuration**; Section 4.7 governs how and when they may be varied.

**Structure criteria (1-hour bars):**

| # | Criterion | LONG setup | SHORT setup |
|---|---|---|---|
| E1 | RSI(14), 1h | 45–65 (moving, not exhausted) | 35–55 |
| E4 | Runway | ≥ 3.0% to nearest resistance | ≥ 3.0% to nearest support |
| E5 | Feasibility | Required 3% move ≤ 1.5 × ATR(14, 1h)% × hours remaining to time stop | Same |

**Trigger criteria (5-minute bars + live stream):**

| # | Criterion | LONG setup | SHORT setup |
|---|---|---|---|
| E2 | Session-adjusted relative volume, 5m | ≥ 1.5 vs. the average volume of the *same 5-minute slot* over the prior 20 sessions | Same |
| E3 | Live VWAP alignment | Live price above session VWAP | Live price below session VWAP |
| E8 | Micro-trigger | Live price breaks the high of the prior completed 5-minute bar | Live price breaks the low of the prior completed 5-minute bar |

**Context criteria (both timeframes):**

| # | Criterion | Rule |
|---|---|---|
| E6 | Session window | New entries 15:45–18:00 CET only |
| E7 | Event blackout | No earnings or configured high-risk date within the blackout window (Section 4.6), unless the operator explicitly overrides |

Resistance and support (E4) are defined as the nearest of: prior-day high/low, the highest/lowest swing point of the trailing 10 trading days, and the classic floor-trader pivot levels (R1/R2/S1/S2) computed from the prior day's H/L/C. The dashboard displays which level is binding.

A name whose structure criteria hold is an **ARMED** setup; it becomes a **LONG / SHORT signal** only when the trigger criteria fire while armed. This two-stage display matches how the strategy is actually traded: structure is read calmly in advance, triggers are acted on in minutes. A signal is displayed only when every **enabled** criterion holds and the Section 4.2 gates pass. The application never displays a probabilistic "score"; under any given configuration, a setup either qualifies or it does not.

### 4.4 Indicator review log (what was challenged, added, and rejected)

The v0.9 indicator stack was formally challenged before revisions 1.1–1.3. Decisions, so the committee sees the reasoning and not just the result:

**Added.** *VWAP* (E3) replaces the v0.9 "price vs. 20-bar MA" alignment check: VWAP is the intraday institutional reference price, defines which side controls the session, and resets daily, matching the strategy's horizon; from v1.3 it is computed live from the trade stream rather than approximated from hourly bars. *Session-adjusted relative volume* (E2) replaces plain trailing relative volume: intraday volume follows a U-shape, so an unadjusted ratio systematically over-signals at the open and under-signals midday; from v1.3 it is evaluated per 5-minute slot. *Feasibility* (E5): a 3% runway is meaningless if current volatility cannot deliver 3% in the remaining time. *Regime gates* (G1–G2): the largest single risk to a leveraged long-momentum book is a market-wide risk-off day, which no single-name indicator detects. *Micro-trigger* (E8, new in v1.3): with minute-level data available, entering on the break of the prior 5-minute extreme replaces entering "somewhere inside the hour", tightening effective entry prices and making simulated and live entries comparable. *Per-name beta* (new in v1.3, screening output): feeds the beta-weighted exposure bucket (5.6) — an adaptation of the rolling-beta diagnostic from the course's quantitative lesson, applied because a two-long high-beta book is a leveraged index bet in disguise.

**Considered and rejected.** *ADX trend-strength filter*: correlated with what E1+E3 already capture; displayed in the drill-down as context, not gated on. *MACD on 1h*: lags at this horizon; retained only as a daily-timeframe display in the overview. *Bollinger-band position*: substantially duplicates the RSI band. *Mean-variance optimizers (min-variance, max-Sharpe)*: assessed from the course material and rejected for this strategy — they allocate a static book on daily covariance, while this book holds 0–2 tactical positions for hours; risk budgeting (5.6) is the correct tool. *Order-flow / bid-ask imbalance data*: genuinely additive but unavailable on any free tier; recorded as a Phase 2 upgrade in the compromise register (C1). *LLM-scored news sentiment as an entry criterion*: rejected on principle — sentiment stays in the commentary layer, never in the signal path.

### 4.5 Exit rules and live monitoring

| Exit | Rule |
|---|---|
| Target | +3.0% in the underlying (limit order at entry) |
| Stop | −0.8% in the underlying, hard, placed mechanically at entry, never widened |
| Time stop | Close after 5 hours in position, or by 21:45 CET, whichever is earlier |
| Overnight | No positions held overnight, without exception |

Because the stop is tight relative to intraday noise, open positions are monitored on the live stream: the position monitor (FR-A16) shows live distance to stop and target and raises visual/audible alerts at configurable proximity thresholds and ahead of the time stop. Alerts inform the operator; exits are executed on the broker platform, never by the application.

### 4.6 Key-date risk (earnings and scheduled events)

Scheduled binary events are the enemy of a stop-based leveraged strategy: an earnings gap does not respect a −0.8% stop. The application therefore treats key dates as first-class data:

- **Earnings blackout window:** from the close of the session before the announcement to the close of the session after it (T−1 close through T+1 close).
- **Macro high-risk dates** (FOMC decisions, CPI releases) are maintained in a versioned `key_dates.json`, refreshed at each monthly screening, and complemented at run time by Riskline macro alerts.
- **Operator-in-the-loop pause:** when a watchlist name enters a blackout window, the dashboard badges it and asks the operator explicitly whether to pause the name (FR-A8/FR-A9). Pausing is the default; trading through an event requires an explicit, logged override.

### 4.7 Parameter governance and optimization protocol

Module C makes every criterion toggleable and every threshold editable. Combined with Module B, this is a curve-fitting machine unless governed; an optimized configuration that merely memorizes the tuning period would fail exactly when capital is at risk. The following protocol is therefore part of the strategy, not an appendix:

1. **Baseline lock.** The committed `config.js` is the baseline. Live signal evaluation in Module A *always* runs on the baseline. Experimental presets exist only inside Modules B and C.
2. **Preset identity.** Every configuration (baseline included) has a deterministic short hash computed from its parameter values. Every simulation result is stamped with the hash of the configuration that produced it; results from different configurations are never displayed as comparable without their hashes.
3. **Tuning / validation split.** Simulation date sets are labeled either *tuning* or *validation*. Parameters may be freely explored against tuning dates. A preset run against validation dates is locked first (no further edits without becoming a new preset with a new hash). Promotion of a preset to the new baseline requires: performance on validation dates it was never tuned on, a written one-paragraph rationale for *why* the change should work (mechanism, not just metrics), and a version-controlled commit of the new `config.js`.
4. **Degrees-of-freedom budget.** Per optimization phase, at most **three** parameters may differ from baseline in any candidate preset. Sweeping many parameters simultaneously guarantees a spurious winner somewhere; a three-parameter budget keeps every change explainable.
5. **Change log.** Module C maintains an append-only log of preset creations, promotions, and rationales, exportable for the IC appendix.

This protocol is itself an IC talking point: the committee is shown not only the strategy but the discipline that prevents its own optimization tooling from deceiving its operator.

## 5. Risk management framework

### 5.1 Position risk

Stop discipline at 10x leverage is the entire risk model at the position level: a −0.8% adverse move is −8% on the position and, at maximum position size, approximately −1.6% of account equity. Stops are entered as resting orders at the moment of entry, not managed discretionarily. The live position monitor (4.5) exists to keep the operator ahead of the stop, never to negotiate with it.

### 5.2 Account-level limits

| Limit | Value | Consequence when hit |
|---|---|---|
| Max capital per position | 20% of account equity | Larger signals are not scaled up |
| Max concurrent positions | 2 | Additional signals are logged, not traded |
| Daily loss limit | −3% of account equity | No new entries until next session |
| Weekly circuit breaker | −6% of account equity | Trading suspended; written review before resumption |

### 5.3 Strategy-level kill criteria

The strategy is suspended and formally reviewed if any of the following occurs: rolling 30-trade hit rate below 15%; average stop slippage above 0.15pp over 20 stops; or three consecutive daily loss-limit hits. Kill-criteria status is computed automatically from the Module D trade journal and displayed persistently (FR-D11), so suspension triggers are watched by the system, not by memory.

### 5.4 Human-in-the-loop design (Knight Capital lesson)

Knight Capital lost USD 440M in 45 minutes in 2012 because deployed code executed autonomously with no effective human oversight or kill mechanism. This strategy is designed as the counter-example within its own (much smaller) scope: the application **signals and monitors**; a human **executes**. There is no order routing, no broker API, no automation of any execution step — this remains true even though the application now holds a live data stream capable in principle of feeding one. All account-level limits are operator-enforced checklist items surfaced by the dashboard, not silent background logic. The kill criteria are pre-committed in writing here, before the first trade, so that stopping is a rule, not a decision made under loss. The key-date pause dialogue (4.6) and the baseline lock (4.7) extend the same principle to scheduled event risk and to the optimization tooling itself.

### 5.5 Strategy monitoring KPIs (running the strategy)

Entry indicators identify trades; these KPIs judge the strategy. They are computed automatically from the Module D trade journal (7.4) and reviewed weekly; the kill criteria in 5.3 are defined on them.

| KPI | Definition | Why it matters here |
|---|---|---|
| Hit rate | Winners ÷ closed trades, rolling 30 | Direct test against the 21% breakeven and 15% kill line |
| Profit factor | Gross wins ÷ gross losses | Overall edge, robust to hit-rate noise |
| Expectancy per trade | (HitRate × AvgWin) − ((1−HitRate) × AvgLoss) | The number the IC actually funds |
| Average MAE | Mean maximum adverse excursion of *winning* trades | Validates the −0.8% stop: if winners routinely draw down −0.6% first, the stop is too tight and the hit rate is being artificially destroyed |
| Average MFE | Mean maximum favorable excursion of *losing* trades | Validates the +3% target: if losers routinely reach +2% first, a partial-take rule deserves study |
| Stop slippage | Realized exit vs. stop level, per stop | Feeds kill criterion; measures the leverage instruments' real cost |
| Time in trade | Distribution of holding periods | Tests the 3–5h horizon assumption and the 5h time stop |
| Exposure | % of sessions with ≥1 open position | Detects overtrading against the 2-position limit |
| Rolling Sharpe (30-trade) | Annualization-free Sharpe on the per-trade return series | Trend of risk-adjusted edge over time, adapted from the course's rolling-diagnostics lesson to the trade level |
| Realized book beta | Beta of daily strategy P&L vs. SPY over the trailing month | Detects whether the "stock-picking" strategy has quietly become a leveraged index bet |

### 5.6 Risk buckets and intra-period position sizing

Section 5.2 caps the book; this section allocates within it. Sizing is fully mechanical and implemented by Module D.

**Sizing formula (equal-risk, default).** Each trade risks a fixed fraction *r* of account equity (baseline r = 1.5%). With stop distance *s* in the underlying (baseline 0.8%) and leverage *L* (baseline 10x), position size as a fraction of equity is *r ÷ (s × L)* — at baseline, 1.5% ÷ 8% ≈ 18.75% of equity, consistent with (and formalizing) the 20% cap in 5.2. The daily loss limit of −3% therefore budgets exactly two full-size stopped trades per day: the limits in 5.2 and the sizing rule here are one coherent system, not independent knobs.

**ATR-scaled variant (configurable).** A name whose 1h ATR% exceeds the watchlist median is sized down proportionally (multiplier = median ATR% ÷ name ATR%, capped at 1.0), keeping the stop at 0.8% but acknowledging that faster names reach stops more easily. The R:R of the strategy is unchanged; only exposure per name varies. Conceptually this is inverse-volatility weighting applied at the trade level rather than to a static book.

**Risk buckets.** The daily risk budget (3%) is tracked against these buckets; a new signal that would breach any bucket is displayed but marked NOT SIZEABLE with the binding bucket named:

| Bucket | Baseline cap | Rationale |
|---|---|---|
| Per-trade risk | 1.5% of equity | The unit of the whole system |
| Concurrent positions | 2 | Attention and correlation control |
| Per correlation cluster | 1 full-size position (a second signal in the same cluster may be taken at half size, configurable) | Two 0.7-correlated names at 10x are one double-sized bet wearing two tickers |
| Per direction (net) | 2 long / 2 short; no constraint on 1-and-1 | A 2-long book is a leveraged market bet; visible, capped, never accidental |
| Beta-weighted net exposure | Σ (position notional × beta × direction) ≤ 450% of equity (configurable, FR-C1) | Direction caps count positions; this bucket counts *market* exposure — two high-beta longs consume it faster than two defensives. The 2026-08 watchlist carries two names with 60d beta > 5: the allocator scales such positions down to exactly exhaust the cap's remaining headroom (FR-D4's "size at which it would fit" — e.g., beta 5.2 → 8.65% instead of 18.75% of equity), verified by engine unit test |
| Drawdown throttle | Equity > 4% below its high-water mark → all new positions at half size until recovery | Anti-martingale: size down when losing, never up |

## 6. Data architecture and sources

Minute-grade decisions need minute-grade data, and free tiers make that genuinely hard. The architecture below is the best free-tier solution found after assessing the current provider landscape; every compromise accepted to stay free is recorded in 6.3. The load-bearing insight: **WebSocket connections are not subject to browser CORS restrictions**, so a static GitHub Pages SPA can hold a real-time stream directly, with no backend and no proxy.

### 6.1 Three-layer architecture

**Layer 1 — Live stream (seconds).** An Alpaca free-tier WebSocket (`wss://stream.data.alpaca.markets/v2/iex`, real-time IEX trades, 30-symbol subscription cap — fits 20 names plus SPY) delivers live trades. From this stream the application builds, client-side: the live last price per name, 1-minute and 5-minute bars, the running session VWAP (Σ price×volume ÷ Σ volume over streamed trades), the E8 micro-trigger state, and the position monitor's distance-to-stop/target. Alpaca replaced Finnhub as Layer 1 after the 2026-08-04 verification spike showed Finnhub's free WebSocket streaming only a restricted popular-symbol subset: in a live-market test, AAPL and TSLA streamed while SPY, MU, and DELL produced no trades and no error frames (compromise C9). The Finnhub WebSocket is no longer used; Finnhub's REST earnings calendar is (Layer 3).

**Layer 2 — Bars on demand (minutes).** Twelve Data REST (CORS-friendly, 8 credits/min, 800 credits/day) supplies 1-hour bars for structure criteria, 5-minute history to seed relative-volume baselines (the same-slot averages over 20 sessions, fetched once per name per day and cached), backfill for stream gaps, historical intraday bars for Module B — and, since v1.6, the overview table's quotes (`/quote`, one credit per symbol, chunked to ≤8 symbols per call through the FR-A5 queue; ~21 credits per refresh). Daily budget check: 20 names × (1 structure refresh + 1 baseline seed) + quote refreshes + drill-down and simulator traffic still fits inside 800 credits with the throttle queue.

**Layer 3 — Reference and context (hours to days).** FMP for the two regime inputs only (SPY quote, ^VIX level — see C9); Finnhub REST earnings calendar for blackout dates (browser CORS verified 2026-08-04, correcting the v1.5 assumption that Finnhub REST was browser-unreliable); quantmod/Yahoo in R for the monthly screen; newsdata.io / NewsAPI / Riskline for LLM context; OpenRouter for the desk note.

### 6.2 Source table

| Source | Auth | Free-tier limits | Used for |
|---|---|---|---|
| Alpaca Market Data WebSocket (`wss://stream.data.alpaca.markets/v2/iex`) | API key pair (paper account sufficient) | Free: real-time IEX trades, 30-symbol subscription, 1 concurrent connection | Layer 1: real-time trades → live prices, client-side 1m/5m bars, session VWAP, micro-trigger, position monitor |
| Twelve Data (`/time_series`, `/quote`) | API key | 8 credits/min, 800 credits/day, US symbols; batch requests cost 1 credit per symbol | Layer 2: 1h structure bars, 5m baseline/backfill, historical intraday for Module B, one daily-bar call for the SPY 20-DMA, overview quotes (chunked ≤8/call) |
| Finnhub REST (`/calendar/earnings`) | API key (token param) | Free plan, 60 req/min; **WebSocket unusable: free tier streams only a popular-symbol subset (C9)** | Layer 3: next earnings dates for the blackout logic (one calendar call covers the watchlist); browser CORS verified 2026-08-04 |
| Polygon.io | API key | Free: 5 req/min, delayed data, multi-year minute history | Documented **backup** for Module B historical minute bars |
| Financial Modeling Prep (`/stable/quote`) | API key | 250 req/day; **free tier is symbol-restricted for post-Aug-2025 keys** — SPY/^VIX served, most watchlist names 402; batch and legacy `v3` endpoints unavailable (C9) | Layer 3: regime inputs only (SPY quote, ^VIX level) |
| Yahoo Finance via quantmod (R only) | none | keyless | Monthly screen, correlation clusters, rolling betas — following the course data-prep pattern; never called from the browser |
| newsdata.io (`/api/1/latest`) | API key | 200 credits/day (10 articles/credit), 30 credits/15 min, **articles ~12h delayed on free plan**, commercial use permitted, browser-callable | Headlines for the LLM commentary on the deployed site; labeled as delayed context, never a trading input |
| NewsAPI (`/v2/everything`) | API key | 100 req/day; browser calls from localhost only | Fresher headlines in local development and demo recordings |
| Riskline (`/alerts/latest.json`) | none | unauthenticated | Macro alerts for LLM context, alongside `key_dates.json` |
| ApeWisdom / Tradestie | none | public endpoints | Screening-time candidate funnel only (3.2); called from R |
| OpenRouter (`/api/v1/chat/completions`) | API key | per-account credits | LLM desk note, using the CO-STAR prompt structure |

API keys are entered at run time in form fields and are never committed to the repository or shipped in source.

### 6.3 Compromise register (accepted to stay on free tiers)

| # | Compromise | Consequence | Mitigation / Phase 2 exit |
|---|---|---|---|
| C1 | Single-venue trade stream (Alpaca free tier = IEX-only feed) instead of the consolidated SIP tape | Live prices, VWAP, and relative volume are computed from a fraction of consolidated volume; VWAP is an approximation of the "true" institutional VWAP | Signals tolerate small VWAP error (binary above/below); final entry/exit prices are confirmed on the broker platform, which carries real-time consolidated quotes. Phase 2: paid SIP feed (Polygon/Databento) |
| C2 | Client-side bar aggregation runs only while the tab is open | Bars and session VWAP have gaps after a tab close or disconnect | Automatic backfill of 5m bars from Twelve Data on reconnect (FR-A17); VWAP re-seeded from backfilled bars (volume-weighted midpoint approximation, labeled in UI) |
| C3 | Twelve Data 800 credits/day | Caps refresh cadence: structure bars refreshed hourly, baselines seeded once daily; ad-hoc drill-downs and simulator runs share the remainder | Throttle queue with visible budget meter (FR-A5); Layer 1 carries the real-time load, so REST cadence is genuinely sufficient |
| C4 | FMP free-tier quotes may be delayed | Overview table and regime inputs are minutes-stale | Overview and gates tolerate minutes of staleness by design; nothing entry-critical reads Layer 3 prices; live prices always come from Layer 1 |
| C5 | Historical minute-data depth and adjustment quality vary on free tiers | Module B uses 5-minute resolution where available, falling back to 1-hour for older dates; split/dividend adjustments are provider-dependent | Resolution and provider are stamped on every simulation result; the conservative same-bar rule (FR-B4) bounds intrabar ambiguity pessimistically |
| C6 | No uptime SLA on any free source | The stream or any REST source can drop mid-session | Per-source graceful degradation with the provider's actual error (global constraint); stream-status indicator with last-tick age (FR-A15); the operator's broker platform remains the execution-grade source of truth |
| C7 | No free order-flow / depth-of-book data | The strategy cannot see bid-ask imbalance, a genuinely useful momentum input | Recorded as rejected-for-now in 4.4; Phase 2 upgrade path via paid feeds |
| C8 | The trade journal persists only in browser localStorage (static hosting, no backend, no accounts) | Clearing browser data or switching devices loses the book, its KPI history, and kill-criteria state | Export prompts after every closed trade and weekly; JSON/CSV export/import round-trip (FR-D10); the operator can commit exported journals to a private repository |
| C9 | Free-tier symbol restrictions, discovered by the 2026-08-04 verification spike: FMP's free tier for post-Aug-2025 keys serves only a popular-symbol subset (SPY/^VIX yes; most watchlist names HTTP 402) with batch and legacy `v3` endpoints unavailable, and Finnhub's free WebSocket streams only that same kind of subset (verified live: AAPL/TSLA ticking, SPY/MU/DELL silent, no error frames) | FMP demoted to regime inputs only; Layer 1 moved from Finnhub to Alpaca; overview quotes moved to Twelve Data, so the initial table fill is progressive (~3 minutes for 20 names at 8 credits/min) instead of a single batch call | Regime banner still renders within 3 s (two FMP calls, NFR-2); the Alpaca live stream overtakes REST quotes within seconds during market hours; earnings move to one Finnhub REST calendar call. Phase 2 exit: any paid tier restores batch quotes |

## 7. Application behavior — functional requirements

The application extends the course Vite template (Repo 3): static SPA, no backend, deployed to GitHub Pages via the existing GitHub Actions workflow on every push to `main`.

**Global constraints (apply to every requirement):** static hosting only; all indicator math implemented in plain JavaScript in the repository; every external call degrades gracefully with the provider's actual error message; no API key ever committed; the baseline configuration lives once in `config.js` with every Section 4–5 threshold, and runtime presets (Module C) are overlays on it, stored client-side and exportable as JSON.

### 7.1 Module A — Live dashboard

| ID | Requirement |
|---|---|
| FR-A1 | On page load, fetch the two regime inputs (SPY quote, ^VIX level) via FMP and one Twelve Data daily-bar call for SPY to compute its 20-DMA, rendering the regime banner within 3 seconds (NFR-2); fetch overview quotes for the 20 watchlist names via Twelve Data `/quote` in ≤8-symbol chunks through the FR-A5 queue, filling the table progressively (~3 minutes worst case; C9), with per-name 50/200-DMA trend state read from the committed screening data in `watchlist.json` until live data refines it. |
| FR-A2 | The regime banner persistently shows G1/G2 state (LONGS OK / SHORTS OK / STAND DOWN) with the underlying values (SPY vs. 20-DMA, VIX level). |
| FR-A3 | The overview table shows, per name: ticker, live price (Layer 1, falling back to Layer 3 with a staleness label), day change %, volume vs. average, 50/200-DMA trend state, directional bias tag, correlation-cluster ID, beta, earnings-date proximity badge, pause state, an IN-BOOK badge when the name has an open position, and setup state (IDLE / ARMED / LONG / SHORT). |
| FR-A4 | Selecting a ticker triggers a drill-down: structure criteria (E1, E4, E5) computed from Twelve Data 1h bars; trigger criteria (E2, E3, E8) computed from client-side 5m bars, live VWAP, and the live price; every enabled criterion rendered individually as pass/fail with its computed value and timeframe; ADX(14) displayed as context, not gated on. Module A always evaluates the locked baseline configuration (Section 4.7). |
| FR-A5 | REST requests are throttled through a queue respecting Twelve Data's 8 req/min limit, with sessionStorage caching (5-minute TTL for bars, 24h for relvol baselines) and a visible daily-budget meter; the UI shows queue position while loading. |
| FR-A6 | A risk panel embeds Module D (Section 7.4): given account equity and open positions, it shows the sized allocation for any live signal and current bucket utilization. |
| FR-A7 | On load, the application determines the next earnings date for each watchlist name via a single Finnhub REST calendar call (names absent from the calendar fail safe to "unknown" and are badged per Section 4.6) and merges configured macro dates from `key_dates.json`. |
| FR-A8 | When a name is inside a blackout window (Section 4.6), the application badges it and presents a pause dialogue: "TICKER reports on DATE — pause this name through T+1?" Default action is Pause. |
| FR-A9 | Pause decisions and explicit overrides are persisted for the session and rendered in the overview; an override never removes the warning badge. |
| FR-A10 | A "desk note" panel calls OpenRouter with a system prompt containing: current regime state, setup states for all names, active blackout badges, bucket utilization, Riskline alerts, and available headlines. The prompt follows the CO-STAR structure (context, objective, style, tone, audience, response format), and the note summarizes which setups are live and whether conditions argue for standing down. |
| FR-A11 | Third-party text (headlines, Riskline alerts) is passed to the LLM explicitly marked as untrusted data with an instruction to ignore any instructions it contains. |
| FR-A12 | News sourcing is environment-aware: NewsAPI on localhost, newsdata.io when deployed, with the active source and its data delay stated in the UI. |
| FR-A13 | The session-window state (pre-market / entry window open / entries closed / market closed, per E6) is computed in CET and displayed persistently in the header. |
| FR-A14 | The watchlist (tickers, bias tags, cluster map, betas, screening date) and `key_dates.json` are loaded from versioned repository files, so every screening refresh is auditable through Git history. |
| FR-A15 | On load, the application opens the Alpaca IEX WebSocket for all watchlist names plus SPY, aggregates trades into client-side 1m/5m bars and the running session VWAP, and displays a stream-status indicator (CONNECTED / DEGRADED / DOWN) with the age of the last tick; automatic reconnection with exponential backoff (authentication errors surface as DOWN without a retry storm). |
| FR-A16 | The position monitor is the live face of the Module D journal: opening a position records an entry fill (FR-D7); for each open position it shows live distance to stop and target in underlying % and leveraged %, elapsed time against the 5h time stop and the 21:45 CET hard close, and records running MAE/MFE from the stream (FR-D8). It raises a visual and audible alert when price comes within a configurable proximity of the stop or target and 15 minutes before either time limit. Alerts inform; they never execute. |
| FR-A17 | On stream reconnect or tab reopen during a session, the application backfills missing 5-minute bars from Twelve Data and re-seeds the session VWAP from backfilled bars, labeling it as re-seeded until live trades resume. |
| FR-A18 | Every data-bearing panel carries a provenance label naming its source and latency class (LIVE-VENUE / REST-CACHED / DELAYED / EOD), so the operator always knows what quality of data a number rests on (compromise register C1–C5 made visible). |

### 7.2 Module B — Point-in-time simulator

| ID | Requirement |
|---|---|
| FR-B1 | The operator selects a historical date, an entry time (default 16:00 CET), either one ticker or "scan watchlist", and the configuration preset to simulate under (default: baseline). |
| FR-B2 | The application fetches intraday bars (5-minute resolution where the provider carries it for that date, otherwise 1-hour, stamped on the result) spanning 30 trading days before through 2 trading days after the selected moment, and evaluates the enabled criteria and gates G1–G2 **using only bars up to the selected moment** — strict point-in-time discipline; the E8 micro-trigger is evaluated against the prior completed bar at the simulation's resolution. |
| FR-B3 | If a setup qualifies, the simulated entry is the open of the bar following the selected moment; the engine then walks subsequent bars and reports which came first: target, stop, or time stop, at the preset's configured levels. |
| FR-B4 | When a single bar's range contains both the target and the stop, the engine assumes the **stop was hit first** (conservative same-bar rule), and labels the trade accordingly; at 5-minute resolution this rule binds far less often than at 1-hour, which is stated in the caveats. |
| FR-B5 | The result view shows: WIN / LOSS / TIME-OUT, underlying % move, leveraged % move, P&L on a Module D-sized position, the preset hash, the bar resolution and provider used, and a chart of the episode with entry, stop, target, and the binding runway level drawn in. |
| FR-B6 | Scan mode runs the same evaluation across all 20 names through the FR-A5 throttle queue (progress and cancel controls shown) and renders a summary table of qualifying setups and their outcomes for that day. |
| FR-B7 | Every simulation view displays its caveats: today's watchlist applied to a past date (survivorship bias), bar-resolution limits and the conservative same-bar rule, simulated VWAP built from bar data rather than the live tape, no slippage, financing, or fee modeling, and provider price adjustments. Simulations are illustrations of mechanics, not a backtest, and the UI says so. |
| FR-B8 | Every stored or displayed simulation result carries the hash of the configuration preset that produced it (Section 4.7); results with different hashes are visually separated in any list or comparison. |

### 7.3 Module C — Configuration & optimization workbench

| ID | Requirement |
|---|---|
| FR-C1 | A configuration page exposes every signal parameter as an editable control: per-criterion enable/disable toggles (E1–E8, G1, G2) and threshold editors for RSI bands (per direction), relative-volume multiple and slot length, runway %, feasibility multiplier, session-window start/end, blackout window length, VIX cap, SPY MA period, target %, stop %, time-stop hours, alert proximity thresholds, and the Module D sizing parameters (r, cluster half-size rule, beta-exposure cap, drawdown throttle level). |
| FR-C2 | Every control displays its baseline value alongside the current value; any deviation from baseline is visually marked, and a one-click diff view lists all deviations of the active preset. |
| FR-C3 | Configurations are saved as **named presets** with automatically computed hashes (Section 4.7); presets can be exported and imported as JSON files so tuning work survives browser storage loss and can be committed to the repository. |
| FR-C4 | Editing any parameter of a preset that has validation-run results creates a new preset with a new hash; results never silently migrate between configurations. |
| FR-C5 | The workbench includes a **batch runner**: the operator defines a date list (or date range sampled at a chosen weekday/time), selects one or more presets, and the runner executes Module B scan-mode simulations for each (date × preset) combination through the throttle queue, with progress and cancel controls. |
| FR-C6 | Batch results aggregate per preset: number of signals, hit rate, expectancy per trade at Module D sizing, average MAE/MFE of simulated episodes, and time-out share — presented side by side with baseline results, preset hashes, and the bar resolutions used. |
| FR-C7 | Date lists are labeled **tuning** or **validation** (Section 4.7). Running a validation list locks the preset first and the UI says so; the batch-results view separates tuning from validation outcomes and never aggregates them together. |
| FR-C8 | The workbench maintains an append-only optimization log (preset created / locked / promoted, with operator rationale text), exportable as JSON or Markdown for the IC appendix. Promotion to baseline is a manual repository commit of `config.js`; the UI displays the instruction rather than performing it. |
| FR-C9 | The page shows a persistent warning when the active preset differs from baseline in more than three parameters (degrees-of-freedom budget, Section 4.7), and batch results for such presets are badged accordingly. |

### 7.4 Module D — Risk allocator & trade journal (intra-period portfolio tool)

| ID | Requirement |
|---|---|
| FR-D1 | The allocator reads the journal's book state: starting equity (entered once), open positions, and realized P&L — from which current equity, the high-water mark, and the drawdown-throttle state are derived automatically; the set of currently qualifying signals comes from the signal engine. |
| FR-D2 | For each qualifying signal, it computes the mechanical position size per Section 5.6 (equal-risk default; ATR-scaled variant when enabled), in % of equity, instrument units, and EUR/USD nominal. |
| FR-D3 | It evaluates every bucket (per-trade risk, concurrent positions, correlation cluster, direction, beta-weighted net exposure, drawdown throttle) and renders a **bucket board**: consumed vs. available risk per bucket, with the daily budget as a gauge. |
| FR-D4 | A signal that would breach any bucket is shown as NOT SIZEABLE with the binding bucket named and the size at which it would fit (e.g., half size under the cluster rule); the signal itself is never hidden. |
| FR-D5 | The allocator recomputes live as the operator edits the book (adding a fill, closing a position), so intra-period reallocation — the answer to "how much can go where, right now" — is always current. |
| FR-D6 | A what-if mode lets the operator tentatively add a hypothetical position and see resulting bucket utilization before deciding; hypotheticals are visually distinct and never persist. |
| FR-D7 | Recording an **entry fill** captures: ticker, direction, size (% of equity, units, nominal), entry timestamp, and entry price — timestamp and price prefilled from the clock and the Layer 1 live price but always operator-editable, because the record of truth is the broker fill, not the app's tape. Open-position records remain editable until closed, with an edited flag. |
| FR-D8 | Each entry fill is automatically enriched with a **signal snapshot**: the values and pass/fail states of every criterion at entry, the regime state, and the baseline preset hash — so every recorded trade is later attributable to the exact conditions that produced it. While a position is open, running MAE and MFE are tracked from the live stream; stream gaps are backfilled approximately from 5-minute bars and marked as approximate. |
| FR-D9 | Recording an **exit fill** captures exit timestamp, exit price (prefilled, editable), and exit reason (TARGET / STOP / TIME / MANUAL); the position moves from the open book to the journal with realized P&L computed in underlying %, leveraged %, and account currency. |
| FR-D10 | The journal persists in browser localStorage and is exportable and importable as JSON and CSV; the application prompts for export after every closed trade and weekly, because client-side storage is the only persistence available on static hosting (compromise register C8). |
| FR-D11 | A KPI dashboard computes every Section 5.5 metric from the journal, and a kill-criteria panel shows live distance to each Section 5.3 threshold (e.g., current rolling-30 hit rate vs. the 15% line), turning suspension rules into a permanently visible instrument. |
| FR-D12 | The journal view renders a filterable trade table and the account equity curve; each closed trade offers a one-click **replay** that opens Module B at the trade's entry moment under the trade's recorded preset hash, so any past decision can be re-examined through the same engine that produced it. |

### 7.5 Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Static hosting only; no server-side components; bundle suitable for GitHub Pages. |
| NFR-2 | Overview table and regime banner render within 3 seconds of load on a standard connection; the live stream connects independently and does not block first render. |
| NFR-3 | A persistent notice states: signals and simulations only — not financial advice, no automated execution. |
| NFR-4 | All indicator math and the signal engine are provider-agnostic pure functions over OHLCV/trade arrays plus a configuration object, behind data-adapter interfaces (stream adapter, bars adapter, reference adapter), so providers are swappable (the v1.6 Finnhub→Alpaca stream swap exercised exactly this seam; Polygon remains the documented swap for Twelve Data) and the DAX leg needs only a new adapter and preset. |
| NFR-5 | Modules A, B, and C evaluate signals through the same engine code path; there is no separate simulation or tuning logic that could drift from live logic. Module D's sizing functions are likewise shared wherever a position size is displayed. |
| NFR-6 | Preset hashes are deterministic across sessions and machines (computed from a canonical serialization of parameter values), so equal hashes always mean equal configurations. |
| NFR-7 | Client-side bar aggregation is deterministic given the same trade stream (bars keyed to exchange timestamps, not arrival time), so two operators streaming the same session converge on the same bars. |

## 8. Out of scope (deferred or excluded)

**Deferred to Phase 2:** the DAX 40 leg (Section 2.2); consolidated SIP / order-flow data (compromise register C1, C7); a statistically serious backtest over years of data with slippage modeling (Module B deliberately simulates single moments and small batches, not full distributions); automated parameter search (grid search, genetic optimization — the batch runner compares operator-defined presets only, keeping a human rationale attached to every candidate); paid data tiers. **Excluded permanently:** automated order execution in any form (Section 5.4), including any use of the live stream to trigger orders; LLM sentiment as an entry criterion (Section 4.4); social-attention data in the live signal path (Section 3.2); live trading on any configuration other than the committed baseline (Section 4.7).

## 9. Known limitations and assumptions

Layer 1 prices come from a single venue rather than the consolidated tape, so live VWAP and relative volume are approximations (C1); the operator's broker platform remains the execution-grade source of truth for final entry and exit prices. Client-side bars exist only while the tab is open, mitigated but not eliminated by backfill (C2). Deployed-site news context is ~12 hours delayed and labeled as such. The 3% runway estimate assumes levels computed from daily history are meaningful intraday, which is an approximation. The strategy has no live track record; the hit-rate economics are a structural argument, Module B provides illustrative point-in-time evidence under the governance of Section 4.7, and Section 5.3 exists precisely because neither is proof. Batch simulation KPIs inherit every Module B caveat and additionally suffer selection effects from operator-chosen date lists; the tuning/validation split mitigates but does not eliminate this. Leveraged instruments introduce financing costs, and overnight gap risk is excluded only by the no-overnight rule, not hedged. Earnings-date data quality depends on the provider; the blackout logic fails safe by badging a name whenever its earnings date cannot be determined. Correlation clusters and betas are estimated monthly from daily returns and can go stale between screens. The trade journal is client-side only (C8): KPIs, MAE/MFE history, and kill-criteria monitoring are only as complete as the journal the operator maintains, preserves, and truthfully records — the application can prefill times and prices, but the broker's fills are the record of truth.

## 10. Acceptance criteria (definition of done)

**Module A** is complete when: the public GitHub Pages URL loads the overview table for all 20 watchlist names and the regime banner from live batch calls; the stream indicator shows CONNECTED with ticking last-trade ages during US market hours; at least one drill-down shows structure and trigger criteria as individual pass/fail rows with values and timeframes, and an ARMED name visibly transitions on a live micro-trigger; a recorded position shows live distance-to-stop and raises a proximity alert; a name with earnings inside the blackout window triggers the pause dialogue and a logged decision; the desk note renders live LLM output incorporating regime state, bucket utilization, and Riskline data; and every panel carries its provenance label.

**Module B** is complete when: a chosen (date, time, ticker, preset) produces a full evaluation using only point-in-time data at a stamped resolution; a qualifying historical setup renders the episode chart with entry, stop, and target and a WIN/LOSS/TIME-OUT verdict under the conservative same-bar rule; scan mode completes across the watchlist with visible progress; and every result view displays the FR-B7 caveats, its preset hash, and its resolution.

**Module C** is complete when: every Section 4–5 parameter is editable with baseline diff marking; presets save, export, import, and hash deterministically; a batch run across at least two presets and five dates produces the side-by-side KPI table with hashes and resolutions; a validation-labeled run demonstrably locks its preset; and the optimization log exports with at least one rationale entry.

**Module D** is complete when: a qualifying signal produces a sized allocation consistent with the Section 5.6 formula; the bucket board reflects an open position including beta-weighted exposure; a second same-cluster signal is shown at half size with the cluster named as binding; the what-if mode shows utilization for a hypothetical without persisting it; an entry fill recorded at a stated time and price appears as an open position with live MAE/MFE and its signal snapshot; closing it writes a journal row with entry/exit time, price, reason, and P&L in all three units; the KPI dashboard and kill-criteria panel recompute from the journal; a closed trade replays in Module B at its entry moment; and a journal export/import round-trip preserves the full book.

**Repository** is complete when: `watchlist.json` (with cluster map and betas) and `key_dates.json` are committed with screening dates; `config.js` contains every baseline threshold exactly once; the deployment workflow is green; and the repository is public.

## 11. Change log

**v1.6 (this version).** Provider pivot forced by the first free-tier verification spike (2026-08-04, run live during US market hours): Finnhub's free WebSocket proved symbol-restricted (AAPL/TSLA streamed; SPY/MU/DELL silent with no error frames) and FMP's free tier for new keys proved symbol-restricted with batch and legacy endpoints removed — both recorded as compromise C9. Layer 1 moved from Finnhub WS to the Alpaca IEX WebSocket (browser reachability verified; same single-venue compromise C1); overview quotes moved to Twelve Data `/quote` chunked through the FR-A5 queue, making the initial table fill progressive (FR-A1); earnings moved to a single Finnhub REST calendar call with fail-safe badging (FR-A7) after browser CORS was verified, correcting v1.5's untested assumption that Finnhub REST was browser-unreliable; FMP retained for exactly two regime inputs (SPY, ^VIX). Alpaca promoted from documented alternative to primary in the source table; spike page upgraded to v2 covering the new provider set. **v1.5.** Review-gate outcomes of the first screening run (2026-08-04): S3 volatility floor made adaptive — max(2.0%, liquid-universe median) — after data showed the fixed 2.0% floor passing 96% of liquid names; new S7 sector cap (max 6 per GICS sector) after the unconstrained rank produced a single-cluster watchlist; beta-exposure cap confirmed at 450% and marked explicitly as Module C-configurable (test-driven correction: the bucket scales to fit rather than halving, since halving a beta-5 name still breaches the cap); residual cross-sector cluster concentration delegated to the trade-time cluster rule. First `watchlist.json` (20 names, clusters, betas) and `key_dates.json` committed. **v1.4.** Added the trade journal to Module D: operator-recorded entry and exit fills (ticker, time, price, size, exit reason) with live-price prefill (FR-D7, D9); automatic signal snapshots and stream-tracked MAE/MFE per trade (FR-D8); localStorage persistence with export/import and reminders, recorded as compromise C8 (FR-D10); KPI dashboard and always-visible kill-criteria panel computed from the journal (FR-D11), closing the v1.3 gap where Section 5.5 referenced a trade log no requirement implemented; equity, high-water mark, and drawdown throttle now derived from the journal instead of manual entry (FR-D1); one-click Module B replay of any closed trade (FR-D12); position monitor and overview integrated with the book (FR-A16, FR-A3). **v1.3.** Reframed data as a three-layer architecture with a real-time WebSocket streaming layer (Finnhub free tier; WebSockets bypass CORS, enabling a live tape on static hosting) and an explicit compromise register C1–C7 for free-tier trade-offs (6). Split signal criteria into structure (1h) and trigger (5m + live) timeframes with an ARMED → SIGNAL two-stage display and a new E8 micro-trigger (4.3). Added live position monitor with stop/target proximity and time-stop alerts (4.5, FR-A16), stream status, backfill, and provenance labels (FR-A15, A17, A18). Added per-name betas and a beta-weighted net exposure bucket (4.1, 5.6, FR-D3), plus rolling Sharpe and realized book beta KPIs (5.5) — adapted from the course's quantitative-extension lesson where they serve the strategy; mean-variance optimizers assessed and rejected with rationale (4.4). Module B upgraded to 5-minute resolution where available, with resolution stamping (7.2). Stated explicitly that course material is a toolbox, not a constraint (1). **v1.2.** Parameter governance and optimization protocol; risk buckets and mechanical sizing; Module C workbench; Module D allocator. **v1.1.** DAX deferral; candidate funnel; regime gates; VWAP, session-adjusted relative volume, feasibility; indicator review log; key-date blackout; monitoring KPIs; newsdata.io; Module B simulator. **v0.9.** Initial draft.

---

*Prepared with AI assistance per course guidelines; the full AI conversation export accompanies the submission. All content human-reviewed and edited before submission.*
