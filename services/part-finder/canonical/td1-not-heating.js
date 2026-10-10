'use strict';
/**
 * Tumble dryer journey 1 — not heating (rules DH1–DH22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §TD1. Also owns a not-drying report with no heat at all (td-family).
 * Dryer technology is kept (vented / condenser / heat pump / unknown) and asked once when it matters:
 *   programme (cool-air / low-heat) → lint filter → condenser (condenser / heat pump) or vent hose (vented) — blocked airflow
 *   trips the thermal cut-out, so heat comes back after clearing it → restarts after cooling (thermal) →
 *   heat pump: runs cooler by design / heat-pump system (engineer; NEVER a conventional heater) →
 *   conventional: heater / thermal cut-out / thermostat (engineer; a heater part only with a heater code, airflow cleared,
 *   a confirmed model whose part list has a heater and the dryer not a heat pump).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./td-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'td-not-heating';
const FAMILY = { PG: 'programme-setting', AF: 'airflow-thermal-cut-out', HN: 'heat-pump-runs-cooler', HS: 'heat-pump-system', HE: 'heater-or-thermal-cut-out' };
const SIGNALS = {
  PG: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, progOk: SA },
  AF: { filterFixed: SS, condFixed: SS, ventFixed: SS, restoredAfterFilterFix: SS, restoredAfterCondFix: SS, restoredAfterVentFix: SS, restarts: S,
    failsAfterFilterFix: A, failsAfterCondFix: A, failsAfterVentFix: A, filterOk: A },
  HN: { heatPump: S, warm: SS, cold: SA },
  HS: { heatPump: S, cold: S, filterOk: S, condOk: S, progOk: S, warm: SA, restoredAfterProgFix: SA, restoredAfterFilterFix: SA, restoredAfterCondFix: SA },
  HE: { heaterCode: SS, codeHeater: S, cold: S, filterOk: S, condOk: S, ventOk: S, progOk: S, failsAfterFilterFix: S, failsAfterCondFix: S, failsAfterVentFix: S, warm: SA, restoredAfterProgFix: SA, restoredAfterFilterFix: SA, restoredAfterCondFix: SA, restoredAfterVentFix: SA },
};
const FACT_LABEL = {
  cold: 'no heat / cold air', warm: 'gets warm', vented: 'vented dryer', condenser: 'condenser dryer', heatPump: 'heat-pump dryer', restarts: 'restarts after cooling',
  progFixed: 'cool / low-heat programme was set (changed)', progOk: 'normal heat programme', filterFixed: 'lint filter blocked (cleaned)', filterOk: 'lint filter clean',
  condFixed: 'condenser clogged (cleaned)', condOk: 'condenser clean', ventFixed: 'vent hose kinked / blocked (cleared)', ventOk: 'vent hose clear',
  codeHeater: 'heating error code', heaterCode: 'heating code with airflow cleared',
};
const SPEC = {
  schema: 'td1-diag/1', FAMILY, PRIOR: ['PG', 'AF', 'HN', 'HS', 'HE'], SIGNALS, FACT_LABEL,
  obs: { restarts: ['restartsAfterCooling', true] },
  checks: { 'programme-setting': { clear: 'progOk', found: 'progFixed' }, 'lint-filter': { clear: 'filterOk', found: 'filterFixed' },
    condenser: { clear: 'condOk', found: 'condFixed' }, 'vent-duct': { clear: 'ventOk', found: 'ventFixed' } },
  FIX_CHECK: { PG: ['programme-setting', 'Prog'], AF: ['lint-filter', 'Filter'], AFc: ['condenser', 'Cond'], AFv: ['vent-duct', 'Vent'] },
  DECISIVE_PART: { HE: { heaterCode: 'heater' } },
  architecture: (s, ctx) => F.tdArchitecture(s, ctx),
  extra(s, ctx, on) {
    F.archFacts(on, ctx.architecture);
    const p = kit.problemOf(s); const j = p && p.journey ? p.journey.value : null;
    const hs = F.heatState(s);
    on('cold', hs === 'cold' || (hs == null && j === 'no-heat')); on('warm', hs === 'warm');
    on('codeHeater', ctx.codeFault === 'not-heating');
    const airflowOk = engine.checkResult(s, 'lint-filter') === 'clear' && ['condenser', 'vent-duct'].some((c) => engine.checkResult(s, c) === 'clear');
    on('heaterCode', ctx.codeFault === 'not-heating' && airflowOk && ctx.architecture.type !== 'heat-pump');
  },
  eligible: (k, has) => (['HN', 'HS'].includes(k) ? has('heatPump') : k === 'HE' ? !has('heatPump') : true),
  partBlockers: (has, { architecture }) => (architecture && architecture.type === 'heat-pump' ? ['heat-pump-has-no-conventional-heater'] : []),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.tdCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const archKnown = (h) => h.has('vented') || h.has('condenser') || h.has('heatPump');
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'DH', appliance: 'tumble-dryer', journeys: ['no-heat'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['programme-setting', 'lint-filter', 'condenser', 'vent-duct'],
  OBS_TARGETS: { heatState: ['noHeat', 'heatPresent'], dryerType: ['dryerVented', 'dryerCondenser', 'dryerHeatPump'], restartsAfterCooling: ['restartsAfterCooling'] },
  REQUIRES: { heatState: [], dryerType: [], 'programme-setting': [], 'lint-filter': ['td_unplug_cool'], condenser: ['td_unplug_cool'], 'vent-duct': ['td_unplug_cool'],
    restartsAfterCooling: [], retest: ['stop_if_trips_or_burning'] },
  FIX_CHECKS: ['programme-setting', 'lint-filter', 'condenser', 'vent-duct'],
  // a heat-pump dryer that is warm (not hot) is working as designed: said once, no part
  early(h) { return h.has('heatPump') && h.has('warm') && !h.has('cold') ? { target: 'heat-pump-runs-cooler', reason: 'heat-pump-runs-cooler', rule: 'DH5', handoff: 'none' } : null; },
  steps: [
    { n: 10, target: 'heatState', reason: 'cold-or-warm', when: (h) => !h.has('cold') && !h.has('warm') },
    { n: 11, target: 'dryerType', reason: 'technology-decides-path', when: (h) => !archKnown(h) },
    { n: 12, target: 'programme-setting', reason: 'cool-air-or-low-heat-programme', when: () => true },
    { n: 13, target: 'lint-filter', reason: 'blocked-airflow-trips-cut-out', when: () => true },
    { n: 14, target: 'condenser', reason: 'condenser-airflow', when: (h) => h.has('condenser') || h.has('heatPump') },
    { n: 15, target: 'vent-duct', reason: 'vent-airflow', when: (h) => h.has('vented') },
    { n: 16, target: 'restartsAfterCooling', reason: 'thermal-cut-out-pattern', when: (h) => h.has('cold') && !h.has('heatPump') },
  ],
  PART_FAMILIES: new Set(['HE']),
  HANDOFF: { PG: 'none', AF: 'none', HN: 'none', HS: 'engineer', HE: 'engineer' },
  // K7: never a conventional heater for a heat-pump dryer, or when the technology is unknown
  partExtra: (s, d) => (d.architecture && d.architecture.type !== 'heat-pump' && d.architecture.type !== 'unknown' ? [] : ['K7-heat-pump-or-unknown-technology']),
});
// AF is fixed by any of three owner checks: the engine's FIX_CHECK labels map them to AF facts.
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'td1/1', codeFaultFor: F.tdCodeFault,
  PART_MATCH: { heater: { re: /\bheater\b|heating\s+element|\belement\b/i, not: /stat|thermostat|toc|cut\s*-?out|sensor|ntc|probe|washer|washing|dishwasher|oven|cooker/i } },
  MEDIA_BY_KEY: { 'lint-filter': { knowledgeId: 'tumble-dryer:filter-blocked', ids: ['td-lint-filter'], concepts: [] },
    condenser: { knowledgeId: 'tumble-dryer:not-emptying-condensate', ids: ['td-condenser'], concepts: [] } },
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'programme-setting': 'a cool-air or low-heat programme', 'airflow-thermal-cut-out': 'blocked airflow tripping the overheat cut-out',
  'heat-pump-runs-cooler': 'normal heat-pump drying (it runs cooler)', 'heat-pump-system': 'the heat-pump system', 'heater-or-thermal-cut-out': 'the heater, its thermal cut-out or thermostat' };
const COMPONENT_LABEL = { heater: 'heater element' };
const TASK = {
  'ask_observation:heatState': { say: 'First, whether any heat comes through at all.', ask: 'Partway through a drying programme, is the air and the laundry warm, or completely cold?' },
  'ask_observation:dryerType': { say: 'The type of dryer changes what to check.', ask: 'Is it a vented dryer (a hose out of the back), a condenser dryer with a water container, or a heat-pump dryer?' },
  'ask_check:programme-setting': { say: 'Some programmes (cool air, refresh, delicates or a low-heat option) dry with little or no heat.', ask: 'Was a cool-air or low-heat programme set (and have you changed it), or was it a normal heat programme?' },
  'ask_check:lint-filter': { say: 'A blocked lint filter stops the airflow, and many dryers then cut the heat to stop overheating. Clean the fluff filter in the door opening (heat-pump models often have a second one at the bottom too).', ask: 'Was it full of fluff (and is it clean now), or was it already clean?' },
  'ask_check:condenser': { say: 'Behind the flap at the bottom front there\'s a condenser unit (or a second filter on heat-pump models). Take it out and rinse the fluff off under the tap, then let it drip-dry and refit it.', ask: 'Was it clogged with fluff (and is it clean now), or was it already clean?' },
  'ask_check:vent-duct': { say: 'Check the vent hose out of the back: it should be short, without kinks or squashed sections, and clear of fluff all the way to the outside vent.', ask: 'Was it kinked, squashed or blocked (and is it sorted), or was it already clear?' },
  'ask_observation:restartsAfterCooling': { say: 'One more thing that helps pin it down.', ask: 'If you leave it to cool down for a while, does it heat or run again for a bit, or never?' },
  'ask_check:retest': { say: 'Run a normal heat programme again for 10–15 minutes.', ask: 'Is it heating now, or still cold?' },
  'ask_identity:model': { say: 'To match the right part for your dryer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate inside the door rim or on the back — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a tumble dryer or a washer-dryer?' },
};
const CONCLUSION = {
  'DH7:programme-setting': 'That was the programme, so no part is needed.',
  'DH7:airflow-thermal-cut-out': 'Clearing the airflow very likely fixed it — blocked fluff makes the dryer cut its heat to stop overheating. No part is needed; clean the filter after every load.',
  'heat-pump-runs-cooler': 'Heat-pump dryers dry at a much lower temperature than older dryers, so the air feels warm rather than hot and programmes take longer. That\'s normal — no part is needed (and a heat-pump dryer has no conventional heater to replace).',
  'heat-pump-system': 'With the filters and the heat exchanger clean but no warmth at all, the heat-pump system itself is the likely area. That needs an appliance engineer — a heat-pump dryer has no conventional heater, and I\'m not recommending a part from this.',
  'heater-or-thermal-cut-out': 'With the programme right and the airflow clear but still no heat, the heater, its thermal cut-out or the thermostat is the likely area. These need testing by an appliance engineer (a cut-out that has tripped usually did so for a reason) — I\'m not recommending a part from this.',
  'airflow-thermal-cut-out': 'Blocked airflow making the dryer cut its heat is the likely cause. Keep the filters and hose clear; if it still won\'t heat after that, an appliance engineer should check the cut-out — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it heating normally now?',
  OBS_COPY: { noHeat: ['no heat', 'gets warm'], heatPresent: ['gets warm', null], dryerVented: ['a vented-type dryer', null], dryerCondenser: ['a condenser-type dryer', null], dryerHeatPump: ['a heat-pump-type dryer', null],
    restartsAfterCooling: ['restarts after cooling', 'never restarts'], faultPersists: ['still cold', 'heating now'] },
  CHECK_RESULT_COPY: {
    'programme-setting': { clear: 'normal heat programme', found_and_cleared: 'programme changed' }, 'lint-filter': { clear: 'lint filter clean', found_and_cleared: 'lint filter cleaned' },
    condenser: { clear: 'condenser clean', found_and_cleared: 'condenser cleaned' }, 'vent-duct': { clear: 'vent hose clear', found_and_cleared: 'vent hose cleared' },
  },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the dryer and let it cool before fitting it — the heater sits inside, so if you\'re not confident an appliance engineer can fit and test it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(heater|heating element|element|thermostat|cut-out|toc|thermal fuse|sensor|heat pump|compressor|pcb|control board|motor)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
