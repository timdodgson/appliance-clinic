'use strict';
/** Journey 6 COMPOSE pack — washing machine · door. WORDING ONLY. PURE. */
const ck = require('./compose-kit.js');

const FAMILY_LABEL = {
  'normal-release-delay': 'the normal safety delay before the door unlocks', 'child-lock': 'the child lock', 'handle-or-catch': 'the door handle or catch',
  'door-lock': 'the door lock (interlock)', 'level-sensing-or-control': 'the water-level sensing or the control side (it thinks there is still water in)',
};
const COMPONENT_LABEL = { 'door-lock': 'door lock (interlock)', 'door-handle': 'door handle / catch' };
const TASK = {
  'ask_observation:doorSymptom': { say: 'Let\'s pin down what the door is doing.', ask: 'Does the door not open, not lock when you start a programme, not close properly, is the handle broken, or does the lock keep clicking on and off?' },
  'ask_observation:waterRemaining': { say: 'The door stays locked on purpose while there\'s water inside.', ask: 'Can you see any water left in the drum through the glass?' },
  'ask_check:door-release-wait': { say: 'Doors often stay locked for a couple of minutes after a programme ends. Leave it switched on for 5 minutes and try the handle normally. If it\'s still locked, switch it off at the socket, wait another 5 minutes and try again.', ask: 'Does the door open now?' },
  'ask_check:child-lock': { say: 'Many machines have a child lock (often a key or padlock symbol, turned off by holding two buttons together for a few seconds — your manual shows which) that keeps the door and buttons locked.', ask: 'Was the child lock on (and is it off now), or was it already off?' },
  'ask_check:door-closed-latched': { say: 'Open the door, make sure nothing is caught in the seal, then close it firmly until it clicks and start a programme.', ask: 'Does the door click locked now?' },
  'ask_check:door-catch': { say: 'With the machine unplugged, look at the small hook (catch) on the door and the slot it goes into, and check the door lines up squarely when you close it.', ask: 'Is the catch broken, bent or the door dropped on its hinge, was something blocking it (now cleared), or does it all look fine?' },
  'ask_check:retest': { say: 'Now close the door and start a programme.', ask: 'Is the door working normally now, or does the problem still happen?' },
  'ask_identity:model': { say: 'To match the right part for your machine I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate — usually around the door opening or on the back — and a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
};
const CONCLUSION = {
  'normal-release-delay': 'That\'s the door lock\'s normal safety delay — it waits a few minutes after the programme (and until the water has gone) before releasing. No part is needed; just give it a few minutes next time.',
  'D7:child-lock': 'The child lock was very likely holding it, so no part is needed.',
  'D7:handle-or-catch': 'Clearing the catch very likely sorted it, so no part is needed.',
  'level-sensing-or-control': 'With no water inside, the wait and power-off done and the child lock off, the door lock isn\'t being released — the lock itself, or the level sensing / control telling it there\'s still water. Please don\'t force the door; an appliance engineer can open it safely and find which. I\'m not recommending a part from this.',
  'door-lock': 'This points to the door lock (interlock) or its release. Please don\'t force it or try to bypass it; an appliance engineer can confirm it safely — I\'m not recommending a part from this.',
};
const OBS_COPY = {
  doorOpens: ['the door opens', 'the door will not open'], doorLocks: ['the door locks', 'the door does not lock'], doorCloses: [null, 'the door will not close'],
  handleBroken: ['the handle is broken', null], lockClicking: ['the lock keeps clicking', null], waterRemaining: ['water left in the drum', 'no water in the drum'],
  faultPersists: ['still happens after the fix', 'works normally after the fix'],
};
const CHECK_RESULT_COPY = {
  'child-lock': { clear: 'child lock not on', found_and_cleared: 'child lock was on (turned off)' },
  'door-catch': { clear: 'catch and alignment look fine', found_and_cleared: 'something blocking the catch (cleared)', fault_seen: 'catch broken / door dropped' },
};
const compose = ck.createCompose({
  TASK, OBS_COPY, CHECK_RESULT_COPY, CONFIRM_ASK: 'Is the door working normally now?',
  statusChecks: [['door-release-wait', 'wait / power-off release'], ['door-closed-latched', 'door lock check'], ['retest', 'retest']],
  conclusionCopy: ck.makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION }),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door lock|interlock|lock|handle|hinge|catch|pcb|control board|pressure switch)\b/i,
});
module.exports = { FAMILY_LABEL, COMPONENT_LABEL, TASK, REQUIREMENT: ck.REQUIREMENT, SAFETY_COPY: ck.SAFETY_COPY, ...compose };
