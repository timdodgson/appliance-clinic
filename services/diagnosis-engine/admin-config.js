'use strict';
/**
 * Runtime loader for the admin-managed ApplianceClinic AI configuration.
 *
 * The engine reads the operational config (routing/models) and, when the
 * reasoning stage (COMPOSE route) is routed to the frontier provider, the OpenAI
 * credential — both from Secrets Manager, matching the project's convention.
 * Values are cached for a short TTL so a config change becomes effective within
 * ~CACHE_TTL_MS WITHOUT a code redeploy, and WITHOUT a secrets lookup per call.
 */

const STAGE = process.env.STAGE || 'dev';
// Phase 7 (D): the secret ids can be set by environment (the AC namespace applianceclinic/production/*); the
// defaults are the original ids.
const AI_CONFIG_SECRET_ID = process.env.AI_CONFIG_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-ai-config`;
const OPENAI_SECRET_ID = process.env.OPENAI_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-openai`;

const CACHE_TTL_MS = Number(process.env.AI_CONFIG_CACHE_TTL_MS || 60000); // 60s default

let _cache = null; // { at, config, openaiKey }

/** Default secret fetcher using the AWS SDK v3 present in the Lambda runtime. */
async function defaultFetchSecret(secretId) {
  // Lazily required so local/offline environments without the SDK don't crash
  // at import; failure returns null and the caller falls back to local.
  // eslint-disable-next-line global-require
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  if (!_sm) _sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-1' });
  const res = await _sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  return res.SecretString || null;
}
let _sm = null;

/**
 * Return { config, openaiKey } for the current request, using the cache. The key is held in memory only and never
 * logged.
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {(id:string)=>Promise<string|null>} [opts.fetchSecret] injectable for tests
 */
async function loadAdminInference(opts = {}) {
  const now = opts.now || Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache;

  const fetchSecret = opts.fetchSecret || defaultFetchSecret;
  let config = null;
  let openaiKey = null;

  try {
    const s = await fetchSecret(AI_CONFIG_SECRET_ID);
    if (s) config = JSON.parse(s);
  } catch {
    config = null; // absent/unreadable -> fall back to env local default
  }

  // Only fetch the credential when the reasoning stage (the COMPOSE route) actually routes to the frontier.
  const needsKey = config && config.routing && config.routing.compose === 'frontier';
  if (needsKey) {
    try {
      const s = await fetchSecret(OPENAI_SECRET_ID);
      if (s) {
        const parsed = JSON.parse(s);
        openaiKey = (typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) ? parsed.apiKey : null;
      }
    } catch {
      openaiKey = null;
    }
  }

  _cache = { at: now, config, openaiKey };
  return _cache;
}

/** Test/ops seam: drop the cache so the next load re-reads the secrets. */
function _resetCache() { _cache = null; }

module.exports = {
  loadAdminInference, _resetCache, AI_CONFIG_SECRET_ID, OPENAI_SECRET_ID, CACHE_TTL_MS,
};
