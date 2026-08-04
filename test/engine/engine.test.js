import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorPivots, runway } from '../../src/engine/levels.js';
import { evaluate } from '../../src/engine/signal.js';
import { walkTrade } from '../../src/engine/walker.js';
import { baseSize, allocate } from '../../src/engine/sizing.js';

// ---- levels ----
test('floor pivots: known-answer case', () => {
  const p = floorPivots({ h: 110, l: 100, c: 106 }); // P=105.333..
  assert.ok(Math.abs(p.P - 105.3333333) < 1e-6);
  assert.ok(Math.abs(p.R1 - 110.6666667) < 1e-6);
  assert.ok(Math.abs(p.S1 - 100.6666667) < 1e-6);
});
test('runway picks nearest binding level above for longs', () => {
  const daily = Array.from({length:10},(_,i)=>({h:104+i*0.1,l:98,c:100}));
  const r = runway(100, 'long', { h: 103, l: 99, c: 101 }, daily);
  // prevDayHigh and R1 are both exactly 103 here (deliberate tie): the binding VALUE must be 103, name may be either
  assert.ok(Math.abs(r.level - 103) < 1e-9 && Math.abs(r.runwayPct - 3) < 1e-9);
  const r2 = runway(100, 'long', { h: 102, l: 99, c: 101 }, daily);  // now prevDayHigh (102) strictly nearest
  assert.equal(r2.name, 'prevDayHigh');
});

// ---- signal evaluation ----
const cfg = { enabled: {}, rsiLong: [45,65], rsiShort: [35,55], runwayPct: 3, feasK: 1.5,
              targetPct: 3, relVolMin: 1.5, vixCap: 30 };
function ctxAllPass() {
  // alternate +0.5/-0.4 → avg gain ≈ avg loss*1.25 → RSI ≈ 55, inside [45,65]
  const hour = []; let px = 100;
  for (let i=0;i<40;i++){ px += (i%2===0 ? 0.5 : -0.4); hour.push({ h: px+0.6, l: px-0.6, c: px, v: 1000 }); }
  const five = Array.from({length: 30}, (_,i)=>({ o:120, h: 120.4, l: 119.6, c: 120.1, v: 150000 }));
  five[28] = { o:120, h: 120.3, l: 119.8, c: 120.1, v: 150000 };  // prior bar
  return { dir: 'long', hourBars: hour, fiveMinBars: five,
    slotBaseline: new Array(30).fill(100000), slotIndex: 29,
    livePrice: 120.5, prevDay: { h: 112, l: 106, c: 110 },   // all pivots (incl. R2=115.33) below price → no level in the way
    dailyBars: Array.from({length:10},()=>({h:112,l:106,c:110})),
    spyAboveMA: true, vix: 18, minutesToTimeStop: 300, inEntryWindow: true,
    inBlackout: false, blackoutOverride: false };
}
test('all criteria pass → LONG', () => {
  const r = evaluate(cfg, ctxAllPass());
  assert.equal(r.state, 'LONG', JSON.stringify(r.criteria.filter(c=>!c.pass)));
});
test('each single trigger/context failure prevents LONG', () => {
  const breaks = [
    ['E2', c => { c.fiveMinBars.at(-1).v = 10000; }],
    ['E3', c => { c.livePrice = 118; c.fiveMinBars.forEach(b=>{b.h=121;b.l=120.5;b.c=120.8;}); }],
    ['E8', c => { c.fiveMinBars.at(-2).h = 125; }],
    ['E6', c => { c.inEntryWindow = false; }],
    ['E7', c => { c.inBlackout = true; }],
    ['G2', c => { c.vix = 35; }],
  ];
  for (const [id, brk] of breaks) {
    const ctx = ctxAllPass(); brk(ctx);
    const r = evaluate(cfg, ctx);
    assert.notEqual(r.state, 'LONG', `${id} should block LONG`);
  }
});
test('structure holds but trigger fails → ARMED', () => {
  const ctx = ctxAllPass(); ctx.fiveMinBars.at(-1).v = 10000; // kill E2 only
  assert.equal(evaluate(cfg, ctx).state, 'ARMED');
});
test('disabled criterion is ignored', () => {
  const ctx = ctxAllPass(); ctx.vix = 35;
  const c2 = { ...cfg, enabled: { G2: false } };
  assert.equal(evaluate(c2, ctx).state, 'LONG');
});

// ---- walker ----
const mkBar = (h,l,c) => ({ h, l, c });
test('walker: target first', () => {
  const r = walkTrade({ entryPrice: 100, dir: 'long', targetPct: 3, stopPct: 0.8, maxBars: 60,
    bars: [mkBar(101,99.5,100.5), mkBar(103.2,100.4,103)] });
  assert.equal(r.reason, 'TARGET'); assert.ok(Math.abs(r.underlyingPct - 3) < 1e-9);
});
test('walker: stop first', () => {
  const r = walkTrade({ entryPrice: 100, dir: 'long', targetPct: 3, stopPct: 0.8, maxBars: 60,
    bars: [mkBar(100.5,99.1,99.3)] });
  assert.equal(r.reason, 'STOP'); assert.ok(Math.abs(r.underlyingPct + 0.8) < 1e-9);
});
test('walker: both in one bar → conservative STOP', () => {
  const r = walkTrade({ entryPrice: 100, dir: 'long', targetPct: 3, stopPct: 0.8, maxBars: 60,
    bars: [mkBar(104,99,103.5)] });
  assert.equal(r.reason, 'STOP');
});
test('walker: time stop with MAE/MFE tracked', () => {
  const r = walkTrade({ entryPrice: 100, dir: 'long', targetPct: 3, stopPct: 0.8, maxBars: 2,
    bars: [mkBar(101,99.4,100.8), mkBar(101.5,100.2,101.2), mkBar(110,90,95)] });
  assert.equal(r.reason, 'TIME');
  assert.ok(Math.abs(r.mfe - 1.5) < 1e-9 && Math.abs(r.mae - 0.6) < 1e-9);
});

// ---- sizing ----
const scfg = { riskPerTrade: 0.015, stopPct: 0.8, leverage: 10, maxConcurrent: 2, maxPerDirection: 2,
               clusterSecondHalf: true, betaCap: 4.5, ddThrottle: 0.04, atrScaled: false };
test('base size = 18.75% of equity (FRD 5.6 identity)', () =>
  assert.ok(Math.abs(baseSize(scfg) - 0.1875) < 1e-12));
test('SNDK beta-5.2 full size breaches 450% cap → scaled to fit', () => {
  const r = allocate(scfg, { equity: 100000, hwm: 100000, open: [] },
    { ticker:'SNDK', dir:'long', beta: 5.2, cluster:'C2', atrPct: 13, medianAtrPct: 6 });
  // scale-to-fit: cap 4.5 / (10 x 5.2) = 8.6538% of equity — FR-D4's "size at which it would fit"
  assert.ok(r.sizeable && r.adjustments.betaScaled && Math.abs(r.sizeFrac - 4.5/52) < 1e-12);
});
test('second same-cluster signal → half size', () => {
  const r = allocate(scfg, { equity: 100000, hwm: 100000,
    open: [{ ticker:'MU', dir:'long', sizeFrac: 0.1875, beta: 1.0, cluster:'C2' }] },
    { ticker:'WDC', dir:'long', beta: 1.0, cluster:'C2', atrPct: 9, medianAtrPct: 6 });
  assert.ok(r.adjustments.clusterHalved && Math.abs(r.sizeFrac - 0.09375) < 1e-12);
});
test('third concurrent signal → NOT SIZEABLE (concurrent binding)', () => {
  const open = [
    { ticker:'A', dir:'long', sizeFrac: 0.1875, beta: 1, cluster:'C1' },
    { ticker:'B', dir:'short', sizeFrac: 0.1875, beta: 1, cluster:'C3' }];
  const r = allocate(scfg, { equity: 1e5, hwm: 1e5, open },
    { ticker:'C', dir:'long', beta: 1, cluster:'C4', atrPct: 6, medianAtrPct: 6 });
  assert.ok(!r.sizeable && r.binding.includes('concurrent'));
});
test('drawdown throttle halves size below HWM-4%', () => {
  const r = allocate(scfg, { equity: 95000, hwm: 100000, open: [] },
    { ticker:'X', dir:'long', beta: 1, cluster:'C9', atrPct: 6, medianAtrPct: 6 });
  assert.ok(r.adjustments.ddHalved && Math.abs(r.sizeFrac - 0.09375) < 1e-12);
});
