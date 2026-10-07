/**
 * Stage C: signed canonical-session token. Deterministic secret, clock and randomness (no AWS).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tok = require('../state-token.js');

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'; // >= 32 chars, test only
const OLD = 'old-secret-0123456789abcdef0123456789abcdef!';
const NOW = 1_800_000_000;
const fixedBytes = (n) => Buffer.alloc(n, 7);
const CSID = tok.newCanonicalSessionId(fixedBytes);

describe('canonical session id', () => {
  it('is server-minted: cs_ + 32 base64url chars', () => {
    expect(CSID).toMatch(tok.CSID_RE);
    expect(CSID.length).toBe(35);
  });
  it('uses the injected randomness (deterministic in tests) and is random by default', () => {
    expect(tok.newCanonicalSessionId(fixedBytes)).toBe(CSID);
    expect(tok.newCanonicalSessionId()).not.toBe(tok.newCanonicalSessionId());
  });
});

describe('issue / verify', () => {
  const secrets = { current: SECRET };
  const t = tok.issueToken(CSID, secrets, { nowSec: NOW });
  it('round-trips and carries only csid + expiry (no state)', () => {
    expect(t.split('.')).toHaveLength(4);
    expect(t.startsWith(`cst1.${CSID}.${NOW + tok.DEFAULT_TTL_SECONDS}.`)).toBe(true);
    expect(tok.verifyToken(t, secrets, { nowSec: NOW + 1 })).toEqual({ ok: true, csid: CSID, exp: NOW + tok.DEFAULT_TTL_SECONDS, rotated: false });
  });
  it('is deterministic for the same secret / csid / time', () => {
    expect(tok.issueToken(CSID, secrets, { nowSec: NOW })).toBe(t);
  });
  it('missing → missing', () => {
    expect(tok.verifyToken(undefined, secrets).reason).toBe('missing');
    expect(tok.verifyToken('', secrets).reason).toBe('missing');
  });
  it('malformed shapes are rejected before any HMAC work', () => {
    for (const bad of ['x', 'cst1.abc.1.2', t + 'x', t.replace('cst1', 'cst2'), 42, { t }, 'a'.repeat(500)]) {
      expect(tok.verifyToken(bad, secrets, { nowSec: NOW }).reason).toBe('malformed');
    }
  });
  it('the browser cannot choose or alter the session id (forgery → bad_signature)', () => {
    const other = tok.newCanonicalSessionId(() => Buffer.alloc(24, 9));
    const [p, , e, s] = t.split('.');
    expect(tok.verifyToken([p, other, e, s].join('.'), secrets, { nowSec: NOW }).reason).toBe('bad_signature');
  });
  it('the browser cannot extend expiry', () => {
    const [p, c, , s] = t.split('.');
    expect(tok.verifyToken([p, c, String(NOW + 10 * tok.DEFAULT_TTL_SECONDS), s].join('.'), secrets, { nowSec: NOW }).reason)
      .toBe('bad_signature');
  });
  it('a token signed with an unknown secret is rejected', () => {
    const foreign = tok.issueToken(CSID, { current: 'z'.repeat(40) }, { nowSec: NOW });
    expect(tok.verifyToken(foreign, secrets, { nowSec: NOW }).reason).toBe('bad_signature');
  });
  it('expires at exp', () => {
    expect(tok.verifyToken(t, secrets, { nowSec: NOW + tok.DEFAULT_TTL_SECONDS }).reason).toBe('expired');
    expect(tok.verifyToken(t, secrets, { nowSec: NOW + tok.DEFAULT_TTL_SECONDS - 1 }).ok).toBe(true);
  });
  it('sliding expiry: re-issuing later moves exp forward for the same csid', () => {
    const later = tok.issueToken(CSID, secrets, { nowSec: NOW + 1000 });
    expect(tok.verifyToken(later, secrets, { nowSec: NOW + 1000 }).exp).toBe(NOW + 1000 + tok.DEFAULT_TTL_SECONDS);
  });
  it('no usable secret → no_secret on verify, throw on issue (never unsigned)', () => {
    expect(tok.verifyToken(t, null, { nowSec: NOW }).reason).toBe('no_secret');
    expect(tok.verifyToken(t, { current: 'short' }, { nowSec: NOW }).reason).toBe('no_secret');
    expect(() => tok.issueToken(CSID, { current: 'short' })).toThrow();
    expect(() => tok.issueToken(CSID, null)).toThrow();
    expect(() => tok.issueToken('not-a-csid', secrets)).toThrow();
  });
});

describe('rotation', () => {
  it('a token signed with the previous secret still verifies (rotated=true); new tokens use current', () => {
    const old = tok.issueToken(CSID, { current: OLD }, { nowSec: NOW });
    const v = tok.verifyToken(old, { current: SECRET, previous: OLD }, { nowSec: NOW });
    expect(v).toMatchObject({ ok: true, csid: CSID, rotated: true });
    const fresh = tok.issueToken(CSID, { current: SECRET, previous: OLD }, { nowSec: NOW });
    expect(tok.verifyToken(fresh, { current: SECRET }, { nowSec: NOW }).ok).toBe(true);
  });
  it('once previous is dropped, old tokens fail', () => {
    const old = tok.issueToken(CSID, { current: OLD }, { nowSec: NOW });
    expect(tok.verifyToken(old, { current: SECRET }, { nowSec: NOW }).reason).toBe('bad_signature');
  });
});

describe('secret loading', () => {
  beforeEach(() => tok._resetCacheForTest());
  it('env first (current + previous)', async () => {
    const s = await tok.loadSecrets({ env: { CANONICAL_TOKEN_SECRET: SECRET, CANONICAL_TOKEN_SECRET_PREVIOUS: OLD },
      fetchSecret: () => { throw new Error('must not be called'); } });
    expect(s).toEqual({ current: SECRET, previous: OLD, source: 'env' });
  });
  it('Secrets Manager default id is stage-scoped; result cached', async () => {
    const ids = [];
    const fetchSecret = async (id) => { ids.push(id); return JSON.stringify({ current: SECRET, previous: OLD }); };
    const a = await tok.loadSecrets({ env: { STAGE: 'prod' }, fetchSecret, nowMs: 0 });
    const b = await tok.loadSecrets({ env: { STAGE: 'prod' }, fetchSecret, nowMs: 1000 });
    expect(a).toEqual({ current: SECRET, previous: OLD, source: 'secretsmanager' });
    expect(b).toBe(a);
    expect(ids).toEqual(['spares4repairs/prod/applianceclinic-canonical-state-token']);
  });
  it('explicit CANONICAL_TOKEN_SECRET_ID wins', async () => {
    const ids = [];
    await tok.loadSecrets({ env: { CANONICAL_TOKEN_SECRET_ID: 'x/y' }, fetchSecret: async (id) => { ids.push(id); return null; } });
    expect(ids).toEqual(['x/y']);
  });
  it('missing / short / unparsable / throwing secret → null (canonical disabled), negatively cached', async () => {
    let calls = 0;
    const thrower = async () => { calls += 1; throw new Error('AccessDenied'); };
    expect(await tok.loadSecrets({ env: {}, fetchSecret: thrower, nowMs: 0 })).toBeNull();
    expect(await tok.loadSecrets({ env: {}, fetchSecret: thrower, nowMs: 30_000 })).toBeNull();
    expect(calls).toBe(1);
    expect(await tok.loadSecrets({ env: {}, fetchSecret: thrower, nowMs: 61_000 })).toBeNull();
    expect(calls).toBe(2);
    for (const raw of [null, '{}', 'not json', JSON.stringify({ current: 'short' })]) {
      tok._resetCacheForTest();
      expect(await tok.loadSecrets({ env: {}, fetchSecret: async () => raw })).toBeNull();
    }
  });
});
