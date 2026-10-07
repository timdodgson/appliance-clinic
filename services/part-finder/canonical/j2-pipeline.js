'use strict';
/**
 * Journey 2 pipeline — runs AFTER the cs/1 merge. PURE: the caller fetches the confirmed model's catalogue
 * part list (modelNeed) and passes it in; architecture typing and the typed part lookup derive from it.
 *
 *   modelNeed(state)                                   -> {model, make} | null   (confirmed model only)
 *   prepare(state, {errorCodes, modelParts})           -> {codeFault, diag, entry, partLookup}
 *   decide(state, prep, {partLookup, control, turn})   -> shared (journey-pipeline)
 *   mediaFor(nextAction)                               -> {key, knowledgeId, ids[], concepts[]} | null
 */
const D = require('./j2-diagnostics.js');
const P = require('./j2-policy.js');
const JP = require('./journey-pipeline.js');

// Typed part-family matchers over catalogue titles for the CONFIRMED model (never brand-only search).
const PART_MATCH = {
  'drive-belt': { re: /\bbelt\b/i, not: /tumble\s*dryer|agitator/i },
  'carbon-brushes': { re: /carbon\s+(motor\s+)?brush|motor\s+brush/i, not: null },
  'door-lock': { re: /door\s+(lock|interlock)|\binterlock\b/i, not: /handle|hinge|seal/i },
};
// Media by typed action key (only where an existing customer-safe item genuinely helps).
const MEDIA_BY_KEY = {
  'door-closed-latched': { knowledgeId: 'washing-machine:door-lock', ids: ['wm-door-lock-about'], concepts: [] },
  'suspension-or-movement': { knowledgeId: 'washing-machine:excessive-vibration', ids: ['wm-transit-bolts'], concepts: [] },
};

function modelNeed(state) {
  const m = state.identity && state.identity.model;
  if (!(m && m.value && m.confirmed)) return null;
  return { model: m.value, make: state.identity.make && state.identity.make.value ? state.identity.make.value : null };
}

function partLookupFrom(modelParts, component) {
  if (!component || !PART_MATCH[component]) return null;
  if (!Array.isArray(modelParts)) return { available: false, component, parts: [], reason: 'no_model_parts' };
  const { re, not } = PART_MATCH[component];
  const parts = modelParts.filter((p) => p && p.title && re.test(p.title) && !(not && not.test(p.title))).slice(0, 3);
  return { available: parts.length > 0, component, parts, reason: parts.length ? null : 'no_compatible_part' };
}

function prepare(state, { errorCodes = null, modelParts = null } = {}) {
  const codeFault = D.codeFaultFor(state, errorCodes);
  const architecture = D.architectureOf(state, { modelParts, errorCodes });
  const diag = D.diagnose(state, { codeFault, architecture, errorCodes, modelParts });
  const entry = P.entry(state, diag);
  const partLookup = entry.applies && diag.partEvidence.sufficient && modelNeed(state)
    ? partLookupFrom(modelParts, diag.partEvidence.component) : null;
  return { codeFault, architecture, diag, entry, partLookup };
}

const decide = JP.makeDecide(P);

function mediaFor(a) {
  if (!a) return null;
  if (a.kind === 'ask_check' && MEDIA_BY_KEY[a.target]) return { key: a.target, ...JP.clone(MEDIA_BY_KEY[a.target]) };
  if (a.kind === 'conclude' && MEDIA_BY_KEY[a.target]) return { key: a.target, ...JP.clone(MEDIA_BY_KEY[a.target]) };
  return null;
}
function summary(prep, out, extra = {}) { return JP.summarise('j2/1', prep, out, extra); }

module.exports = { PART_MATCH, MEDIA_BY_KEY, modelNeed, partLookupFrom, prepare, decide, applyIssuedRequest: JP.applyIssuedRequest, mediaFor, summary };
