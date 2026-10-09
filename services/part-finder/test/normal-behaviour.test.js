'use strict';
/**
 * Permanent regression tests for FIRST-CLASS NORMAL-BEHAVIOUR RECOGNITION.
 *
 * Background: normal/expected appliance behaviour used to be recognised only by (a) an UNDERSTAND
 * boolean flag and (b) a closed-set regex backstop (detectNormalBehaviour) covering ~5 conditions.
 * That could not represent features/indicators/symbols (InfoLight, hob child-lock padlock, fridge
 * back-wall condensation, microwave magnetron hum), so the confident LLM either mis-grounded to the
 * nearest FAULT or had its correct understanding discarded by deterministic logic.
 *
 * The fix makes NORMAL_BEHAVIOUR first-class: knowledge/normal-behaviour.json holds the domain facts
 * (with provenance), retrieval exposes them, and matchNormalBehaviour() is the generic MATCHER
 * (family/make gate + concern framing + per-record fault-like `notIf` calibration + shared
 * failure-symptom veto). No per-scenario or benchmark-string logic lives in code.
 *
 * These tests protect:
 *   1. Recognition of the four evidence behaviours AND near-neighbour paraphrases (semantic, not
 *      benchmark-wording).
 *   2. Calibration: fault-like near-neighbours are NOT reassured away (mutation proof D).
 *   3. The failure-symptom / safety veto stays stronger than reassurance (mutation proof E).
 *   4. Manufacturer boundaries (brand-specific features don't leak to other makes).
 *   5. The knowledge dependency itself (mutation proofs A + B): the behaviour comes from the data,
 *      and removing/emptying a record breaks the relevant recognition.
 *   6. The migrated operating-condition discipline (ECO/plastics/fridge-noise/induction/heat-pump).
 *   7. normaliseIntent() carries the `normalBehaviour` flag + schema is satisfiable (unchanged).
 *
 * Pure functions, no LLM, no network — fully deterministic.
 * Run: node services/part-finder/test/normal-behaviour.test.js
 */
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const fs = require('fs');
const path = require('path');
const {
  matchNormalBehaviour, hasFailureSymptom, expressesConcern, getNormalBehaviourRecords,
  normaliseIntent, INTENT_SCHEMA,
} = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
// Convenience: is this recognised as normal? (record or null). ctx carries make where a record is
// brand-specific (in production this comes from intent.make; the matcher never guesses the make).
// The matcher consumes Jev's typed appliance family (ctx.applianceFamily); it no longer guesses the
// family from prose. These scenarios are written in prose, so simulate Jev's family the way the
// deployed pass would type it (mirrors FakeDiagnosticService), unless the test supplies one.
const _simFamily = (text) => {
  const t = String(text || '').toLowerCase();
  if (/\bdish\s?washers?\b/.test(t)) return 'dishwasher';
  if (/\bfridge|freezer|refrigerat/.test(t)) return 'fridge-freezer';
  if (/\bhobs?\b|\bcooktops?\b|\binduction\b/.test(t)) return 'hobs';
  if (/\bmicrowaves?\b/.test(t)) return 'microwave';
  if (/\bwasher[\s-]?dryers?\b/.test(t)) return 'washer-dryer';
  if (/\btumble[\s-]?dryers?\b|\bdryers?\b/.test(t)) return 'tumble-dryer';
  if (/\bwashing machines?\b|\bwashers?\b/.test(t)) return 'washing-machine';
  if (/\bovens?\b|\bcookers?\b/.test(t)) return 'oven-cooker';
  if (/\bvacuum|dysons?\b|\bhenry\b/.test(t)) return 'vacuum';
  return null;
};
const norm = (text, ctx) => {
  const c = ctx || {};
  const applianceFamily = c.applianceFamily || _simFamily(text);
  return matchNormalBehaviour({ ...c, applianceFamily }, text);
};
const isNormal = (text, ctx) => Boolean(norm(text, ctx));
const idOf = (text, ctx) => { const r = norm(text, ctx); return r ? r.id : null; };
const eqId = (name, got, want) => check(name, got === want, { got, want });

// ---------------------------------------------------------------------------
// 1. THE FOUR EVIDENCE BEHAVIOURS — recognised for the RIGHT record.
// ---------------------------------------------------------------------------
eqId('DW-017 InfoLight recognised', idOf("Bosch dishwasher red light shining on the floor, what's wrong", { make: 'Bosch' }), 'dishwasher:infolight');
eqId('FF-002 back-wall condensation recognised', idOf('the back wall inside my fridge has water droplets and a bit of ice, is it broken'), 'fridge-freezer:back-wall-condensation');
eqId('HB-011 hob child-lock recognised', idOf('Bosch hob has an F and a padlock symbol, can\'t change anything', { make: 'Bosch' }), 'hobs:child-lock');
eqId('MW-007 magnetron operation-noise recognised', idOf("my microwave makes a humming noise and the light dims when it's on, is it dying"), 'microwave:magnetron-operation-noise');

// ---------------------------------------------------------------------------
// 1b. NEAR-NEIGHBOUR PARAPHRASES (semantic coverage, NOT the benchmark strings).
// ---------------------------------------------------------------------------
check('InfoLight paraphrase (Neff, projected under door)', isNormal('my Neff dishwasher projects a red dot on the floor under the door, is that normal', { make: 'Neff' }));
check('InfoLight paraphrase (Siemens, light on the ground)', isNormal('Siemens dishwasher shines a light on the floor when running, meant to?', { make: 'Siemens' }));
check('condensation paraphrase (droplets rear wall)', isNormal('is it normal to get droplets and a little frost on the rear wall inside the fridge'));
check('child-lock paraphrase (key symbol, Siemens)', isNormal('Siemens hob key symbol showing and it won\'t let me change anything', { make: 'Siemens' }));
check('child-lock paraphrase (lock icon, no make)', isNormal('my induction hob has a little lock icon and the controls are locked'));
check('magnetron paraphrase (drones, kitchen lights dim)', isNormal('the microwave drones loudly and the kitchen lights dim when it runs, is that ok'));
// customer-language / spelling variation
check('child-lock spelling variation (no apostrophe)', isNormal('bosch hob padlock symbol and cant change anything', { make: 'Bosch' }));

// ---------------------------------------------------------------------------
// 2 + 3. FAULT-LIKE NEAR-NEIGHBOURS + SAFETY: must NOT be reassured away.
//   (Mutation proof D: over-reassuring a fault-like near-neighbour -> these go RED.)
//   (Mutation proof E: a failure symptom / safety signal is stronger than reassurance.)
// ---------------------------------------------------------------------------
check('D leak on the floor (not InfoLight) NOT normal', !isNormal('Bosch dishwasher leaking water all over the floor', { make: 'Bosch' }));
check('D dishwasher red light but WON\'T START NOT normal', !isNormal("Bosch dishwasher red light on the floor and it won't start", { make: 'Bosch' }));
check('D thick ice building up (defrost fault) NOT normal', !isNormal('loads of ice building up on the back wall of my fridge and it\'s not cold, is it broken'));
check('D FF-007 near-neighbour (Beko building up ice) NOT normal', !isNormal('Beko freezer building up loads of ice at the back'));
check('D microwave humming but NOT HEATING NOT normal', !isNormal('microwave hums loudly and the light dims but it\'s not heating the food, is it dying'));
check('D hob cracked + lock symbol NOT reassured', !isNormal('induction hob is cracked and showing a lock symbol'));
check('E magnetron-normal words + BURNING SMELL NOT normal', !isNormal('microwave humming and the light dims but there\'s a burning smell'));
check('E InfoLight words + water near the plug (safety) NOT normal', !isNormal('Bosch dishwasher light on the floor and water is getting near the plug socket', { make: 'Bosch' }));
check('E child-lock words + electric shock (safety) NOT normal', !isNormal('hob padlock symbol and I got an electric shock off it'));

// ---------------------------------------------------------------------------
// 4. MANUFACTURER BOUNDARIES — brand-specific features don't leak to other makes.
// ---------------------------------------------------------------------------
check('InfoLight NOT applied to Hotpoint (brand-specific)', !isNormal('Hotpoint dishwasher red light shining on the floor, what\'s wrong', { make: 'Hotpoint' }));
check('InfoLight NOT applied when make unknown (brand-specific needs make)', !isNormal('dishwasher red light shining on the floor, is that normal'));
check('child-lock IS generic (applies to any make)', isNormal('AEG hob padlock symbol, controls locked', { make: 'AEG' }));

// ---------------------------------------------------------------------------
// 5. AMBIGUOUS -> clarification (no confident normal match).
// ---------------------------------------------------------------------------
check('vague "dishwasher has a light on" -> not a normal match', !isNormal('my dishwasher has a light on'));
check('vague "fridge is a bit noisy" (no known-normal noise cue + no concern) -> not matched', !isNormal('my fridge is a bit noisy'));

// ---------------------------------------------------------------------------
// 6. MIGRATED OPERATING-CONDITION DISCIPLINE (was detectNormalBehaviour; must still hold).
// ---------------------------------------------------------------------------
check('long ECO + clean = normal', isNormal('is it normal for the eco programme on my dishwasher to run for almost 4 hours? the dishes come out clean'));
check('long combined wash+dry = normal', isNormal('my washer dryer takes over 3 hours for a wash and dry combined, is that broken'));
check('ECO + water stays cold = NOT normal', !isNormal('is it normal the eco cycle takes 4 hours? also the water stays cold'));
check('ECO + not heating = NOT normal', !isNormal("is it normal eco takes so long? the water isn't getting hot"));
check('long cycle + stalls = NOT normal', !isNormal('is it normal the cycle takes ages? it keeps stalling at the same stage'));
check('long cycle + not draining = NOT normal', !isNormal("is it normal eco takes 3 hours? there's water left in the bottom and it won't drain"));
check('long cycle + error code = NOT normal', !isNormal('is it normal eco is 4 hours? it also shows error F3'));
check('plastics wet after dishwasher = normal', isNormal('is it normal the plastic tubs come out wet after the dishwasher cycle?'));
check('fridge gurgle/hiss = normal', isNormal('is it normal my fridge makes a gurgling and hissing noise?'));
check('fridge compressor cycling on/off = normal', isNormal('my fridge motor keeps humming on and off through the day, that normal?'));
check('induction buzzing at high power = normal', isNormal('is it normal my induction hob buzzes and drops power when I use two zones?'));
check('heat-pump dryer runs longer/cooler = normal', isNormal('is it normal my heat pump dryer takes longer and the drum feels cooler?'));
check('cordless short runtime on boost = normal', isNormal('my cordless vacuum only runs for about 8 minutes on full power, is the battery faulty'));
check('cordless handle warmth = normal', isNormal('my cordless vacuum gets warm on the handle after 10 minutes, is that dangerous'));
check('dishwasher auto-open door + steam = normal', isNormal('my dishwasher door pops open at the end and steam comes out, is that a fault'));
// NON-triggers preserved
check('not asking (plain long statement) = false', !isNormal('the eco cycle takes 4 hours'));
check('plain fault (no reassurance) = false', !isNormal("my dishwasher eco cycle won't drain"));
check('unrelated "need a new door seal" = false', !isNormal('is it normal to need a new door seal?'));
check('empty = false', !isNormal(''));
check('"eco" alone = false', !isNormal('eco'));

// ---------------------------------------------------------------------------
// SHARED VETO + CONCERN helpers (unit-level).
// ---------------------------------------------------------------------------
check('hasFailureSymptom: leak', hasFailureSymptom('it is leaking water'));
check('hasFailureSymptom: not heating', hasFailureSymptom("it isn't getting hot"));
check('hasFailureSymptom: burning smell', hasFailureSymptom('there is a burning smell'));
check('hasFailureSymptom: gas/shock safety', hasFailureSymptom('I got an electric shock off it'));
check('hasFailureSymptom: benign normal text is NOT a failure', !hasFailureSymptom('red light shining on the floor'));
check('expressesConcern: "is it broken"', expressesConcern(' is it broken '));
check('expressesConcern: "is it dying"', expressesConcern(' is it dying '));
check('expressesConcern: "what\'s wrong"', expressesConcern(" what's wrong "));
check('expressesConcern: "is that normal"', expressesConcern(' is that normal '));
check('expressesConcern: plain statement is NOT concern', !expressesConcern(' the cycle takes four hours '));

// ---------------------------------------------------------------------------
// MUTATION PROOF A + B: the behaviour comes from the KNOWLEDGE DATA, and the runtime reads it via
// retrieval. Removing a record (A) or emptying the knowledge (B) must break recognition.
// ---------------------------------------------------------------------------
const records = getNormalBehaviourRecords();
check('A knowledge has the four evidence records', ['dishwasher:infolight', 'hobs:child-lock', 'fridge-freezer:back-wall-condensation', 'microwave:magnetron-operation-noise']
  .every((id) => records.some((r) => r.id === id)), records.map((r) => r.id));
check('A each evidence record carries provenance (source-backed knowledge)',
  ['dishwasher:infolight', 'hobs:child-lock'].every((id) => {
    const r = records.find((x) => x.id === id);
    return r && Array.isArray(r.provenance) && r.provenance.length > 0 && r.provenance.every((p) => p.url && p.publisher);
  }));
check('A each record distinguishes NORMAL from FAULT-LIKE (faultLikeIf present)',
  records.every((r) => Array.isArray(r.faultLikeIf) && r.faultLikeIf.length > 0));
// A: recognition is OWNED by the record — no OTHER record recognises the InfoLight phrase, so
// deleting the InfoLight record from the knowledge would stop the InfoLight phrase being recognised
// (nothing else covers it). This proves the behaviour depends on that specific knowledge record.
{
  const infoPhrase = 'bosch dishwasher red light shining on the floor';
  const others = records.filter((r) => r.id !== 'dishwasher:infolight');
  const anyOther = others.some((r) => (r.cues || []).some((c) => infoPhrase.includes(String(c).toLowerCase())));
  check('A removing the InfoLight record leaves nothing else matching the InfoLight phrase', !anyOther);
}
check('B knowledge file is loadable and non-empty (retrieval dependency)', Array.isArray(records) && records.length >= 4);
// B: source guard — retrieval.js must LOAD normal-behaviour.json and EXPORT the accessor.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'retrieval.js'), 'utf8');
  check('B retrieval loads normal-behaviour.json', src.includes("'normal-behaviour.json'") || src.includes('normal-behaviour.json'));
  check('B retrieval exports getNormalBehaviourRecords', /getNormalBehaviourRecords/.test(src) && /module\.exports\s*=/.test(src));
}

// ---------------------------------------------------------------------------
// MUTATION PROOF C: source guard on the ORCHESTRATOR precedence — a resolved brand error code, a
// safety-stop, and a failure symptom must all remain stronger than a knowledge normal match, and a
// knowledge match overrides a fuzzy symptom fault. If this wiring is weakened, this goes RED.
// ---------------------------------------------------------------------------
{
  const src = require('./engine-source.cjs')();
  check('C normalByKnowledge gated on !safetyStop && !resolvedErrorCode',
    /normalByKnowledge\s*=\s*Boolean\(nbMatch\)\s*&&\s*!safetyStop\s*&&\s*!resolvedErrorCode/.test(src));
  check('C resolvedErrorCode derived from a resolved brand code (fault.via === errorCode)',
    /resolvedErrorCode\s*=\s*Boolean\(fault\s*&&\s*fault\.via\s*===\s*'errorCode'\)/.test(src));
  check('C model-flag path stays conservative (!fault && !errorCode)',
    /normalByModelFlag\s*=\s*intent\.normalBehaviour === true[\s\S]*?!fault && !intent\.errorCode/.test(src));
  check('C a knowledge normal match drops the fuzzy symptom fault (fault = null)',
    /if \(normalByKnowledge\)\s*\{[\s\S]*?fault = null;/.test(src));
  check('C detectNormalBehaviour closed-set regex fully removed (single authoritative matcher)',
    !/function detectNormalBehaviour/.test(src));
}

// ---------------------------------------------------------------------------
// SCHEMA CONSISTENCY (unchanged): the UNDERSTAND json_schema must be SATISFIABLE.
// ---------------------------------------------------------------------------
const propKeys = Object.keys(INTENT_SCHEMA.properties || {});
const reqKeys = INTENT_SCHEMA.required || [];
const missingFromProps = reqKeys.filter((k) => !propKeys.includes(k));
check('schema: every required key exists in properties (satisfiable)', missingFromProps.length === 0, missingFromProps);
check('schema: normalBehaviour is a declared property', propKeys.includes('normalBehaviour'));
check('schema: normalBehaviour is required', reqKeys.includes('normalBehaviour'));
check('schema: additionalProperties is false (strict)', INTENT_SCHEMA.additionalProperties === false);

// ---------------------------------------------------------------------------
// CONTRACT: normaliseIntent MUST carry `normalBehaviour` across the boundary.
// ---------------------------------------------------------------------------
check('contract: normaliseIntent carries normalBehaviour=true', normaliseIntent({ normalBehaviour: true }).normalBehaviour === true);
check('contract: normaliseIntent defaults normalBehaviour=false', normaliseIntent({}).normalBehaviour === false);
check('contract: normaliseIntent coerces non-boolean to false', normaliseIntent({ normalBehaviour: 'yes' }).normalBehaviour === false);
check('contract: normalBehaviour key is always present', 'normalBehaviour' in normaliseIntent({ make: 'Bosch' }));

console.log(`\nnormal-behaviour: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
