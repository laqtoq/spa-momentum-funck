# Position Monitor Implementation Plan (FR-A16)

**Goal:** Close the last gap in Module A — the live position monitor. For every open position: live distance to stop and target in underlying % and leveraged %, elapsed time against the 5h time stop and the 21:45 CET hard close, running MAE/MFE from the stream, and visual + audible alerts at proximity and time thresholds. Alerts inform; the app never executes.

**Architecture:** A new pure module `src/engine/monitor.js` computes every derived number and alert flag from (position, live price, now, cfg) — no DOM, no I/O, so Module B replays it unchanged (NFR-5). `src/core/live.js` gains a book-tracking side: it feeds stream ticks into MAE/MFE and exposes open positions on `state`. `src/main.js` renders the panel and owns the entry/exit fill forms (FR-D7/D9) and the audio latch. The journal in `src/core/store.js` already implements persistence, P&L, and export — this phase consumes it, it does not rewrite it.

**Tech stack:** Existing. No new dependencies. WebAudio oscillator for the audible alert (no binary asset committed).

## Scope boundary

In: FR-A16 in full, plus the FR-D7 / FR-D8 / FR-D9 slices it is "the live face" of — entry fill with prefill, signal snapshot, MAE/MFE, exit fill with reason and realized P&L, export prompt after close (FR-D10).

Out (later phases, do not creep): FR-D3 bucket board, FR-D11 KPI dashboard + kill-criteria panel, FR-D12 trade table / equity curve / replay, FR-D6 what-if mode.

## Interpretation calls (record here; FRD amend only if the user disagrees)

- **`alertProximityPct: 0.25` is read as percentage points of underlying distance remaining**, not 0.25% of price. At entry the stop sits 0.8pp away, so the alert fires with ~0.55pp of room left — a warning with time to act. Target alert uses the same 0.25pp rule against the 3.0pp target distance.
- **Time alert fires 15 min (`alertTimeMin`) before whichever limit binds first** — entry + 5h, or 21:45 CET.
- **MAE/MFE are stored as positive magnitudes in underlying %**, matching `store.js`'s existing `Math.max` accumulate and its test fixture `updateExcursion(id, 0.4, 1.1)`.
- **Alerts latch.** Each threshold fires once per position per crossing, re-arming only after price leaves the band. The render loop runs every 400ms; an unlatched beep would be unusable.

## Tasks

### Task 1 — Pure monitor module
- [x] `src/engine/monitor.js`: `stopPrice/targetPrice(pos, cfg)`, `monitorPosition(pos, livePrice, now, cfg)` returning `{ toStopPct, toTargetPct, toStopLevered, toTargetLevered, openPnlPct, openPnlLevered, minutesElapsed, minutesToTimeStop, minutesToHardClose, binding, alerts:{stop,target,time} }`
- [x] VERIFY: `node --test test/engine/monitor.test.js` — long and short symmetry; a long at entry shows exactly 0.8pp to stop / 3.0pp to target and 8%/30% levered; alerts off at entry, `stop` true at 0.25pp remaining, `time` true at 15 min before the binding limit; `binding` names time-stop vs hard-close correctly either side of 16:45 CET entry

### Task 2 — Excursion tracking from the stream (FR-D8)
- [x] `src/engine/monitor.js`: `excursion(pos, price)` → `{mae, mfe}` for one price; wire into `live.js` so each tick for a held ticker updates the journal via `updateExcursion`, and mark `approx:true` on the position when a stream gap > 60s occurred while it was open
- [x] VERIFY: extend `test/live.test.js` — fake trades on a held ticker move MAE/MFE monotonically and never shrink; a simulated DEGRADED→CONNECTED gap sets `approx`

### Task 3 — Book state on the live handle
- [x] `live.js`: accept an injected journal, expose `state.book()` (open positions with live price attached), and re-emit on tick so the panel refreshes; demo mode gets an in-memory journal so the panel is demo-able keyless
- [x] VERIFY: `node --test test/live.test.js` all green; opening a position through the handle appears in `state.book()` with a live price

### Task 4 — Entry fill form (FR-D7)
- [x] Drill-down gains a "Record entry" control for names in LONG/SHORT; form prefills ts (clock), price (live), and size from `allocate()`; every field editable; captures the signal snapshot + `presetHash` (FR-D8); sets `edited` when a prefill is changed
- [x] VERIFY: in demo mode, record a fill → it appears in the monitor panel; reload the page → it persists (localStorage); the snapshot carries the criteria array and the baseline hash

### Task 5 — Monitor panel UI + alerts
- [x] `index.html` + `style.css` + `renderMonitor()`: one row per open position with a dual-sided stop/target strip reusing the `.rw` visual language, levered numbers, elapsed/remaining clocks, MAE/MFE, provenance label (FR-A18); alert states colour the row and fire a latched WebAudio beep; a mute toggle
- [x] VERIFY: demo position with a hand-set entry price crosses into the stop band → row turns red and beeps once, not repeatedly; mute silences it; `npm run build` green

### Task 6 — Exit fill + close (FR-D9/D10)
- [x] Close control per row: prefilled exit ts/price, reason select (TARGET/STOP/TIME/MANUAL), writes through `closePosition`, then prompts a journal export (C8)
- [x] VERIFY: close a demo position → realized underlying % and levered % match hand-calculation; the export prompt appears; `state().closed` holds the trade after reload

### Task 7 — Docs + gate
- [x] Update `README.md` status, `HANDOVER.md` §5 and §11, and the FRD change log if any interpretation above was overridden; correct the §1 deadline (syllabus says TBD, not Aug 31)
- [x] VERIFY: full suite green — `node --test test/core.test.js test/engine/engine.test.js test/engine/indicators.test.js test/engine/monitor.test.js test/adapters.test.js test/live.test.js` — plus `npm run build`; commit referencing FR-A16

## Outcome (2026-09-07)

All seven tasks executed. **55/55 tests green** (9 new in `test/engine/monitor.test.js`, 3 new in `test/live.test.js`); `npm run build` green at 36.3 kB / 14.1 kB gzip. Demo-mode click-through verified in Chrome: seeded book → panel renders → alert classes correct (`al-stop`+`al-time` on the through-stop position, clean on the mid-flight one) → exit fill → realized +1.73% underlying / +17.33% levered, hand-checked → equity advanced 100,000 → 103,249 → export prompt raised.

**Two bugs caught by the click-through, both fixed:**
1. `fmtMin` split hours before rounding, so 179.5 min rendered `2h60`. Moved to `fmtDuration` in `monitor.js` and covered by a test — the reason it now lives in the pure module.
2. Every entry fill recorded `edited: true`. The prefill is rendered at 2 decimals, so the value read back never equalled the raw tape price. Now compared against what the operator was shown; both branches verified in the browser.

**Blocked, escalated, not implemented — demo mode cannot display a signal.** Verifying Task 4's entry-fill button needed a LONG state, which the committed demo dataset cannot produce (E1 RSI ~10, E2 0.85, E3 wrong VWAP side, E8 no break — seeded noise, not a staged scenario), and which E6 gates to 15:45–18:00 CET regardless. The click-through was completed under a temporary staged-data harness, reverted afterwards (`git diff` clean on `demo.js`/`config.js`/`session.js`). This blocks the narrated demo recording, not just this phase. Recorded as an open issue in HANDOVER §5 with the two options; the choice changes what demo mode asserts, so it is the user's call, not a silent fix.

## Addendum — demo-signal question resolved (2026-09-07)

The escalation above was answered: build a staged dataset so the desk demonstrates itself when the live entry window is not met. Implemented as **decision D9** (HANDOVER §9), not as an FRD amendment — demo mode is an implementation affordance and appears in no FR/NFR table.

`src/adapters/demo.js` rewritten: deterministic scripted bars anchored to `DEMO_ASOF` (Tue 4 Aug 2026, 16:30 CET), a scenario per long-bias name, per-ticker variation for the rest, and `demoContext()` moved in from `main.js` so app and test share one context shape. `main.js` gained a single `NOW()` seam — demo resolves to the as-of moment, live to the wall clock — used by the session pill, engine context, position clocks and fill prefills.

`test/demo.test.js` (6 tests) asserts the staged map through the real `evaluate()`: DELL LONG with zero failing criteria, LITE/PWR ARMED with structure passing and E8 failing, one distinct named failure per IDLE long, every short held by G1, and determinism across builds. **61/61 green**, build 37.5 kB / 14.6 kB gzip.

Click-through on the real demo path, no harness: equity → DELL drill-down → entry fill (prefilled 16:30, size 15.57% scaled to the β-cap, stop 479.19 / target 497.55) → monitor showing 0.80pp/8.0% to stop and 3.00pp/30.0% to target at entry → exit at target → **+3.00% underlying / +30.00% levered, equity 100,000 → 104,670**.

One further bug found and fixed: `fmtDuration` treated 0 as "over", so a freshly opened position's Held column read `over` instead of `0h00`. Only negative minutes mean over now.

Note for future sessions: editing a module mid-session triggers a Vite full reload, which drops any `window.confirm` stub used to keep the export prompt from blocking the browser. Re-stub in the same evaluation as the click.
