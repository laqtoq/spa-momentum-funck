# Screening Run Report — 2026-08-04

> **Corrections applied 2026-09-07**, after the figures were checked against the committed `public/watchlist.json`: the bias mix read 6 long / 14 short (it is 7 / 13), the C2 cluster residual read 8/20 (it is 10/20), and F3's beta remedy read "auto-halves" (the allocator scales to fit — decision D4). Pipeline counts, sector groupings, the S3 sensitivity curve and the funnel overlap were re-verified and are unchanged. This report is planned as appendix A3 of the IC deck; regenerate it with the watchlist if the screen is re-run before submission.

## Pipeline verification (all gates passed)
Data: 504/504 tickers downloaded, 99.4% with full 260-day history (FDXF, HONA, Q excluded — insufficient listing history). ATR computation hand-verified (AAPL: 3.154% both methods). ApeWisdom funnel live (100 rows; MU, SNDK, AMD, CAT, TSLA intersect the screen).

## Filter pass/fail distribution (universe of 500 with full history)
| Filter | Pass |
|---|---|
| S2 close ≥ $20 | 492 |
| S4 dollar volume ≥ $500M | 187 |
| S3 at FRD's 2.0% (after S2+S4) | **180 — filter does no work** |
| S3 sensitivity | 2.5% → 151 · 3.0% → 111 · 3.5% → 79 |
| S3 adaptive = max(2.0, median) = **3.28%** | **93 survivors** |

## Findings requiring FRD decisions
**F1 — S3 threshold is regime-blind.** Median ATR among liquid names is currently 3.28%; the fixed 2.0% floor passes 96% of them. Proposal: adaptive floor `max(2.0%, liquid-universe median)`, recomputed at each monthly screen.

**F2 — Unconstrained composite rank yields a degenerate watchlist.** Top-20 by z-score = 2 sectors, one 17-name correlation cluster (AI hardware). Under Module D's cluster rule that is ~2 tradeable slots wearing 20 tickers. Proposal: new screen filter **S7: max 6 names per GICS sector** → 7 sectors, 11 clusters (variant shipped). Residual: **10/20** still share cluster C2 (the AI-infrastructure trade crosses sector lines: SNDK/MU/WDC/LITE + VRT/FIX/GEV/PWR/CAT/ETN industrials); Module D's trade-time cluster cap handles the residual, or a screen-time cluster cap (max 5 per cluster) could be added.

**F3 — Extreme betas are real and the bucket design bites.** SNDK 5.2, MRVL 5.2 (60d vs SPY). A full-size (187.5% notional) position in a beta-5 name = ~975% beta-weighted exposure vs the 450% cap → Module D scales the position down. Working as intended; verify the cap value is the one you want. *(Superseded in detail: this run proposed auto-halving, but a unit test showed halving a β-5.2 name — 18.75% → 9.375% of equity — still breaches the 450% cap. The allocator scales to fit instead, so SNDK enters at 4.5/52 ≈ 8.65% of equity. See FRD §5.6 and HANDOVER decision D4.)*

## Shipped watchlist (Variant B, provisional)
DELL, SNDK, MRVL, MU, WDC, LITE (IT · 6) — VRT, FIX, GEV, PWR, CAT, ETN (Industrials · 6) — HUM, BSX (Health Care) — COIN, HOOD (Financials) — CVNA, TSLA (Cons. Disc.) — VLO (Energy) — VST (Utilities). Bias mix: **7 long / 13 short** (recent pullback under strong 6-month trends) — long: DELL, LITE, PWR, CVNA, VLO, BSX, ETN. Funnel overlap: SNDK, MU, CAT, TSLA.

## Open items
CPI dates in key_dates.json to verify; earnings dates come live from FMP (FR-A7); R port of this pipeline for the course-facing repo pending.
