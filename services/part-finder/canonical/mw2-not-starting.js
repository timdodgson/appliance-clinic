'use strict';
/**
 * Microwave journey 2 — not starting (rules MS1–MS22). PURE, deterministic. No parts.
 * Design: docs/diagnostics/final-migration-evidence.md §MW2. Dead (no display) → socket / plug fuse (look only; never the
 * internal fuse — it sits in the HV area) → internal fuse / thermal cut-out / control (engineer) · display on → control /
 * child lock → clock / programme not set → control (engineer). Door not recognised → mw-door (mw-family).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./mw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'mw-not-starting';
const FAMILY = { PW: 'supply-or-plug-fuse', MP: 'internal-fuse-cut-out-or-control', LK: 'control-or-child-lock', CS: 'clock-or-programme-not-set', CT: 'control' };
const SIGNALS = {
  PW: { dead: SS, powerFixed: SS, restoredAfterPowerFix: SS, failsAfterPowerFix: SA, socketOk: A, powered: SA },
  MP: { dead: S, socketOk: SS, powered: SA, powerFixed: A },
  LK: { lockOff: SS, restoredAfterLockFix: SS, failsAfterLockFix: SA, powered: S, lockOk: SA, dead: SA },
  CS: { progFixed: SS, restoredAfterProgFix: SS, failsAfterProgFix: SA, powered: S, progOk: SA, dead: SA },
  CT: { powered: S, lockOk: S, progOk: S, recognised: S, dead: SA, restoredAfterLockFix: SA, restoredAfterProgFix: SA },
};
const FACT_LABEL = { dead: 'display dead', powered: 'display / light on', socketOk: 'socket and plug fuse fine', powerFixed: 'socket / plug was off (sorted)', lockOff: 'control lock was on (off now)',
  lockOk: 'no lock on', progFixed: 'clock / programme not set (sorted)', progOk: 'clock and programme set', recognised: 'door recognised as shut' };
const SPEC = {
  schema: 'mw2-diag/1', FAMILY, PRIOR: ['PW', 'MP', 'LK', 'CS', 'CT'], SIGNALS, FACT_LABEL,
  obs: { dead: ['noPower', true], powered: ['noPower', false], recognised: ['doorRecognised', true] },
  checks: { 'power-supply': { clear: 'socketOk', found: 'powerFixed' }, 'child-lock': { clear: 'lockOk', found: 'lockOff' }, 'programme-setting': { clear: 'progOk', found: 'progFixed' } },
  FIX_CHECK: { PW: ['power-supply', 'Power'], LK: ['child-lock', 'Lock'], CS: ['programme-setting', 'Prog'] },
  DECISIVE_PART: {},
  eligible: (k, has) => (k === 'PW' || k === 'MP' ? has('dead') || has('powerFixed') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.mwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'MS', appliance: 'microwave', journeys: ['wont-start', 'controls-unresponsive', 'trips-electrics'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['power-supply', 'child-lock', 'programme-setting'],
  OBS_TARGETS: { noPower: ['noPower'], doorRecognised: ['doorRecognised'] },
  REQUIRES: { noPower: [], 'power-supply': ['no_live_electrical_checks'], 'child-lock': [], 'programme-setting': [], doorRecognised: [], retest: [] },
  FIX_CHECKS: ['power-supply', 'child-lock', 'programme-setting'],
  steps: [
    { n: 10, target: 'noPower', reason: 'display-dead-or-on', when: (h) => !h.has('dead') && !h.has('powered') },
    { n: 11, target: 'power-supply', reason: 'socket-plug-fuse', when: (h) => h.has('dead') },
    { n: 12, target: 'doorRecognised', reason: 'door-recognised', when: (h) => h.has('powered') && h.obs('doorRecognised') == null },
    { n: 13, target: 'child-lock', reason: 'control-lock', when: (h) => h.has('powered') },
    { n: 14, target: 'programme-setting', reason: 'clock-programme-set', when: (h) => h.has('powered') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { PW: 'none', MP: 'engineer', LK: 'none', CS: 'none', CT: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'mw2/1', codeFaultFor: F.mwCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'supply-or-plug-fuse': 'the socket or plug fuse', 'internal-fuse-cut-out-or-control': 'the internal fuse, a thermal cut-out or the control', 'control-or-child-lock': 'the control / child lock',
  'clock-or-programme-not-set': 'the clock or programme not being set', control: 'the control' };
const TASK = {
  'ask_observation:noPower': { say: 'First, whether it has any power.', ask: 'Does the display or clock show anything at all, or is it completely blank?' },
  'ask_check:power-supply': { say: 'Check the plug is in and the socket switched on, and try another appliance in that socket. Don\'t open the microwave to look for a fuse.', ask: 'Was the socket or plug the problem (and is it sorted), or does the socket work fine with something else?' },
  'ask_observation:doorRecognised': { say: 'Next, whether it knows the door is shut.', ask: 'With the door shut, does it show "door" or refuse to start as if the door were open?' },
  'ask_check:child-lock': { say: 'Many microwaves have a control / child lock (often a key or lock symbol, or holding Stop for a few seconds) that stops the buttons working.', ask: 'Was the control lock on (and is it off now), or was it already off?' },
  'ask_check:programme-setting': { say: 'Some models won\'t start until the clock is set, and need a time entered before Start.', ask: 'Was the clock or programme not set (and is it sorted), or was it all set?' },
  'ask_check:retest': { say: 'Put a cup of water in and try a minute on full power.', ask: 'Does it start now, or still not?' },
  'ask_identity:appliance': F.MW_APPLIANCE_ASK,
};
const CONCLUSION = {
  'MS7:supply-or-plug-fuse': 'That was the supply, so no part is needed.', 'MS7:control-or-child-lock': 'The control lock was on, so no part is needed.',
  'MS7:clock-or-programme-not-set': 'That was the clock / programme, so no part is needed.',
  'internal-fuse-cut-out-or-control': `With the socket working but the display dead, the internal fuse, a thermal cut-out or the control has gone — and a blown internal fuse usually means another fault. ${F.HV} An appliance engineer is the next step; I'm not recommending a part from this.`,
  control: `It has power and nothing is locked, so the control (or the door switch side) is the likely area. ${F.HV} An appliance engineer is the next step; I'm not recommending a part from this.`,
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it working now?',
  OBS_COPY: { noPower: ['display blank', 'display on'], doorRecognised: ['door recognised', 'acts as if door open'], faultPersists: ['still won\'t start', 'starts now'] },
  CHECK_RESULT_COPY: { 'power-supply': { clear: 'socket fine', found_and_cleared: 'socket / plug sorted' }, 'child-lock': { clear: 'no lock', found_and_cleared: 'lock off now' },
    'programme-setting': { clear: 'clock / programme set', found_and_cleared: 'clock / programme sorted' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(fuse|thermal|cut.?out|door switch|interlock|pcb|control board|transformer|magnetron)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
