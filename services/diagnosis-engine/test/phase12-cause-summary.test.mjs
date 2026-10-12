/**
 * Phase 12: the engine owns the customer-facing label of a canonical cause. Every cause a journey can conclude has a
 * summary in canonical/cause-summary.js; the journey summary's NextAction carries it as `conclusion.summary`; a cause
 * without one gets null, never its raw key. Covers the four causes the orchestrator's old table had drifted from.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const H = require('./helpers/b2-journey.cjs');
const L = require('../handler.js')._internal;
const { CAUSE_SUMMARY, causeSummary, journeyWithCauseSummary } = require('../canonical/cause-summary.js');
const { C, O, K } = H;
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = L.CANONICAL_JOURNEY_PACKS;
const mod = (p) => require(p.replace('./canonical/', '../canonical/'));
const open = (a, j, obs = []) => H.opener(j, null, obs, {}, { appliance: { value: a, basis: 'stated' } });
const ck = (c, r = 'clear') => C({ checks: [K(c, 'done', r)] });
const ob = (...o) => C({ observations: o });
const ALL = Object.keys(PACKS);

/** Every cause any journey can conclude: each pack's cause families, plus the causes policy code names literally. */
function concludableCauses() {
  const out = new Set();
  for (const p of Object.values(PACKS)) {
    for (const k of Object.keys(mod(p.compose).FAMILY_LABEL || {})) out.add(k);
    const J = mod(p.pipeline);
    for (const k of Object.values(J.FAMILY || {})) if (typeof k === 'string') out.add(k);
  }
  const dir = join(HERE, '..', 'canonical');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/cause: *'([a-z0-9-]+)'/g)) out.add(m[1]);
  }
  return out;
}

describe('the engine cause vocabulary', () => {
  it('every concludable cause has a customer-facing summary', () => {
    const missing = [...concludableCauses()].filter((c) => !causeSummary(c));
    expect(missing).toEqual([]);
  });
  it('a summary is short label text, never a key', () => {
    for (const [k, v] of Object.entries(CAUSE_SUMMARY)) {
      expect(v, k).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
      expect(v.length, k).toBeLessThanOrEqual(60);
      expect(v[0], k).toBe(v[0].toUpperCase());
    }
  });
  it('an unknown or missing cause gets null, never its raw key', () => {
    expect(causeSummary('some-internal-key')).toBe(null);
    expect(causeSummary(null)).toBe(null);
    expect(causeSummary('constructor')).toBe(null);
    const j = journeyWithCauseSummary({ key: 'x', nextAction: { kind: 'conclude', conclusion: { cause: 'not-a-cause' } } });
    expect(j.nextAction.conclusion.summary).toBe(null);
  });
  it('a NextAction without a conclusion is untouched', () => {
    const j = { key: 'x', nextAction: { kind: 'ask_check', target: 'drain-filter' } };
    expect(journeyWithCauseSummary(j)).toBe(j);
  });
});

describe('the journey summary carries the label (the four causes the orchestrator table had lost)', () => {
  const concluded = async (turns) => (await H.routeWith(L, turns, ALL)).journey.nextAction;
  const WD = (obs) => open('washer-dryer', 'leaking', [O('wdDrySide'), ...obs]);
  it('washer-dryer drying / water-container-full', async () => {
    const a = await concluded([WD([]), ob(O('tankWarning'))]);
    expect(a.conclusion).toMatchObject({ cause: 'water-container-full', summary: 'Full water container' });
  });
  it('washer-dryer drying / condenser-water-path', async () => {
    const a = await concluded([WD([]), ck('drain-filter'), ck('drain-hose')]);
    expect(a.conclusion).toMatchObject({ cause: 'condenser-water-path', summary: 'Condenser water path' });
  });
  it('washer-dryer drying, drain-related / drain-hose-or-standpipe', async () => {
    const a = await concluded([WD([]), ck('drain-filter'), ck('drain-hose', 'found_and_cleared'), ob(O('faultPersists', false))]);
    expect(a.conclusion).toMatchObject({ cause: 'drain-hose-or-standpipe', summary: 'Drain hose or standpipe' });
  });
  it('microwave noise / normal-operating-hum', async () => {
    const a = await concluded([open('microwave', 'noisy', [O('humNoise'), O('heatPresent')])]);
    expect(a.conclusion).toMatchObject({ cause: 'normal-operating-hum', summary: 'Normal running hum' });
  });
  // Replayed turn by turn (the questions these answer must have been issued), then labelled as the runtime does.
  const playedLabel = (key, turns) => journeyWithCauseSummary({ key, nextAction: H.play(mod(PACKS[key].pipeline), turns).last }).nextAction;
  it('a generic conclusion (likely-causes) is labelled too', () => {
    const a = playedLabel('dw-leaking', [H.dwOpener('leaking', 'water', []), C({ reply: { toPending: 'cannot_answer' } }), C({ reply: { toPending: 'cannot_answer' } })]);
    expect(a.conclusion).toMatchObject({ cause: 'likely-causes', summary: 'Likely causes (not narrowed down)' });
  });
  it('an existing label is unchanged (dishwasher not cleaning / dirty filter)', () => {
    const a = playedLabel('dw-not-cleaning', [H.dwOpener('poor-results', 'results', [O('poorAllRacks')]), ck('dishwasher-filter', 'found_and_cleared'), ob(O('faultPersists', false))]);
    expect(a.conclusion).toMatchObject({ cause: 'dirty-filter', summary: 'Dirty filter' });
  });
});
