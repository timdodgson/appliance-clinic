'use strict';
/**
 * COMPOSE evidence-fidelity contract (deterministic). Proves the COMPOSE system prompt carries the
 * grounding rules that stop the assistant converting a diagnostic possibility / retrieved knowledge
 * / an internal fault LABEL into a fact the customer supposedly reported. Contract-presence only —
 * behaviour is validated by the LLM-judge GOLD suite + targeted live runs, not here.
 *
 *   node services/part-finder/test/compose-evidence-fidelity.test.js
 */
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const mod = require('../part-finder-lambda.js');
const { buildComposeSystem } = mod._internal;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}

// A WP-32-like intent: Jev handed a terse fault LABEL that re-characterises the customer's symptom,
// family unknown, no grounded fault node. (Synthetic typed intent — no customer prose parsing.)
const intent = {
  applianceType: null,
  _applianceUnconfirmed: true,
  make: null,
  model: null,
  fault: 'trips electrics',
  faultId: null,
  primaryFinding: null,
  reportedSymptoms: [],
  facts: [],
  customerTheories: [],
  _applianceFamilyProvenance: 'none',
  _tokenMeaning: 'none',
};
const system = buildComposeSystem([], null, intent, null, [], null, false, false, null, false, null, null);

// --- the new problem-statement fidelity rule is present ---
check('contract: states the problem as the customer described it',
  /STATE THE PROBLEM AS THE CUSTOMER DESCRIBED IT/.test(system));
check('contract: fault label is an internal routing hypothesis, not the customer\'s words',
  /internal routing hypothesis/i.test(system) && /not the customer's words/i.test(system));
check('contract: defer to the customer\'s own description when the label diverges',
  /defer to the customer's own description/i.test(system));
check('contract: ungrounded cause/mechanism offered as a possibility, not established',
  /offer it as a possibility/i.test(system)
  && /unless it is grounded in a resolved error code, a customer-stated fact, or a committed diagnosis/i.test(system));

// --- pre-existing provenance guardrails still present (regression guard) ---
check('regression: retrieved knowledge never claimed as customer experience',
  /never claim the customer experienced them/i.test(system));
check('regression: hypothesis is never a confirmed fault',
  /HYPOTHESIS = a plausible mechanism or retrieved ranking — never a confirmed fault/i.test(system));
check('regression: safety hazards only stated when in customer evidence',
  /never invent smoke, a burning\/hot-plastic smell/i.test(system));

// --- the terse fault label is NOT injected as a "customer reported" statement ---
check('contract: prompt does not assert the customer reported the fault label verbatim',
  !/customer (?:reported|said|told us)[^.\n]*trips electrics/i.test(system));

console.log(`\ncompose-evidence-fidelity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
