'use strict';
/**
 * Test helpers for the batch-2 washing-machine journeys: replay typed mc/1 turns through the REAL merge + journey
 * pipeline (control mode, requests issued), and the shared COMPOSE contract checks applied to every NextAction seen.
 */
const { emptyState } = require('../../canonical/cs1.js');
const { merge } = require('../../canonical/merge.js');
const mc1 = require('../../canonical/mc1.js');
const EC = require('../../faults-catalogue.json').errorCodes;

const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const O = (k, v = true) => ({ key: k, value: v });
const K = (c, st = 'done', r = null) => ({ check: c, status: st, result: r });
const WMI = { appliance: { value: 'washing-machine', basis: 'stated' } };
const opener = (journey, faultDomain, obs = [], extra = {}, identity = {}) =>
  C({ identity: { ...WMI, ...identity }, intent: 'report_fault', problem: { journey, faultDomain, ...extra }, observations: obs });
const model = (m = 'NSWM1043CW', make = 'hotpoint') => C({ identity: { model: { value: m, basis: 'stated' }, make: { value: make, basis: 'stated' } } });
const noModel = () => C({ identity: { modelStatus: 'unavailable' }, reply: { toPending: 'cannot_answer' } });

/** Replay turns; returns {state, rules ['F11:supplyOk', ...], actions, last, prep}. */
function play(J, turns, { modelParts = null } = {}) {
  let s = emptyState('cs_b2test');
  const rules = []; const actions = []; let prep = null; let last = null;
  for (const c of turns) {
    s = merge(s, c, { turn: s.version + 1 }).state;
    prep = J.prepare(s, { errorCodes: EC, modelParts: J.modelNeed && J.modelNeed(s) ? modelParts : null });
    const out = J.decide(s, prep, { partLookup: prep.partLookup, control: true, turn: s.version });
    s = out.state; last = out.nextAction;
    rules.push(`${last.rule}:${last.target}`); actions.push({ state: s, action: last, prep });
  }
  return { state: s, rules, actions, last, prep };
}

const UNSAFE = /multimeter|test the (heater|element|motor|voltage|valve|resistance)|continuity|(?<!never try to force or |never |don't |do not |never try to )bypass|while (it'?s )?plugged in and|remove the (back|top|rear) panel|lever .* lock|prise .* door/i;
/** Shared COMPOSE contract over every action reached. Returns a list of problems (empty = pass). */
function composeProblems(JC, P, seen) {
  const out = [];
  for (const { state, action: a } of seen) {
    const b = JC.brief(state, a, null, {});
    const t = JC.template(b);
    const where = `${a.rule}:${a.kind}:${a.target}`;
    if (t.length < 20) out.push(`${where} empty template`);
    if ((t.match(/\?/g) || []).length > 1) out.push(`${where} >1 question`);
    if (a.kind !== 'recommend_part' && /\b(buy|order|purchase|£\s?\d)\b/i.test(t)) out.push(`${where} purchase language`);
    if (/^ask_/.test(a.kind) && !b.task) out.push(`${where} no TASK copy`);
    if (/^ask_/.test(a.kind) && (t.match(/\?/g) || []).length !== 1) out.push(`${where} ask without exactly one question`);
    for (const tok of a.requires || []) if (!JC.REQUIREMENT[tok]) out.push(`${where} unknown requirement ${tok}`);
    // Ask templates carry each requirement's fixed copy; a fixed safety-stop copy must satisfy each marker.
    for (const s of b.safety) {
      // a template says each requirement once: its fixed copy, or the step's own words carrying the same marker checkReply uses
      const ok = JC.REQUIREMENT[s.token].marker.test(t.replace(/[\u2018\u2019]/g, "'"));
      if (!ok) out.push(`${where} safety ${s.token} missing from template`);
    }
    if (a.kind === 'safety_stop' && t !== JC.SAFETY_COPY[a.target]) out.push(`${where} safety copy not fixed`);
    if (UNSAFE.test(t.replace(/[\u2018\u2019]/g, "'"))) out.push(`${where} unsafe instruction`);
    const msgs = JC.prompt(b);
    if (msgs.map((m) => m.role).join(',') !== 'system,user') out.push(`${where} prompt shape`);
  }
  return out;
}

const DWI = { appliance: { value: 'dishwasher', basis: 'stated' } };
const dwOpener = (journey, faultDomain, obs = [], extra = {}, identity = {}) => opener(journey, faultDomain, obs, extra, { ...DWI, ...identity });
/** Routing helper: run the REAL part-finder canonicalJourneys over typed turns with a given allow-list. */
function routeWith(L, turns, journeys, deps = {}) {
  let s = emptyState('cs_' + 'e'.repeat(32));
  for (const c of turns) s = merge(s, c, { turn: s.version + 1 }).state;
  const t = { schema: 'cs/1', mode: 'control', sessionId: s.sessionId, priorVersion: s.version - 1, version: s.version, state: s, classification: turns[turns.length - 1], rulesFired: [], requestOutcome: null, degraded: null };
  return L.canonicalJourneys(t, { schema: 'cs/1', mode: 'control', control: { journeys }, sessionId: 'x', version: 0, state: null, degraded: null }, deps);
}

const FFI = { appliance: { value: 'fridge-freezer', basis: 'stated' } };
const TDI = { appliance: { value: 'tumble-dryer', basis: 'stated' } };
const ffOpener = (journey, faultDomain, obs = [], extra = {}, identity = {}) => opener(journey, faultDomain, obs, extra, { ...FFI, ...identity });
const tdOpener = (journey, faultDomain, obs = [], extra = {}, identity = {}) => opener(journey, faultDomain, obs, extra, { ...TDI, ...identity });
/** The canonical key that applies for these typed turns (null = none: legacy). */
async function ownerOf(L, turns, journeys) { const r = await routeWith(L, turns, journeys); return r.journey && r.journey.applies ? r.journey.key : null; }

module.exports = { C, O, K, WMI, DWI, FFI, TDI, opener, dwOpener, ffOpener, tdOpener, model, noModel, play, composeProblems, routeWith, ownerOf, EC };
