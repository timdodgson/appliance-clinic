'use strict';
/**
 * High-recall structural candidate pre-pass for the canonical mc/1 classifier (services/whichpart-api/docs/canonical-architecture.md §3).
 *
 * Design history: canonical-semantic-state.md §14.2 (historical).
 * Jev cannot extract strings; it can only choose among options we supply. This pre-pass therefore
 * ENUMERATES candidate values from the LATEST customer message only. It never decides meaning:
 *   - no ranking, no position cap, no "looks like a model" filter (shape rules only ANNOTATE via hints);
 *   - syntax normalisation only (upper-casing, whitespace/punctuation joins and splits);
 *   - the only exclusions are the documented rules below.
 *
 * Identifier candidates (for model / displayed code / part number):
 *   1. every token of 2–24 chars containing a digit, verbatim, plus `/`, `-`, `.` split parts
 *      (each part that still contains a digit, or is 2–4 letters after a code-like stem);
 *   2. joins of 2–3 adjacent short fragments whose join contains a digit ("WAN 28281 GB" → WAN28281,
 *      WAN28281GB, 28281GB; "v 6" → V6; "e 21" → E21). A fragment is joinable when it is ≤ 8 chars and
 *      contains a digit, or is ≤ 4 letters; English function words and cue words are never joined;
 *   3. explicit cue spans: the 1–3 tokens after model / e-nr / enr / pnc / product number / serial /
 *      part number / code / error / fault / showing / displaying / display says / flashing — offered
 *      even when digit-free (so "showing UE" yields UE). Digit-free tokens WITHOUT a cue are not
 *      identifier candidates (documented limitation; surfaced by the recall-gap question).
 * Brand candidates: every brand-catalogue mention (whole word / phrase).
 * Component candidates: every catalogue component name or alias mentioned (whole word / phrase), plus,
 *   for a bare head noun ("pump", "filter", "element", "motor", …), every vocabulary entry ending in
 *   that head noun INSTEAD of the bare word, so the specific part is chosen by Jev in context
 *   ("the pump" → drain-pump | circulation-pump | condensate-pump). The bare word is kept only when no
 *   specific entry exists. Values are canonical component ids (lower-case, hyphenated).
 *
 * Choice chunking: JEV_CHOICE_MAX_OPTIONS = 32 candidate options per choice question (+ `none`).
 * Larger lists are split into disjoint chunks in message order; no candidate is ever dropped.
 */

const JEV_CHOICE_MAX_OPTIONS = 32;
const MAX_TOKEN = 24;
const JOIN_FRAGMENT_MAX = 8;

// English function words never used as join fragments (documented exclusion rule 2).
const JOIN_STOP = new Set(['A', 'AN', 'THE', 'IS', 'IT', 'ITS', 'MY', 'OUR', 'AND', 'OR', 'OF', 'TO', 'IN', 'ON',
  'AT', 'BY', 'FOR', 'IM', 'I', 'ME', 'WE', 'SO', 'BUT', 'AS', 'BE', 'DO', 'NO', 'NOT', 'UP', 'IF', 'WAS', 'HAS',
  'HAD', 'ARE', 'AM', 'THIS', 'THAT', 'WITH', 'FROM', 'JUST', 'NOW', 'ALSO', 'OUT', 'OFF', 'GOT', 'ITS',
  // cue words (rule 3 handles what follows them)
  'PNC', 'ENR', 'NR', 'CODE', 'SAYS', 'PART']);

// Cue phrases that introduce an identifier (rule 3). Lower-case, matched on word boundaries.
const CUES = [
  ['model number', 'model'], ['model no', 'model'], ['model', 'model'], ['e-nr', 'enr'], ['e nr', 'enr'], ['enr', 'enr'],
  ['e-number', 'enr'], ['pnc', 'pnc'], ['product number', 'product'], ['product code', 'product'],
  ['serial number', 'serial'], ['serial', 'serial'], ['part number', 'part'], ['part no', 'part'],
  ['error code', 'code'], ['fault code', 'code'], ['code', 'code'], ['error', 'code'], ['fault', 'code'],
  ['showing', 'display'], ['displaying', 'display'], ['display says', 'display'], ['display shows', 'display'],
  ['flashing', 'display'], ['says', 'display'],
];
const CUE_SPAN_TOKENS = 3;

// Hints only (never filters).
const CODE_SHAPE = /^([EFHCU]:?\d{1,3}[A-Z]?|I[0-9A-F]{1,2}|\d{1,2}[A-Z]|[A-Z]{1,2}\d?|[A-Z]\d{1,2}[A-Z]?)$/;
const MODEL_SHAPE = /^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{5,}$/;
const PNC_SHAPE = /^\d{9}$/;
const PART_NUMBER_SHAPE = /^\d{8,14}$/;
const SERIES_SHAPE = /^(V|DC|SV|G)\d{1,2}$/;

const upper = (s) => String(s || '').toUpperCase();
const hasDigit = (s) => /\d/.test(s);
const clean = (s) => upper(s).replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');

function hintsFor(value, extra) {
  const h = new Set(extra || []);
  const compact = value.replace(/[^A-Z0-9]/g, '');
  if (CODE_SHAPE.test(compact)) h.add('code_shape');
  if (MODEL_SHAPE.test(compact) && compact.length >= 6) h.add('model_shape');
  if (SERIES_SHAPE.test(compact)) h.add('series_shape');
  if (PNC_SHAPE.test(compact)) h.add('pnc_shape');
  else if (PART_NUMBER_SHAPE.test(compact)) h.add('part_number_shape');
  if (/\//.test(value)) h.add('slash');
  if (/-/.test(value)) h.add('hyphen');
  return [...h].sort();
}

/** Raw tokens with character offsets (whitespace-delimited; surrounding punctuation trimmed). */
function tokenize(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0].replace(/^[("'[{]+|[)"'\]},.;:!?]+$/g, '');
    if (raw) out.push({ raw, index: m.index });
  }
  return out;
}

/**
 * Identifier candidates from the latest message. Returns [{id, value, hints}] in first-occurrence order.
 */
function identifierCandidates(text) {
  const msg = String(text || '');
  const list = [];
  const byValue = new Map();
  const add = (value, hints) => {
    const v = clean(value);
    if (!v || v.length < 2 || v.length > MAX_TOKEN) return;
    if (byValue.has(v)) { for (const x of hints || []) byValue.get(v).hintSet.add(x); return; }
    const c = { value: v, hintSet: new Set(hints || []) };
    byValue.set(v, c);
    list.push(c);
  };
  const toks = tokenize(msg);

  // Rule 1: tokens containing a digit, verbatim + separator split parts.
  for (const t of toks) {
    const v = clean(t.raw);
    if (!v || !hasDigit(v)) continue;
    add(v, []);
    if (/[/\-.]/.test(v)) {
      add(v.replace(/[/\-.]/g, ''), ['joined']);
      for (const part of v.split(/[/\-.]+/)) {
        if (part && (hasDigit(part) || /^[A-Z]{2,4}$/.test(part))) add(part, ['split_part']);
      }
    }
  }

  // Rule 2: joins of 2–3 adjacent short fragments whose join contains a digit.
  const frags = toks.map((t) => clean(t.raw));
  for (let i = 0; i < frags.length; i += 1) {
    for (let n = 2; n <= 3 && i + n <= frags.length; n += 1) {
      const parts = frags.slice(i, i + n);
      const joinable = (p) => Boolean(p) && !JOIN_STOP.has(p) && /^[A-Z0-9/\-]+$/.test(p)
        && (hasDigit(p) ? p.length <= JOIN_FRAGMENT_MAX : p.length <= 4);
      if (!parts.every(joinable)) continue;
      const joined = parts.join('').replace(/[/\-]/g, '');
      if (hasDigit(joined)) add(joined, ['joined']);
    }
  }

  // Rule 3: cue spans (digit-free allowed).
  const lower = msg.toLowerCase();
  for (const [cue, kind] of CUES) {
    const re = new RegExp(`(^|[^a-z])${cue.replace(/[-]/g, '[- ]?').replace(/ /g, '\\s+')}(?:\\s*(?:no\\.?|number|is|was|of|:|=|#))*\\s*`, 'gi');
    let m;
    while ((m = re.exec(lower))) {
      const after = msg.slice(m.index + m[0].length);
      const spanToks = tokenize(after).slice(0, CUE_SPAN_TOKENS).map((x) => clean(x.raw)).filter(Boolean);
      for (let k = 0; k < spanToks.length; k += 1) {
        const tok = spanToks[k];
        if (JOIN_STOP.has(tok) && !hasDigit(tok)) break;
        if (tok.length >= 2 && tok.length <= MAX_TOKEN && /^[A-Z0-9/\-:]+$/.test(tok)) add(tok.replace(/:/g, ''), [`cue:${kind}`]);
        if (k > 0) {
          const joined = spanToks.slice(0, k + 1).join('').replace(/[/\-:]/g, '');
          if (/^[A-Z0-9]+$/.test(joined)) add(joined, [`cue:${kind}`, 'joined']);
        }
      }
    }
  }
  return list.map((c, i) => ({ id: `t${i + 1}`, value: c.value, hints: hintsFor(c.value, [...c.hintSet]) }));
}

// ---- catalogue vocabularies ------------------------------------------------------------------------
// Brands not present in the error-code catalogue but common in UK domestic appliances (vacuums etc.).
const EXTRA_BRANDS = ['dyson', 'shark', 'vax', 'henry', 'numatic', 'gtech', 'bissell', 'karcher', 'russell hobbs',
  'morphy richards', 'kenwood', 'sharp', 'logik', 'swan', 'liebherr', 'fridgemaster', 'lec', 'amica', 'sage',
  'de dietrich', 'falcon', 'aga', 'britannia', 'caple', 'teka', 'elica', 'bush', 'russell', 'tower'];

let _vocab = null;
function loadVocab() {
  if (_vocab) return _vocab;
  // eslint-disable-next-line global-require
  const cat = require('../faults-catalogue.json');
  _vocab = buildVocab(cat);
  return _vocab;
}

const canonicalId = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Build {brands:[name], components:[{id, names:[...]}]} from the faults catalogue (pure, testable). */
function buildVocab(cat) {
  const brands = new Set(EXTRA_BRANDS);
  for (const def of Object.values((cat && cat.errorCodes) || {})) {
    for (const b of (def && def.appliesTo) || []) brands.add(String(b).toLowerCase());
  }
  const comps = new Map(); // id -> Set(names)
  const addComp = (name, alias) => {
    const n = String(name || '').toLowerCase().trim();
    if (!n || n.split(/\s+/).length > 4 || /\b(the|check|clear|reduce|use|avoid|move|stop|clean)\b/.test(n)) return;
    const id = canonicalId(n);
    if (!id) return;
    if (!comps.has(id)) comps.set(id, new Set([n]));
    if (alias) {
      const a = String(alias).toLowerCase().trim();
      if (a && a.split(/\s+/).length <= 5) comps.get(id).add(a);
    }
  };
  for (const nodes of Object.values((cat && cat.faults) || {})) {
    for (const node of Object.values(nodes || {})) for (const c of (node && node.components) || []) addComp(c);
  }
  for (const [name, aliases] of Object.entries((cat && cat.componentAliases) || {})) {
    addComp(name);
    for (const a of aliases || []) addComp(name, a);
  }
  return {
    brands: [...brands].sort((a, b) => b.length - a.length || a.localeCompare(b)),
    components: [...comps.entries()].map(([id, names]) => ({ id, names: [...names] })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const phraseRe = (p) => new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+')}s?([^a-z0-9]|$)`, 'i');

function brandCandidates(text, vocab) {
  const t = String(text || '');
  const out = [];
  const taken = [];
  for (const b of vocab.brands) {
    const m = phraseRe(b).exec(t);
    if (!m) continue;
    const start = m.index + m[1].length;
    // a shorter brand fully inside an already-matched longer brand phrase is the same mention
    if (taken.some(([s, e]) => start >= s && start + b.length <= e)) continue;
    taken.push([start, start + b.length]);
    out.push({ start, value: b });
  }
  return out.sort((a, b) => a.start - b.start).map((x, i) => ({ id: `b${i + 1}`, value: x.value }));
}

function componentCandidates(text, vocab) {
  const t = String(text || '');
  const hits = [];
  const ids = new Set();
  const push = (id, start) => { if (!ids.has(id)) { ids.add(id); hits.push({ id, start }); } };
  for (const c of vocab.components) {
    for (const n of c.names) {
      const m = phraseRe(n).exec(t);
      if (m) { push(c.id, m.index); break; }
    }
  }
  // Head-noun expansion: a mentioned single-word component offers every entry ending in it, and the bare
  // generic word is then replaced by those specific entries (so Jev picks drain-pump vs circulation-pump in
  // context instead of the uninformative "pump"). With no specific entry the generic word is kept.
  for (const h of [...hits]) {
    if (h.id.includes('-')) continue;
    const specific = vocab.components.filter((c) => c.id.endsWith(`-${h.id}`));
    for (const c of specific) push(c.id, h.start + 0.5);
    if (specific.length) { const i = hits.indexOf(h); hits.splice(i, 1); }
  }
  return hits.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)).map((x, i) => ({ id: `p${i + 1}`, value: x.id }));
}

/** Split options into disjoint chunks of ≤ max, preserving order. Never drops an option. */
function chunk(list, max = JEV_CHOICE_MAX_OPTIONS) {
  const out = [];
  for (let i = 0; i < list.length; i += max) out.push(list.slice(i, i + max));
  return out;
}

/** All candidates for the latest message. */
function buildCandidates(latestMessageText, opts = {}) {
  const vocab = opts.vocab || loadVocab();
  return {
    identifiers: identifierCandidates(latestMessageText),
    brands: brandCandidates(latestMessageText, vocab),
    components: componentCandidates(latestMessageText, vocab),
  };
}

module.exports = {
  JEV_CHOICE_MAX_OPTIONS, JOIN_STOP, CUES, EXTRA_BRANDS,
  tokenize, identifierCandidates, brandCandidates, componentCandidates, buildVocab, loadVocab, canonicalId,
  chunk, buildCandidates,
};
