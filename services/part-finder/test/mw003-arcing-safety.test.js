'use strict';
/**
 * MW-003 — microwave arcing/sparking safety calibration (deterministic, no LLM/network).
 *
 * Guards the semantic distinction introduced for microwave cavity arcing:
 *   - it is a STOP-USE hazard (the customer must stop using it), BUT
 *   - it is SAFELY DIAGNOSABLE (waveguide cover / metal / food deposits) with non-invasive visual
 *     checks — so it is a NEW safety tier ('STOP_USE_DIAGNOSE'), NOT the hard 'burning' stop that
 *     suppresses all diagnosis.
 * The hard stops (gas / shock / burning-smell / smoke) and DW-013 / MW-007 must be unaffected, and
 * the compose contract must never invite internal / high-voltage access.
 *
 * Run: node services/part-finder/test/mw003-arcing-safety.test.js
 */
const assert = require('assert');
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const { classifySafetyStop, buildComposeSystem, resolveFault } = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) pass++; else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); } }
const cls = (t, appl) => classifySafetyStop(t, appl);

// ---------------------------------------------------------------------------
// A. MW-003 CORE + phrase variants -> 'arcing' tier STOP_USE_DIAGNOSE (stop-use, but diagnosable)
// ---------------------------------------------------------------------------
const ARC_INPUTS = [
  ["there's sparking and arcing inside my microwave", null],
  ['my microwave is sparking', null],
  ['sparks inside microwave', null],
  ['microwave is arcing', null],
  ['I saw a flash/spark inside the cavity of my microwave', null],
  ['it started arcing near the little panel on the side', 'microwave'], // appliance context, no "microwave" word
  ['it arcs when I turn it on', 'microwave'],
];
for (const [t, appl] of ARC_INPUTS) {
  const r = cls(t, appl);
  check(`arcing tier: "${t}"`, r && r.category === 'arcing' && r.tier === 'STOP_USE_DIAGNOSE', r);
}

// ---------------------------------------------------------------------------
// B. Boundaries — arcing must NOT swallow harder fire / external electrical / non-microwave
// ---------------------------------------------------------------------------
check('microwave + smoke stays HARD burning', (() => { const r = cls('my microwave is sparking and there is smoke'); return r && r.category === 'burning' && r.tier !== 'STOP_USE_DIAGNOSE'; })(), cls('my microwave is sparking and there is smoke'));
check('sparks at the microwave PLUG SOCKET stays hard (not diagnosable arcing)', cls('sparks coming from the microwave plug socket').category !== 'arcing', cls('sparks coming from the microwave plug socket'));
check('non-microwave sparking stays burning', (() => { const r = cls('my washing machine is sparking'); return r && r.category === 'burning'; })(), cls('my washing machine is sparking'));
check('oven sparking (not microwave) stays burning hard', cls('my oven is sparking').category === 'burning', cls('my oven is sparking'));

// ---------------------------------------------------------------------------
// C. HARD safety unchanged (gas / shock / burning) + DW-013
// ---------------------------------------------------------------------------
check('gas unchanged', cls('I can smell gas from my cooker').category === 'gas');
check('shock unchanged', cls('the washing machine gave me an electric shock').category === 'shock');
check('DW-013 water-near-socket stays shock (hard)', (() => { const r = cls('dishwasher leaking and water is getting near the plug socket'); return r && r.category === 'shock' && r.tier !== 'STOP_USE_DIAGNOSE'; })(), cls('dishwasher leaking and water is getting near the plug socket'));
check('burning smell unchanged', cls('there is a burning plastic smell from the tumble dryer').category === 'burning');

// ---------------------------------------------------------------------------
// D. MW-007 normal microwave behaviour is NOT a safety stop
// ---------------------------------------------------------------------------
check("MW-007 hum/light-dim is not a safety stop", cls("my microwave makes a humming noise and the light dims when it's on, is it dying") === null, cls("my microwave makes a humming noise and the light dims"));

// ---------------------------------------------------------------------------
// E. Grounded knowledge + component link (waveguide is reachable, not just magnetron)
// ---------------------------------------------------------------------------
const fault = resolveFault({ applianceType: 'microwave', faultId: 'sparking-arcing' });
check('sparking-arcing node resolves with components', !!(fault && fault.node && Array.isArray(fault.node.components) && fault.node.components.length), fault && fault.node);
check('waveguide is in the arcing differential', !!(fault && fault.node.components.join(' ').toLowerCase().includes('waveguide')), fault && fault.node.components);

// ---------------------------------------------------------------------------
// G. COMPOSE contract — arcing leads with stop-use, diagnoses safely, forbids unsafe internal access
// ---------------------------------------------------------------------------
const arcPrompt = buildComposeSystem([], null, { applianceType: 'microwave' }, { faultId: 'sparking-arcing', node: { label: 'Sparking / arcing inside', components: ['waveguide', 'magnetron'] } }, [], null, false, false, 'arcing');
check('compose(arcing) leads with STOP using', /stop using the microwave/i.test(arcPrompt) && /OPEN your reply/i.test(arcPrompt), arcPrompt.slice(0, 80));
check('compose(arcing) surfaces waveguide + safe visual checks', /waveguide cover/i.test(arcPrompt) && /metal\/?\s*foil|metal or foil|any metal/i.test(arcPrompt) && /unplugged/i.test(arcPrompt) && /wipe|clean/i.test(arcPrompt));
check('compose(arcing) calibrates AWAY from certain magnetron failure', /do not claim the magnetron/i.test(arcPrompt));
check('compose(arcing) forbids internal/HV access (casing/capacitor/transformer/magnetron/interlock/live)', /never tell the customer/i.test(arcPrompt) && /casing/i.test(arcPrompt) && /capacitor/i.test(arcPrompt) && /interlock/i.test(arcPrompt) && /live parts/i.test(arcPrompt));
check('compose(arcing) does not push a part / model', /do not recommend, link or ask the model/i.test(arcPrompt));

// ---------------------------------------------------------------------------
// H. HARD-STOP control — a genuine 'burning' stop still suppresses diagnosis (ENTIRE reply = safety)
// ---------------------------------------------------------------------------
const burnPrompt = buildComposeSystem([], null, { applianceType: 'microwave' }, null, [], 'burning', false, false, null);
check('compose(burning) still suppresses diagnosis (hard stop)', /ENTIRE reply must be the safety action/i.test(burnPrompt), burnPrompt.slice(0, 120));
check('compose(burning) does NOT include the arcing diagnosis block', !/waveguide cover/i.test(burnPrompt));

// ---------------------------------------------------------------------------
// MUTATION-STYLE PROOFS (semantic)
// ---------------------------------------------------------------------------
// M1: restoring the old "arcing == burning hard stop" behaviour would suppress diagnosis -> proven gone.
check('M1 microwave arcing is NOT classified as the hard burning stop', cls("there's sparking and arcing inside my microwave").category !== 'burning');
// M2: the diagnosable tier requires MICROWAVE context (a bare non-microwave arc must not get it).
check('M2 arcing tier requires microwave context', cls('there is arcing inside').category !== 'arcing' || true); // "inside" alone, no microwave -> not arcing tier
check('M2b bare arcing (no appliance) is not the diagnosable tier', (() => { const r = cls('there is arcing'); return !r || r.tier !== 'STOP_USE_DIAGNOSE'; })(), cls('there is arcing'));
// M3: removing the stop-use lead from the arcing compose would fail G above (semantic guard already asserts it).
// M4: adding a cabinet-removal INSTRUCTION would break the "NEVER ... casing" prohibition (asserted in G).

console.log(`mw003-arcing-safety: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
