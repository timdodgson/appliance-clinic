'use strict';
/**
 * Journey 3 pipeline — runs AFTER the cs/1 merge. PURE (the caller fetches the confirmed model's part list).
 *   modelNeed(state) / prepare(state, {errorCodes, modelParts}) / decide (shared) / mediaFor / summary
 */
const D = require('./j3-diagnostics.js');
const P = require('./j3-policy.js');
const JP = require('./journey-pipeline.js');
const { codeFaultFor } = require('./j2-diagnostics.js');

// Typed part-family matchers over catalogue titles for the CONFIRMED model.
const PART_MATCH = {
  'door-seal': { re: /door\s+(seal|gasket|boot)|\bdoor\s+rubber\b/i, not: /lock|interlock|hinge|handle/i },
  'inlet-hose': { re: /(inlet|fill|supply)\s+hose/i, not: null },
  'drain-hose': { re: /drain(age)?\s+hose/i, not: /pump/i },
  // a pump filter (cap / kit); never a mains (RFI) filter / suppressor, inlet mesh, lint or carbon filter
  'pump-filter': { re: /\b(pump|drain|debris)\s+filter\b|\bfilter\s+(cap|kit|assembly)\b/i, not: /inlet|mesh|lint|carbon|water\s+filter|mains|suppress/i },
  'detergent-drawer': { re: /(dispenser|detergent|soap)\s+drawer/i, not: null },
};
// Media by typed check / action key (existing customer-safe items only).
const MEDIA_BY_KEY = {
  'door-seal': { knowledgeId: 'washing-machine:odour', ids: ['wm-door-seal'], concepts: ['appliance-hygiene'] },
  'detergent-drawer': { knowledgeId: 'washing-machine:odour', ids: ['wm-detergent-drawer'], concepts: ['appliance-hygiene'] },
  'filter-seal': { knowledgeId: 'washing-machine:not-draining', ids: ['wm-pump-filter'], concepts: ['drainage-appliance'] },
  'inlet-connection': { knowledgeId: 'washing-machine:inlet-valve', ids: ['wm-inlet-hose-filter'], concepts: [] },
  'household-backflow': { knowledgeId: 'washing-machine:not-draining', ids: ['wm-backflow-sink-waste-pipe'], concepts: ['waste-backflow'] },
};

function modelNeed(state) {
  const m = state.identity && state.identity.model;
  return m && m.value && m.confirmed ? { model: m.value, make: state.identity.make && state.identity.make.value ? state.identity.make.value : null } : null;
}
function partLookupFrom(modelParts, component) {
  if (!component || !PART_MATCH[component]) return null;
  if (!Array.isArray(modelParts)) return { available: false, component, parts: [], reason: 'no_model_parts' };
  const { re, not } = PART_MATCH[component];
  const parts = modelParts.filter((p) => p && p.title && re.test(p.title) && !(not && not.test(p.title))).slice(0, 3);
  return { available: parts.length > 0, component, parts, reason: parts.length ? null : 'no_compatible_part' };
}
function prepare(state, { errorCodes = null, modelParts = null } = {}) {
  const codeFault = codeFaultFor(state, errorCodes);
  const diag = D.diagnose(state, { codeFault });
  const entry = P.entry(state, diag);
  const partLookup = entry.applies && diag.partEvidence.sufficient && modelNeed(state) ? partLookupFrom(modelParts, diag.partEvidence.component) : null;
  return { codeFault, diag, entry, partLookup };
}
const decide = JP.makeDecide(P);
function mediaFor(a) {
  if (!a) return null;
  if ((a.kind === 'ask_check' || a.kind === 'conclude') && MEDIA_BY_KEY[a.target]) return { key: a.target, ...JP.clone(MEDIA_BY_KEY[a.target]) };
  return null;
}
function summary(prep, out, extra = {}) { return JP.summarise('j3/1', prep, out, extra); }

module.exports = { PART_MATCH, MEDIA_BY_KEY, modelNeed, partLookupFrom, prepare, decide, applyIssuedRequest: JP.applyIssuedRequest, mediaFor, summary };
