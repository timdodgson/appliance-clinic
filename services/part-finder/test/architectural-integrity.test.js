'use strict';
/**
 * General architectural contracts from the real-world 100 failure classes.
 * Concepts only — no frozen journey IDs, no opener copies, no benchmark phrases.
 *
 * Run: node services/part-finder/test/architectural-integrity.test.js
 */
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const fs = require('fs');
const path = require('path');
const {
  resolveEstablishedFamily: _resolveEstablishedFamily, lockApplianceType, identityNamedFamilies,
  customerOnlyText, looksLikeModelToken, guessErrorCode, collectEvidence, adjustDifferential,
  classifySafetyStop, detectUnsafeIntent,
  classifyRemoteActionClass, computePresentationGrain, formatTrustedCustomerEvidence,
  COMPONENT_MENTION, REMOTE_ACTION, commitFromEvidence, factConflict,
} = require('../part-finder-lambda.js')._internal;

// TEST-ONLY Jev simulation (production identity no longer parses customer prose for family/fuel —
// those are Jev's typed decisions). Derives the typed signals from scenario prose, mirroring the
// deployed Jev, unless the caller supplied them explicitly.
const _NAMED_FAM = [
  ['washer-dryer', /\bwasher[\s-]?dryers?\b/i],
  ['tumble-dryer', /\btumble[\s-]?dryers?\b|\bdryers?\b/i],
  ['washing-machine', /\bwashing machines?\b|\bwashers?\b/i],
  ['dishwasher', /\bdish\s?washers?\b/i],
  ['microwave', /\bmicrowaves?\b/i],
  ['hobs', /\bhobs?\b|\bcooktops?\b|\binduction hob\b/i],
  ['oven-cooker', /\bovens?\b|\bcookers?\b/i],
  ['fridge-freezer', /\bfridge[\s-]?freezers?\b|\bfridges?\b|\bfreezers?\b/i],
  ['vacuum', /\bvacuum(?:\s+cleaners?)?s?\b|\bdysons?\b|\bhenry\b/i],
];
const _INFERRED_FAM = [
  ['microwave', /\b(?:cover off|take the cover|stirrer|turntables?)\b/i],
  ['washing-machine', /\bfront[\s-]?loaders?\b|\b(?:soap|detergent)[\s-]?(?:drawer|dispenser)\b/i],
  ['dishwasher', /\b(?:3|all)[\s-]?in[\s-]?1 tablets?\b|\b(?:rinse aid|crockery|cutlery basket)\b/i],
  ['hobs', /\binduction\b|\b(?:cooking )?zones?\b/i],
];
function _simJev(messages, queryText) {
  const turns = [];
  for (const m of messages || []) {
    if (!m || m.role !== 'user') continue;
    const c = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join(' ') : '';
    turns.push(String(c));
  }
  if (!turns.length && queryText) turns.push(String(queryText));
  const isShort = (t) => /^(?:yes|yep|no|nope|ok|okay|correct|i don'?t know|don'?t know|not sure|already tried that)\s*[.!]?$/i.test(String(t).trim());
  let jevFamily = null; let prov = 'none';
  for (const t of turns) {
    if (isShort(t)) continue;
    for (const [fam, re] of _NAMED_FAM) { if (re.test(t)) { jevFamily = fam; prov = 'customer_named'; break; } }
  }
  if (!jevFamily) { const blob = turns.join('\n'); for (const [fam, re] of _INFERRED_FAM) { if (re.test(blob)) { jevFamily = fam; prov = 'inferred'; break; } } }
  const blob = turns.join('\n');
  let fuelValue = null; let fuelConflict = false;
  const g = /\bgas\b(?:\s+\w+){0,2}\s+(?:oven|cooker|hob|grill|dryer)|\bit'?s gas\b/i.test(blob);
  const e = /\belectric\b(?:\s+\w+){0,2}\s+(?:oven|cooker|hob|dryer|grill)|\bit'?s electric\b|\binduction\b/i.test(blob);
  if (g && e && !/\b(?:actually|sorry)\b/i.test(blob)) fuelConflict = true;
  else if (g) fuelValue = 'gas'; else if (e) fuelValue = 'electric';
  return { jevFamily, jevFamilyProvenance: prov, jevFuel: { value: fuelValue, conflict: fuelConflict, stated: Boolean(fuelValue) } };
}
function resolveEstablishedFamily(opts = {}) {
  if (opts && (opts.messages || opts.queryText) && opts.jevFamily === undefined && opts.jevFuel === undefined) {
    return _resolveEstablishedFamily({ ...opts, ..._simJev(opts.messages, opts.queryText) });
  }
  return _resolveEstablishedFamily(opts);
}
const { applyFamilyFilter } = require('../retrieval.js');
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));

// ---------------------------------------------------------------------------
// 1. Family identity persistence
// ---------------------------------------------------------------------------
{
  const established = resolveEstablishedFamily({
    messages: [
      { role: 'user', content: 'My tumble dryer has stopped heating. Clothes come out wet.' },
      { role: 'assistant', content: 'Is it an induction hob, a ceramic/electric one, or a gas hob?' },
      { role: 'user', content: 'the heating element I think' },
    ],
  });
  check('F1 established tumble dryer survives later element mention', established.family === 'tumble-dryer');
}
{
  const established = resolveEstablishedFamily({
    bodyAppliance: 'vacuum',
    messages: [
      { role: 'user', content: 'My Dyson V8 is not picking up on the kitchen floor' },
      { role: 'user', content: 'I don\'t know' },
    ],
  });
  check('F2 Dyson / vacuum identity survives I don\'t know', established.family === 'vacuum');
}
{
  const established = resolveEstablishedFamily({
    messages: [
      { role: 'user', content: 'My microwave heats for a bit then the food stays cold' },
      { role: 'user', content: 'yes' },
    ],
  });
  check('F3 microwave survives short follow-up yes', established.family === 'microwave');
}
{
  const blob = customerOnlyText('Customer: clothes come out wet\nAdvisor asked: Is it an induction hob?');
  check('F4 advisor hob question is stripped from customer text', !/\bhob\b/i.test(blob) && /clothes/.test(blob));
  // F5 removed: guessApplianceFamily (customer-prose family minting) is deleted — family is Jev's typed
  // applianceFamily now, so "does not mint a hob family from ambiguous prose" is Jev's responsibility.
}
{
  const intent = { applianceType: 'hobs', clarifyingQuestion: 'Is it an induction hob?' };
  lockApplianceType(intent, { family: 'tumble-dryer', source: 'customer' }, [{ applianceFamily: 'hobs' }]);
  check('F6 retrieved hob docs cannot override tumble dryer', intent.applianceType === 'tumble-dryer');
}
{
  const established = resolveEstablishedFamily({
    bodyAppliance: 'tumble-dryer',
    messages: [
      { role: 'user', content: 'My tumble dryer is not heating' },
      { role: 'user', content: 'actually it\'s a washing machine' },
    ],
  });
  check('F7 explicit correction can change family', established.family === 'washing-machine' && established.familyEstablished === true);
}
{
  const unknown = resolveEstablishedFamily({
    messages: [{ role: 'user', content: 'the pump is noisy' }],
  });
  check('F8 unresolved identity stays null rather than becoming a fridge', unknown.family == null);
}
{
  const working = resolveEstablishedFamily({
    messages: [{ role: 'user', content: 'food stays cold and I can take the cover off' }],
  });
  check('F8b cover+cold is working microwave not fridge', working.family === 'microwave' && working.identity.familyState === 'working' && working.identity.familyEstablished === false);
}

// ---------------------------------------------------------------------------
// 2. Retrieval cannot redefine family
// ---------------------------------------------------------------------------
{
  const docs = [
    { applianceFamily: 'hobs', faultId: 'element' },
    { applianceFamily: 'tumble-dryer', faultId: 'not-heating' },
  ];
  const locked = applyFamilyFilter(docs, 'tumble-dryer', true);
  check('R1 established family filter keeps only that family', locked.length === 1 && locked[0].faultId === 'not-heating');
  const empty = applyFamilyFilter([{ applianceFamily: 'hobs' }], 'microwave', true);
  check('R2 established family never falls back to the whole corpus', empty.length === 0);
  const guessEmpty = applyFamilyFilter([{ applianceFamily: 'hobs' }], 'microwave', false);
  check('R3 unestablished empty filter may fall back', guessEmpty.length === 1);
}

// ---------------------------------------------------------------------------
// 3. Replacement evidence + assembly grain
// ---------------------------------------------------------------------------
{
  const ev = collectEvidence({ alreadyReplaced: [], provenGood: [], facts: [] },
    'I already replaced the heating element and nothing changed');
  check('E1 previous element replacement is captured', ev.alreadyReplaced.some((p) => /element/i.test(p)));
  check('E2 component grain for a named part', ev.replacementGrain === 'component');
  const ranked = adjustDifferential(['heating element', 'thermostat', 'wiring'], ev);
  check('E3 replaced element is demoted not dropped', ranked[ranked.length - 1].includes('element') && ranked.length === 3);
}
{
  const ev = collectEvidence({ alreadyReplaced: [], provenGood: [], facts: [] },
    'I fitted a whole spare unit and the same fault came back');
  check('E4 whole-unit replacement is unit grain', ev.replacementGrain === 'unit');
  const ranked = adjustDifferential(['magnetron', 'capacitor', 'mains inlet'], ev);
  check('E5 internals demoted ahead of external supply path', ranked[0].includes('inlet') || ranked[0].includes('mains'));
}
{
  const ev = collectEvidence({
    provenGood: [], alreadyReplaced: [],
    facts: [{ name: 'heatsAtAll', value: 'TRUE' }],
  }, 'the grill still works');
  check('E6 proven-good from heatsAtAll fact', ev.provenGood.some((p) => /heater|element/i.test(p)));
}

// ---------------------------------------------------------------------------
// 4. Safety ≠ component certainty; safety-stop suppresses purchase
// ---------------------------------------------------------------------------
{
  const grain = computePresentationGrain({
    intent: { userIntent: 'PART_REQUEST', candidateComponents: ['spark generator'], primaryFindingKind: 'component', applianceType: 'hobs' },
    fault: { faultId: 'ignition', node: CAT.faults.hobs.ignition, via: 'classified' },
    committedFinding: true,
    outcome: 'PART_ROUTING',
    remoteAction: REMOTE_ACTION.COMPETENT_PERSON,
    queryText: 'gas hob, I need the ignition module',
  });
  check('S1 competent-person suppresses purchase even on part request', grain.purchaseAppropriate === false && grain.mention === COMPONENT_MENTION.NONE);
}
{
  const remote = classifyRemoteActionClass({
    applianceType: 'oven-cooker', queryText: 'gas oven, can you find the FSD',
    userIntent: 'PART_REQUEST',
  });
  check('S2 gas part request is competent-person', remote === REMOTE_ACTION.COMPETENT_PERSON);
}
{
  const remote = classifyRemoteActionClass({
    applianceType: 'microwave', queryText: 'I can take the cover off to test the magnetron',
    unsafeIntent: true,
  });
  check('S3 microwave HV internals are competent-person', remote === REMOTE_ACTION.COMPETENT_PERSON);
}
{
  const grain = computePresentationGrain({
    intent: { candidateComponents: ['spark generator'], primaryFindingKind: 'component' },
    safetyStop: 'burning',
    committedFinding: true,
    outcome: 'SAFETY_STOP',
  });
  check('S4 safety-stop grain is none', grain.mention === COMPONENT_MENTION.NONE && grain.purchaseAppropriate === false);
}
check('S5 cover-off magnetron is unsafe intent', detectUnsafeIntent('I can take the cover off to check the magnetron') === true);

// ---------------------------------------------------------------------------
// 5. Fabricated hazards
// ---------------------------------------------------------------------------
check('H1 melted belt is not a burning stop', classifySafetyStop('the drive belt looks melted') == null);
check('H2 melting wiring still stops', (classifySafetyStop('the wiring is melting by the plug') || {}).category === 'burning');
check('H3 explicit burning smell still stops', classifySafetyStop('hot plastic smell from the motor') === 'burning' || (classifySafetyStop('hot plastic smell from the motor') || {}).category === 'burning');

// ---------------------------------------------------------------------------
// 6. Hob reasoning structure
// ---------------------------------------------------------------------------
{
  const ov = factConflict(CAT.faults.hobs.element, facts({ wholeHobThermalCutout: 'TRUE', allZonesAffected: 'TRUE' }));
  check('HB4 whole-hob thermal contradicts single-zone element', ov.contradicted === true);
}

// ---------------------------------------------------------------------------
// 7. Diagnostic likelihood vs purchase vs fit (grain)
// ---------------------------------------------------------------------------
{
  const grain = computePresentationGrain({
    intent: {
      alreadyReplaced: ['heating element'],
      userIntent: 'PART_REQUEST',
      candidateComponents: ['heating element'],
      primaryFindingKind: 'component',
      replacementGrain: 'component',
    },
    fault: { faultId: 'not-heating', node: CAT.faults['tumble-dryer']['not-heating'], via: 'classified' },
    committedFinding: true,
    outcome: 'PART_ROUTING',
  });
  check('P1 prior replacement demotes a part-request away from purchase', grain.purchaseAppropriate === false);
}
{
  const grain = computePresentationGrain({
    intent: {
      userIntent: 'PART_REQUEST',
      candidateComponents: ['drain pump'],
      primaryFindingKind: 'component',
      alreadyReplaced: [],
    },
    fault: { faultId: 'not-draining', node: CAT.faults['washing-machine']['not-draining'], via: 'errorCode' },
    committedFinding: true,
    outcome: 'PART_ROUTING',
  });
  check('P2 isolated part request remains purchase-appropriate', grain.purchaseAppropriate === true && grain.mention === COMPONENT_MENTION.PURCHASE);
}
{
  const block = formatTrustedCustomerEvidence({
    alreadyReplaced: ['whole unit'],
    replacementGrain: 'unit',
    primaryFindingKind: 'subsystem',
    reportedSymptoms: ['same fault after swap'],
  });
  check('P3 unit replacement grain reaches COMPOSE evidence', /replacement grain: unit/i.test(block) && /Whole-unit/i.test(block));
}

// ---------------------------------------------------------------------------
// 8. Fridge powdery ice / vacuum brush vs motor
// ---------------------------------------------------------------------------
{
  const defrost = factConflict(CAT.faults['fridge-freezer']['defrost-system'], facts({ airIngressFrost: 'TRUE', doorNotSeating: 'TRUE' }));
  check('FF3 air-ingress contradicts defrost-first', defrost.contradicted === true);
}

// ---------------------------------------------------------------------------
// 9. Model tokens are not error codes; English IF/ICE is not a code
// ---------------------------------------------------------------------------
check('C1 WDF740 is a model token', looksLikeModelToken('WDF740') === true);
check('C2 RS21 is a model token', looksLikeModelToken('RS21') === true);
check('C3 E15 is not a model token', looksLikeModelToken('E15') === false);
check('C4 "if I smack it" does not mint IF', guessErrorCode('if I smack the freezer it starts') == null);
check('C4b "should be draining" does not mint BE',
  guessErrorCode("water left in the bottom, humming when it should be draining") == null);
check('C5 "ice on the back" does not mint ICE', guessErrorCode('there is ice on the back panel') == null);
check('C6 showing E15 still extracts a code', guessErrorCode('Bosch dishwasher showing E15') === 'E15');

console.log(`\narchitectural-integrity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
