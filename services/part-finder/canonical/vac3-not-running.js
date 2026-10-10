'use strict';
/**
 * Vacuum journey 3 — won't run / dead (rules VN1–VN22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §VAC3. The type decides the supply checks:
 *   corded → socket / plug fuse / cable (a damaged cable or plug = stop use, early VN5) · cordless / robot → charger, socket,
 *   charging light and contacts → for all: a blockage that tripped the thermal cut-out (cool for an hour, clear it) →
 *   all fine but still dead → switch, cable, battery or motor inside (repairer; no part, no live testing).
 * A cordless that won't charge is vacuum-battery-runtime's (ownership); no battery / charger part is recommended here.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./vac-family.js');
const ck = require('./compose-kit.js');
const { SS, S, SA } = engine;

const KEY = 'vacuum-not-running';
const FAMILY = { PS: 'mains-supply-or-fuse', CH: 'charger-or-dock', TC: 'thermal-cut-out-after-blockage', BT: 'battery-or-charger-fault', IN: 'switch-cable-or-motor' };
const RESTORED = { restoredAfterPsFix: SA, restoredAfterChFix: SA, restoredAfterBlockFix: SA };
const SIGNALS = {
  PS: { psFixed: SS, restoredAfterPsFix: SS, failsAfterPsFix: SA, psOk: SA, corded: S, cordless: SA, robot: SA },
  CH: { chFixed: SS, restoredAfterChFix: SS, failsAfterChFix: SA, chOk: SA, corded: SA },
  TC: { blockFixed: SS, blockStuck: S, cutOut: S, restoredAfterBlockFix: SS, failsAfterBlockFix: SA, blockOk: SA },
  BT: { chFault: SS, cordless: S, robot: S, corded: SA, ...RESTORED },
  IN: { psOk: S, chOk: S, blockOk: S, failsAfterPsFix: S, failsAfterChFix: S, failsAfterBlockFix: S, chFault: SA, ...RESTORED },
};
const FACT_LABEL = {
  psFixed: 'socket / plug fuse / switch was the problem (sorted)', psOk: 'socket and plug fine', cableDamaged: 'cable or plug damaged',
  chFixed: 'charger / socket / contacts were the problem (sorted)', chFault: 'charging light never comes on / charger damaged', chOk: 'charger fine, charging light on',
  blockFixed: 'blockage found (cleared)', blockStuck: 'blockage that will not clear', blockOk: 'no blockage', cutOut: 'stopped during use and won\'t restart',
  cordless: 'cordless', corded: 'corded', robot: 'robot',
};
const SPEC = {
  schema: 'vac3-diag/1', FAMILY, PRIOR: ['PS', 'CH', 'TC', 'BT', 'IN'], SIGNALS, FACT_LABEL,
  obs: { cutOut: ['cutsOut', true] },
  checks: { 'power-supply': { clear: 'psOk', found: 'psFixed', fault: 'cableDamaged' },
    'vacuum-charger-check': { clear: 'chOk', found: 'chFixed', fault: 'chFault' },
    'vacuum-blockage': { clear: 'blockOk', cleared: 'blockFixed', notCleared: 'blockStuck' } },
  FIX_CHECK: { PS: ['power-supply', 'Ps'], CH: ['vacuum-charger-check', 'Ch'], TC: ['vacuum-blockage', 'Block'] },
  DECISIVE_PART: {},
  extra(s, ctx, on) { F.typeFacts(on, F.vacType(s)); },
  eligible: (k, has) => (k === 'PS' ? !has('cordless') && !has('robot') : (k === 'CH' || k === 'BT') ? !has('corded') : true),
};
function diagnose(state, ctx = {}) { return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault: null }); }
const typeOf = (h) => F.vacType(h.s).type;
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'VN', appliance: 'vacuum', journeys: ['wont-start', 'trips-electrics'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['power-supply', 'vacuum-charger-check', 'vacuum-blockage'],
  OBS_TARGETS: { vacType: ['vacuumCordless', 'vacuumCorded', 'vacuumRobot'] },
  REQUIRES: { vacType: [], 'power-supply': [], 'vacuum-charger-check': [], 'vacuum-blockage': ['vac_power_off'], retest: [] },
  FIX_CHECKS: ['power-supply', 'vacuum-charger-check', 'vacuum-blockage'],
  fixResults: { 'vacuum-blockage': ['found_and_cleared'], 'power-supply': ['found_and_cleared'], 'vacuum-charger-check': ['found_and_cleared'] },
  // a damaged mains cable / plug: stop using it — no further diagnosis, no taping it up
  early(h) { return h.has('cableDamaged') ? { target: 'damaged-cable-stop-use', reason: 'damaged-mains-cable', rule: 'VN5', handoff: 'engineer' } : null; },
  steps: [
    { n: 10, target: 'vacType', reason: 'type-decides-supply-checks', when: (h) => typeOf(h) === 'unknown' },
    { n: 11, target: 'power-supply', reason: 'socket-fuse-cable', when: (h) => typeOf(h) === 'corded' },
    { n: 12, target: 'vacuum-charger-check', reason: 'charger-and-contacts', when: (h) => ['cordless', 'robot'].includes(typeOf(h)) },
    { n: 13, target: 'vacuum-blockage', reason: 'thermal-cut-out-after-blockage', when: (h) => !h.has('chFault') },
  ],
  PART_FAMILIES: new Set(),
  HANDOFF: { PS: 'none', CH: 'none', TC: 'none', BT: 'engineer', IN: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({ D: { diagnose }, P, schema: 'vac3/1', codeFaultFor: F.vacCodeFault, PART_MATCH: {}, MEDIA_BY_KEY: {} });

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'mains-supply-or-fuse': 'the socket or plug fuse', 'charger-or-dock': 'the charger, socket or charging contacts', 'thermal-cut-out-after-blockage': 'the thermal cut-out after a blockage',
  'battery-or-charger-fault': 'the battery or charger', 'switch-cable-or-motor': 'the switch, cable or motor inside', 'damaged-cable-stop-use': 'a damaged mains cable or plug' };
const COMPONENT_LABEL = {};
const TASK = {
  'ask_observation:vacType': { say: 'The type changes what to check.', ask: 'Is it a corded vacuum (plugs into the wall), a cordless (battery) one, or a robot?' },
  'ask_check:power-supply': { say: 'Try the socket with something else, and check the switch on the vacuum. If the plug has a fuse (UK plugs do), a 13A fuse can be swapped — unplugged. Look along the cable for cuts or damage too.', ask: 'Was it the socket, switch or fuse (and is it sorted), is the cable or plug damaged, or is the supply fine?' },
  'ask_check:vacuum-charger-check': { say: 'Check the charger is plugged into a working socket and fully into the vacuum (or the robot is seated on its dock), and wipe the charging contacts clean and dry.', ask: 'Was the charger, socket or contacts the problem (and is it sorted), does the charging light never come on, or is the charger fine with the light on?' },
  'ask_check:vacuum-blockage': { say: 'If it stopped while you were using it, it may have overheated from a blockage. Leave it switched off to cool for an hour, and check the hose, wand, floorhead and filters for a blockage.', ask: 'Did you find a blockage and clear it, is there one you can\'t shift, or was it all clear?' },
  'ask_check:retest': { say: 'Try switching it on again.', ask: 'Does it run now, or is it still dead?' },
  'ask_identity:model': F.VAC_MODEL_ASK, 'ask_identity:appliance': F.VAC_APPLIANCE_ASK,
};
const CONCLUSION = {
  'VN7:mains-supply-or-fuse': 'That was the supply, so no part is needed.',
  'VN7:charger-or-dock': 'That was the charging connection, so no part is needed.',
  'VN7:thermal-cut-out-after-blockage': 'It had cut out to protect itself after a blockage, so no part is needed. Keep the filters clean to stop it happening again.',
  'damaged-cable-stop-use': 'Please don\'t use it with a damaged cable or plug — unplug it and don\'t tape it up. A repairer can replace the cable safely.',
  'thermal-cut-out-after-blockage': 'There\'s a blockage that won\'t shift, which will keep tripping its cut-out. A repairer can clear it — please don\'t open the main body.',
  'battery-or-charger-fault': 'From what you\'ve described, it\'s most likely the battery or the charger. Trying a known-good charger tells them apart — I\'m not recommending a part until that\'s clear.',
  'switch-cable-or-motor': 'The supply and airflow are fine but it\'s still dead, so it\'s the switch, an internal connection, the battery or the motor. That needs a repairer — please don\'t open it or test inside. I\'m not recommending a part from this.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is it running normally now?',
  OBS_COPY: { noPower: ['dead', 'has power'], cutsOut: ['stopped during use', null], vacuumCordless: ['cordless', null], vacuumCorded: ['corded', null], vacuumRobot: ['robot', null], faultPersists: ['still dead', 'running now'] },
  CHECK_RESULT_COPY: { 'power-supply': { clear: 'supply fine', found_and_cleared: 'supply sorted', fault_seen: 'cable / plug damaged' },
    'vacuum-charger-check': { clear: 'charger fine', found_and_cleared: 'charging sorted', fault_seen: 'charging light never on' },
    'vacuum-blockage': { clear: 'no blockage', found_and_cleared: 'blockage cleared', found_not_cleared: 'blockage stuck' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: '' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(motor|battery|charger|switch|cable|pcb)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
