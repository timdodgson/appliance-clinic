'use strict';
/**
 * The admin-managed AI configuration and the model credential, read from Secrets Manager and cached for a short TTL
 * so a Settings change takes effect within about a minute, without a redeploy and without a secret read per turn.
 *
 *   AI_CONFIG_SECRET_ID   the configuration document Settings writes ({ model, ... }; a document written before 23.3
 *                         names the model as frontier.model and carries routing fields, which are ignored)
 *   OPENAI_SECRET_ID      the credential secret; the Anthropic key is its `anthropicApiKey` field. The secret keeps its
 *                         historical name: renaming a secret is a production change
 *
 * The key is held in memory only and never logged.
 */

const STAGE = process.env.STAGE || 'dev';
// Phase 7 (D): the secret ids can be set by environment (the AC namespace applianceclinic/production/*); the
// defaults are the original ids.
const AI_CONFIG_SECRET_ID = process.env.AI_CONFIG_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-ai-config`;
const OPENAI_SECRET_ID = process.env.OPENAI_SECRET_ID || `spares4repairs/${STAGE}/applianceclinic-openai`;

const CACHE_TTL_MS = Number(process.env.AI_CONFIG_CACHE_TTL_MS || 60000); // 60s default

let _cache = null; // { at, config, anthropicKey }
let _sm = null;

/** Default secret fetcher using the AWS SDK v3 present in the Lambda runtime. */
async function defaultFetchSecret(secretId) {
  // eslint-disable-next-line global-require
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  if (!_sm) _sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-1' });
  const res = await _sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  return res.SecretString || null;
}

/**
 * Return { at, config, anthropicKey } for the current request, using the cache. An absent or unreadable secret gives
 * null; the provider resolution (inference.js) then fails with an explicit CONFIG error.
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {(id:string)=>Promise<string|null>} [opts.fetchSecret] injectable for tests
 */
async function loadAdminInference(opts = {}) {
  const now = opts.now || Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache;

  const fetchSecret = opts.fetchSecret || defaultFetchSecret;
  let config = null;
  let anthropicKey = null;
  try {
    const s = await fetchSecret(AI_CONFIG_SECRET_ID);
    if (s) config = JSON.parse(s);
  } catch {
    config = null;
  }
  try {
    const s = await fetchSecret(OPENAI_SECRET_ID);
    if (s) {
      const parsed = JSON.parse(s);
      anthropicKey = typeof parsed.anthropicApiKey === 'string' && parsed.anthropicApiKey.trim() ? parsed.anthropicApiKey.trim() : null;
    }
  } catch {
    anthropicKey = null;
  }

  _cache = { at: now, config, anthropicKey };
  return _cache;
}

/** Test/ops seam: drop the cache so the next load re-reads the secrets. */
function _resetCache() { _cache = null; }

module.exports = { loadAdminInference, _resetCache, AI_CONFIG_SECRET_ID, OPENAI_SECRET_ID, CACHE_TTL_MS };
