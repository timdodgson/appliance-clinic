/**
 * Brand and error-code extraction from customer text.
 */
const { CATALOGUE, errorCodeFragmentTokens } = require('./catalogue.js');

// Deterministic backstops for FACTUAL extraction (brand + error code). The LLM
// is the primary extractor, but on terse inputs like "Samsung 4E" it can miss
// them; brand and code are facts, so we recover them in code rather than relying
// solely on the model. Used only to fill fields the LLM left null.
const BRAND_LIST = (() => {
  const set = new Set();
  for (const def of Object.values(CATALOGUE.errorCodes || {})) {
    for (const b of def.appliesTo || []) set.add(String(b).toLowerCase());
  }
  // longest first so "new world" wins over "world"
  return [...set].sort((a, b) => b.length - a.length);
})();

function guessMake(text) {
  const t = ` ${(text || '').toLowerCase()} `;
  for (const b of BRAND_LIST) {
    // whole-word (allow multiword brands); avoid matching inside other words
    const re = new RegExp(`(^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(t)) return b;
  }
  return null;
}

// High-precision UK appliance error-code shapes. Kept conservative to avoid
// grabbing model-number fragments; only used when the LLM gave no code/model.
// Compound / subcode forms (`E:36-10`, `E36/-10`, `E36/E10`) are preferred over a
// stem token so a suffix is not discarded as a second independent code.
const CODE_COMPOUND_PATTERN = /\b([EFHC]:?\d{1,3}(?:\s*[/\-]\s*(?:[EFHC]{0,3})?:?-?\d{1,3})+)\b/i;

function normalizeCodeSpeech(text) {
  let t = String(text || '').toUpperCase();
  t = t.replace(/\b([EFHC]:?\d{1,3})\s+(?:OR|AND)\s+((?:[EFHC]:?)?\d{1,3})\b/g, (_, a, b) => {
    const right = /^[EFHC]/.test(b) ? b : a.charAt(0) + b;
    return `${a.replace(/\s+/g, '')}/${right.replace(/\s+/g, '')}`;
  });
  t = t.replace(/\b([EFHC])\s+(\d{1,3}[A-Z]?)\b/g, '$1$2');
  return t;
}

const CODE_PATTERNS = [
  /\b([EFH])[\s-]?(\d{1,3})([A-Z])?\b/, // F03, E15, H20, F 05, F18E
  // i-codes must include a digit so ordinary English (ICE, IF) cannot mint a code.
  /\b(i(?=[0-9A-F]*\d)[0-9A-F]{1,2})\b/i, // i20, iC0, iF0
  /\b(\d{1,2}[EC])\b/, // 4E, 21E, 10E, 4C
  /\bFLASH\s?(\d{1,2})\b/i,
  /\b(OE|UE|IE|dE\d?|LE\d?|PE|FE|HE|nE|CE|tE|SE|AE|bE|dC|LC|OF|nF|Sud|SUD)\b/,
];

// Letter-only catalogue tokens that collide with ordinary English after
// normalizeCodeSpeech uppercases the whole utterance ("tub full OF water").
const ENGLISH_CODE_STOPWORDS = new Set([
  'OF', 'HE', 'BE', 'IE', 'OR', 'AS', 'AN', 'NO', 'SO', 'IF', 'IT', 'IS',
  'DO', 'WE', 'ME', 'MY', 'UP', 'US', 'AM', 'AT', 'BY', 'TO', 'IN', 'ON',
]);

/** True when a stopword-shaped token is a displayed code, not an English word. */
function letterCodeAllowed(token, originalText) {
  const tok = String(token || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (!tok || !ENGLISH_CODE_STOPWORDS.has(tok)) return true;
  const t = String(originalText || '');
  return new RegExp(
    `\\b(?:error|fault|code|flash(?:ing)?|showing|displays?)\\b[\\s\\S]{0,20}\\b${tok}\\b|\\b${tok}\\b[\\s\\S]{0,12}\\b(?:error|fault|code)\\b`,
    'i',
  ).test(t);
}

function guessErrorCode(text) {
  const raw = normalizeCodeSpeech(text || '');
  const compound = raw.match(CODE_COMPOUND_PATTERN);
  if (compound) return compound[1].replace(/\s+/g, '').toUpperCase();
  for (const re of CODE_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = g.exec(raw))) {
      const tok = m[0].replace(/[\s-]/g, '').toUpperCase();
      if (!letterCodeAllowed(tok, text)) continue;
      return tok;
    }
  }
  return null;
}

function upgradeErrorCodeFromText(text, extracted) {
  if (!extracted) return guessErrorCode(text);
  const compound = guessErrorCode(text);
  if (!compound) return extracted;
  const stem = _normCodeToken(extracted);
  const full = _normCodeToken(compound);
  if (!stem || stem === full) return extracted;
  // Stem of a compound (`E36` → `E36/E10`) or any fragment of it (`E10` → `E36/E10`).
  // A suffix-only extract must not stay as a standalone code: that maps through a
  // different catalogue row than the customer's displayed compound.
  if (full.startsWith(stem) && full.length > stem.length) return compound;
  const fragments = errorCodeFragmentTokens(compound);
  if (fragments.length >= 2 && fragments.some((f) => _normCodeToken(f) === stem)) return compound;
  return extracted;
}

function _normCodeToken(s) {
  return String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/** Every displayed-code token in the customer's own words, in order of appearance. */
function customerErrorCodes(text) {
  const raw = normalizeCodeSpeech(text || '');
  const out = [];
  const seen = new Set();
  const push = (tok) => {
    const n = _normCodeToken(tok);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(String(tok).replace(/\s+/g, '').toUpperCase());
  };
  const compoundSrc = raw.match(new RegExp(CODE_COMPOUND_PATTERN.source, 'gi')) || [];
  for (const c of compoundSrc) push(c.replace(/\s+/g, ''));
  for (const re of CODE_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let hit;
    while ((hit = g.exec(raw))) {
      const tok = hit[0].replace(/[\s-]/g, '');
      if (!letterCodeAllowed(tok, text)) continue;
      push(tok);
    }
  }
  return out;
}

/**
 * An explicit customer-supplied code outranks a retrieved or inferred sibling.
 * UNDERSTAND / knowledge may emit a related canonical alias; restore the token
 * the customer actually wrote unless they corrected it.
 */
function retainCustomerErrorCode(intent, customerText, metric) {
  if (!intent) return;
  const allowed = customerErrorCodes(customerText);
  if (!allowed.length) {
    if (intent.errorCode) {
      if (metric) metric.strippedInventedCode = intent.errorCode;
      intent.errorCode = null;
    }
    return;
  }
  const have = _normCodeToken(intent.errorCode);
  const allowedNorm = allowed.map(_normCodeToken);
  const inCustomer = have && allowedNorm.some((c) => c === have || c.startsWith(have) || have.startsWith(c));
  if (inCustomer) {
    const upgraded = upgradeErrorCodeFromText(customerText, intent.errorCode);
    if (upgraded && _normCodeToken(upgraded) !== have) intent.errorCode = upgraded;
    return;
  }
  const restored = allowed[allowed.length - 1];
  if (metric) metric.retainedCustomerCode = `${intent.errorCode || 'null'}->${restored}`;
  intent.errorCode = restored;
}

module.exports = { guessMake, guessErrorCode, upgradeErrorCodeFromText, customerErrorCodes, retainCustomerErrorCode };
