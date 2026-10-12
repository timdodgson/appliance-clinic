/**
 * Provider-boundary contract, configuration, mutation, structured-output and
 * error/timeout tests for the ApplianceClinic inference abstraction.
 *
 * Fully offline and deterministic — a FAKE transport is injected, so NO real
 * (paid or local) model call is ever made. Runs under the repo vitest suite.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  InferenceError,
  LMStudioProvider,
  OpenAIProvider,
  resolveStageProvider,
  resolveProviders,
  normaliseUsage,
} = require('../inference.js');

/** A transport that records requests and returns scripted responses. */
function fakeTransport({ nonStreamBody, streamDeltas = [], streamUsage = null, throwOn = null, status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    request(url, opts) {
      calls.push({ mode: 'request', url, opts, body: JSON.parse(opts.body) });
      if (throwOn === 'request') return Promise.reject(new Error('Request timeout'));
      return Promise.resolve({ status, body: nonStreamBody ?? '' });
    },
    stream(url, opts) {
      calls.push({ mode: 'stream', url, opts, body: JSON.parse(opts.body) });
      if (throwOn === 'stream') return Promise.reject(Object.assign(new Error('boom'), { statusCode: 500 }));
      if (throwOn === 'streamTimeout') return Promise.reject(new Error('Request timeout'));
      for (const d of streamDeltas) opts.onEvent({ choices: [{ delta: { content: d } }] });
      if (streamUsage) opts.onEvent({ usage: streamUsage });
      return Promise.resolve();
    },
  };
}

const okBody = (content, usage) =>
  JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });

/** Capture a thrown error for field-level assertions. */
async function caught(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

describe('inference contract — non-stream (UNDERSTAND-style)', () => {
  it('returns normalised text + usage; provider shape does not leak', async () => {
    const t = fakeTransport({ nonStreamBody: okBody('{"faultId":"x"}', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) });
    const p = new LMStudioProvider({ transport: t });
    const res = await p.infer({ messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 900, stream: false, timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"faultId":"x"}');
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(Object.keys(res).sort()).toEqual(['status', 'text', 'usage']);
  });

  it('non-200 is returned (not thrown) so the engine can degrade', async () => {
    const p = new LMStudioProvider({ transport: fakeTransport({ status: 500, nonStreamBody: 'err' }) });
    const res = await p.infer({ messages: [], temperature: 0, maxTokens: 10, stream: false, timeoutMs: 10 });
    expect(res.status).toBe(500);
    expect(res.text).toBe('');
  });

  it('malformed transport JSON degrades to empty text (no throw)', async () => {
    const p = new LMStudioProvider({ transport: fakeTransport({ nonStreamBody: 'not json' }) });
    const res = await p.infer({ messages: [], temperature: 0, maxTokens: 10, stream: false, timeoutMs: 10 });
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });

  it('empty content normalises to empty string', async () => {
    const p = new LMStudioProvider({ transport: fakeTransport({ nonStreamBody: JSON.stringify({ choices: [{ message: {} }] }) }) });
    const res = await p.infer({ messages: [], temperature: 0, maxTokens: 10, stream: false, timeoutMs: 10 });
    expect(res.text).toBe('');
  });

  it('transport timeout throws InferenceError(TIMEOUT) with context', async () => {
    const p = new LMStudioProvider({ transport: fakeTransport({ throwOn: 'request' }), stage: 'UNDERSTAND' });
    const e = await caught(() => p.infer({ messages: [], temperature: 0, maxTokens: 10, stream: false, timeoutMs: 10 }));
    expect(e).toBeInstanceOf(InferenceError);
    expect(e.category).toBe('TIMEOUT');
    expect(e.provider).toBe('lmstudio');
    expect(e.stage).toBe('UNDERSTAND');
  });
});

describe('inference contract — stream (COMPOSE-style)', () => {
  it('calls onDelta per chunk and returns the full text', async () => {
    const p = new LMStudioProvider({ transport: fakeTransport({ streamDeltas: ['Hello', ' ', 'world'] }) });
    const chunks = [];
    const res = await p.infer(
      { messages: [], temperature: 0.3, maxTokens: 700, repeatPenalty: 1.1, stream: true, timeoutMs: 1000 },
      { onDelta: (d) => chunks.push(d) },
    );
    expect(chunks).toEqual(['Hello', ' ', 'world']);
    expect(res.text).toBe('Hello world');
  });

  it('non-200 stream throws InferenceError(HTTP)', async () => {
    const p = new LMStudioProvider({ transport: fakeTransport({ throwOn: 'stream' }), stage: 'COMPOSE' });
    const e = await caught(() => p.infer({ messages: [], temperature: 0.3, maxTokens: 700, stream: true, timeoutMs: 10 }, { onDelta() {} }));
    expect(e).toBeInstanceOf(InferenceError);
    expect(e.category).toBe('HTTP');
    expect(e.stage).toBe('COMPOSE');
  });
});

describe('no-drift — LM Studio request body is byte-for-byte equivalent to the previous inline payload', () => {
  it('UNDERSTAND body (no model field, schema forwarded)', async () => {
    const t = fakeTransport({ nonStreamBody: okBody('{}') });
    const p = new LMStudioProvider({ transport: t });
    const responseFormat = { type: 'json_schema', json_schema: { name: 'part_finder_intent', strict: true, schema: { type: 'object' } } };
    await p.infer({ messages: [{ role: 'user', content: 'x' }], temperature: 0, maxTokens: 900, stream: false, seed: 7, responseFormat, timeoutMs: 240000 });
    expect(t.calls[0].body).toEqual({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      max_tokens: 900,
      stream: false,
      seed: 7,
      response_format: responseFormat,
    });
    expect(t.calls[0].url).toBe('http://localhost:1234/v1/chat/completions');
    expect('Authorization' in (t.calls[0].opts.headers || {})).toBe(false);
  });

  it('COMPOSE body (repeat_penalty + stream)', async () => {
    const t = fakeTransport({ streamDeltas: ['ok'] });
    const p = new LMStudioProvider({ transport: t });
    await p.infer({ messages: [{ role: 'system', content: 's' }], temperature: 0.3, maxTokens: 700, repeatPenalty: 1.1, stream: true, seed: 3, timeoutMs: 240000 }, { onDelta() {} });
    expect(t.calls[0].body).toEqual({
      messages: [{ role: 'system', content: 's' }],
      temperature: 0.3,
      max_tokens: 700,
      stream: true,
      repeat_penalty: 1.1,
      seed: 3,
    });
  });

  it('omits seed when not provided', async () => {
    const t = fakeTransport({ nonStreamBody: okBody('{}') });
    const p = new LMStudioProvider({ transport: t });
    await p.infer({ messages: [], temperature: 0, maxTokens: 900, stream: false, timeoutMs: 10 });
    expect('seed' in t.calls[0].body).toBe(false);
  });
});

describe('remote adapter', () => {
  it('sends the model, Bearer auth, and usage opt-in on stream', async () => {
    const t = fakeTransport({ streamDeltas: ['hi'], streamUsage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    const p = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini', transport: t });
    const res = await p.infer({ messages: [], temperature: 0.3, maxTokens: 700, stream: true, timeoutMs: 1000 }, { onDelta() {} });
    expect(t.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(t.calls[0].opts.headers.Authorization).toBe('Bearer sk-test');
    expect(t.calls[0].body.model).toBe('gpt-4o-mini');
    expect(t.calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('never exposes the Bearer key in an InferenceError', async () => {
    const p = new OpenAIProvider({ apiKey: 'sk-super-secret', model: 'gpt-4o-mini', transport: fakeTransport({ throwOn: 'request' }), stage: 'UNDERSTAND' });
    const e = await caught(() => p.infer({ messages: [], temperature: 0, maxTokens: 10, stream: false, timeoutMs: 10 }));
    expect(e).toBeInstanceOf(InferenceError);
    expect(/sk-super-secret/.test(e.message)).toBe(false);
    expect(/sk-super-secret/.test(JSON.stringify({ p: e.provider, s: e.stage, m: e.model, c: e.category }))).toBe(false);
  });
});

describe('configuration resolution + explicit errors (no silent fallback)', () => {
  it('default config resolves lmstudio for both stages', () => {
    const p = resolveProviders({});
    expect(p.understand.name).toBe('lmstudio');
    expect(p.compose.name).toBe('lmstudio');
  });

  it('unknown provider is a CONFIG error', () => {
    const e = (() => { try { resolveStageProvider('UNDERSTAND', { UNDERSTAND_PROVIDER: 'acme' }); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(InferenceError);
    expect(e.category).toBe('CONFIG');
    expect(/Unknown UNDERSTAND_PROVIDER/.test(e.message)).toBe(true);
  });

  it('remote without credential is a CONFIG error (refuses to fall back to local)', () => {
    const e = (() => { try { resolveStageProvider('COMPOSE', { COMPOSE_PROVIDER: 'openai', COMPOSE_MODEL: 'gpt-4o-mini' }); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(InferenceError);
    expect(e.category).toBe('CONFIG');
    expect(/OPENAI_API_KEY/.test(e.message)).toBe(true);
  });

  it('remote without a model id is a CONFIG error', () => {
    const e = (() => { try { resolveStageProvider('COMPOSE', { COMPOSE_PROVIDER: 'openai', OPENAI_API_KEY: 'sk' }); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(InferenceError);
    expect(/COMPOSE_MODEL/.test(e.message)).toBe(true);
  });
});

describe('mutation — UNDERSTAND and COMPOSE are configured INDEPENDENTLY', () => {
  it('switching UNDERSTAND to remote changes only understand', () => {
    const p = resolveProviders({ UNDERSTAND_PROVIDER: 'openai', UNDERSTAND_MODEL: 'gpt-4o', OPENAI_API_KEY: 'sk' });
    expect(p.understand.name).toBe('openai');
    expect(p.understand.model).toBe('gpt-4o');
    expect(p.compose.name).toBe('lmstudio');
  });

  it('switching COMPOSE to remote changes only compose', () => {
    const p = resolveProviders({ COMPOSE_PROVIDER: 'openai', COMPOSE_MODEL: 'gpt-4o-mini', OPENAI_API_KEY: 'sk' });
    expect(p.compose.name).toBe('openai');
    expect(p.compose.model).toBe('gpt-4o-mini');
    expect(p.understand.name).toBe('lmstudio');
  });

  it('all four combinations resolve without cross-wiring, with independent models', () => {
    const key = { OPENAI_API_KEY: 'sk' };
    const A = resolveProviders({});
    expect([A.understand.name, A.compose.name]).toEqual(['lmstudio', 'lmstudio']);
    const B = resolveProviders({ ...key, UNDERSTAND_PROVIDER: 'openai', UNDERSTAND_MODEL: 'm' });
    expect([B.understand.name, B.compose.name]).toEqual(['openai', 'lmstudio']);
    const C = resolveProviders({ ...key, COMPOSE_PROVIDER: 'openai', COMPOSE_MODEL: 'm' });
    expect([C.understand.name, C.compose.name]).toEqual(['lmstudio', 'openai']);
    const D = resolveProviders({ ...key, UNDERSTAND_PROVIDER: 'openai', UNDERSTAND_MODEL: 'm', COMPOSE_PROVIDER: 'openai', COMPOSE_MODEL: 'm2' });
    expect([D.understand.name, D.compose.name]).toEqual(['openai', 'openai']);
    expect(D.understand.model).toBe('m');
    expect(D.compose.model).toBe('m2');
  });
});

describe('capabilities + usage normalisation', () => {
  it('providers declare capabilities explicitly', () => {
    expect(resolveProviders({}).understand.capabilities).toEqual({ structuredOutput: true, vision: true, seed: true, streaming: true });
  });

  it('normaliseUsage handles missing/partial usage', () => {
    expect(normaliseUsage(null)).toBe(null);
    expect(normaliseUsage({})).toBe(null);
    expect(normaliseUsage({ prompt_tokens: 4, completion_tokens: 6 })).toEqual({ promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  });
});
