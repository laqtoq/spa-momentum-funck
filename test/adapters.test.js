import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStream } from '../src/adapters/alpacaStream.js';
import { regimeQuotes } from '../src/adapters/fmp.js';
import { nextEarningsMap } from '../src/adapters/finnhub.js';
import { quotes } from '../src/adapters/twelvedata.js';

test('twelvedata: quotes maps batch response, null for failed symbols', async () => {
  const f = async () => ({ json: async () => ({
    DELL: { close: '470.435', percent_change: '-4.4', volume: '9000000', average_volume: '8000000' },
    MU: { code: 404, status: 'error', message: 'symbol not found' },
  }) });
  const q = await quotes(['DELL', 'MU'], 'key', f);
  assert.deepEqual(q, { DELL: { price: 470.435, changePct: -4.4, volume: 9000000, avgVolume: 8000000 }, MU: null });
});

test('twelvedata: quotes handles single-symbol unwrapped response', async () => {
  const f = async () => ({ json: async () => ({ symbol: 'SPY', close: '772.48', percent_change: '2.0', volume: '50', average_volume: '40' }) });
  const q = await quotes(['SPY'], 'key', f);
  assert.deepEqual(q, { SPY: { price: 772.48, changePct: 2.0, volume: 50, avgVolume: 40 } });
});

test('finnhub: nextEarningsMap queries per symbol (bulk calendar caps at 1500 rows), earliest future date, null when absent', async () => {
  const perSymbol = {
    MU: [{ symbol: 'MU', date: '2026-12-17' }, { symbol: 'MU', date: '2026-09-24' }],
    DELL: [{ symbol: 'DELL', date: '2026-08-27' }],
    SNDK: [],
  };
  const urls = [];
  const f = async url => { urls.push(url);
    const sym = new URL(url).searchParams.get('symbol');
    return { ok: true, status: 200, json: async () => ({ earningsCalendar: perSymbol[sym] }) }; };
  const map = await nextEarningsMap(['MU', 'DELL', 'SNDK'], 'key', f, new Date('2026-08-04'));
  assert.deepEqual(map, { MU: '2026-09-24', DELL: '2026-08-27', SNDK: null });
  assert.equal(urls.length, 3);                                  // one call per ticker
  assert.ok(urls.every(u => new URL(u).searchParams.get('symbol')));
});

test('finnhub: nextEarningsMap surfaces HTTP errors', async () => {
  const f = async () => ({ ok: false, status: 429, text: async () => 'rate limit' });
  await assert.rejects(() => nextEarningsMap(['MU'], 'key', f), /429/);
});

const fakeFetch = table => async url => {
  for (const [needle, resp] of Object.entries(table)) if (url.includes(needle))
    return { ok: resp.status === 200, status: resp.status,
             json: async () => resp.body, text: async () => JSON.stringify(resp.body) };
  throw new Error('unexpected url ' + url);
};

test('fmp: regimeQuotes maps SPY quote and VIX level', async () => {
  const f = fakeFetch({
    'symbol=SPY': { status: 200, body: [{ symbol: 'SPY', price: 772.85, changePercentage: 2.0, priceAvg50: 750.1, priceAvg200: 700.2 }] },
    'symbol=%5EVIX': { status: 200, body: [{ symbol: '^VIX', price: 16.47 }] },
  });
  const r = await regimeQuotes('key', f);
  assert.deepEqual(r, { spy: { price: 772.85, changePct: 2.0, ma50: 750.1, ma200: 700.2 }, vix: 16.47 });
});

test('fmp: regimeQuotes surfaces provider error text', async () => {
  const f = async () => ({ ok: false, status: 402, text: async () => 'Restricted Endpoint: upgrade', json: async () => null });
  await assert.rejects(() => regimeQuotes('key', f), /402.*Restricted Endpoint/s);
});

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.onclose?.({}); }
  open() { this.onopen?.(); }
  msg(arr) { this.onmessage?.({ data: JSON.stringify(arr) }); }
}

test('alpaca: auth handshake then subscribe, trades mapped to {sym,p,v,t}', () => {
  FakeWS.all = [];
  const trades = [], statuses = [];
  openStream(['DELL', 'SPY'], { keyId: 'K', secret: 'S' }, t => trades.push(t), s => statuses.push(s), FakeWS);
  const ws = FakeWS.all[0];
  assert.equal(ws.url, 'wss://stream.data.alpaca.markets/v2/iex');
  ws.open();
  assert.deepEqual(ws.sent[0], { action: 'auth', key: 'K', secret: 'S' });
  ws.msg([{ T: 'success', msg: 'authenticated' }]);
  assert.deepEqual(statuses, ['CONNECTED']);
  assert.deepEqual(ws.sent[1], { action: 'subscribe', trades: ['DELL', 'SPY'] });
  ws.msg([{ T: 't', S: 'DELL', p: 470.1, s: 100, t: '2026-08-04T19:00:00.500Z' }]);
  assert.deepEqual(trades, [{ sym: 'DELL', p: 470.1, v: 100, t: Date.parse('2026-08-04T19:00:00.500Z') }]);
});

test('alpaca: auth failure → DOWN, no reconnect', () => {
  FakeWS.all = [];
  const statuses = [];
  openStream(['DELL'], { keyId: 'bad', secret: 'bad' }, () => {}, s => statuses.push(s), FakeWS);
  const ws = FakeWS.all[0];
  ws.open();
  ws.msg([{ T: 'error', code: 402, msg: 'auth failed' }]);
  assert.deepEqual(statuses, ['DOWN']);
  assert.equal(FakeWS.all.length, 1);   // close() fired but no reconnect socket created
});

test('alpaca: unexpected close → DEGRADED and reconnect socket opened', async () => {
  FakeWS.all = [];
  const statuses = [];
  openStream(['DELL'], { keyId: 'K', secret: 'S' }, () => {}, s => statuses.push(s), FakeWS);
  const ws = FakeWS.all[0];
  ws.open();
  ws.msg([{ T: 'success', msg: 'authenticated' }]);
  ws.close();   // simulate drop
  assert.deepEqual(statuses, ['CONNECTED', 'DEGRADED']);
  await new Promise(r => setTimeout(r, 1100));   // first backoff is 1000ms
  assert.equal(FakeWS.all.length, 2);
});
