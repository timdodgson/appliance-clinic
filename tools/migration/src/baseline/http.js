/**
 * Guarded HTTP client for baseline runs.
 *
 * The baseline must not change production state beyond ordinary customer traffic, so this client
 * refuses admin and benchmark routes, refuses request bodies that would store transcripts or
 * enter live-test or benchmark modes, only talks to configured hosts, and caps request count.
 */
const FORBIDDEN_PATH = /\/(admin|benchmark|acq)(\/|$|\?)/i;
const FORBIDDEN_BODY_KEYS = ['observability', 'liveTest', 'benchmark', 'adminLiveTest'];

export class BaselineGuardError extends Error {
  constructor(message) { super(message); this.name = 'BaselineGuardError'; }
}

export function assertSafeRequest(url, body, allowedHosts) {
  const u = new URL(url);
  if (!allowedHosts.includes(u.host)) throw new BaselineGuardError(`Host ${u.host} is not a configured baseline endpoint.`);
  if (FORBIDDEN_PATH.test(u.pathname)) throw new BaselineGuardError(`Refused ${u.pathname}: admin and benchmark routes are out of scope.`);
  if (body && typeof body === 'object') {
    for (const key of FORBIDDEN_BODY_KEYS) {
      if (key in body) throw new BaselineGuardError(`Refused request body field "${key}": baseline runs must not store transcripts or change routing.`);
    }
  }
}

export function createGuardedFetch({ allowedHosts, maxRequests, timeoutMs, fetchImpl = fetch }) {
  let used = 0;
  return async function guardedFetch(url, { method = 'GET', body, headers = {} } = {}) {
    assertSafeRequest(url, body, allowedHosts);
    if (used >= maxRequests) throw new BaselineGuardError(`Request cap of ${maxRequests} reached.`);
    used += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const started = Date.now();
      const res = await fetchImpl(url, {
        method,
        headers: body ? { 'content-type': 'application/json', ...headers } : headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function hostsOf(endpoints) {
  const urls = Object.values(endpoints).flat().filter((v) => typeof v === 'string' && /^https?:/.test(v));
  return [...new Set(urls.map((u) => new URL(u).host))];
}
