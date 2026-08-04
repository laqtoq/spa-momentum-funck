# Signal Engine Implementation Plan

**Goal:** Provider-agnostic pure-function engine (indicators, levels/runway, signal evaluation, trade walker, sizing/buckets) with a zero-dependency test suite; the exact code Modules A/B/C/D will share.

**Architecture:** Plain ES modules, no runtime deps. Tests via node:test + assert. Indicator correctness proven against fixtures computed independently in Python from real market data (cross-language verification).

## Tasks
1. **Fixtures** — export real AAPL daily bars + synthetic 5m session; compute expected RSI(14, Wilder), ATR(14, Wilder), SMA, VWAP, session-slot relvol in Python → fixtures.json. VERIFY: values finite, spot-check plausibility.
2. **indicators.js** — rsi, atr, sma, sessionVWAP, slotRelVol. VERIFY: match fixtures within 1e-6 (rel).
3. **levels.js** — floor pivots (R1/R2/S1/S2), swing high/low (10d), binding level + runway%. VERIFY: hand-constructed cases with known answers.
4. **signal.js** — evaluate(config, ctx) → {state: IDLE|ARMED|LONG|SHORT, criteria[]}, honoring per-criterion enable flags + gates. VERIFY: baseline all-pass → signal; each criterion toggled failing alone → no signal; disabled criterion ignored.
5. **walker.js** — forward walk: target/stop/time-stop, conservative same-bar rule. VERIFY: 4 canonical cases incl. both-in-one-bar → STOP.
6. **sizing.js** — equal-risk size, ATR-scaled variant, all six buckets. VERIFY: 18.75% base case; SNDK beta-5.2 auto-halve; cluster half-size; drawdown throttle.
7. **Suite run** — all green or stop and fix.
