/**
 * DRYING DIAGNOSTIC DEPTH — cross-appliance material discrimination for "not drying".
 *
 * The material dimension is the HEAT STATE at the end of the cycle: WARM/HOT but wet = a drying/
 * rinse-aid/airflow issue (usually NO part) vs STONE COLD = a genuine heating fault (a part).
 * Before committing, if both a no-part/maintenance node and a heating-hardware node are plausible
 * and the heat state is UNKNOWN, ask the safe heat discriminator. Proven for dishwasher, washer-dryer
 * and tumble-dryer, reusing the material-ambiguity gate + evidence engine.
 *
 * Run: node services/part-finder/test/drying-diagnostic-depth.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  materialAmbiguity, commitFromEvidence, factConflict, scoreNodeEvidence,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (fam, id) => CAT.faults[fam][id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const amb = (fam, leaderId, obj) => materialAmbiguity(leaderId, node(fam, leaderId), facts(obj), fam);
const commit = (obj, fam) => commitFromEvidence({ facts: facts(obj) }, fam);

// ============================================================================
// B. DISHWASHER (PRIMARY / DW-011) — no-part poor-drying vs heating hardware
// ============================================================================
// B1 bare "not drying", heat UNKNOWN (NO facts) -> material ambiguity fires (the key DW-011 fix).
{
  const a = amb('dishwasher', 'poor-drying', {});
  check('B1 poor-drying ADVICE_ONLY leader (heat unknown) -> do NOT delay advice to ask heat', a === null, a);
  const a2 = amb('dishwasher', 'heating', {});
  check('B1c heating leader (heat unknown) -> still ask vs poor-drying (do not sell a heater yet)', a2 && a2.altId === 'poor-drying', a2 && a2.altId);
  check('B1d heating-leader discriminator is the heat state', a2 && (a2.fact === 'noHeat' || a2.fact === 'heatPresent'), a2 && a2.fact);
}
// B2 stone cold -> heating hardware commits; poor-drying contradicted.
{
  const c = commit({ noHeat: 'TRUE' }, 'dishwasher');
  check('B2 no-heat -> heating', c && c.faultId === 'heating', c && c.faultId);
  check('B2b poor-drying contradicted by no-heat', factConflict(node('dishwasher', 'poor-drying'), facts({ noHeat: 'TRUE' })).contradicted === true);
}
// B3 warm but wet -> poor-drying (no-part / rinse-aid / settings); heating contradicted.
{
  const c = commit({ heatPresent: 'TRUE' }, 'dishwasher');
  check('B3 heat-present -> poor-drying', c && c.faultId === 'poor-drying', c && c.faultId);
  check('B3b poor-drying is ADVICE_ONLY (no part)', c && c.node.outcome === 'ADVICE_ONLY');
  check('B3c heating contradicted by heat-present', factConflict(node('dishwasher', 'heating'), facts({ heatPresent: 'TRUE' })).contradicted === true);
}
// B4 heat state answered -> no re-ask (no loop).
check('B4 heat answered -> no material ambiguity', amb('dishwasher', 'poor-drying', { heatPresent: 'TRUE' }) === null
  && amb('dishwasher', 'heating', { noHeat: 'TRUE' }) === null);

// ============================================================================
// C. WASHER-DRYER — airflow/maintenance (no-part) vs drying heater (part)
// ============================================================================
{
  const a = amb('washer-dryer', 'drying-poor', {});
  check('C1 WD airflow ADVICE_ONLY leader (heat unknown) -> do NOT delay advice to ask heat', a === null, a);
  const aHeat = amb('washer-dryer', 'drying-heater', {});
  check('C1b WD heating leader (heat unknown) -> still ask vs airflow', aHeat && aHeat.altId === 'drying-poor', aHeat && aHeat.altId);
  check('C2 WD no-heat -> drying-heater', (commit({ noHeat: 'TRUE' }, 'washer-dryer') || {}).faultId === 'drying-heater');
  const c = commit({ heatPresent: 'TRUE' }, 'washer-dryer');
  check('C3 WD heat-present -> airflow/poor-drying (no part)', c && c.faultId === 'drying-poor' && c.node.outcome === 'ADVICE_ONLY', c && c.faultId);
}

// ============================================================================
// D. TUMBLE-DRYER — poor-drying/airflow (maintenance) vs not-heating (part)
// ============================================================================
{
  const a = amb('tumble-dryer', 'poor-drying', {});
  check('D1 TD poor-drying ADVICE_ONLY leader (heat unknown) -> do NOT delay advice to ask heat', a === null, a);
  const aHeat = amb('tumble-dryer', 'not-heating', {});
  check('D1b TD not-heating leader (heat unknown) -> still ask vs poor-drying', aHeat && aHeat.altId === 'poor-drying', aHeat && aHeat.altId);
  check('D2 TD no-heat -> not-heating', (commit({ noHeat: 'TRUE' }, 'tumble-dryer') || {}).faultId === 'not-heating');
  check('D3 TD heat-present -> poor-drying', (commit({ heatPresent: 'TRUE' }, 'tumble-dryer') || {}).faultId === 'poor-drying');
}

// ============================================================================
// E. CROSS-FAMILY — same fact, family-specific candidates; no leakage
// ============================================================================
check('E1 dishwasher heat-present commits a DISHWASHER node (rinse-aid poor-drying), not a dryer node',
  (commit({ heatPresent: 'TRUE' }, 'dishwasher') || {}).faultId === 'poor-drying');
check('E2 tumble-dryer no-heat commits a TUMBLE-DRYER node, not a dishwasher heating node',
  (commit({ noHeat: 'TRUE' }, 'tumble-dryer') || {}).faultId === 'not-heating');

// ============================================================================
// F. UNKNOWN semantics + contradiction
// ============================================================================
check('F1 UNKNOWN heat is neutral in scoring', scoreNodeEvidence(node('dishwasher', 'heating'), facts({ noHeat: 'UNKNOWN' })).score === 0);
check('F2 dishes HOT contradicts the heating (no-heat) node', factConflict(node('dishwasher', 'heating'), facts({ heatPresent: 'TRUE' })).contradicted === true);
check('F3 dishes COLD contradicts the no-part poor-drying node', factConflict(node('dishwasher', 'poor-drying'), facts({ noHeat: 'TRUE' })).contradicted === true);

// ============================================================================
// G. REGRESSION — the refined gate must not over-question prior fixes
// ============================================================================
// WM-008: grinding on spin is a decisive bearings commit; the water/timing facts must NOT trigger a
// spurious discriminator (leader far ahead; no answer can rule motor-drum out here).
check('G1 WM grinding-on-spin -> no material ambiguity (no over-question)',
  materialAmbiguity('motor-drum', CAT.faults['washing-machine']['motor-drum'], facts({ grindingNoise: 'TRUE', noiseOnSpin: 'TRUE' }), 'washing-machine') === null);
// WM-001: "won't spin" (water state unknown) still asks the water discriminator (contradictable leader).
check('G2 WM won\'t-spin (water unknown) -> water discriminator still fires',
  (materialAmbiguity('motor-drum', CAT.faults['washing-machine']['motor-drum'], [], 'washing-machine') || {}).fact === 'waterRemaining');
// DW-015: dishwasher noisy during wash still asks grind-vs-hum.
check('G3 DW noisy-during-wash -> still asks grind-vs-hum',
  (amb('dishwasher', 'circulation-pump', { noiseOnWash: 'TRUE' }) || {}).altId === 'foreign-object');
// not-draining must NOT be turned into a drying/heat question (no contradictable mapped pivotal).
check('G4 not-draining (empty facts) -> no spurious drying question',
  materialAmbiguity('not-draining', CAT.faults['dishwasher']['not-draining'], [], 'dishwasher') === null);

// ============================================================================
// H. SOURCE GUARDS
// ============================================================================
const SRC = fs.readFileSync(path.join(__dirname, '..', 'part-finder-lambda.js'), 'utf8');
const codeOnly = SRC.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('H1 no journey/benchmark id in code', !/dw-011|wd-001|dw-015/i.test(codeOnly));
check('H2 no "not drying -> heater" / "cold -> heater" / "warm -> rinse aid" string rule',
  !/(not ?dry|cold|warm)[\s\S]{0,40}(faultId|return)\s*[:=]\s*['"]?(heat|rinse|drying)/i.test(codeOnly));
check('H4 no drying-specific appliance branch inside the material gate',
  !/materialAmbiguity[\s\S]{0,400}===\s*['"](dishwasher|tumble-dryer|washer-dryer)['"]/i.test(codeOnly));

console.log(`\nDrying diagnostic depth: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
