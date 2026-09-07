# Module C — Configuration & Optimization Workbench Implementation Plan (FR-C1–C9)

**Goal:** Make every parameter editable *and* make the tooling incapable of quietly deceiving its operator. Module C is a curve-fitting machine unless governed (FRD 4.7), so the governance is the feature: baseline lock, deterministic preset hashes, a tuning/validation split that locks before validation, a three-parameter degrees-of-freedom budget, and an append-only optimization log.

**Architecture:** `src/core/presets.js` owns the preset model — a data-driven parameter spec, diff against baseline, DoF counting, fork-on-edit-when-locked, localStorage persistence with JSON export/import — plus the append-only log. `src/core/batch.js` runs (date × preset) combinations through Module B's existing `runScan`, never re-implementing evaluation. Aggregation maps simulated episodes onto the shape `computeKpis()` already measures, so tuning results and live journal results are scored by one code path. `main.js` renders.

**Tech stack:** Existing. No new dependencies.

## Scope boundary

In: FR-C1 through FR-C9 in full — that is what the FRD's completion criterion asks for.

Out: promoting a preset to baseline automatically (FR-C8 explicitly requires the UI to *display* the commit instruction, never perform it) · automated parameter search (FRD 4.7 forbids it; the runner compares operator-defined presets only) · FR-D6 what-if · FR-D12 trade table.

## Interpretation calls (record here; FRD amend if overridden)

- **Editing a locked preset forks it** into a new preset with a new hash, rather than refusing the edit. FR-C4 requires that results never migrate between configurations; forking satisfies that while keeping the operator moving. The fork records its parent in the log.
- **The DoF budget counts leaf parameters.** `rsiLong: [45, 65]` changed to `[40, 65]` counts as one deviation, not two — the budget exists to keep changes explainable, and a band is one idea. Criterion toggles count individually.
- **Simulated episodes are scored through `computeKpis()`** by mapping each to a trade-shaped record. Writing a second expectancy formula for Module C would let tuning results and live results disagree about what expectancy means.
- **Expectancy uses Module D sizing on an empty book** — `allocate()` with no open positions. Sizing against a hypothetical book would make the number depend on trade ordering, which is not a property of the preset.
- **Slot length is not editable.** FR-C1 lists it, but the 5-minute slot is structural — it is the bar resolution the relative-volume baseline is built from, not a configuration value. Exposing it would imply the engine can re-bucket history, which it cannot. Recorded here rather than silently dropped.

## Tasks

### Task 1 — Preset model and parameter spec
- [x] `src/core/presets.js`: `PARAM_SPEC` (every FR-C1 parameter with group, label, type, min/max/step), `diffFromBaseline(cfg)`, `dofCount(cfg)`, `makePresetStore(storage)` with create / update / fork-on-locked / lock / remove / list / exportJSON / importJSON
- [x] VERIFY: `node --test test/presets.test.js` — the spec covers every editable key in BASELINE with none missing and none invented; an unedited preset diffs to zero; changing an RSI band counts as one deviation; editing a locked preset yields a new preset with a new hash and the original untouched; export→import round-trips

### Task 2 — Append-only optimization log (FR-C8)
- [x] `src/core/presets.js`: `makeLog(storage)` with `append({action, preset, hash, rationale})`, list, `exportJSON()`, `exportMarkdown()`; entries are never edited or deleted
- [x] VERIFY: same suite — appended entries keep insertion order; an attempt to mutate a returned entry does not change stored state; Markdown export contains the action, hash and rationale of each entry

### Task 3 — Batch runner (FR-C5/C7)
- [x] `src/core/batch.js`: `runBatch({dates, presets, label, timeCET, watchlist}, deps, onProgress)` → `{promise, cancel}`, executing Module B `runScan` per (date × preset) through the queue; a `validation` label locks each preset **before** its first run and reports that it did
- [x] VERIFY: `node --test test/batch.test.js` with fakes — progress reports (date, preset, done, total); cancel stops further combinations; a validation run locks presets first and a tuning run does not; results carry their preset hash and label

### Task 4 — Aggregation (FR-C6/C9)
- [x] `src/core/batch.js`: `aggregate(results, cfg)` → per preset per label: signals, hit rate, expectancy per trade at Module D sizing, average MAE/MFE, time-out share, resolutions used, DoF badge — computed by mapping episodes through `computeKpis()`
- [x] VERIFY: same suite — a hand-built set of episodes produces the expected hit rate and expectancy; tuning and validation never aggregate together; a >3-deviation preset is badged; resolutions are reported as the set actually used

### Task 5 — Config editor UI (FR-C1/C2/C9)
- [x] Workbench panel rendering `PARAM_SPEC` by group, each control showing current and baseline value with deviations marked; a diff view listing all deviations; a persistent warning above three deviations
- [x] VERIFY: demo click-through — editing a threshold marks it and updates the hash live; the diff view lists exactly the changed parameters; a fourth deviation raises the warning

### Task 6 — Preset manager, batch UI, log UI (FR-C3/C4/C7/C8)
- [x] Preset list with save / fork / lock / export / import; batch runner with date list, preset multi-select, tuning-or-validation label, progress and cancel; side-by-side results table with hashes and resolutions, tuning and validation separated; log view with rationale entry and JSON/Markdown export; promotion shows the `config.js` commit instruction and does not perform it
- [x] VERIFY: demo click-through — a two-preset, five-date batch produces the side-by-side table; a validation run visibly locks its preset; the log exports with a rationale; `npm run build` green

### Task 7 — Docs + gate
- [x] README, HANDOVER §5/§11, plan outcome; FRD note only if an interpretation above was overridden
- [x] VERIFY: full suite green; browser pass against the FRD completion criterion (two presets × five dates, locking demonstrated, log exported); commit referencing FR-C1–C9

## Outcome (2026-09-07)

All seven tasks executed. **135/135 tests green** (16 new in `test/presets.test.js`, 9 in `test/batch.test.js`); build 86 kB / 31 kB gzip. All four modules now exist.

Browser pass against the FRD's Module C completion criterion, in order:
- **43 parameters** editable, each showing its baseline value, deviations marked live; editing `runwayPct` 3 → 6 moved the hash `88d3bdbf → b4aaae3e` in the header
- two presets saved with distinct hashes; the **DoF warning** appeared on the fourth deviation, not the third
- **batch across 2 presets × 5 dates** produced the side-by-side table with hashes and resolutions: baseline 6 signals / 33% hit / +0.87% expectancy, the 6%-runway preset 0 signals — a legible result, since demanding 6% of runway filters every staged setup out
- **validation run locked both presets before the first date**, said so, and rendered tuning and validation as separate tables
- editing the locked preset **forked** it to `wider runway (2)` with hash `9f535da9`, leaving the locked one untouched at `b4aaae3e`
- the log exported with a rationale entry; presets exported and re-imported into a fresh store with **hashes intact**
- promotion printed the `config.js` edit and performed nothing

**Two bugs found in the browser pass:**
1. `renderWbSummary()` owns `#c_warn` and rewrites it on every keystroke, so the fork message was wiped the instant it appeared. Transient messages moved to their own `#c_msg`; `#c_warn` stays the persistent FR-C9 warning.
2. The deviations list reused the criteria grid, whose 44px first column overlapped parameter keys like `runwayPct`. It has its own content-sized grid now.

**Demo providers made date-aware** so a five-date batch is not five identical rows: outcomes now vary deterministically per (ticker, date), while the canonical `DEMO_SIM.date` keeps its staged WIN / LOSS / TIME-OUT trio so the existing Module B tests still pin real behaviour.

**One FR-C1 item deliberately not implemented:** relative-volume *slot length*. The 5-minute slot is structural — it is the bar resolution the baseline is built from, not a configuration value — and exposing it would imply the engine can re-bucket history, which it cannot. Recorded here rather than silently dropped.

## Follow-up fixes (2026-09-07, from review feedback)

Four items raised against the codebase, all confirmed before changing anything:

1. **FRD header stale** — version field read 1.6 and the author was an unfilled `[Your name]` placeholder while the change log was at v1.7. Header now reads v1.8 with the author filled in (the syllabus requires names in the document).
2. **FRD §3.2 described the screen as it was planned, not as it ran.** The funnel text said "in R" — the 2026-08-04 run was Python (yfinance, keyless), and the R port is still an open item. It also listed FMP biggest-gainers as a funnel source, which the C9 spike had already ruled out: FMP's free tier is symbol-restricted for post-Aug-2025 keys. The run used ApeWisdom alone. Both corrected, with a v1.8 change-log entry recording that no requirement changed — these were descriptive sections that had drifted from the delivered artefacts.
3. **README opener and tallies stale** — still claimed "Module A complete" after all four modules shipped, and the per-suite counts had drifted (core 5→7, demo 6→9). Replaced with a measured per-suite list that sums to the stated total, so the two can no longer disagree silently.
4. **The bucket board offered a dust-sized position in a name already held** — reported as `DELL 0.00% of equity · $93`. Reproduced and root-caused: the fill form records size to two decimals, so a book that fills the beta cap leaves 0.00027 of headroom behind, and `allocate()` scaled into it — a position risking **0.000075% of equity against a 1.5% unit**. Two independent defects, both fixed with tests:
   - `allocate()` now reports NOT SIZEABLE when the fitted size risks less than a tenth of the risk unit. `MIN_RISK_SHARE` is a guard against rounding dust, not a strategy knob, so it is a named constant rather than a config parameter — adding it to `BASELINE` would move every preset hash for a numerical-noise fix.
   - the current-signals list now shows a held name as *already in the book*, with its size, rather than sizing it again. A second position in one ticker is the doubled bet the cluster rule exists to prevent.
