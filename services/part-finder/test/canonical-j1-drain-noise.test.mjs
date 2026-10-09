/**
 * Washing machine not draining with a noise heard while it tries to empty (multi-symptom).
 *   D4 (merge)   a noise on drain means the pump is running: pumpHumming is derived TRUE, never over a stated value.
 *   R7b (policy) the noise points at the pump / filter area: the filter stays the next step, not the downstream hose.
 *   COMPOSE      the filter step names the noise; a reply that echoes prompt scaffolding falls back to the template.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const mc1 = require('../canonical/mc1.js');
const D = require('../canonical/j1-diagnostics.js');
const P = require('../canonical/j1-policy.js');
const J1C = require('../canonical/j1-compose.js');
const F = require('./j1-state-fixture.cjs');
const EC = require('../faults-catalogue.json').errorCodes;

const C = (fields = {}) => mc1.validateClassification({ scope: 'appliance', ...fields });
const decide = (s) => P.policy(s, D.diagnose(s, { codeArea: D.codeAreaFor(s, EC) }), {});
const noisy = () => F.obs(F.obs(F.obs(F.base(), 'commandedDrain', false, 1), 'grindingNoise', true, 1), 'noiseOnDrain', true, 1);

describe('D4: noise on drain -> pump audible', () => {
  it('derives pumpHumming TRUE from a stated noise on drain', () => {
    const s = merge(emptyState('s1'), C({ observations: [{ key: 'noiseOnDrain', value: true }, { key: 'grindingNoise', value: true }] })).state;
    expect(s.evidence.observations.pumpHumming).toMatchObject({ value: true, basis: 'derived', derivedBy: 'D4' });
  });
  it('never overwrites a stated silent pump', () => {
    const s0 = merge(emptyState('s1'), C({ observations: [{ key: 'pumpHumming', value: false }] })).state;
    const s = merge(s0, C({ observations: [{ key: 'noiseOnDrain', value: true }] })).state;
    expect(s.evidence.observations.pumpHumming).toMatchObject({ value: false, basis: 'stated' });
  });
  it('derives nothing without a noise on drain', () => {
    const s = merge(emptyState('s1'), C({ observations: [{ key: 'grindingNoise', value: true }] })).state;
    expect(s.evidence.observations.pumpHumming).toBeUndefined();
  });
});

describe('R7b: the filter stays the next step', () => {
  it('opener -> filter (R7)', () => {
    expect(decide(noisy())).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7' });
  });
  it('filter request superseded by new facts -> filter re-offered, not the pump-sound question or the hose', () => {
    const s = F.request(noisy(), 'drain-filter', 'ask', 'superseded');
    expect(decide(s)).toMatchObject({ kind: 'ask_check', target: 'drain-filter', rule: 'R7b', reason: 'drain-noise-points-to-pump-area' });
  });
  it('offered three times -> moves on', () => {
    let s = noisy();
    for (let i = 0; i < 3; i += 1) s = F.request(s, 'drain-filter', i ? 'reoffer' : 'ask', 'superseded', i + 1);
    expect(decide(s)).not.toMatchObject({ target: 'drain-filter' });
  });
  it('declined -> not offered again', () => {
    const s = F.declined(F.request(noisy(), 'drain-filter', 'ask', 'declined'), 'drain-filter');
    expect(decide(s)).not.toMatchObject({ target: 'drain-filter' });
  });
  it('no noise on drain -> unchanged (superseded filter is not re-offered)', () => {
    const s = F.request(F.obs(F.base(), 'commandedDrain', false, 1), 'drain-filter', 'ask', 'superseded');
    expect(decide(s)).not.toMatchObject({ rule: 'R7b' });
  });
});

describe('COMPOSE: the filter step reconciles both symptoms', () => {
  it('names the noise and links it to the pump / filter area', () => {
    const s = noisy();
    const b = J1C.brief(s, decide(s), null, {});
    expect(b.task.say).toMatch(/noise like that while it tries to empty/);
    expect(b.task.say).toMatch(/pump filter/);
    expect(b.evidence).toEqual(expect.arrayContaining(['a grinding noise', 'the noise happens when it tries to empty']));
  });
  it('a derived observation is never listed as something the customer reported', () => {
    const s = merge(emptyState('s1'), C({ observations: [{ key: 'noiseOnDrain', value: true }, { key: 'grindingNoise', value: true }] })).state;
    s.identity.appliance = F.base().identity.appliance; s.identity.applianceEstablishment = 'established';
    const b = J1C.brief(s, { kind: 'ask_check', target: 'drain-filter', rule: 'R7', requires: [] }, null, {});
    expect(b.evidence).not.toContain('the pump hums when draining');
    expect(b.evidence).toContain('a grinding noise');
  });
  it('without the noise keeps the standard filter copy', () => {
    const s = F.base();
    expect(J1C.brief(s, decide(s), null, {}).task.say).toMatch(/^The most common cause is a blockage in the pump filter/);
  });
  it('a reply that echoes the media instruction falls back to the template', () => {
    const s = noisy(); const a = decide(s);
    const b = J1C.brief(s, a, null, { media: [{ type: 'DIAGRAM', title: 'x' }, { type: 'VIDEO', title: 'y' }] });
    const leaked = `${J1C.template(b)} A picture and video is shown below the reply; you may mention it once.`;
    const r = J1C.checkReply(leaked, a, b);
    expect(r.violations).toContain('prompt-echo');
    expect(r.reply).not.toMatch(/you may mention it once/);
  });
  it('the prompt marks the media line as an instruction', () => {
    const s = noisy();
    const b = J1C.brief(s, decide(s), null, { media: [{ type: 'VIDEO', title: 'y' }] });
    const user = J1C.prompt(b)[1].content;
    expect(user).toMatch(/MEDIA \(instruction, not content\)/);
  });
});
