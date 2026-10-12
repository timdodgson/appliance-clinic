'use strict';
/**
 * Runtime loader for the admin-managed ApplianceClinic AI configuration.
 *
 * The orchestrator reads the operational config (routing/models) and, when a
 * stage is routed to the frontier provider, the OpenAI credential — both from
 * Secrets Manager, matching the project's convention. Values are cached for a
 * short TTL so a config change becomes effective within ~CACHE_TTL_MS WITHOUT a
 * code redeploy, and WITHOUT a secrets lookup per token/stream chunk.
 *
 * The loader also reads TypeSafe Jev credentials from
 * `spares4repairs/<STAGE>/applianceclinic-jev`. The token is never logged.
 * Missing Jev credentials are a CONFIG failure for UNDERSTAND (no silent
 * fallback to the old generative pass).
 */

const STAGE = process.env.STAGE || 'dev';
// Phase 7 (D): the secret ids can be set by environment (the AC namespace applianceclinic/production/*); the
// defaults are the original ids.
const AI_CONFIG_SECRET_ID = process.env.AI_CONFIG_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-ai-config`;
const OPENAI_SECRET_ID = process.env.OPENAI_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-openai`;
const JEV_SECRET_ID = process.env.JEV_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-jev`;

const CACHE_TTL_MS = Number(process.env.AI_CONFIG_CACHE_TTL_MS || 60000); // 60s default

let _cache = null; // { at, config, openaiKey, jev }

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

function parseJevSecret(raw, env) {
  let accountId = (env && env.CLOUDFLARE_ACCOUNT_ID) || (env && env.JEV_ACCOUNT_ID) || null;
  let apiToken = (env && env.CLOUDFLARE_API_TOKEN) || (env && env.JEV_API_TOKEN) || null;
  let gatewayId = (env && env.CLOUDFLARE_GATEWAY_ID) || (env && env.JEV_GATEWAY_ID) || null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.accountId === 'string' && parsed.accountId.trim()) accountId = parsed.accountId.trim();
        const tok = parsed.apiToken || parsed.apiKey || parsed.token;
        if (typeof tok === 'string' && tok.trim()) apiToken = tok.trim();
        if (typeof parsed.gatewayId === 'string' && parsed.gatewayId.trim()) gatewayId = parsed.gatewayId.trim();
      }
    } catch {
      // unreadable JSON — ignore; env may still supply credentials
    }
  }
  if (accountId && apiToken) return { accountId, apiToken, gatewayId: gatewayId || null };
  return null;
}

/**
 * Return { config, openaiKey, jev, jevConfigured } for the current request, using the cache.
 * `jev` holds the credential object in memory only and is never logged.
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {(id:string)=>Promise<string|null>} [opts.fetchSecret] injectable for tests
 * @param {object} [opts.env]
 */
async function loadAdminInference(opts = {}) {
  const now = opts.now || Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache;

  const fetchSecret = opts.fetchSecret || defaultFetchSecret;
  const env = opts.env || process.env;
  let config = null;
  let openaiKey = null;
  let jev = null;

  try {
    const s = await fetchSecret(AI_CONFIG_SECRET_ID);
    if (s) config = JSON.parse(s);
  } catch {
    config = null; // absent/unreadable -> fall back to env local default
  }

  // Only fetch the credential when a stage actually routes to the frontier.
  const needsKey = config && config.routing &&
    (config.routing.understand === 'frontier' || config.routing.compose === 'frontier');
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

  try {
    const s = await fetchSecret(JEV_SECRET_ID);
    jev = parseJevSecret(s, env);
  } catch {
    jev = parseJevSecret(null, env);
  }
  if (!jev) jev = parseJevSecret(null, env);

  _cache = { at: now, config, openaiKey, jev, jevConfigured: Boolean(jev && jev.accountId && jev.apiToken) };
  return _cache;
}

/** Test/ops seam: drop the cache so the next load re-reads the secrets. */
function _resetCache() { _cache = null; }

module.exports = {
  loadAdminInference, _resetCache, parseJevSecret,
  AI_CONFIG_SECRET_ID, OPENAI_SECRET_ID, JEV_SECRET_ID, CACHE_TTL_MS,
};
