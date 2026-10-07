'use strict';
/**
 * Journey 3 COMPOSE pack — washing machine · leaking. WORDING ONLY. PURE.
 * Fixed customer copy keyed by typed NextAction kind/target and cause family; the shared compose kit builds the
 * brief, prompt, deterministic template and reply checks.
 */
const ck = require('./compose-kit.js');
const { REQUIREMENT, SAFETY_COPY, naturalList } = ck;

const FAMILY_LABEL = {
  'door-seal': 'the rubber door seal', dispenser: 'the detergent drawer', oversudsing: 'too much (or the wrong) detergent foaming over',
  'filter-seal': 'the pump filter cap or its seal', 'inlet-connection': 'the fill hose or its tap connection', 'inlet-valve-or-fill': 'the fill side inside the machine (inlet valve or its hoses)',
  'drain-connection': 'the drain hose or its standpipe connection', 'household-backflow': 'the household waste plumbing', 'pump-body': 'the drain pump body',
  'internal-hose': 'an internal (sump or tub) hose', 'tub-or-major-internal': 'the drum tub or another internal part',
};
const COMPONENT_LABEL = { 'door-seal': 'door seal', 'inlet-hose': 'fill (inlet) hose', 'drain-hose': 'drain hose', 'pump-filter': 'pump filter', 'detergent-drawer': 'detergent drawer' };

const TASK = {
  'ask_observation:leakLocation': { say: 'Let\'s pin down where the water is coming from.', ask: 'Where do you see it first — around the door, from the detergent drawer, at the back where the hoses are, at the pump filter flap at the bottom front, or just a puddle underneath?' },
  'ask_observation:leakTiming': { say: 'Next, when it happens tells us a lot.', ask: 'Does it leak while it\'s filling, during the wash, while it drains or spins, or even when the machine is off?' },
  'ask_check:door-seal': { say: 'Front leaks are most often the rubber door seal. Open the door and look all the way round the seal, including inside the folds at the bottom — a trapped coin, underwire or sock can hold it open, and splits often hide in the folds.', ask: 'Is the seal intact, did you find something trapped in it, or is it torn or split?' },
  'ask_check:detergent-drawer': { say: 'Pull the detergent drawer out (most have a release tab) and rinse away any built-up powder or softener, and check the housing it slides into for gunk.', ask: 'Was it blocked or built up, already clean, or cracked or broken?' },
  'ask_check:detergent-dose': { say: 'Too much detergent, or one that isn\'t low-foam (HE), can foam over and push water out.', ask: 'How much detergent do you use, and is it a low-foam (HE) washing-machine detergent?' },
  'ask_check:filter-seal': { say: 'The pump filter cap at the bottom front is a common leak, especially if it\'s been opened recently. Check it\'s screwed in fully and straight, and that its rubber seal is clean.', ask: 'Was it loose or not seated, tight and dry already, or is the cap or seal cracked or damaged?' },
  'ask_check:inlet-connection': { say: 'Check the fill hose where it screws onto the tap and onto the back of the machine — a loose fitting or a missing or perished washer is the usual cause.', ask: 'Were the connections loose (and are they tight now), already tight and dry, or is the hose split or bulging?' },
  'ask_check:drain-connection': { say: 'Check the grey drain hose along its length and where it goes into the standpipe or sink waste.', ask: 'Was it loose or pushed in too far, sound and dry, or is the hose split or cracked?' },
  'ask_check:leak-retest': { say: 'Now run a short programme and keep an eye on the floor.', ask: 'Does it stay dry, or does it still leak?' },
  'ask_check:leak-retest:retest': { say: 'Now run a short programme and keep an eye on the floor.', ask: 'Does it stay dry, or does it still leak?' },
  'ask_identity:model': { say: 'To match the right part for your machine I need its exact model.', ask: 'Could you send me the model number? It\'s on the rating plate — usually around the door opening, on the inside of the door or on the back — and a photo of the label is fine.' },
  'ask_identity:appliance': { say: '', ask: 'Is it a washing machine, a washer-dryer or a dishwasher?' },
};

const CONCLUSION = {
  'L15:door-seal': 'The trapped item was very likely what was letting water past the seal, so no part is needed. Wipe the folds out now and then.',
  'L15:dispenser': 'The blocked drawer was very likely the cause, so no part is needed. Rinsing it out every few weeks stops it happening again.',
  'L15:oversudsing': 'Too much foam was very likely the cause, so no part is needed. Stick to the recommended dose of a low-foam (HE) detergent.',
  'L15:filter-seal': 'The filter cap not being seated properly was very likely the cause, so no part is needed.',
  'L15:inlet-connection': 'The loose fill-hose connection was very likely the cause, so no part is needed.',
  'L15:drain-connection': 'The loose drain-hose connection was very likely the cause, so no part is needed.',
  'household-backflow': 'If the sink or waste backs up when the machine drains, the blockage is in the household waste plumbing (the standpipe, sink waste or U-bend), not the washing machine. Clearing that, or a plumber, is the next step — no machine part is needed.',
  oversudsing: 'This looks like too much detergent foaming over. Use the recommended dose of a low-foam (HE) washing-machine detergent and run a rinse to clear the suds — no part is needed.',
};
// Internal (engineer) conclusions: the lead-in states ONLY the owner checks that actually came back clear.
const INTERNAL = {
  'inlet-valve-or-fill': (drawer) => (drawer
    ? 'a drawer that still overflows points to the fill side inside the machine (the inlet valve or the hose into the drawer). That needs the casing off, so an appliance engineer is the next step — I\'m not recommending a part from this.'
    : 'the leak is most likely on the fill side inside the machine (the inlet valve or its hoses). That needs the casing off, so an appliance engineer is the next step — I\'m not recommending a part from this.'),
  'pump-body': () => 'the water is most likely coming from inside the base of the machine (around the drain pump or its hoses). That needs an appliance engineer to find safely — I\'m not recommending a part from this.',
  'internal-hose': () => 'the leak is most likely inside the machine (a sump or tub hose, or the pump). That needs an appliance engineer to trace safely — I\'m not recommending a part from this.',
  'tub-or-major-internal': () => 'with this much water the leak is most likely internal — a hose, the pump or the tub itself. Please don\'t take the machine apart; an appliance engineer is the next step. I\'m not recommending a part from this.',
};
const RULED_OUT = [['door-seal', 'the door seal'], ['detergent-drawer', 'the detergent drawer'], ['detergent-dose', 'the detergent dose'],
  ['filter-seal', 'the filter cap'], ['inlet-connection', 'the fill-hose connections'], ['drain-connection', 'the drain hose']];
function ruledOut(state) {
  const ch = (state.evidence && state.evidence.checks) || {};
  return RULED_OUT.filter(([k]) => ch[k] && ch[k].status === 'done' && ch[k].result === 'clear').map(([, l]) => l);
}
function internalCopy(state, cause) {
  const o = (state.evidence && state.evidence.observations) || {};
  const drawer = Boolean(o.drawerOverflowing && o.drawerOverflowing.value === true);
  const out = ruledOut(state);
  const body = INTERNAL[cause](drawer);
  const and = out.length > 1 ? `${out.slice(0, -1).join(', ')} and ${out[out.length - 1]}` : out[0];
  const lead = out.length ? `With ${and} checked and fine, ` : 'From what you\'ve described, ';
  return lead + body;
}
const CONFIRM_ASK = 'Is it staying dry now?';

function conclusionCopy(state, a) {
  const c = a.conclusion || {};
  const model = state.identity.model && state.identity.model.confirmed ? state.identity.model.value : null;
  const unavailable = state.identity.modelStatus === 'unavailable';
  if (a.kind === 'close_resolved') return `Glad it's dry now${c.cause && FAMILY_LABEL[c.cause] ? ` — ${FAMILY_LABEL[c.cause]} was the likely cause` : ''}. No part is needed.`;
  if (a.kind === 'recommend_part') {
    const comp = COMPONENT_LABEL[c.component] || 'part';
    return `The damaged ${comp} you found would explain the leak. I've shown the matching ${comp} for your ${model || 'machine'} below. Turn the water off at the tap and unplug the machine before fitting it; if you'd rather not, an appliance engineer can fit it.`;
  }
  if (CONCLUSION[`${a.rule}:${c.cause}`]) return CONCLUSION[`${a.rule}:${c.cause}`];
  const noMatch = unavailable ? 'Without the model number I can\'t match the exact part' : 'I can\'t match a compatible part for your model from here';
  if (c.level === 'component' && COMPONENT_LABEL[c.component]) {
    return `The ${COMPONENT_LABEL[c.component]} looks damaged and is the likely source of the leak. ${noMatch}, so ${c.component === 'inlet-hose' || c.component === 'drain-hose' ? 'a plumber or appliance engineer' : 'an appliance engineer'} is the best next step.`;
  }
  if (CONCLUSION[c.cause]) return CONCLUSION[c.cause];
  if (INTERNAL[c.cause]) return internalCopy(state, c.cause);
  if (c.cause === 'leak-source-unconfirmed') {
    return 'From what we have so far I can\'t pin down where the water is coming from. An appliance engineer is the best next step to find it safely — I\'m not recommending a part from this.';
  }
  const alts = (c.alternatives || []).map((x) => FAMILY_LABEL[x]).filter(Boolean);
  const label = FAMILY_LABEL[c.cause] || 'a leak we haven\'t been able to pin down';
  return `From the checks so far, the most likely source is ${label}${alts.length ? ` (${naturalList(alts)} is also possible)` : ''}. ${c.handoff === 'plumbing' ? 'A plumber or the installer can sort the connection.' : 'An appliance engineer is the best next step to confirm it safely.'}`;
}

const OBS_COPY = {
  leakAtDoor: ['water at the door / front', null], leakAtDrawer: ['water from the detergent drawer', null], leakAtRear: ['water at the back', null],
  leakUnderneath: ['a puddle underneath', null], leakAtFilter: ['water at the pump filter flap', null],
  leaksOnFill: ['leaks while filling', null], leaksOnWash: ['leaks during the wash', null], leaksOnDrain: ['leaks while draining / spinning', null],
  leaksWhenOff: ['leaks even when the machine is off', null], majorLeak: ['a large amount of water', 'only a small drip'],
  drawerOverflowing: ['the drawer overflows', null], excessiveFoam: ['excess foam', null], waterReturnsAfterDrain: ['the sink / waste backs up when it drains', null],
  recentFilterAccess: ['the pump filter was opened recently', null], recentInstallation: ['recently installed / moved / plumbing work', null],
  leakRecurs: ['it still leaks when run again', 'it stayed dry when run again'],
};
const CHECK_RESULT_COPY = {
  'door-seal': { clear: 'door seal intact', found_and_cleared: 'an item trapped in the door seal was removed', found_not_cleared: 'something trapped in the door seal', fault_seen: 'door seal torn / split' },
  'detergent-drawer': { clear: 'drawer clean', found_and_cleared: 'blocked / built-up drawer cleaned', fault_seen: 'drawer cracked' },
  'detergent-dose': { clear: 'normal dose of low-foam detergent', found_and_cleared: 'detergent dose / type corrected' },
  'filter-seal': { clear: 'filter cap tight and dry', found_and_cleared: 'filter cap re-seated', found_not_cleared: 'filter cap not seated', fault_seen: 'filter cap or seal damaged' },
  'inlet-connection': { clear: 'fill-hose connections tight and dry', found_and_cleared: 'loose fill-hose connection tightened', found_not_cleared: 'fill-hose connection loose', fault_seen: 'fill hose split / washer perished' },
  'drain-connection': { clear: 'drain hose and standpipe sound', found_and_cleared: 'drain hose connection refitted', found_not_cleared: 'drain hose connection loose', fault_seen: 'drain hose split' },
};

const compose = ck.createCompose({
  TASK, conclusionCopy, OBS_COPY, CHECK_RESULT_COPY, CONFIRM_ASK,
  statusChecks: [['leak-retest', 'leak retest']],
  retestKey: (a) => (a.kind === 'ask_check' && a.target === 'leak-retest' && a.requestKind === 'retest' ? 'ask_check:leak-retest:retest' : null),
  PURCHASE_RE: /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(door seal|seal|hose|inlet valve|valve|pump|tub|drum|drawer|bearings?)\b/i,
});
const { brief, prompt, template, checkReply } = compose;

module.exports = { FAMILY_LABEL, COMPONENT_LABEL, REQUIREMENT, TASK, SAFETY_COPY, brief, prompt, template, checkReply };
