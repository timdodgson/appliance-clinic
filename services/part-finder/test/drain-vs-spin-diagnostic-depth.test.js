/**
 * WASHING-MACHINE / WASHER-DRYER DRAIN-vs-SPIN DIAGNOSTIC DEPTH.
 *
 * "Won't spin" / "won't drain" / "clothes wet" must not commit prematurely between materially
 * different families: DRAINAGE/water-removal (not-draining / drain-pump), DRIVE/drum-motion
 * (motor-drum), and a customer-correctable LOAD/imbalance NO-PART cause (unbalanced-load). The key
 * causal relationship — a machine WON'T SPIN UNTIL IT HAS DRAINED — is encoded as evidence:
 *   waterRemaining  -> STRONG_SUPPORT not-draining / STRONG_AGAINST motor-drum + unbalanced-load
 *   drainsNormally  -> STRONG_AGAINST not-draining / SUPPORT motor-drum
 *   loadDependent   -> STRONG_SUPPORT unbalanced-load / STRONG_AGAINST motor-drum
 * so retained water routes to drainage (not the motor), drains-fine weakens drainage, and a
 * load-conditional spin failure is the no-part imbalance (not a motor). This pass ALSO gives the
 * washer-dryer nodes the SAME drain/spin signals the washing-machine nodes already had (they had
 * none), so the material gate asks the safe retained-water discriminator for WD too.
 *
 * Observations are never components; "I think the motor/pump has gone" is a hypothesis and derives
 * NOTHING. Wet clothes never directly map to a drain/motor/drying part. Drying boundary (noHeat /
 * heatPresent) and washing-machine leak-source depth are untouched.
 *
 * Run: node services/part-finder/test/drain-vs-spin-diagnostic-depth.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  commitFromEvidence, materialAmbiguity, factConflict, scoreNodeEvidence,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const node = (fam, id) => CAT.faults[fam][id];
const commit = (fam, obj) => { const r = commitFromEvidence({ facts: facts(obj) }, fam); return r ? r.faultId : null; };
const amb = (fam, id, obj) => materialAmbiguity(id, node(fam, id), facts(obj), fam);
const sig = (fam, id, f) => (node(fam, id).signals || []).find((s) => s.fact === f);

// ============================================================================
// C. RETAINED-WATER SPIN-INHIBITION (encoded as evidence, both families)
// ============================================================================
for (const fam of ['washing-machine', 'washer-dryer']) {
  check(`C:${fam} retained water STRONG_SUPPORT not-draining`, (sig(fam, 'not-draining', 'waterRemaining') || {}).effect === 'STRONG_SUPPORT');
  check(`C:${fam} retained water STRONG_AGAINST motor-drum`, (sig(fam, 'motor-drum', 'waterRemaining') || {}).effect === 'STRONG_AGAINST');
  check(`C:${fam} drains-fine STRONG_AGAINST not-draining`, (sig(fam, 'not-draining', 'drainsNormally') || {}).effect === 'STRONG_AGAINST');
  check(`C:${fam} retained water contradicts motor-drum`, factConflict(node(fam, 'motor-drum'), facts({ waterRemaining: 'TRUE' })).contradicted === true);
  check(`C:${fam} drains-fine contradicts not-draining`, factConflict(node(fam, 'not-draining'), facts({ drainsNormally: 'TRUE' })).contradicted === true);
}

// ============================================================================
// D. EVIDENCE COMMIT — observations route to materially-different families
// ============================================================================
for (const fam of ['washing-machine', 'washer-dryer']) {
  check(`D:${fam} retained water + no spin -> not-draining (drainage first)`, commit(fam, { waterRemaining: 'TRUE', spinsSlowly: 'FALSE' }) === 'not-draining');
  check(`D:${fam} pump hums + water remains -> drainage dominates (drain-pump/not-draining top; motor contradicted)`, (() => {
    const f = facts({ pumpHumming: 'TRUE', waterRemaining: 'TRUE' });
    const nd = scoreNodeEvidence(node(fam, 'not-draining'), f).score;
    const dp = scoreNodeEvidence(node(fam, 'drain-pump'), f).score;
    const md = scoreNodeEvidence(node(fam, 'motor-drum'), f).score;
    return Math.max(nd, dp) >= 3 && md < Math.max(nd, dp) && factConflict(node(fam, 'motor-drum'), f).contradicted;
  })());
  check(`D:${fam} load-dependent + drains fine -> unbalanced-load (NO-PART)`, commit(fam, { loadDependent: 'TRUE', waterRemaining: 'FALSE', drainsNormally: 'TRUE' }) === 'unbalanced-load');
  check(`D:${fam} grinding worse at high spin -> motor-drum (drive/bearings)`, commit(fam, { grindingNoise: 'TRUE', noiseWorseAtHighSpeed: 'TRUE', waterRemaining: 'FALSE' }) === 'motor-drum');
}

// ============================================================================
// E. MATERIAL GATE — ask the SAFE retained-water discriminator BEFORE committing (BOTH families)
// ============================================================================
for (const fam of ['washing-machine', 'washer-dryer']) {
  check(`E:${fam} bare motor-drum leader -> asks retained-water (not commit)`, (() => { const a = amb(fam, 'motor-drum', {}); return a && a.fact === 'waterRemaining' && a.altId === 'not-draining'; })());
  check(`E:${fam} bare not-draining leader -> asks retained-water`, (() => { const a = amb(fam, 'not-draining', {}); return a && a.fact === 'waterRemaining'; })());
  check(`E:${fam} retained-water known -> motor-drum leader does NOT re-ask`, amb(fam, 'motor-drum', { waterRemaining: 'TRUE' }) === null || (amb(fam, 'motor-drum', { waterRemaining: 'TRUE' }) || {}).fact !== 'waterRemaining');
}

// ============================================================================
// F. NO HARD-CODED SHORTCUTS (mutation guards, source-level)
// ============================================================================
const SRC = require('./engine-source.cjs')();
check('F1 no "wont spin -> motor" hard-code', !/won'?t ?spin[^\n]{0,30}motor/i.test(SRC));
check('F2 no "water -> pump" hard-code', !/water[^\n]{0,25}->[^\n]{0,10}pump/i.test(SRC));
check('F3 no "wet -> drain" hard-code', !/wet[^\n]{0,25}->[^\n]{0,10}drain/i.test(SRC));
check('F4 no WM/WD journey IDs in source', !/\bWM-0\d\d\b|\bWD-0\d\d\b/.test(SRC));
check('F5 loadDependent is evidence-driven (STRONG_SUPPORT unbalanced-load / STRONG_AGAINST motor-drum)', (() => {
  const okWM = (sig('washing-machine', 'unbalanced-load', 'loadDependent') || {}).effect === 'STRONG_SUPPORT'
    && (sig('washing-machine', 'motor-drum', 'loadDependent') || {}).effect === 'STRONG_AGAINST';
  const okWD = (sig('washer-dryer', 'unbalanced-load', 'loadDependent') || {}).effect === 'STRONG_SUPPORT'
    && (sig('washer-dryer', 'motor-drum', 'loadDependent') || {}).effect === 'STRONG_AGAINST';
  return okWM && okWD;
})());

// ============================================================================
// G. WASHER-DRYER PARITY — WD nodes now carry the WM drain/spin signals
// ============================================================================
for (const id of ['not-draining', 'drain-pump', 'motor-drum']) {
  const wm = (node('washing-machine', id).signals || []).map((s) => `${s.fact}:${s.effect}`).sort();
  const wd = (node('washer-dryer', id).signals || []).map((s) => `${s.fact}:${s.effect}`).sort();
  // WD must carry at least the WM drain/spin discriminating signals (waterRemaining / drainsNormally).
  check(`G:${id} WD has signals (parity, previously none)`, wd.length > 0);
  check(`G:${id} WD carries the retained-water/drains signal`, wd.some((s) => s.startsWith('waterRemaining:')) || wd.some((s) => s.startsWith('drainsNormally:')));
}

// ============================================================================
// H. LOAD-DEPENDENT CALIBRATION — retained water is NOT load imbalance
// ============================================================================
for (const fam of ['washing-machine', 'washer-dryer']) {
  check(`H:${fam} retained water counts AGAINST unbalanced-load (drain, not balance)`, (sig(fam, 'unbalanced-load', 'waterRemaining') || {}).effect === 'AGAINST');
  check(`H:${fam} retained water routes to not-draining OVER unbalanced-load (even with load hint)`, (() => {
    const f = facts({ waterRemaining: 'TRUE', loadDependent: 'TRUE' });
    return scoreNodeEvidence(node(fam, 'not-draining'), f).score > scoreNodeEvidence(node(fam, 'unbalanced-load'), f).score;
  })());
  check(`H:${fam} drains-fine alone does NOT make unbalanced-load a live commit (no spurious boost)`, scoreNodeEvidence(node(fam, 'unbalanced-load'), facts({ drainsNormally: 'TRUE', waterRemaining: 'FALSE' })).score <= 0);
  check(`H:${fam} load-dependent contradicts motor-drum`, factConflict(node(fam, 'motor-drum'), facts({ loadDependent: 'TRUE' })).contradicted === true);
}

// ---- results ----
console.log(`\nDrain-vs-spin diagnostic depth: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
if (fail) process.exit(1);
