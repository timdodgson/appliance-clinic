'use strict';
/**
 * Diagnostic presentation grain, evidence provenance, and safety-bounded actions.
 *
 * General capabilities (not the five frozen pilot transcripts):
 *   - observed vs inferred hazard
 *   - advice-only / retrieved candidates do not imply purchase
 *   - mention threshold separate from purchase
 *   - preserved-function evidence reaches COMPOSE
 *   - customer theory is not an observed fact
 *   - safety boundary suppresses unsafe customer action
 *   - prior replacement remains scoped
 *
 * Pure functions, no LLM, no network.
 * Run: node services/part-finder/test/diagnostic-presentation.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  classifyCustomerClaim, refineCustomerTheories, hazardProvenance, assertedHazardIsObserved,
  classifyRemoteActionClass, remoteActionBoundary, computePresentationGrain,
  applyPartReadinessProgression, presentableCandidateComponents, effectiveFindingKind, evidenceJustifiesComponent,
  classifySafetyStop, detectUnsafeIntent, formatTrustedCustomerEvidence, buildComposeSystem,
  normaliseIntent, INTENT_SCHEMA, COMPONENT_MENTION, REMOTE_ACTION, evidenceDecisive,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));

// ---------------------------------------------------------------------------
// A. Schema: grain + theories are first-class
// ---------------------------------------------------------------------------
check('A1 primaryFindingKind is required', (INTENT_SCHEMA.required || []).includes('primaryFindingKind'));
check('A2 customerTheories is required', (INTENT_SCHEMA.required || []).includes('customerTheories'));
check('A3 normaliseIntent defaults kind unknown and theories []', (() => {
  const n = normaliseIntent({});
  return n.primaryFindingKind === 'unknown' && Array.isArray(n.customerTheories) && n.customerTheories.length === 0;
})());

// ---------------------------------------------------------------------------
// B. Customer theory is not an observation
// ---------------------------------------------------------------------------
check('B1 "I think the fan is broken" is a theory', classifyCustomerClaim('I think the fan is broken') === 'theory');
check('B2 "I cannot hear the fan" is an observation', classifyCustomerClaim('I cannot hear the fan') === 'observation');
check('B3 measured temperature is stronger than a qualitative report', classifyCustomerClaim('the freezer is -18°C') === 'measured');
check('B4 qualitative "the freezer is cold" is an observation, not measured', classifyCustomerClaim('the freezer is cold') === 'observation');
{
  const n = normaliseIntent({
    reportedSymptoms: ['I think the board has gone', 'fridge warm'],
    customerTheories: [],
    facts: [{ name: 'fridgeOnlyWarm', value: 'TRUE' }],
  });
  check('B5 theory is stripped from reportedSymptoms', !n.reportedSymptoms.some((s) => /i think/i.test(s)));
  check('B6 theory lands in customerTheories, not facts', n.customerTheories.some((t) => /board/i.test(t)) && n.facts.every((f) => f.name !== 'board'));
}

// ---------------------------------------------------------------------------
// C. Observed vs inferred hazard provenance
// ---------------------------------------------------------------------------
check('C1 ignition sparking is not an observed burning hazard', hazardProvenance({ queryText: 'gas hob sparking on its own', safetyStop: null }) === 'none');
check('C2 burning smell is observed burning', hazardProvenance({ queryText: 'smells of burning plastic', safetyStop: 'burning' }) === 'observed');
check('C3 cannot assert burning as observed from sparking', assertedHazardIsObserved('burning', 'the hob keeps clicking and sparking') === false);
check('C4 can assert burning as observed from a burning smell', assertedHazardIsObserved('burning', 'hot plastic smell from the motor') === true);
check('C5 inferred stop without matching customer words is inferred', hazardProvenance({ queryText: 'it clicks sometimes', safetyStop: 'burning' }) === 'inferred');

// ---------------------------------------------------------------------------
// D. Advice-only / retrieved ≠ purchase; mention ≠ purchase
// ---------------------------------------------------------------------------
{
  const adviceFault = { faultId: 'poor-drying', node: node('dishwasher', 'poor-drying'), via: 'classified' };
  const grain = computePresentationGrain({
    intent: { candidateComponents: ['heater element', 'rinse-aid dispenser'], confidence: 0.8, primaryFindingKind: 'condition' },
    fault: adviceFault, committedFinding: true, outcome: 'ADVICE_ONLY',
  });
  check('D1 ADVICE_ONLY mention is none', grain.mention === COMPONENT_MENTION.NONE);
  check('D2 ADVICE_ONLY is not purchase-appropriate', grain.purchaseAppropriate === false);
  const presented = presentableCandidateComponents(
    ['heater element', 'rinse-aid dispenser'],
    ['heater element', 'ntc', 'main pcb'],
    grain,
  );
  check('D3 advice-only cannot leak retrieved components', presented.length === 0);
}
{
  const fanFault = { faultId: 'evaporator-fan', node: node('fridge-freezer', 'evaporator-fan'), via: 'classified' };
  const grain = computePresentationGrain({
    intent: {
      applianceType: 'fridge-freezer',
      candidateComponents: ['fan motor', 'defrost heater', 'control pcb'],
      confidence: 0.9,
      primaryFindingKind: 'component',
      facts: facts({ fridgeOnlyWarm: 'TRUE' }),
    },
    fault: fanFault, committedFinding: true, outcome: 'PART_ROUTING',
  });
  check('D4 split-cooling without decisive component evidence is not purchase', grain.purchaseAppropriate === false);
  check('D5 mention is none at subsystem grain', grain.mention === COMPONENT_MENTION.NONE);
  check('D6 curated catalogue list is not backfilled', presentableCandidateComponents(
    ['fan motor', 'pcb'], ['fan motor', 'fan blade', 'defrost heater', 'control pcb', 'defrost timer'], grain,
  ).length === 0);
}
{
  const drain = { faultId: 'not-draining', node: node('washing-machine', 'not-draining'), via: 'errorCode' };
  const grain = computePresentationGrain({
    intent: { userIntent: 'PART_REQUEST', candidateComponents: ['drain pump'], primaryFindingKind: 'component' },
    fault: drain, committedFinding: true, outcome: 'PART_ROUTING',
  });
  check('D7 direct part request remains purchase-appropriate', grain.mention === COMPONENT_MENTION.PURCHASE && grain.purchaseAppropriate === true);
  check('D8 purchase grain may backfill curated suspects', presentableCandidateComponents(
    ['drain pump'], ['drain pump', 'pump filter'], grain,
  ).includes('pump filter'));
}
check('D9 mention discuss does not backfill a shopping list', presentableCandidateComponents(
  ['element'], ['element', 'selector', 'pcb', 'thermostat', 'wiring'],
  { mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false },
).length === 1);

{
  const vac = { faultId: 'cuts-out', node: node('vacuum', 'cuts-out'), via: 'classified' };
  const opening = {
    applianceType: 'vacuum', make: 'Dyson', model: 'V6',
    userIntent: 'NEW_PROBLEM', primaryFindingKind: 'condition',
    candidateComponents: [], _nextAction: 'check', nextCheckCustomerSafe: true,
    furtherGenericCheckJustified: true, needMoreInfo: true,
    _partReadiness: 'diagnosis_only',
  };
  applyPartReadinessProgression(opening, vac);
  const openingGrain = computePresentationGrain({ intent: opening, fault: vac, committedFinding: true, outcome: 'PART_ROUTING' });
  check('D10 symptom-only opening remains advice/check first', openingGrain.purchaseAppropriate === false);

  const dirtyFilter = {
    applianceType: 'vacuum', make: 'Dyson', model: 'V6',
    userIntent: 'EVIDENCE_UPDATE', primaryFindingKind: 'subsystem',
    // Grounded replacement-evidence case as the real path produces it: the fault is decisively
    // grounded by the customer's structured facts (cutsOut supported; no-power/weak-suction against),
    // matching the live turn-2 diagnostic state. Without decisive grounding the product correctly
    // refuses to sell — the earlier 'condition'/no-facts fixture was an UNsupported case.
    facts: [{ name: 'cutsOut', value: 'TRUE' }, { name: 'noPower', value: 'FALSE' }, { name: 'weakSuction', value: 'FALSE' }],
    candidateComponents: [], _nextAction: 'check', nextCheckCustomerSafe: true,
    furtherGenericCheckJustified: true, needMoreInfo: true,
    nextBestCheck: 'Clean the filters and clear blockages',
    _partReadiness: 'replacement_evidence',
  };
  applyPartReadinessProgression(dirtyFilter, vac);
  const dirtyGrain = computePresentationGrain({ intent: dirtyFilter, fault: vac, committedFinding: true, outcome: 'PART_ROUTING' });
  check('D11 direct replacement evidence progresses beyond stale check',
    dirtyFilter._nextAction === 'replacement_evidence' && dirtyGrain.purchaseAppropriate === true);
  check('D12 replacement evidence carries grounded catalogue components',
    dirtyFilter.candidateComponents.includes('pre-motor filter'));

  const buyFilter = {
    applianceType: 'vacuum', make: 'Dyson', model: 'V6',
    userIntent: 'PART_REQUEST', primaryFindingKind: 'condition',
    candidateComponents: [], _nextAction: 'check', nextCheckCustomerSafe: true,
    furtherGenericCheckJustified: true, needMoreInfo: true,
    nextBestCheck: 'Clean the filters and clear blockages',
    _partReadiness: 'explicit_purchase',
  };
  applyPartReadinessProgression(buyFilter, vac);
  const buyGrain = computePresentationGrain({ intent: buyFilter, fault: vac, committedFinding: true, outcome: 'PART_ROUTING' });
  check('D13 explicit grounded purchase request supersedes stale diagnostic action',
    buyFilter.userIntent === 'PART_REQUEST' && buyFilter._nextAction === 'part_request' && buyGrain.purchaseAppropriate === true);
}

// ---------------------------------------------------------------------------
// E. Error-code authority still justifies a component (fit path intact)
// ---------------------------------------------------------------------------
{
  const fan = { faultId: 'evaporator-fan', node: node('fridge-freezer', 'evaporator-fan'), via: 'errorCode' };
  check('E1 error-code via justifies a component', evidenceJustifiesComponent(fan, { facts: [] }) === true);
  const grain = computePresentationGrain({
    intent: { candidateComponents: ['fan motor'], primaryFindingKind: 'component', facts: [] },
    fault: fan, committedFinding: true, outcome: 'PART_ROUTING',
  });
  check('E2 error-code grain is purchase', grain.mention === COMPONENT_MENTION.PURCHASE && grain.purchaseAppropriate === true);
  const stillChecking = computePresentationGrain({
    intent: {
      candidateComponents: ['fan motor'],
      primaryFindingKind: 'component',
      facts: [],
      _nextAction: 'check',
      nextCheckCustomerSafe: true,
      userIntent: 'PART_REQUEST',
    },
    fault: fan, committedFinding: true, outcome: 'PART_ROUTING',
  });
  check('E2b stale check still blocks purchase until semantic part progression is applied',
    stillChecking.purchaseAppropriate === false && stillChecking.mention === COMPONENT_MENTION.DISCUSS);
  applyPartReadinessProgression(stillChecking && {
    applianceType: 'washing-machine',
    make: 'Hotpoint',
    model: 'WMX123',
    userIntent: 'PART_REQUEST',
    candidateComponents: ['drain pump'],
    primaryFindingKind: 'component',
    facts: [],
    _nextAction: 'check',
    nextCheckCustomerSafe: true,
    furtherGenericCheckJustified: true,
    needMoreInfo: true,
    nextBestCheck: 'Check the filter first',
    _partReadiness: 'explicit_purchase',
  }, fan);
}

// ---------------------------------------------------------------------------
// F. Preserved-function evidence reaches COMPOSE
// ---------------------------------------------------------------------------
{
  const intent = {
    applianceType: 'oven-cooker',
    reportedSymptoms: ['grill works', 'fan oven cold'],
    provenGood: ['grill element'],
    alreadyReplaced: [],
    facts: facts({ heatsAtAll: 'TRUE' }),
    candidateComponents: ['fan oven element'],
    primaryFinding: 'heating path for fan oven is uncertain; grill still works',
    primaryFindingKind: 'subsystem',
    customerTheories: [],
    declinedFacts: [],
  };
  const block = formatTrustedCustomerEvidence(intent);
  check('F1 still-working reaches evidence block', /Still working/.test(block) && /grill element/.test(block));
  check('F2 finding grain reaches evidence block', /subsystem/.test(block));
  const prompt = buildComposeSystem([], null, intent, { faultId: 'element', node: node('oven-cooker', 'element'), via: 'classified' }, [], null, false, false, null, true, {
    mention: COMPONENT_MENTION.NONE, purchaseAppropriate: false, committedComponent: false,
  });
  check('F3 compose has cross-mode / preserved-function instruction', /PRESERVED FUNCTION|CROSS-MODE|still works/i.test(prompt));
  check('F4 compose does not dump a catalogue shopping list at none grain', !/COMPONENTS\/PARTS TO CONSIDER/.test(prompt));
  check('F5 compose forbids minting a usual culprit', /Do NOT lead with "the usual culprit"/i.test(prompt) || /do not still call it the usual culprit/i.test(prompt));
}

// ---------------------------------------------------------------------------
// G. Safety boundary suppresses unsafe customer action
// ---------------------------------------------------------------------------
{
  const cls = classifyRemoteActionClass({ applianceType: 'gas hob', queryText: 'hob keeps sparking' });
  check('G1 fuel-burning sparking is caution, not a hard stop', cls === REMOTE_ACTION.CAUTION);
  const b = remoteActionBoundary(cls, 'gas hob', 'hob keeps sparking');
  check('G2 out of scope includes gas controls / holding the knob', /gas|flame-failure|holding/i.test(b.outOfScope.join(' ')));
  check('G3 in scope allows accessible cleaning', /cleaning|observation/i.test(b.inScope.join(' ')));
  const prompt = buildComposeSystem([], null, { applianceType: 'gas hob', candidateComponents: ['thermocouple'], facts: [] }, { faultId: 'ignition', node: node('hobs', 'ignition'), via: 'classified' }, [], null, false, false, null, true, {
    mention: COMPONENT_MENTION.NONE, purchaseAppropriate: false,
  });
  check('G4 compose receives REMOTE ACTION BOUNDARY before DIY', /REMOTE ACTION BOUNDARY/.test(prompt));
  check('G5 compose must not instruct out-of-scope even with a warning appended', /Do NOT instruct an out-of-scope action even with a warning/i.test(prompt));
  check('G6 detectUnsafeIntent still flags live testing', detectUnsafeIntent('how do I test the element live') === true);
  check('G7 microwave HV family is caution', classifyRemoteActionClass({ applianceType: 'microwave', queryText: 'runs but no heat' }) === REMOTE_ACTION.CAUTION);
  check('G8 observed gas smell remains STOP_USE', classifyRemoteActionClass({ safetyStop: 'gas', applianceType: 'gas hob' }) === REMOTE_ACTION.STOP_USE);
}

// ---------------------------------------------------------------------------
// H. Prior replacement remains scoped; assistant/customer history not rewritten
// ---------------------------------------------------------------------------
{
  const intent = {
    reportedSymptoms: ['still leaking'],
    provenGood: [],
    alreadyReplaced: ['door seal'],
    facts: [],
    declinedFacts: [],
    customerTheories: [],
    primaryFinding: 'leak path still open after a door-seal replacement',
  };
  const block = formatTrustedCustomerEvidence(intent);
  check('H1 already replaced is present', /Already replaced/.test(block) && /door seal/.test(block));
  check('H2 replacement is down-ranked, not impossible', /do not treat as impossible/.test(block));
}

// ---------------------------------------------------------------------------
// I. Source guards — no journey ids or opener phrases
// ---------------------------------------------------------------------------
const SRC = require('./engine-source.cjs')();
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('I1 no RJ / WD-F / DW-G journey ids in product code', !/\bRJ-|WD-F-003|DW-G-002|FF-F-001|OV-F-002|OV-P-001/i.test(codeOnly));
check('I2 no Hoover / Nextra opener literals', !/nextra|hnwl7146|coat hanger/i.test(codeOnly));
check('I3 oven element knowledge no longer claims ~9/10', !/~9 out of 10/.test(JSON.stringify(node('oven-cooker', 'element').discriminators || [])));

console.log(`\ndiagnostic-presentation: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
