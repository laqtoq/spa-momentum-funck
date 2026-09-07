// REST throttle queue + TTL cache + daily budget meter (FR-A5, compromise C3).
export function makeQueue({ perMinute = 8, dailyBudget = 800, now = () => Date.now() } = {}) {
  const stamps = []; let used = 0; const cache = new Map(); const waiters = [];
  const gap = 60000 / perMinute;
  async function schedule(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.t < ttlMs) return { value: hit.v, cached: true };
    const wait = () => { const last = stamps.at(-1); return !last ? 0 : Math.max(0, last + gap - now()); };
    // Only yield to a timer when there is a real wait. A sub-millisecond gap is not worth a
    // macrotask, and in a background tab every such timer is clamped to a full second — which
    // turned an instant demo scan into 20 seconds of nothing.
    const w = wait();
    if (w >= 1) await new Promise(res => setTimeout(res, w));
    stamps.push(now()); used += 1;
    const v = await fn();
    cache.set(key, { v, t: now() });
    return { value: v, cached: false };
  }
  return { schedule, budget: () => ({ used, remaining: dailyBudget - used }), _cache: cache };
}
