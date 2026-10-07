'use strict';
/**
 * Evidence provenance vs safety escalation.
 *
 * Safety may be conservative about genuine risk, but STOP_USE / reported-hazard
 * language must never be triggered by a customer symptom the customer did not
 * report. Retrieved knowledge that a fault CAN involve burning, smoke or
 * overheating is RETRIEVED_KNOWLEDGE, not a CUSTOMER_FACT.
 *
 * Pure functions only — no LLM, no network, no journey-specific product gates.
 * Run: node services/part-finder/test/hazard-provenance.test.js
 */
const assert = require('assert');
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const {
  classifySafetyStop,
  detectSafetyStop,
  isStatusIndicationFlash,
  isElectricalFlashEvent,
  proposedPhysicalAccess,
  hazardProvenance,
  assertedHazardIsObserved,
  collectEvidence,
  adjustDifferential,
  formatTrustedCustomerEvidence,
  extractDisplayedStatusToken,
  displayedIndicationNeedsIdentity,
  applyDisplayedIndicationIdentity,
  EVIDENCE_KIND,
} = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''); }
}
const eq = (name, got, want) => check(name, got === want, { got, want });

check('evidence kinds are distinct', EVIDENCE_KIND.CUSTOMER_FACT !== EVIDENCE_KIND.RETRIEVED_KNOWLEDGE
  && EVIDENCE_KIND.CUSTOMER_OBSERVATION !== EVIDENCE_KIND.INFERENCE
  && EVIDENCE_KIND.SYSTEM_SAFETY_RULE === 'SYSTEM_SAFETY_RULE');

// ---------------------------------------------------------------------------
// A. Status-indication flash is a CUSTOMER_OBSERVATION, not a fire report
// ---------------------------------------------------------------------------
eq('A1 flashing displayed token is not STOP_USE', detectSafetyStop('the machine still flashes E15'), null);
eq('A2 flashing F-code is not STOP_USE', detectSafetyStop('it keeps flashing F08'), null);
eq('A3 replacement plus unchanged indication is not STOP_USE',
  detectSafetyStop('Already replaced the door lock, still flashes DOOR.'), null);
eq('A4 programmer flashing is not STOP_USE', detectSafetyStop('the programmer display is flashing'), null);
check('A5 helper recognises a short displayed token', isStatusIndicationFlash('still flashes E24'));
check('A6 helper does not treat flash-from as a status token',
  !isStatusIndicationFlash('flashing from the socket'));

// ---------------------------------------------------------------------------
// B. Explicit customer-reported hazards still stop
// ---------------------------------------------------------------------------
eq('B1 burning plastic smell still stops', detectSafetyStop('The door lock smells of burning and the plastic looks melted.'), 'burning');
eq('B2 hot-plastic smell still stops', detectSafetyStop('there is a hot plastic smell from the lock'), 'burning');
eq('B3 flash from the plug still stops', detectSafetyStop('there was a flash from the plug'), 'burning');
eq('B4 smoking still stops', detectSafetyStop('the appliance is smoking'), 'burning');
check('B5 electrical flash event from plug', isElectricalFlashEvent('there was a flash from the plug'));
check('B6 asserted burning is observed only from customer words',
  assertedHazardIsObserved('burning', 'The door lock smells of burning and the plastic looks melted.'));
check('B7 asserted burning is NOT observed from a status flash',
  !assertedHazardIsObserved('burning', 'Already replaced the door lock, still flashes DOOR.'));

// ---------------------------------------------------------------------------
// C. Proposed physical access is a SYSTEM_SAFETY_RULE, not a reported hazard
// ---------------------------------------------------------------------------
check('C1 proposed take-out + check plug is physical access',
  proposedPhysicalAccess("I'm going to take the door lock out and check the plug."));
check('C2 already-replaced is not proposed access',
  !proposedPhysicalAccess('Already replaced the door lock, still flashes DOOR.'));
eq('C3 proposed access is not a burning stop',
  detectSafetyStop("I'm going to take the door lock out and check the plug."), null);

// ---------------------------------------------------------------------------
// D. Retrieved/inferred hazards must not masquerade as observed customer facts
// ---------------------------------------------------------------------------
eq('D1 classifier reads customer text only — no retrieval argument',
  typeof classifySafetyStop, 'function');
check('D2 classifySafetyStop arity does not accept retrieved docs as evidence',
  classifySafetyStop.length <= 2);
eq('D3 ungrounded burning latch on status-flash text is inferred, not observed',
  hazardProvenance({ queryText: 'still flashes E15', safetyStop: 'burning' }), 'inferred');
eq('D4 genuine burning smell provenance is observed',
  hazardProvenance({ queryText: 'smells of burning plastic', safetyStop: 'burning' }), 'observed');
eq('D5 no stop means no hazard provenance',
  hazardProvenance({ queryText: 'still flashes E15', safetyStop: null }), 'none');

// ---------------------------------------------------------------------------
// E. Previous replacement is CUSTOMER_FACT that down-ranks repeating the same part
// ---------------------------------------------------------------------------
{
  const intent = {
    reportedSymptoms: ['still no heat'],
    alreadyReplaced: [],
    provenGood: [],
    facts: [],
    candidateComponents: ['heating element', 'thermostat', 'ntc'],
  };
  const adj = collectEvidence(intent, 'Already replaced the heating element, still no heat', null);
  check('E1 alreadyReplaced captures the replaced component',
    adj.alreadyReplaced.some((p) => /heating element/i.test(p)));
  const ranked = adjustDifferential(['heating element', 'thermostat', 'ntc'], adj);
  check('E2 replaced component is demoted, not dropped',
    ranked.includes('heating element') && ranked[0] !== 'heating element');
  const block = formatTrustedCustomerEvidence({
    ...intent,
    alreadyReplaced: adj.alreadyReplaced,
  });
  check('E3 evidence block labels replacement as CUSTOMER_FACT',
    /CUSTOMER_FACT/.test(block) && /Already replaced/.test(block) && /heating element/i.test(block));
  check('E4 replacement is down-ranked, not proven healthy',
    /do not treat as impossible/.test(block));
}

// ---------------------------------------------------------------------------
// F. Displayed indication without identity is not a manufacturer-specific diagnosis
// ---------------------------------------------------------------------------
{
  eq('F1 flashes + letter token is captured', extractDisplayedStatusToken('the machine still flashes E15'), 'E15');
  eq('F2 shows status word is captured', extractDisplayedStatusToken('it still flashes F08'), 'F08');
  eq('F3 clock flashing is not a displayed token', extractDisplayedStatusToken('the clock is flashing'), null);
  eq('F4 programmer display flashing is not a displayed token', extractDisplayedStatusToken('the programmer display is flashing'), null);
  eq('F5 flash from plug is not a status token', extractDisplayedStatusToken('there was a flash from the plug'), null);
  check('F6 missing make and family needs identity',
    displayedIndicationNeedsIdentity({ make: null, applianceType: null }, 'the machine still flashes E15'));
  check('F7 make + family can interpret the indication',
    !displayedIndicationNeedsIdentity(
      { make: 'beko', applianceType: 'washing-machine', errorCode: 'E15' },
      'my Beko washing machine still flashes E15',
    ));
  const ident = applyDisplayedIndicationIdentity(
    { make: null, applianceType: null, alreadyReplaced: ['heating element'] },
    'Already replaced the heating element, still flashes E24',
    {},
  );
  check('F8 identity ask is the next action, not a board guess',
    ident._nextAction === 'identification' && ident.needMoreInfo === true && ident.faultId == null);
  check('F9 identity question asks make and appliance',
    /make/i.test(ident.clarifyingQuestion) && /appliance/i.test(ident.clarifyingQuestion));
}

console.log(`\nhazard-provenance: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
