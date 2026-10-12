'use strict';
/**
 * Fridge / freezer journey 6 — door / door seal (rules FD1–FD22). PURE, deterministic.
 * Design: docs/diagnostics/ff-td-batch-evidence.md §FF6. Also owns a not-cooling report where the door will not close or
 * seal (ff-family precedence). Obstruction / levelling (owner fix) → the seal (owner sees it torn → gasket) → the hinge /
 * alignment (owner sees it broken / dropped → hinge). A gasket or hinge is only ever recommended with a confirmed model
 * AND that owner-seen evidence — never because the fridge is warm.
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./ff-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'ff-door-seal-door';
const FAMILY = { OB: 'door-obstruction-or-level', DS: 'door-seal', HG: 'door-hinge-or-alignment', HD: 'door-handle', NF: 'door-closes-fine' };
const SIGNALS = {
  OB: { fitFixed: SS, restoredAfterFitFix: SS, failsAfterFitFix: SA, fitOk: SA, wontClose: S, notSeating: S },
  DS: { sealTorn: SS, sealFixed: SS, restoredAfterSealFix: SS, failsAfterSealFix: SA, sealOk: SA, notSeating: S },
  HG: { hingeBroken: SS, wontClose: S, notSeating: S, fitOk: SA },
  HD: { handle: SS },
  NF: { fitOk: S, sealOk: S, hingeBroken: SA, sealTorn: SA, handle: SA, restoredAfterFitFix: SA, restoredAfterSealFix: SA },
};
const FACT_LABEL = { notSeating: 'door not sealing', wontClose: 'door won\'t close', handle: 'door handle broken', fitFixed: 'something in the way / not level (sorted)',
  fitOk: 'door shuts and lines up', hingeBroken: 'hinge broken / door dropped', sealTorn: 'door seal torn / come away', sealFixed: 'seal dirty / folded (sorted)', sealOk: 'door seal fine' };
const SPEC = {
  schema: 'ff6-diag/1', FAMILY, PRIOR: ['OB', 'DS', 'HG', 'HD', 'NF'], SIGNALS, FACT_LABEL,
  obs: { notSeating: ['doorNotSeating', true], wontClose: ['doorCloses', false], handle: ['handleBroken', true] },
  checks: { 'ff-door-fit': { clear: 'fitOk', found: 'fitFixed', fault: 'hingeBroken' }, 'door-seal': { clear: 'sealOk', found: 'sealFixed', fault: 'sealTorn' } },
  FIX_CHECK: { OB: ['ff-door-fit', 'Fit'], DS: ['door-seal', 'Seal'] },
  DECISIVE_PART: { DS: { sealTorn: 'door-seal' }, HG: { hingeBroken: 'door-hinge' } },
  eligible: (k, has) => (k === 'HD' ? has('handle') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.ffCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'FD', appliance: 'fridge-freezer', journeys: ['door-problem'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['ff-door-fit', 'door-seal'],
  OBS_TARGETS: {},
  REQUIRES: { 'ff-door-fit': ['do_not_force_door'], 'door-seal': ['look_and_feel_only'], retest: [] },
  FIX_CHECKS: ['ff-door-fit', 'door-seal'],
  steps: [
    { n: 10, target: 'ff-door-fit', reason: 'obstruction-level-hinge', when: (h) => !h.has('handle') },
    { n: 11, target: 'door-seal', reason: 'seal-condition', when: (h) => !h.has('hingeBroken') && !h.has('handle') },
  ],
  PART_FAMILIES: new Set(['DS', 'HG']),
  HANDOFF: { OB: 'none', DS: 'engineer', HG: 'engineer', HD: 'engineer', NF: 'none' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'ff6/1', codeFaultFor: F.ffCodeFault,
  PART_MATCH: {
    'door-seal': { re: /door\s+(seal|gasket)|\bgasket\b/i, not: /hinge|handle|shelf|drawer|tumble|dryer|washing|dishwasher|oven/i },
    'door-hinge': { re: /\bhinge\b/i, not: /flap|drawer|compartment|cover|freezer\s+flap|seal|gasket/i },
  },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const FAMILY_LABEL = { 'door-obstruction-or-level': 'something in the way or the fridge not standing right', 'door-seal': 'the door seal', 'door-hinge-or-alignment': 'the door hinge / alignment',
  'door-handle': 'the door handle', 'door-closes-fine': 'nothing wrong with the door' };
const COMPONENT_LABEL = { 'door-seal': 'door seal (gasket)', 'door-hinge': 'door hinge' };
const TASK = {
  'ask_check:ff-door-fit': { say: 'Check nothing is stopping the door — a shelf, drawer, bottle or food sticking out — and that the door hasn\'t dropped or gone loose on its hinge. Most fridge freezers also need the front feet raised slightly so the doors swing shut on their own.', ask: 'Was something in the way or it not standing right (and have you sorted it), is the hinge broken or the door dropped, or does the door shut and line up fine?' },
  'ask_check:door-seal': { say: 'Run your fingers round the rubber seal and look for splits, gaps or a section that has come away from the door. A seal that is just dirty or folded can often be cleaned and eased back into shape.', ask: 'Is the seal torn or come away, was it dirty or folded (and is that sorted), or does it look fine?' },
  'ask_check:retest': { say: 'Close the door gently and see whether it shuts and seals properly now.', ask: 'Is the door shutting and sealing properly now, or still not?' },
  'ask_identity:model': { say: 'To match the right part for your fridge freezer I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating label inside the fridge, usually on a side wall near the salad drawer — a photo is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a fridge freezer, a fridge or a freezer?' },
};
const CONCLUSION = {
  'FD7:door-obstruction-or-level': 'That was what was stopping the door, so no part is needed.',
  'FD7:door-seal': 'Sorting the seal very likely fixed it, so no part is needed.',
  'door-handle': 'A broken door handle needs the exact part for your model; an appliance engineer can confirm and fit it — I\'m not recommending a part from this.',
  'door-closes-fine': 'The door shuts, lines up and the seal is fine, so the door isn\'t letting warm air in and no door part is needed. If it\'s still not cold enough, tell me and we\'ll look at the cooling itself.',
};
const compose = ck.createCompose({
  TASK, CONFIRM_ASK: 'Is the door shutting and sealing properly now?',
  OBS_COPY: { doorNotSeating: ['door not sealing', null], doorCloses: [null, 'door won\'t close'], handleBroken: ['handle broken', null], faultPersists: ['still not shutting / sealing', 'shutting and sealing now'] },
  CHECK_RESULT_COPY: {
    'ff-door-fit': { clear: 'door shuts and lines up', found_and_cleared: 'obstruction / levelling sorted', fault_seen: 'hinge broken / door dropped' },
    'door-seal': { clear: 'door seal fine', found_and_cleared: 'seal sorted', fault_seen: 'door seal torn / come away' },
  },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Switch the fridge freezer off at the socket before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door seal|seal|gasket|hinge|handle|door)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
