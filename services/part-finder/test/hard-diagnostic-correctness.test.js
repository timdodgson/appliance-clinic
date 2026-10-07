'use strict';
/**
 * HARD-SCENARIO DIAGNOSTIC CORRECTNESS — symptom fidelity, cause ranking, no-part restraint.
 *
 * Probes (used as architecture probes, NOT patched individually):
 *   OV-006  "dirty/filthy between the oven door panes"  must NOT become "shattered glass + replace".
 *   HB-009  induction hob "E on all zones"              overheating/supply must be a real candidate.
 *   WM-016  "spins but clothes soaking wet"             must NOT be led by carbon brushes/belt on a
 *                                                        fabricated "drains normally"; water-remaining
 *                                                        must down-rank the motor and favour drainage.
 *
 * The reusable fix under test:
 *   - factConflict(node, facts): a node signal marked STRONG_AGAINST that the customer stated TRUE
 *     (or STRONG_SUPPORT stated FALSE) is a genuine contradiction; UNKNOWN stays neutral.
 *   - chooseCompatibleFault(): re-ground a contradicted symptom fault to a fact-supported alternative.
 *   - knowledge: new oven `door-glass-dirty` (ADVICE_ONLY) vs `door-glass` (shattered); WM motor-drum
 *     gains waterRemaining:STRONG_AGAINST; hob overheating gains all-zones-E synonyms + discriminator.
 *
 * Pure/deterministic — no LLM, no network. Run: node services/part-finder/test/hard-diagnostic-correctness.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  resolveFault, applianceKey, factConflict, chooseCompatibleFault, computeEvidence, buildComposeSystem,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));

// ============================================================================
// A. factConflict — contradiction must matter; UNKNOWN stays UNKNOWN
// ============================================================================
{
  const md = node('washing-machine', 'motor-drum');
  // WM-016: customer's real fact is waterRemaining TRUE -> motor-drum STRONG_AGAINST -> contradicted.
  check('A1 motor-drum contradicted by waterRemaining TRUE',
    factConflict(md, facts({ waterRemaining: 'TRUE' })).contradicted === true);
  // Contradiction stands EVEN WITH a supporting fact present (a common fault must not override a
  // stated contradiction).
  check('A2 contradiction holds despite a SUPPORT fact (spinsSlowly TRUE)',
    factConflict(md, facts({ waterRemaining: 'TRUE', spinsSlowly: 'TRUE' })).contradicted === true);
  // UNKNOWN / absent must be neutral — never treated as TRUE.
  check('A3 unknown waterRemaining is NOT a contradiction',
    factConflict(md, facts({ waterRemaining: 'UNKNOWN' })).contradicted === false);
  check('A4 absent waterRemaining is NOT a contradiction',
    factConflict(md, facts({ noiseOnSpin: 'TRUE' })).contradicted === false);
  // A STRONG_SUPPORT fact stated FALSE is also a contradiction (glassDamaged FALSE vs shatter node).
  check('A5 door-glass(shatter) contradicted when glassDamaged FALSE',
    factConflict(node('oven-cooker', 'door-glass'), facts({ glassDamaged: 'FALSE' })).contradicted === true);
  // door-glass-dirty must be contradicted by real damage.
  check('A6 door-glass-dirty contradicted when glassDamaged TRUE',
    factConflict(node('oven-cooker', 'door-glass-dirty'), facts({ glassDamaged: 'TRUE' })).contradicted === true);
  check('A7 no facts -> no contradiction', factConflict(md, []).contradicted === false);
}

// ============================================================================
// B. chooseCompatibleFault — re-ground a contradicted fault to a supported alternative
// ============================================================================
{
  const fault = { faultId: 'motor-drum', node: node('washing-machine', 'motor-drum'), via: 'classified' };
  // WM-016: waterRemaining TRUE; UNDERSTAND offered not-draining as an alternative.
  const intent = { applianceType: 'washing machine', alternatives: ['not-draining'], facts: facts({ waterRemaining: 'TRUE' }) };
  const alt = chooseCompatibleFault(intent, fault, applianceKey(intent.applianceType));
  check('B1 re-grounds motor-drum -> not-draining on waterRemaining TRUE', alt && alt.faultId === 'not-draining', alt);
  check('B2 re-ground carries the node + evidence provenance', alt && alt.node && alt.via === 'evidence-reground');
  // No supported alternative offered -> null (caller demotes + hedges instead).
  check('B3 no alternatives -> null',
    chooseCompatibleFault({ applianceType: 'washing machine', alternatives: [], facts: facts({ waterRemaining: 'TRUE' }) }, fault, 'washing-machine') === null);
  // Never re-route an error-code-resolved fault (authority is owned upstream).
  check('B4 error-code fault is never re-routed',
    chooseCompatibleFault(intent, { faultId: 'motor-drum', node: node('washing-machine', 'motor-drum'), via: 'errorCode' }, 'washing-machine') === null);
  // An alternative that is ALSO contradicted is not chosen.
  check('B5 contradicted alternative rejected',
    chooseCompatibleFault({ applianceType: 'washing machine', alternatives: ['motor-drum'], facts: facts({ waterRemaining: 'TRUE' }) },
      { faultId: 'tacho', node: node('washing-machine', 'tacho'), via: 'classified' }, 'washing-machine') === null);
}

// ============================================================================
// C. Knowledge coverage — dirty glass vs shattered glass (OV-006)
// ============================================================================
{
  // The dirty-between-panes node exists, is ADVICE_ONLY (no part), and is distinct from the shatter node.
  const dirty = node('oven-cooker', 'door-glass-dirty');
  const shatter = node('oven-cooker', 'door-glass');
  check('C1 door-glass-dirty exists + ADVICE_ONLY + no components', dirty && dirty.outcome === 'ADVICE_ONLY' && (dirty.components || []).length === 0);
  check('C2 shattered node is NOT advice-only (still a replacement route)', shatter && shatter.outcome !== 'ADVICE_ONLY');
  check('C3 dirty and shatter are different nodes (not collapsed)', dirty.label !== shatter.label);
  // Symptom-match resolution: "dirty between the panes" grounds to the dirty node, not the shatter node.
  const rfDirty = resolveFault({ applianceType: 'oven', fault: 'dirty between the panes' });
  check('C4 "dirty between the panes" -> door-glass-dirty', rfDirty && rfDirty.faultId === 'door-glass-dirty', rfDirty && rfDirty.faultId);
  const rfClean = resolveFault({ applianceType: 'oven', fault: 'clean inside the door glass' });
  check('C5 "clean inside the door glass" -> door-glass-dirty', rfClean && rfClean.faultId === 'door-glass-dirty', rfClean && rfClean.faultId);
  // Genuine damage still resolves to the shatter node (boundary preserved).
  const rfShatter = resolveFault({ applianceType: 'oven', fault: 'door glass shattered' });
  check('C6 "door glass shattered" -> door-glass (replacement route preserved)', rfShatter && rfShatter.faultId === 'door-glass', rfShatter && rfShatter.faultId);
  const rfClassifiedDirty = resolveFault({ applianceType: 'oven', faultId: 'door-glass-dirty' });
  check('C7 classified door-glass-dirty resolves', rfClassifiedDirty && rfClassifiedDirty.faultId === 'door-glass-dirty');
}

// ============================================================================
// D. Knowledge coverage — hob "E on all zones" reaches overheating (HB-009)
// ============================================================================
{
  const oh = node('hobs', 'overheating');
  const syn = oh.synonyms.map((s) => s.toLowerCase());
  check('D1 overheating has all-zones-E synonyms', syn.includes('e on all zones') && syn.includes('error on all zones'));
  check('D2 overheating has a system-wide discriminator', (oh.discriminators || []).some((d) => /all zones/i.test(d) && /overheat/i.test(d)));
  const rf = resolveFault({ applianceType: 'induction hob', fault: 'E on all zones' });
  check('D3 "E on all zones" grounds to overheating (not a single-zone/PCB template)', rf && rf.faultId === 'overheating', rf && rf.faultId);
}

// ============================================================================
// E. COMPOSE integration — fact-conflict hedge + advice-only no-part
// ============================================================================
{
  // Demoted (not re-grounded) conflict: compose must be told NOT to lead with the contradicted fault.
  const intent = {
    applianceType: 'washing machine', make: 'Bosch', candidateComponents: ['carbon brushes', 'drive belt'],
    facts: facts({ waterRemaining: 'TRUE' }), primaryFinding: null,
    _factConflict: { label: 'Motor / drum fault', reasons: ['water remaining'] },
  };
  const fault = { faultId: 'motor-drum', node: node('washing-machine', 'motor-drum'), via: 'classified' };
  const sys = buildComposeSystem([], null, intent, fault, [], null, false, false, null);
  check('E1 compose hedge names the conflict + says do not lead with it', /POINTS AWAY FROM/.test(sys) && /Motor \/ drum fault/.test(sys), sys.slice(0, 0));
  // ADVICE_ONLY dirty-glass node -> ADVICE FIRST, no part push.
  const dirtyIntent = { applianceType: 'oven', make: 'Zanussi', candidateComponents: [], facts: [] };
  const dirtyFault = { faultId: 'door-glass-dirty', node: node('oven-cooker', 'door-glass-dirty'), via: 'classified' };
  const sys2 = buildComposeSystem([], null, dirtyIntent, dirtyFault, [], null, false, false, null);
  check('E2 dirty-glass compose is ADVICE-FIRST (no part sale)', /ADVICE FIRST/.test(sys2));
}

// ============================================================================
// F. Mutation proofs — the tests fail if the fix is reverted
// ============================================================================
{
  const md = node('washing-machine', 'motor-drum');
  // F1: if waterRemaining were only SUPPORT (not STRONG_AGAINST), factConflict would NOT fire.
  const mutated = { ...md, signals: (md.signals || []).map((s) => s.fact === 'waterRemaining' ? { ...s, effect: 'SUPPORT' } : s) };
  check('F1 mutation (waterRemaining downgraded to SUPPORT) is caught', factConflict(mutated, facts({ waterRemaining: 'TRUE' })).contradicted === false);
  // F2: if the gate treated UNKNOWN as TRUE it would wrongly contradict — prove UNKNOWN is neutral.
  check('F2 UNKNOWN not treated as TRUE', factConflict(md, facts({ waterRemaining: 'UNKNOWN' })).contradicted === false);
  // F3: if the dirty node were removed/collapsed into the shatter node, "dirty between panes" would
  // resolve to the shatter (replacement) node — prove it does not.
  check('F3 dirty phrasing does not resolve to the replacement node',
    resolveFault({ applianceType: 'oven', fault: 'filthy between the panes' }).faultId !== 'door-glass');
  // F4: contradiction must matter even for a "common" fault (supports present) — prove it still fires.
  check('F4 common-fault support does not suppress the contradiction',
    factConflict(md, facts({ waterRemaining: 'TRUE', spinsSlowly: 'TRUE', noiseOnSpin: 'TRUE' })).contradicted === true);
}

// ============================================================================
// G. Cross-family isolation — the dirty-glass node is oven-only
// ============================================================================
{
  check('G1 door-glass-dirty only exists for oven-cooker',
    !!CAT.faults['oven-cooker']['door-glass-dirty'] && !CAT.faults['washing-machine']['door-glass-dirty'] && !CAT.faults['hobs']['door-glass-dirty']);
  // A washing-machine "spins but wet" must not somehow resolve to an oven node.
  const rf = resolveFault({ applianceType: 'washing machine', faultId: 'not-draining' });
  check('G2 wm not-draining resolves within washing-machine', rf && rf.faultId === 'not-draining' && rf.node.label === node('washing-machine', 'not-draining').label);
}

// ============================================================================
// H. Source guards — no journey ids / no benchmark-answer map in production logic
// ============================================================================
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
  const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const blob = codeLines.join('\n');
  check('H1 no OV-006 journey id in production logic', !/OV-006/.test(blob));
  check('H2 no HB-009 journey id in production logic', !/HB-009/.test(blob));
  check('H3 no WM-016 journey id in production logic', !/WM-016/.test(blob));
}

console.log(`\nhard-diagnostic-correctness: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
