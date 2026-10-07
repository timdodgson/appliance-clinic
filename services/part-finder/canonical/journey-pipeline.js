'use strict';
/**
 * Shared journey pipeline mechanics (PURE), used by every canonical journey (extracted from Journey 1).
 *   makeDecide(policyModule) -> decide(state, prep, {partLookup, control, turn}) -> {nextAction, partGate, state, issuedRequest}
 *   applyIssuedRequest(state, issuedRequest, turn)  (BFF replay: merge + issueRequest reproduces the digest)
 *   summarise(schema, prep, out, extra)            (bounded trace/log projection)
 * Requests are issued into cs/1 ONLY when canonical CONTROL owns the turn (shadow = trace-only NextAction).
 */
const rq = require('./requests.js');

const clone = (x) => JSON.parse(JSON.stringify(x));

function makeDecide(P) {
  return function decide(state, prep, { partLookup = null, control = false, turn } = {}) {
    const nextAction = P.policy(state, prep.diag, { partLookup });
    const partGate = P.partGate(state, prep.diag, partLookup);
    let next = state;
    let issuedRequest = null;
    if (control && prep.entry.applies && nextAction.pending) {
      issuedRequest = {
        slot: nextAction.pending.slot, target: nextAction.pending.target, purpose: nextAction.pending.purpose,
        kind: nextAction.requestKind || undefined, journey: nextAction.journey, rule: nextAction.rule,
      };
      if (issuedRequest.kind === undefined) delete issuedRequest.kind;
      const r = rq.issueRequest(clone(state), issuedRequest, Number.isInteger(turn) ? turn : state.version);
      next = r.state;
      if (r.overflow) issuedRequest = { ...issuedRequest, overflow: true };
    }
    return { nextAction, partGate, state: next, issuedRequest };
  };
}

function applyIssuedRequest(state, issuedRequest, turn) {
  if (!issuedRequest) return state;
  const { overflow, ...req } = issuedRequest;
  return rq.issueRequest(clone(state), req, turn).state;
}

function summarise(schema, prep, out, extra = {}) {
  const d = prep && prep.diag;
  const a = out && out.nextAction;
  return {
    schema,
    applies: Boolean(prep && prep.entry.applies),
    entry: prep ? { E1: prep.entry.E1, E2: prep.entry.E2, E3: prep.entry.E3, journey: prep.entry.journey } : null,
    codeArea: prep ? (prep.codeArea || prep.codeFault || null) : null,
    diagnostics: d ? {
      rank: d.rank.map((r) => [r.family, r.score, r.strongSupport]),
      // The engine's own FOR / AGAINST fact labels for the leading families (admin audit; bounded).
      evidence: d.rank.slice(0, 4).map((r) => ({ family: r.family,
        for: (r.support || []).slice(0, 8), against: (r.againstReasons || []).slice(0, 8) })),
      contradicted: d.contradicted.map((c) => c.family),
      leader: d.leader ? { family: d.leader.family, committed: d.leader.committed, level: d.leader.level, margin: d.leader.margin, component: d.leader.component } : null,
      likelyResolved: d.likelyResolved, partEvidence: d.partEvidence, noViableCause: d.noViableCause, pivotal: d.pivotal || null,
      ...(d.architecture ? { architecture: d.architecture } : {}),
    } : null,
    nextAction: a || null,
    partGate: out ? out.partGate : null,
    issuedRequest: out ? out.issuedRequest : null,
    ...extra,
  };
}

/**
 * Model-part-list journey pipeline (Journey 3 mechanics, shared by the batch-2 journeys). PURE.
 *   {D (diagnose), P (policy), schema, PART_MATCH {component: {re, not}}, MEDIA_BY_KEY {actionTarget: media}, codeFaultFor}
 * The caller (part-finder) fetches the CONFIRMED model's part list; matching is by typed component family only.
 */
function makeModelPartPipeline({ D, P, schema, PART_MATCH = {}, MEDIA_BY_KEY = {}, codeFaultFor = () => null }) {
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
    const diag = D.diagnose(state, { codeFault, errorCodes, modelParts });
    const entry = P.entry(state, diag);
    const partLookup = entry.applies && diag.partEvidence.sufficient && modelNeed(state) ? partLookupFrom(modelParts, diag.partEvidence.component) : null;
    return { codeFault, diag, entry, partLookup };
  }
  const decide = makeDecide(P);
  function mediaFor(a) {
    if (!a) return null;
    if ((a.kind === 'ask_check' || a.kind === 'conclude' || a.kind === 'ask_observation') && MEDIA_BY_KEY[a.target]) return { key: a.target, ...clone(MEDIA_BY_KEY[a.target]) };
    return null;
  }
  const summary = (prep, out, extra = {}) => summarise(schema, prep, out, extra);
  return { PART_MATCH, MEDIA_BY_KEY, modelNeed, partLookupFrom, prepare, decide, applyIssuedRequest, mediaFor, summary };
}

module.exports = { makeDecide, applyIssuedRequest, summarise, clone, makeModelPartPipeline };
