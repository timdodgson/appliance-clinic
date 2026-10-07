'use strict';
/**
 * Oven / cooker diagnostic reasoning — structural contracts.
 *
 * Guards reusable domain grain, not benchmark wording:
 *   - ambiguous "oven dead" is not a component
 *   - flashing programmer / power-loss stays advice / no-part
 *   - fan-runs / no-heat is not unconditional purchase
 *   - cross-mode and top-oven vs grill evidence is preserved
 *   - preserved-function evidence reaches COMPOSE
 *   - tripping does not identify the selected element for purchase
 *   - electrical leakage/testing is out of scope
 *   - subsystem / discuss grain does not leak catalogue shopping lists
 *
 * Pure functions, no LLM, no network.
 * Run: node services/part-finder/test/oven-diagnostic-reasoning.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  computePresentationGrain, presentableCandidateComponents, evidenceJustifiesComponent,
  effectiveFindingKind, commitFromEvidence, materialAmbiguity, evidenceDecisive,
  classifyRemoteActionClass, remoteActionBoundary, detectUnsafeIntent,
  detectSafetyStop, stripOutOfScopeElectricalTests,
  buildComposeSystem, formatTrustedCustomerEvidence, COMPONENT_MENTION, REMOTE_ACTION,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (id) => CAT.faults['oven-cooker'][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const ovFault = (id, via = 'classified') => ({ faultId: id, node: node(id), via });
const grain = (opts) => computePresentationGrain(opts);

// ---------------------------------------------------------------------------
// A. Catalogue structure: oven-dead / programmer / path / topology
// ---------------------------------------------------------------------------
check('A1 clock-timer is ADVICE_ONLY', node('clock-timer').outcome === 'ADVICE_ONLY');
check('A2 clock-timer flashing is STRONG_SUPPORT', (node('clock-timer').signals || []).some((s) => s.fact === 'clockFlashing' && s.effect === 'STRONG_SUPPORT'));
check('A3 element clock-flashing is STRONG_AGAINST', (node('element').signals || []).some((s) => s.fact === 'clockFlashing' && s.effect === 'STRONG_AGAINST'));
check('A4 element fanSpinning is SUPPORT not STRONG', (node('element').signals || []).some((s) => s.fact === 'fanSpinning' && s.effect === 'SUPPORT'));
check('A5 element top-oven heat is STRONG_AGAINST a simple open element', (node('element').signals || []).some((s) => s.fact === 'topOvenHeats' && s.effect === 'STRONG_AGAINST'));
check('A6 selector keeps cross-mode SUPPORT', (node('selector-switch').signals || []).some((s) => s.fact === 'topOvenHeats' && s.effect === 'SUPPORT')
  && (node('selector-switch').signals || []).some((s) => s.fact === 'grillPartial' && s.effect === 'SUPPORT'));
check('A7 selector universe includes control/supply path not only element', {
  comps: (node('selector-switch').components || []).join(' ').toLowerCase(),
}.comps.includes('selector') && /regulator|wiring/.test((node('selector-switch').components || []).join(' ').toLowerCase()));
check('A8 element knowledge keeps supply/control path', /selector|switch|wiring|connector/i.test((node('element').discriminators || []).join(' ')));
check('A9 top-oven vs grill topology is in element knowledge', /series|half mains|top-oven/i.test((node('element').discriminators || []).join(' ')));
check('A10 oven-dead ambiguity is on main-pcb', /ambiguous|display|flashing/i.test((node('main-pcb').discriminators || []).join(' ')));
check('A11 tripping does not treat selected function as proof', /not proof|NOT proof|does not identify/i.test((node('tripping-electrics').discriminators || []).join(' ')));

// ---------------------------------------------------------------------------
// B. Ambiguous oven-dead is not a component / purchase
// ---------------------------------------------------------------------------
{
  const g = grain({
    intent: {
      applianceType: 'oven-cooker',
      primaryFindingKind: 'unknown',
      candidateComponents: ['main pcb'],
      facts: [],
    },
    fault: ovFault('main-pcb'),
    committedFinding: false,
    outcome: 'PART_ROUTING',
  });
  check('B1 oven-dead without established observations is mention none', g.mention === COMPONENT_MENTION.NONE);
  check('B2 oven-dead without observations is not purchase', g.purchaseAppropriate === false);
}

{
  const amb = materialAmbiguity('main-pcb', node('main-pcb'), [], 'oven-cooker');
  check('B3 completely-dead leader asks programmer/display discriminator vs advice-only clock', amb && amb.altId === 'clock-timer' && amb.fact === 'clockFlashing', amb);
}

{
  const amb = materialAmbiguity('element', node('element'), [], 'oven-cooker');
  check('B4 heating-path leader asks flashing-programmer before a part', amb && amb.altId === 'clock-timer' && (amb.fact === 'clockFlashing' || amb.fact === 'programmerAuto'), amb);
}

// ---------------------------------------------------------------------------
// C. Flashing programmer / power-loss remains advice / no-part
// ---------------------------------------------------------------------------
{
  const committed = commitFromEvidence({ facts: facts({ clockFlashing: 'TRUE', recentPowerLoss: 'TRUE' }) }, 'oven-cooker');
  check('C1 flashing + power-loss commits clock-timer', committed && committed.faultId === 'clock-timer', committed && committed.faultId);
  const g = grain({
    intent: {
      applianceType: 'oven-cooker',
      primaryFindingKind: 'usage',
      candidateComponents: ['timer', 'control pcb'],
      facts: facts({ clockFlashing: 'TRUE', recentPowerLoss: 'TRUE' }),
    },
    fault: committed || ovFault('clock-timer'),
    committedFinding: true,
    outcome: 'ADVICE_ONLY',
  });
  check('C0 flashing programmer opener is not a burning safety stop', detectSafetyStop('The oven will not heat since the power cut last night. The clock is flashing.') === null);
  check('C2 flashing programmer mention is none', g.mention === COMPONENT_MENTION.NONE);
  check('C3 flashing programmer is not purchase', g.purchaseAppropriate === false);
  check('C4 advice grain cannot leak catalogue suspects', presentableCandidateComponents(
    ['timer'], ['timer', 'control pcb', 'fan oven element'], g,
  ).length === 0);
}

check('C5 flashing clock contradicts an element commit', (() => {
  const c = commitFromEvidence({ facts: facts({ clockFlashing: 'TRUE', fanSpinning: 'TRUE' }) }, 'oven-cooker');
  return c && c.faultId === 'clock-timer';
})());

// ---------------------------------------------------------------------------
// D. Fan runs / no heat is not unconditional purchase
// ---------------------------------------------------------------------------
{
  const intent = {
    applianceType: 'oven-cooker',
    primaryFindingKind: 'component',
    candidateComponents: ['fan oven element'],
    facts: facts({ fanSpinning: 'TRUE' }),
  };
  const fault = ovFault('element');
  check('D1 fan-runs/no-heat is not decisive component evidence', evidenceJustifiesComponent(fault, intent) === false);
  check('D2 claimed component without decisive evidence becomes subsystem', effectiveFindingKind(intent, fault, true) === 'subsystem');
  const g = grain({ intent, fault, committedFinding: true, outcome: 'PART_ROUTING' });
  check('D3 fan-runs/no-heat is not purchase grain', g.purchaseAppropriate === false && g.mention === COMPONENT_MENTION.NONE);
  check('D4 fan-runs/no-heat does not evidence-commit an element', commitFromEvidence({ facts: intent.facts }, 'oven-cooker') == null);
}

check('D5 element node still lists selector/wiring as well as elements', {
  comps: (node('element').components || []).join(' ').toLowerCase(),
}.comps.includes('fan oven element') && /selector|connector/.test((node('element').components || []).join(' ').toLowerCase()));

// ---------------------------------------------------------------------------
// E. Cross-mode / top-oven vs grill evidence is preserved
// ---------------------------------------------------------------------------
{
  const intent = {
    applianceType: 'oven-cooker',
    reportedSymptoms: ['grill only partly heats in grill mode', 'top oven heats normally'],
    provenGood: [],
    facts: facts({ topOvenHeats: 'TRUE', grillPartial: 'TRUE', grillModeHeats: 'FALSE' }),
    candidateComponents: ['grill element'],
    primaryFinding: 'same upper-cavity heating system heats in top-oven mode but grill-mode is incomplete',
    primaryFindingKind: 'subsystem',
    customerTheories: [],
    declinedFacts: [],
  };
  const block = formatTrustedCustomerEvidence(intent);
  check('E1 top-oven heat reaches evidence block', /top-oven|upper cavity heats/i.test(block));
  check('E2 partial grill reaches evidence block', /partly heats|grill only/i.test(block));
  check('E3 top-oven heat argues against a simple open element', evidenceDecisive(node('element'), intent.facts) === false);
  check('E4 element is not evidence-committed from cross-mode heat', commitFromEvidence({ facts: intent.facts }, 'oven-cooker') == null);
  const g = grain({
    intent: { ...intent, primaryFindingKind: 'component', candidateComponents: ['grill element'] },
    fault: ovFault('element'),
    committedFinding: true,
    outcome: 'PART_ROUTING',
  });
  check('E5 cross-mode split is not purchase of the element', g.purchaseAppropriate === false);
  const prompt = buildComposeSystem([], null, intent, ovFault('element'), [], null, false, false, null, true, {
    mention: COMPONENT_MENTION.NONE, purchaseAppropriate: false, committedComponent: false,
  });
  check('E6 compose keeps oven electrical-path / series-vs-grill instruction', /OVEN ELECTRICAL PATH|series vs full mains|top-oven/i.test(prompt));
  check('E7 compose does not dump catalogue shopping list at none grain', !/COMPONENTS\/PARTS TO CONSIDER/.test(prompt));
  check('E8 selector remains a live alternative in knowledge, not a deterministic winner', /not a deterministic selector|do not conclude/i.test((node('selector-switch').discriminators || []).join(' ')));
}

// ---------------------------------------------------------------------------
// F. Preserved-function evidence
// ---------------------------------------------------------------------------
{
  const intent = {
    applianceType: 'oven-cooker',
    reportedSymptoms: ['grill works', 'fan oven cold'],
    provenGood: ['grill element'],
    facts: facts({ anyHeatingFunction: 'TRUE', fanOvenHeats: 'FALSE' }),
    candidateComponents: ['fan oven element'],
    primaryFinding: 'fan-oven heating path is uncertain; grill still works',
    primaryFindingKind: 'subsystem',
    customerTheories: [],
    declinedFacts: [],
  };
  const block = formatTrustedCustomerEvidence(intent);
  check('F1 still-working grill is preserved', /Still working/.test(block) && /grill element/.test(block));
  check('F2 finding grain is subsystem not generic not-heating', /subsystem/.test(block));
  const prompt = buildComposeSystem([], null, intent, ovFault('element'), [], null, false, false, null, true, {
    mention: COMPONENT_MENTION.NONE, purchaseAppropriate: false, committedComponent: false,
  });
  check('F3 compose is instructed to use preserved function', /PRESERVED FUNCTION|CROSS-MODE/i.test(prompt));
}

// ---------------------------------------------------------------------------
// G. Tripping does not identify the selected element; safety boundary
// ---------------------------------------------------------------------------
{
  const intent = {
    applianceType: 'oven-cooker',
    primaryFindingKind: 'component',
    candidateComponents: ['grill element'],
    facts: facts({ tripsElectrics: 'TRUE' }),
  };
  const fault = ovFault('tripping-electrics');
  const remote = classifyRemoteActionClass({
    applianceType: 'oven-cooker', faultId: 'tripping-electrics', facts: intent.facts,
  });
  check('G1 tripping remote action is competent-person', remote === REMOTE_ACTION.COMPETENT_PERSON);
  const g = grain({
    intent, fault, committedFinding: true, outcome: 'PART_ROUTING', remoteAction: remote,
  });
  check('G2 tripping is not purchase of the selected element', g.purchaseAppropriate === false && g.mention === COMPONENT_MENTION.NONE);
  check('G3 STOP_USE safety card also forces none', grain({
    intent, fault, committedFinding: true, outcome: 'PART_ROUTING',
  }).mention === COMPONENT_MENTION.NONE);
  check('G4 presentable candidates empty at none grain', presentableCandidateComponents(
    ['grill element'], ['grill element', 'base element', 'fan oven element'], g,
  ).length === 0);
  const prompt = buildComposeSystem([], null, intent, fault, [], null, false, false, null, true, g);
  check('G5 compose boundary forbids live / insulation tests', /insulation-resistance|live electrical testing/i.test(prompt));
  check('G6 insulation-test request is unsafe intent', detectUnsafeIntent('how do I megger the grill element') === true);
  check('G7 live test remains unsafe', detectUnsafeIntent('how do I test the element live') === true);
  const b = remoteActionBoundary(REMOTE_ACTION.COMPETENT_PERSON, 'oven-cooker', 'trips when grill is on');
  check('G8 insulation testing is out of scope', /insulation-resistance|megger/i.test(b.outOfScope.join(' ')));
  check('G9 compose forbids naming megger as the electrician method', /Never name insulation-resistance|never name insulation-resistance/i.test(prompt));
  check('G10 strip insulation-test sentence from customer reply', (() => {
    const a = stripOutOfScopeElectricalTests(
      'Stop using the grill. A qualified electrician must perform an insulation resistance test to identify the component.',
    );
    const b = stripOutOfScopeElectricalTests(
      'Stop using it. A qualified electrician must perform insulation testing to identify the leaking component.',
    );
    return /Stop using the grill/i.test(a) && !/insulation/i.test(a)
      && /Stop using it/i.test(b) && !/insulation/i.test(b);
  })());
}

// ---------------------------------------------------------------------------
// H. No automatic catalogue leakage from subsystem / discuss grain
// ---------------------------------------------------------------------------
check('H1 discuss grain does not backfill a shopping list', presentableCandidateComponents(
  ['fan oven element'], ['fan oven element', 'selector switch', 'thermostat', 'main pcb', 'wiring'],
  { mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false },
).length === 1);
check('H2 none grain leaks nothing', presentableCandidateComponents(
  ['fan oven element'], ['fan oven element', 'selector switch'],
  { mention: COMPONENT_MENTION.NONE, purchaseAppropriate: false },
).length === 0);
{
  const prompt = buildComposeSystem(
    [{ title: 'Grill Element', partNumber: 'X1' }],
    { model: 'EXAMPLE' },
    {
      applianceType: 'oven-cooker',
      primaryFindingKind: 'subsystem',
      candidateComponents: ['grill element', 'selector switch'],
      facts: facts({ topOvenHeats: 'TRUE', grillPartial: 'TRUE' }),
    },
    ovFault('element'),
    [], null, false, false, null, true,
    { mention: COMPONENT_MENTION.NONE, purchaseAppropriate: false, committedComponent: false },
  );
  check('H3 none grain forbids component names / catalogue cards', /do not mention replacement components/i.test(prompt));
  check('H4 none grain does not require a catalogue link', !/MANDATORY when CATALOGUE DATA/.test(prompt));
}

console.log(`\noven-diagnostic-reasoning: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
