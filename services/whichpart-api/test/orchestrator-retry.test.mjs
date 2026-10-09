/** Bounded retry for a throttled (429) orchestrator call: retried a few times, never hidden when it persists. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetchWithThrottleRetry } = require('../orchestrator-retry.js');

const resp = (status, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
const scripted = (...statuses) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return statuses[Math.min(calls.length - 1, statuses.length - 1)]; };
  return { fn, calls };
};
const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe('fetchWithThrottleRetry', () => {
  it('a 200 is returned at once (one call)', async () => {
    const f = scripted(resp(200));
    expect((await fetchWithThrottleRetry(f.fn, 'u', {}, noSleep)).status).toBe(200);
    expect(f.calls).toHaveLength(1);
  });
  it('a throttle that clears is retried and succeeds, with the same request each time', async () => {
    const f = scripted(resp(429), resp(429), resp(200));
    const delays = [];
    const r = await fetchWithThrottleRetry(f.fn, 'u', { body: 'b' }, { ...noSleep, onRetry: (x) => delays.push(x) });
    expect(r.status).toBe(200);
    expect(f.calls).toHaveLength(3);
    expect(f.calls.every((c) => c.init.body === 'b')).toBe(true);
    expect(delays.map((d) => d.attempt)).toEqual([1, 2]);
  });
  it('a persistent throttle is returned as the final 429 after the bounded retries (never hidden)', async () => {
    const f = scripted(resp(429));
    const r = await fetchWithThrottleRetry(f.fn, 'u', {}, { ...noSleep, retries: 2 });
    expect(r.status).toBe(429);
    expect(f.calls).toHaveLength(3);
  });
  it('other failures are not retried', async () => {
    for (const st of [500, 502, 503, 400]) {
      const f = scripted(resp(st));
      expect((await fetchWithThrottleRetry(f.fn, 'u', {}, noSleep)).status).toBe(st);
      expect(f.calls).toHaveLength(1);
    }
  });
  it('backoff grows and is capped; a small Retry-After is honoured', async () => {
    const delays = [];
    const f = scripted(resp(429), resp(429), resp(429), resp(429));
    await fetchWithThrottleRetry(f.fn, 'u', {}, { retries: 3, baseMs: 400, maxDelayMs: 1000, random: () => 1, sleep: async (ms) => { delays.push(ms); } });
    expect(delays).toEqual([400, 800, 1000]);
    const g = scripted(resp(429, { 'retry-after': '1' }), resp(200));
    const d2 = [];
    await fetchWithThrottleRetry(g.fn, 'u', {}, { sleep: async (ms) => { d2.push(ms); } });
    expect(d2).toEqual([1000]);
  });
  it('an abort during the wait stops retrying', async () => {
    const ac = new AbortController();
    const f = scripted(resp(429), resp(200));
    const p = fetchWithThrottleRetry(f.fn, 'u', { signal: ac.signal }, { baseMs: 10_000, maxDelayMs: 10_000 });
    ac.abort(new Error('timeout'));
    await expect(p).rejects.toThrow('timeout');
    expect(f.calls).toHaveLength(1);
  });
});
