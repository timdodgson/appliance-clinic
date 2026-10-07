/**
 * OVEN FIRST-USE BURN-OFF / NEW-APPLIANCE SMELL — normal-vs-fault-vs-safety discrimination.
 *
 * A brand-new / first-use oven giving off a faint smell, light haze or steam while the protective
 * coating and manufacturing residue burn off (cure) is NORMAL (no part). The reusable objective:
 * when the customer's OWN observations (new/first-use + a benign smell/vapour, under reassurance
 * framing) are enough to recognise expected behaviour, COMMIT the normal outcome instead of falling
 * back to a generic "describe the problem" clarification — WITHOUT ever reassuring a genuinely unsafe
 * symptom (gas / electrical burning / sparking / smoke) as burn-off. Safety always wins.
 *
 * This reuses the existing first-class normal-behaviour matcher (knowledge/normal-behaviour.json +
 * matchNormalBehaviour) — NO new engine, NO journey/Hotpoint rule. The only code change is a
 * benign-smell exception (isBenignSmellOnly) that lets a mild new-appliance smell reach a `firstUse`
 * record past the shared "smell" failure veto, plus a word-boundary fix so "installed" no longer
 * trips the "stall" failure token.
 *
 * Run: node services/part-finder/test/oven-first-use-burnoff.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  matchNormalBehaviour, hasFailureSymptom, isBenignSmellOnly, classifySafetyStop, getNormalBehaviourRecords,
} = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const OVEN = { applianceFamily: 'oven-cooker' };
const nbId = (t, ctx) => { const r = matchNormalBehaviour(ctx || OVEN, t); return r ? r.id : null; };
const isNormal = (t, ctx) => Boolean(matchNormalBehaviour(ctx || OVEN, t));
const ss = (t, fam) => { const r = classifySafetyStop(t, fam || 'oven-cooker'); return r ? r.category : null; };
const BURNOFF = 'oven-cooker:first-use-burnoff';

// ============================================================================
// A. PRIMARY — OV-003 is recognised as first-use burn-off (NORMAL, no part)
// ============================================================================
check('A1 OV-003 exact -> first-use burn-off (NORMAL)',
  nbId('my new Hotpoint oven puffs out steam and there\u2019s a bit of a smell when it\u2019s on, is it faulty') === BURNOFF);
check('A2 the burn-off record carries NO purchasable components (no part)',
  (getNormalBehaviourRecords().find((r) => r.id === BURNOFF) || {}).components === undefined);
check('A3 the record is family-scoped to oven-cooker',
  (getNormalBehaviourRecords().find((r) => r.id === BURNOFF) || {}).family === 'oven-cooker');
check('A4 the record opts into the benign-smell exception (firstUse:true)',
  (getNormalBehaviourRecords().find((r) => r.id === BURNOFF) || {}).firstUse === true);

// ============================================================================
// B. FIRST-USE CONTEXT — "new"/installed/first-time recognised; old/not-new NOT
// ============================================================================
check('B1 brand new + first-time chemical smell', nbId('brand new oven has a bit of a chemical smell the first time i use it, is that normal') === BURNOFF);
check('B2 just installed + smell + concern', nbId('just installed a new oven and there is a smell when it heats up, is it faulty') === BURNOFF);
check('B3 recently installed + smell', nbId('recently installed oven and it smells a bit when on, normal?') === BURNOFF);
check('B4 OLD oven (5 years) + smell is NOT first-use burn-off', nbId('my oven is 5 years old and there\u2019s a smell when it\u2019s on, is it faulty') === null);
check('B5 "new" ALONE (no smell/vapour) does NOT commit normal', nbId('is my new oven ok?') === null);
check('B6 smell WITHOUT any new/first-use context is NOT burn-off', nbId('there is a smell from my oven when it\u2019s on, is it faulty') === null);

// ============================================================================
// C. EMISSION — steam/vapour recognised; smoke is NOT collapsed into steam
// ============================================================================
check('C1 new oven + light steam only (no smell word)', nbId('my new oven puffs out a bit of steam when it is on, is that normal') === BURNOFF);
check('C2 new oven + vapour + concern', nbId('brand new oven gives off a bit of vapour on first use, is that normal') === BURNOFF);
check('C3 new oven + SMOKE is NOT auto-normal (not collapsed with steam)', nbId('my new oven is pouring out smoke, is that normal') === null);
check('C4 new oven + heavy smoke -> safety classifier fires', ss('my new oven is pouring out smoke, is that normal') === 'burning');

// ============================================================================
// D. SMELL TYPE — mild/chemical benign; burning/electrical/acrid/gas NOT benign
// ============================================================================
check('D1 mild "bit of a smell" is benign', isBenignSmellOnly('just a bit of a smell'));
check('D2 "chemical smell" (new-appliance) is benign', isBenignSmellOnly('a chemical smell'));
check('D3 "burning smell" is NOT benign', !isBenignSmellOnly('a burning smell'));
check('D4 "electrical smell" is NOT benign', !isBenignSmellOnly('an electrical smell'));
check('D5 "acrid smell" is NOT benign', !isBenignSmellOnly('an acrid smell'));
check('D6 "smells of gas" is NOT benign', !isBenignSmellOnly('it smells of gas'));
check('D7 "hot plastic smell" is NOT benign', !isBenignSmellOnly('a hot plastic smell'));
check('D8 "drain smell" is NOT benign (hygiene/other fault)', !isBenignSmellOnly('a drain smell'));
check('D9 benign detection needs a smell word at all', !isBenignSmellOnly('the oven is not heating'));

// ============================================================================
// E. SAFETY PRECEDENCE — unsafe cues defeat normal burn-off (safety wins)
// ============================================================================
check('E1 new oven + gas smell -> NOT normal', nbId('my new oven smells of gas, is that normal') === null);
check('E1b new oven + gas smell -> safety(gas)', ss('my new oven smells of gas, is that normal') === 'gas');
check('E2 new oven + electrical burning -> NOT normal', nbId('brand new oven has an electrical burning smell, is it faulty') === null);
check('E2b new oven + electrical burning -> safety(burning)', ss('brand new oven has an electrical burning smell, is it faulty') === 'burning');
check('E3 new oven + sparking -> NOT normal', nbId('my new oven is sparking at the back, is that normal') === null);
check('E3b new oven + sparking -> safety(burning)', ss('my new oven is sparking at the back, is that normal') === 'burning');
check('E4 new oven + melting plastic -> NOT normal', nbId('my new oven smells of melting plastic, is that normal') === null);
check('E5 OV-004 gas near cooker still a safety stop (protection)', ss('I can smell gas near my gas cooker even when it\u2019s off') === 'gas');

// ============================================================================
// F. PERSISTENCE — a smell that does NOT fade / worsens is NOT reassured
// ============================================================================
check('F1 new oven, smell persists after weeks -> NOT normal', nbId('new oven but it still smells after weeks of use') === null);
check('F2 new oven, smell getting worse each time -> NOT normal', nbId('my new oven smell is getting worse each time, is that normal') === null);

// ============================================================================
// G. TARGETED-VS-OPEN — genuinely vague input still yields no false commit
// ============================================================================
check('G1 "oven is broken" -> no burn-off commit (open clarify)', nbId('my oven is broken') === null);
check('G2 "oven not heating" -> no burn-off commit (diagnosis)', nbId('my oven is not heating up') === null);
check('G3 first-use burn-off does NOT leak to other families (fridge)',
  matchNormalBehaviour({ applianceFamily: 'fridge-freezer' }, 'my new fridge puffs out steam and a bit of a smell, is that normal') === null);

// ============================================================================
// H. REGRESSION — hasFailureSymptom word-boundary + benign-smell behaviour
// ============================================================================
check('H1 "installed" no longer trips the stall failure token', !hasFailureSymptom('just installed a new oven'));
check('H2 genuine "stalls mid cycle" still IS a failure symptom', hasFailureSymptom('my washing machine stalls mid cycle'));
check('H3 "stuck on same stage" still IS a failure symptom', hasFailureSymptom('dishwasher stuck on same stage'));
check('H4 a burning smell still IS a failure symptom (veto intact)', hasFailureSymptom('there is a burning smell'));
check('H5 bare benign smell is still flagged by hasFailureSymptom (default veto unchanged)', hasFailureSymptom('there is a smell'));
check('H6 not-heating still a failure symptom', hasFailureSymptom('it is not getting hot'));

// ============================================================================
// I. PROTECT existing normal-behaviour records (no cross-contamination)
// ============================================================================
check('I1 FF-002 back-wall condensation still recognised',
  matchNormalBehaviour({ applianceFamily: 'fridge-freezer' }, 'the back wall inside my fridge has water droplets and a bit of ice, is it broken') === null ? false : true);
check('I2 MW-007 magnetron hum still recognised',
  Boolean(matchNormalBehaviour({ applianceFamily: 'microwave' }, 'my microwave makes a humming noise and the light dims when it\u2019s on, is it dying')));
check('I3 HB-011 hob child-lock still recognised',
  Boolean(matchNormalBehaviour({ applianceFamily: 'hobs', make: 'Bosch' }, 'Bosch hob has an F and a padlock symbol, can\u2019t change anything')));

// ============================================================================
// J. SOURCE GUARDS — no journey ids, no string rules, no brand special-case
// ============================================================================
const SRC = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('J1 no OV journey/benchmark id in code', !/ov-003|ov-004/i.test(codeOnly));
check('J2 no "new oven -> normal/burnoff" string rule', !/new ?oven[\s\S]{0,40}(faultId|return|normal|burnoff|burn-off)/i.test(codeOnly));
check('J3 no "smell -> safety" string rule in code', !/\bsmell\b[\s\S]{0,30}(safetyStop|return\s*['"]?(gas|burning|safety))/i.test(codeOnly));
check('J4 no brand-keyed first-use/burn-off rule (Hotpoint only appears as generic prompt example)',
  !/hotpoint[\s\S]{0,40}(first.?use|burn|normal)/i.test(codeOnly) && !/(first.?use|burn ?off|burn-off)[\s\S]{0,40}hotpoint/i.test(codeOnly));
check('J5 isBenignSmellOnly is a reusable pure helper (no appliance/journey literal)',
  !/isBenignSmellOnly[\s\S]{0,300}(oven-cooker|hotpoint|ov-003)/i.test(codeOnly));

console.log(`\nOven first-use burn-off: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
