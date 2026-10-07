/**
 * Stage A: the mc/1 shadow stage travels only inside the trusted diagnostic trace. The
 * browser-facing view built by the BFF must never carry it.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toWhichPartView } = require('../index.js');

const shadowStage = {
  id: 'canonical-mc1-shadow', label: 'Canonical classification (mc/1 shadow, non-authoritative)',
  evidence: 'DERIVED', summary: 'shadow',
  detail: { schema: 'mc/1', mode: 'shadow', authoritative: false, classification: { scope: 'appliance' } },
};
const stateStage = {
  id: 'canonical-cs1-shadow', label: 'Canonical state (cs/1 shadow, non-authoritative, non-durable)',
  evidence: 'DERIVED', summary: 'shadow',
  detail: { schema: 'cs/1', mode: 'shadow', authoritative: false, durable: false, state: { version: 1 } },
};

describe('browser view excludes the canonical shadow', () => {
  it('toWhichPartView output contains no canonical / mc/1 data even when the trace carries it', () => {
    const orch = {
      outcome: 'ANSWER', route: 'SYMPTOMS', message: 'Check the pump filter.',
      parts: [], media: [],
      _diagnosticTrace: { schemaVersion: '1.0', stages: [shadowStage, stateStage] },
    };
    const view = toWhichPartView(orch, 'rid-1', null);
    const json = JSON.stringify(view);
    expect(json.includes('canonical-mc1-shadow')).toBe(false);
    expect(json.includes('mc/1')).toBe(false);
    expect(json.includes('canonical-cs1-shadow')).toBe(false);
    expect(json.includes('cs/1')).toBe(false);
    expect(Object.keys(view)).not.toContain('_diagnosticTrace');
  });
});
