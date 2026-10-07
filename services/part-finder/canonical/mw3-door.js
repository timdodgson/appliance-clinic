'use strict';
/**
 * Microwave journey 3 — door (rules MD1–MD22). PURE, deterministic.
 * Design: docs/diagnostics/final-migration-evidence.md §MW3. Cracked door glass → stop use (early; engineer). Won't
 * latch / won't open / says door open / only works if pushed → look at the door hooks and slots (unplugged, look only):
 * dirt / grease (owner) · a broken door hook / latch (external, mechanical) → door latch part with a model (fitted from
 * outside; if the casing must come off, an engineer) · hooks fine but door not recognised / only works pushed → the
 * interlock switches inside (HV area: engineer, no part; stop using it until checked).
 */
const engine = require('./evidence-engine.js');
const kit = require('./policy-kit.js');
const JP = require('./journey-pipeline.js');
const F = require('./mw-family.js');
const ck = require('./compose-kit.js');
const { SS, S, A, SA } = engine;

const KEY = 'mw-door';
const FAMILY = { OB: 'dirt-or-obstruction', HK: 'door-hook-or-latch', RL: 'door-release-mechanism', IL: 'interlock-switches' };
const SIGNALS = {
  OB: { checkFixed: SS, restoredAfterCheckFix: SS, failsAfterCheckFix: SA, checkOk: SA },
  HK: { hookBroken: SS, wontClose: S, checkOk: SA },
  RL: { wontOpen: SS, checkOk: S, hookBroken: A },
  IL: { pushed: SS, notRecog: S, checkOk: S, hookBroken: A, wontOpen: A, restoredAfterCheckFix: SA },
};
const FACT_LABEL = { wontClose: 'door won\'t latch', wontOpen: 'door won\'t open', notRecog: 'says door open / won\'t start', pushed: 'only works if the door is pushed',
  checkFixed: 'grease / food in the latch (cleaned)', hookBroken: 'door hook / latch broken', checkOk: 'hooks and slots look fine' };
const SPEC = {
  schema: 'mw3-diag/1', FAMILY, PRIOR: ['OB', 'HK', 'RL', 'IL'], SIGNALS, FACT_LABEL,
  obs: { wontClose: ['doorCloses', false], wontOpen: ['doorOpens', false], notRecog: ['doorRecognised', false], pushed: ['startsWhenPushed', true] },
  checks: { 'mw-door-check': { clear: 'checkOk', found: 'checkFixed', fault: 'hookBroken' } },
  FIX_CHECK: { OB: ['mw-door-check', 'Check'] },
  DECISIVE_PART: { HK: { hookBroken: 'mw-door-latch' } },
  extra(s, ctx, on) { if (ctx.codeFault === 'door') on('notRecog', true); },
  eligible: (k, has) => (k === 'RL' ? has('wontOpen') : true),
};
function diagnose(state, ctx = {}) {
  const codeFault = ctx.codeFault !== undefined ? ctx.codeFault : F.mwCodeFault(state, ctx.errorCodes || null);
  return engine.diagnoseSpec(SPEC, state, { ...ctx, codeFault });
}
const P = kit.makeStepPolicy({
  JOURNEY: KEY, P: 'MD', appliance: 'microwave', journeys: ['door-problem'], ...F.owns(KEY), declineUnsafe: F.UNSAFE,
  CHECKS: ['mw-door-check'],
  OBS_TARGETS: {},
  REQUIRES: { 'mw-door-check': ['mw_no_casing', 'look_only_no_tools', 'do_not_force_door'], retest: [] },
  FIX_CHECKS: ['mw-door-check'],
  early(h) { return h.obs('doorGlassCracked') === true ? { target: 'door-glass-cracked', reason: 'cracked-door-stop-use', rule: 'MD5', handoff: 'engineer' } : null; },
  steps: [{ n: 10, target: 'mw-door-check', reason: 'hooks-latches-slots', when: () => true }],
  PART_FAMILIES: new Set(['HK']),
  HANDOFF: { OB: 'none', HK: 'engineer', RL: 'engineer', IL: 'engineer' },
});
const pipeline = JP.makeModelPartPipeline({
  D: { diagnose }, P, schema: 'mw3/1', codeFaultFor: F.mwCodeFault,
  PART_MATCH: { 'mw-door-latch': { re: /door\s+(latch|hook)|\blatch\s+hook\b/i, not: /switch|interlock|lock assembly|lever|button|glass|choke|hinge/i } },
  MEDIA_BY_KEY: {},
});

// ---- COMPOSE (wording only) ----
const STOP = 'Please don\'t use it until it\'s sorted — the door switches are what stop it running with the door open.';
const FAMILY_LABEL = { 'dirt-or-obstruction': 'grease or food stopping the latch', 'door-hook-or-latch': 'a broken door hook / latch', 'door-release-mechanism': 'the door release mechanism',
  'interlock-switches': 'the door interlock switches', 'door-glass-cracked': 'cracked door glass' };
const COMPONENT_LABEL = { 'mw-door-latch': 'door latch / hook' };
const TASK = {
  'ask_check:mw-door-check': { say: 'With it unplugged, look at the plastic hooks on the edge of the door and the slots they click into, and check the door shuts cleanly — food or grease in the slots can stop them engaging.', ask: 'Was there food / grease in the way (and is it cleaned), is a hook or latch broken, or does it all look fine?' },
  'ask_check:retest': { say: 'Plug it back in and try a cup of water for a minute.', ask: 'Does the door latch and the microwave start normally now, or still not?' },
  'ask_identity:model': F.MW_MODEL_ASK, 'ask_identity:appliance': F.MW_APPLIANCE_ASK,
};
const CONCLUSION = {
  'door-glass-cracked': `Please stop using the microwave while the door is cracked or damaged — the door is part of what keeps the microwaves in. ${F.HV} An appliance engineer is the next step (for a low-cost microwave, replacing it is often more economical); I'm not recommending a part from this.`,
  'MD7:dirt-or-obstruction': 'Cleaning the latch very likely fixed it, so no part is needed.',
  'door-hook-or-latch': `A broken door hook / latch stops the door switches being pressed. ${STOP} With your model number I can check for the latch; otherwise an appliance engineer can fit it. I'm not recommending a part without that.`,
  'door-release-mechanism': `The door release mechanism isn't letting go. Please don't force the door. ${F.HV} An appliance engineer is the next step — I'm not recommending a part from this.`,
  'interlock-switches': `With the hooks fine but the door not recognised (or only working when pushed), the door interlock switches inside are the likely cause. ${STOP} ${F.HV} An appliance engineer is the next step; I'm not recommending a part from this.`,
};
const compose = ck.createCompose({
  ASK_GUARD: true, TASK, CONFIRM_ASK: 'Is the door working normally now?',
  OBS_COPY: { doorCloses: [null, 'door won\'t latch'], doorOpens: ['door opens', 'door won\'t open'], doorRecognised: ['door recognised', 'says door open'], startsWhenPushed: ['only works when pushed', null],
    doorGlassCracked: ['door glass cracked', null], faultPersists: ['still the same', 'working now'] },
  CHECK_RESULT_COPY: { 'mw-door-check': { clear: 'hooks and slots fine', found_and_cleared: 'latch cleaned', fault_seen: 'hook / latch broken' } },
  statusChecks: [['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Unplug the microwave before fitting it. It fits on the door itself — if fitting it needs the outer casing off, an appliance engineer must do it (high voltage inside).' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door|door switch|interlock|latch|hook|glass|hinge|pcb|control board)\b/i,
});
module.exports = { SPEC, FAMILY, diagnose, P, ...pipeline, FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
