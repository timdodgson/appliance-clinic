'use strict';

/**
 * Configurable model/provider for production transcript semantic review.
 * Model names are not hard-coded in application logic — they come from env.
 */

function resolveReviewConfig(env) {
  const e = env || process.env;
  const enabled = String(e.TRANSCRIPT_REVIEW_ENABLED == null ? '1' : e.TRANSCRIPT_REVIEW_ENABLED) !== '0';
  const provider = String(e.TRANSCRIPT_REVIEW_PROVIDER || '').trim().toLowerCase();
  const model = String(e.TRANSCRIPT_REVIEW_MODEL || '').trim();
  const url = String(e.TRANSCRIPT_REVIEW_URL || '').trim();
  const maxPerRun = Math.min(10, Math.max(1, Number(e.TRANSCRIPT_REVIEW_MAX_PER_RUN) || 3));
  return { enabled, provider, model, url, maxPerRun };
}

function endpointFor(cfg) {
  if (cfg.url) return openAiCompatBase(cfg.url);
  if (cfg.provider === 'lmstudio') {
    return openAiCompatBase(process.env.LM_STUDIO_URL || '');
  }
  if (cfg.provider === 'openai') {
    return openAiCompatBase(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
  }
  return '';
}

function openAiCompatBase(raw) {
  let base = String(raw || '').replace(/\/$/, '');
  if (!base) return '';
  if (!/\/v\d+$/i.test(base)) base += '/v1';
  return base;
}

module.exports = { resolveReviewConfig, endpointFor, openAiCompatBase };
