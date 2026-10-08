/**
 * Phase 7: whichpart-api sends CORS only to the AC origins (never "*"), and security headers on every HTTP response.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { finalizeResponse, AC_ORIGINS, SECURITY_HEADERS } = require('../http-headers.js');
const api = require('../index.js');

const http = (method, headers = {}, p = '/api/auth/me') => ({
  rawPath: p, requestContext: { http: { method, path: p }, requestId: 'hh' }, headers, cookies: [], body: '',
});
const base = { statusCode: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' }, body: '{}' };

describe('finalizeResponse', () => {
  it('echoes an AC origin, with vary, never "*"', () => {
    for (const o of AC_ORIGINS) {
      const r = finalizeResponse(http('GET', { origin: o }), base);
      expect(r.headers['access-control-allow-origin']).toBe(o);
      expect(r.headers.vary).toBe('origin');
    }
  });
  it('sends no CORS headers to any other origin, or without an origin', () => {
    for (const h of [{ origin: 'https://evil.example' }, { origin: 'https://applianceclinic.ai.evil.example' }, { origin: 'http://applianceclinic.ai' }, { origin: 'null' }, {}]) {
      const r = finalizeResponse(http('GET', h), base);
      expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
  });
  it('matches the Origin header case-insensitively by name, exactly by value', () => {
    expect(finalizeResponse(http('GET', { Origin: 'https://applianceclinic.ai' }), base).headers['access-control-allow-origin']).toBe('https://applianceclinic.ai');
    expect(finalizeResponse(http('GET', { origin: 'HTTPS://APPLIANCECLINIC.AI' }), base).headers['access-control-allow-origin']).toBeUndefined();
  });
  it('adds the security headers and keeps everything else, body and cookies included', () => {
    const r = finalizeResponse(http('POST'), { ...base, cookies: ['a=b'], headers: { ...base.headers, 'retry-after': '5' } });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers[k]).toBe(v);
    expect(r.headers['retry-after']).toBe('5');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.cookies).toEqual(['a=b']);
    expect(r.body).toBe('{}');
    expect(r.statusCode).toBe(200);
  });
  it('leaves non-HTTP (scheduled) results untouched', () => {
    const result = { attempted: 0 };
    expect(finalizeResponse({ transcriptReview: true }, result)).toBe(result);
    expect(finalizeResponse({ source: 'aws.events' }, base)).toBe(base);
  });
});

describe('the deployed handler', () => {
  it('preflight from an AC origin is allowed; from another origin it carries no CORS', async () => {
    const ok = await api.handler(http('OPTIONS', { origin: 'https://applianceclinic.ai' }));
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://applianceclinic.ai');
    const bad = await api.handler(http('OPTIONS', { origin: 'https://evil.example' }));
    expect(bad.statusCode).toBe(204);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect(bad.headers['content-security-policy']).toBe(SECURITY_HEADERS['content-security-policy']);
  });
  it('a normal same-origin JSON response keeps its status, body and content type', async () => {
    const r = await api.handler(http('GET', {}, '/api/auth/me'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.body)).toMatchObject({ authenticated: false });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
