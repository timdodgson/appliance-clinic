'use strict';
/**
 * Architectural identity/context contracts — three-state identity model.
 * Concepts only — no frozen journey IDs.
 *   node services/part-finder/test/identity-integrity.test.js
 */
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const fs = require('fs');
const path = require('path');
const {
  FAMILY_STATE, resolveConversationIdentity: _resolveConversationIdentity, hydrateConversationRoles, isShortFollowUp,
  lockIdentityOnIntent, constrainReplyToIdentity, constrainIntentToFamily,
  formatIdentityLock, applyFuelFilter, questionAsksDifferentFamily,
  identityNamedFamilies, hasOperationalFamily, inferWorkingIdentity,
  familyFromCatalogueCategory, uniqueFamilyForMakeAndCode, extractModelTokenFromText,
  replyUsesForeignFamilyInstruction, foreignFamilyTermsIn,
} = require('../identity.js');

// ---------------------------------------------------------------------------
// TEST-ONLY Jev simulation. Production identity.js no longer parses customer prose for family/fuel —
// those are Jev's TYPED decisions (applianceType, applianceFamilyProvenance, fuel). These unit tests
// still describe scenarios in prose, so this shim derives the typed Jev signals the deployed Jev
// would return (mirroring FakeDiagnosticService in the orchestration tests) and passes them in. When
// a test already supplies jevFamily/jevFuel explicitly, the shim leaves them untouched.
// ---------------------------------------------------------------------------
const _INFERRED_FAMILY_CUES = [
  ['washing-machine', /\bfront[\s-]?loaders?\b|\b(?:soap|detergent|fabric[\s-]?conditioner)[\s-]?(?:drawer|dispenser)\b/i],
  ['dishwasher', /\b(?:3|all)[\s-]?in[\s-]?1 tablets?\b|\b(?:rinse aid|dishwasher salt|dishwasher tablets?)\b|\b(?:crockery|cutlery basket)\b/i],
  ['hobs', /\binduction\b|\b(?:cooking )?zones?\b/i],
  ['microwave', /\bturntables?\b|\b(?:cover off|take the cover|stirrer)\b/i],
];
function _simCustomerTurns(messages, queryText) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.role !== 'user') continue;
    const c = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join(' ') : '';
    // Drop labelled advisor lines the way hydrateConversationRoles does.
    out.push(String(c).replace(/\b(?:advisor asked|assistant)\s*:\s*[^\n]*/gi, ''));
  }
  if (!out.length && queryText) out.push(String(queryText));
  return out;
}
function _simulateJev(messages, queryText) {
  const turns = _simCustomerTurns(messages, queryText);
  const blob = turns.join('\n');
  // Family + provenance: the customer NAMED a family (last-wins, so a correction replaces it) →
  // customer_named; else a strong distinctive function cue → inferred; else none.
  const _NAMED = [
    ['washer-dryer', /\bwasher[\s-]?dryers?\b|\bwashing[\s-]?and[\s-]?dry/i],
    ['tumble-dryer', /\btumble[\s-]?dryers?\b|\bcondenser dryers?\b|\bheat[\s-]?pump dryers?\b|\bdryers?\b/i],
    ['washing-machine', /\bwashing machines?\b|\bwashers?\b/i],
    ['dishwasher', /\bdish\s?washers?\b/i],
    ['microwave', /\bmicrowaves?\b/i],
    ['hobs', /\bhobs?\b|\bcooktops?\b|\binduction hob\b/i],
    ['oven-cooker', /\bovens?\b|\bcookers?\b|\brange cookers?\b/i],
    ['fridge-freezer', /\bfridge[\s-]?freezers?\b|\bfridges?\b|\bfreezers?\b|\brefrigerators?\b/i],
    ['vacuum', /\bvacuum(?:\s+cleaners?)?s?\b|\bdysons?\b|\bhenry\b|\bhoovers?\b/i],
  ];
  let jevFamily = null;
  let jevFamilyProvenance = 'none';
  for (const t of turns) {
    if (isShortFollowUp(t)) continue;
    // Jev names the family whenever the customer refers to it (first match per turn in priority order;
    // last-wins across turns so a later correction replaces it).
    for (const [fam, re] of _NAMED) {
      if (re.test(t)) { jevFamily = fam; jevFamilyProvenance = 'customer_named'; break; }
    }
  }
  if (!jevFamily) {
    for (const [fam, re] of _INFERRED_FAMILY_CUES) {
      if (re.test(blob)) { jevFamily = fam; jevFamilyProvenance = 'inferred'; break; }
    }
  }
  // Fuel: the customer's explicit energy statement (last-wins). Correction handled by last-wins.
  let fuelValue = null;
  let fuelConflict = false;
  const hasGas = /\b(?:lpg|natural gas)\b|\bgas\b(?:\s+\w+){0,2}\s+(?:oven|cooker|hob|grill|dryer|tumble)|\bit'?s gas\b|\bgas appliance\b/i.test(blob);
  const hasElectric = /\belectric\b(?:\s+\w+){0,2}\s+(?:oven|cooker|hob|dryer|tumble|grill|double)|\bit'?s electric\b|\binduction\b|\belectric tumble\b/i.test(blob);
  // A within-turn "gas ... and ... electric" with no correction is a genuine conflict.
  if (hasGas && hasElectric && !/\b(?:actually|sorry)\b/i.test(blob)) fuelConflict = true;
  else if (/\b(?:actually|sorry)\b[^.]*\belectric\b/i.test(blob)) fuelValue = 'electric';
  else if (/\b(?:actually|sorry)\b[^.]*\bgas\b/i.test(blob)) fuelValue = 'gas';
  else if (hasGas) fuelValue = 'gas';
  else if (hasElectric) fuelValue = 'electric';
  return {
    jevFamily,
    jevFamilyProvenance,
    jevFuel: { value: fuelValue, conflict: fuelConflict, stated: Boolean(fuelValue) },
  };
}
function resolveConversationIdentity(opts = {}) {
  if (opts && (opts.messages || opts.queryText) && opts.jevFamily === undefined && opts.jevFuel === undefined) {
    return _resolveConversationIdentity({ ...opts, ..._simulateJev(opts.messages, opts.queryText) });
  }
  return _resolveConversationIdentity(opts);
}
const { applyFamilyFilter, applyFuelFilter: retrievalFuelFilter, retrieve } = require('../retrieval.js');
const { resolveEstablishedFamily, lockApplianceType, guessErrorCode, looksLikeModelToken, discriminatorQuestionText,
  buildComposeSystem } =
  require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}

{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'My microwave runs but the food stays cold' },
      { role: 'user', content: 'it just stays cold' },
    ],
  });
  check('1 established microwave survives later ambiguous symptom', id.family === 'microwave' && id.familyEstablished);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'Hoover tumble dryer heating circuit trips and I have to reset it' },
      { role: 'user', content: 'the airflow seems weak' },
    ],
  });
  check('2 established dryer survives airflow/suction-like wording', id.family === 'tumble-dryer' && id.familyEstablished);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Electric oven, fan works, oven and grill do not' }],
  });
  check('3 established electric oven fuel is electric', id.family === 'oven-cooker' && id.fuel === 'electric' && id.fuelState === FAMILY_STATE.ESTABLISHED);
  const intent = { applianceType: 'oven-cooker', faultId: 'ignition', clarifyingQuestion: null };
  lockIdentityOnIntent(intent, id, [{ applianceFamily: 'oven-cooker', faultId: 'ignition' }]);
  check('3b electric oven cannot keep gas ignition fault', intent.faultId == null);
  const clamped = constrainReplyToIdentity(
    'The most common cause on a gas cooker is a faulty flame failure device.',
    id,
  );
  check('3c compose cannot emit gas diagnosis for electric oven', clamped.changed === true);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Gas oven will not stay lit' }],
  });
  check('4 established gas oven stays gas', id.family === 'oven-cooker' && id.fuel === 'gas');
  const intent = { applianceType: 'oven-cooker', faultId: 'ignition' };
  lockIdentityOnIntent(intent, id, []);
  check('4b gas oven may keep ignition fault', intent.faultId === 'ignition');
}
{
  const id = resolveConversationIdentity({
    bodyAppliance: 'fridge-freezer',
    identitySource: 'inferred',
    messages: [{ role: 'user', content: 'It runs but food stays cold. I can take the cover off.' }],
  });
  check('5 inferred fridge is not established', id.familyEstablished === false && id.family !== 'fridge-freezer');
  check('5b cover+cold is working microwave not fridge', id.family === 'microwave' && id.familyState === FAMILY_STATE.WORKING);
  const filtered = applyFamilyFilter(
    [{ applianceFamily: 'fridge-freezer' }, { applianceFamily: 'microwave' }],
    'microwave',
    true,
  );
  check('5c established family scopes retrieval', filtered.length === 1 && filtered[0].applianceFamily === 'microwave');
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Double oven. Fan works. Oven and grill don\'t.' }],
  });
  const clamped = constrainReplyToIdentity(
    'On a gas cooker the thermocouple has shut off the gas supply.',
    id,
  );
  check('6 COMPOSE cannot redefine oven as gas when fuel unknown', clamped.changed === true && id.fuel !== 'gas');
}
{
  const hydrated = hydrateConversationRoles([
    { role: 'user', content: 'Customer: My tumble dryer has no heat\nAdvisor asked: Is it an induction hob?' },
  ]);
  const assistant = hydrated.find((m) => m.role === 'assistant');
  const id = resolveConversationIdentity({ messages: hydrated });
  check('7 assistant hob guess is not customer identity', id.family === 'tumble-dryer');
  check('7b assistant turn is hydrated as assistant', assistant && /hob/i.test(assistant.content));
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'My washing machine fills but the drum never spins' },
      { role: 'assistant', content: 'Is there water left standing in the bottom of the drum?' },
      { role: 'user', content: 'yes' },
    ],
  });
  check('8 yes binds without changing family', id.family === 'washing-machine' && id.latestIsFollowUp);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'My washing machine fills but the drum never spins' },
      { role: 'assistant', content: 'Is there water left standing in the bottom of the drum?' },
      { role: 'user', content: 'no' },
    ],
  });
  check('9 no binds without changing family', id.family === 'washing-machine' && id.latestIsFollowUp);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'My microwave is not heating' },
      { role: 'assistant', content: 'Does it run normally with the turntable turning?' },
      { role: 'user', content: "I don't know" },
    ],
  });
  check('10 I don\'t know binds and stays microwave', id.family === 'microwave' && id.latestIsFollowUp);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'My dishwasher is not draining' },
      { role: 'assistant', content: 'Have you cleaned the filter?' },
      { role: 'user', content: 'already tried that' },
    ],
  });
  check('11 already tried that preserves identity', id.family === 'dishwasher' && id.latestIsFollowUp);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'My dishwasher isn\'t draining' },
      { role: 'user', content: 'sorry, I meant my washing machine' },
    ],
  });
  check('12 explicit correction can change family', id.family === 'washing-machine' && id.familyState === FAMILY_STATE.ESTABLISHED);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: "it's a gas oven and it's electric" }],
  });
  const intent = { applianceType: 'oven-cooker', clarifyingQuestion: null };
  lockIdentityOnIntent(intent, id, []);
  check('13 genuine fuel conflict produces clarification rather than mutation', id.fuelConflict === true);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'Bosch washing machine WAN28281GB won\'t drain' },
      { role: 'user', content: 'yes' },
    ],
  });
  check('14 make/model survive cross-turn', /bosch/i.test(id.customerText) && /WAN28281GB/i.test(id.customerText) && id.family === 'washing-machine');
}
{
  check('15 model token is not an error code', looksLikeModelToken('V6') === true);
  check('15b V6 not minted as code without cue', guessErrorCode('my dyson v6 is pulsing') == null);
  check('15c extractModelToken keeps V6 as model', extractModelTokenFromText('my dyson v6 is pulsing') === 'v6'
    || extractModelTokenFromText('my dyson v6 is pulsing') === 'V6');
  const spaced = extractModelTokenFromText('dyson v 6 pulsing on and off');
  check('15d spaced model fragments still fuse to a model token', /^v6$/i.test(spaced || ''));
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'the pump is noisy' }],
  });
  check('16 unknown identity remains unknown rather than fabricated', id.family == null && id.familyEstablished === false && id.familyState === FAMILY_STATE.UNKNOWN);
  const intent = { applianceType: 'fridge-freezer', clarifyingQuestion: 'Is the freezer cold?' };
  lockIdentityOnIntent(intent, id, [{ applianceFamily: 'fridge-freezer' }]);
  check('16b inferred fridge is cleared', intent.applianceType == null && /appliance/i.test(intent.clarifyingQuestion));
}
{
  const docs = [
    { applianceFamily: 'tumble-dryer', faultId: 'not-heating' },
    { applianceFamily: 'vacuum', faultId: 'lost-suction' },
  ];
  const locked = applyFamilyFilter(docs, 'tumble-dryer', true);
  check('17 established family scopes retrieval', locked.length === 1 && locked[0].faultId === 'not-heating');
  check('17b vacuum suction discriminator is not a dryer question', discriminatorQuestionText('noPower', 'tumble-dryer') == null);
  check('17c vacuum suction discriminator remains for vacuum', /suction/i.test(discriminatorQuestionText('noPower', 'vacuum') || ''));
}
{
  const id = resolveConversationIdentity({
    bodyAppliance: 'tumble-dryer',
    identitySource: 'customer',
    messages: [{ role: 'user', content: 'My tumble dryer tripped the electrics after I fitted a new element' }],
  });
  check('18 fuel/type electric-only families / dryer with element stays off the gas path', id.family === 'tumble-dryer' && id.fuel !== 'gas');
  const gasDocs = applyFuelFilter(
    [{ faultId: 'not-heating' }, { faultId: 'ignition' }],
    id,
  );
  check('18b ignition docs dropped when fuel is not gas', gasDocs.every((d) => d.faultId !== 'ignition'));
  check('18c retrieval fuel filter matches identity module', retrievalFuelFilter([{ faultId: 'ignition' }], { fuel: 'electric' }).length === 0);
}

check('follow-up helper: yes', isShortFollowUp('yes') === true);
check('follow-up helper: already tried that', isShortFollowUp('already tried that') === true);
check('identity lock mentions established family', /microwave/.test(formatIdentityLock({
  familyEstablished: true, familyState: FAMILY_STATE.ESTABLISHED, family: 'microwave', familySource: 'customer', fuel: 'electric',
})));
check('foreign family question detected', questionAsksDifferentFamily('Is it just the fridge that’s warm?', 'microwave') === true);
check('dyson brand is not customer-established vacuum word', !identityNamedFamilies('My Dyson V8 is not picking up').includes('vacuum'));
check('hoover + tumble dryer is not vacuum', identityNamedFamilies('Hoover tumble dryer heating circuit trips').includes('tumble-dryer')
  && !identityNamedFamilies('Hoover tumble dryer heating circuit trips').includes('vacuum'));
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Electric double oven. Fan works, oven and grill do not.' }],
  });
  check('electric double oven fuel is electric', id.family === 'oven-cooker' && id.fuel === 'electric');
}

// ---------------------------------------------------------------------------
// Three-state identity architecture
// ---------------------------------------------------------------------------
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'it is not working' }],
  });
  check('T1 unknown remains unknown with genuinely insufficient evidence', id.familyState === FAMILY_STATE.UNKNOWN && id.family == null);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Bosch WMA2841 will not drain' }],
    catalogueFamily: 'washing-machine',
  });
  check('T2 strong model metadata creates WORKING identity', id.family === 'washing-machine' && id.familyState === FAMILY_STATE.WORKING);
  check('T2b catalogue working is not customer-established', id.familyEstablished === false);
  check('T2c catalogue source is catalogue-model', id.familySource === 'catalogue-model');
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'The front loader will not spin and the detergent drawer is blocked' }],
  });
  check('T3 multiple strong compatible observations create WORKING identity', id.family === 'washing-machine' && id.familyState === FAMILY_STATE.WORKING);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'the drain is slow' }],
  });
  check('T4 one ambiguous symptom does not establish identity', id.family == null && id.familyState === FAMILY_STATE.UNKNOWN);
  const heat = resolveConversationIdentity({ messages: [{ role: 'user', content: 'no heat' }] });
  check('T4b heat alone is unknown', heat.family == null);
  const suction = resolveConversationIdentity({ messages: [{ role: 'user', content: 'lost suction' }] });
  check('T4c suction alone is unknown', suction.family == null);
  const noise = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'it makes a scraping noise when it runs' }],
  });
  check('T4d shared noise does not establish identity', noise.family == null && noise.familyState === FAMILY_STATE.UNKNOWN);
  const fillEmpty = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'it takes water then the cycle stops. emptying works if I cancel.' }],
  });
  check('T4e shared fill and empty functions do not establish identity',
    fillEmpty.family == null && fillEmpty.familyState === FAMILY_STATE.UNKNOWN);
}
{
  const docs = [
    { applianceFamily: 'washing-machine', faultId: 'not-draining' },
    { applianceFamily: 'dishwasher', faultId: 'not-draining' },
  ];
  const scoped = applyFamilyFilter(docs, 'washing-machine', FAMILY_STATE.WORKING);
  check('T5 WORKING identity can scope retrieval', scoped.length === 1 && scoped[0].applianceFamily === 'washing-machine');
  const empty = applyFamilyFilter([{ applianceFamily: 'dishwasher' }], 'washing-machine', FAMILY_STATE.WORKING);
  check('T5b working high-confidence family does not fall back across families', empty.length === 0);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Beko TDC40W clothes come out wet' }],
    catalogueFamily: 'tumble-dryer',
  });
  const intent = {
    applianceType: null,
    needMoreInfo: true,
    clarifyingQuestion: 'What kind of appliance is it?',
    faultId: 'not-heating',
  };
  lockIdentityOnIntent(intent, id, []);
  check('T6 WORKING identity supports diagnosis without identity clarification', intent.applianceType === 'tumble-dryer' && !/appliance/i.test(intent.clarifyingQuestion || ''));
  check('T7 WORKING identity is NOT customer-established', id.familyEstablished === false && id.familyState === FAMILY_STATE.WORKING);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Beko TDC40W clothes come out wet' }],
    catalogueFamily: 'tumble-dryer',
  });
  const beforeState = id.familyState;
  lockIdentityOnIntent({ applianceType: 'vacuum', faultId: 'lost-suction' }, id, [{ applianceFamily: 'vacuum' }]);
  check('T8 retrieval cannot upgrade WORKING to ESTABLISHED', id.familyState === FAMILY_STATE.WORKING && id.familyEstablished === false && beforeState === FAMILY_STATE.WORKING);
  check('T8b lock keeps working family not vacuum', id.family === 'tumble-dryer');
}
{
  const hydrated = hydrateConversationRoles([
    { role: 'user', content: 'Customer: Beko TDC40W no heat\nAdvisor asked: Has it lost suction?' },
  ]);
  const id = resolveConversationIdentity({
    messages: hydrated,
    catalogueFamily: 'tumble-dryer',
  });
  check('T9 assistant text cannot upgrade WORKING to ESTABLISHED', id.family === 'tumble-dryer' && id.familyState === FAMILY_STATE.WORKING && id.familyEstablished === false);
  check('T24 assistant incorrect question cannot poison subsequent identity', id.family !== 'vacuum');
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Beko TDC40W no heat' }],
    catalogueFamily: 'tumble-dryer',
  });
  const clamped = constrainReplyToIdentity(
    'If the vacuum has lost suction, check the hose and filters.',
    id,
  );
  check('T10 COMPOSE cannot change family', clamped.changed === true && id.family === 'tumble-dryer' && id.familyState === FAMILY_STATE.WORKING);
  const airflow = constrainReplyToIdentity(
    'Weak airflow often means a blocked filter or vent on this machine.',
    id,
  );
  check('T17 working dryer cannot become vacuum merely from airflow terminology', id.family === 'tumble-dryer' && id.familyState === FAMILY_STATE.WORKING && airflow.changed === false);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'My washing machine will not drain' }],
  });
  check('T11 customer explicit naming creates ESTABLISHED', id.family === 'washing-machine' && id.familyState === FAMILY_STATE.ESTABLISHED);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'My dishwasher isn\'t draining' },
      { role: 'user', content: 'Sorry, it\'s actually my washing machine.' },
    ],
  });
  check('T12 explicit correction replaces ESTABLISHED identity', id.family === 'washing-machine' && id.familyState === FAMILY_STATE.ESTABLISHED);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'Bosch WMA2841 will not drain' },
      { role: 'user', content: 'it is actually my dishwasher' },
    ],
    catalogueFamily: 'washing-machine',
  });
  check('T13 explicit customer evidence overrides WORKING identity', id.family === 'dishwasher' && id.familyState === FAMILY_STATE.ESTABLISHED);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'Bosch WMA2841 will not drain' },
      { role: 'assistant', content: 'Is there water left in the drum?' },
      { role: 'user', content: 'yes' },
    ],
    catalogueFamily: 'washing-machine',
  });
  check('T14 short yes/no preserves WORKING identity', id.family === 'washing-machine' && id.familyState === FAMILY_STATE.WORKING && id.latestIsFollowUp);
}
{
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'Bosch WMA2841 will not drain' },
      { role: 'assistant', content: 'Is there water left in the drum?' },
      { role: 'user', content: "I don't know" },
    ],
    catalogueFamily: 'washing-machine',
  });
  check('T15 I don\'t know preserves WORKING identity', id.family === 'washing-machine' && id.familyState === FAMILY_STATE.WORKING && id.latestIsFollowUp);
}
{
  // Jev keeps the established microwave across an incidental later "fridge light" mention (that
  // discrimination is Jev's job); the identity module must honour Jev's typed customer_named family.
  const id = resolveConversationIdentity({
    messages: [
      { role: 'user', content: 'My microwave runs but the food stays cold' },
      { role: 'user', content: 'the fridge light is on' },
    ],
    jevFamily: 'microwave', jevFamilyProvenance: 'customer_named',
  });
  check('T16 established microwave cannot become fridge', id.family === 'microwave' && id.familyState === FAMILY_STATE.ESTABLISHED);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Electric tumble dryer is not heating' }],
  });
  check('T18 established electric cannot become gas', id.fuel === 'electric' && id.fuelState === FAMILY_STATE.ESTABLISHED);
  const locked = { faultId: 'ignition', applianceType: 'tumble-dryer' };
  lockIdentityOnIntent(intentFrom(locked), id, [{ faultId: 'ignition' }]);
  check('T18b ignition cannot survive established electric', locked.faultId == null);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'The front loader will not spin' }],
  });
  check('T19 working electric cannot become gas from downstream inference', id.family === 'washing-machine' && id.familyState === FAMILY_STATE.WORKING && id.fuel === 'electric' && id.fuelState === FAMILY_STATE.WORKING && id.fuelEstablished === false);
  const reply = constrainReplyToIdentity('The ignition module or gas valve has failed.', id);
  check('T19b compose cannot invent gas on working electric family', reply.changed === true);
}
{
  check('T20 model token still cannot become error code', looksLikeModelToken('TDC32P') === true && guessErrorCode('Hotpoint TDC32P no heat') == null);
  check('T20b WAN28281GB is a model token', looksLikeModelToken('WAN28281GB') === true);
}
{
  const docs = [
    { applianceFamily: 'microwave', faultId: 'not-heating' },
    { applianceFamily: 'fridge-freezer', faultId: 'warm-fridge' },
  ];
  const est = applyFamilyFilter(docs, 'microwave', FAMILY_STATE.ESTABLISHED);
  check('T21 established family strictly scopes retrieval', est.length === 1 && est[0].applianceFamily === 'microwave');
}
{
  const tablets = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'The 3-in-1 tablets are not dissolving and the crockery is still dirty' }],
  });
  check('T3b dishwasher distinctive cluster is WORKING', tablets.family === 'dishwasher' && idStateWorking(tablets));
  const induction = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Rangemaster 110 induction one zone has no power' }],
  });
  check('T3c induction function is WORKING hob', induction.family === 'hobs' && induction.familyState === FAMILY_STATE.WORKING);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'front loader and 3-in-1 tablets both mentioned somehow' }],
  });
  check('T25 conflicting evidence does not silently pick a family', id.familyState === FAMILY_STATE.UNKNOWN || id.family == null || id.familySource === 'conflict' || id.familyState !== FAMILY_STATE.ESTABLISHED);
  const intent = { applianceType: 'washing-machine', clarifyingQuestion: null };
  if (id.familyState === FAMILY_STATE.UNKNOWN) {
    lockIdentityOnIntent(intent, id, []);
    check('T25b unknown conflict asks identity rather than diagnosing the wrong family', /appliance/i.test(intent.clarifyingQuestion || ''));
  } else {
    check('T25b skip lock when not unknown', true);
  }
}
{
  check('catalogue category maps washing machine', familyFromCatalogueCategory('Washing Machine') === 'washing-machine');
  check('catalogue category maps tumble dryer', familyFromCatalogueCategory('Tumble Dryer') === 'tumble-dryer');
  check('catalogue category maps washer dryer', familyFromCatalogueCategory('Washer Dryer') === 'washer-dryer');
  check('non-unique Samsung 4E does not mint a family', uniqueFamilyForMakeAndCode(CAT.errorCodes, 'samsung', '4E') == null);
  const uniq = uniqueFamilyForMakeAndCode(CAT.errorCodes, 'samsung', '22E');
  check('unique make+code can mint WORKING family', uniq === 'fridge-freezer' || uniq == null);
}
{
  const working = inferWorkingIdentity({ blob: 'Bosch WMA2841 will not drain', catalogueFamily: 'washing-machine' });
  check('inferWorking uses catalogue over a weak drain word', working && working.family === 'washing-machine' && working.source === 'catalogue-model');
  const weak = inferWorkingIdentity({ blob: 'the fan is noisy' });
  check('inferWorking ignores a single ambiguous word', !weak || !weak.family);
}
{
  // Story 5: Jev's TYPED applianceFamily is authoritative WORKING evidence. It is CONSUMED (no longer
  // discarded) when the customer's prose carries no family cue the regex can catch.
  const jevOnly = inferWorkingIdentity({ blob: 'it just wont work anymore', jevFamily: 'dishwasher' });
  check('J1 Jev typed family becomes WORKING evidence when prose has no cue',
    jevOnly && jevOnly.family === 'dishwasher' && jevOnly.source === 'jev-typed-family');
  const idJev = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'it keeps stopping mid cycle' }],
    jevFamily: 'washing-machine',
  });
  check('J2 resolveConversationIdentity adopts Jev family as WORKING (not discarded)',
    idJev.family === 'washing-machine' && idJev.familyState === FAMILY_STATE.WORKING
    && idJev.familyEstablished === false);
  const idNamedWins = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'my dishwasher is not draining' }],
    jevFamily: 'dishwasher', jevFamilyProvenance: 'customer_named',
  });
  check('J3 Jev customer_named provenance makes the family ESTABLISHED',
    idNamedWins.family === 'dishwasher' && idNamedWins.familyEstablished === true);
  const catWins = inferWorkingIdentity({
    blob: 'Bosch WMA2841 will not drain', catalogueFamily: 'washing-machine', jevFamily: 'dishwasher',
  });
  check('J4 a resolved catalogue model outranks Jev typed family',
    catWins && catWins.family === 'washing-machine' && catWins.source === 'catalogue-model');
  // Jev is the sole family interpreter: its typed family is the WORKING family; there is no
  // customer-prose function-cue layer left to contradict it.
  const jevInferred = inferWorkingIdentity({ jevFamily: 'tumble-dryer' });
  check('J5 Jev typed family is the WORKING family (no prose function-cue layer)',
    jevInferred && jevInferred.family === 'tumble-dryer' && jevInferred.source === 'jev-typed-family');
}
{
  const lock = formatIdentityLock({
    family: 'washing-machine', familyState: FAMILY_STATE.WORKING, familySource: 'catalogue-model',
    familyEvidence: 'catalogue-category', fuel: 'electric', fuelState: FAMILY_STATE.WORKING,
  });
  check('WORKING lock is not described as customer-stated', /WORKING/i.test(lock) && !/CUSTOMER-ESTABLISHED/.test(lock.split('\n').find((l) => /applianceFamilyState/.test(l)) || ''));
  check('WORKING lock forbids identity question', /do not ask what kind of appliance/i.test(lock));
  check('WORKING lock requires family-compatible customer actions', /programmes, controls, named parts, and procedures MUST belong/i.test(lock));
}
{
  check('hasOperationalFamily working', hasOperationalFamily({ family: 'washing-machine', familyState: FAMILY_STATE.WORKING }));
  check('hasOperationalFamily unknown', hasOperationalFamily({ family: null, familyState: FAMILY_STATE.UNKNOWN }) === false);
}
{
  const intent = { applianceType: 'vacuum' };
  lockApplianceType(intent, {
    family: 'tumble-dryer',
    source: 'catalogue-model',
    identity: resolveConversationIdentity({
      messages: [{ role: 'user', content: 'Beko TDC40W no heat' }],
      catalogueFamily: 'tumble-dryer',
    }),
  }, [{ applianceFamily: 'vacuum' }]);
  check('lockApplianceType does not promote working to established via retrieval', intent.applianceType === 'tumble-dryer');
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'it makes a scraping noise when it runs — is it ok to keep using?' }],
  });
  check('T26 unstated family stays unknown', id.family == null && id.familyState === FAMILY_STATE.UNKNOWN);
  const invented = constrainReplyToIdentity(
    'This is likely normal behaviour for a vacuum cleaner (suction noise or brush bar hitting the floor).',
    id,
  );
  check('T26b COMPOSE cannot invent a family when identity is unknown', invented.changed === true && invented.reason === 'family-invented');
  check('T26c fallback asks identity and does not name a family',
    /what kind of appliance/i.test(invented.text) && !/\bvacuum\b/i.test(invented.text) && !/\bwasher\b/i.test(invented.text));
  check('T26d fallback does not authorise continued use', /not assume[\s\S]*fine to keep using|should not assume/i.test(invented.text));
  const ask = constrainReplyToIdentity(
    'Which appliance is this, and what is the make and model on the rating plate?',
    id,
  );
  check('T26e identity question without a named family is kept', ask.changed === false);
  const washer = constrainReplyToIdentity(
    'On this washing machine the drum bearing is the usual cause.',
    id,
  );
  check('T26f an invented washer is also clamped', washer.changed === true && washer.reason === 'family-invented');
  const genericSeal = constrainReplyToIdentity(
    'A leak at the door can be around the door seal. What kind of appliance is it?',
    id,
  );
  check('T26g shared door-seal advice is kept while family is unknown',
    genericSeal.changed === false, genericSeal.reason && genericSeal.text);
  const mixedArch = constrainReplyToIdentity(
    'A leak at the door can be around the door seal. Look in the gasket folds of the drum. What kind of appliance is it?',
    id,
  );
  check('T26h family-specific architecture is stripped without discarding shared advice',
    mixedArch.changed === true
    && /door seal/i.test(mixedArch.text)
    && !/\bdrum\b/i.test(mixedArch.text)
    && /what kind of appliance/i.test(mixedArch.text), mixedArch.text);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'the dishes come out hot but still wet' }],
  });
  const allowed = constrainReplyToIdentity(
    'On this dishwasher, heat reaching the load downranks a complete heating failure.',
    id,
    { allowedFamily: 'dishwasher' },
  );
  check('T27 customer-grounded family may be named', allowed.changed === false);
  const foreign = constrainReplyToIdentity(
    'This is likely a vacuum cleaner filter issue.',
    id,
    { allowedFamily: 'dishwasher' },
  );
  check('T27b a different family is still foreign', foreign.changed === true);
}
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'Put washing-up liquid in the dishwasher, foam everywhere.' }],
  });
  check('T28 dishwasher named from detergent/foam evidence is established', id.family === 'dishwasher' && id.familyState === FAMILY_STATE.ESTABLISHED);
  const mixed = constrainReplyToIdentity(
    'This is the wrong detergent, not a failed part. Cancel the cycle and let the foam settle. Then use a Drain or Spin programme and rinse the drum.',
    id,
  );
  check('T28b other-family procedures cannot survive into the reply', mixed.changed === true && mixed.reason === 'family-incompatible');
  check('T28c remaining advice does not keep the foreign procedures',
    mixed.text.length > 0
    && !replyUsesForeignFamilyInstruction(mixed.text, 'dishwasher'));
  check('T28c2 clamp fallback does not announce or re-ask identity',
    !/i am treating this as your|what kind of appliance|describe what it is doing/i.test(mixed.text));
  const local = constrainReplyToIdentity(
    'This is excess foam from the wrong detergent, not a failed part. Stop or cancel the cycle, let the foam settle, and scoop or wipe it. Then run an empty rinse using this dishwasher\'s own cancel or drain control.',
    id,
  );
  check('T28d same-family foam advice is kept', local.changed === false, local.reason && local.text);
  const pump = constrainReplyToIdentity(
    'If water is left in the base after the foam has gone, check the drain filter and drain pump on this dishwasher.',
    id,
  );
  check('T28e shared drain/pump language on this family is kept', pump.changed === false, pump.reason && foreignFamilyTermsIn(pump.text, 'dishwasher'));
  const washer = constrainReplyToIdentity(
    'Run a rinse or spin to clear the suds, then rinse the drum.',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'My washing machine is full of foam.' }] }),
  );
  check('T28f the same procedures remain valid on the family that owns them', washer.changed === false, washer.reason);
  const intent = {
    applianceType: 'dishwasher',
    faultId: 'motor-drum',
    nextBestCheck: 'Select Drain or Spin and rinse the drum.',
    candidateComponents: ['drum bearing', 'drain pump'],
  };
  constrainIntentToFamily(intent, 'dishwasher');
  check('T28g intent cannot keep another family\'s fault or procedure', intent.faultId == null && intent.nextBestCheck == null);
  check('T28h shared components survive; exclusive ones do not',
    intent.candidateComponents.includes('drain pump') && !intent.candidateComponents.includes('drum bearing'));
  const oneLiner = constrainReplyToIdentity(
    'Use a Drain or Spin programme and rinse the drum to clear the foam.',
    id,
  );
  check('T28i a fully foreign instruction is replaced without identity announcement',
    oneLiner.changed === true
    && oneLiner.reason === 'family-incompatible'
    && !/i am treating this as your|what kind of appliance|describe what it is doing/i.test(oneLiner.text)
    && /foam|cancel|not a failed part/i.test(oneLiner.text)
    && !replyUsesForeignFamilyInstruction(oneLiner.text, 'dishwasher'));
  const dryerOk = constrainReplyToIdentity(
    'The drum spinning shows the motor is working. For no heat, clean the fluff filter and condenser before assuming a heater failure.',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'My tumble dryer drum turns but there is no heat.' }] }),
  );
  check('T28j rotation language on a dryer is not treated as foreign', dryerOk.changed === false, dryerOk.reason);
  const wmAsk = constrainReplyToIdentity(
    'A belt that looks OK is not the whole drive. Can you turn the drum by hand, and do you hear the motor hum?',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'My washing machine fills but the drum never turns. The belt looks OK.' }] }),
  );
  check('T28k a same-family drum/drive discriminator is kept', wmAsk.changed === false, wmAsk.reason);
  const dryerCold = constrainReplyToIdentity(
    'The drum turns but the clothes stay cold. Clean the fluff filter and check the vent before assuming the heater has failed.',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'My tumble dryer drum turns but clothes stay cold.' }] }),
  );
  check('T28l dryer no-heat advice that mentions cold clothes is kept', dryerCold.changed === false, dryerCold.reason);
  const dwMoisture = constrainReplyToIdentity(
    'Thanks — those first-line checks are already answered. For this identified machine, the next useful observation is whether remaining moisture is mainly on plastics or also on glass and crockery.',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'Dishes hot but not dry.' }] }),
    { allowedFamily: 'dishwasher' },
  );
  check('T28m dishwasher drying advice may mention moisture on glassware',
    dwMoisture.changed === false, dwMoisture.reason && foreignFamilyTermsIn(dwMoisture.text, 'dishwasher'));
  const dwBlock = constrainReplyToIdentity(
    'The impeller turns freely, so an obvious blockage is less likely. Next check whether the drain hose is kinked.',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'My Bosch dishwasher just hums. Filter is clear.' }] }),
  );
  check('T28n shared blockage language on a dishwasher is kept', dwBlock.changed === false, dwBlock.reason);
  const dwSensor = constrainReplyToIdentity(
    'This looks like a failed moisture sensor. Rinse the drum on a spin programme.',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'Put washing-up liquid in the dishwasher, foam everywhere.' }] }),
  );
  check('T28o exclusive other-family parts and procedures are still clamped',
    dwSensor.changed === true
    && dwSensor.reason === 'family-incompatible'
    && !replyUsesForeignFamilyInstruction(dwSensor.text, 'dishwasher'));
  const waterQ = constrainReplyToIdentity(
    'Is there water left standing in the bottom of the drum, or does it drain away fully?',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'My dishwasher just hums.' }] }),
  );
  check('T28p a drum-specific standing-water question cannot be asked on a dishwasher',
    waterQ.changed === true && !/\bdrum\b/i.test(waterQ.text), waterQ.text);
  const dwPumpDrum = constrainReplyToIdentity(
    'A weak or failed drain-path component is a reasonable hypothesis together with any remaining downstream restriction. Do not treat a free impeller as proof the pump has failed, and do not instruct buying it as the next step even if the drum looks empty.',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'My Bosch dishwasher just hums. Filter is clear.' }] }),
  );
  check('T28p2 dishwasher drain advice that mentions drum is not replaced by a stay-only sentence',
    dwPumpDrum.changed === true
    && /drain-path|impeller|pump/i.test(dwPumpDrum.text)
    && !/\bdrum\b/i.test(dwPumpDrum.text)
    && !/stay with the controls/i.test(dwPumpDrum.text), dwPumpDrum.text);
  const wmWaterQ = constrainReplyToIdentity(
    'Is there water left standing in the bottom of the drum, or does it drain away fully?',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'My washing machine just hums.' }] }),
  );
  check('T28q the same standing-water question remains valid on a drum family', wmWaterQ.changed === false, wmWaterQ.reason);
  const intentDw = {
    applianceType: 'dishwasher',
    clarifyingQuestion: 'Is there water left standing in the bottom of the drum, or does it drain away fully?',
    _materialAmbiguity: {
      fact: 'waterRemaining',
      question: 'Is there water left standing in the bottom of the drum, or does it drain away fully?',
    },
  };
  constrainIntentToFamily(intentDw, 'dishwasher');
  check('T28r intent cannot keep a drum-specific discriminator on a dishwasher',
    intentDw.clarifyingQuestion == null && intentDw._materialAmbiguity == null);
  const dryerElement = constrainReplyToIdentity(
    'The heating element is a later hypothesis. Clean the fluff filter and check the vent hose before assuming a heat part has failed. Once you have done that, try another cycle.',
    resolveConversationIdentity({ messages: [{ role: 'user', content: 'tumble dryer going round but clothes stay cold, is it the heater' }] }),
  );
  check('T28s shared heating-element language on a dryer is kept', dryerElement.changed === false, dryerElement.reason && foreignFamilyTermsIn(dryerElement.text, 'tumble-dryer'));
}

function intentFrom(obj) { return obj; }
function idStateWorking(id) { return id.familyState === FAMILY_STATE.WORKING; }

// Story 4: identity + condition-limited meaning is supplied to COMPOSE as AUTHORITATIVE STRUCTURED
// STATE (the pre-COMPOSE input), NOT rediscovered by a post-COMPOSE prose re-parser. Assert
// buildComposeSystem states those structured constraints so COMPOSE produces the correct reply
// directly. Structured input assertion — no reply prose rewriting.
{
  const sys = (intent) => buildComposeSystem([], null, intent, null, [], null, false, false, null, false, null,
    { isFollowUp: true, priorUserText: '', latestUserText: '', priorAdvisorText: '' });
  const established = sys({
    applianceType: 'dishwasher', _applianceUnconfirmed: false, make: 'Bosch', model: 'SMS50C12GB',
    conditionLimited: ['heater'], facts: [], reportedSymptoms: [],
  });
  check('S4-1 established family is stated to COMPOSE as authoritative (do not re-ask appliance)',
    /IDENTITY IS ESTABLISHED/.test(established) && /do NOT ask which appliance/i.test(established));
  check('S4-2 known model is stated to COMPOSE (do not re-ask make/model)',
    /MODEL IS KNOWN/.test(established) && /SMS50C12GB/.test(established));
  check('S4-3 condition-limited part is stated as not-a-confirmed-failure to COMPOSE',
    /CONDITION-LIMITED/.test(established) && /do NOT state[\s\S]{0,60}confirmed failed/i.test(established));
  const unknownFam = sys({ applianceType: null, _applianceUnconfirmed: true, facts: [], reportedSymptoms: [] });
  check('S4-4 unknown family is NOT asserted as established to COMPOSE',
    !/IDENTITY IS ESTABLISHED/.test(unknownFam));
}

(async () => {
  const unscoped = await retrieve({}, 'the pump is noisy and there is no heat', 3);
  check('T23 unknown does not cause arbitrary cross-family retrieval', unscoped.mode === 'unresolved-family' && unscoped.docs.length === 0);
  const workingScoped = await retrieve({
    applianceFamily: 'washing-machine',
    familyState: FAMILY_STATE.WORKING,
  }, 'will not drain', 3);
  check('T22 working high-confidence family scopes retrieval', workingScoped.docs.every((d) => d.applianceFamily === 'washing-machine'));
  const estScoped = await retrieve({
    applianceFamily: 'microwave',
    familyState: FAMILY_STATE.ESTABLISHED,
  }, 'food stays cold', 3);
  check('T21b established microwave retrieval stays microwave', estScoped.docs.every((d) => d.applianceFamily === 'microwave'));

  console.log(`\nidentity-integrity: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
