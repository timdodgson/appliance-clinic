'use strict';
/**
 * Hob journey 2 — no power (rules HP1–HP22). PURE, deterministic. No parts.
 * Design: docs/diagnostics/final-migration-evidence.md §HOB2. Whole hob dead (no lights) → isolator / breaker (look only)
 * → mains connection / power side (engineer) · lights on but nothing responds → key / child lock → control (engineer) ·
 * a trip is the sticky safety stop. No live electrical discrimination.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./hob-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'hob-no-power';
const FAMILY = { PW: 'supply-or-isolator', MP: 'mains-connection-or-power-side', LK: 'key-or-child-lock', CT: 'touch-control' };
const SIGNALS = {
  PW: { dead: SS, powerFixed: SS, restoredAfterPowerFix: SS, failsAfterPowerFix: SA, socketOk: A, powered: SA },
  MP: { dead: S, socketOk: SS, powered: SA, powerFixed: A },
  LK: { lockOff: SS, restoredAfterLockFix: SS, failsAfterLockFix: SA, powered: S, lockOk: SA, dead: SA },
  CT: { powered: S, lockOk: S, dead: SA, restoredAfterLockFix: SA },
};
const FACT_LABEL = { dead: 'no lights at all', powered: 'lights / display come on', socketOk: 'isolator and breaker on', powerFixed: 'isolator / breaker was off (sorted)', lockOff: 'lock was on (off now)', lockOk: 'no lock on' };
const SPEC = {
  schema: 'hb2-diag/1', FAMILY, PRIOR: ['PW', 'MP', 'LK', 'CT'], SIGNALS, FACT_LABEL,
  obs: { dead: ['noPower', true], powered: ['noPower', false] },
  checks: { 'power-supply': { clear: 'socketOk', found: 'powerFixed' }, 'child-lock': { clear: 'lockOk', found: 'lockOff' } },
  FIX_CHECK: { PW: ['power-supply', 'Power'], LK: ['child-lock', 'Lock'] },
  DECISIVE_PART: {},
  eligible: (k, has) => (k === 'PW' || k === 'MP' ? has('dead') || has('powerFixed') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.hobCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'HP', appliance: 'hob', journeys: ['wont-start', 'controls-unresponsive', 'trips-electrics'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['power-supply', 'child-lock'],
  OBS_TARGETS: { noPower: ['noPower'] },
  REQUIRES: { noPower: [], 'power-supply': ['no_live_electrical_checks'], 'child-lock': [], retest: [] },
  FIX_CHECKS: ['power-supply', 'child-lock'],
  steps: [
    { n: 10, target: 'noPower', reason: 'lights-or-dead', when: (h) => !h.has('dead') && !h.has('powered') },
    { n: 11, target: 'power-supply', reason: 'isolator-breaker', when: (h) => h.has('dead') },
    { n: 12, target: 'child-lock', reason: 'key-lock', when: (h) => h.has('powered') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { PW: 'none', MP: 'engineer', LK: 'none', CT: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'hb2/1', codeFaultFor: F.hobCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'supply-or-isolator': 'the supply (isolator switch or breaker)', 'mains-connection-or-power-side': 'the hob\'s mains connection or power side', 'key-or-child-lock': 'the key / child lock', 'touch-control': 'the touch control' };
const TASK = {
  'ask_observation:noPower': { say: 'First, whether it has any power.', ask: 'When you touch the on button, do any lights or the display come on, or is it completely dead?' },
  'ask_check:power-supply': { say: 'Check the hob\'s isolator switch (often a large switch on the wall or in a cupboard) is on, and look at the fuse box for a breaker that has switched off. If a breaker keeps tripping, don\'t keep resetting it.', ask: 'Was the isolator or a breaker off (and is it sorted), or were they all on?' },
  'ask_check:child-lock': { say: 'Most touch-control hobs have a key / child lock (often a key or padlock symbol) — usually you hold that symbol for a few seconds to unlock it.', ask: 'Was the lock on (and is it off now), or was there no lock on?' },
  'ask_check:retest': { say: 'Now try switching a zone on.', ask: 'Is it working now, or still not?' },
  'ask_identity:appliance': F.HOB_APPLIANCE_ASK,
};
const CONCLUSION = {
  'HP7:supply-or-isolator': 'That was the supply, so no part is needed.', 'HP7:key-or-child-lock': 'That was the lock, so no part is needed.',
  'mains-connection-or-power-side': 'With the isolator and breaker on but no lights at all, the fault is in the hob\'s mains connection or power side. Please don\'t take it out or test it live — an appliance engineer (or electrician for the supply) is the next step. I\'m not recommending a part from this.',
  'touch-control': 'It has power and nothing is locked, so the touch control is the likely area. That needs an appliance engineer — I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the hob working now?',
  OBS_COPY: { noPower: ['no lights at all', 'lights come on'], faultPersists: ['still not working', 'working now'] },
  CHECK_RESULT_COPY: { 'power-supply': { clear: 'isolator and breaker on', found_and_cleared: 'isolator / breaker sorted' }, 'child-lock': { clear: 'no lock', found_and_cleared: 'lock off now' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL: {}, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(module|power board|board|touch control|pcb|control|fuse)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL: {}, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
