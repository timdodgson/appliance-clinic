/**
 * The advisor's provider (inference.js): the Anthropic Messages API call with tools, and the resolution of the one
 * model from the admin AI configuration and the credential. Offline: a fake transport, no model call.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InferenceError, AnthropicProvider, resolveAdvisorProvider, modelOf } = require('../inference.js');

const fake = (status, body) => { const calls = []; return { calls, request: async (url, opts) => { calls.push({ url, ...opts, body: JSON.parse(opts.body) }); return { status, body: typeof body === 'string' ? body : JSON.stringify(body) }; } }; };
const TOOLS = [{ name: 'find_parts', description: 'd', strict: true, input_schema: { type: 'object', additionalProperties: false, required: ['model'], properties: { model: { type: 'string' } } } }];

describe('AnthropicProvider.converse (the advisor)', () => {
  it('sends tools, the cached system prompt, medium effort and server-side fallback; returns the content blocks and usage', async () => {
    const blocks = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't1', name: 'find_parts', input: { model: 'V6' } }];
    const t = fake(200, { content: blocks, stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } });
    const p = new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', transport: t });
    const r = await p.converse({ system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: TOOLS, effort: 'medium', maxTokens: 16000, timeoutMs: 1000 });
    const { url, headers, body } = t.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' });
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default', output_config: { effort: 'medium' }, tools: TOOLS, tool_choice: { type: 'auto' },
      system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }] });
    expect(body).not.toHaveProperty('thinking');
    expect(r).toMatchObject({ status: 200, stopReason: 'tool_use', content: blocks, usage: { promptTokens: 100, completionTokens: 5, cacheReadTokens: 90 } });
  });

  it('a refusal is a non-200, never content', async () => {
    const t = fake(200, { content: [], stop_reason: 'refusal', stop_details: { category: 'bio' } });
    const r = await new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', transport: t }).converse({ system: 'S', messages: [] });
    expect(r.status).toBe(422);
    expect(r.content).toEqual([]);
  });

  it('a non-200 is returned with a bounded detail; an unparseable body is a 502', async () => {
    const r = await new AnthropicProvider({ apiKey: 'k', model: 'm', transport: fake(529, { type: 'error', error: { type: 'overloaded_error', message: 'x'.repeat(1000) } }) }).converse({ system: 'S', messages: [] });
    expect(r.status).toBe(529);
    expect(r.errorDetail.length).toBeLessThanOrEqual(300);
    expect(r.content).toEqual([]);
    expect((await new AnthropicProvider({ apiKey: 'k', model: 'm', transport: fake(200, 'not json') }).converse({ system: 'S', messages: [] })).status).toBe(502);
  });

  it('a transport timeout or network failure is an InferenceError that never carries the key', async () => {
    const down = { request: () => Promise.reject(new Error('Request timeout')) };
    const p = new AnthropicProvider({ apiKey: 'sk-super-secret', model: 'm', transport: down });
    let err;
    try { await p.converse({ system: 'S', messages: [] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(InferenceError);
    expect(err.category).toBe('TIMEOUT');
    expect(JSON.stringify({ m: err.message, ...err })).not.toContain('sk-super-secret');
  });
});

describe('resolveAdvisorProvider: one model, from the admin AI configuration', () => {
  it('takes the model from { model }, or from frontier.model in a document written before 23.3', () => {
    expect(modelOf({ model: ' claude-opus-5-5 ' })).toBe('claude-opus-5-5');
    expect(modelOf({ routing: { compose: 'frontier' }, frontier: { provider: 'anthropic', model: 'claude-opus-5-5' } })).toBe('claude-opus-5-5');
    expect(modelOf({ frontier: { model: '' } })).toBeNull();
    expect(modelOf(null)).toBeNull();
    const p = resolveAdvisorProvider({ model: 'claude-opus-5-5' }, 'k');
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect([p.name, p.model]).toEqual(['anthropic', 'claude-opus-5-5']);
  });

  it('no model or no key is an explicit CONFIG error (no fallback), and the message never carries the key', () => {
    const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
    const noModel = errOf(() => resolveAdvisorProvider({ model: '' }, 'sk-super-secret'));
    expect(noModel).toBeInstanceOf(InferenceError);
    expect(noModel.category).toBe('CONFIG');
    expect(noModel.message).not.toContain('sk-super-secret');
    const noKey = errOf(() => resolveAdvisorProvider({ model: 'claude-opus-5-5' }, null));
    expect(noKey.category).toBe('CONFIG');
    expect(noKey.message).toMatch(/Anthropic API key/);
  });
});
