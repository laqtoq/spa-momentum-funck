import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStream } from '../src/adapters/alpacaStream.js';

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
