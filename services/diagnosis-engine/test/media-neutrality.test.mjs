/**
 * Media neutrality on the canonical path (offline, deterministic): the journey decides; media only illustrates the
 * decided NextAction. Changing the media catalogue (removing every item for the journey's node, or replacing it with
 * different items through the admin overlay) leaves the journey result bit-for-bit identical — NextAction, issued
 * request, state and parts — and changes only the media a reply carries.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../handler.js')._internal;
const media = require('../media.js');
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const mc1 = require('../canonical/mc1.js');

const CSID = 'cs_' + 'n'.repeat(32);
const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const CONTROL = { schema: 'cs/1', mode: 'control', control: { journeys: ['wm-not-draining'] }, sessionId: CSID, version: 0, state: null, degraded: null };
const opener = C({ identity: { appliance: { value: 'washing-machine', basis: 'stated' } }, problem: { journey: 'not-draining', faultDomain: 'water' },
  observations: [{ key: 'waterRemaining', value: true }] });
function transport() {
  const s = merge(emptyState(CSID), opener, { turn: 1 }).state;
  return { schema: 'cs/1', mode: 'control', sessionId: CSID, priorVersion: 0, version: s.version, state: s, classification: opener, rulesFired: [], requestOutcome: null, degraded: null };
}
const provider = { infer: async (_r, { onDelta }) => onDelta('Switch the machine off and unplug it first. Put towels down. Unscrew the filter slowly. What did you find in the filter?') };

async function turn(overlay) {
  media.resetMediaOverlayCache();
  media.setMediaOverlayLoader(async () => overlay);
  await media.ensureMediaOverlay({ now: Date.now(), ttlMs: 0 });
  const t = await L.canonicalJourney(transport(), CONTROL, 'wm-not-draining');
  const r = await L.canonicalRespond({ canonical: t, messages: [{ role: 'user', content: 'x' }], requestId: 'n1' }, { provider, ensureMedia: false });
  return { decision: JSON.stringify({ journey: t.journey.nextAction, issued: t.issuedRequest, state: t.state, parts: r.done.parts }), media: r.done.media.map((m) => m.id) };
}

const empty = () => ({ identities: {}, byKnowledgeId: {}, byComponent: {}, detachedByKnowledgeId: {}, detachedByComponent: {} });
afterEach(() => { media.setMediaOverlayLoader(null); media.resetMediaOverlayCache(); });

describe('media never changes the canonical decision', () => {
  it('with the shipped media, the reply carries the drain-filter media', async () => {
    const base = await turn(null);
    expect(base.media.length).toBeGreaterThan(0);
  });
  it('removing the node media through the overlay changes only the media', async () => {
    const base = await turn(null);
    const ov = empty();
    ov.byKnowledgeId['washing-machine:not-draining'] = null;
    const changed = await turn(ov);
    expect(changed.decision).toBe(base.decision);
    expect(changed.media).toEqual([]);
  });
  it('adding unrelated media through the overlay changes nothing', async () => {
    const base = await turn(null);
    const ov = empty();
    ov.byKnowledgeId['washing-machine:not-draining'] = [{ id: 'zzz-other', type: 'IMAGE', title: 'x', description: 'x', applicability: 'GENERIC', asset: '/media/x.png', alt: 'x' }];
    const changed = await turn(ov);
    expect(changed).toEqual(base);
  });
});
