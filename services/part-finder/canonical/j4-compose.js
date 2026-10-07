'use strict';
/** Journey 4 COMPOSE pack — washing machine · not filling. WORDING ONLY. PURE. */
const ck = require('./compose-kit.js');

const FAMILY_LABEL = {
  'household-supply': 'the household water supply', 'tap-or-fill-hose': 'the tap or the fill hose', 'inlet-mesh-filter': 'a blocked inlet mesh filter',
  'door-interlock': 'the door lock (the machine won\'t fill until the door locks)', 'inlet-valve': 'the inlet (fill) valve', 'pressure-or-control': 'the water-level sensing or the control side',
};
const COMPONENT_LABEL = { 'inlet-hose': 'fill (inlet) hose', 'inlet-valve': 'inlet (fill) valve', 'door-lock': 'door lock (interlock)' };
const TASK = {
  'ask_observation:fillState': { say: 'Let\'s narrow down the fill problem.', ask: 'When it starts, does no water come in at all, or does it come in but only very slowly?' },
  'ask_observation:supplyOk': { say: 'First, the supply to the house.', ask: 'Do your other taps (for example the kitchen cold tap) run at normal pressure right now?' },
  'ask_observation:doorLocks': { say: 'Most machines won\'t let any water in until the door has locked.', ask: 'When you start a programme, does the door click locked (and the lock light come on)?' },
  'ask_check:door-closed-latched': { say: 'Open the door, make sure nothing is caught in the seal, then close it firmly until it clicks and start a programme.', ask: 'Does the door click locked now?' },
  'ask_check:inlet-hose-tap': { say: 'Check the tap the fill hose connects to is turned fully on, and that the hose behind the machine isn\'t kinked or squashed against the wall.', ask: 'Was the tap fully on and the hose clear, did you find it off or kinked (and sort it), or is the hose itself damaged?' },
  'ask_check:inlet-filter': { say: 'Where the fill hose screws onto the back of the machine there\'s a small mesh filter that can block with grit or scale. Unscrew the hose at the machine end and look into the inlet.', ask: 'Was the mesh blocked (and is it clean now), or was it already clean?' },
  'ask_check:retest': { say: 'Now turn the tap back on and start a programme.', ask: 'Does it fill normally now, or is it still not taking water?' },
  'ask_identity:model': { say: 'To match the right part for your machine I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate — usually around the door opening or on the back — and a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
};
const CONCLUSION = {
  'household-supply': 'If your other taps are weak or off too, the problem is the household water supply rather than the machine. Check the stopcock and whether your water supplier has reported an outage or low pressure; a plumber can help if it\'s a house problem. No machine part is needed.',
  'F7:tap-or-fill-hose': 'The tap or a kinked hose was very likely stopping the water, so no part is needed. Keep the hose free of kinks when you push the machine back.',
  'F7:inlet-mesh-filter': 'The blocked inlet mesh was very likely the cause, so no part is needed. If it blocks again, hard-water scale or debris in the pipes may be worth a plumber\'s look.',
  'inlet-valve': 'With the supply, hose and mesh fine but water not coming in properly, the fill side inside the machine (the inlet valve or its control) is the most likely area. That needs an appliance engineer to confirm safely — I\'m not recommending a part from this.',
  'pressure-or-control': 'With the supply, tap, hose and mesh all fine, the fault is inside the machine — the fill valve, the water-level sensing or the control side. An appliance engineer is the best next step to confirm it safely; I\'m not recommending a part from this.',
};
const OBS_COPY = {
  waterEntering: ['water comes in', 'no water comes in'], fillsSlowly: ['fills only very slowly', null], supplyOk: ['other taps run normally', 'household supply off / low'],
  doorLocks: ['door locks', 'door does not lock'], faultPersists: ['still not filling after the fix', 'fills normally after the fix'],
};
const CHECK_RESULT_COPY = {
  'inlet-hose-tap': { clear: 'tap fully on and hose clear', found_and_cleared: 'tap was off / hose kinked (sorted)', found_not_cleared: 'tap / hose problem found', fault_seen: 'fill hose damaged' },
  'inlet-filter': { clear: 'inlet mesh clean', found_and_cleared: 'inlet mesh blocked (cleaned)', found_not_cleared: 'inlet mesh blocked' },
};
const compose = ck.createCompose({
  TASK, OBS_COPY, CHECK_RESULT_COPY, CONFIRM_ASK: 'Is it filling normally now?',
  statusChecks: [['door-closed-latched', 'door lock check'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION, fitNote: 'Turn the water off at the tap and unplug the machine before fitting it; if you\'d rather not, an appliance engineer can fit it.' }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(inlet valve|fill valve|valve|solenoid|hose|door lock|interlock|pressure switch|pcb|control board)\b/i,
});
module.exports = { FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
