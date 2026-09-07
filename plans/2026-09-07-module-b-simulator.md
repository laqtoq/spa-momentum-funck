# Module B — Point-in-Time Simulator Implementation Plan (FR-B1–B8)

**Goal:** Replay the strategy at a chosen historical moment under strict point-in-time discipline. A (date, time, ticker, preset) produces a full criterion evaluation using only bars up to that moment; a qualifying setup walks forward to WIN / LOSS / TIME-OUT under the conservative same-bar rule and renders the episode with entry, stop, target and the binding runway level drawn in; scan mode runs the watchlist through the throttle queue with progress and cancel; every view carries its caveats, preset hash and bar resolution.

**Architecture:** `src/engine/simulate.js` holds the pure core — point-in-time slicing, context assembly, and the episode result — reusing `evaluate()` and `walkTrade()` unchanged (NFR-5: one engine code path for A/B/C, never a forked simulator). `src/core/sim.js` is the orchestrator with every provider call behind injected deps, mirroring `live.js`, so the whole data plane is testable with fakes. `main.js` renders the panel and the episode SVG.

**Tech stack:** Existing. Chart is hand-rolled inline SVG — no charting dependency.

## Scope boundary

In: FR-B1 inputs · FR-B2 point-in-time fetch and evaluation · FR-B3/B4 forward walk (walker exists, wire it) · FR-B5 result view with episode chart · FR-B6 scan mode with progress and cancel · FR-B7 caveats · FR-B8 preset-hash stamping and separation.

Out: FR-C5 batch runner across (date × preset) — Module C · FR-D12 one-click replay from the journal · storing simulation history.

## Interpretation calls (record here; FRD amend if overridden)

- **Point-in-time means `t <= moment`, and entry is the open of the *next* bar.** The moment's own bar is visible for evaluation only if it closed at or before the moment; the entry bar is never one the evaluation saw. This is the discipline the whole module exists to demonstrate, so it is enforced in a pure function with its own tests rather than by care at the call site.
- **VIX history is not reliably free.** `vixAt` is an injected dep; when it returns null, **G2 is stamped `not evaluated` rather than passed or failed**, and the result and caveats say so. Fabricating a VIX number to make a gate pass would corrupt exactly the discipline being demonstrated.
- **Earnings history likewise.** `earningsAt` is injected; unavailable means E7 is stamped `not evaluated`. Note that live mode's `inBlackout` fails *safe* (unknown → in blackout), which is right for trading and wrong for simulation — failing safe there would render every historical setup IDLE. The two behaviours are deliberately different and both are correct for their context.
- **Resolution is requested at 5-minute and falls back to 1-hour**, stamped on every result (FR-B2, compromise C5). The conservative same-bar rule binds far less often at 5m, which the caveat states.
- **Demo mode ships a canned episode** so the panel demonstrates itself keylessly, consistent with decision D9. Without it Module B is dead on the deployed URL and cannot appear in the narrated demo.

## Tasks

### Task 1 — Point-in-time core
- [x] `src/engine/simulate.js`: `sliceTo(bars, momentMs)`, `entryBar(bars, momentMs)`, and `simContext({bars5m, bars1h, daily, spyDaily, vix, moment, name, cfg})` → the same ctx shape `evaluate()` takes, built only from visible bars, plus `{resolution, notEvaluated:[]}`
- [x] VERIFY: `node --test test/engine/simulate.test.js` — a bar closing exactly at the moment is visible, the next one is not; the entry bar is strictly after the moment; ctx never contains a bar later than the moment (asserted by scanning every array); a null vix marks G2 not-evaluated instead of passing it

### Task 2 — Episode result
- [x] `src/engine/simulate.js`: `simulateOne(cfg, name, data, moment)` → `{state, criteria, resolution, qualified, entry:{ts,price}, walk, episode:[bars], levels:{stop,target,runway}, presetHash}`, reusing `evaluate()` and `walkTrade()` with no forked logic
- [x] VERIFY: same suite — a hand-built qualifying series produces LONG then a TARGET walk with the expected underlying %; a series where one bar spans both levels reports STOP (FR-B4); a non-qualifying series returns `qualified:false` with the failing criteria intact and no entry

### Task 3 — Orchestrator with injected providers
- [x] `src/core/sim.js`: `runSimulation({date, timeCET, ticker, cfg, watchlist}, deps)` fetching 30 trading days before → 2 after at 5m with a 1h fallback, SPY daily for the 20-DMA as of that date, `vixAt`, `earningsAt`; all through the FR-A5 queue
- [x] VERIFY: `node --test test/sim.test.js` with fakes — requests the right ranges; falls back to 1h and stamps it when 5m returns empty; a provider failure yields a result carrying the error, never a silent pass; the SPY 20-DMA uses only daily bars up to the date

### Task 4 — Scan mode (FR-B6)
- [x] `runScan({date, timeCET, cfg, watchlist}, deps, onProgress)` → per-name results with `{done, total, cancelled}` progress and a working cancel that stops further queue work
- [x] VERIFY: same suite — progress fires per name in order; cancel mid-run leaves the remaining names unfetched and the result marked cancelled; one name failing does not abort the scan

### Task 5 — Demo episode (keyless, decision D9)
- [x] Staged historical dataset in `src/adapters/demo.js` for one date/ticker that qualifies, so the panel runs with no keys
- [x] VERIFY: extend `test/demo.test.js` — the canned episode produces a qualifying setup and a decided outcome through the real engine

### Task 6 — UI: panel, episode chart, caveats
- [x] Module B panel: date, time (default 16:00 CET), ticker or scan, preset (baseline), Run/Cancel; result view with verdict, underlying and levered %, P&L on a Module D-sized position, preset hash, resolution and provider; inline SVG episode chart with entry, stop, target and the binding runway level; FR-B7 caveats always visible; scan summary table
- [x] VERIFY: demo click-through — canned episode renders end to end with the chart; caveats and hash visible; `npm run build` green

### Task 7 — Docs + gate
- [x] README, HANDOVER §5/§11, plan outcome; FRD compromise register if the VIX/earnings gap needs a C-entry
- [x] VERIFY: full suite green; browser pass; commit referencing FR-B1–B8

## Outcome (2026-09-07)

All seven tasks executed. **110/110 tests green** (12 new in `test/engine/simulate.test.js`, 10 in `test/sim.test.js`, 3 in `test/demo.test.js`, 2 in `test/core.test.js`); build 65 kB / 24 kB gzip.

Browser pass on the staged demo episode: DELL at 2026-07-28 16:00 CET evaluates LONG on all ten criteria, walks to a **WIN** at +3.00% underlying / +30.0% levered on a 15.57% β-capped position, and renders the chart with runway, target, stop, entry and exit drawn in. Scan mode covers all 20 names and stages all three verdicts — DELL WIN, LITE LOSS (one bar spanning both levels, the conservative same-bar rule doing its job), PWR TIME-OUT.

**A 700× performance fix, found by measuring rather than assuming.** A 20-name demo scan took 21.5 s. Profiling ruled out the engine (1–2 ms per name) and the providers (0 ms), then showed every `queue.schedule` costing exactly ~1000 ms — the signature of a background tab's timer clamp. The queue awaited a `setTimeout` even when the computed wait was 0.06 ms; it now yields only when the wait is ≥1 ms. **21,500 ms → 29 ms**, live throttling untouched, and two tests pin the behaviour: an unthrottled queue must use zero timers, a real one must still space calls.

Separately, `src/core/tz.js` now caches one `Intl.DateTimeFormat` per zone. `toLocaleString` with a `timeZone` constructs a formatter on every call and sat on per-bar paths in `live.js`, `simulate.js`, `session.js` and `kpis.js`.

**No FRD amendment.** The VIX and earnings gaps are handled by stamping the criterion `not evaluated`, which FR-B7's caveat requirement already covers, and compromise C5 already records resolution/adjustment variance. If the VIX gap turns out to be permanent for live use as well, it deserves its own C-entry — this phase did not establish that.

**Deferred, unchanged:** FR-C5 batch runner (Module C), FR-D12 one-click replay from the journal, and persisting simulation history.
