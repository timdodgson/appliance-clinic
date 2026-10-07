'use strict';
/**
 * Dishwasher journey 3 — leaking, incl. anti-flood / base tray (rules K1–K22). PURE, deterministic.
 * Design: docs/diagnostics/dw-batch-1-evidence.md §3. This journey OWNS any dishwasher problem with water in the base,
 * continuous pumping or an anti-flood code (whatever journey it was typed as — not filling, not starting, not
 * draining), so flood protection is diagnosed once and never bounces. A large leak first reported → containment once.
 * Installation / plumbing causes → no machine part; anti-flood alone never yields an inlet valve.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./dw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const FAMILY = { FO: 'foam-or-wrong-detergent', DS: 'door-seal', LS: 'loading-or-spray-escape', IC: 'inlet-connection', DC: 'drain-connection', IN: 'internal-leak' };
const SIGNALS = {
  FO: { foam: SS, wrongDet: SS, atDoor: S, onWash: S, atRear: A, onFill: A, wrongDetNo: SA },
  DS: { sealTorn: SS, sealObject: SS, restoredAfterSealFix: SS, failsAfterSealFix: SA, atDoor: S, onWash: S, sealOk: SA, atRear: A, onFill: A, baseWater: A },
  LS: { loadingFixed: SS, restoredAfterLoadingFix: SS, failsAfterLoadingFix: SA, atDoor: S, onWash: S, loadingOk: SA, atRear: A, onFill: A },
  IC: { inletFixed: SS, inletHoseDamaged: SS, restoredAfterInletFix: SS, failsAfterInletFix: SA, atRear: S, onFill: S, recentInstall: S, inletOk: SA, atDoor: A, onDrain: A },
  DC: { drainFixed: SS, drainHoseDamaged: SS, restoredAfterDrainFix: SS, failsAfterDrainFix: SA, atRear: S, onDrain: S, recentInstall: S, drainOk: SA, onFill: A, atDoor: A },
  IN: { baseWater: S, pumping: S, underneath: S, codeFlood: S, sealOk: S, inletOk: S, drainOk: S, loadingOk: S, atDoor: A, foam: A, wrongDet: A },
};
const FACT_LABEL = {
  atDoor: 'water at the door', atRear: 'water at the back / hoses', underneath: 'water underneath', onFill: 'while filling', onWash: 'during the wash', onDrain: 'while draining',
  foam: 'foam escaping', wrongDet: 'washing-up liquid / wrong detergent used', wrongDetNo: 'dishwasher detergent only', baseWater: 'water in the base tray / flood warning',
  pumping: 'keeps pumping non-stop', recentInstall: 'recently installed / moved', sealTorn: 'door seal damaged', sealObject: 'something caught on the seal (removed)', sealOk: 'door seal fine',
  loadingFixed: 'item deflecting spray at the door (moved)', loadingOk: 'nothing blocking the arms', inletFixed: 'inlet connection loose (tightened)', inletHoseDamaged: 'inlet hose damaged',
  inletOk: 'inlet connection dry', drainFixed: 'drain connection loose (refitted)', drainHoseDamaged: 'drain hose split', drainOk: 'drain connection dry', codeFlood: 'anti-flood error code',
};
const SPEC = {
  schema: 'dw3-diag/1', FAMILY, PRIOR: ['FO', 'DS', 'LS', 'IC', 'DC', 'IN'], SIGNALS, FACT_LABEL,
  obs: { atDoor: ['leakAtDoor', true], atRear: ['leakAtRear', true], underneath: ['leakUnderneath', true], onFill: ['leaksOnFill', true], onWash: ['leaksOnWash', true],
    onDrain: ['leaksOnDrain', true], foam: ['excessiveFoam', true], wrongDet: ['wrongDetergent', true], wrongDetNo: ['wrongDetergent', false], baseWater: ['waterInBase', true],
    pumping: ['pumpRunsContinuously', true], recentInstall: ['recentInstallation', true] },
  checks: { 'door-seal': { clear: 'sealOk', found: 'sealObject', fault: 'sealTorn' }, 'loading-clearance': { clear: 'loadingOk', found: 'loadingFixed' },
    'inlet-connection': { clear: 'inletOk', found: 'inletFixed', fault: 'inletHoseDamaged' }, 'drain-connection': { clear: 'drainOk', found: 'drainFixed', fault: 'drainHoseDamaged' },
    // the generic drain-hose check reported as damaged is the same owner-seen evidence
    'drain-hose': { fault: 'drainHoseDamaged' } },
  FIX_CHECK: { DS: ['door-seal', 'Seal'], LS: ['loading-clearance', 'Loading'], IC: ['inlet-connection', 'Inlet'], DC: ['drain-connection', 'Drain'] },
  DECISIVE_PART: { DS: { sealTorn: 'door-seal' }, IC: { inletHoseDamaged: 'inlet-hose' }, DC: { drainHoseDamaged: 'drain-hose' } },
  extra(s, ctx, on) { on('codeFlood', ctx.codeFault === 'leak-flood'); },
  eligible: (k, has) => (k === 'FO' ? has('foam') || has('wrongDet') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.dwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
function containment(s) {
  const ml = s.evidence && s.evidence.observations && s.evidence.observations.majorLeak;
  return ml && ml.value === true && ml.turn === s.version
    ? { target: 'major-leak', reason: 'uncontrolled-leak', requires: ['water_off_at_tap', 'power_off_only_if_dry', 'keep_clear_of_socket_if_water_near'], pending: null } : null;
}
const LOC = ['atDoor', 'atRear', 'underneath', 'baseWater', 'pumping'];
const P = kit.makeStepPolicy({
  JOURNEY: 'dw-leaking', P: 'K', appliance: 'dishwasher', journeys: ['leaking'], codeFaults: ['leak-flood'],
  claims: (h, journey) => F.DW_JOURNEYS.includes(journey) && F.flood(h),
  containment,
  CHECKS: ['door-seal', 'loading-clearance', 'inlet-connection', 'drain-connection'],
  OBS_TARGETS: { dwLeakLocation: ['leakAtDoor', 'leakAtRear', 'leakUnderneath'], leakTiming: ['leaksOnFill', 'leaksOnWash', 'leaksOnDrain', 'leaksWhenOff'],
    wrongDetergent: ['wrongDetergent'], waterInBase: ['waterInBase'] },
  REQUIRES: {
    'door-seal': ['isolate_mains', 'look_and_feel_only'], 'loading-clearance': [],
    'inlet-connection': ['isolate_mains', 'water_off_at_tap', 'hand_tight_only'], 'drain-connection': ['isolate_mains', 'contain_water'],
    waterInBase: ['no_tilting', 'keep_clear_of_socket_if_water_near'], retest: ['stop_if_water_near_socket'],
  },
  FIX_CHECKS: ['door-seal', 'loading-clearance', 'inlet-connection', 'drain-connection'],
  early(h) { return h.has('wrongDet') ? { target: 'foam-or-wrong-detergent', reason: 'wrong-detergent-foam', rule: 'K5', handoff: 'none' } : null; },
  steps: [
    { n: 10, target: 'dwLeakLocation', reason: 'location-decides-source', when: (h) => !LOC.some(h.has) && !h.has('foam') },
    { n: 11, target: 'leakTiming', reason: 'timing-fill-wash-drain', when: (h) => (h.has('atRear') || h.has('underneath')) && !['onFill', 'onWash', 'onDrain'].some(h.has) },
    { n: 12, target: 'wrongDetergent', reason: 'foam-check-detergent', when: (h) => h.has('foam') || h.has('atDoor') },
    { n: 13, target: 'door-seal', reason: 'door-seal-check', when: (h) => h.has('atDoor') },
    { n: 14, target: 'loading-clearance', reason: 'spray-deflected-at-door', when: (h) => h.has('atDoor') && !h.has('sealTorn') },
    { n: 15, target: 'waterInBase', reason: 'base-tray-flood-protection', when: (h) => h.has('underneath') || !LOC.some(h.has) },
    { n: 16, target: 'inlet-connection', reason: 'inlet-connection-check', when: (h) => (h.has('onFill') || (h.has('atRear') && !h.has('onDrain')) || h.has('baseWater') || h.has('pumping') || h.has('underneath')) && !h.has('sealTorn') && !h.has('drainHoseDamaged') },
    { n: 17, target: 'drain-connection', reason: 'drain-connection-check', when: (h) => (h.has('onDrain') || h.has('baseWater') || h.has('pumping') || (h.has('atRear') && !h.has('onFill')) || h.has('underneath')) && !h.has('sealTorn') },
  ],
  PART_FAMILIES: new Set(['DS', 'IC', 'DC']),
  HANDOFF: { FO: 'none', DS: 'engineer', LS: 'none', IC: 'install', DC: 'install', IN: 'engineer' },
});

const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'dw3/1', codeFaultFor: F.dwCodeFault,
  PART_MATCH: {
    'door-seal': { re: /door\s+(seal|gasket)|\b(tub|door)\s+seal\b|\bdoor\s+gasket\b/i, not: /lock|latch|hinge|handle/i },
    'inlet-hose': { re: /(inlet|fill|supply|aqua\s*-?stop)\s*hose|aqua\s*-?stop/i, not: /drain/i },
    'drain-hose': { re: /drain(age)?\s+hose/i, not: /pump/i },
  },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = {
  'foam-or-wrong-detergent': 'foam from washing-up liquid or the wrong detergent', 'door-seal': 'the door seal', 'loading-or-spray-escape': 'spray being deflected out of the door by the loading',
  'inlet-connection': 'the inlet hose connection', 'drain-connection': 'the drain hose connection', 'internal-leak': 'a leak inside the dishwasher (sump, pump seal or an internal hose)',
};
const COMPONENT_LABEL = { 'door-seal': 'door seal', 'inlet-hose': 'inlet hose', 'drain-hose': 'drain hose' };
const TASK = {
  'ask_observation:dwLeakLocation': { say: 'Let\'s pin down where the water is coming from.', ask: 'Do you see it first at the door, at the back where the hoses are, or underneath the dishwasher?' },
  'ask_observation:leakTiming': { say: 'When it leaks tells us a lot.', ask: 'Does it leak while it\'s filling, during the wash, while it drains, or even when it\'s switched off?' },
  'ask_observation:wrongDetergent': { say: 'Washing-up liquid — even a little left on rinsed dishes — makes masses of foam that pushes out past the door.', ask: 'Could any washing-up liquid or hand-wash liquid have got into the dishwasher, or do you only use dishwasher tablets / detergent?' },
  'ask_check:door-seal': { say: 'Open the door and look all the way round the rubber seal on the tub edge, and along the bottom of the door, for splits, flattened sections or something caught on it.', ask: 'Is the seal damaged, was something caught on it (now removed), or does it look fine?' },
  'ask_check:loading-clearance': { say: 'Tall trays or items hanging below the lower rack can deflect the spray straight at the door seal. With the racks loaded, turn each spray arm by hand.', ask: 'Was anything catching the arms or pointing at the door (and have you moved it), or is everything clear?' },
  'ask_observation:waterInBase': { say: 'Dishwashers have a base tray with a flood-protection float: if water collects there, it stops filling and often keeps pumping on purpose.', ask: 'Looking under the front kick plate, can you see water in the base tray, or a flood / tap warning on the display?' },
  'ask_check:inlet-connection': { say: 'Check where the inlet hose connects at the tap under the sink and at the dishwasher end for drips, a loose fitting or a split.', ask: 'Was a connection loose (and is it tight now), is the hose damaged, or is it dry?' },
  'ask_check:drain-connection': { say: 'Check the drain hose along its length and where it joins the sink waste for drips, a loose clip or a split.', ask: 'Was it loose (and is it refitted now), is the hose split, or is it dry?' },
  'ask_check:retest': { say: 'Now run a short programme and keep an eye on the floor.', ask: 'Does it stay dry, or does it still leak?' },
  'ask_identity:model': { say: 'To match the right part for your dishwasher I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate along the edge of the door or the side of the tub — a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a dishwasher, a washing machine or a washer-dryer?' },
};
const CONCLUSION = {
  'foam-or-wrong-detergent': 'Washing-up liquid makes far more foam than a dishwasher can hold, and it pushes water out past the door. Mop up, run a rinse (or two) with the door shut and nothing added, and only use dishwasher detergent — no part is needed.',
  'K7:door-seal': 'Clearing the seal very likely stopped it, so no part is needed.',
  'K7:loading-or-spray-escape': 'That was the spray being deflected out of the door, so no part is needed. Keep tall items clear of the spray arms.',
  'K7:inlet-connection': 'The loose inlet connection was very likely the cause, so no part is needed.',
  'K7:drain-connection': 'The loose drain connection was very likely the cause, so no part is needed.',
  'internal-leak': (state) => {
    const o = state.evidence && state.evidence.observations; const base = o && ((o.waterInBase && o.waterInBase.value) || (o.pumpRunsContinuously && o.pumpRunsContinuously.value));
    return base
      ? 'Water in the base tray has set off the flood protection — that\'s why it won\'t fill (or keeps pumping): it\'s doing its job. With the hoses and door fine, the water is coming from inside (the sump, pump seal or an internal hose). Switch it off at the socket, leave the tap off and don\'t tip it to empty the tray; an appliance engineer needs to find the leak — I\'m not recommending a part (an inlet valve won\'t fix this).'
      : 'With the hoses and door fine, the water is most likely coming from inside the dishwasher (the sump, pump seal or an internal hose). An appliance engineer needs to find it safely — I\'m not recommending a part from this.';
  },
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is it staying dry now?',
  OBS_COPY: { leakAtDoor: ['water at the door', null], leakAtRear: ['water at the back', null], leakUnderneath: ['water underneath', null], leaksOnFill: ['while filling', null],
    leaksOnWash: ['during the wash', null], leaksOnDrain: ['while draining', null], excessiveFoam: ['foam escaping', null], wrongDetergent: ['washing-up liquid / wrong detergent', 'dishwasher detergent only'],
    waterInBase: ['water in the base / flood warning', 'base dry'], pumpRunsContinuously: ['keeps pumping', null], majorLeak: ['a large amount of water', null], faultPersists: ['still leaks', 'stays dry'] },
  CHECK_RESULT_COPY: {
    'door-seal': { clear: 'door seal fine', found_and_cleared: 'something on the seal (removed)', fault_seen: 'door seal damaged' },
    'loading-clearance': { clear: 'nothing blocking the arms', found_and_cleared: 'item deflecting spray (moved)' },
    'inlet-connection': { clear: 'inlet connection dry', found_and_cleared: 'inlet connection loose (tightened)', fault_seen: 'inlet hose damaged' },
    'drain-connection': { clear: 'drain connection dry', found_and_cleared: 'drain connection loose (refitted)', fault_seen: 'drain hose split' },
  },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Turn the water off at the tap and switch the dishwasher off at the socket before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door seal|seal|gasket|hose|inlet valve|valve|pump|sump|float|tub)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
