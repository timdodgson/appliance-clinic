'use strict';
/**
 * Oven journey 6 — door (rules OR1–OR22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §OV6. Cracked / shattered door glass → stop using it now (it can
 * break further when hot; early, engineer). Otherwise: something in the way / door not seated (owner) → hinge broken / door
 * dropped (hinge part with model) → handle broken (handle part with model) → seal torn / come away (seal part with model);
 * stuck LOCKED (pyrolytic / door-lock) → cool fully and power-cycle → door lock (engineer). A part needs the owner-seen
 * fault AND a confirmed model whose list has it.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ov-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'oven-door';
const FAMILY = { RL: 'lock-released-after-cooling', OB: 'door-obstruction-or-seating', HG: 'door-hinge', HD: 'door-handle', SL: 'door-seal', LK: 'door-lock', NF: 'door-fine' };
const SIGNALS = {
  RL: { restoredAfterResetFix: SS },
  OB: { fitFixed: SS, restoredAfterFitFix: SS, failsAfterFitFix: SA, fitOk: SA, wontClose: S },
  HG: { hingeBroken: SS, wontClose: S, fitOk: SA },
  HD: { handle: SS },
  SL: { sealTorn: SS, sealFixed: SS, restoredAfterSealFix: SS, failsAfterSealFix: SA, sealOk: SA },
  LK: { wontOpen: S, codeLock: SS, restoredAfterResetFix: SA },
  NF: { fitOk: S, sealOk: S, wontOpen: SA, handle: SA, hingeBroken: SA, sealTorn: SA },
};
const FACT_LABEL = { wontClose: 'door won\'t close', wontOpen: 'door stuck shut / locked', handle: 'door handle broken', fitFixed: 'something in the way / door not seated (sorted)',
  hingeBroken: 'hinge broken / door dropped', fitOk: 'door closes and lines up', sealTorn: 'door seal torn / come away', sealFixed: 'seal unhooked / dirty (sorted)', sealOk: 'door seal fine', codeLock: 'door-lock error code' };
const SPEC = {
  schema: 'ov6-diag/1', FAMILY, PRIOR: ['RL', 'OB', 'HG', 'HD', 'SL', 'LK', 'NF'], SIGNALS, FACT_LABEL,
  obs: { wontClose: ['doorCloses', false], wontOpen: ['doorOpens', false], handle: ['handleBroken', true] },
  checks: { 'oven-door-fit': { clear: 'fitOk', found: 'fitFixed', fault: 'hingeBroken' }, 'door-seal': { clear: 'sealOk', found: 'sealFixed', fault: 'sealTorn' } },
  FIX_CHECK: { OB: ['oven-door-fit', 'Fit'], SL: ['door-seal', 'Seal'] },
  DECISIVE_PART: { HG: { hingeBroken: 'oven-door-hinge' }, HD: { handle: 'oven-door-handle' }, SL: { sealTorn: 'oven-door-seal' } },
  extra(s, ctx, on) {
    on('codeLock', ctx.codeFault === 'door-lock');
    // the door opened after cooling + a power cycle: the lock simply hadn't released (no fault)
    on('restoredAfterResetFix', engine.checkDone(s, 'reset-power-cycle') && engine.obsVal(s, 'doorOpens') === true);
  },
  eligible: (k, has) => (k === 'HD' ? has('handle') : k === 'LK' ? has('wontOpen') || has('codeLock') : k === 'RL' ? has('restoredAfterResetFix') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ovCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const stuck = (h) => (h.has('wontOpen') || h.has('codeLock')) && h.obs('doorOpens') !== true;
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'OR', appliance: 'oven-cooker', journeys: ['door-problem'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['oven-door-fit', 'door-seal', 'reset-power-cycle'],
  OBS_TARGETS: {},
  outcomeObs: { 'reset-power-cycle': 'doorOpens' },
  REQUIRES: { 'oven-door-fit': ['oven_isolate_cool', 'do_not_force_door'], 'door-seal': ['oven_isolate_cool', 'look_and_feel_only'], 'reset-power-cycle': ['do_not_force_door'], retest: [] },
  FIX_CHECKS: ['oven-door-fit', 'door-seal'],
  // cracked door glass: stop using it (it can shatter when hot) — said once, engineer
  early(h) { return h.obs('doorGlassCracked') === true ? { target: 'door-glass-cracked', reason: 'cracked-glass-stop-use', rule: 'OR5', handoff: 'engineer' } : null; },
  steps: [
    { n: 10, target: 'reset-power-cycle', reason: 'cool-and-power-cycle-releases-lock', when: (h) => stuck(h) },
    { n: 11, target: 'oven-door-fit', reason: 'obstruction-hinge-handle', when: (h) => !stuck(h) && !h.has('handle') },
    { n: 12, target: 'door-seal', reason: 'seal-condition', when: (h) => !stuck(h) && !h.has('hingeBroken') && !h.has('handle') },
  ],
  PART_FAMILIES: new Set(['HG', 'HD', 'SL']),
  HANDOFF: { RL: 'none', OB: 'none', HG: 'engineer', HD: 'engineer', SL: 'engineer', LK: 'engineer', NF: 'none' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ov6/1', codeFaultFor: F.ovCodeFault,
  PART_MATCH: {
    'oven-door-hinge': { re: /\bhinge\b/i, not: /pin only|screw|hob|fridge|washing|dryer|microwave/i },
    'oven-door-handle': { re: /door\s+handle\b|\bhandle\s+(assembly|kit)\b/i, not: /screw|spacer|end cap|hob|fridge|washing|dryer/i },
    'oven-door-seal': { re: /door\s+(seal|gasket)|oven\s+(door\s+)?(seal|gasket)/i, not: /top oven|grill|hob|fridge|washing|dryer|round seal|clamp|spring/i },
  },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'lock-released-after-cooling': 'the door lock not having released yet', 'door-obstruction-or-seating': 'something in the way or the door not seated', 'door-hinge': 'a door hinge', 'door-handle': 'the door handle', 'door-seal': 'the door seal',
  'door-lock': 'the door lock', 'door-fine': 'nothing wrong with the door', 'door-glass-cracked': 'cracked door glass' };
const COMPONENT_LABEL = { 'oven-door-hinge': 'oven door hinge', 'oven-door-handle': 'oven door handle', 'oven-door-seal': 'oven door seal' };
const TASK = {
  'ask_check:oven-door-fit': { say: 'With the oven cold, check nothing (a shelf, tray or foil) is stopping the door, that a lift-off door is seated properly on both hinges, and whether the door has dropped to one side or a hinge looks broken.', ask: 'Was something in the way or the door not seated (and is it sorted), is a hinge broken / the door dropped, or does it close and line up fine?' },
  'ask_check:door-seal': { say: 'Look round the seal on the oven opening (or the door) for splits, a section hanging loose, or clips that have come out of their holes.', ask: 'Is the seal torn or come away, had it just come unhooked (and is it back in), or does it look fine?' },
  'ask_check:reset-power-cycle': { say: 'Doors often stay locked after a self-clean until the oven is fully cool. Once it\'s cold, switch it off at the cooker switch for a couple of minutes and back on — don\'t force the door.', ask: 'Does the door unlock now, or is it still stuck?' },
  'ask_check:retest': { say: 'Close the door gently.', ask: 'Is the door closing and sealing properly now, or still not?' },
  'ask_identity:model': F.OVEN_MODEL_ASK, 'ask_identity:appliance': F.OVEN_APPLIANCE_ASK,
};
const CONCLUSION = {
  'door-glass-cracked': 'Please stop using the oven while the door glass is cracked — it can break further when it heats up. Keep it switched off at the cooker switch; an appliance engineer can replace the glass (the panels are model-specific) — I\'m not recommending a part from this.',
  'OR7:lock-released-after-cooling': 'The lock just hadn\'t released yet — it stays locked until the oven is fully cool after a self-clean or a very hot cook. No part is needed.',
  'OR7:door-obstruction-or-seating': 'That was what was stopping the door, so no part is needed.', 'OR7:door-seal': 'Sorting the seal very likely fixed it, so no part is needed.',
  'door-lock': 'The door lock hasn\'t released. Please don\'t force it — an appliance engineer can open it safely and check the lock. I\'m not recommending a part from this.',
  'door-fine': 'The door closes and lines up and the seal is fine, so no door part is needed.',
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the door working properly now?',
  OBS_COPY: { doorCloses: [null, 'door won\'t close'], doorOpens: ['door opens', 'door stuck shut'], handleBroken: ['handle broken', null], doorGlassCracked: ['door glass cracked', null], faultPersists: ['still the same', 'sorted now'] },
  CHECK_RESULT_COPY: { 'oven-door-fit': { clear: 'door closes and lines up', found_and_cleared: 'obstruction / seating sorted', fault_seen: 'hinge broken / door dropped' },
    'door-seal': { clear: 'seal fine', found_and_cleared: 'seal back in place', fault_seen: 'seal torn / come away' } },
  statusChecks: [['reset-power-cycle', 'power cycle'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the oven off at the isolator and let it cool before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door|door glass|glass|hinge|handle|seal|gasket|door lock|lock)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
