// Finnhub WebSocket (Layer 1, C1 single-venue). WS is CORS-exempt → works on GitHub Pages.
export function openStream(tickers, apiKey, onTrade, onStatus, WS = WebSocket) {
  let ws, closed = false, backoff = 1000, lastTick = 0;
  const connect = () => {
    ws = new WS(`wss://ws.finnhub.io?token=${apiKey}`);
    ws.onopen = () => { backoff = 1000; onStatus('CONNECTED');
      tickers.forEach(s => ws.send(JSON.stringify({ type: 'subscribe', symbol: s }))); };
    ws.onmessage = ev => { const m = JSON.parse(ev.data);
      if (m.type === 'trade') { lastTick = Date.now(); m.data.forEach(d => onTrade({ sym: d.s, p: d.p, v: d.v, t: d.t })); } };
    ws.onclose = () => { if (closed) return; onStatus('DEGRADED');
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); };
    ws.onerror = () => ws.close();
  };
  connect();
  return { close: () => { closed = true; ws?.close(); }, lastTickAge: () => lastTick ? Date.now() - lastTick : null };
}
