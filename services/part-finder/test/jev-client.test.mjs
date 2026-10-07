/**
 * Jev Cloudflare client: envelope unwrap, error categories, no credential logs.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateJev, JevError, unwrapCloudflare, redact } = require('../jev-client.js');

function fakeTransport({ status = 200, body, throwMsg } = {}) {
  const calls = [];
  return {
    calls,
    async transport(url, opts) {
      calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      if (throwMsg) throw new Error(throwMsg);
      return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
    },
  };
}

const jevBody = {
  model: 'jev-1.13.0',
  answers: { onTopic: { type: 'noul', noul: 0.99 } },
  usage: { input_tokens: 12, output_tokens: 4 },
};

describe('evaluateJev', () => {
  it('unwraps a Cloudflare success envelope', async () => {
    const t = fakeTransport({ body: { success: true, result: jevBody } });
    const res = await evaluateJev({
      accountId: 'abc',
      apiToken: 'tok_secret',
      state: 'hi',
      questions: { onTopic: { type: 'noul', instructions: 'on topic?' } },
      transport: t.transport,
    });
    expect(res.model).toBe('jev-1.13.0');
    expect(res.answers.onTopic.noul).toBe(0.99);
    expect(t.calls[0].url).toMatch(/\/accounts\/abc\/ai\/run$/);
    expect(t.calls[0].body.model).toBe('typesafe/jev');
    expect(t.calls[0].body.input.questions.onTopic.type).toBe('noul');
    expect(t.calls[0].headers.Authorization).toBe('Bearer tok_secret');
  });

  it('accepts a bare answers payload', async () => {
    const t = fakeTransport({ body: jevBody });
    const res = await evaluateJev({
      accountId: 'abc', apiToken: 'tok', state: 'hi',
      questions: { onTopic: { type: 'noul', instructions: 'x' } },
      transport: t.transport,
    });
    expect(res.answers.onTopic.noul).toBe(0.99);
  });

  it('AUTH on 401', async () => {
    const t = fakeTransport({ status: 401, body: { success: false } });
    await expect(evaluateJev({
      accountId: 'abc', apiToken: 'tok', state: 'hi',
      questions: { onTopic: { type: 'noul', instructions: 'x' } },
      transport: t.transport,
    })).rejects.toMatchObject({ name: 'JevError', category: 'AUTH' });
  });

  it('TIMEOUT on transport timeout', async () => {
    const t = fakeTransport({ throwMsg: 'Request timeout' });
    await expect(evaluateJev({
      accountId: 'abc', apiToken: 'tok', state: 'hi',
      questions: { onTopic: { type: 'noul', instructions: 'x' } },
      transport: t.transport,
    })).rejects.toMatchObject({ category: 'TIMEOUT' });
  });

  it('MALFORMED when answers are missing', async () => {
    const t = fakeTransport({ body: { success: true, result: { model: 'jev-1.13.0' } } });
    await expect(evaluateJev({
      accountId: 'abc', apiToken: 'tok', state: 'hi',
      questions: { onTopic: { type: 'noul', instructions: 'x' } },
      transport: t.transport,
    })).rejects.toMatchObject({ category: 'MALFORMED' });
  });

  it('CONFIG when credentials are missing', async () => {
    await expect(evaluateJev({
      accountId: null, apiToken: null, state: 'hi',
      questions: { onTopic: { type: 'noul', instructions: 'x' } },
    })).rejects.toMatchObject({ category: 'CONFIG' });
  });

  it('never puts the token in error messages', async () => {
    const t = fakeTransport({ status: 500, body: 'nope' });
    let err;
    try {
      await evaluateJev({
        accountId: 'abc', apiToken: 'very-secret-token', state: 'hi',
        questions: { onTopic: { type: 'noul', instructions: 'x' } },
        transport: t.transport,
      });
    } catch (e) { err = e; }
    expect(JSON.stringify({ m: err.message, ...err })).not.toContain('very-secret-token');
  });
});

describe('helpers', () => {
  it('unwrapCloudflare prefers result.answers', () => {
    expect(unwrapCloudflare({ result: jevBody }).model).toBe('jev-1.13.0');
    expect(unwrapCloudflare(jevBody).answers.onTopic.noul).toBe(0.99);
    expect(unwrapCloudflare({})).toBe(null);
  });
  it('unwraps the live Cloudflare Workers AI nested envelope', () => {
    const live = {
      success: true,
      errors: [],
      messages: [],
      result: {
        state: 'ping',
        result: jevBody,
        gatewayMetadata: { keySource: 'api-token' },
      },
    };
    expect(unwrapCloudflare(live).model).toBe('jev-1.13.0');
    expect(unwrapCloudflare(live).answers.onTopic.noul).toBe(0.99);
  });
  it('redact does not echo a secret', () => {
    expect(redact('very-secret-token')).not.toBe('very-secret-token');
  });
});
