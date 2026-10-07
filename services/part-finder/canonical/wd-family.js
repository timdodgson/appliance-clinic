'use strict';
/**
 * Washer-dryer family — the ONE ownership function for the washer-dryer journeys, plus the WASH-SIDE VIEW wrapper (PURE).
 *
 * A washer-dryer washes exactly like a washing machine, so the wash-side journeys REUSE the accepted washing-machine
 * diagnostics / policy / COMPOSE (no copies, no refactor): each wrapper presents a *view* of the state with
 * identity.appliance = washing-machine to the WM pipeline, then restores the real state and stamps its own journey key
 * on the NextAction / issued request. Each wrapper is certified and gated separately (its own key + kill switch). The
 * drying side is NOT the tumble-dryer architecture: wd-not-drying is a native module (wd-not-drying.js).
 *
 * Ownership (first match wins; a handoff happens once):
 *   1. drying side : a not-drying report, or "doesn't heat" stated to be during DRYING (wdDrySide / dry_only)  → wd-not-drying
 *   2. wash side   : the WM entries evaluated under the view in WM routing order (J1 retained water first, then
 *                    not-spinning, leaking, not-filling, overfilling, door, vibration, noisy, not-heating). A "doesn't
 *                    heat" with the side unknown → wd-not-heating-wash, which asks the side FIRST (if drying →
 *                    wd-not-drying takes over).
 * Error codes under the view resolve through the WM code tables (documented; WD-specific code tables are not owned).
 */
const JP = require('./journey-pipeline.js');
const rq = require('./requests.js');
const engine = require('./evidence-engine.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const WASH = [
  ['wd-not-draining', 'j1', 'washing-machine:not-draining'],
  ['wd-not-spinning', 'j2', 'washing-machine:motor-drum'],
  ['wd-leaking', 'j3', 'washing-machine:leak-drain'],
  ['wd-not-filling', 'j4', 'washing-machine:inlet-valve'],
  ['wd-overfilling', 'j5', 'washing-machine:inlet-valve'],
  ['wd-door', 'j6', 'washing-machine:door-lock'],
  ['wd-excessive-vibration', 'j7', 'washing-machine:excessive-vibration'],
  ['wd-noisy', 'j8', 'washing-machine:motor-drum'],
  ['wd-not-heating-wash', 'j9', 'washing-machine:heater'],
];
// eslint-disable-next-line global-require, import/no-dynamic-require
const pipelineOf = (j) => require(`./${j}-pipeline.js`);
// eslint-disable-next-line global-require, import/no-dynamic-require
const policyOf = (j) => require(`./${j}-policy.js`);

const applianceOf = (s) => (s && s.identity && s.identity.appliance && s.identity.appliance.value) || null;
/** The wash-side view: the same state with identity.appliance = washing-machine (null if not a washer-dryer). */
function viewOf(state) {
  if (applianceOf(state) !== 'washer-dryer') return null;
  const v = clone(state);
  v.identity.appliance = { ...v.identity.appliance, value: 'washing-machine' };
  return v;
}
const activeProblem = (s) => (s.problems || []).find((p) => p.status === 'active') || null;
/** The drying side owns it: a not-drying report, or no heat stated to be during drying. */
function drySide(state) {
  const p = activeProblem(state); const j = p && p.journey ? p.journey.value : null;
  if (j === 'not-drying') return true;
  if (j === 'no-heat') return engine.obsVal(state, 'wdDrySide') === true || Boolean(p.scope && p.scope.value === 'dry_only');
  return false;
}
function wdOwner(state, { errorCodes = null } = {}) {
  const view = viewOf(state);
  if (!view) return null;
  if (drySide(state)) return 'wd-not-drying';
  for (const [key, j] of WASH) {
    const prep = pipelineOf(j).prepare(view, { errorCodes });
    if (prep.entry && prep.entry.applies) return key;
  }
  return null;
}

// Journey-1 part matching for the view (the lambda's J1 lookup is WM-only; the wrapper matches the model's list itself).
const J1_PART_MATCH = {
  'drain-pump': { re: /drain\s+pump|pump\s+(assembly|motor)|\bpump\b/i, not: /circulation|recirculation|heat\s*pump|\bfilter\b(?!.*\bpump\s+(assembly|motor|complete))/i },
  'pump-filter': { re: /(pump|drain)\s+filter|filter\s+(cap|plug|insert)|coin\s+trap/i, not: /lint|fluff|pump\s+(assembly|motor)/i },
  'drain-hose': { re: /(drain|outlet)\s+hose/i, not: /inlet|fill/i },
};

/**
 * makeWashWrapper({KEY, j, sideQuestion}) -> a model-part-list pipeline (same interface as journey-pipeline) for one
 * wash-side washer-dryer journey over the WM journey `j`.
 */
function makeWashWrapper({ KEY, j, sideQuestion = false }) {
  const inner = pipelineOf(j);
  const IP = policyOf(j);
  const KNOWLEDGE = (WASH.find((w) => w[0] === KEY) || [])[2] || null;
  const notApplying = (state) => ({ diag: null, entry: { E1: false, E2: false, E3: false, candidate: false, applies: false, journey: null, appliance: applianceOf(state) } });

  function partLookupFrom(modelParts, component) {
    // Journey 1's own lookup needs the Lambda's catalogue alias matcher; the washer-dryer keeps its typed regexes
    if (j !== 'j1' && inner.partLookupFrom) return inner.partLookupFrom(modelParts, component);
    if (!component || !J1_PART_MATCH[component]) return null;
    if (!Array.isArray(modelParts)) return { available: false, component, parts: [], reason: 'no_model_parts' };
    const { re, not } = J1_PART_MATCH[component];
    const parts = modelParts.filter((p) => p && p.title && re.test(p.title) && !(not && not.test(p.title))).slice(0, 3);
    return { available: parts.length > 0, component, parts, reason: parts.length ? null : 'no_compatible_part' };
  }
  function modelNeed(state) {
    const m = state.identity && state.identity.model;
    return m && m.value && m.confirmed ? { model: m.value, make: state.identity.make && state.identity.make.value ? state.identity.make.value : null } : null;
  }
  function prepare(state, { errorCodes = null, modelParts = null } = {}) {
    const view = viewOf(state);
    if (!view) return notApplying(state);
    const ip = j === 'j1' ? inner.prepare(view, { errorCodes }) : inner.prepare(view, { errorCodes, modelParts });
    const owner = wdOwner(state, { errorCodes });
    const entry = { ...ip.entry, appliance: 'washer-dryer', applies: Boolean(ip.entry && ip.entry.applies && owner === KEY), wdOwner: owner };
    let partLookup = ip.partLookup || null;
    if (j === 'j1') partLookup = entry.applies && ip.partLookupNeed && Array.isArray(modelParts) ? partLookupFrom(modelParts, ip.partLookupNeed.component) : null;
    return { ...ip, entry, partLookup };
  }
  const stamp = (a) => (a ? { ...a, journey: KEY } : a);
  function sideAsk(state, a) {
    if (!sideQuestion || !a || ['safety_stop', 'close_resolved', 'exit_journey'].includes(a.kind) || a.target === 'unsafe-request-declined') return null;
    const p = activeProblem(state);
    if (engine.obsVal(state, 'wdDrySide') != null || (p && p.scope && ['wash_only', 'dry_only'].includes(p.scope.value))) return null;
    if (rq.requestsFor(state, 'wdDrySide').length) return null; // asked once; unanswered → the wash side carries on
    return { kind: 'ask_observation', target: 'wdDrySide', reason: 'wash-water-or-drying-air', requires: [], expects: ['observations.wdDrySide'],
      pending: { slot: 'OBSERVATION', target: 'wdDrySide', purpose: 'DIAGNOSIS' }, conclusion: null, journey: KEY, rule: 'H0', requestKind: 'ask' };
  }
  const P = {
    JOURNEY: KEY,
    policy(state, d, ctx = {}) {
      const view = viewOf(state) || state;
      const a = stamp(IP.policy(view, d, ctx));
      return sideAsk(state, a) || a;
    },
    partGate(state, d, pl) { return IP.partGate(viewOf(state) || state, d, pl); },
    entry(state, d) { return prepare(state).entry || IP.entry(state, d); },
  };
  const decide = JP.makeDecide(P);
  function mediaFor(a) {
    const m = inner.mediaFor ? inner.mediaFor(a) : null;
    return m ? { knowledgeId: KNOWLEDGE, ...m } : null;
  }
  const schema = `wd-${j}/1`;
  const summary = (prep, out, extra = {}) => JP.summarise(schema, prep, out, { wdOwner: prep && prep.entry ? prep.entry.wdOwner || null : null, ...extra });
  return { KEY, INNER: j, PART_MATCH: inner.PART_MATCH || J1_PART_MATCH, MEDIA_BY_KEY: inner.MEDIA_BY_KEY || {}, modelNeed, partLookupFrom, prepare, decide,
    applyIssuedRequest: JP.applyIssuedRequest, mediaFor, summary, P, schema };
}

const WD_MODEL_ASK = { say: 'To match the right part for your washer-dryer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate around the door opening or on the back — a photo is fine.' };
const UNSAFE = ['live_electrical_test', 'open_while_powered', 'bypass_safety_device', 'repeated_reset_after_trip'];

module.exports = { WASH, viewOf, drySide, wdOwner, makeWashWrapper, J1_PART_MATCH, WD_MODEL_ASK, UNSAFE };
