/**
 * Vacuum cuts-out / pulsing: the check-first part is a filter, not a charger.
 * Live fail: Dyson V6 pulsing showed "Battery Charger" as MODEL_CONFIRMED because
 * substring "battery" matched the charger title and "pre-motor filter" did not
 * match "Pre Filter Assembly".
 *
 *   node services/part-finder/test/vacuum-check-first-part.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  matchesComponent, rankPartsByFault, preferCheckFirstPart, partsStillInPlay,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail) : '')); }
}

const FILTER = { partId: 5410, partNo: '96566101', title: 'Pre Filter Assembly' };
const HEPA = { partId: 5901, partNo: 'FLT9580', title: 'Hepa Post Motor Filter Non Genuine' };
const CHARGER = { partId: 6711, partNo: 'CBL1034', title: 'Compatible Dyson Vacuum Cleaner Battery Charger - UK Plug : Input: 100-240V Output 26.1 Volts 0.78A' };
const PACK = { partId: 5880, partNo: '96781002', title: 'Power Pack Service Assembly' };

check('A1 pre-motor filter matches Pre Filter Assembly', matchesComponent(FILTER.title, 'pre-motor filter'));
check('A2 pre-motor filter matches HEPA post-motor filter', matchesComponent(HEPA.title, 'pre-motor filter'));
check('A3 battery does NOT match a battery charger', matchesComponent(CHARGER.title, 'battery') === false);
check('A4 charger DOES match a battery charger', matchesComponent(CHARGER.title, 'charger'));
check('A5 battery still matches a power pack', matchesComponent(PACK.title, 'battery'));

const ranked = rankPartsByFault([CHARGER, FILTER, HEPA], { components: CAT.faults.vacuum['cuts-out'].components });
check('B1 ranked first is a filter, not the charger', /filter/i.test(ranked[0].title), ranked.map((p) => p.title));

const promoted = preferCheckFirstPart([CHARGER], [CHARGER, FILTER, HEPA], { node: CAT.faults.vacuum['cuts-out'] });
check('C1 preferCheckFirstPart promotes filter 5410 ahead of the charger', promoted[0].partId === 5410, promoted.map((p) => p.partId));
check('C2 charger remains as a later option', promoted.some((p) => p.partId === 6711));

const already = preferCheckFirstPart([FILTER, CHARGER], [CHARGER, FILTER], { node: CAT.faults.vacuum['cuts-out'] });
check('C3 already-filter first is left alone', already[0].partId === 5410);

const HOSE = { partId: 99, partNo: 'C00214408', title: 'Outlet Sump Hose' };
const FILTER_KIT = { partId: 1, partNo: 'C00252721', title: 'Copreci Pump Filter Kit' };
const leakFault = { node: { components: ['pump filter', 'sump hose', 'drain pump'] } };
const filterRuledOut = { checksReported: ['pump filter cap'] };
const notInjected = preferCheckFirstPart([HOSE], [FILTER_KIT, HOSE], leakFault, filterRuledOut);
check('E1 do not inject a filter card after that area was checked', notInjected[0].partId === 99 && !notInjected.some((p) => p.partId === 1));
const stillInPlay = partsStillInPlay([FILTER_KIT, HOSE], leakFault, filterRuledOut);
check('E2 drop a filter card once that area is ruled out', stillInPlay.length === 1 && stillInPlay[0].partId === 99);
check('E3 vacuum filter promotion is unchanged when that check is not reported',
  preferCheckFirstPart([CHARGER], [CHARGER, FILTER, HEPA], { node: CAT.faults.vacuum['cuts-out'] }, { checksReported: [] })[0].partId === 5410);

check('D2 pulsing is a cuts-out synonym', (CAT.faults.vacuum['cuts-out'].synonyms || []).includes('pulsing'));

console.log('\nvacuum-check-first-part: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
