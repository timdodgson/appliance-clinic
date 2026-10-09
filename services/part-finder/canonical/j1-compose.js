'use strict';
/**
 * Journey 1 COMPOSE contract — WORDING ONLY. PURE.
 *
 *   brief(state, nextAction, diag, {partLookup, media}) -> {facts[], task, safety[], media, part, explanation}
 *   prompt(brief)                                        -> [{role, content}]  (no customer prose, no transcript)
 *   template(brief)                                      -> deterministic customer reply (fallback / safety)
 *   checkReply(reply, nextAction, brief)                 -> {ok, reply, violations[]}
 *
 * COMPOSE never chooses ask vs conclude, the check, whether the model is needed, the part, the cause
 * rank or the resolution: those all arrive typed in the NextAction. The copy below is FIXED product copy
 * keyed by typed keys (check key, requirement token, cause family) — nothing is derived from prose.
 */

const FAMILY_LABEL = {
  'filter-blockage': 'a blockage in the pump filter',
  'impeller-obstruction': 'something caught in the pump impeller',
  'hose-or-waste-restriction': 'a kink or blockage in the drain hose or waste pipe',
  'household-waste-backflow': 'a blockage in the household waste plumbing',
  'excess-suds': 'too much foam from the detergent',
  'drain-pump': 'the drain pump',
  'pressure-or-level': 'the water-level (pressure) sensing system',
  'control': 'the control circuit that drives the pump',
  'obstruction-beyond-reach': 'a blockage at the pump that can\'t be reached from the filter opening',
};
const COMPONENT_LABEL = { 'drain-pump': 'drain pump', 'pump-filter': 'pump filter', 'drain-hose': 'drain hose' };

const ck = require('./compose-kit.js');
const { REQUIREMENT, SAFETY_COPY, naturalList } = ck;

// Fixed customer copy per typed action. `ask` ends with exactly one question.
const TASK = {
  'ask_check:drain-filter': {
    say: 'The most common cause is a blockage in the pump filter (also called the drain filter or trap), and it\'s a free fix. On most washing machines it\'s behind a small flap or kick-plate at the bottom front.',
    ask: 'Could you check the filter and tell me what you find — was it clear, did you find and remove something, is there a blockage you can\'t shift, or does anything look broken?',
  },
  'ask_check:drain-filter:noise': {
    say: 'A noise like that while it tries to empty, together with the water not going, usually means something is caught in the pump filter or in the pump just behind it, so the pump filter is the first thing to check, and it\'s often a free fix. On most washing machines it\'s behind a small flap or kick-plate at the bottom front.',
    ask: 'Could you check the filter and tell me what you find — was it clear, did you find and remove something, is there a blockage you can\'t shift, or does anything look broken?',
  },
  'ask_check:drain-command': {
    say: 'Next, run a drain or spin-only programme and listen near the bottom front of the machine while it tries to pump out.',
    ask: 'Does the water pump away, and can you hear the pump humming or is it silent?',
  },
  'ask_check:drain-command:retest': {
    say: 'Now that the blockage is cleared, let\'s test it: run a drain or spin-only programme.',
    ask: 'Does the water pump away now?',
  },
  'ask_check:pump-impeller': {
    say: 'With the filter out, shine a torch into the filter opening and gently turn the small plastic impeller (the vanes) with a finger.',
    ask: 'Does it turn freely, was anything caught in it, is it jammed, or do the vanes look broken?',
  },
  'ask_check:drain-hose': {
    say: 'The next thing to check is the drain hose at the back: look for kinks or crushing, and check where it goes into the standpipe or sink waste.',
    ask: 'Was the hose clear, did you find and clear a kink or blockage, or is there one you can\'t clear?',
  },
  'ask_observation:pumpHumming': {
    say: 'That helps narrow it down.',
    ask: 'When it tries to drain, can you hear the pump humming or buzzing, or is it silent?',
  },
  'ask_observation:waterRemaining': { say: '', ask: 'Is there water left standing in the drum?' },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
  'ask_identity:model': {
    say: 'The simple checks are done, and what\'s left depends on your exact machine.',
    ask: 'Could you send me the model number? It\'s on the rating plate — usually around the door opening, on the inside of the door or on the back — and a photo of the label is fine.',
  },
};
const CONCLUSION = {
  'R9:filter-blockage': 'That blockage in the filter was very likely the cause, and it\'s draining again, so no part is needed.',
  'R9:impeller-obstruction': 'Whatever was caught in the impeller was very likely the cause, and it\'s draining again, so no part is needed.',
  'R9:hose-or-waste-restriction': 'The hose restriction was very likely the cause, and it\'s draining again, so no part is needed.',
  'R9a:excess-suds': 'Too much foam was very likely the cause — the rinse and spin clearing it supports that — so no part is needed. Use a little less detergent next time and make sure it\'s a low-foam (HE) one.',
  'obstruction-beyond-reach': 'There\'s a blockage at the pump that can\'t be cleared from the filter opening. Please don\'t force it or take the machine apart — an appliance engineer can remove the pump and clear it. No part is needed at this stage.',
  'hose-or-waste-restriction': 'The restriction is in the drain hose or the household waste it empties into. Clearing the standpipe or sink trap, or calling a plumber, is the next step — no machine part is needed.',
  'household-waste-backflow': 'If the machine pumps out but the water comes back or the sink backs up, the blockage is usually in the household waste plumbing — the standpipe, sink waste or U-bend — not the machine itself. Clearing that, or a plumber, is the next step; no machine part is needed.',
  'pressure-or-level': 'Because it pumps out when you run a drain or spin on its own, the pump and hose are working. That points to the water-level (pressure) sensing system — a small hose and switch that an appliance engineer needs to test. I\'m not recommending a part for that.',
  'control': 'With the pump silent and the drain path clear, the pump isn\'t being driven — that needs an appliance engineer to test the pump and its control circuit before any part is bought.',
};
const CONFIRM_ASK = 'Is it all working normally now?';

const CHECK_RESULT_COPY = {
  'drain-filter': { clear: 'pump filter checked: clear', found_and_cleared: 'pump filter: blockage found and cleared', found_not_cleared: 'pump filter: blockage that could not be cleared', fault_seen: 'pump filter: damaged' },
  'pump-impeller': { clear: 'impeller turns freely', found_and_cleared: 'impeller: object removed', found_not_cleared: 'impeller jammed', fault_seen: 'impeller vanes damaged' },
  'drain-hose': { clear: 'drain hose checked: clear', found_and_cleared: 'drain hose: kink/blockage cleared', found_not_cleared: 'drain hose: blockage not cleared', fault_seen: 'drain hose damaged' },
};
const OBS_COPY = {
  waterRemaining: ['water left in the drum', 'no water left in the drum'],
  commandedDrain: ['a drain/spin programme pumped the water out', 'a drain/spin programme did not pump the water out'],
  pumpHumming: ['the pump hums when draining', 'the pump is silent when draining'],
  grindingNoise: ['a grinding noise', null],
  noiseOnDrain: ['the noise happens when it tries to empty', null],
  excessiveFoam: ['excess foam seen', null],
  waterReturnsAfterDrain: ['water comes back after draining / the sink backs up', null],
};
function conclusionCopy(state, a) {
  const c = a.conclusion || {};
  if (a.kind === 'close_resolved') {
    return `Glad it's sorted${c.cause && FAMILY_LABEL[c.cause] ? ` — ${FAMILY_LABEL[c.cause]} was the likely cause` : ''}. No part is needed. If it happens again, the pump filter is the first thing to check.`;
  }
  if (a.kind === 'recommend_part') {
    const comp = COMPONENT_LABEL[c.component] || 'part';
    const model = state.identity.model && state.identity.model.value;
    return `With the filter, impeller and hose all checked clear and the pump humming but not moving water, the ${comp} itself is the likely fault${model ? ` on your ${model}` : ''}. I've shown the matching ${comp} below. Fitting it means unplugging and draining the machine first; if you'd rather not, an appliance engineer can fit it.`;
  }
  if (CONCLUSION[`${a.rule}:${c.cause}`]) return CONCLUSION[`${a.rule}:${c.cause}`];
  if (c.cause === 'drain-pump') {
    const unavailable = state.identity.modelStatus === 'unavailable';
    if (c.level === 'component') {
      return `The checks point to the drain pump itself.${unavailable ? ' Without the model number I can\'t match an exact replacement,' : ' I can\'t match a compatible part for your model from here,'} so an appliance engineer is the best next step to confirm and fit one.`;
    }
    const alts = (c.alternatives || []).map((x) => FAMILY_LABEL[x]).filter(Boolean);
    return `The most likely remaining cause is the drain pump${alts.length ? `, but ${naturalList(alts)} can't be ruled out without testing` : ''}. An appliance engineer should confirm it before any part is bought.`;
  }
  if (CONCLUSION[c.cause]) return CONCLUSION[c.cause];
  const label = FAMILY_LABEL[c.cause] || 'a drainage fault';
  return `From what we've been able to check, the most likely cause is ${label}. ${c.handoff === 'engineer' ? 'An appliance engineer is the best next step to confirm it.' : ''}`.trim();
}

const compose = ck.createCompose({
  TASK, conclusionCopy, OBS_COPY, CHECK_RESULT_COPY, CONFIRM_ASK,
  statusChecks: [['drain-command', 'drain/spin test']],
  retestKey: (a, state) => {
    if (a.kind === 'ask_check' && a.target === 'drain-command' && a.requestKind === 'retest') return 'ask_check:drain-command:retest';
    const o = state && state.evidence && state.evidence.observations && state.evidence.observations.noiseOnDrain;
    if (a.kind === 'ask_check' && a.target === 'drain-filter' && o && o.value === true) return 'ask_check:drain-filter:noise';
    return null;
  },
});
const { brief, prompt, template, checkReply } = compose;

module.exports = { FAMILY_LABEL, COMPONENT_LABEL, REQUIREMENT, TASK, SAFETY_COPY, brief, prompt, template, checkReply };
