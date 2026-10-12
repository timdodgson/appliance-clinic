'use strict';
/**
 * Deterministic part gate.
 *
 * The reasoner may propose a likely component. A part card reaches the customer only when:
 *   G1 the proposal cites customer- or tool-sourced evidence that is recorded and not contradicted;
 *   G2 the reasoner's own assessment is narrowed (or engineer-level) with at least medium confidence;
 *   G3 no hazard is active that forbids continuing with the appliance;
 *   G4 the customer's model number is known and the parts catalogue recognises it;
 *   G5 the catalogue lists a part for that model that matches the component.
 * Outcomes: 'verified' (model-confirmed parts), 'model_needed' (likely component, model needed before buying),
 * 'no_catalogue_part', 'not_justified' (with the failed conditions), or 'none' (nothing proposed).
 * Price and availability come only from the catalogue; nothing here invents them.
 */
const K = require('./knowledge.js');
const L = require('./ledger.js');

const GENERIC = new Set(['part', 'parts', 'assembly', 'kit', 'unit', 'genuine', 'replacement', 'spare', 'for', 'and', 'the', 'with']);
function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !GENERIC.has(w));
}

/** The journey part-matcher that best fits the proposed component, if any. */
function matcherFor(appliance, component) {
  const cw = new Set(words(component));
  let best = null;
  for (const m of K.partMatchers(appliance)) {
    const mw = words(`${m.component.replace(/-/g, ' ')} ${m.label}`);
    const n = mw.filter((w) => cw.has(w)).length;
    if (n && (!best || n > best.n)) best = { n, m };
  }
  return best ? best.m : null;
}

function matchParts(parts, appliance, component) {
  const m = matcherFor(appliance, component);
  if (m) {
    const hits = parts.filter((p) => p && p.title && m.re.test(p.title) && !(m.not && m.not.test(p.title)));
    if (hits.length) return { parts: hits.slice(0, 3), matcher: m.component };
  }
  // No journey matcher: every distinctive word of the component must appear in the title.
  const cw = words(component);
  if (!cw.length) return { parts: [], matcher: null };
  const hits = parts.filter((p) => p && p.title && cw.every((w) => p.title.toLowerCase().includes(w)));
  return { parts: hits.slice(0, 3), matcher: m ? m.component : 'words' };
}

/**
 * proposal: the reasoner's normalised proposal; state: ledger; hazard: active hazard {type, policy} or null.
 * lookup: async (model) -> { parts, model } (the external parts catalogue).
 */
async function gate(proposal, state, hazard, { lookup, appliance }) {
  const p = proposal.part;
  if (!p) return { outcome: 'none', failed: [] };
  const failed = [];
  const facts = new Map(L.supportingFacts(state).map((f) => [f.id, f]));
  const cited = (p.evidence || []).filter((id) => facts.has(id));
  if (!cited.length) failed.push('G1-no-recorded-evidence');
  const a = proposal.assessment;
  if (!['narrowed', 'needs_engineer', 'resolved'].includes(a.status) || a.confidence === 'low') failed.push('G2-not-narrowed');
  if (hazard && (hazard.policy.terminate || ['burning', 'fire', 'gas', 'battery', 'electric_shock', 'microwave_arcing', 'supply_trip'].includes(hazard.type))) failed.push('G3-active-hazard');
  const base = { component: p.component, cited, failed };
  if (failed.length) return { outcome: 'not_justified', ...base };

  const model = state.model && state.model.value;
  if (!model) return { outcome: 'model_needed', ...base };
  let res;
  try { res = await lookup(model); } catch { res = { parts: [], model: null }; }
  const parts = Array.isArray(res && res.parts) ? res.parts : [];
  // The model is known but the catalogue has nothing for it: asking for the model again would not help.
  if (!parts.length) return { outcome: 'no_catalogue_part', reason: 'catalogue-does-not-recognise-model', ...base, failed: ['G4-model-not-in-catalogue'] };
  const m = matchParts(parts, appliance, p.component);
  if (!m.parts.length) return { outcome: 'no_catalogue_part', ...base, failed: ['G5-no-matching-part'], matcher: m.matcher };
  return { outcome: 'verified', ...base, parts: m.parts, catalogueModel: res.model || model, matcher: m.matcher };
}

module.exports = { gate, matchParts, matcherFor };
