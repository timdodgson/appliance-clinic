'use strict';
/**
 * Regression tests for ERROR-CODE → COMPONENT resolution + authority propagation.
 *
 * Evidence (FF-010): Samsung fridge/freezer code 22E should point to the evaporator-fan system.
 * The authoritative mapping already existed (errorCodes.samsung["fridge-freezer"]["22E"] =
 * "evaporator-fan"), but the runtime lost it at COMPOSE: the UNDERSTAND model's free-text guess
 * about the code (e.g. "comms/PCB fault") was ranked ABOVE the catalogue node's curated components,
 * so the customer got the wrong diagnosis. Root cause = authority propagation, NOT missing data.
 *
 * Fix under test:
 *   - authoritativeCodeComponents(): when a fault is resolved via a brand error-code table, the node's
 *     curated components LEAD the differential (a manufacturer code mapping outranks the model guess);
 *     for non-errorCode faults the model's evidence order is preserved (scoping).
 *   - applianceKey(): fridge-freezer synonyms added so real phrasings ("American fridge freezer",
 *     "fridge", "freezer", "refrigerator", "fridge/freezer") normalise and the code resolves.
 *   - faults-catalogue.json: documented Samsung E/C display variants completed (21C/22C/24C...).
 *
 * Pure/deterministic — no LLM, no network. Run: node services/part-finder/test/error-code-component.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  resolveFault, applianceKey, authoritativeCodeComponents, guessErrorCode, upgradeErrorCodeFromText,
  retainCustomerErrorCode,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const rf = (applianceType, make, errorCode) => resolveFault({ applianceType, make, errorCode });
const isFan = (c) => /\bfan\b/.test(String(c).toLowerCase());

// ---------------------------------------------------------------------------
// A. Samsung fridge/freezer 22E resolves to the evaporator-fan node via the error code.
// ---------------------------------------------------------------------------
{
  const f = rf('fridge-freezer', 'Samsung', '22E');
  check('A 22E resolves', !!f && f.faultId === 'evaporator-fan' && f.via === 'errorCode', f && { id: f.faultId, via: f.via });
  check('A evaporator-fan node has a fan component', !!f && (f.node.components || []).some(isFan), f && f.node && f.node.components);
}

// ---------------------------------------------------------------------------
// B. Formatting variants resolve appropriately (norm strips spaces/case; C variant is documented).
// ---------------------------------------------------------------------------
for (const v of ['22E', '22 E', '22e', ' 22E ', '22C']) {
  const f = rf('fridge-freezer', 'Samsung', v);
  check(`B variant "${v}" -> evaporator-fan`, !!f && f.faultId === 'evaporator-fan' && f.via === 'errorCode', f && f.faultId);
}
// applianceKey normalises real fridge-freezer phrasings (the FF-010 scenario says "American fridge freezer").
for (const [phrase, expect] of [
  ['fridge-freezer', 'fridge-freezer'], ['fridge freezer', 'fridge-freezer'], ['American fridge freezer', 'fridge-freezer'],
  ['fridge', 'fridge-freezer'], ['freezer', 'fridge-freezer'], ['refrigerator', 'fridge-freezer'], ['fridge/freezer', 'fridge-freezer'],
]) check(`B applianceKey("${phrase}")`, applianceKey(phrase) === expect, applianceKey(phrase));
check('B "American fridge freezer" + "22 E" resolves end-to-end', (() => { const f = rf('American fridge freezer', 'Samsung', '22 E'); return f && f.faultId === 'evaporator-fan' && f.via === 'errorCode'; })());

// ---------------------------------------------------------------------------
// C. Same code under ANOTHER manufacturer does NOT inherit the Samsung meaning.
// ---------------------------------------------------------------------------
{
  const lg = rf('fridge-freezer', 'LG', '22E');
  check('C LG 22E does NOT resolve to Samsung evaporator-fan via errorCode', !(lg && lg.via === 'errorCode' && lg.faultId === 'evaporator-fan'), lg && { id: lg.faultId, via: lg.via });
}

// ---------------------------------------------------------------------------
// D. Same code under an UNRELATED appliance family does NOT inherit the Samsung fridge meaning.
// ---------------------------------------------------------------------------
{
  const wm = rf('washing-machine', 'Samsung', '22E'); // Samsung WM table has no 22E
  check('D Samsung washing-machine 22E does NOT resolve to evaporator-fan', !(wm && wm.faultId === 'evaporator-fan'), wm && { id: wm.faultId, via: wm.via });
}

// ---------------------------------------------------------------------------
// E. Resolution works from family+make+code without needing a model (no model-specific split for 22E),
//    and manufacturer context is REQUIRED (a bare code with no make cannot resolve).
// ---------------------------------------------------------------------------
check('E resolves with make+code, no model needed', (() => { const f = rf('fridge-freezer', 'Samsung', '22E'); return !!f && f.via === 'errorCode'; })());
check('E bare code with NO make does not resolve via errorCode', (() => { const f = resolveFault({ applianceType: 'fridge-freezer', errorCode: '22E' }); return !(f && f.via === 'errorCode'); })());

// ---------------------------------------------------------------------------
// F + G. Error-code result provides the correct canonical component candidate AND it LEADS
//        (authoritative code beats the model's free-text guess). Scoping: non-errorCode preserved.
// ---------------------------------------------------------------------------
{
  const f = rf('fridge-freezer', 'Samsung', '22E');
  const modelGuess = ['main pcb', 'display board']; // what the LLM mis-guessed for 22E
  const out = authoritativeCodeComponents(f, modelGuess);
  check('F leads with a fan component (authoritative)', isFan(out[0]), out);
  check('G authoritative node components precede the model guess', out.indexOf('main pcb') >= (f.node.components || []).length, out);
  check('G model extras are retained (appended, not dropped)', out.includes('main pcb') && out.includes('display board'), out);
  // Scoping: a symptom/classified fault keeps the model's evidence order unchanged.
  const symptomFault = { via: 'classified', faultId: 'x', node: { components: ['fan motor'] } };
  const symOut = authoritativeCodeComponents(symptomFault, ['pump filter', 'drain pump']);
  check('G scoping: non-errorCode fault keeps model order', JSON.stringify(symOut) === JSON.stringify(['pump filter', 'drain pump']), symOut);
}

// ---------------------------------------------------------------------------
// H + I. COMPOSE receives the authoritative code/component evidence, and it is CALIBRATED
//        (code INDICATES an area — does NOT prove a specific part failed). Source guards on the
//        orchestrator (buildComposeSystem is not exported; assert the wired behaviour in source).
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
  check('H COMPOSE states the authoritative meaning of the code', /THIS IS THE AUTHORITATIVE MEANING of the code/.test(src));
  check('H handler applies authoritativeCodeComponents for via==errorCode', /fault\.via === 'errorCode'[\s\S]{0,220}authoritativeCodeComponents\(fault, intent\.candidateComponents\)/.test(src));
  check('H handler drops the model primaryFinding for an authoritative code', /errorCodeAuthoritative/.test(src) && /intent\.primaryFinding = null;/.test(src));
  check('I calibration: code indicates an area, does NOT prove a part failed', /does NOT prove a specific part has failed/.test(src));
}

// ---------------------------------------------------------------------------
// J. Unknown code falls back safely (no resolution, no crash).
// ---------------------------------------------------------------------------
check('J unknown Samsung fridge code ZZ9 does not resolve via errorCode', (() => { const f = rf('fridge-freezer', 'Samsung', 'ZZ9'); return !(f && f.via === 'errorCode'); })());
check('J unknown code returns null-ish, never throws', (() => { try { rf('fridge-freezer', 'Samsung', ''); return true; } catch { return false; } })());

// ---------------------------------------------------------------------------
// K. Ambiguous manufacturer/code — no make means the code cannot be trusted (needs clarification upstream).
// ---------------------------------------------------------------------------
check('K unknown appliance family for a code does not resolve', (() => { const f = resolveFault({ applianceType: 'toaster', make: 'Samsung', errorCode: '22E' }); return !(f && f.via === 'errorCode'); })());

// ---------------------------------------------------------------------------
// L. Safety precedence is computed independently of code resolution (source guard): an error-code
//    resolution must not bypass the deterministic safety-stop / normal-behaviour precedence.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
  check('L safetyStop is evaluated and wins the outcome regardless of fault', /outcome = safetyStop \? 'SAFETY_STOP'/.test(src));
  check('L a RESOLVED error code still blocks the normal-behaviour override (prev-work guard)', /normalByKnowledge = Boolean\(nbMatch\) && !safetyStop && !resolvedErrorCode/.test(src));
}

// ---------------------------------------------------------------------------
// M. Existing known-good error codes still resolve (no regression from the change).
// ---------------------------------------------------------------------------
for (const [appl, make, code, want] of [
  ['dishwasher', 'Bosch', 'E24', 'not-draining'],       // bsh family
  ['washing-machine', 'Samsung', '4E', 'inlet-valve'],
  ['washing-machine', 'Bosch', 'E18', 'not-draining'],
  ['fridge-freezer', 'Samsung', '24E', 'defrost-system'],
  ['fridge-freezer', 'Samsung', '2E', 'temperature-sensor'],
]) {
  const f = rf(appl, make, code);
  check(`M ${make} ${appl} ${code} -> ${want}`, !!f && f.faultId === want && f.via === 'errorCode', f && { id: f.faultId, via: f.via });
}

// ---------------------------------------------------------------------------
// MUTATION-STYLE PROOFS
// ---------------------------------------------------------------------------
// (i) remove 22E authoritative knowledge -> FF-010 fails: the mapping must EXIST in the data, and
//     removing it would make resolveFault('22E') stop returning evaporator-fan.
check('MUT-i 22E authoritative mapping exists in faults-catalogue', CAT.errorCodes.samsung['fridge-freezer']['22E'] === 'evaporator-fan');
check('MUT-i 22C documented display variant present', CAT.errorCodes.samsung['fridge-freezer']['22C'] === 'evaporator-fan');
// (ii) remove component mapping -> component expectation fails: authoritativeCodeComponents depends on
//      the node's components; a node with no fan component cannot lead with a fan.
{
  const noFanFault = { via: 'errorCode', faultId: 'evaporator-fan', node: { components: ['control pcb', 'wiring'] } };
  const out = authoritativeCodeComponents(noFanFault, []);
  check('MUT-ii node without a fan component cannot lead with a fan', !isFan(out[0]), out);
  check('MUT-ii real evaporator-fan node DOES carry a fan component', (CAT.faults['fridge-freezer']['evaporator-fan'].components || []).some(isFan));
}
// (iii) ignore manufacturer context -> cross-brand isolation fails (proven by C + the no-make case in E/K).
check('MUT-iii manufacturer context required (LG 22E != evaporator-fan)', (() => { const f = rf('fridge-freezer', 'LG', '22E'); return !(f && f.faultId === 'evaporator-fan' && f.via === 'errorCode'); })());
// (iv) ignore family context -> family isolation fails (proven by D).
check('MUT-iv family context required (Samsung WM 22E != evaporator-fan)', (() => { const f = rf('washing-machine', 'Samsung', '22E'); return !(f && f.faultId === 'evaporator-fan'); })());
// (v) discard resolver result before ranking -> ranking fails: authoritativeCodeComponents needs the
//     resolver's fault; without a via:errorCode fault it returns the model list unchanged.
check('MUT-v without a via:errorCode fault, model list is unchanged (resolver result IS the lever)',
  JSON.stringify(authoritativeCodeComponents(null, ['main pcb', 'display'])) === JSON.stringify(['main pcb', 'display']));
// (vi) convert likely component to confirmed failure -> calibration test fails (source guard on the calibration language).
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
  check('MUT-vi calibration language present (indicates area, not proven failure)', /INDICATES a likely area or component, it does NOT prove/.test(src));
}

// ---------------------------------------------------------------------------
// STRUCTURAL INVARIANT (coverage guard): every error-code mapping resolves to a fault node WITH
// components. Guards future additions from introducing an orphan code that can never rank a component.
// ---------------------------------------------------------------------------
{
  const skip = new Set(['appliesTo', '_note']);
  let orphans = 0, total = 0;
  for (const def of Object.values(CAT.errorCodes || {})) {
    for (const [appl, table] of Object.entries(def)) {
      if (skip.has(appl) || typeof table !== 'object') continue;
      for (const fid of Object.values(table)) {
        total++;
        const node = CAT.faults[appl] && CAT.faults[appl][fid];
        if (!node || !Array.isArray(node.components) || !node.components.length) orphans++;
      }
    }
  }
  check('INVARIANT every error code maps to a fault node with components (0 orphans)', orphans === 0, { total, orphans });
}

{
  check('compound slash-subcode extracted whole', guessErrorCode('Bosch E36/E10, won\'t spin') === 'E36/E10');
  check('colon-hyphen subcode extracted whole', guessErrorCode('showing E:36-10') === 'E:36-10');
  check('messy separators collapsed', guessErrorCode('code E:36 / -10') === 'E:36/-10');
  check('stem upgraded to compound from the same text',
    upgradeErrorCodeFromText('Bosch E36/E10, won\'t spin', 'E36') === 'E36/E10');
  check('suffix fragment of a spoken compound upgrades to the whole displayed code',
    upgradeErrorCodeFromText('mums bosch, code e36 or e10 flashing, wont spin', 'E10') === 'E36/E10');
  check('simple E15 unchanged', guessErrorCode('Bosch dishwasher E15') === 'E15');
  check('spoken compound E36 or E10 is one token', guessErrorCode('it beeps and flashes E36 or E10') === 'E36/E10');
  check('lowercase spoken compound', guessErrorCode('code e36 or e10 flashing') === 'E36/E10');
  const fragment = resolveFault({
    applianceType: 'washing-machine',
    make: 'bosch',
    errorCode: 'E36/E10',
    faultId: 'comms',
    fault: 'communication fault',
  });
  check('compound E36/E10 is not resolved as the E10 comms fragment',
    !fragment || fragment.faultId !== 'comms', fragment);
  const soaking = resolveFault({
    applianceType: 'washing-machine',
    make: 'bosch',
    errorCode: 'E36/E10',
    faultId: 'comms',
    fault: 'clothes soaking wet will not spin',
  });
  check('compound E36/E10 with soak/spin evidence is not comms',
    !soaking || soaking.faultId !== 'comms', soaking);
  const simpleE10 = resolveFault({
    applianceType: 'washing-machine',
    make: 'bosch',
    errorCode: 'E10',
  });
  check('standalone E10 still maps to comms', simpleE10 && simpleE10.via === 'errorCode' && simpleE10.faultId === 'comms');
  const noMake = resolveFault({
    applianceType: 'washing-machine',
    errorCode: 'E36/E10',
    faultId: 'comms',
    fault: 'communication fault',
  });
  check('compound E36/E10 without make is still not the E10 comms fragment',
    !noMake || noMake.faultId !== 'comms', noMake);
  const suffixKept = { errorCode: 'E10', applianceType: 'washing-machine', make: 'bosch', faultId: 'comms', fault: 'communication fault' };
  retainCustomerErrorCode(suffixKept, 'mums bosch, code e36 or e10 flashing, wont spin, soaking wet, is the drain blocked', {});
  check('retain restores the spoken compound when UNDERSTAND kept the suffix fragment',
    suffixKept.errorCode === 'E36/E10', suffixKept.errorCode);
  const suffixResolved = resolveFault(suffixKept);
  check('restored compound is not resolved as the E10 comms fragment',
    !suffixResolved || suffixResolved.faultId !== 'comms', suffixResolved);
  check('spaced e 21 is E21', guessErrorCode('error e 21') === 'E21');
  check('V6 is not extracted as a code', guessErrorCode('my dyson v6 is pulsing') == null);
  check('English of is not OF', guessErrorCode('Mum\'s machine ended with a tub full of water') == null);
  check('English be is not BE', guessErrorCode('humming when it should be draining') == null);
  check('Displayed OF still extracts', guessErrorCode('Hotpoint showing OF and will not empty') === 'OF');
  const invented = { errorCode: 'OF' };
  retainCustomerErrorCode(invented, 'tub full of water and spin just hums', {});
  check('Invented OF from retrieval is stripped when the customer reported no code', invented.errorCode == null);
}

{
  const unique = resolveFault({ make: 'Samsung', errorCode: '22E' });
  check('unique make+code without family resolves when the mapping is unique',
    unique && unique.via === 'errorCode' && unique.faultId === 'evaporator-fan' && unique.resolvedAppliance === 'fridge-freezer');
  const elxDrain = resolveFault({ make: 'Zanussi', errorCode: 'E21' });
  check('unique grouped drain code without family resolves to not-draining',
    elxDrain && elxDrain.via === 'errorCode' && elxDrain.faultId === 'not-draining' && elxDrain.resolvedAppliance === 'washing-machine');
  const shared = resolveFault({ make: 'Electrolux', errorCode: 'E20' });
  check('shared make+code across families does not unique-resolve',
    !(shared && shared.via === 'errorCode'));
  check('explicit unknown family still blocks unique resolve',
    !resolveFault({ applianceType: 'toaster', make: 'Samsung', errorCode: '22E' }));
}

console.log(`\nerror-code-component: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
