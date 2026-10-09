'use strict';
/**
 * Bounded retry for a THROTTLED orchestrator call (HTTP 429). A 429 means the orchestrator invocation was refused
 * before it ran (Lambda concurrency throttle), so sending the same request again cannot double-apply a turn. Any
 * other status, and any network error or abort, is returned / thrown unchanged on the first attempt.
 *
 * At most `retries` extra attempts, with exponential backoff and jitter (a small Retry-After is honoured). All attempts
 * share the caller's AbortSignal, so the caller's overall timeout still bounds the whole call. A throttle that persists
 * through every attempt is returned as the final 429 response: the caller reports it as a failure (never a fake success).
 */
const THROTTLED = 429;
const sleepMs = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(signal.reason || new Error('aborted')); return; }
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

function retryDelay(attempt, res, { baseMs, maxDelayMs, random }) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  const ra = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(ra) && ra >= 0 && ra * 1000 <= maxDelayMs) return Math.round(ra * 1000);
  const exp = baseMs * (2 ** attempt);
  return Math.min(maxDelayMs, Math.round(exp / 2 + random() * (exp / 2)));
}

/**
 * fetchWithThrottleRetry(fetchFn, url, init, opts) -> Response (the first non-429, or the last 429).
 * opts: retries (2), baseMs (400), maxDelayMs (3000), onRetry({attempt, delayMs}), sleep, random — the last two for tests.
 */
async function fetchWithThrottleRetry(fetchFn, url, init = {}, opts = {}) {
  const { retries = 2, baseMs = 400, maxDelayMs = 3000, onRetry = null, sleep = sleepMs, random = Math.random } = opts;
  let res = await fetchFn(url, init);
  for (let attempt = 0; res && res.status === THROTTLED && attempt < retries; attempt += 1) {
    const delayMs = retryDelay(attempt, res, { baseMs, maxDelayMs, random });
    if (onRetry) onRetry({ attempt: attempt + 1, delayMs });
    await sleep(delayMs, init.signal);
    res = await fetchFn(url, init);
  }
  return res;
}

module.exports = { fetchWithThrottleRetry, THROTTLED };
