'use strict';
/**
 * Inference provider boundary for ApplianceClinic.
 *
 * The diagnostic pipeline (UNDERSTAND + COMPOSE in part-finder-lambda.js) used
 * to call LM Studio directly over an OpenAI-compatible HTTP endpoint. This
 * module turns that into an INFRASTRUCTURE boundary: the engine now depends on
 * a small `infer()` contract and no longer knows which provider serves the
 * inference.
 *
 * It is deliberately NOT a second diagnostic implementation — a provider
 * supplies raw inference only (messages in, text out). All grounding, safety,
 * RAG, error-code and response-contract logic stays in the engine.
 *
 * Providers:
 *   - LMStudioProvider  (default, local, concurrency=1 for validation)
 *   - OpenAIProvider    (one remote implementation, OpenAI-compatible)
 *
 * UNDERSTAND and COMPOSE are resolved INDEPENDENTLY from configuration, so any
 * local/remote combination is possible without code changes. There is NO silent
 * fallback from remote to local — a misconfigured remote is an explicit error,
 * because a hidden fallback would invalidate quality/cost comparisons and mask
 * production availability problems.
 */

const https = require('https');
const http = require('http');

// --- Error type -------------------------------------------------------------

/**
 * A provider/inference failure. Carries enough internal context to diagnose
 * (provider, stage, model, category) but never a raw key/secret.
 * category ∈ CONFIG | TIMEOUT | HTTP | NETWORK | EMPTY
 */
class InferenceError extends Error {
  constructor(message, { provider = null, stage = null, model = null, category = 'HTTP', status = null } = {}) {
    super(message);
    this.name = 'InferenceError';
    this.provider = provider;
    this.stage = stage;
    this.model = model;
    this.category = category;
    this.status = status;
  }
}

// --- Default transport (byte-for-byte equivalent to the previous engine code)-
// Injectable so tests never touch the network. `request` mirrors the old
// httpRequest (resolves {status,body} even on non-200; rejects on error/timeout).
// `stream` mirrors the old httpStream (SSE `data:` lines; rejects on non-200/timeout).

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

  stream(urlStr, { headers = {}, body, timeoutMs, onEvent }) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const mod = url.protocol === 'https:' ? https : http;
      const h = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'text/event-stream',
        ...headers,
      };
      const req = mod.request(url, { method: 'POST', headers: h, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => (errBody += c));
          res.on('end', () => reject(Object.assign(new Error(`stream LM status ${res.statusCode} ${errBody.slice(0, 200)}`), { statusCode: res.statusCode })));
          return;
        }
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]') continue;
            try {
              onEvent(JSON.parse(dataStr));
            } catch {
              /* ignore keep-alive / non-JSON lines */
            }
          }
        });
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    });
  },
};

// --- Response normalisation (keeps provider-specific shapes out of the engine)

/** Map an OpenAI-compatible usage object to a stable, provider-neutral shape. */
function normaliseUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = u.prompt_tokens ?? u.promptTokens ?? null;
  const completion = u.completion_tokens ?? u.completionTokens ?? null;
  const total = u.total_tokens ?? u.totalTokens ?? (prompt != null && completion != null ? prompt + completion : null);
  if (prompt == null && completion == null && total == null) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

// --- Base provider (OpenAI-compatible chat/completions) ---------------------

class OpenAICompatibleProvider {
  constructor({ name, endpoint, headers = {}, model, transport, stage = null, includeUsageOnStream = false, paramStyle = 'local' }) {
    this.name = name;
    this.endpoint = endpoint;
    this._headers = headers;
    this.model = model || null;
    this.stage = stage;
    this._transport = transport || defaultTransport;
    this._includeUsageOnStream = includeUsageOnStream;
    // Request-parameter dialect. 'local' = classic Chat Completions (LM Studio:
    // max_tokens, temperature, repeat_penalty). 'openai' = current OpenAI models
    // incl. GPT-5/o-series, which require max_completion_tokens, reject
    // repeat_penalty, and only accept the default temperature — so we omit it.
    this._paramStyle = paramStyle;
    // Capabilities are declared explicitly so the engine/config can reason about
    // them rather than assuming. Both current providers are fully capable.
    this.capabilities = { structuredOutput: true, vision: true, seed: true, streaming: true };
  }

  /**
   * Build the OpenAI-compatible request body from the engine's generic request.
   * A `model` is only emitted when configured — so the LM Studio path stays
   * byte-for-byte identical to the previous inline payload (which sent none).
   */
  _body(req) {
    const body = { messages: req.messages, stream: !!req.stream };
    if (this._paramStyle === 'openai') {
      // Current OpenAI models: token cap is max_completion_tokens; temperature
      // other than the default is rejected by GPT-5/o-series, so we omit it and
      // accept the model default; repeat_penalty is not an OpenAI parameter.
      body.max_completion_tokens = req.maxTokens;
    } else {
      // LM Studio / classic Chat Completions — unchanged (byte-for-byte).
      body.temperature = req.temperature;
      body.max_tokens = req.maxTokens;
      if (req.repeatPenalty !== undefined) body.repeat_penalty = req.repeatPenalty;
    }
    if (req.seed !== undefined) body.seed = req.seed;
    if (req.responseFormat) body.response_format = req.responseFormat;
    if (this.model) body.model = this.model;
    if (req.stream && this._includeUsageOnStream) body.stream_options = { include_usage: true };
    return body;
  }

  /**
   * infer(request[, { onDelta }])
   *   non-stream -> { status, text, usage }   (text = assistant message content)
   *   stream     -> calls onDelta(textChunk); resolves { status, text, usage }
   * Throws InferenceError on transport failure (timeout/network) or a non-200
   * streaming response, mirroring the previous engine behaviour exactly.
   */
  async infer(req, { onDelta } = {}) {
    const body = JSON.stringify(this._body(req));
    const errCtx = { provider: this.name, stage: this.stage, model: this.model };

    if (req.stream) {
      let text = '';
      let usage = null;
      try {
        await this._transport.stream(this.endpoint, {
          headers: this._headers,
          body,
          timeoutMs: req.timeoutMs,
          onEvent: (evt) => {
            const delta = evt && evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
            if (delta) {
              text += delta;
              if (onDelta) onDelta(delta);
            }
            if (evt && evt.usage) usage = normaliseUsage(evt.usage);
          },
        });
      } catch (err) {
        const category = /timeout/i.test(err.message) ? 'TIMEOUT' : (err.statusCode ? 'HTTP' : 'NETWORK');
        throw new InferenceError(`${this.name} stream failed: ${err.message}`, { ...errCtx, category, status: err.statusCode || null });
      }
      return { status: 200, text, usage };
    }

    let res;
    try {
      res = await this._transport.request(this.endpoint, { method: 'POST', headers: this._headers, body, timeoutMs: req.timeoutMs });
    } catch (err) {
      const category = /timeout/i.test(err.message) ? 'TIMEOUT' : 'NETWORK';
      throw new InferenceError(`${this.name} request failed: ${err.message}`, { ...errCtx, category });
    }
    // Non-200 is returned (not thrown) so the engine keeps its existing
    // status-check + graceful-degrade behaviour rather than retrying a 4xx/5xx.
    if (res.status !== 200) {
      return { status: res.status, text: '', usage: null };
    }
    let text = '';
    let usage = null;
    try {
      const parsed = JSON.parse(res.body);
      text = (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '';
      usage = normaliseUsage(parsed.usage);
    } catch {
      // Malformed transport JSON — surface as empty text; the engine's own JSON
      // parse of the (empty) content then degrades gracefully, as before.
      text = '';
    }
    return { status: res.status, text, usage };
  }
}

// --- Concrete providers -----------------------------------------------------

class LMStudioProvider extends OpenAICompatibleProvider {
  constructor({ baseUrl = 'http://localhost:1234', model, transport, stage } = {}) {
    super({
      name: 'lmstudio',
      endpoint: baseUrl.replace(/\/$/, '') + '/v1/chat/completions',
      headers: {},
      model,
      transport,
      stage,
      includeUsageOnStream: false, // LM Studio streams without a usage frame
    });
    this.baseUrl = baseUrl;
  }
}

class OpenAIProvider extends OpenAICompatibleProvider {
  constructor({ baseUrl = 'https://api.openai.com/v1', apiKey, model, transport, stage } = {}) {
    super({
      name: 'openai',
      endpoint: baseUrl.replace(/\/$/, '') + '/chat/completions',
      headers: { Authorization: `Bearer ${apiKey}` },
      model,
      transport,
      stage,
      includeUsageOnStream: true, // ask OpenAI to emit a usage frame on streams
      paramStyle: 'openai',       // max_completion_tokens; no temperature/repeat_penalty
    });
    this.baseUrl = baseUrl;
  }
}

// --- Per-stage configuration resolver ---------------------------------------

const KNOWN_PROVIDERS = ['lmstudio', 'openai'];

/**
 * Resolve the provider for one stage ('UNDERSTAND' | 'COMPOSE') from env.
 *
 * Env (per stage, with a shared LLM_PROVIDER fallback):
 *   <STAGE>_PROVIDER   lmstudio | openai   (default lmstudio)
 *   <STAGE>_MODEL      model id            (required for openai; optional for lmstudio)
 *   LM_STUDIO_URL      lmstudio base url   (default http://localhost:1234)
 *   OPENAI_API_KEY     openai credential   (required when openai selected)
 *   OPENAI_BASE_URL    openai base url     (default https://api.openai.com/v1)
 *
 * Throws InferenceError(category CONFIG) for: unknown provider, remote selected
 * with a missing credential, or remote selected with no model. Never falls back.
 */
function resolveStageProvider(stage, env = process.env, deps = {}) {
  const providerName = (env[`${stage}_PROVIDER`] || env.LLM_PROVIDER || 'lmstudio').toLowerCase();
  const model = env[`${stage}_MODEL`] || undefined;
  const transport = deps.transport;

  if (!KNOWN_PROVIDERS.includes(providerName)) {
    throw new InferenceError(
      `Unknown ${stage}_PROVIDER '${providerName}'. Known providers: ${KNOWN_PROVIDERS.join(', ')}.`,
      { provider: providerName, stage, category: 'CONFIG' },
    );
  }

  if (providerName === 'lmstudio') {
    return new LMStudioProvider({ baseUrl: env.LM_STUDIO_URL || 'http://localhost:1234', model, transport, stage });
  }

  // openai (remote)
  const apiKey = env.OPENAI_API_KEY || deps.apiKey;
  if (!apiKey) {
    throw new InferenceError(
      `${stage}_PROVIDER=openai but OPENAI_API_KEY is not configured — refusing to fall back to local (would hide the misconfiguration).`,
      { provider: 'openai', stage, category: 'CONFIG' },
    );
  }
  if (!model) {
    throw new InferenceError(
      `${stage}_PROVIDER=openai but ${stage}_MODEL is not set — a remote model id is required.`,
      { provider: 'openai', stage, category: 'CONFIG' },
    );
  }
  return new OpenAIProvider({ baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey, model, transport, stage });
}

/** Resolve both stages independently. */
function resolveProviders(env = process.env, deps = {}) {
  return {
    understand: resolveStageProvider('UNDERSTAND', env, deps),
    compose: resolveStageProvider('COMPOSE', env, deps),
  };
}

/**
 * Resolve providers from the admin-managed operational config (the runtime
 * source of truth). Routing maps: local -> LM Studio, frontier -> OpenAI, per
 * stage independently.
 *
 * When `aiConfig` is null/absent (secret not created or unreadable) this falls
 * back to the env-based default (local/local) — the safe production baseline.
 * A stage routed to frontier without a usable key/model raises a CONFIG error
 * (NO silent fallback to local), matching the abstraction's failure semantics.
 *
 * For LOCAL, the endpoint is the admin override if set, otherwise the
 * orchestrator's own deployed LM_STUDIO_URL — so a blank admin endpoint never
 * breaks the deployed local connection.
 */
function resolveProvidersFromAdminConfig(aiConfig, openaiKey, env = process.env, deps = {}) {
  if (!aiConfig || !aiConfig.routing) return resolveProviders(env, deps);

  const local = aiConfig.local || {};
  const frontier = aiConfig.frontier || {};

  const pick = (stage, kind) => {
    if (kind === 'frontier') {
      if (!openaiKey) {
        throw new InferenceError(`${stage} routed to frontier but no OpenAI API key is available`, { provider: 'openai', stage, category: 'CONFIG' });
      }
      if (!frontier.model) {
        throw new InferenceError(`${stage} routed to frontier but no frontier model is configured`, { provider: 'openai', stage, category: 'CONFIG' });
      }
      return new OpenAIProvider({ baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: openaiKey, model: frontier.model, transport: deps.transport, stage });
    }
    const baseUrl = (local.endpoint && String(local.endpoint).trim()) || env.LM_STUDIO_URL || 'http://localhost:1234';
    return new LMStudioProvider({ baseUrl, model: (local.model && String(local.model).trim()) || undefined, transport: deps.transport, stage });
  };

  return {
    understand: pick('UNDERSTAND', aiConfig.routing.understand === 'frontier' ? 'frontier' : 'local'),
    compose: pick('COMPOSE', aiConfig.routing.compose === 'frontier' ? 'frontier' : 'local'),
  };
}

module.exports = {
  InferenceError,
  OpenAICompatibleProvider,
  LMStudioProvider,
  OpenAIProvider,
  resolveStageProvider,
  resolveProviders,
  resolveProvidersFromAdminConfig,
  normaliseUsage,
  defaultTransport,
  KNOWN_PROVIDERS,
};
