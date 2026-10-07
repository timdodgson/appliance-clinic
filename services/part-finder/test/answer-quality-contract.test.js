'use strict';
/**
 * ANSWER QUALITY / REASONING DISCRIMINATION contract (COMPOSE).
 *
 * A grounded (committed) diagnosis must read as expert triage: name the fault AREA, tie it to the
 * customer's OWN words, distinguish the SINGLE nearest realistic alternative (from the causes already
 * supplied) with the observation that separates them, and give the best safe next check — calibrated,
 * concise, anchored (no more-specific component than supplied, no invented symptom). This is a
 * presentation contract layered onto the EXISTING compose inputs (candidate components, distinguishing
 * details, evidence supports/against) — it introduces no new data, so grounding cannot loosen.
 *
 * These are PROMPT-STRING wiring tests (buildComposeSystem is pure): they prove the contract is
 * present exactly when a diagnosis is committed, and absent on the ask / safety / normal paths so the
 * previous premature-clarification, safety and normal-behaviour work is untouched.
 *
 * Run: node services/part-finder/test/answer-quality-contract.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const { buildComposeSystem, applianceKey } = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) pass++; else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); } }
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([n, v]) => ({ name: n, value: v }));
function faultObj(fam, id, via = 'evidence-commit') { return { faultId: id, node: node(fam, id), via }; }
function intentFor(fam, comps, extra = {}) {
  return { applianceType: fam, make: 'Bosch', confidence: 0.9, facts: extra.facts || [],
    candidateComponents: comps || [], alternatives: extra.alternatives || [], primaryFinding: extra.primaryFinding || null,
    reportedSymptoms: extra.reportedSymptoms || [] };
}

// ---------------------------------------------------------------------------
// A. Contract PRESENT when a diagnosis is committed.
// ---------------------------------------------------------------------------
{
  const fault = faultObj('washing-machine', 'motor-drum');
  const intent = intentFor('washing-machine', (fault.node.components || []).slice(0, 4), { facts: facts({ grindingNoise: 'TRUE', noiseOnSpin: 'TRUE' }) });
  const p = buildComposeSystem([], null, intent, fault, [], null, false, false, null, /*committed*/ true);
  check('A1 committed -> ANSWER SHAPE present', /ANSWER SHAPE/.test(p));
  check('A2 instructs single nearest alternative (not a list)', /nearest realistic alternative/i.test(p) && /exactly one alternative, not a list/i.test(p));
  check('A3 instructs tie to customer own words', /what the CUSTOMER THEMSELVES said/i.test(p));
  check('A4 anti-overcommit: no more-specific component', /do NOT substitute a different or MORE SPECIFIC component/i.test(p));
  check('A5 area-over-false-precision allowed', /calibrated .*points to.* beats a false-precise/i.test(p));
  check('A6 still calibrated + suppresses re-ask', /most likely/i.test(p) && /Do NOT ask another diagnostic question to re-establish/i.test(p));
}

// ---------------------------------------------------------------------------
// B. Contract ABSENT when NOT committed (ask path preserved).
// ---------------------------------------------------------------------------
{
  const fault = faultObj('washing-machine', 'motor-drum', 'symptom');
  const intent = intentFor('washing-machine', [], { facts: [] });
  const p = buildComposeSystem([], null, intent, fault, [], null, false, false, null, /*committed*/ false);
  check('B1 not committed -> no ANSWER SHAPE (ask path untouched)', !/ANSWER SHAPE/.test(p));
}

// ---------------------------------------------------------------------------
// C. Safety / normal paths never receive the diagnosis answer-shape (committed=false there).
// ---------------------------------------------------------------------------
{
  const p = buildComposeSystem([], null, intentFor('washing-machine', []), null, [], 'shock', false, false, null, false);
  check('C1 safety-stop path -> no ANSWER SHAPE', !/ANSWER SHAPE/.test(p) && /SAFETY FIRST|ELECTRICAL HAZARD|shock/i.test(p));
}
{
  const p = buildComposeSystem([], null, intentFor('dishwasher', []), null, [], null, false, /*normal*/ true, null, false);
  check('C2 normal-behaviour path -> no ANSWER SHAPE', !/ANSWER SHAPE/.test(p) && /REASSURANCE|normal/i.test(p));
}

// ---------------------------------------------------------------------------
// D. ADVICE_ONLY committed still gets the shape but stays advice-anchored (no invented part).
// ---------------------------------------------------------------------------
{
  const fault = faultObj('washer-dryer', 'drying-poor');
  if (fault.node) {
    const intent = intentFor('washer-dryer', (fault.node.components || []).slice(0, 2), { facts: facts({ heatPresent: 'TRUE' }) });
    const p = buildComposeSystem([], null, intent, fault, [], null, false, false, null, true);
    check('D1 advice-only committed -> ANSWER SHAPE present + ADVICE FIRST retained', /ANSWER SHAPE/.test(p) && /ADVICE FIRST/i.test(p));
  } else { pass++; }
}

console.log(`\nanswer-quality-contract: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
