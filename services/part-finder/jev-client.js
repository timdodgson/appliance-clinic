'use strict';
/**
 * Cloudflare Workers AI / AI Gateway client for TypeSafe Jev.
 *
 * The rest of ApplianceClinic never sees Cloudflare request/response shapes.
 * Credentials are loaded from Secrets Manager (or env for local eval) and are
 * never logged.
 */

const https = require('https');
const http = require('http');

const JEV_MODEL = 'typesafe/jev';
const DEFAULT_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 15000);
const DEFAULT_ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts';

class JevError extends Error {
  constructor(message, { category = 'HTTP', status = null } = {}) {
    super(message);
    this.name = 'JevError';
    this.category = category; // CONFIG | AUTH | TIMEOUT | HTTP | NETWORK | MALFORMED | INCOMPLETE
    this.status = status;
  }
}

function defaultTransport(urlStr, { method = 'POST', headers = {}, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const h = { ...headers };
    if (body) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const req = mod.request(url, { method, headers: h, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => {
      const e = new JevError(err && err.message ? err.message : 'network error', { category: 'NETWORK' });
      reject(e);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new JevError('Jev request timeout', { category: 'TIMEOUT' }));
    });
    if (body) req.write(body);
    req.end();
  });
}

function redact(value) {
  if (!value) return value;
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 3)}…${s.slice(-2)}`;
}

function hasAnswers(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.answers && typeof obj.answers === 'object' && !Array.isArray(obj.answers));
}

/**
 * Cloudflare Workers AI wraps Jev as:
 *   { success, result: { state, result: { model, answers, usage }, gatewayMetadata } }
 * Docs sometimes show a flatter { result: { model, answers } } or a bare answers body.
 */
function unwrapCloudflare(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const nested = parsed.result && typeof parsed.result === 'object' ? parsed.result : null;
  const holders = [
    parsed,
    nested,
    nested && nested.result,
    nested && nested.response,
    parsed.response,
  ];
  for (const holder of holders) {
    if (hasAnswers(holder)) return holder;
  }
  return null;
}

function classifyHttp(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 408 || status === 504) return 'TIMEOUT';
  return 'HTTP';
}

/**
 * Call Jev once with a state + typed questions map.
 * @returns {{ model: string, answers: object, usage: object|null, latencyMs: number }}
 */
async function evaluateJev({ accountId, apiToken, gatewayId, state, questions, timeoutMs, transport }) {
  if (!accountId || !apiToken) {
    throw new JevError('Jev credentials are not configured', { category: 'CONFIG' });
  }
  if (!questions || typeof questions !== 'object' || !Object.keys(questions).length) {
    throw new JevError('Jev questions are required', { category: 'MALFORMED' });
  }
  const started = Date.now();
  const url = `${DEFAULT_ENDPOINT}/${encodeURIComponent(accountId)}/ai/run`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    Accept: 'application/json',
  };
  if (gatewayId) headers['cf-aig-gateway-id'] = String(gatewayId);
  const payload = JSON.stringify({
    model: JEV_MODEL,
    input: { state, questions },
  });
  const send = transport || defaultTransport;
  let res;
  try {
    res = await send(url, {
      method: 'POST',
      headers,
      body: payload,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof JevError) throw err;
    const msg = err && err.message ? err.message : 'network error';
    const category = /timeout/i.test(msg) ? 'TIMEOUT' : 'NETWORK';
    throw new JevError(msg, { category });
  }
  const latencyMs = Date.now() - started;
  if (!res || (res.status !== 200 && res.status !== 201)) {
    const status = res ? res.status : null;
    throw new JevError(`Jev HTTP ${status || 'error'}`, { category: classifyHttp(status), status });
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body || '');
  } catch {
    throw new JevError('Jev response was not JSON', { category: 'MALFORMED', status: res.status });
  }
  if (parsed && parsed.success === false) {
    const status = Array.isArray(parsed.errors) && parsed.errors[0] && parsed.errors[0].code
      ? parsed.errors[0].code
      : res.status;
    const cat = status === 10000 || status === 10001 || status === 401 || status === 403 ? 'AUTH' : 'HTTP';
    throw new JevError('Jev API reported failure', { category: cat, status });
  }
  const result = unwrapCloudflare(parsed);
  if (!result) {
    throw new JevError('Jev response missing answers', { category: 'MALFORMED', status: res.status });
  }
  return {
    model: typeof result.model === 'string' ? result.model : JEV_MODEL,
    answers: result.answers,
    usage: result.usage && typeof result.usage === 'object' ? result.usage : null,
    latencyMs,
  };
}

async function evaluateJevWithRetries(opts) {
  const attempts = Number(opts.attempts || 3);
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await evaluateJev(opts);
    } catch (err) {
      lastErr = err;
      const cat = err && err.category;
      if (cat === 'AUTH' || cat === 'CONFIG' || cat === 'MALFORMED' || cat === 'INCOMPLETE') throw err;
      if (i === attempts) throw err;
      const delay = 400 * i;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = {
  JevError,
  JEV_MODEL,
  DEFAULT_TIMEOUT_MS,
  evaluateJev,
  evaluateJevWithRetries,
  unwrapCloudflare,
  redact,
};
