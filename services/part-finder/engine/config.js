/**
 * Diagnosis engine configuration: catalogue API endpoints, model tuning, request limits and the admin-configured
 * inference providers. Read once at cold start from the environment; defaults are the production values.
 */
const { resolveProvidersFromAdminConfig } = require('../inference.js');
const { loadAdminInference } = require('../admin-config.js');

// --- Configuration (env-overridable) ---
// NOTE: LM_STUDIO_URL is now read inside inference.js (the provider boundary).
// UNDERSTAND/COMPOSE provider + model are configured via UNDERSTAND_PROVIDER /
// UNDERSTAND_MODEL / COMPOSE_PROVIDER / COMPOSE_MODEL (default: local lmstudio).
const SEARCH_API =
  process.env.SEARCH_API ||
  'https://65vnizdmk4.execute-api.eu-west-1.amazonaws.com/api/search';

const PARTS_FOR_MODEL_API =
  process.env.PARTS_FOR_MODEL_API ||
  'https://65vnizdmk4.execute-api.eu-west-1.amazonaws.com/api/parts-for-model';

// Model tuning
const LM_TEMPERATURE = numEnv('LM_TEMPERATURE', 0.3);

 // compose pass
const LM_MAX_TOKENS = numEnv('LM_MAX_TOKENS', 700);

const LM_TIMEOUT_MS = numEnv('LM_TIMEOUT_MS', 240000);

// Mild repeat penalty stops the compose pass looping (observed on Qwen 27B).
const LM_REPEAT_PENALTY = numEnv('LM_REPEAT_PENALTY', 1.1);

// Inference providers for UNDERSTAND and COMPOSE, resolved independently from
// configuration (see inference.js). Default is local LM Studio for both, which
// keeps the request byte-for-byte identical to the previous inline code. A
// misconfigured remote raises a clear error (no silent fallback to local).
// Cached at cold start; getProviders() re-resolves only if resolution failed.
let _providers = null;

let _providersAt = 0;

const PROVIDERS_TTL_MS = Number(process.env.AI_CONFIG_CACHE_TTL_MS || 60000);

// Resolve the per-stage providers from the admin-managed config (source of
// truth), cached for a short TTL so an admin routing change becomes effective
// within ~PROVIDERS_TTL_MS with no redeploy and no per-token secrets lookup.
// When no admin config exists (or it's unreadable) this falls back to the
// env-based local/local default — the safe production baseline. A frontier
// misconfiguration surfaces as an explicit error (no silent fallback).
async function getProviders() {
  const now = Date.now();
  if (_providers && now - _providersAt < PROVIDERS_TTL_MS) return _providers;
  const { config, openaiKey } = await loadAdminInference({ now });
  _providers = resolveProvidersFromAdminConfig(config, openaiKey, process.env);
  _providersAt = now;
  return _providers;
}

// Test seam: inject resolved providers and freeze the cache.
function _setProvidersForTest(p) { _providers = p; _providersAt = Date.now() + 3.6e6; }

// Input caps (defend the Lambda + upstream LM from oversized payloads)
const MAX_MESSAGES = numEnv('MAX_MESSAGES', 12);

const MAX_BODY_BYTES = numEnv('MAX_BODY_BYTES', 8 * 1024 * 1024);

 // 8 MB

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

module.exports = {
  SEARCH_API, PARTS_FOR_MODEL_API, LM_TEMPERATURE, LM_MAX_TOKENS, LM_TIMEOUT_MS, LM_REPEAT_PENALTY, getProviders,
  _setProvidersForTest, MAX_MESSAGES, MAX_BODY_BYTES,
};
