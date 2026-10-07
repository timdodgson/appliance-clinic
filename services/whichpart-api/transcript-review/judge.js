'use strict';

/**
 * LLM judge caller for production transcript review.
 * Inject callJudge(messages, cfg) in tests. Never coupled to the GOLD harness.
 */

const schema = require('./schema');
const { resolveReviewConfig, endpointFor } = require('./config');

function extractJsonObject(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* fall through */ }
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

function parseJudgeResponse(text) {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, error: 'malformed-judge-output' };
  return schema.validateAssessment(obj);
}

async function defaultCallJudge(messages, cfg) {
  if (!cfg || !cfg.provider) throw new Error('review-not-configured');
  const base = endpointFor(cfg);
  if (!base) throw new Error('review-endpoint-missing');
  const headers = { 'Content-Type': 'application/json' };
  const body = {
    messages: messages,
    stream: false,
  };
  if (cfg.provider === 'openai') {
    const aiConfig = require('../ai-config');
    const key = await aiConfig.getKey();
    if (!key) throw new Error('no-api-key');
    headers.Authorization = 'Bearer ' + key;
    body.max_completion_tokens = 1200;
    body.response_format = { type: 'json_object' };
    if (!cfg.model) throw new Error('model-not-configured');
    body.model = cfg.model;
  } else if (cfg.provider === 'lmstudio') {
    headers['ngrok-skip-browser-warning'] = '1';
    body.max_tokens = 1200;
    body.temperature = 0.2;
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'transcript_review', schema: schema.jsonSchemaForJudge() },
    };
    if (cfg.model) body.model = cfg.model;
  } else {
    throw new Error('unknown-review-provider');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error('judge-http-' + res.status);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('judge-http-unreadable'); }
    const text = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content
      : null;
    if (typeof text !== 'string') throw new Error('judge-empty-content');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function judgeRecord(rec, opts) {
  const now = (opts && opts.now) || new Date();
  const cfg = (opts && opts.config) || resolveReviewConfig(opts && opts.env);
  // Jev is the semantic authority for production review: every quality/progression decision is a
  // typed Jev `choice`/`noul`. The injectable `callJudge` seam is reused — for the jev provider it
  // is the Jev `evaluate(state, questions) -> answers` hook (tests pass a typed mock); in production
  // it is unset and jev-review calls Jev with the stored Cloudflare credentials.
  if (cfg.provider === 'jev') {
    return require('./jev-review').judgeViaJev(rec, {
      now,
      evaluate: opts && opts.callJudge,
      credentials: opts && opts.jevCredentials,
      env: opts && opts.env,
    });
  }
  const prompt = require('./prompt').buildJudgePrompt(rec, now);
  const callJudge = (opts && opts.callJudge) || defaultCallJudge;
  const text = await callJudge(prompt.messages, cfg);
  const parsed = parseJudgeResponse(text);
  return {
    parsed: parsed,
    promptVersion: prompt.version,
    config: { provider: cfg.provider || null, model: cfg.model || null },
  };
}

module.exports = {
  parseJudgeResponse,
  extractJsonObject,
  defaultCallJudge,
  judgeRecord,
  resolveReviewConfig,
};
