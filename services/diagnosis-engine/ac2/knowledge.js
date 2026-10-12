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
    terms: termSet([d.label, ...(d.symptoms || []), d.faultId.replace(/-/g, ' ')].join(' ')),
  }));
  _kb = { docs, journeys, normal, safety, index };
  return _kb;
}

const STOP = new Set('a an the and or but if it its it\'s is are was were be been my our your i me we you to of in on at for with from this that there it has have had not no do does did so very just when then than as by up out off can cant can\'t wont won\'t dont don\'t'.split(' '));
function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}
function termSet(text) {
  const out = new Set();
  const ws = words(text);
  ws.forEach((w, i) => { out.add(w); if (i + 1 < ws.length) out.add(`${w} ${ws[i + 1]}`); });
  return out;
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

function trim(s, n) { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function compactDoc(entry) {
  const d = entry.doc;
  const checks = [];
  for (const j of entry.journeys) {
    for (const c of j.checks) {
      if (c.kind !== 'ask_check') continue;
      checks.push(trim([c.say, c.ask].filter(Boolean).join(' '), 320));
      if (checks.length >= 6) break;
    }
  }
  const causes = {};
  for (const j of entry.journeys) Object.assign(causes, j.causes);
  return {
    knowledgeId: d.knowledgeId,
    appliance: d.applianceFamily,
    fault: d.label,
    likelyComponents: d.likelyComponents,
    causes: Object.values(causes).slice(0, 8),
    discriminators: (d.discriminators || []).slice(0, 4).map((x) => trim(x, 260)),
    commonConfusion: (d.commonConfusion || []).slice(0, 3).map((c) => trim(`${c.name}: ${c.note}`, 260)),
    ownerSafeChecks: checks,
    beforeReplacingAPart: (d.adviceBeforeReplacement || []).slice(0, 4).map((x) => trim(x, 200)),
  };
}

/**
 * The fault nodes most relevant to the conversation.
 * appliance: the ledger appliance (or null); text: the customer's words so far.
 */
function retrieve({ appliance = null, text = '', limit = 3 } = {}) {
  const { index } = kb();
  const q = termSet(text);
  const hints = appliance ? [appliance] : applianceHints(text);
  const scored = [];
  for (const e of index) {
    if (hints.length && !hints.includes(e.doc.applianceFamily)) continue;
    let s = 0;
    for (const t of q) if (e.terms.has(t)) s += t.includes(' ') ? 3 : 1;
    if (s > 0) scored.push([s, e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([score, e]) => ({ score, ...compactDoc(e) }));
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
    if (appliance && j.appliance !== appliance && !(appliance === 'washer-dryer' && j.appliance === 'washing-machine')) continue;
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
