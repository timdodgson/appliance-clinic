'use strict';
/**
 * ADR 0017: whichpart-api's one direct engine call (the feedback pass-through) is signed with the AC engine signing
 * key, as the orchestrator signs its calls. The engine honours `feedback` only with a valid signature.
 * Header format matches services/part-finder/engine-auth.js.
 */
const crypto = require('node:crypto');

const ENGINE_SIGNATURE_HEADER = 'x-ac-engine-signature';

function engineSignature(rawBody, key = process.env.ENGINE_SIGNING_TOKEN, nowS = Math.floor(Date.now() / 1000)) {
  if (typeof key !== 'string' || !key) return null;
  const mac = crypto.createHmac('sha256', key).update(`${nowS}.`).update(rawBody).digest('hex');
  return `t=${nowS},v1=${mac}`;
}

/** Headers for a signed JSON POST of exactly `rawBody`. */
function signedJsonHeaders(rawBody) {
  const headers = { 'content-type': 'application/json' };
  const sig = engineSignature(rawBody);
  if (sig) headers[ENGINE_SIGNATURE_HEADER] = sig;
  return headers;
}

module.exports = { ENGINE_SIGNATURE_HEADER, engineSignature, signedJsonHeaders };
