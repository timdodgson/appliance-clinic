/**
 * Diagnosis engine configuration: the S4R Parts Catalogue endpoint, request limits and the admin-configured inference
 * providers. Read once at cold start from the environment; defaults are the production values.
 */
const { resolveProvidersFromAdminConfig } = require('../inference.js');
const { loadAdminInference } = require('../admin-config.js');

// --- Configuration (env-overridable) ---
// The reasoning provider and model come from the Admin AI configuration (inference.js, the provider boundary).
// S4R Parts Catalogue (external service): compatible parts for a confirmed model.
const PARTS_FOR_MODEL_API =
  process.env.PARTS_FOR_MODEL_API ||
  'https://65vnizdmk4.execute-api.eu-west-1.amazonaws.com/api/parts-for-model';

// Inference providers, resolved from the Admin AI configuration (see inference.js). Default is local LM Studio. A
// misconfigured remote raises a clear error (no silent fallback to local).
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
const MAX_BODY_BYTES = numEnv('MAX_BODY_BYTES', 8 * 1024 * 1024); // 8 MB

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

module.exports = {
  PARTS_FOR_MODEL_API, getProviders, _setProvidersForTest, MAX_MESSAGES, MAX_BODY_BYTES,
};
