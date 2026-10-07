/**
 * COMPLETED-CHECK TYPING CONTRACT (deterministic / schema + adapter).
 *
 * Invariant: a customer turn that is a refusal / cannot-answer / not-done must NEVER be represented
 * as a completed check. Completed-check facts (filterChecked/hoseChecked/impellerClear/airflowChecked)
 * are produced ONLY from their own typed noul answering TRUE — the adapter never infers one completed
 * check from another, and never from the refusal/cannot-answer typing. These tests pin:
 *   1. the adapter mapping (mock Jev answers -> facts), including the mixed completed+refused turn;
 *   2. the question CRITERIA that keep Jev from typing a refusal/not-done as a completion
 *      (guards against the criteria being loosened again, and keeps the pump/impeller distinct
 *      from the front filter — the concrete over-fire this fix removed).
 *
 * Natural-language correctness is proven separately against live Jev (refusal-completed-check.eval.mjs)
 * and GOLD. No customer-text regex is asserted into product logic.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const { CUSTOMER_EVIDENCE_SPEC, adaptCustomerEvidence } = require('../jev-understand.js');

const NOUL_TRUE = { type: 'noul', noul: 0.95 };
const NOUL_FALSE = { type: 'noul', noul: 0.02 };
const CHECK_FACTS = ['filterChecked', 'hoseChecked', 'impellerClear', 'airflowChecked'];

function completedFacts(answers) {
  const ev = adaptCustomerEvidence(answers);
  return ev.facts.filter((f) => CHECK_FACTS.includes(f.name) && f.value === 'TRUE').map((f) => f.name);
}
// A refusal / cannot-answer / not-done turn: Jev answers every completed-check noul FALSE.
const notPerformed = () => ({
  evFilterChecked: NOUL_FALSE, evHoseChecked: NOUL_FALSE, evImpellerClear: NOUL_FALSE, evAirflowChecked: NOUL_FALSE,
});

describe('completed-check adapter mapping', () => {
  it('refusal/cannot-answer/not-done (all check nouls FALSE) -> NO completed-check facts', () => {
    expect(completedFacts(notPerformed())).toEqual([]);
  });

  it('genuine filter completion -> filterChecked only (no cross-inference to the pump/impeller)', () => {
    const facts = completedFacts({ ...notPerformed(), evFilterChecked: NOUL_TRUE });
    expect(facts).toContain('filterChecked');
    expect(facts).not.toContain('impellerClear');
  });

  it('completion + refusal in one turn (filter done TRUE, pump refused FALSE) -> only filterChecked', () => {
    const facts = completedFacts({ ...notPerformed(), evFilterChecked: NOUL_TRUE, evImpellerClear: NOUL_FALSE });
    expect(facts).toEqual(['filterChecked']);
  });

  it('genuine pump/impeller inspection -> impellerClear present', () => {
    const facts = completedFacts({ ...notPerformed(), evFilterChecked: NOUL_TRUE, evImpellerClear: NOUL_TRUE });
    expect(facts).toContain('impellerClear');
  });

  it('a completed-check noul left UNKNOWN (uncertain) never asserts a completed check', () => {
    const facts = completedFacts({ ...notPerformed(), evFilterChecked: { type: 'noul', noul: 0.5 } });
    expect(facts).toEqual([]);
  });
});

describe('completed-check question criteria (anti-regression on the typing fix)', () => {
  const byKey = Object.fromEntries(CUSTOMER_EVIDENCE_SPEC.map((d) => [d.key, d]));
  const checkKeys = ['evFilterChecked', 'evHoseChecked', 'evImpellerClear', 'evAirflowChecked'];

  it('each completed-check question requires a performed-and-reported action, excluding not-performed', () => {
    for (const k of checkKeys) {
      const dim = byKey[k];
      expect(dim).toBeTruthy();
      const text = `${dim.instructions} ${dim.criteria.false}`.toLowerCase();
      // Must spell out that a non-performed turn is FALSE (refused / unable / not yet / unsure).
      expect(/refus|unwilling/.test(text)).toBe(true);
      expect(/not yet|not performed|unable|unsure/.test(text)).toBe(true);
    }
  });

  it('impeller criteria is distinct from the front filter (filter-only is not the pump)', () => {
    const imp = byKey.evImpellerClear;
    const t = `${imp.instructions} ${imp.criteria.true} ${imp.criteria.false}`.toLowerCase();
    expect(t.includes('impeller') || t.includes('pump')).toBe(true);
    expect(t.includes('filter')).toBe(true); // explicitly says filter-only does NOT count
  });
});
