/**
 * Bot check (change 21.38): Cloudflare Turnstile on the first message of a conversation. Modes off/observe/enforce,
 * fail-open when the check cannot run, later turns (valid state token) never checked.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('../turnstile.js');

const ENV = (mode) => ({ TURNSTILE_MODE: mode, TURNSTILE_SECRET_ID: 'test/turnstile' });
const secret = async () => JSON.stringify({ siteKey: 'site', secretKey: 'sec' });
const cf = (body, calls = []) => async (url, opts) => { calls.push({ url, form: Object.fromEntries(opts.body) }); return { json: async () => body }; };
const deps = (body, calls) => ({ fetchFn: cf(body, calls), fetchSecret: secret });

beforeEach(() => ts._resetCacheForTest());

describe('turnstile mode', () => {
  it('defaults to off; only observe and enforce switch it on', () => {
    expect(ts.mode({})).toBe('off');
    expect(ts.mode({ TURNSTILE_MODE: 'ENFORCE' })).toBe('enforce');
    expect(ts.mode({ TURNSTILE_MODE: 'observe' })).toBe('observe');
    expect(ts.mode({ TURNSTILE_MODE: 'yes' })).toBe('off');
  });
});

describe('verify', () => {
  it('posts the secret, token and IP to Cloudflare and passes on success', async () => {
    const calls = [];
    const r = await ts.verify('tok', { ip: '203.0.113.7', env: ENV('enforce'), ...deps({ success: true, hostname: 'applianceclinic.ai' }, calls) });
    expect(r).toMatchObject({ ok: true, reason: 'passed' });
    expect(calls[0].url).toBe(ts.VERIFY_URL);
    expect(calls[0].form).toEqual({ secret: 'sec', response: 'tok', remoteip: '203.0.113.7' });
  });
  it('rejected by Cloudflare, missing token, no secret, unreachable', async () => {
    expect(await ts.verify('tok', { env: ENV('enforce'), ...deps({ success: false, 'error-codes': ['invalid-input-response'] }) }))
      .toEqual({ ok: false, reason: 'rejected', codes: ['invalid-input-response'] });
    expect((await ts.verify('', { env: ENV('enforce'), ...deps({ success: true }) })).reason).toBe('missing');
    ts._resetCacheForTest();
    expect((await ts.verify('tok', { env: { TURNSTILE_MODE: 'enforce' }, fetchFn: cf({ success: true }) })).reason).toBe('no_secret');
    ts._resetCacheForTest();
    const down = async () => { throw new Error('ECONNRESET'); };
    expect((await ts.verify('tok', { env: ENV('enforce'), fetchFn: down, fetchSecret: secret })).reason).toBe('unreachable');
  });
});

describe('guard', () => {
  const run = (mode, { token = 'tok', newConversation = true, body = { success: false }, fetchSecret = secret } = {}) => {
    const logs = [];
    return ts.guard({ token, newConversation, ip: '203.0.113.7', log: (x) => logs.push(x), env: ENV(mode), deps: { fetchFn: cf(body), fetchSecret } })
      .then((res) => ({ res, logs }));
  };
  it('off: never checks', async () => {
    const { res, logs } = await run('off');
    expect(res).toBeNull();
    expect(logs).toEqual([]);
  });
  it('a later turn (valid state token) is never checked', async () => {
    const { res, logs } = await run('enforce', { newConversation: false });
    expect(res).toBeNull();
    expect(logs).toEqual([]);
  });
  it('observe: logs a failure but lets it through', async () => {
    const { res, logs } = await run('observe');
    expect(res).toBeNull();
    expect(logs[0]).toMatchObject({ evt: 'turnstile', mode: 'observe', ok: false, reason: 'rejected' });
  });
  it('enforce: refuses a new conversation without a passing token, allows one with', async () => {
    const bad = await run('enforce');
    expect(bad.res.statusCode).toBe(428);
    expect(JSON.parse(bad.res.body).code).toBe('bot_check_failed');
    const none = await run('enforce', { token: null, body: { success: true } });
    expect(none.res.statusCode).toBe(428);
    expect((await run('enforce', { body: { success: true } })).res).toBeNull();
  });
  it('enforce: fails open when the check cannot run (no secret configured)', async () => {
    const { res, logs } = await run('enforce', { fetchSecret: async () => null });
    expect(res).toBeNull();
    expect(logs[0].reason).toBe('no_secret');
  });
  it('never logs the secret or the token', async () => {
    const { logs } = await run('observe');
    expect(JSON.stringify(logs)).not.toMatch(/sec"|tok"/);
  });
});
