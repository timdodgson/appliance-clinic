/**
 * Redaction for anything written to disk by the migration tooling.
 *
 * Secret values are replaced by a SHA-256 digest and length, so two captures can still be
 * compared without the value ever being stored.
 */
import { createHash } from 'node:crypto';

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|BEARER|CREDENTIAL|API_?KEY|ACCESS_?KEY|SIGNING|HMAC|AUTH(?!OR))/i;
// Names that hold an identifier or a location, not a value.
const IDENTIFIER_NAME = /(_ID|_ARN|_NAME|_URL|_URI|_REGION|_TABLE|_BUCKET)$/i;
// Long unbroken token-like strings are treated as secrets whatever their name: hex, or
// base64-style text mixing upper case, lower case and digits. Paths and slugs do not qualify.
const OPAQUE_CHARSET = /^[A-Za-z0-9+/_=-]{32,}$/;
const HEX = /^[0-9a-f]{32,}$/i;

export function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function redactedValue(value) {
  const s = String(value);
  return { redacted: true, sha256: sha256Hex(s), length: s.length };
}

export function isSecretName(name) {
  return SECRET_NAME.test(name) && !IDENTIFIER_NAME.test(name);
}

export function looksOpaque(value) {
  if (typeof value !== 'string' || !OPAQUE_CHARSET.test(value)) return false;
  return HEX.test(value) || (/[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value));
}

export function shouldRedact(name, value) {
  if (isSecretName(name)) return true;
  if (IDENTIFIER_NAME.test(name)) return false;
  return looksOpaque(value);
}

/** Redact a Lambda-style environment map. */
export function redactEnvironment(vars = {}) {
  const out = {};
  for (const [name, value] of Object.entries(vars)) {
    out[name] = shouldRedact(name, value) ? redactedValue(value) : value;
  }
  return out;
}

/** Recursively redact any object, using key names and value shapes. */
export function redactDeep(input, keyName = '') {
  if (Array.isArray(input)) return input.map((v) => redactDeep(v, keyName));
  if (input && typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = redactDeep(v, k);
    return out;
  }
  if (typeof input === 'string' && shouldRedact(keyName, input)) return redactedValue(input);
  return input;
}

/** Collect every digest produced by redaction, for leak detection in templates. */
export function collectDigests(input, into = new Set()) {
  if (Array.isArray(input)) input.forEach((v) => collectDigests(v, into));
  else if (input && typeof input === 'object') {
    if (input.redacted === true && typeof input.sha256 === 'string') into.add(input.sha256);
    else Object.values(input).forEach((v) => collectDigests(v, into));
  }
  return into;
}
