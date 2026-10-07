'use strict';
/**
 * Journey 2 COMPOSE pack — washing machine · not spinning. WORDING ONLY. PURE.
 * Fixed customer copy keyed by typed NextAction kind/target, cause family and architecture; the shared
 * compose kit builds the brief, the prompt, the deterministic template and the reply checks.
 */
const ck = require('./compose-kit.js');
const { REQUIREMENT, SAFETY_COPY, naturalList } = ck;

const FAMILY_LABEL = {
  'load-imbalance': 'an out-of-balance load', 'programme-setting': 'a programme or spin setting',
  'suspension-or-movement': 'the suspension (shock absorbers / springs) or the machine not standing level',
  'pressure-or-level': 'the water-level (pressure) sensing system', 'door-lock': 'the door lock (interlock)',
  'drive-belt': 'the drive belt', 'motor-brushes': 'worn carbon brushes in the motor',
  'motor-drive': 'the motor, its control or the speed sensing', 'mechanical-resistance': 'the drum bearings or something jammed between the drum and tub',
  control: 'the control board',
};
const COMPONENT_LABEL = { 'drive-belt': 'drive belt', 'carbon-brushes': 'carbon brushes', 'door-lock': 'door lock' };

const MODEL_ASK = 'Could you send me the model number? It\'s on the rating plate — usually around the door opening, on the inside of the door or on the back — and a photo of the label is fine.';
const TASK = {
  'ask_observation:waterRemaining': { say: 'First, let\'s rule out a drainage problem — a washing machine won\'t spin while water is still in it.', ask: 'When it stops, is there water left standing in the drum (not just wet washing)?' },
  'ask_observation:drumTurns': { say: '', ask: 'During the wash part of the cycle, does the drum turn back and forth, or does it not turn at all?' },
  'ask_check:empty-spin-test': { say: 'Let\'s see whether the machine itself can spin: take the washing out and run a spin-only programme with the drum empty.', ask: 'Does it spin up properly when it\'s empty?' },
  'ask_check:load-check': { say: 'Washing machines refuse to spin if the load is out of balance — a single heavy item such as a bath mat, rug, duvet or a pair of jeans on its own, or a very small load, is the usual trigger. Spreading the washing out evenly or adding a few smaller items usually lets it spin.', ask: 'Was it a single heavy item or a very small load, or a normal mixed load?' },
  'ask_check:spin-command': { say: 'Next, run a spin-only (or rinse and spin) programme with the washing in.', ask: 'Does the drum spin up properly on that programme?' },
  'ask_check:spin-command:retest': { say: 'If you haven\'t already, change that (switch the option off, or even out the load), then run a rinse and spin or spin-only programme to test it.', ask: 'Does it spin up properly now?' },
  'ask_check:programme-setting': { say: 'It\'s also worth checking the settings: wool, delicate and hand-wash programmes spin very gently, and options such as "no spin", "rinse hold" or a low spin speed stop the final spin.', ask: 'Was a normal programme with a normal spin speed selected, or was one of those options set?' },
  'ask_check:drum-by-hand': { say: 'Next, check how the drum moves by hand.', ask: 'With the machine unplugged and the door open, how does the drum feel when you turn it by hand — normal, much lighter or looser than usual, or stiff, rough or grinding?' },
  'ask_observation:motorAudible': { say: 'One more thing to listen for.', ask: 'When it should be turning the drum, can you hear the motor running or humming, or is there no motor sound at all?' },
  'ask_check:door-closed-latched': { say: 'A washing machine won\'t run if the door lock doesn\'t engage. Close the door firmly, check nothing like a sock or the seal is caught in it, and start a programme.', ask: 'Does the door click locked and the lock light come on?' },
  'ask_identity:model': { say: 'What\'s left depends on how your machine is built (belt or direct drive, brushed or brushless motor).', ask: MODEL_ASK },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
};

const CONCLUSION = {
  'S9:load-imbalance': 'That points to an out-of-balance load: the machine was protecting itself rather than failing, so no part is needed. Evenly spread, mixed loads help — wash heavy items such as bath mats or duvets with a few smaller items.',
  'S9:programme-setting': 'That setting was stopping the spin, so there\'s no fault and no part needed.',
  'load-imbalance': 'Because it spins properly when it\'s empty, the motor and drive are working — the spin is being stopped by the out-of-balance protection, so no part is needed. Try evenly spread, mixed loads; if it keeps refusing with normal loads, an appliance engineer can check the balance sensing and suspension.',
  'programme-setting': 'It spins on a spin-only programme, so the motor and drive are working; the spin is most likely being limited by the programme or an option such as low spin or rinse hold. No part is needed.',
  'suspension-or-movement': 'Violent shaking with normal loads points to the suspension (shock absorbers or springs) or the machine not standing level. An appliance engineer should check it — I\'m not recommending a part from this.',
  'pressure-or-level': 'Because it drains but won\'t go into the fast spin even when empty, the likely cause is the water-level (pressure) sensing telling the machine water is still in it. That needs an appliance engineer to test — I\'m not recommending a part from this.',
  'mechanical-resistance': 'A drum that\'s stiff, rough, grinding or seized by hand points to the drum bearings or something jammed between the drum and the tub. Please don\'t keep running it — an appliance engineer is the next step. This isn\'t a DIY part.',
  control: 'Nothing is driving the drum and the drum itself turns normally, which points to the motor control or control board. That needs an appliance engineer with test equipment — I\'m not recommending a part from this.',
};
const archNote = (arch) => {
  const n = [];
  if (arch && arch.drive === 'direct') n.push('your machine is direct drive, so it has no drive belt');
  if (arch && arch.motor === 'brushless') n.push('it has a brushless (inverter) motor, so carbon brushes can\'t be the cause');
  return n.length ? ` (${n.join('; ')})` : '';
};

function conclusionCopy(state, a) {
  const c = a.conclusion || {};
  const model = state.identity.model && state.identity.model.confirmed ? state.identity.model.value : null;
  const unavailable = state.identity.modelStatus === 'unavailable';
  if (a.kind === 'close_resolved') return `Glad it's spinning again${c.cause && FAMILY_LABEL[c.cause] ? ` — ${FAMILY_LABEL[c.cause]} was the likely cause` : ''}. No part is needed.`;
  if (a.kind === 'recommend_part') {
    const comp = COMPONENT_LABEL[c.component] || 'part';
    const why = {
      'drive-belt': 'The motor runs but the drum doesn\'t, and the drum turns unusually freely by hand — that points to the drive belt having come off or broken',
      'carbon-brushes': 'The worn carbon brushes you found would explain the motor not driving the drum',
      'door-lock': 'The door lock isn\'t engaging even with the door closed firmly, so the machine can\'t run',
    }[c.component] || `The checks point to the ${comp}`;
    return `${why}. I've shown the matching ${comp} for your ${model || 'machine'} below. Unplug the machine before any repair; if you'd rather not fit it yourself, an appliance engineer can.`;
  }
  if (CONCLUSION[`${a.rule}:${c.cause}`]) return CONCLUSION[`${a.rule}:${c.cause}`];
  const noMatch = unavailable ? 'Without the model number I can\'t match the exact part' : 'I can\'t match a compatible part for your model from here';
  if (c.cause === 'door-lock') return `The door lock (interlock) isn't confirming the door is shut, so the machine won't run. Please don't try to bypass it. ${noMatch}, so an appliance engineer is the best next step.`;
  if (c.cause === 'drive-belt') return `The motor runs but the drum doesn't turn, which points to the drive belt having slipped off or broken. ${noMatch}; an appliance engineer can refit or replace it.`;
  if (c.cause === 'motor-brushes' && c.level === 'component') return `Worn carbon brushes would explain the motor not driving the drum. ${noMatch}, so an appliance engineer is the best next step.`;
  if (c.cause === 'motor-drive' || c.cause === 'motor-brushes') {
    const alts = (c.alternatives || []).filter((x) => x !== c.cause).map((x) => FAMILY_LABEL[x]).filter(Boolean);
    return `The fault is most likely in the motor, motor control or speed-sensing area${archNote(c.architecture)}${alts.length ? ` — ${naturalList(alts)} is also possible` : ''}. Owner checks can't separate these safely, so an appliance engineer with test equipment is the next step. I'm not recommending a part from this alone.`;
  }
  if (CONCLUSION[c.cause]) return CONCLUSION[c.cause];
  return `From what we've been able to check, the most likely cause is ${FAMILY_LABEL[c.cause] || 'a drive fault'}. An appliance engineer is the best next step to confirm it.`;
}

const OBS_COPY = {
  waterRemaining: ['water left in the drum', 'no water left in the drum (it drains)'],
  drumTurns: ['the drum turns during the wash', 'the drum does not turn at all'],
  spinsEmpty: ['it spins properly with the drum empty', 'it will not spin even with the drum empty'],
  commandedSpin: ['it spins on a spin-only programme', 'it will not spin on a spin-only programme'],
  spinsSlowly: ['it spins only slowly', null], intermittentSpin: ['it spins only sometimes', null], jerkyAcceleration: ['the drum jerks instead of speeding up', null],
  repeatedRedistribution: ['it keeps trying to balance the load', null], excessiveVibration: ['it bangs / shakes violently', null],
  doorLocks: ['the door locks', 'the door does not lock'], motorAudible: ['the motor can be heard running', 'no motor sound'],
  drumUnusuallyFree: ['the drum turns unusually freely by hand', null], drumTurnsByHand: [null, 'the drum is stiff or will not turn by hand'],
  loadDependent: ['it only fails with heavy / bulky loads', null], grindingNoise: ['grinding / rumbling noise', null],
};
const CHECK_RESULT_COPY = {
  'load-check': { clear: 'load: a normal mixed load', found_and_cleared: 'load problem found and corrected' },
  'programme-setting': { clear: 'programme and spin setting normal', found_and_cleared: 'a no-spin / low-spin setting was found and changed' },
  'drum-by-hand': { clear: 'drum turns normally by hand', fault_seen: 'drum stiff, rough or grinding by hand', found_not_cleared: 'drum seized by hand' },
  'drive-belt': { fault_seen: 'drive belt seen broken or off', clear: 'drive belt seen intact' },
  'carbon-brushes': { fault_seen: 'carbon brushes seen worn', clear: 'carbon brushes seen fine' },
};
function extraFacts(state, a) {
  const arch = a && a.conclusion && a.conclusion.architecture;
  const out = [];
  if (arch && arch.drive === 'direct') out.push('This machine is direct drive: it has no drive belt.');
  if (arch && arch.motor === 'brushless') out.push('This machine has a brushless (inverter) motor: it has no carbon brushes.');
  return out;
}

const compose = ck.createCompose({
  TASK, conclusionCopy, OBS_COPY, CHECK_RESULT_COPY, extraFacts,
  statusChecks: [['empty-spin-test', 'empty-drum spin test'], ['spin-command', 'spin-only test'], ['door-closed-latched', 'door check']],
  retestKey: (a) => (a.kind === 'ask_check' && a.target === 'spin-command' && a.requestKind === 'retest' ? 'ask_check:spin-command:retest' : null),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(drive\s+)?(belt|carbon brushes|brushes|motor|door lock|interlock|pcb|control board|bearings?|shock absorbers?|pump)\b/i,
});
const { brief, prompt, template, checkReply } = compose;

module.exports = { FAMILY_LABEL, COMPONENT_LABEL, REQUIREMENT, TASK, SAFETY_COPY, brief, prompt, template, checkReply };
