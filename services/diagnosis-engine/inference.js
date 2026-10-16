'use strict';
/**
 * The advisor's model: Claude through the Anthropic Messages API, with tools (ac2/advisor.js).
 *
 * Since change 23.3 the engine has one model and one provider. The admin AI configuration names the model
 * (Settings); the API key is the `anthropicApiKey` field of the credential secret (admin-config.js). There is no
 * fallback provider: a missing key or model is an explicit CONFIG error, so a misconfiguration is never hidden behind
 * another model's answers.
 */

const https = require('https');
const http = require('http');

/**
 * A provider failure. Carries what is needed to diagnose it (provider, model, category) and never a key.
 * category: CONFIG | TIMEOUT | NETWORK
 */
class InferenceError extends Error {
  constructor(message, { provider = null, model = null, category = 'NETWORK', status = null } = {}) {
    super(message);
    this.name = 'InferenceError';
    this.provider = provider;
    this.model = model;
    this.category = category;
    this.status = status;
  }
}

/** One HTTPS request; resolves { status, body } for any status, rejects on a network error or timeout. */
const defaultTransport = {
  request(urlStr, { method = 'POST', headers = {}, body, timeoutMs }) {
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
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      if (body) req.write(body);
      req.end();
    });
  },
};

/** The Anthropic Messages API. */
class AnthropicProvider {
  constructor({ baseUrl = 'https://api.anthropic.com/v1', apiKey, model, transport } = {}) {
    this.name = 'anthropic';
    this.endpoint = baseUrl.replace(/\/$/, '') + '/messages';
    this._headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    this.model = model || null;
    this._transport = transport || defaultTransport;
  }

  /**
   * One Messages API call with tools (the advisor turn). Content blocks go in and come back as the API shapes them, so
   * the caller can append the assistant content (thinking and tool_use blocks unchanged) and its tool_result blocks for
   * the next round. The system prompt and the tools are a stable prefix and are cached. A declined request is re-run
   * server-side on Anthropic's recommended fallback model (`fallbacks: "default"`).
   * req: { system, messages, tools, effort, maxTokens, timeoutMs, toolChoice }
   * -> { status, content, stopReason, usage, errorDetail? }
   */
  async converse(req) {
    const errCtx = { provider: this.name, model: this.model };
    const body = {
      model: this.model,
      max_tokens: req.maxTokens || 16000,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages,
      output_config: { effort: req.effort || 'medium' },
      fallbacks: 'default',
    };
    if (req.tools && req.tools.length) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice || { type: 'auto' };
    }
    const headers = { ...this._headers, 'anthropic-beta': 'server-side-fallback-2026-07-01' };
    let res;
    try {
      res = await this._transport.request(this.endpoint, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs: req.timeoutMs });
    } catch (err) {
      throw new InferenceError(`${this.name} request failed: ${err.message}`, { ...errCtx, category: /timeout/i.test(err.message) ? 'TIMEOUT' : 'NETWORK' });
    }
    // The provider's own error message, bounded; never a credential (the API never echoes the key).
    if (res.status !== 200) return { status: res.status, content: [], stopReason: null, usage: null, errorDetail: String(res.body || '').replace(/\s+/g, ' ').slice(0, 300) };
    let parsed;
    try { parsed = JSON.parse(res.body); } catch { return { status: 502, content: [], stopReason: null, usage: null, errorDetail: 'unparseable response' }; }
    const u = parsed.usage || {};
    const usage = { promptTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), completionTokens: u.output_tokens ?? null,
      cacheReadTokens: u.cache_read_input_tokens || 0, cacheWriteTokens: u.cache_creation_input_tokens || 0, uncachedInputTokens: u.input_tokens || 0 };
    if (parsed.stop_reason === 'refusal') return { status: 422, content: [], stopReason: 'refusal', usage, errorDetail: `refusal ${(parsed.stop_details && parsed.stop_details.category) || ''}`.trim() };
    return { status: 200, content: Array.isArray(parsed.content) ? parsed.content : [], stopReason: parsed.stop_reason || null, usage };
  }
}

/** The model the admin AI configuration names: `{ model }`, or `{ frontier: { model } }` in a document written before 23.3. */
function modelOf(aiConfig) {
  if (!aiConfig || typeof aiConfig !== 'object') return null;
  const m = typeof aiConfig.model === 'string' ? aiConfig.model
    : (aiConfig.frontier && typeof aiConfig.frontier.model === 'string' ? aiConfig.frontier.model : '');
  return m.trim() || null;
}

/**
 * The advisor's provider from the admin AI configuration and the credential. A missing model or key is a CONFIG error
 * (no fallback). deps.transport is injectable for tests and the health check.
 */
function resolveAdvisorProvider(aiConfig, anthropicKey, deps = {}) {
  const model = modelOf(aiConfig);
  if (!model) throw new InferenceError('No advisor model is configured (admin AI configuration)', { provider: 'anthropic', category: 'CONFIG' });
  if (!anthropicKey) throw new InferenceError('No Anthropic API key is available (the credential secret has no anthropicApiKey)', { provider: 'anthropic', model, category: 'CONFIG' });
  return new AnthropicProvider({ apiKey: anthropicKey, model, transport: deps.transport, ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}) });
}

module.exports = { InferenceError, AnthropicProvider, resolveAdvisorProvider, modelOf, defaultTransport };
