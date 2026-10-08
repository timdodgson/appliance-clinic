'use strict';
/**
 * Appliance Clinic authentication claims (Phase 7, ADR 0006). Pure: no AWS calls.
 *
 * whichpart-api signs users in against AC's own Cognito pool (AcAuthStack) and keeps the access token in an httpOnly
 * cookie. Every token it acts on has been issued by AdminInitiateAuth or accepted by Cognito GetUser, which checks the
 * signature and expiry. GetUser accepts an access token from ANY user pool in the region, though, so a token is an AC
 * session only if its claims say it was issued by the AC pool, for the AC app client, as an access token. Admin
 * authority is membership of the AC pool's `admin` group, and nothing else: a token from another pool (the S4R pool
 * included) never grants it, whatever groups it carries.
 */

function b64urlJson(seg) {
  try {
    const s = String(seg || '').replace(/-/g, '+').replace(/_/g, '/');
    const v = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** The payload of a JWT, without verification (see above for why that is safe here). */
function tokenClaims(token) {
  const parts = String(token || '').split('.');
  return parts.length === 3 ? b64urlJson(parts[1]) : {};
}

/** The issuer the AC pool puts in its tokens. */
function issuerFor(region, poolId) {
  return `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
}

/**
 * True when the access token belongs to the configured AC pool and app client. `config` is
 * {region, poolId, clientId}; an unconfigured pool or client never matches.
 */
function isAcAccessToken(token, config) {
  const { region, poolId, clientId } = config || {};
  if (!region || !poolId || !clientId) return false;
  const c = tokenClaims(token);
  return c.iss === issuerFor(region, poolId) && c.token_use === 'access' && c.client_id === clientId
    && typeof c.sub === 'string' && c.sub.length > 0;
}

/** Admin: an AC access token whose `cognito:groups` claim holds the admin group. Default-deny. */
function isAcAdmin(token, config) {
  if (!isAcAccessToken(token, config)) return false;
  const group = (config && config.adminGroup) || 'admin';
  const groups = tokenClaims(token)['cognito:groups'];
  return Array.isArray(groups) && groups.indexOf(group) !== -1;
}

module.exports = { tokenClaims, issuerFor, isAcAccessToken, isAcAdmin, b64urlJson };
