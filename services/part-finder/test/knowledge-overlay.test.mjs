/**
 * Published Admin knowledge overlay (knowledge-admin/published.json) merged over the shipped index.
 * Drafts never reach this file; these tests cover what part-finder does with what was published.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const r = require('../retrieval.js');
const shipped = require('../knowledge/knowledge-index.json');

const vec = () => new Array(shipped.dims).fill(0.01);
const base = shipped.docs.find((d) => d.knowledgeId === 'washing-machine:not-draining');
const edited = Object.assign({}, base, { label: 'Edited label', vector: vec(), publishedVersion: 3,
  safetyInformation: { text: 'Unplug first', hazard: 'Water + electricity', classification: 'STOP_USE', applicability: 'Always', provenance: [{ sourceType: 'x', publisher: 'y', url: 'https://example.org' }] } });
const added = { knowledgeId: 'dishwasher:new-topic', applianceFamily: 'dishwasher', faultId: 'new-topic', label: 'New topic',
  outcome: 'ADVICE_ONLY', likelyComponents: [], symptoms: ['odd chirp'], discriminators: [], text: 'Appliance: dishwasher\nFault: New topic', vector: vec() };

beforeEach(() => {
  r.setKnowledgeOverlayLoader(async () => null);
  r.resetKnowledgeOverlayCache();
});

describe('knowledge overlay merge', () => {
  it('no overlay → shipped baseline exactly (171 records, state none)', async () => {
    await r.ensureKnowledgeOverlay({ ttlMs: 0 });
    expect(r.describeLoadedIndex().records).toBe(171);
    expect(r.getKnowledgeOverlayCache().state).toBe('none');
    expect(r.getKnowledgeRecord('washing-machine', 'not-draining').label).toBe(base.label);
  });
  it('replaces by knowledgeId, adds new records, removes archived ones, and swaps safety by identity', async () => {
    r.setKnowledgeOverlayLoader(async () => ({ version: 4, docs: { [edited.knowledgeId]: edited, [added.knowledgeId]: added }, archived: ['vacuum:cuts-out'] }));
    await r.ensureKnowledgeOverlay({ ttlMs: 0 });
    expect(r.getKnowledgeOverlayCache()).toMatchObject({ state: 'active', version: 4, docs: 2, archived: 1 });
    expect(r.describeLoadedIndex().records).toBe(171); // +1 added, -1 archived
    expect(r.describeLoadedIndex().mismatch).toBe(false);
    expect(r.getKnowledgeRecord('washing-machine', 'not-draining').label).toBe('Edited label');
    expect(r.getKnowledgeRecord('dishwasher', 'new-topic').label).toBe('New topic');
    expect(r.getKnowledgeRecord('vacuum', 'cuts-out')).toBeNull();
    expect(r.getSafetyInformation('washing-machine', 'not-draining').text).toBe('Unplug first');
    const res = await r.retrieve({ applianceFamily: 'vacuum' }, 'cuts out pulsing', 500);
    expect(res.docs.map((d) => d.knowledgeId)).not.toContain('vacuum:cuts-out');
  });
  it('a published doc without safetyInformation removes the baseline safety for that node only', async () => {
    const tripping = shipped.docs.find((d) => d.knowledgeId === 'washing-machine:tripping-electrics');
    expect(r.getSafetyInformation('washing-machine', 'tripping-electrics')).toBeTruthy();
    r.setKnowledgeOverlayLoader(async () => ({ version: 1, docs: { [tripping.knowledgeId]: Object.assign({}, tripping, { vector: vec() }) }, archived: [] }));
    await r.ensureKnowledgeOverlay({ ttlMs: 0 });
    expect(r.getSafetyInformation('washing-machine', 'tripping-electrics')).toBeNull();
  });
  it('retrieval pool docs never carry admin content / customer safety', async () => {
    r.setKnowledgeOverlayLoader(async () => ({ version: 2, docs: { [edited.knowledgeId]: Object.assign({}, edited, { content: { secret: 1 } }) }, archived: [] }));
    await r.ensureKnowledgeOverlay({ ttlMs: 0 });
    const res = await r.retrieve({ applianceFamily: 'washing-machine' }, 'not draining', 500);
    expect(JSON.stringify(res)).not.toMatch(/Unplug first|secret/);
  });
  it('malformed overlay (wrong dims) is rejected whole and the last good state stays', async () => {
    r.setKnowledgeOverlayLoader(async () => ({ version: 5, docs: { [edited.knowledgeId]: edited }, archived: [] }));
    await r.ensureKnowledgeOverlay({ ttlMs: 0 });
    r.setKnowledgeOverlayLoader(async () => ({ version: 6, docs: { [added.knowledgeId]: Object.assign({}, added, { vector: [1, 2] }) }, archived: [] }));
    await r.ensureKnowledgeOverlay({ ttlMs: 0 });
    expect(r.getKnowledgeOverlayCache().state).toBe('unavailable');
    expect(r.getKnowledgeRecord('washing-machine', 'not-draining').label).toBe('Edited label');
    expect(r.getKnowledgeRecord('dishwasher', 'new-topic')).toBeNull();
  });
  it('S3 NoSuchKey → baseline; TTL caches between loads', async () => {
    let calls = 0;
    r.setKnowledgeOverlayLoader(async () => { calls++; const e = new Error('The specified key does not exist.'); e.name = 'NoSuchKey'; throw e; });
    await r.ensureKnowledgeOverlay({ now: 1000 });
    await r.ensureKnowledgeOverlay({ now: 2000 });
    expect(calls).toBe(1);
    expect(r.getKnowledgeOverlayCache().state).toBe('none');
    await r.ensureKnowledgeOverlay({ now: 1000 + r.KNOWLEDGE_OVERLAY_TTL_MS + 1 });
    expect(calls).toBe(2);
  });
});
