/**
 * PROGRESSION MECHANICS — the shared Node-side changes that stop the GOLD v2 loop / re-ask /
 * continue-after-solved / unsafe-internal-testing failures. These exercise the PURE, exported
 * building blocks with TYPED/STRUCTURAL inputs — no LLM, and no regex matching of generated prose
 * as a behavioural oracle. We assert on function outputs and on the deterministic COMPOSE directive
 * text (structural prompt contract), which is legitimate (the prompt is code, not model output).
 *
 *   node services/part-finder/test/progression-mechanics.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const {
  ensureNonTerminalProgression, identificationIsNextAction, applyFollowUpNextAction,
  stripOwnerInternalElectricalInspection, remoteActionBoundary, classifyRemoteActionClass,
  buildComposeSystem, REMOTE_ACTION,
} = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''); }
}
const ACK = 'Thanks for confirming that.';

// 1) ensureNonTerminalProgression — no canned probe on terminal/cannot-answer turns -------------
{
  const recovered = ensureNonTerminalProgression(ACK, { nextBestCheck: null }, { recovered: true });
  check('recovery turn is terminal — no probe appended', recovered === ACK, recovered);

  const normal = ensureNonTerminalProgression(ACK, { nextBestCheck: null }, { normalBehaviour: true });
  check('normal-behaviour turn is terminal — no probe appended', normal === ACK, normal);

  const cannot = ensureNonTerminalProgression(
    'From what you have said the drain pump is the most likely cause.',
    { _cannotAnswer: true, nextBestCheck: null },
    {},
  );
  check('cannot-answer turn appends no question (no loop)',
    !/what else still works/i.test(cannot) && cannot.indexOf('?') === -1, cannot);

  const partReq = ensureNonTerminalProgression(ACK, { _nextAction: 'part_request' }, {});
  check('part-request turn is terminal — no probe appended', partReq === ACK, partReq);

  // A genuine mid-diagnosis dead-end STILL progresses (dead-end avoidance retained).
  const deadEnd = ensureNonTerminalProgression(ACK, {}, {});
  check('genuine dead-end still progresses', /\?/.test(deadEnd) || /what else still works/i.test(deadEnd), deadEnd);

  // A real next check is used in preference to the generic probe.
  const withCheck = ensureNonTerminalProgression(
    ACK,
    { nextBestCheck: 'Does the drum turn freely by hand?', nextCheckCustomerSafe: true },
    {},
  );
  check('real next check preferred over generic probe',
    /drum turn freely/i.test(withCheck) && !/what else still works/i.test(withCheck), withCheck);
}

// 2) identificationIsNextAction — do not re-ask the model once it is unavailable ----------------
{
  const famKnownNoModel = { applianceType: 'fridge-freezer', modelUnavailable: true, needMoreInfo: true,
    nextCheckCustomerSafe: false };
  check('model unavailable + family known -> identification is NOT next (no model loop)',
    identificationIsNextAction(famKnownNoModel, { isFollowUp: true }) === false,
    identificationIsNextAction(famKnownNoModel, { isFollowUp: true }));

  // Family still unknown: asking which appliance remains legitimate (not blocked by modelUnavailable).
  const famUnknownNoModel = { applianceType: null, modelUnavailable: true, needMoreInfo: true,
    _nextAction: 'identification' };
  check('model unavailable + family unknown -> identification can still be next',
    identificationIsNextAction(famUnknownNoModel, { isFollowUp: true }) === true,
    identificationIsNextAction(famUnknownNoModel, { isFollowUp: true }));

  // applyFollowUpNextAction must not fall through to a model/identity ask when model unavailable + family known.
  const intent = { applianceType: 'oven-cooker', modelUnavailable: true, needMoreInfo: true,
    nextCheckCustomerSafe: false, nextBestCheck: null, make: 'zanussi' };
  const after = applyFollowUpNextAction(intent, { isFollowUp: true }, {});
  check('applyFollowUpNextAction does not set identification when model unavailable + family known',
    after._nextAction !== 'identification', after._nextAction);
}

// 3) stripOwnerInternalElectricalInspection — owner internal-electrical testing removed ---------
{
  const owner = stripOwnerInternalElectricalInspection(
    'Visually inspect the heating element inside the oven cavity for any obvious breaks in the metal coil or blistering.');
  check('owner internal-element inspection is removed', !/inspect the heating element/i.test(owner), owner);
  check('owner internal-element inspection is routed to an engineer instead',
    /engineer/i.test(owner), owner);

  const engineerRouted = 'A qualified engineer should test the heating element and replace it if faulty.';
  check('engineer-routed element advice is preserved',
    stripOwnerInternalElectricalInspection(engineerRouted) === engineerRouted, engineerRouted);

  const benign = 'With the dryer off, clean the lint filter and check the vent hose is clear.';
  check('benign owner-safe check is untouched',
    stripOwnerInternalElectricalInspection(benign) === benign, benign);
}

// 4) Remote-action boundary — internal electrical components are out of scope -------------------
{
  const cls = classifyRemoteActionClass({ applianceType: 'oven-cooker', queryText: 'fan oven not heating' });
  const b = remoteActionBoundary(cls, 'oven-cooker', 'fan oven not heating');
  const oos = b.outOfScope.join(' ').toLowerCase();
  check('boundary out-of-scope names internal electrical components',
    /heating element|thermostat|pcb|wiring|terminals/.test(oos) && /internal electrical/.test(oos), oos);
}

// 5) COMPOSE directive contract — the structural guardrails are present -------------------------
{
  const promptPlain = buildComposeSystem([], null, { applianceType: 'dishwasher' }, null, [], null, false, false, null, false, null, { isFollowUp: true });
  check('COMPOSE enforces one question per turn', /ONE QUESTION PER TURN/i.test(promptPlain));
  check('COMPOSE forbids a menu of possibilities', /never offer a menu of possibilities/i.test(promptPlain));
  check('COMPOSE forbids owner internal electrical access', /NO INTERNAL ELECTRICAL ACCESS BY THE OWNER/i.test(promptPlain));
  check('COMPOSE requires safe-check framing', /SAFE-CHECK FRAMING/i.test(promptPlain));

  const promptNoModel = buildComposeSystem([], null, { applianceType: 'fridge-freezer', modelUnavailable: true }, null, [], null, false, false, null, false, null, { isFollowUp: true });
  check('COMPOSE adds a MODEL UNAVAILABLE do-not-re-ask directive', /MODEL UNAVAILABLE/i.test(promptNoModel));
}

console.log(`progression-mechanics: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
