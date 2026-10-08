/**
 * whichpart-api rate limiting (Phase 7): client IP derivation behind CloudFront, fixed-window counting per dimension,
 * the off/observe/enforce modes, fail-open on store errors, and no raw identifiers in the store.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rl = require('../rate-limit.js');

const ev = (sourceIp, xff) => ({ requestContext: { http: { sourceIp } }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
const memoryStore = () => {
  const m = new Map();
  return { m, async increment(pk) { const n = (m.get(pk) || 0) + 1; m.set(pk, n); return n; } };
};
const ENFORCE = { RATE_LIMIT_MODE: 'enforce' };

describe('client IP', () => {
  it('behind CloudFront: the right-most address (the one CloudFront appended), never what the viewer sent', () => {
    expect(rl.clientIp(ev('130.176.1.1', '203.0.113.7')).ip).toBe('203.0.113.7');
    // A viewer-supplied X-Forwarded-For comes first; CloudFront appends the real viewer after it.
    expect(rl.clientIp(ev('130.176.1.1', '198.51.100.99, 203.0.113.7')).ip).toBe('203.0.113.7');
    // The Function URL may report the viewer as the source too: the right-most entry still wins (Phase 7 probe).
    expect(rl.clientIp(ev('203.0.113.7', '198.51.100.99, 203.0.113.7')).ip).toBe('203.0.113.7');
  });
  it('a direct caller with no header is its source address; the source is always reported for the edge count', () => {
    expect(rl.clientIp(ev('203.0.113.9')).ip).toBe('203.0.113.9');
    expect(rl.clientIp(ev('203.0.113.9', '203.0.113.9')).ip).toBe('203.0.113.9');
    expect(rl.clientIp(ev('203.0.113.9', '198.51.100.1')).source).toBe('203.0.113.9');
    expect(rl.clientIp({}).ip).toBe('unknown');
  });
  it('reports the header shape, never an address', () => {
    expect(rl.clientIp(ev('203.0.113.7', '198.51.100.99, 203.0.113.7'))).toMatchObject({ xffDepth: 2, lastIsSource: true });
    expect(rl.clientIp(ev('130.176.1.1', '203.0.113.7'))).toMatchObject({ xffDepth: 1, lastIsSource: false });
  });
});

describe('counting', () => {
  it('off by default: no store call at all', async () => {
    const store = { increment: () => { throw new Error('must not be called'); } };
    const r = await rl.check('diagnose', { ip: 'a', source: 'b' }, { store, env: {} });
    expect(r).toEqual({ mode: 'off', limited: false, counts: [] });
  });
  it('enforce: refuses the request after the per-source limit within one window, and allows it in the next window', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const ctx = { ip: '203.0.113.7', source: '130.176.1.1' };
    for (let i = 0; i < rl.LIMITS.diagnoseEdge.limit; i += 1) expect((await rl.check('diagnose', ctx, { store, now, env: ENFORCE })).limited).toBe(false);
    const over = await rl.check('diagnose', ctx, { store, now, env: ENFORCE });
    expect(over.limited).toBe(true);
    expect(over.retryAfter).toBeGreaterThan(0);
    expect(over.retryAfter).toBeLessThanOrEqual(rl.LIMITS.diagnoseEdge.windowSec);
    const next = await rl.check('diagnose', ctx, { store, now: now + rl.LIMITS.diagnoseEdge.windowSec * 1000, env: ENFORCE });
    expect(next.limited).toBe(false);
  });
  it('per-IP counts are advisory: over the limit is reported, never refused (a forged address cannot lock anyone out)', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    let r;
    for (let i = 0; i <= rl.LIMITS.diagnoseIp.limit; i += 1) r = await rl.check('diagnose', { ip: '203.0.113.7', source: `edge-${i}` }, { store, now, env: ENFORCE });
    expect(r.limited).toBe(false);
    expect(r.counts.find((c) => c.name === 'diagnoseIp')).toMatchObject({ advisory: true });
    expect(r.counts.find((c) => c.name === 'diagnoseIp').count).toBeGreaterThan(rl.LIMITS.diagnoseIp.limit);
  });
  it('the per-conversation limit applies on its own', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    for (let i = 0; i < rl.LIMITS.diagnoseSession.limit; i += 1) await rl.check('diagnose', { ip: `198.51.100.${i}`, source: 'edge', session: 's1' }, { store, now, env: ENFORCE });
    expect((await rl.check('diagnose', { ip: '198.51.100.250', source: 'edge', session: 's1' }, { store, now, env: ENFORCE })).limited).toBe(true);
    expect((await rl.check('diagnose', { ip: '198.51.100.251', source: 'edge', session: 's2' }, { store, now, env: ENFORCE })).limited).toBe(false);
  });
  it('rotating a spoofed address does not escape the per-source (edge) limit', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    let limited = false;
    for (let i = 0; i <= rl.LIMITS.diagnoseEdge.limit; i += 1) limited = (await rl.check('diagnose', { ip: `spoof-${i}`, source: '203.0.113.66' }, { store, now, env: ENFORCE })).limited;
    expect(limited).toBe(true);
  });
  it('forging X-Forwarded-For does not escape the global caps', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    let limited = false;
    for (let i = 0; i <= rl.LIMITS.loginGlobal.limit; i += 1) limited = (await rl.check('login', { ip: `forged-${i}`, email: `user${i}@example.test` }, { store, now, env: ENFORCE })).limited;
    expect(limited).toBe(true);
    const turns = memoryStore();
    for (let i = 0; i <= rl.LIMITS.diagnoseGlobal.limit; i += 1) limited = (await rl.check('diagnose', { ip: `forged-${i}`, source: `edge-${i % 50}` }, { store: turns, now, env: ENFORCE })).limited;
    expect(limited).toBe(true);
  });
  it('login: per IP and per email, case-insensitively', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    for (let i = 0; i < rl.LIMITS.loginEmail.limit; i += 1) await rl.check('login', { ip: `198.51.100.${i}`, email: 'Admin@Example.test' }, { store, now, env: ENFORCE });
    expect((await rl.check('login', { ip: '198.51.100.200', email: 'admin@example.test ' }, { store, now, env: ENFORCE })).limited).toBe(true);
    expect((await rl.check('login', { ip: '198.51.100.201', email: 'other@example.test' }, { store, now, env: ENFORCE })).limited).toBe(false);
  });
  it('observe: counts and reports over-limit, never refuses', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    let r;
    for (let i = 0; i <= rl.LIMITS.loginEmail.limit; i += 1) r = await rl.check('login', { ip: '203.0.113.7', email: 'a@example.test' }, { store, now, env: { RATE_LIMIT_MODE: 'observe' } });
    expect(r.limited).toBe(false);
    expect(r.overLimit).toBe(true);
  });
  it('fails open when the store fails', async () => {
    const store = { increment: async () => { throw new Error('ProvisionedThroughputExceeded'); } };
    const r = await rl.check('diagnose', { ip: 'a', source: 'b' }, { store, env: ENFORCE });
    expect(r.limited).toBe(false);
    expect(r.error).toMatch(/ProvisionedThroughput/);
  });
  it('stores only hashed identifiers, with an expiry after the window', async () => {
    const store = memoryStore();
    const seen = [];
    const spy = { async increment(pk, exp) { seen.push({ pk, exp }); return store.increment(pk); } };
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    await rl.check('login', { ip: '203.0.113.7', email: 'admin@example.test' }, { store: spy, now, env: ENFORCE });
    for (const { pk, exp } of seen) {
      expect(pk).not.toMatch(/203\.0\.113\.7|admin@example/);
      expect(pk).toMatch(/^login(Ip|Email|Global)#[0-9a-f]{32}#\d+$/);
      expect(exp).toBeGreaterThan(now / 1000);
    }
  });
  it('the DynamoDB store makes one atomic ADD with an expiry', async () => {
    const calls = [];
    const store = rl.dynamoStore(async (action, payload) => { calls.push({ action, payload }); return { Attributes: { n: { N: '3' } } }; }, 'tbl');
    expect(await store.increment('k', 123)).toBe(3);
    expect(calls[0].action).toBe('UpdateItem');
    expect(calls[0].payload.UpdateExpression).toBe('ADD n :one SET expiresAt = if_not_exists(expiresAt, :exp)');
    expect(calls[0].payload.TableName).toBe('tbl');
  });
});

describe('whichpart-api handler with rate limiting', () => {
  process.env.COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'eu-west-1_ACPOOL001';
  process.env.COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || 'acclient0001';
  process.env.ORCHESTRATOR_URL = 'http://127.0.0.1:9';
  process.env.ORCH_TIMEOUT_MS = '500';
  const api = require('../index.js');
  const sdk = require('@aws-sdk/client-cognito-identity-provider');
  const full = { async increment() { return 1000; } };
  const fresh = { async increment() { return 1; } };
  const ev = (route, body, xff = '203.0.113.7') => ({
    rawPath: '/api' + route, requestContext: { http: { method: 'POST', path: '/api' + route, sourceIp: '130.176.1.1' }, requestId: 'r' },
    headers: { 'x-forwarded-for': xff }, cookies: [], body: JSON.stringify(body),
  });
  const withMode = async (mode, fn) => {
    const before = process.env.RATE_LIMIT_MODE;
    process.env.RATE_LIMIT_MODE = mode;
    try { return await fn(); } finally { if (before === undefined) delete process.env.RATE_LIMIT_MODE; else process.env.RATE_LIMIT_MODE = before; }
  };

  it('enforce: sign-in over the limit is 429 with Retry-After, and Cognito is never called', async () => {
    const original = sdk.CognitoIdentityProviderClient.prototype.send;
    sdk.CognitoIdentityProviderClient.prototype.send = async () => { throw new Error('Cognito must not be called'); };
    api.setRateLimitStoreForTests(full);
    try {
      const r = await withMode('enforce', () => api.handler(ev('/auth/login', { email: 'a@example.test', password: 'x' })));
      expect(r.statusCode).toBe(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.parse(r.body).code).toBe('rate_limited');
    } finally { sdk.CognitoIdentityProviderClient.prototype.send = original; }
  });
  it('enforce: a customer turn over the limit is 429 before the orchestrator is called', async () => {
    api.setRateLimitStoreForTests(full);
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('the orchestrator must not be called'); };
    try {
      const r = await withMode('enforce', () => api.handler(ev('', { messages: [{ role: 'user', content: 'My dishwasher will not drain' }] })));
      expect(r.statusCode).toBe(429);
    } finally { globalThis.fetch = fetchBefore; }
  });
  // Sign-in reaches Cognito (stubbed to reject the password): 401 proves the limiter let the request through.
  const rejectingCognito = async (fn) => {
    const original = sdk.CognitoIdentityProviderClient.prototype.send;
    let called = 0;
    sdk.CognitoIdentityProviderClient.prototype.send = async () => { called += 1; const e = new Error('Incorrect username or password.'); e.name = 'NotAuthorizedException'; throw e; };
    try { return { r: await fn(), called: () => called }; } finally { sdk.CognitoIdentityProviderClient.prototype.send = original; }
  };
  it('observe: never refuses, even over the limit', async () => {
    api.setRateLimitStoreForTests(full);
    const { r, called } = await rejectingCognito(() => withMode('observe', () => api.handler(ev('/auth/login', { email: 'a@example.test', password: 'x' }))));
    expect(r.statusCode).toBe(401);
    expect(called()).toBe(1);
  });
  it('enforce: a store failure never refuses a request', async () => {
    api.setRateLimitStoreForTests({ async increment() { throw new Error('boom'); } });
    const { r, called } = await rejectingCognito(() => withMode('enforce', () => api.handler(ev('/auth/login', { email: 'a@example.test', password: 'x' }))));
    expect(r.statusCode).toBe(401);
    expect(called()).toBe(1);
  });
  it('enforce: under the limit, sign-in carries on to Cognito', async () => {
    api.setRateLimitStoreForTests(fresh);
    const { r, called } = await rejectingCognito(() => withMode('enforce', () => api.handler(ev('/auth/login', { email: 'a@example.test', password: 'x' }))));
    expect(r.statusCode).toBe(401);
    expect(called()).toBe(1);
  });
});
