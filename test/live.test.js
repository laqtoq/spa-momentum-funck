import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inBlackout, slotIndexNY, slotBaselineFrom, startLive } from '../src/core/live.js';
import { BASELINE } from '../src/core/config.js';
import { makeQueue } from '../src/core/queue.js';

test('blackout: T-1 through T+1 inclusive, unknown fails safe', () => {
  const cfg = BASELINE;
  assert.equal(inBlackout('2026-08-05', new Date('2026-08-04T18:00:00Z'), cfg), true);   // T-1
  assert.equal(inBlackout('2026-08-05', new Date('2026-08-06T18:00:00Z'), cfg), true);   // T+1
  assert.equal(inBlackout('2026-08-05', new Date('2026-08-07T18:00:00Z'), cfg), false);  // T+2
  assert.equal(inBlackout('2026-08-05', new Date('2026-08-02T18:00:00Z'), cfg), false);  // T-3
  assert.equal(inBlackout(null, new Date('2026-08-04T18:00:00Z'), cfg), true);           // unknown → badge
});

test('slotIndexNY: session boundaries in EDT', () => {
  assert.equal(slotIndexNY(Date.parse('2026-08-04T13:30:00Z')), 0);    // 09:30 ET
  assert.equal(slotIndexNY(Date.parse('2026-08-04T13:34:59Z')), 0);
  assert.equal(slotIndexNY(Date.parse('2026-08-04T19:55:00Z')), 77);   // 15:55 ET
  assert.equal(slotIndexNY(Date.parse('2026-08-04T20:00:00Z')), null); // 16:00 ET = closed
  assert.equal(slotIndexNY(Date.parse('2026-08-04T13:00:00Z')), null); // pre-market
});

test('slotBaselineFrom: averages same slot across sessions, excludes today', () => {
  const mk = (iso, v) => ({ t: Date.parse(iso), o: 1, h: 1, l: 1, c: 1, v });
  const bars = [
    mk('2026-08-01T13:30:00Z', 100), mk('2026-08-02T13:30:00Z', 300),  // slot 0, two prior days
    mk('2026-08-02T13:35:00Z', 50),                                     // slot 1, one prior day
    mk('2026-08-04T13:30:00Z', 999),                                    // today → excluded
  ];
  const base = slotBaselineFrom(bars, '2026-08-04');
  assert.equal(base[0], 200);
  assert.equal(base[1], 50);
  assert.equal(base[2], 0);
});

// ---- startLive orchestrator ----

const WL = { names: [
  { ticker: 'AA', bias: 'long', cluster: 'C1', beta_60d: 2, atr_pct_14d: 5 },
  { ticker: 'BB', bias: 'short', cluster: 'C2', beta_60d: 3, atr_pct_14d: 6 },
] };
const KEYS = { alpacaId: 'k', alpacaSecret: 's', td: 't', fmp: 'f', fh: 'h' };
const instantQueue = () => makeQueue({ perMinute: 100000, now: () => Date.now() });

function fakeDeps(over = {}) {
  const calls = { stream: null, tdQuotes: [], tdBars: [], earnings: 0 };
  const deps = {
    openStream: (tickers, key, onTrade, onStatus) => {
      calls.stream = { tickers, key, onTrade, onStatus };
      return { close() {}, lastTickAge: () => 1000 };
    },
    regimeQuotes: async () => ({ spy: { price: 700, changePct: 1, ma50: 650, ma200: 600 }, vix: 18 }),
    tdQuotes: async symbols => { calls.tdQuotes.push(symbols);
      return Object.fromEntries(symbols.map(s => [s, { price: 10, changePct: 1, volume: 5, avgVolume: 4 }])); },
    tdBars: async (sym, interval) => { calls.tdBars.push([sym, interval]);
      if (interval === '1day') return Array.from({ length: 21 }, (_, i) => ({ t: i * 86400000, o: 9, h: 12, l: 8, c: 10 + (i % 3), v: 100 }));
      if (interval === '1h') return Array.from({ length: 40 }, (_, i) => ({ t: i * 3600000, o: 9, h: 11, l: 9, c: 10, v: 100 }));
      return Array.from({ length: 156 }, (_, i) => ({ t: Date.parse('2026-08-03T13:30:00Z') + i * 300000, o: 9, h: 11, l: 9, c: 10, v: 100 }));
    },
    earningsMap: async () => { calls.earnings += 1; return { AA: '2026-09-01', BB: null }; },
    queue: instantQueue(), ...over,
  };
  return { deps, calls };
}
const settle = () => new Promise(r => setTimeout(r, 60));

test('startLive: subscribes watchlist+SPY, routes trades to live prices and aggregators', async () => {
  const { deps, calls } = fakeDeps();
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: BASELINE }, deps);
  assert.deepEqual(calls.stream.tickers, ['AA', 'BB', 'SPY']);
  assert.deepEqual(calls.stream.key, { keyId: 'k', secret: 's' });
  calls.stream.onTrade({ sym: 'AA', p: 11.5, v: 10, t: Date.parse('2026-08-04T14:00:01Z') });
  calls.stream.onTrade({ sym: 'SPY', p: 701, v: 1, t: Date.parse('2026-08-04T14:00:02Z') });
  assert.equal(state.live.AA.p, 11.5);
  assert.equal(state.spyLive, 701);
  assert.equal(state.bars5m('AA').length, 1);
  await settle();
});

test('startLive: chunks TD quotes ≤8 symbols per call and fills regime + earnings', async () => {
  const wl20 = { names: Array.from({ length: 20 }, (_, i) => ({ ticker: 'T' + i, bias: 'long', cluster: 'C1', beta_60d: 1, atr_pct_14d: 5 })) };
  const { deps, calls } = fakeDeps();
  const { state } = startLive({ keys: KEYS, watchlist: wl20, cfg: BASELINE }, deps);
  await settle();
  assert.ok(calls.tdQuotes.length >= 3);
  assert.ok(calls.tdQuotes.every(chunk => chunk.length <= 8));
  assert.equal(state.quotes.T0.price, 10);
  assert.equal(state.spy.price, 700);
  assert.equal(state.vix, 18);
  assert.ok(state.spy.ma20 > 0);
});

test('startLive: provider failure stores actual error, rest continues', async () => {
  const { deps } = fakeDeps({ regimeQuotes: async () => { throw new Error('FMP quote SPY 402: Restricted'); } });
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: BASELINE }, deps);
  await settle();
  assert.match(state.errors.regime, /402.*Restricted/);
  assert.equal(state.quotes.AA.price, 10);          // quotes unaffected
  assert.deepEqual(state.earnings, { AA: '2026-09-01', BB: null });
});

test('startLive: evaluates states once structure+daily+baseline+live present', async () => {
  const { deps, calls } = fakeDeps();
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: BASELINE }, deps);
  await settle();
  calls.stream.onTrade({ sym: 'AA', p: 11.5, v: 10, t: Date.parse('2026-08-04T14:00:01Z') });
  calls.stream.onTrade({ sym: 'AA', p: 11.6, v: 10, t: Date.parse('2026-08-04T14:06:01Z') });
  state.reeval();
  assert.ok(state.states.AA, 'AA evaluated');
  assert.ok(['IDLE', 'ARMED', 'LONG'].includes(state.states.AA.state));
  assert.ok(state.states.AA.criteria.length >= 9);
});

test('startLive: reconnect triggers 5m backfill + VWAP reseed flag (FR-A17)', async () => {
  const { deps, calls } = fakeDeps();
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: BASELINE }, deps);
  await settle();
  const before = calls.tdBars.filter(c => c[1] === '5min').length;
  calls.stream.onStatus('DEGRADED');
  calls.stream.onStatus('CONNECTED');
  await settle();
  assert.ok(calls.tdBars.filter(c => c[1] === '5min').length > before, 'backfill fetched 5m bars');
  assert.equal(state.reseeded, true);
});

test('startLive: pause forces PAUSED state and blackout defaults to paused', async () => {
  const { deps } = fakeDeps({ earningsMap: async () => ({ AA: '2026-09-01', BB: nextDayISO() }) });
  const { state } = startLive({ keys: KEYS, watchlist: WL, cfg: BASELINE }, deps);
  await settle();
  assert.equal(state.paused.BB, true, 'blackout name paused by default (FR-A8)');
  state.setPause('AA', true, false);
  assert.equal(state.states.AA?.state, 'PAUSED');
  state.setPause('BB', false, true);                 // explicit override
  assert.equal(state.overrides.BB, true);
});
const nextDayISO = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
