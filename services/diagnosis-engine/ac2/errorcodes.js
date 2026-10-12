'use strict';
/**
 * Error-code catalogue tool (ac2). Deterministic, in-process, no network.
 *
 * Reads ./data/error-codes.json, exported from the banked runtime artefacts by
 * error-codes/tools/export-engine-catalogue.mjs. Token matching ports error-codes/runtime-model/compiler/resolve.py
 * (_tok: upper-case, whitespace removed; _fold: punctuation-insensitive subcode form; keys from token, shown forms
 * and canonicalCode). Additions over resolve.py, each flagged in the result:
 *   - normalised: customers type the letter O for zero and vice versa (EO3 for E03, 0E for OE). O/0 swaps are tried
 *     only when the code as typed matches nothing in scope, so an exact match always wins.
 *   - fallback: a washer-dryer with no match falls back to the washing-machine records of the same brand.
 *   - brand optional / unknown: candidates across brands, AMBIGUOUS unless they all agree on the fault.
 *
 *   lookup({ code, brand, appliance }) -> { status, code, brand, appliance, normalised, fallback, candidates, ... }
 *   brands()                           -> known brand names (lower-case), for deterministic brand spotting
 *   candidateTokens(text)              -> [{ token, quote, quoted }] code-like tokens in free text
 */

const DATA = require('./data/error-codes.json');

const MAX_CANDIDATES = 6;
const CONF_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// Engine appliance name -> catalogue appliance names.
const APPLIANCE_TO_CATALOGUE = {
  'washing-machine': ['washing-machine'],
  'washer-dryer': ['washer-dryer'],
  'tumble-dryer': ['tumble-dryer'],
  dishwasher: ['dishwasher'],
  'fridge-freezer': ['fridge-freezer', 'fridge', 'freezer'],
  'oven-cooker': ['cooker-oven'],
  hobs: ['hobs'],
  microwave: ['microwave'],
  vacuum: ['vacuum-cleaner'],
};
const APPLIANCE_ALIASES = {
  'washing machine': 'washing-machine', washer: 'washing-machine',
  'washer dryer': 'washer-dryer', 'washer-drier': 'washer-dryer',
  'tumble dryer': 'tumble-dryer', dryer: 'tumble-dryer', 'tumble-drier': 'tumble-dryer',
  fridge: 'fridge-freezer', freezer: 'fridge-freezer', 'fridge freezer': 'fridge-freezer',
  'cooker-oven': 'oven-cooker', oven: 'oven-cooker', cooker: 'oven-cooker', range: 'oven-cooker',
  hob: 'hobs', cooktop: 'hobs',
  'vacuum-cleaner': 'vacuum', 'vacuum cleaner': 'vacuum', hoover: 'vacuum',
};
// Catalogue appliance name -> engine name (for output).
const CATALOGUE_TO_ENGINE = {
  'cooker-oven': 'oven-cooker', fridge: 'fridge-freezer', freezer: 'fridge-freezer', 'vacuum-cleaner': 'vacuum',
};

// --------------------------------------------------------------- token folding (port of resolve.py)
function tok(c) {
  return String(c == null ? '' : c).trim().toUpperCase().replace(/\s+/g, '');
}

function fold(c) {
  let t = tok(c);
  t = t.split('<->').join('-').split(':').join('').split('/').join('-');
  t = t.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  let prev = null;
  while (prev !== t) {
    prev = t;
    t = t.replace(/([A-Z]{1,3})(\d{1,3})-([A-Z]{1,3})(\d{1,3})(?=-|$)/g, (m, a, n1, b, n2) => (a === b ? `${a}${n1}-${n2}` : m));
  }
  return t;
}

function recordKeys(r) {
  const keys = new Set([fold(r.token), tok(r.token)]);
  for (const s of r.shown || []) { keys.add(fold(s)); keys.add(tok(s)); }
  if (r.canonicalCode) { keys.add(fold(r.canonicalCode)); keys.add(tok(r.canonicalCode)); }
  keys.delete('');
  return keys;
}

// --------------------------------------------------------------- indexes
const brandKey = (b) => String(b || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const isGenericBrand = (b) => b.startsWith('(');

const RECORDS = DATA.records;
const BY_KEY = new Map();
const BRAND_INDEX = new Map(); // brandKey -> Set(catalogue brand names)
for (let i = 0; i < RECORDS.length; i += 1) {
  const r = RECORDS[i];
  for (const k of recordKeys(r)) {
    if (!BY_KEY.has(k)) BY_KEY.set(k, []);
    BY_KEY.get(k).push(i);
  }
  for (const b of r.brands || []) {
    if (isGenericBrand(b)) continue;
    const k = brandKey(b);
    if (!BRAND_INDEX.has(k)) BRAND_INDEX.set(k, new Set());
    BRAND_INDEX.get(k).add(b);
  }
}
const BRANDS = [...new Set(RECORDS.flatMap((r) => r.brands || []).filter((b) => !isGenericBrand(b)))].sort();

/** Duplicate ids would make records overwrite each other in any id-keyed consumer: refuse them. */
function assertUniqueIds(records) {
  const seen = new Set();
  for (const r of records) {
    if (seen.has(r.id)) throw new Error(`duplicate error-code record id ${r.id}`);
    seen.add(r.id);
  }
  return true;
}
assertUniqueIds(RECORDS);

function normaliseAppliance(a) {
  if (!a) return null;
  const s = String(a).trim().toLowerCase().replace(/_/g, '-');
  if (APPLIANCE_TO_CATALOGUE[s]) return s;
  if (APPLIANCE_ALIASES[s]) return APPLIANCE_ALIASES[s];
  const spaced = s.replace(/-/g, ' ');
  if (APPLIANCE_ALIASES[spaced]) return APPLIANCE_ALIASES[spaced];
  return s; // unknown appliance name: matched literally against the catalogue
}

function catalogueAppliances(engineAppliance) {
  if (!engineAppliance) return null;
  return APPLIANCE_TO_CATALOGUE[engineAppliance] || [engineAppliance];
}

function resolveBrand(b) {
  if (!b) return null;
  const set = BRAND_INDEX.get(brandKey(b));
  return set ? [...set] : null;
}

// --------------------------------------------------------------- matching
function matchKeys(code) {
  return [...new Set([tok(code), fold(code)])].filter(Boolean);
}

function recordsFor(code, scope) {
  const hits = new Set();
  for (const k of matchKeys(code)) for (const i of BY_KEY.get(k) || []) hits.add(i);
  return [...hits].map((i) => RECORDS[i]).filter((r) => inScope(r, scope));
}

function inScope(r, { brands, appliances }) {
  if (brands && !(r.brands || []).some((b) => brands.includes(b))) return false;
  if (appliances && !(r.appliances || []).some((a) => appliances.includes(a))) return false;
  return true;
}

/** Variants of `code` with letter O and digit 0 swapped, fewest swaps first. Only O/0 positions change. */
function o0Variants(code) {
  const t = tok(code);
  const pos = [];
  for (let i = 0; i < t.length; i += 1) if (t[i] === 'O' || t[i] === '0') pos.push(i);
  if (!pos.length || pos.length > 4) return [];
  const out = [];
  for (let mask = 1; mask < (1 << pos.length); mask += 1) {
    const chars = t.split('');
    let n = 0;
    pos.forEach((p, j) => { if (mask & (1 << j)) { chars[p] = chars[p] === 'O' ? '0' : 'O'; n += 1; } });
    out.push({ code: chars.join(''), swaps: n });
  }
  return out.sort((a, b) => a.swaps - b.swaps || (a.code < b.code ? -1 : 1));
}

/** Exact match in scope wins; else the O/0 variants with the fewest swaps that match. */
function matchInScope(code, scope) {
  const exact = recordsFor(code, scope);
  if (exact.length) return { records: exact, normalised: false, matched: tok(code) };
  let best = null;
  for (const v of o0Variants(code)) {
    if (best && v.swaps > best.swaps) break;
    const recs = recordsFor(v.code, scope);
    if (!recs.length) continue;
    if (!best) best = { swaps: v.swaps, records: [], codes: [] };
    for (const r of recs) if (!best.records.includes(r)) best.records.push(r);
    best.codes.push(v.code);
  }
  if (best) return { records: best.records, normalised: true, matched: best.codes.join('|') };
  return null;
}

function engineAppliances(list) {
  return [...new Set((list || []).map((a) => CATALOGUE_TO_ENGINE[a] || a))];
}

function candidatesOf(records) {
  // Records with the same fault and meaning are one candidate (e.g. the same code banked for several badges).
  const groups = new Map();
  for (const r of records) {
    const key = `${r.faultId}\u0000${r.recordType}\u0000${r.meaning}`;
    let g = groups.get(key);
    if (!g) {
      g = { brands: [], appliances: [], meaning: r.meaning, recordType: r.recordType, confidence: r.confidence,
        faultId: r.faultId, schemeIds: [], ids: [], conditions: [], disputed: false };
      groups.set(key, g);
    }
    for (const b of r.brands || []) if (!g.brands.includes(b)) g.brands.push(b);
    for (const a of engineAppliances(r.appliances)) if (!g.appliances.includes(a)) g.appliances.push(a);
    if (!g.schemeIds.includes(r.schemeId)) g.schemeIds.push(r.schemeId);
    g.ids.push(r.id);
    for (const c of r.otherConditions || []) g.conditions.push(c);
    if ((CONF_RANK[r.confidence] ?? 3) < (CONF_RANK[g.confidence] ?? 3)) g.confidence = r.confidence;
    if (r.disputed) g.disputed = true;
  }
  return [...groups.values()]
    .map((g) => {
      const out = { ...g };
      if (!out.conditions.length) delete out.conditions;
      if (!out.disputed) delete out.disputed;
      return out;
    })
    .sort((a, b) => (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3)
      || b.brands.length - a.brands.length || (a.ids[0] < b.ids[0] ? -1 : 1));
}

/**
 * Look up a displayed code.
 * @param {{code: string, brand?: string, appliance?: string}} q
 */
function lookup({ code, brand, appliance } = {}) {
  const input = String(code == null ? '' : code).trim();
  const app = normaliseAppliance(appliance);
  const brandNames = resolveBrand(brand);
  const base = {
    code: input,
    brand: brand ? String(brand).trim().toLowerCase() : null,
    brandKnown: Boolean(brandNames),
    appliance: app,
    normalised: false,
    fallback: null,
  };
  if (!tok(input)) return { status: 'NOT_FOUND', ...base, candidates: [] };

  const scopes = [{ brands: brandNames, appliances: catalogueAppliances(app), fallback: null }];
  if (app === 'washer-dryer') scopes.push({ brands: brandNames, appliances: APPLIANCE_TO_CATALOGUE['washing-machine'], fallback: 'washing-machine' });

  for (const scope of scopes) {
    const m = matchInScope(input, scope);
    if (!m) continue;
    const cands = candidatesOf(m.records);
    const faults = new Set(cands.map((c) => c.faultId));
    const out = {
      status: faults.size === 1 ? 'RESOLVED' : 'AMBIGUOUS',
      ...base,
      normalised: m.normalised,
      fallback: scope.fallback,
      candidates: cands.slice(0, MAX_CANDIDATES),
      totalCandidates: cands.length,
    };
    if (m.normalised) out.matchedAs = m.matched;
    if (!brandNames) out.reason = brand ? 'BRAND_NOT_IN_CATALOGUE' : 'NO_BRAND';
    if (faults.size > 1) out.reason = out.reason || 'MULTIPLE_MEANINGS';
    if (cands.some((c) => c.disputed)) out.disputed = true;
    return out;
  }
  return { status: 'NOT_FOUND', ...base, candidates: [] };
}

function brands() {
  return BRANDS.slice();
}

// --------------------------------------------------------------- free-text token extraction
const QUOTE_OPEN = '\'"‘“`(«[';
const QUOTE_CLOSE = '\'"’”`)»]';
const CUE_RE = /\b(code|error|err|fault|display(?:s|ing)?|screen|show(?:s|ing|n)?|flash(?:es|ing)?|says|saying|reads|reading|symbol|light|message|blinking|comes? up|came up|appears?|appearing)\b/i;
const STOPWORDS = new Set([
  'A', 'I', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'HI', 'IF', 'IN', 'IS', 'IT', 'ME', 'MY', 'NO', 'OF', 'OH',
  'OK', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE', 'AM', 'PM', 'TV', 'UK', 'EU', 'US', 'OFF', 'END', 'LOW', 'HOT',
  'ONE', 'TWO', 'NEW', 'OLD', 'AND', 'THE', 'BUT', 'NOT', 'ANY', 'ALL', 'YES', 'NOW', 'DOOR', 'FILL', 'HIGH',
  'STUCK', 'SENSOR', 'DESCALE', 'DAMPER', 'SHARED',
]);
const UNIT_RE = /^\d+(?:ST|ND|RD|TH|KG|G|L|ML|W|KW|V|A|MM|CM|M|H|HR|HRS|MIN|S|X|P|K|C°|F°)$/;
const LETTER_DIGIT_RE = /^[A-Z]{1,3}[-:]?[0O]?\d{1,3}$/i;
const SUBCODE_RE = /^[A-Z]{1,2}:?\d{1,3}(?:[-/][A-Z]{0,2}:?-?\d{1,3})+$/i;

function inCatalogue(token) {
  if (matchKeys(token).some((k) => BY_KEY.has(k))) return true;
  return o0Variants(token).some((v) => matchKeys(v.code).some((k) => BY_KEY.has(k)));
}

function quoteAround(text, start, end) {
  const s = Math.max(0, start - 30);
  const e = Math.min(text.length, end + 30);
  return text.slice(s, e).replace(/\s+/g, ' ').trim();
}

/**
 * Code-like tokens in free text, conservative about ordinary words. Letter+digit codes (E18, F21, H98, Er03, EO3,
 * E:36-10) are always taken; digit+letter (4C, 5E), letter-only (OE, dE, HsY, U) and bare numbers are taken only
 * when the catalogue knows them and the shape or context says "code" (quoted, unusual case, or a cue word nearby).
 */
function candidateTokens(text) {
  const src = String(text || '');
  const out = [];
  const seen = new Set();
  const re = /[A-Za-z0-9][A-Za-z0-9:/-]*[A-Za-z0-9]|[A-Za-z0-9]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let raw = m[0];
    const start = m.index;
    let end = start + raw.length;
    // "E 18" / "E: 18" written with a gap: join a capital letter group to the following number when a cue word
    // ("code", "display", "showing" ...) is nearby, so "A 2 year old" is never read as a code.
    const gap = /^([A-Z]{1,2}):?\s+(\d{1,3})\b/.exec(src.slice(start));
    if (gap && /^[A-Z]{1,2}$/.test(raw) && CUE_RE.test(src.slice(Math.max(0, start - 40), start + gap[0].length + 40))) {
      raw = `${gap[1]}${gap[2]}`;
      end = start + gap[0].length;
      re.lastIndex = end;
    }
    const before = src[start - 1] || '';
    const after = src[end] || '';
    const quoted = QUOTE_OPEN.includes(before) && QUOTE_CLOSE.includes(after);
    const near = src.slice(Math.max(0, start - 40), Math.min(src.length, end + 40));
    const cue = CUE_RE.test(near);
    const T = tok(raw);
    if (seen.has(T)) continue;

    let take = false;
    const hasDigit = /\d/.test(raw);
    const hasLetter = /[A-Za-z]/.test(raw);
    if (SUBCODE_RE.test(raw)) {
      take = true;
    } else if (hasDigit && hasLetter && LETTER_DIGIT_RE.test(raw)) {
      const letters = raw.match(/^[A-Za-z]+/)[0];
      // single letter + digits (e18, F21) always; longer letter groups need a capital or the catalogue (Er03, AL6, i20)
      take = letters.length === 1 || /[A-Z]/.test(letters) || inCatalogue(raw);
      if (/^(MP|MP3|MP4|COVID|A4|A3)$/i.test(T)) take = false;
    } else if (hasDigit && hasLetter && /^\d{1,2}[A-Za-z]{1,2}\d?$/.test(raw)) {
      take = !UNIT_RE.test(T) && inCatalogue(raw) && (/[A-Z]/.test(raw) || quoted || cue);
    } else if (!hasDigit && hasLetter && raw.length <= 4 && !raw.includes('-')) {
      const allLower = raw === raw.toLowerCase();
      const titleWord = /^[A-Z][a-z]+$/.test(raw);
      const odd = !allLower && !titleWord; // OE, dE, HsY, LOC
      if (inCatalogue(raw) && !(STOPWORDS.has(T) && !quoted)) {
        if (raw.length === 1) take = quoted || (cue && raw === raw.toUpperCase() && T !== 'A' && T !== 'I');
        else take = quoted || (odd && (cue || raw.length >= 2));
      }
    } else if (!hasLetter && /^\d{1,2}$/.test(raw)) {
      take = quoted && inCatalogue(raw);
    }
    if (!take) continue;
    seen.add(T);
    out.push({ token: raw, quote: quoteAround(src, start, end), quoted });
  }
  return out;
}

module.exports = {
  lookup,
  brands,
  candidateTokens,
  // exported for tests and the engine's own use
  tok,
  fold,
  o0Variants,
  normaliseAppliance,
  assertUniqueIds,
  datasetContentHash: DATA.datasetContentHash,
};
