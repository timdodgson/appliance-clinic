'use strict';
/**
 * Stage D test helpers shared by the unit oracle suite and the live Jev evaluation.
 *   stateFromCtx(ctx)               -> a real cs/1 state carrying the fixture's read-only context
 *   expectedMc1(expect, messageId)  -> the COMPLETE expected mc/1 (every unlisted leaf null / empty)
 *   oracleAnswers(fx, req)          -> the ideal typed Jev answers for the fixture, per question in req
 *   fieldDiff(expected, actual)     -> per-field comparison [{field, expected, actual, ok}]
 */
const cs1 = require('../../canonical/cs1.js');
const mc1 = require('../../canonical/mc1.js');
const Q = require('../../canonical/mc1-questions.js');

const CSID = 'cs_' + 'D'.repeat(32);

function stateFromCtx(ctx) {
  if (!ctx) return null;
  const s = cs1.emptyState(CSID);
  s.version = 3;
  const fact = (v, basis = 'stated') => cs1.newFact(v, basis, 1);
  if (ctx.appliance) { s.identity.appliance = { ...fact(ctx.appliance[0], ctx.appliance[1]) }; s.identity.applianceEstablishment = ctx.appliance[1] === 'stated' ? 'established' : 'working'; }
  if (ctx.make) s.identity.make = fact(ctx.make);
  if (ctx.model) s.identity.model = { ...fact(ctx.model), confirmed: false };
  if (ctx.fuel) s.identity.fuel = { ...fact(ctx.fuel), conflict: false };
  if (ctx.journey || ctx.faultDomain || ctx.scope) {
    s.problems.push({ id: 'p1', status: 'active', origin: 'stated', journey: ctx.journey ? fact(ctx.journey) : cs1.emptyFact(),
      faultDomain: ctx.faultDomain ? fact(ctx.faultDomain) : cs1.emptyFact(), scope: ctx.scope ? fact(ctx.scope) : cs1.emptyFact(),
      openedTurn: 1, resolvedTurn: null, recurrences: [], archive: null });
  }
  for (const [k, v] of Object.entries(ctx.observations || {})) s.evidence.observations[k] = fact(v);
  for (const [k, [status, result]] of Object.entries(ctx.checks || {})) s.evidence.checks[k] = { status, result: result || null, turn: 2, history: [] };
  for (const h of ctx.hazards || []) s.safety.hazards.push({ hazard: h, turn: 1, status: 'active', correctedTurn: null });
  if (ctx.pending) {
    s.requests.push({ id: 'r1', slot: ctx.pending.slot, target: ctx.pending.target, purpose: 'DIAGNOSIS', kind: 'ask', issuedTurn: 3, outcome: 'pending', resolvedTurn: null });
    s.pendingRequest = 'r1';
  }
  return s;
}

function expectedMc1(e, messageId = null) {
  const c = mc1.emptyClassification(messageId);
  c.scope = e.scope || 'unclear';
  if (e.appliance) c.identity.appliance = { value: e.appliance[0], basis: e.appliance[1] };
  if (e.make) c.identity.make = { value: e.make, basis: 'stated' };
  if (e.model) c.identity.model = { value: e.model, basis: 'stated' };
  c.identity.modelStatus = e.modelStatus || null;
  c.identity.fuel = e.fuel || null;
  c.identity.displayedCode = e.code || null;
  c.intent = e.intent || null;
  c.problem = { faultDomain: e.faultDomain || null, journey: e.journey || null, scope: e.symptomScope || null, relation: e.relation || null };
  c.safety = { hazard: e.hazard || null, unsafeAction: e.unsafeAction || null };
  // observations in OBS question order (the adapter's deterministic order)
  const order = Q.OBS.flatMap((o) => (o.noul ? [o.noul[0]] : Object.values(o.options).map((x) => x[0])));
  c.observations = Object.entries(e.observations || {}).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([key, value]) => ({ key, value }));
  c.checks = Object.entries(e.checks || {}).sort((a, b) => mc1.CHECK_KEYS.indexOf(a[0]) - mc1.CHECK_KEYS.indexOf(b[0]))
    .map(([check, [status, result]]) => ({ check, status, result: Q.STATUS_ONLY_CHECKS.has(check) ? null : (result || null) }));
  c.reply = { toPending: e.toPending || null, correction: [...(e.correction || [])], outcome: e.outcome || null };
  c.mentions = { replacedParts: [...(e.replaced || [])], customerTheories: [...(e.theories || [])] };
  return mc1.validateClassification(c);
}

const ch = (choice, confidence = 0.92) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence } });
const nl = (v) => ({ type: 'noul', noul: v ? 0.95 : 0.04 });

/** The ideal answers for a fixture. Fails loudly (returns null for a role) when a value is not offered. */
function oracleAnswers(fx, req) {
  const e = fx.expect;
  const a = {};
  const missing = [];
  const coreMap = {
    mcScope: e.scope || 'unclear', mcAppliance: e.appliance ? e.appliance[0] : 'none', mcApplianceBasis: e.appliance ? e.appliance[1] : 'none',
    mcModelStatus: e.modelStatus || 'none', mcFuel: e.fuel || 'none', mcIntent: e.intent || 'none', mcFaultDomain: e.faultDomain || 'none',
    mcJourney: e.journey || 'none', mcSymptomScope: e.symptomScope || 'none', mcRelation: e.relation || 'none', mcHazard: e.hazard || 'none',
    mcUnsafeAction: e.unsafeAction || 'none', mcOutcome: e.outcome || 'none', mcToPending: e.toPending || 'none',
    mcIdentifierNotListed: e.recallGap || 'none',
  };
  for (const [k, v] of Object.entries(coreMap)) if (req.questions[k]) a[k] = ch(v);
  const roleAnswer = (role, value, list) => {
    const plan = req.plan.roles[role];
    if (!plan) { if (value) missing.push(`${role}:${value}:no-question`); return; }
    const target = value ? list.find((c) => c.value === value) : null;
    if (value && !target) missing.push(`${role}:${value}:not-a-candidate`);
    for (const { key, ids } of plan) a[key] = ch(target && ids.includes(target.id) ? target.id : 'none');
  };
  const cands = req.plan.candidates;
  roleAnswer('candMake', e.make, cands.brands);
  roleAnswer('candModel', e.model, cands.identifiers);
  let code1 = e.code || null; let code2 = null;
  if (code1 && !cands.identifiers.some((c) => c.value === code1) && code1.includes('/')) [code1, code2] = code1.split('/');
  roleAnswer('candCode', code1, cands.identifiers);
  roleAnswer('candCode2', code2, cands.identifiers);
  roleAnswer('candPartNumber', e.partNumber || null, cands.identifiers);
  if (req.questions.mcReportBelt) a.mcReportBelt = nl(Boolean(e.checks && e.checks['drive-belt'] && e.checks['drive-belt'][1] === 'fault_seen'));
  if (req.questions.mcReportDamper) a.mcReportDamper = nl(Boolean(e.checks && e.checks['shock-absorbers'] && e.checks['shock-absorbers'][1] === 'fault_seen'));
  if (req.questions.mcReplacedStated) a.mcReplacedStated = nl(Boolean((e.replaced || []).length));
  if (req.questions.mcTheoryStated) a.mcTheoryStated = nl(Boolean((e.theories || []).length));
  roleAnswer('mcReplacedPart', (e.replaced || [])[0] || null, cands.components);
  roleAnswer('mcTheoryPart', (e.theories || [])[0] || null, cands.components);
  for (const o of Q.OBS) {
    if (o.noul) { a[o.key] = nl(e.observations && e.observations[o.noul[0]] === true); continue; }
    const hit = Object.entries(o.options).find(([, [k, v]]) => e.observations && e.observations[k] === v);
    a[o.key] = ch(hit ? hit[0] : 'none');
  }
  const inverse = Object.fromEntries(Object.entries(Q.CHECK_STATUS).filter(([opt]) => opt !== 'done_found_unspecified').map(([opt, [st, r]]) => [`${st}:${r}`, opt]));
  const optFor = (key, want) => {
    const r = Q.STATUS_ONLY_CHECKS.has(key) ? null : (want[1] || null);
    return inverse[`${want[0]}:${r}`] || (want[0] === 'done' ? 'done_no_result' : 'none');
  };
  const checks = Object.entries(e.checks || {});
  let rest = checks.filter(([k, v]) => !(k === 'drive-belt' && v[1] === 'fault_seen' && req.questions.mcReportBelt)
    && !(k === 'shock-absorbers' && v[1] === 'fault_seen' && req.questions.mcReportDamper));
  if (req.plan.pendingCheck) {
    const pk = req.plan.pendingCheck[1];
    const hit = checks.find(([k]) => k === pk);
    a[req.plan.pendingCheck[0]] = ch(hit ? optFor(pk, hit[1]) : 'none');
    rest = checks.filter(([k]) => k !== pk);
  }
  req.plan.checks.forEach(([tk, rk], i) => {
    const item = rest[i];
    a[tk] = ch(item ? item[0] : 'none');
    a[rk] = ch(item ? optFor(item[0], item[1]) : 'none');
  });
  if (rest.length > req.plan.checks.length) missing.push('checks:more-than-two-unprompted');
  if (req.plan.pendingObservation) {
    const [qk, key] = req.plan.pendingObservation;
    const v = e.observations ? e.observations[key] : undefined;
    a[qk] = ch(v === true ? 'yes' : v === false ? 'no' : 'none');
  }
  for (const [k, path] of req.plan.correctable) a[k] = nl((e.correction || []).includes(path));
  for (const p of e.correction || []) if (!req.plan.correctable.some(([, x]) => x === p)) missing.push(`correction:${p}:no-question`);
  if (e.toPending && !req.questions.mcToPending) missing.push('toPending:no-question');
  return { answers: a, missing };
}

const FIELDS = ['scope', 'identity.appliance', 'identity.make', 'identity.model', 'identity.modelStatus', 'identity.fuel', 'identity.displayedCode',
  'intent', 'problem.faultDomain', 'problem.journey', 'problem.scope', 'problem.relation', 'safety.hazard', 'safety.unsafeAction',
  'observations', 'checks', 'reply.toPending', 'reply.correction', 'reply.outcome', 'mentions.replacedParts', 'mentions.customerTheories'];
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const norm = (v) => JSON.stringify(v === undefined ? null : v);

/** Per-field comparison; `accept` lists documented alternative mc/1 values per fixture field (live only). */
function fieldDiff(expected, actual, accept = {}) {
  const altFor = (field) => {
    const short = { 'identity.appliance': 'appliance', 'identity.make': 'make', 'identity.model': 'model', 'identity.modelStatus': 'modelStatus',
      'identity.fuel': 'fuel', 'identity.displayedCode': 'code', 'problem.faultDomain': 'faultDomain', 'problem.journey': 'journey',
      'problem.scope': 'symptomScope', 'problem.relation': 'relation', 'safety.hazard': 'hazard', 'safety.unsafeAction': 'unsafeAction',
      'reply.toPending': 'toPending', 'reply.correction': 'correction', 'reply.outcome': 'outcome', 'mentions.replacedParts': 'replaced',
      'mentions.customerTheories': 'theories' }[field] || field;
    return accept[short] || [];
  };
  return FIELDS.map((f) => {
    const ev = get(expected, f); const av = get(actual, f);
    let ok = norm(ev) === norm(av);
    if (!ok) {
      for (const alt of altFor(f)) {
        let altVal = alt;
        if (f === 'observations') altVal = expectedMc1({ observations: alt }).observations;
        else if (f === 'checks') altVal = expectedMc1({ checks: alt }).checks;
        else if (f === 'identity.appliance') altVal = alt === null ? { value: null, basis: null } : expectedMc1({ appliance: alt }).identity.appliance;
        else if (f === 'identity.make' || f === 'identity.model') altVal = alt === null ? { value: null, basis: null } : { value: alt, basis: 'stated' };
        if (norm(altVal) === norm(av)) { ok = 'accepted'; break; }
      }
    }
    return { field: f, expected: ev, actual: av, ok };
  });
}

module.exports = { CSID, stateFromCtx, expectedMc1, oracleAnswers, fieldDiff, FIELDS };
