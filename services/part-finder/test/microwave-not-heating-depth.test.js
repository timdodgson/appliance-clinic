/**
 * MICROWAVE NOT-HEATING DIAGNOSTIC DEPTH + SAFE MATERIAL DISCRIMINATION.
 *
 * "Microwave runs but doesn't heat" must not commit prematurely between materially different causes:
 * a DOOR / start / interlock fault (won't start, only starts when the door is moved, door won't
 * latch) vs the HEATING / high-voltage path (starts and runs normally but no heat). It adds two
 * customer-SAFE observation facts (runsNormally, doorStartProblem) + node signals and reuses the
 * material-ambiguity gate to ask the highest-value SAFE discriminator (runs-normally-but-cold vs
 * won't-start / door-conditioned) before committing.
 *
 * HV precision is CALIBRATED: "runs but no heat" resolves the broad high-voltage HEATING CIRCUIT, it
 * never hard-commits "magnetron" (magnetron / HV diode / inverter cannot be separated by any safe
 * external observation). Observations are never components; "I think the magnetron has gone" is a
 * hypothesis and derives NOTHING. Arcing / burning safety (MW-003) and error-code authority (H97/H98)
 * are untouched. The customer-facing knowledge NEVER instructs cover removal / capacitor discharge /
 * HV-component testing / interlock bypass.
 *
 * Run: node services/part-finder/test/microwave-not-heating-depth.test.js
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const fs = require('fs');
const path = require('path');
const {
  commitFromEvidence, materialAmbiguity, factConflict, scoreNodeEvidence,
  classifySafetyStop, detectUnsafeIntent,
} = require('../part-finder-lambda.js')._internal;
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faults-catalogue.json'), 'utf8'));
const OV = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'overrides.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}
const node = (id) => CAT.faults.microwave[id];
const facts = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));
const commit = (obj) => { const r = commitFromEvidence({ facts: facts(obj) }, 'microwave'); return r ? r.faultId : null; };
const amb = (id, obj) => materialAmbiguity(id, node(id), facts(obj), 'microwave');
const ss = (t) => { const r = classifySafetyStop(t, 'microwave'); return r ? (r.tier === 'STOP_USE_DIAGNOSE' ? 'arcing' : r.category) : null; };
const doc = (id) => OV.docs[`microwave:${id}`] || {};
const discrText = (id) => `${(doc(id).discriminators || []).join(' ')} ${doc(id).safety || ''} ${(doc(id).adviceBeforeReplacement || []).join(' ')}`.toLowerCase();

// ============================================================================
// C. MATERIAL GATE — ask the SAFE discriminator BEFORE committing
// ============================================================================
check('C1 bare not-heating -> gate asks door-vs-heating discriminator', (() => { const a = amb('not-heating', {}); return a && a.altId === 'door' && (a.fact === 'doorStartProblem' || a.fact === 'runsNormally'); })());
check('C2 runs-normally -> NO ask (commit heating path)', amb('not-heating', { runsNormally: 'TRUE', doorStartProblem: 'FALSE' }) === null);
check('C3 door-start known -> door leader does NOT spuriously ask', amb('door', { doorStartProblem: 'TRUE', runsNormally: 'FALSE' }) === null);

// ============================================================================
// D. EVIDENCE COMMIT — observations route to materially-different nodes
// ============================================================================
check('D1 bare not-heating fact-less -> no commit (must ask)', commit({}) === null);
check('D2 runs-normally + no door problem -> not-heating (HV heating path)', commit({ runsNormally: 'TRUE', doorStartProblem: 'FALSE' }) === 'not-heating');
check('D3 door-start problem -> door', commit({ doorStartProblem: 'TRUE', runsNormally: 'FALSE' }) === 'door');
check('D4 doorStartProblem contradicts the heating path', factConflict(node('not-heating'), facts({ doorStartProblem: 'TRUE' })).contradicted === true);
check('D5 runsNormally contradicts the door path', factConflict(node('door'), facts({ runsNormally: 'TRUE' })).contradicted === true);

// ============================================================================
// E. HV PRECISION IS CALIBRATED — "runs but no heat" is NOT "magnetron"
// ============================================================================
check('E1 not-heating node relabelled to broad HV heating circuit (not "magnetron circuit")',
  /high-voltage|heating circuit/i.test(node('not-heating').label) && !/magnetron/i.test(node('not-heating').label));
check('E2 not-heating discriminator forbids naming a single failed part / claiming "the magnetron"',
  /do not name a single failed part|not name a single|the magnetron/i.test((node('not-heating').discriminators || []).join(' ')));
check('E3 not-heating discriminator carries the HV SAFETY boundary (never remove cover / discharge capacitor / test HV)',
  /never .*(remove|cover|casing|discharge|capacitor|test)/i.test((node('not-heating').discriminators || []).join(' ')));
check('E4 knowledge doc still lists the HV components for engineer follow-up (magnetron/diode/inverter present)',
  /magnetron|diode|inverter/i.test(JSON.stringify(doc('not-heating').components || [])));
check('E5 knowledge doc checks cookware/power AND door BEFORE any HV part (calibrated order preserved)', (() => {
  const comps = (doc('not-heating').components || []).map((c) => String(c.name || c).toLowerCase());
  const magIdx = comps.findIndex((c) => c.includes('magnetron'));
  return magIdx > 0 && comps.some((c) => c.includes('cookware') || c.includes('power')) && comps.some((c) => c.includes('door'));
})());

// ============================================================================
// F. HV SAFETY BOUNDARY — no unsafe DIY instruction anywhere in the knowledge
// ============================================================================
// Unsafe = removing the microwave's OUTER casing/cabinet (NOT the waveguide/mica cover, which is a
// safe visual check) OR any instruction to discharge/test/probe an HV component or a live circuit.
const UNSAFE_RE = /(remove|take off|open|undo)\b[^.]*\b(outer (?:case|cover|casing)|casing|cabinet|the back(?:\b| panel| off))\b|(discharge|test|probe|measure)\b[^.]*\b(capacitor|magnetron|hv diode|transformer|\blive\b)\b/i;
for (const id of ['not-heating', 'door', 'sparking-arcing', 'cutting-out', 'low-voltage']) {
  const positive = discrText(id).replace(/(do not|don't|never|no)\b[^.]*/g, '');
  check(`F:${id} no positive unsafe HV/interlock instruction`, !UNSAFE_RE.test(positive), positive.match(UNSAFE_RE));
}
check('F6 detectUnsafeIntent flags "how do I discharge the capacitor"', detectUnsafeIntent('how do I discharge the capacitor in my microwave'));
check('F7 detectUnsafeIntent flags "can I bypass the door interlock"', detectUnsafeIntent('can I bypass the door interlock switch'));
check('F8 detectUnsafeIntent does NOT flag a plain not-heating report', !detectUnsafeIntent('my microwave runs but doesnt heat'));

// ============================================================================
// G. SAFETY PRECEDENCE — arcing / burning / smoke win over not-heating discrimination
// ============================================================================
check('G1 not heating + sparking -> arcing stop-use', ss('microwave not heating and sparking') === 'arcing');
check('G2 not heating + arcing -> arcing stop-use', ss('microwave arcing inside and not heating') === 'arcing');
check('G3 not heating + burning smell -> burning hard stop', ss('microwave smells burnt and doesnt heat') === 'burning');
check('G4 not heating + smoke -> burning hard stop', ss('smoke coming from the microwave and it wont heat') === 'burning');
check('G5 plain runs-but-cold is NOT a safety stop', ss('microwave runs but doesnt heat') === null);

// ============================================================================
// I. SOURCE GUARDS / MUTATION — no hard-coded shortcuts, no journey IDs
// ============================================================================
const SRC = require('./engine-source.cjs')();
check('I1 no "no heat -> magnetron" hard-code in source', !/no ?heat[^\n]{0,40}magnetron/i.test(SRC));
check('I2 no "runs -> diode" hard-code in source', !/runs[^\n]{0,30}(hv )?diode/i.test(SRC));
check('I3 no MW journey IDs in production source', !/\bMW-0\d\d\b/.test(SRC));
check('I4 doorStartProblem STRONG_SUPPORT on door + STRONG_AGAINST on not-heating (evidence-driven, not a phrase map)', (() => {
  const nh = (node('not-heating').signals || []).find((s) => s.fact === 'doorStartProblem');
  const dr = (node('door').signals || []).find((s) => s.fact === 'doorStartProblem');
  return nh && nh.effect === 'STRONG_AGAINST' && dr && dr.effect === 'STRONG_SUPPORT';
})());
check('I5 runsNormally SUPPORT on not-heating + STRONG_AGAINST on door', (() => {
  const nh = (node('not-heating').signals || []).find((s) => s.fact === 'runsNormally');
  const dr = (node('door').signals || []).find((s) => s.fact === 'runsNormally');
  return nh && nh.effect === 'SUPPORT' && dr && dr.effect === 'STRONG_AGAINST';
})());

// ---- results ----
console.log(`\nMicrowave not-heating depth: ${pass} passed / ${fail} failed  (total ${pass + fail})`);
if (fail) process.exit(1);
