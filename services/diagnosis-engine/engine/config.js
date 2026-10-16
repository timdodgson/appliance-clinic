/**
 * Diagnosis engine configuration: the S4R Parts Catalogue endpoint, request limits and the advisor's model provider.
 * Read once at cold start from the environment; defaults are the production values.
 */
const { resolveAdvisorProvider } = require('../inference.js');
const { loadAdminInference } = require('../admin-config.js');

// S4R Parts Catalogue (external service): compatible parts for a confirmed model.
const PARTS_FOR_MODEL_API =
  process.env.PARTS_FOR_MODEL_API ||
  'https://65vnizdmk4.execute-api.eu-west-1.amazonaws.com/api/parts-for-model';

// The advisor's provider, resolved from the admin AI configuration (the model) and the credential secret (the key),
// cached for a short TTL so a Settings change becomes effective within ~PROVIDER_TTL_MS with no redeploy and no
// secrets lookup per turn. A missing model or key is an explicit error at first use (no fallback).
let _provider = null;
let _providerAt = 0;
const PROVIDER_TTL_MS = Number(process.env.AI_CONFIG_CACHE_TTL_MS || 60000);

async function getAdvisorProvider() {
  const now = Date.now();
  if (_provider && now - _providerAt < PROVIDER_TTL_MS) return _provider;
  const { config, anthropicKey } = await loadAdminInference({ now });
  _provider = resolveAdvisorProvider(config, anthropicKey);
  _providerAt = now;
  return _provider;
}

// Test seam: inject the provider and freeze the cache (null clears it).
function _setProviderForTest(p) { _provider = p; _providerAt = p ? Date.now() + 3.6e6 : 0; }

// Input caps (defend the Lambda and the model from oversized payloads)
const MAX_MESSAGES = numEnv('MAX_MESSAGES', 12);
const MAX_BODY_BYTES = numEnv('MAX_BODY_BYTES', 8 * 1024 * 1024); // 8 MB

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

module.exports = {
  PARTS_FOR_MODEL_API, getAdvisorProvider, _setProviderForTest, MAX_MESSAGES, MAX_BODY_BYTES,
};
