// Alpaca IEX WebSocket — Layer 1 primary since FRD v1.6 (C1: still single-venue, now IEX).
// Replaces Finnhub WS, whose free tier stopped streaming most watchlist names (C9, spike 2026-08-04).
// Same contract as finnhubStream.openStream so providers stay swappable (NFR-4).
export function openStream(tickers, { keyId, secret }, onTrade, onStatus, WS = WebSocket) {
  let ws, closed = false, backoff = 1000, lastTick = 0;
  const connect = () => {
    ws = new WS('wss://stream.data.alpaca.markets/v2/iex');
    ws.onopen = () => ws.send(JSON.stringify({ action: 'auth', key: keyId, secret }));
    ws.onmessage = ev => {
      for (const m of JSON.parse(ev.data)) {
        if (m.T === 'success' && m.msg === 'authenticated') {
          backoff = 1000; onStatus('CONNECTED');
          ws.send(JSON.stringify({ action: 'subscribe', trades: tickers }));
        } else if (m.T === 'error') {          // auth/limit errors: stop, surface, no retry storm
          closed = true; onStatus('DOWN'); ws.close();
        } else if (m.T === 't') {
          lastTick = Date.now();
          onTrade({ sym: m.S, p: m.p, v: m.s, t: Date.parse(m.t) });
        }
      }
    };
    ws.onclose = () => { if (closed) return; onStatus('DEGRADED');
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); };
    ws.onerror = () => ws.close();
  };
  connect();
  return { close: () => { closed = true; ws?.close(); }, lastTickAge: () => lastTick ? Date.now() - lastTick : null };
}
