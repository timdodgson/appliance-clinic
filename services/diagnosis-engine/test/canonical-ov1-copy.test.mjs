/**
 * Oven not heating (ov1) customer copy: each check asks ONE plain question, and a fan-oven-element conclusion with no
 * matched part says why the evidence points there (the grill has its own element, so it working does not clear it).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const OV1 = require('../canonical/ov1-not-heating.js');
const { emptyState, newFact } = require('../canonical/cs1.js');

function state(obs) {
  const s = emptyState('ov1');
  s.version = 3;
  s.identity.appliance = newFact('oven-cooker', 'stated', 1);
  s.identity.applianceEstablishment = 'established';
  s.identity.model = { ...newFact('ZOB35301XK', 'stated', 1), confirmed: true };
  for (const [k, v] of Object.entries(obs)) s.evidence.observations[k] = newFact(v, 'stated', 1);
  return s;
}
const conclude = { kind: 'conclude', rule: 'OH22', target: 'fan-oven-element', requires: [],
  conclusion: { cause: 'fan-oven-element', level: 'component', component: 'fan-oven-element', confidence: 'likely', handoff: 'engineer', alternatives: [] } };

describe('ov1 copy', () => {
  it('check questions are one plain question each', () => {
    for (const k of ['ask_check:oven-clock-mode', 'ask_check:programme-setting']) {
      const q = OV1.TASK[k].ask;
      expect((q.match(/\?/g) || []).length).toBe(1);
      expect(q).not.toMatch(/\(and have you/);
    }
  });
  it('the setting check says why it matters (defrost runs the fan with no heat)', () => {
    expect(OV1.TASK['ask_check:programme-setting'].say).toMatch(/defrost setting runs the fan with no heat/);
  });
  it('fan turning + grill heating, no matched part -> explains the grill does not clear the fan element', () => {
    const b = OV1.brief(state({ ovenFanTurns: true, grillWorks: true, mainOvenWorks: false }), conclude, null, {});
    expect(b.conclusion).toMatch(/grill has its own element/);
    expect(b.conclusion).toMatch(/most likely cause — it would need testing to be certain/);
    expect(b.conclusion).toMatch(/appliance engineer/);
  });
  it('without that evidence -> the generic component wording', () => {
    const b = OV1.brief(state({ ovenFanTurns: true }), conclude, null, {});
    expect(b.conclusion).toMatch(/^From what you've described, the fan-oven \(circular\) element is the most likely cause/);
  });
});
