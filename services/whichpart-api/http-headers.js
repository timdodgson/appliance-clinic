'use strict';
/**
 * Phase 7: CORS and security headers on every HTTP response of whichpart-api.
 *
 * The site calls the API same-origin, through the AC CloudFront distribution, on each of its hosts. A browser needs CORS
 * only for a cross-origin call, so `access-control-allow-origin` is sent only to the AC origins (echoing the caller's
 * origin, with `vary: origin`), never `*`. Any other origin gets no CORS headers: the browser then refuses to expose the
 * response, and nothing else changes (server-to-server callers ignore CORS).
 *
 * Every response is JSON, so the content security policy allows nothing to load, and the response may not be framed.
 */

const AC_ORIGINS = Object.freeze([
  'https://applianceclinic.ai',
  'https://www.applianceclinic.ai',
  'https://whichpart.co.uk',
  'https://www.whichpart.co.uk',
]);

const SECURITY_HEADERS = Object.freeze({
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
});

const CORS_KEYS = ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-credentials'];

function requestOrigin(event) {
  const h = (event && event.headers) || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === 'origin') return typeof h[k] === 'string' ? h[k] : null;
  return null;
}

/** True for an HTTP (Function URL) event; scheduled events get no headers. */
function isHttpEvent(event) {
  return Boolean(event && event.requestContext && event.requestContext.http);
}

/** Apply the CORS allowlist and the security headers to an HTTP response. Returns a new response object. */
function finalizeResponse(event, res) {
  if (!isHttpEvent(event) || !res || typeof res !== 'object' || res.statusCode == null) return res;
  const headers = {};
  for (const [k, v] of Object.entries(res.headers || {})) {
    if (CORS_KEYS.indexOf(k.toLowerCase()) === -1) headers[k] = v;
  }
  const origin = requestOrigin(event);
  if (origin && AC_ORIGINS.indexOf(origin) !== -1) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'content-type';
    headers['access-control-allow-methods'] = 'GET,POST,OPTIONS';
  }
  headers.vary = 'origin';
  Object.assign(headers, SECURITY_HEADERS);
  return { ...res, headers };
}

module.exports = { AC_ORIGINS, SECURITY_HEADERS, finalizeResponse, requestOrigin };
