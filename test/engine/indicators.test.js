import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rsi, atr, sma, sessionVWAP, slotRelVol } from '../../src/engine/indicators.js';
const fix = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)));
const bars = fix.daily_bars.map(b => ({ h: b.h, l: b.l, c: b.c }));
const closes = fix.daily_bars.map(b => b.c);
const close6 = (a, e, m) => e.forEach((x, i) => assert.ok(Math.abs(a[i]-x)/Math.abs(x) < 1e-6, `${m}[${i}] ${a[i]} vs ${x}`));

test('RSI(14) matches Python Wilder reference', () => close6(rsi(closes).slice(-5), fix.expected.rsi14_last5, 'rsi'));
test('ATR(14) matches Python Wilder reference', () => close6(atr(bars).slice(-5), fix.expected.atr14_last5, 'atr'));
test('SMA(50) matches reference', () => assert.ok(Math.abs(sma(closes,50).at(-1) - fix.expected.sma50_last) < 2e-6 /* fixtures carry 6 decimals */));
test('Session VWAP matches reference', () =>
  close6(sessionVWAP(fix.session_5m).slice(-5), fix.session_expected.vwap_last5, 'vwap'));
test('Slot relative volume matches reference', () => {
  const s = fix.session_5m, i = s.length - 1;
  assert.ok(Math.abs(slotRelVol(s[i].v, i, fix.session_expected.slot_baseline) - fix.session_expected.relvol_last) < 1e-6);
});
