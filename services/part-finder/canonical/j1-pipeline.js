'use strict';
/**
 * Journey 1 pipeline — runs AFTER the cs/1 merge. PURE (the part lookup is fetched by the caller).
 *
 *   prepare(state, {errorCodes, modelParts, matchComponent}) -> {codeArea, diag, entry, partLookupNeed, partLookup}
 *   modelNeed(state)                                    -> {model, make} | null   (the caller fetches that model's parts)
 *   decide(state, prep, {partLookup, control, turn})    -> {nextAction, partGate, state, issuedRequest}
 *   mediaFor(nextAction)                                -> {key, ids[], concepts[]} | null   (media by check/action key)
 *   summary(result)                                     -> bounded trace/log projection
 *
 * Requests are issued into cs/1 ONLY when canonical CONTROL owns the turn: in shadow the NextAction is
 * trace-only, so pendingRequest never claims a question the legacy path did not actually ask.
 * The issued request is returned so the BFF turn record can replay it (merge + issueRequest = digest).
 */

const D = require('./j1-diagnostics.js');
const P = require('./j1-policy.js');
const JP = require('./journey-pipeline.js');

const { clone } = JP;

// Media keyed by typed check / action key (evidence doc K6; journey doc C6). Ids are media-information items.
const MEDIA_BY_KEY = {
  'drain-filter': { ids: ['wm-pump-filter', 'wm-pump-unblock-howtorepair', 'wm-drain-hotpoint-f05-f11', 'wm-drain-lg-oe'], concepts: ['drainage-appliance'] },
  'pump-impeller': { ids: ['wm-pump-unblock-howtorepair', 'wm-drain-hotpoint-f05-f11', 'wm-drain-lg-oe'], concepts: ['drainage-appliance'] },
  'household-waste-backflow': { ids: ['wm-backflow-sink-waste-pipe'], concepts: ['waste-backflow'] },
};

// Journey 1 part families -> catalogue component terms (matched with the catalogue alias matcher the runtime injects).
const COMPONENT_TERMS = { 'drain-pump': 'drain pump', 'pump-filter': 'pump filter', 'drain-hose': 'drain hose' };

function modelNeed(state) {
  const m = state.identity && state.identity.model;
  return m && m.value && m.confirmed ? { model: m.value, make: state.identity.make && state.identity.make.value ? state.identity.make.value : null } : null;
}

/** Typed part lookup over the CONFIRMED model's part list: parts filtered to the gated component. Never brand-only. */
function partLookupFrom(modelParts, component, matchComponent) {
  if (!component) return null;
  const term = COMPONENT_TERMS[component];
  if (!term) return { available: false, component, parts: [], reason: 'component_not_part_eligible' };
  if (!Array.isArray(modelParts) || typeof matchComponent !== 'function') return { available: false, component, parts: [], reason: 'no_model_parts' };
  const parts = modelParts
    .filter((p) => p && p.title && matchComponent(p.title, term))
    // a drain-pump FILTER is not the pump; a pump is not the filter
    .filter((p) => (component === 'drain-pump'
      ? !/\bfilter\b/i.test(p.title) || /\bwith\s+(a\s+)?filter\b|\bpump\s+(assembly|motor|complete)\b/i.test(p.title)
      : true))
    .slice(0, 3);
  return { available: parts.length > 0, component, parts, reason: parts.length ? null : 'no_compatible_part' };
}

/**
 * -> {codeArea, diag, entry, partLookupNeed, partLookup}. `partLookupNeed` (model + component) is set when the part
 * gate's evidence is met for a confirmed model; `partLookup` is filled once the caller supplies the model's parts.
 */
function prepare(state, { errorCodes, modelParts = null, matchComponent = null } = {}) {
  const codeArea = D.codeAreaFor(state, errorCodes);
  const diag = D.diagnose(state, { codeArea });
  const entry = P.entry(state, diag);
  const need = modelNeed(state);
  const partLookupNeed = entry.applies && diag.partEvidence.sufficient && need ? { ...need, component: diag.partEvidence.component } : null;
  const partLookup = partLookupNeed && Array.isArray(modelParts) ? partLookupFrom(modelParts, partLookupNeed.component, matchComponent) : null;
  return { codeArea, diag, entry, partLookupNeed, partLookup };
}

const decide = JP.makeDecide(P);
const { applyIssuedRequest } = JP;

function mediaFor(a) {
  if (!a) return null;
  if (a.kind === 'ask_check' && MEDIA_BY_KEY[a.target]) return { key: a.target, ...clone(MEDIA_BY_KEY[a.target]) };
  if (a.kind === 'conclude' && a.target === 'household-waste-backflow') return { key: a.target, ...clone(MEDIA_BY_KEY[a.target]) };
  return null;
}

function summary(prep, out, extra = {}) { return JP.summarise('j1/1', prep, out, extra); }

module.exports = { MEDIA_BY_KEY, COMPONENT_TERMS, modelNeed, partLookupFrom, prepare, decide, applyIssuedRequest, mediaFor, summary };
