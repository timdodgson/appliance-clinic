'use strict';
/**
 * Knowledge layer: what the reasoner may read. Retrieval informs the reasoner; it never decides control flow.
 *
 * Sources (all shipped with the engine):
 *   knowledge-docs.json      171 fault nodes (likely causes, discriminators, common confusions, advice before replacing)
 *   journey-knowledge.json   the 63 retired journeys as knowledge (owner-safe checks with their wording, part matching)
 *   normal-operation.json    normal-operation patterns that are often reported as faults
 *   safety-information.json  pre-written, sourced safety panels per fault node
 */
const path = require('path');

const APPLIANCES = ['washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher', 'fridge-freezer', 'oven-cooker', 'hobs', 'microwave', 'vacuum'];

let _kb = null;
function kb() {
  if (_kb) return _kb;
  const dir = path.join(__dirname, '..', 'knowledge');
  const docs = require(path.join(dir, 'knowledge-docs.json')).docs;
  const journeys = require(path.join(dir, 'journey-knowledge.json')).journeys;
  const normal = require(path.join(dir, 'normal-operation.json')).entries;
  let safety = {};
  try { safety = require(path.join(dir, 'safety-information.json')).byKnowledgeId || {}; } catch { safety = {}; }
  const byKid = new Map();
  for (const j of journeys) {
    const list = byKid.get(j.knowledgeId) || [];
    list.push(j);
    byKid.set(j.knowledgeId, list);
  }
  const index = docs.map((d) => ({
    doc: d,
    journeys: byKid.get(d.knowledgeId) || [],
    terms: termList([d.label, ...(d.symptoms || []), d.faultId.replace(/-/g, ' ')].join(' ; ')),
    components: termSet([...(d.likelyComponents || []), ...(d.componentFamilies || []), ...(d.components || []).map((c) => c.partName || c.name)].join(' ; ')),
  }));
  // BM25 statistics over the notes (D8): rare terms weigh more than appliance words and filler.
  const df = new Map();
  for (const e of index) {
    e.tf = new Map();
    for (const t of e.terms) e.tf.set(t, (e.tf.get(t) || 0) + 1);
    for (const t of e.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgLen = index.reduce((n, e) => n + e.terms.length, 0) / index.length;
  const vocab = new Set([...df.keys()].filter((t) => !t.includes(' ')));
  _kb = { docs, journeys, normal, safety, index, df, avgLen, vocab };
  return _kb;
}

// Negations are kept (D8): "won't drain" and "drains" are different faults. Apostrophes are folded ("won't" -> "wont").
// Appliance names say nothing about the fault once retrieval is scoped to the appliance, so they are not terms.
const STOP = new Set(('a an the and or but if it its is are was were be been my our your i me we you to of in on at for with from this that there has have had do does did so very just when then than as by up out off can '
  + 'appliance washing machine washer dryer drier tumble dishwasher dish fridge freezer refrigerator oven cooker hob hobs microwave vacuum cleaner').split(' '));
const NEGATION = /^(not|no|never|wont|dont|cant|doesnt|isnt|wasnt|didnt|wouldnt|couldnt|aint|nothing)$/;
function words(text) {
  return String(text || '').toLowerCase().replace(/[\u2018\u2019'`]/g, '').replace(/[^a-z0-9;]+/g, ' ').split(/\s+/).filter((w) => w === ';' || (w.length > 1 && !STOP.has(w)) || NEGATION.test(w));
}
/** Words and adjacent pairs; ";" separates phrases, so pairs never span two of them. */
function termList(text) {
  const out = [];
  const ws = words(text);
  ws.forEach((w, i) => {
    if (w === ';') return;
    out.push(w);
    if (i + 1 < ws.length && ws[i + 1] !== ';') out.push(`${w} ${ws[i + 1]}`);
  });
  return out;
}
function termSet(text) { return new Set(termList(text)); }

/** One-edit typo tolerance for longer words ("spinn" -> "spin", "drian" -> "drain"); exact words are kept as they are. */
function editsWithin1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}
function correct(word, vocab) {
  if (vocab.has(word) || word.length < 5 || /\d/.test(word)) return word;
  for (const v of vocab) if (v[0] === word[0] && editsWithin1(word, v)) return v;
  return word;
}
function queryTerms(text, vocab) {
  const ws = words(text).map((w) => (w === ';' ? w : correct(w, vocab)));
  return termList(ws.join(' '));
}

/** Appliance hints from text: a cheap deterministic signal used only to scope retrieval. */
const APPLIANCE_WORDS = [
  ['washer-dryer', /\b(washer[- ]?dryer|washer drier|wash(?:er)? and dry)\b/],
  ['tumble-dryer', /\b(tumble ?dryer|tumble ?drier|dryer|drier|condenser dryer|heat pump dryer)\b/],
  ['washing-machine', /\b(washing machine|washer|wash machine)\b/],
  ['dishwasher', /\b(dish ?washer)\b/],
  ['fridge-freezer', /\b(fridge|freezer|refrigerator|chest freezer|ice maker)\b/],
  ['microwave', /\b(microwave)\b/],
  ['hobs', /\b(hob|cooktop|induction|ceramic hob|gas hob|burner)\b/],
  ['oven-cooker', /\b(oven|cooker|grill|range cooker)\b/],
  ['vacuum', /\b(vacuum|hoover|dyson|shark|henry|cordless vac)\b/],
];
function applianceHints(text) {
  const t = String(text || '').toLowerCase();
  return APPLIANCE_WORDS.filter(([, re]) => re.test(t)).map(([a]) => a);
}
// A washer-dryer is a washing machine with a dryer: its washing faults are in the washing-machine notes (D9).
const ALSO = { 'washer-dryer': ['washing-machine'] };
const CROSS_FAMILY = 0.85;

function uniq(list) { return [...new Set(list.filter(Boolean).map((x) => String(x).trim()))]; }

/** Everything the note and its journeys hold that helps the reasoner (D5): nothing is truncated. */
function compactDoc(entry) {
  const d = entry.doc;
  const checks = [];
  for (const j of entry.journeys) {
    for (const c of j.checks) if (c.kind === 'ask_check') checks.push([c.say, c.ask].filter(Boolean).join(' '));
  }
  const causes = {};
  for (const j of entry.journeys) Object.assign(causes, j.causes);
  return {
    knowledgeId: d.knowledgeId,
    appliance: d.applianceFamily,
    fault: d.label,
    likelyComponents: d.likelyComponents,
    causes: Object.values(causes),
    clarifyingQuestion: d.clarifyingQuestion || null,
    secondaryQuestion: d.secondaryQuestion || null,
    discriminators: d.discriminators || [],
    componentEvidence: (d.components || []).map((c) => ({ name: c.name, type: c.type, supports: c.supports || [], against: c.against || [] })),
    commonConfusion: (d.commonConfusion || []).map((c) => ({ name: c.name, note: c.note, appliesIf: c.wouldApplyIf || [] })),
    ownerSafeChecks: uniq(checks),
    beforeReplacingAPart: d.adviceBeforeReplacement || [],
  };
}

/**
 * The fault nodes most relevant to the conversation, ranked by BM25 over each note's label, symptom phrases and fault
 * name (D8). appliance: the ledger appliance (or null); text: the customer's words so far; components: the parts a
 * resolved error code points to, which lift the notes about those parts; faultIds: the fault a resolved error code
 * names, whose note comes first (DW-02: 4C is a fill fault, whatever words the customer used).
 */
function retrieve({ appliance = null, text = '', components = [], faultIds = [], limit = 3 } = {}) {
  const { index, df, avgLen, vocab } = kb();
  const q = queryTerms(text, vocab);
  const hints = appliance ? [appliance] : applianceHints(text);
  const families = new Map();
  for (const h of hints) { families.set(h, 1); for (const a of ALSO[h] || []) if (!families.has(a)) families.set(a, CROSS_FAMILY); }
  const codeTerms = termSet(components.join(' ; '));
  const N = index.length, k1 = 1.2, b = 0.75;
  const qtf = new Map();
  for (const t of q) qtf.set(t, (qtf.get(t) || 0) + 1);
  const scored = [];
  for (const e of index) {
    const fw = families.size ? families.get(e.doc.applianceFamily) : 1;
    if (!fw) continue;
    let s = 0;
    for (const [t, n] of qtf) {
      const f = e.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * e.terms.length) / avgLen))) * (t.includes(' ') ? 1.5 : 1) * Math.min(n, 2);
    }
    // A resolved error code names the area of the fault: the notes about those components come first.
    let c = 0;
    for (const t of codeTerms) if (!t.includes(' ') && e.components.has(t)) c += 1;
    if (c) s += 4 + c;
    if (faultIds.includes(e.doc.faultId)) s += 1000;
    if (s > 0) scored.push([s * fw, e]);
  }
  scored.sort((x, y) => y[0] - x[0]);
  return scored.slice(0, limit).map(([score, e]) => ({ score: Math.round(score * 100) / 100, ...compactDoc(e) }));
}

/** Normal-operation notes that may apply. */
function normalNotes({ appliance = null, text = '', limit = 3 } = {}) {
  const { normal } = kb();
  const t = String(text || '').toLowerCase();
  const hints = appliance ? [appliance] : applianceHints(text);
  return normal
    .filter((n) => !hints.length || n.appliance.some((a) => hints.includes(a)))
    .map((n) => [n.match.filter((m) => t.includes(m)).length, n])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, n]) => ({ id: n.id, normal: n.normal, warningSigns: n.warning }));
}

/** Part-matching rules for a component on an appliance, from the retired journeys. */
function partMatchers(appliance) {
  const { journeys } = kb();
  const out = [];
  for (const j of journeys) {
    // The journeys name hobs `hob` (D9); a washer-dryer shares the washing machine's parts.
    const ja = j.appliance === 'hob' ? 'hobs' : j.appliance;
    if (appliance && ja !== appliance && !(appliance === 'washer-dryer' && ja === 'washing-machine')) continue;
    for (const [component, m] of Object.entries(j.partMatch || {})) {
      if (!m.re) continue;
      out.push({ component, label: (j.components || {})[component] || component.replace(/-/g, ' '), re: new RegExp(m.re.source, m.re.flags), not: m.not ? new RegExp(m.not.source, m.not.flags) : null });
    }
  }
  return out;
}

function safetyInformation(knowledgeId) {
  const s = kb().safety[knowledgeId];
  return s && s.text ? { text: s.text, classification: s.classification || null } : null;
}

function knownKnowledgeId(id) {
  return kb().docs.some((d) => d.knowledgeId === id);
}

module.exports = { APPLIANCES, retrieve, normalNotes, partMatchers, safetyInformation, applianceHints, knownKnowledgeId, words };
