/**
 * SCOPED-EVIDENCE + QUALITY PASS regression tests. Covers the targeted shared fixes:
 *   - typed symptom SCOPE (Jev customer-evidence) → _jevEvidence.scope + COMPOSE directive
 *   - deterministic owner-check safety framing (ownerCheckPrecaution / ensureOwnerCheckSafety)
 *   - internal-electrical → engineer referral with NO procedure, never a broken fragment
 *   - single-primary-ask for vague openers
 * Pure/typed/structural assertions and prompt-contract checks — NO regex oracle on LLM prose.
 *   node services/part-finder/test/scoped-evidence-quality.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const {
  stripOwnerInternalElectricalInspection, ownerCheckPrecaution, ensureOwnerCheckSafety,
  preferSingleVagueClarify, buildComposeSystem, classifySafetyStop,
} = require('../part-finder-lambda.js')._internal;
const jev = require('../jev-understand.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''); }
}
const choice = (c) => ({ type: 'choice', choice: c, confidence: 0.9, probabilities: {} });

// 1) Typed symptom scope — Jev dim exists, maps to a phrase, and is failure-tolerant ------------
{
  const qs = jev.buildCustomerEvidenceQuestions();
  check('1 evSymptomScope question exists and is a choice', qs.evSymptomScope && qs.evSymptomScope.type === 'choice', Object.keys(qs).filter((k) => /scope/i.test(k)));
  const dry = jev.adaptCustomerEvidence({ evSymptomScope: choice('dry_only') });
  check('2 dry_only → scope with a human phrase', dry.scope && dry.scope.value === 'dry_only' && /drying/i.test(dry.scope.phrase), dry.scope);
  const fridge = jev.adaptCustomerEvidence({ evSymptomScope: choice('fridge_only') });
  check('3 fridge_only → fridge-compartment scope', fridge.scope && fridge.scope.value === 'fridge_only', fridge.scope);
  const none = jev.adaptCustomerEvidence({ evSymptomScope: choice('none') });
  check('4 none → no scope (never forced)', none.scope === null, none.scope);
  const missing = jev.adaptCustomerEvidence({});
  check('5 absent answer → no scope, no throw', missing.scope === null, missing.scope);
}

// 2) COMPOSE scope directive ---------------------------------------------------------------------
{
  const prompt = buildComposeSystem([], null, { applianceType: 'washer-dryer', _symptomScope: { value: 'dry_only', phrase: 'only during the drying function (washing works fine)' } }, null, [], null, false, false, null, false, null, { isFollowUp: true });
  check('6 COMPOSE carries the SYMPTOM SCOPE directive', /SYMPTOM SCOPE/i.test(prompt) && /drying function/i.test(prompt));
  check('7 scope directive forbids declaring the working side healthy', /NOT proof the in-scope parts are healthy/i.test(prompt));
  const noScope = buildComposeSystem([], null, { applianceType: 'washer-dryer' }, null, [], null, false, false, null, false, null, {});
  check('8 no scope → no scope directive', !/SYMPTOM SCOPE/i.test(noScope));
}

// 3) Deterministic owner-check safety framing ---------------------------------------------------
{
  check('9 vacuum diagnostic turn → unplug/battery precaution', /unplug|battery/i.test(ownerCheckPrecaution({ applianceType: 'vacuum', _nextAction: 'check' }) || ''));
  check('10 dryer diagnostic turn → isolate + lint fire-risk precaution', /unplug/i.test(ownerCheckPrecaution({ applianceType: 'tumble-dryer', _nextAction: 'check' }) || '') && /lint|fire/i.test(ownerCheckPrecaution({ applianceType: 'tumble-dryer' }) || ''));
  check('11 oven note routes element replacement to an engineer, no live test', /engineer/i.test(ownerCheckPrecaution({ applianceType: 'oven-cooker' }) || '') && /live/i.test(ownerCheckPrecaution({ applianceType: 'oven-cooker' }) || ''));
  check('12 model-ask (identification) turn → no precaution', ownerCheckPrecaution({ applianceType: 'vacuum', _nextAction: 'identification' }) === null);
  check('12b recovery turn → no precaution', ownerCheckPrecaution({ applianceType: 'vacuum', _nextAction: 'check' }, { recovered: true }) === null);
  check('12c vague clarify turn → no precaution', ownerCheckPrecaution({ applianceType: 'dishwasher', _exclusiveClarify: true }) === null);
  const injected = ensureOwnerCheckSafety('Empty the bin and clean the filter.', { applianceType: 'vacuum', _nextAction: 'check' }, {});
  check('13 enforcer injects on a real physical-check turn', /unplug|battery/i.test(injected) && /clean the filter/i.test(injected), injected);
  const already = 'With it switched off and unplugged, open the filter.';
  check('14 enforcer does not double an existing precaution', ensureOwnerCheckSafety(already, { applianceType: 'dishwasher', _nextAction: 'check' }, {}) === already);
  check('15 enforcer skips on a safety stop', ensureOwnerCheckSafety('Stop and unplug it.', { applianceType: 'vacuum', _nextAction: 'check' }, { safetyStop: 'burning' }) === 'Stop and unplug it.');
  // The orchestrator owns model-ask / stop turns; a model-ask carries _nextAction 'identification'
  // (a NON_CHECK action), so the enforcer leaves it untouched on structural grounds.
  const modelAsk = 'To identify the right part, could you please provide the model number from the rating plate?';
  check('16 enforcer skips a model-ask (identification) turn', ensureOwnerCheckSafety(modelAsk, { applianceType: 'fridge-freezer', _nextAction: 'identification' }, {}) === modelAsk);
  // A diagnostic conclusion/advice turn precedes the owner acting on it, so the family-standing
  // precaution is carried deterministically rather than left to COMPOSE.
  const conclusion = 'That points to the door seal as the most likely cause on this model.';
  const concOut = ensureOwnerCheckSafety(conclusion, { applianceType: 'oven-cooker', _nextAction: 'advice' }, {});
  check('17 enforcer carries the family precaution on an advice/conclusion turn', /engineer|at the wall|switch it off/i.test(concOut) && /door seal/i.test(concOut), concOut);
}

// 4) Internal-electrical → engineer, no procedure, no fragment ----------------------------------
{
  const meter = stripOwnerInternalElectricalInspection('The fan spins but no heat points to the element. A qualified engineer can test continuity of the element with a multimeter.');
  check('16 continuity/multimeter procedure removed', !/continuity|multimeter/i.test(meter), meter);
  check('17 engineer referral retained without procedure', /engineer/i.test(meter), meter);
  const ownerInspect = stripOwnerInternalElectricalInspection('This looks like the rear element. Inspect the element inside the cavity for breaks.');
  check('18 owner internal inspection removed', !/inspect the element/i.test(ownerInspect), ownerInspect);
  const noFragment = stripOwnerInternalElectricalInspection('If damaged, which a qualified engineer should access. Test the element continuity with a multimeter.');
  check('19 result has no lowercase-start fragment', !/\.\s+[a-z]/.test(noFragment) || !/^[a-z]/.test(noFragment.split(/(?<=[.!?])\s+/).slice(1).join(' ') || 'X'), noFragment);
  const benign = 'With the dryer off, clean the lint filter and check the vent hose is clear.';
  check('20 benign owner-safe check untouched', stripOwnerInternalElectricalInspection(benign) === benign);
}

// 5) Single-primary-ask for vague openers -------------------------------------------------------
{
  const vague = { applianceType: 'dishwasher', needMoreInfo: true, candidateComponents: [], reportedSymptoms: ['My dishwasher is not working properly'], _jev: { decisions: { symptomFamily: 'uncertain' } } };
  preferSingleVagueClarify(vague, null, {});
  check('21 vague opener (symptomFamily uncertain, even with seeded reportedSymptoms) → one exclusive clarification', vague._exclusiveClarify === true && /main thing/i.test(vague.clarifyingQuestion), vague.clarifyingQuestion);
  const withSymptom = { applianceType: 'dishwasher', needMoreInfo: true, candidateComponents: [], _jev: { decisions: { symptomFamily: 'not_draining' } } };
  preferSingleVagueClarify(withSymptom, null, {});
  check('22 established symptom family → no vague clarify', !withSymptom._exclusiveClarify);
  const withFault = { applianceType: 'dishwasher', needMoreInfo: true, candidateComponents: [], _jev: { decisions: { symptomFamily: 'uncertain' } } };
  preferSingleVagueClarify(withFault, { faultId: 'x' }, {});
  check('23 grounded fault → no vague clarify', !withFault._exclusiveClarify);
  const promptVague = buildComposeSystem([], null, { applianceType: 'dishwasher', _exclusiveClarify: true, clarifyingQuestion: 'What is the main thing the dishwasher is doing wrong?' }, null, [], null, false, false, null, false, null, {});
  check('24 COMPOSE carries the one-question directive', /ONE QUESTION ONLY/i.test(promptVague) && /main thing/i.test(promptVague));
}

// 6) Electrical supply-trip corroboration oracle (basis for the ELECTRICAL CORROBORATION GUARD) ---
// A supply-trip STOP must be corroborated by real appliance-trips-the-electrics language; a PAST
// power cut / outage that has since been restored carries no such cue and must NOT escalate.
{
  check('25 past power cut (no trip cue) → not an electrical stop',
    classifySafetyStop('my electric oven won\u2019t heat up at all since the power cut') === null);
  check('26 "stopped working after a power cut" → not an electrical stop',
    classifySafetyStop('oven stopped working after a power cut') === null);
  const trip = classifySafetyStop('the washing machine trips the rcd every time');
  check('27 appliance trips the RCD → electrical supply-trip (still escalates)',
    trip && trip.category === 'electrical' && trip.reason === 'supply-trip', trip);
  const fuse = classifySafetyStop('it tripped the fuse box');
  check('28 appliance tripped the fuse box → electrical supply-trip', fuse && fuse.category === 'electrical', fuse);
}
// 8) Normal-behaviour: wet-plastics recognised on a complaint, genuine drying faults rejected ----
{
  const { matchNormalBehaviour, isWetPlasticsOnly } = require('../part-finder-lambda.js')._internal;
  const nb = (t) => { const r = matchNormalBehaviour({ applianceFamily: 'dishwasher' }, t); return r ? r.id : null; };
  check('wp1 plastics-not-drying complaint -> wet-plastics', nb('dishwasher not drying the plastic tubs properly, everything else is dry') === 'dishwasher:wet-plastics');
  check('wp2 glasses dry just plastics wet -> wet-plastics', nb('glasses and plates are dry, just plastics wet') === 'dishwasher:wet-plastics');
  check('wp3 everything wet+cold -> not reassured', nb('nothing is drying, everything comes out wet and cold') === null);
  check('wp4 plates+plastics all wet -> not reassured', nb('plates and plastics all still wet') === null);
  check('wp5 not-heating -> not reassured', nb('dishwasher not drying and not heating the water') === null);
  check('wp6 isWetPlasticsOnly guards crockery', isWetPlasticsOnly(' only the plastic containers come out wet ') === true && isWetPlasticsOnly(' plates and plastics all still wet ') === false);
}
// 9) Committed-conclusion backstop (surface typed component when COMPOSE didn't name it) ---------
{
  const { ensureCommittedConclusion } = require('../part-finder-lambda.js')._internal;
  const oc = ensureCommittedConclusion('so this is the point to bring in a qualified appliance engineer.',
    { model: 'ZOB35301XK', make: 'Zanussi', primaryFindingKind: 'component', candidateComponents: ['fan oven element'], provenGood: ['grill element'], primaryFinding: 'The fan oven is cold while the fan runs and the grill works, pointing to the fan oven element.' }, {});
  check('cc1 surfaces committed fan element + provenGood sibling note', /fan oven element/i.test(oc) && /grill/i.test(oc) && !/\.\s+[a-z]/.test(oc), oc);
  check('cc2 leaves reply naming the component unchanged',
    ensureCommittedConclusion('The fan oven element has failed; here is the part.', { model: 'X', primaryFindingKind: 'component', candidateComponents: ['fan oven element'] }, {}).startsWith('The fan oven element has failed'));
  check('cc3 no-op without a known model',
    ensureCommittedConclusion('x reply', { primaryFindingKind: 'component', candidateComponents: ['y'] }, {}) === 'x reply');
  check('cc4 no-op on a safety stop',
    ensureCommittedConclusion('x reply', { model: 'X', primaryFindingKind: 'component', candidateComponents: ['y'] }, { safetyStop: 'burning' }) === 'x reply');
}
// 7) Deterministic terminal render (decision/result from typed state, not COMPOSE) --------------
{
  const { renderDeterministicTerminal, naturalList, ownerSafeAdvice } = require('../part-finder-lambda.js')._internal;
  const { getKnowledgeRecord } = require('../retrieval.js');
  check('29 naturalList joins with or', naturalList(['a', 'b', 'c'], 'or') === 'a, b or c');
  // cannot-answer + grounded fault with safe advice -> conclusion + safe checks + non-looping close
  const td = renderDeterministicTerminal(
    { applianceType: 'tumble-dryer', faultId: 'overheating', _cannotAnswer: true, primaryFinding: '' },
    getKnowledgeRecord('tumble-dryer', 'overheating'), {});
  check('30 terminal gives safe checks + model close', td && /check/i.test(td) && /rating plate/i.test(td) && !/understood/i.test(td), td);
  // model known -> this terminal does not fire (commit path owns it)
  check('31 terminal skips when model known',
    renderDeterministicTerminal({ applianceType: 'tumble-dryer', faultId: 'overheating', _cannotAnswer: true, model: 'TVFS83CGP' }, getKnowledgeRecord('tumble-dryer', 'overheating'), {}) === null);
  // cordless split drops corded causes
  const vac = renderDeterministicTerminal(
    { applianceType: 'vacuum', faultId: 'wont-run', modelUnavailable: true, primaryFinding: '' },
    getKnowledgeRecord('vacuum', 'wont-run'), { cordless: true });
  check('32 cordless terminal drops mains-cable/plug-fuse', vac && !/mains cable|plug fuse/i.test(vac) && /battery|charger/i.test(vac), vac);
  // not a cannot-answer turn -> no terminal
  check('33 terminal skips on a normal diagnostic turn',
    renderDeterministicTerminal({ applianceType: 'tumble-dryer', faultId: 'overheating' }, getKnowledgeRecord('tumble-dryer', 'overheating'), {}) === null);
}
console.log(`scoped-evidence-quality: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
