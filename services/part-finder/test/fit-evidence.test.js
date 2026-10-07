'use strict';

/**
 * Deterministic catalogue fit tests. No benchmark IDs, no live HTTP.
 *
 *   node services/part-finder/test/fit-evidence.test.js
 */
const assert = require('assert');
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const {
  normalizeModelKey,
  classifyModelResolution,
  classifyPartFit,
  selectFitParts,
  cardFitStatus,
  shouldBrandSearch,
  shouldAskForFullerModel,
  FIT_STATE,
  MATCH_TYPE,
} = require('../fit-evidence');
const { matchesComponent, computePresentationGrain, buildComposeSystem } = require('../part-finder-lambda.js')._internal;

function check(name, cond, detail) {
  if (!cond) {
    throw new Error(`FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
  console.log('  ok  - ' + name);
}

const WFF = { model: 'WFF1201GB/01', make: 'Bosch', category: 'Washing-Machine' };
const WTA = { model: 'WTA4107GB/01', make: 'Bosch', category: 'Washing-Machine' };
const WMA = { model: 'WMA63P/S', make: 'Hotpoint', category: 'Washing-Machine' };
const BRUSHES = { partNo: 'CBN2222', title: 'Brushes' };
const HEATER = { partNo: 'ELE9267', title: 'Heater Element' };
const PUMP = { partNo: '00146083', title: 'Drain Pump Assembly' };
const SERIAL = {
  partNo: '00422149',
  title: 'Currently Unavailable *SERIAL NUMBER DEPENDANT, PLEASE CONTACT US TO CONFIRM* Transformer Ignition Device',
};

check('normalise strips spaces and punctuation', normalizeModelKey('WFF 2000 /01') === 'WFF200001');
check('normalise is case-insensitive', normalizeModelKey('wff1201gb/01') === 'WFF1201GB01');

{
  const r = classifyModelResolution({ query: 'WFF1201GB/01', matches: [WFF], requestedMake: 'Bosch' });
  check('exact model uniquely resolves', r.matchType === MATCH_TYPE.EXACT && r.resolvedModel === 'WFF1201GB/01', JSON.stringify(r));
}
{
  const r = classifyModelResolution({ query: 'WFF1201', matches: [WFF] });
  check('factory suffix uniquely completes', r.matchType === MATCH_TYPE.UNIQUE_SUFFIX && r.resolvedModel === 'WFF1201GB/01', JSON.stringify(r));
}
{
  const r = classifyModelResolution({ query: 'WFF 2000', matches: [{ model: 'WFF2000GB/01', make: 'Bosch' }] });
  check('spaced model normalises to the same unique suffix', r.matchType === MATCH_TYPE.UNIQUE_SUFFIX && r.resolvedModel === 'WFF2000GB/01', JSON.stringify(r));
}
{
  const r = classifyModelResolution({
    query: 'WFF1201',
    matches: [WFF, { model: 'WFF1201GB/02', make: 'Bosch' }],
  });
  check('two suffix completions are ambiguous', r.matchType === MATCH_TYPE.AMBIGUOUS && !r.resolvedModel, JSON.stringify(r));
}
{
  const r = classifyModelResolution({ query: 'WMA63', matches: [WMA] });
  check('letter remainder is incomplete, not unique', r.matchType === MATCH_TYPE.INCOMPLETE && !r.resolvedModel, JSON.stringify(r));
}
{
  const r = classifyModelResolution({ query: 'APL 1313', matches: [] });
  check('missing catalogue row is not_found', r.matchType === MATCH_TYPE.NOT_FOUND);
}
{
  const r = classifyModelResolution({ query: '', matches: [WFF] });
  check('missing model is none', r.matchType === MATCH_TYPE.NONE);
}
{
  const r = classifyModelResolution({ query: 'WFF1201', matches: [WFF], requestedMake: 'Hotpoint' });
  check('make/model disagreement does not silently resolve', r.matchType === MATCH_TYPE.MAKE_CONFLICT && !r.resolvedModel, JSON.stringify(r));
}

check(
  'confirmed fit requires unique match + modelPart join',
  classifyPartFit({ matchType: MATCH_TYPE.EXACT, onResolvedModelList: true, brandOnly: false, title: 'Brushes' }) === FIT_STATE.CONFIRMED_FIT,
);
check(
  'incompatible when unique model and SKU not on the list',
  classifyPartFit({ matchType: MATCH_TYPE.EXACT, onResolvedModelList: false, brandOnly: false, title: 'Brushes' }) === FIT_STATE.INCOMPATIBLE,
);
check(
  'brand-only cannot become confirmed',
  classifyPartFit({ matchType: MATCH_TYPE.EXACT, onResolvedModelList: false, brandOnly: true, title: 'Brushes' }) === FIT_STATE.VERIFY_FIT,
);
check(
  'missing/not-found model cannot become confirmed',
  classifyPartFit({ matchType: MATCH_TYPE.NOT_FOUND, onResolvedModelList: true, brandOnly: false, title: 'Brushes' }) === FIT_STATE.VERIFY_FIT,
);
check(
  'ambiguous model cannot become confirmed',
  classifyPartFit({ matchType: MATCH_TYPE.AMBIGUOUS, onResolvedModelList: true, brandOnly: false, title: 'Brushes' }) === FIT_STATE.VERIFY_FIT,
);
check(
  'serial-dependent listing is not confirmed even on the model list',
  classifyPartFit({ matchType: MATCH_TYPE.EXACT, onResolvedModelList: true, brandOnly: false, title: SERIAL.title }) === FIT_STATE.VERIFY_FIT,
);

{
  const selected = selectFitParts({
    matchType: MATCH_TYPE.UNIQUE_SUFFIX,
    modelParts: [BRUSHES, PUMP],
    diagnosedComponents: ['carbon brushes'],
    matchesComponent,
  });
  check('component match filters presentation but listed SKU is confirmed', selected.parts.length === 1 && selected.parts[0].partNo === 'CBN2222' && selected.parts[0].fitState === FIT_STATE.CONFIRMED_FIT, JSON.stringify(selected.parts));
}
{
  const selected = selectFitParts({
    matchType: MATCH_TYPE.UNIQUE_SUFFIX,
    modelParts: [BRUSHES],
    diagnosedComponents: ['drain pump'],
    matchesComponent,
  });
  check('component match alone cannot establish fit when SKU is a different component', selected.fitSet === FIT_STATE.NO_FIT_EVIDENCE && selected.parts.length === 0, JSON.stringify(selected));
}
{
  const selected = selectFitParts({
    matchType: MATCH_TYPE.NOT_FOUND,
    modelParts: [],
    brandParts: [BRUSHES],
    diagnosedComponents: ['carbon brushes'],
    matchesComponent,
  });
  check('brand search after model-not-found is verify-fit', selected.parts[0].fitState === FIT_STATE.VERIFY_FIT && selected.parts[0]._brandOnly === true);
}
{
  const selected = selectFitParts({
    matchType: MATCH_TYPE.UNIQUE_SUFFIX,
    modelParts: [HEATER, { partNo: '00498607', title: 'Obsolete Heating Element With No Alternative' }],
    diagnosedComponents: ['heater element'],
    matchesComponent,
  });
  check('multiple compatible heaters all remain confirmed', selected.parts.length === 2 && selected.parts.every((p) => p.fitState === FIT_STATE.CONFIRMED_FIT), JSON.stringify(selected.parts.map((p) => p.partNo)));
}

check('do not brand-search a unique model', shouldBrandSearch({ matchType: MATCH_TYPE.EXACT, hasMake: true }) === false);
check('do not brand-search an incomplete model', shouldBrandSearch({ matchType: MATCH_TYPE.INCOMPLETE, hasMake: true }) === false);
check('do not brand-search a make conflict', shouldBrandSearch({ matchType: MATCH_TYPE.MAKE_CONFLICT, hasMake: true }) === false);
check('brand-search allowed when model is not in the catalogue and make is known', shouldBrandSearch({ matchType: MATCH_TYPE.NOT_FOUND, hasMake: true }) === true);
check('ask for fuller model on incomplete/ambiguous/conflict', shouldAskForFullerModel(MATCH_TYPE.INCOMPLETE) && shouldAskForFullerModel(MATCH_TYPE.AMBIGUOUS) && shouldAskForFullerModel(MATCH_TYPE.MAKE_CONFLICT));

{
  const status = cardFitStatus({ fitState: FIT_STATE.CONFIRMED_FIT, partNo: 'CBN2222' }, { catalogueMatchType: MATCH_TYPE.UNIQUE_SUFFIX });
  check('confirmed fit survives card mapping', status === 'MODEL_CONFIRMED');
}
{
  const status = cardFitStatus({ fitState: FIT_STATE.VERIFY_FIT, partNo: 'CBN2222' }, { catalogueMatchType: MATCH_TYPE.UNIQUE_SUFFIX });
  check('verify-fit survives card mapping', status === 'VERIFY_FIT');
}
{
  const status = cardFitStatus({ fitState: FIT_STATE.INCOMPATIBLE, partNo: 'C00196539' }, { catalogueMatchType: MATCH_TYPE.EXACT });
  check('incompatible is dropped at the card boundary', status === null);
}

{
  const grain = computePresentationGrain({
    intent: { facts: { openCircuitElement: true } },
    fault: { node: { components: ['heater element'] } },
    committedFinding: true,
    safetyStop: null,
    diagnoseStop: null,
    remoteAction: 'none',
    outcome: 'DIAGNOSIS',
    queryText: 'element is open circuit',
  });
  const withParts = computePresentationGrain({
    intent: { facts: { openCircuitElement: true } },
    fault: { node: { components: ['heater element'] } },
    committedFinding: true,
    safetyStop: null,
    diagnoseStop: null,
    remoteAction: 'none',
    outcome: 'DIAGNOSIS',
    queryText: 'element is open circuit',
  });
  check('catalogue presence is not an argument to presentation grain', JSON.stringify(grain) === JSON.stringify(withParts));
}

{
  const prompt = buildComposeSystem(
    [{ title: 'Brushes', partNo: 'CBN2222', price: '12.00', fitState: 'CONFIRMED_FIT', _onModelList: true }],
    { make: 'Bosch', category: 'Washing-Machine', modelNumber: 'WFF1201GB/01' },
    { applianceType: 'washing machine', make: 'Bosch', model: 'WFF1201', candidateComponents: ['carbon brushes'] },
    { faultId: 'motor', node: { label: 'Motor / drum fault', components: ['carbon brushes'] } },
    [],
    null, false, false, null, true,
    { mention: 'purchase', purchaseAppropriate: true },
  );
  check('compose says catalogue is not a diagnosis', /CATALOGUE FIT IS NOT A DIAGNOSIS/.test(prompt));
  check('compose does not tell the model to lead with stocked parts as more likely', !/lead with the first of THESE that fits the symptom \(confirmed to exist/.test(prompt));
}

console.log('\nfit-evidence tests passed');
