/**
 * Effective media mapping resolver — shipped baseline + overlay tombstones.
 *   node --test services/part-finder/test/media-effective.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeJoin, mappingIds } = require('../media-effective.js');
const retrieval = require('../retrieval.js');
const mediaInspect = require('../../whichpart-api/media-inspect.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const shipped = JSON.parse(readFileSync(join(HERE, '..', 'knowledge', 'media-information.json'), 'utf8'));

function overlayBase() {
  return {
    identities: {},
    byKnowledgeId: {},
    byComponent: {},
    detachedByKnowledgeId: {},
    detachedByComponent: {},
  };
}

describe('baseline', () => {
  it('empty overlay equals shipped join', () => {
    const a = mergeJoin(shipped, null);
    const b = mergeJoin(shipped, overlayBase());
    assert.deepEqual(mappingIds(a, 'vacuum:cuts-out'), ['vac-lost-suction']);
    assert.deepEqual(mappingIds(b, 'vacuum:cuts-out'), ['vac-lost-suction']);
    assert.deepEqual(mappingIds(a, 'dishwasher:not-draining'), ['dishwasher-filter']);
    assert.equal((a.byComponent['oven-cooker:fan-oven-element'] || []).length, 1);
  });
});

describe('overlay attach', () => {
  it('augments baseline without replacing sibling shipped items', () => {
    const ov = overlayBase();
    ov.byKnowledgeId['dishwasher:not-draining'] = [{
      id: 'admin-temp-media', type: 'IMAGE', title: 'Temp', description: 'Temp',
      applicability: 'GENERIC', asset: '/media/admin-temp-media.png', alt: 'Temp',
      priority: 10000,
    }];
    const eff = mergeJoin(shipped, ov);
    assert.deepEqual(mappingIds(eff, 'dishwasher:not-draining'), ['dishwasher-filter', 'admin-temp-media']);
    assert.deepEqual(mappingIds(eff, 'vacuum:cuts-out'), ['vac-lost-suction']);
  });

  it('dedupes the same id if overlay repeats a shipped mapping', () => {
    const ov = overlayBase();
    ov.byKnowledgeId['dishwasher:not-draining'] = [
      { id: 'dishwasher-filter', type: 'DIAGRAM', title: 'Overlay title', description: 'x', applicability: 'GENERIC', asset: '/media/dishwasher-filter.png', alt: 'a' },
      { id: 'dishwasher-filter', type: 'DIAGRAM', title: 'Dup', description: 'x', applicability: 'GENERIC', asset: '/media/dishwasher-filter.png', alt: 'a' },
    ];
    const ids = mappingIds(mergeJoin(shipped, ov), 'dishwasher:not-draining');
    assert.deepEqual(ids, ['dishwasher-filter']);
  });
});

describe('overlay detach tombstone', () => {
  it('suppresses a shipped mapping and survives a second merge (reload)', () => {
    const ov = overlayBase();
    ov.detachedByKnowledgeId['dishwasher:not-draining'] = { 'dishwasher-filter': true };
    const first = mergeJoin(shipped, ov);
    assert.deepEqual(mappingIds(first, 'dishwasher:not-draining'), []);
    const reloaded = mergeJoin(shipped, JSON.parse(JSON.stringify(ov)));
    assert.deepEqual(mappingIds(reloaded, 'dishwasher:not-draining'), []);
    assert.deepEqual(mappingIds(reloaded, 'dishwasher:poor-clean-results'), ['dishwasher-filter', 'dishwasher-spray-arm']);
  });

  it('does not resurrect a shipped mapping when overlay add list is empty', () => {
    const ov = overlayBase();
    ov.byKnowledgeId['dishwasher:not-draining'] = [];
    ov.detachedByKnowledgeId['dishwasher:not-draining'] = { 'dishwasher-filter': true };
    assert.deepEqual(mappingIds(mergeJoin(shipped, ov), 'dishwasher:not-draining'), []);
  });

  it('re-attach clears the tombstone when overlay item is present and detached flag is off', () => {
    const ov = overlayBase();
    ov.detachedByKnowledgeId['dishwasher:not-draining'] = {};
    ov.byKnowledgeId['dishwasher:not-draining'] = [{
      id: 'admin-temp-media', type: 'IMAGE', title: 'Temp', description: 'Temp',
      applicability: 'GENERIC', asset: '/media/x.png', alt: 't',
    }];
    assert.ok(mappingIds(mergeJoin(shipped, ov), 'dishwasher:not-draining').includes('admin-temp-media'));
    assert.ok(mappingIds(mergeJoin(shipped, ov), 'dishwasher:not-draining').includes('dishwasher-filter'));
  });
});

describe('retire', () => {
  it('strips a retired identity from live join including overlay mappings', () => {
    const ov = overlayBase();
    ov.identities['vac-lost-suction'] = { origin: 'shipped', status: 'retired', catalogue: { id: 'vac-lost-suction' } };
    ov.byKnowledgeId['microwave:not-heating'] = [{
      id: 'vac-lost-suction', type: 'IMAGE', title: 'x', description: 'x', applicability: 'GENERIC', asset: '/media/x.png', alt: 'x',
    }];
    const live = mergeJoin(shipped, ov);
    assert.deepEqual(mappingIds(live, 'vacuum:cuts-out'), []);
    assert.deepEqual(mappingIds(live, 'vacuum:lost-suction'), []);
    assert.deepEqual(mappingIds(live, 'microwave:not-heating'), []);
    const admin = mergeJoin(shipped, ov, { includeRetired: true });
    assert.deepEqual(mappingIds(admin, 'vacuum:cuts-out'), ['vac-lost-suction']);
  });
});

describe('byComponent', () => {
  it('obeys overlay attach and detach on the active component join', () => {
    const ov = overlayBase();
    ov.byComponent['oven-cooker:fan-oven-element'] = [{
      id: 'admin-temp-media', type: 'IMAGE', title: 'Temp', description: 't', applicability: 'GENERIC', asset: '/media/t.png', alt: 't',
    }];
    let ids = (mergeJoin(shipped, ov).byComponent['oven-cooker:fan-oven-element'] || []).map((m) => m.id);
    assert.ok(ids.includes('oven-element-about') || ids.includes('oven-cooker-not-heating-cooking-properly') || ids.length >= 2);
    ov.detachedByComponent['oven-cooker:fan-oven-element'] = {};
    const shippedId = (shipped.byComponent['oven-cooker:fan-oven-element'][0] || {}).id;
    ov.detachedByComponent['oven-cooker:fan-oven-element'][shippedId] = true;
    ids = (mergeJoin(shipped, ov).byComponent['oven-cooker:fan-oven-element'] || []).map((m) => m.id);
    assert.ok(!ids.includes(shippedId));
    assert.ok(ids.includes('admin-temp-media'));
  });
});

describe('metadata override', () => {
  it('catalogue overlay title/alt/url win on the mapping item', () => {
    const ov = overlayBase();
    ov.identities['dishwasher-filter'] = {
      origin: 'shipped', status: 'active',
      catalogue: { id: 'dishwasher-filter', title: 'Edited title', alt: 'Edited alt', url: '/media/dishwasher-filter-2026.png', type: 'DIAGRAM' },
    };
    const item = mergeJoin(shipped, ov).byKnowledgeId['dishwasher:not-draining'][0];
    assert.equal(item.title, 'Edited title');
    assert.equal(item.alt, 'Edited alt');
    assert.equal(item.asset, '/media/dishwasher-filter-2026.png');
  });
});

describe('malformed / missing overlay', () => {
  it('null overlay keeps baseline', () => {
    assert.deepEqual(mappingIds(mergeJoin(shipped, null), 'vacuum:lost-suction'), ['vac-lost-suction']);
  });
});

describe('admin inspector vs runtime resolver', () => {
  it('produce the same effective knowledge ids', () => {
    const ov = overlayBase();
    ov.byKnowledgeId['microwave:not-heating'] = [{
      id: 'admin-temp-media', type: 'IMAGE', title: 'Temp', description: 'Temp caption',
      applicability: 'GENERIC', asset: '/media/admin-temp-media.png', alt: 'Temp alt',
    }];
    ov.detachedByKnowledgeId['dishwasher:not-draining'] = { 'dishwasher-filter': true };
    const runtime = mergeJoin(shipped, ov);
    const inspected = mediaInspect.applyOverlay(
      { items: [] },
      shipped,
      ov,
    ).join;
    assert.deepEqual(mappingIds(inspected, 'microwave:not-heating'), mappingIds(runtime, 'microwave:not-heating'));
    assert.deepEqual(mappingIds(inspected, 'dishwasher:not-draining'), mappingIds(runtime, 'dishwasher:not-draining'));
    const rec = mediaInspect.getMedia('dishwasher-filter', ov);
    assert.ok(!rec.knowledge.map((k) => k.knowledgeId).includes('dishwasher:not-draining'));
    const attached = mediaInspect.getMedia('admin-temp-media', ov);
    assert.ok(attached.knowledge.map((k) => k.knowledgeId).includes('microwave:not-heating'));
  });
});

describe('live selection consumes the resolver', () => {
  it('getMediaInformation returns overlay-attached media for a previously empty node', async () => {
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(async () => {
      const ov = overlayBase();
      ov.byKnowledgeId['microwave:not-heating'] = [{
        id: 'admin-temp-media', type: 'IMAGE', title: 'Temp microwave diagram',
        description: 'Temporary admin mapping for tests.', applicability: 'GENERIC',
        asset: '/media/admin-temp-media.png', alt: 'Temporary test image',
      }];
      return ov;
    });
    await retrieval.ensureMediaOverlay({ now: Date.now(), ttlMs: 0 });
    const items = retrieval.getMediaInformation('microwave', 'not-heating', {});
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'admin-temp-media');
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(null);
  });

  it('overlay unavailable after a good load keeps last effective mappings', async () => {
    retrieval.resetMediaOverlayCache();
    let n = 0;
    retrieval.setMediaOverlayLoader(async () => {
      n += 1;
      if (n === 1) {
        const ov = overlayBase();
        ov.byKnowledgeId['microwave:not-heating'] = [{
          id: 'admin-temp-media', type: 'IMAGE', title: 'Temp', description: 't',
          applicability: 'GENERIC', asset: '/media/t.png', alt: 't',
        }];
        return ov;
      }
      throw new Error('s3-down');
    });
    await retrieval.ensureMediaOverlay({ now: 1, ttlMs: 0 });
    assert.equal(retrieval.getMediaInformation('microwave', 'not-heating', {})[0].id, 'admin-temp-media');
    await retrieval.ensureMediaOverlay({ now: 1 + retrieval.MEDIA_OVERLAY_TTL_MS + 1, ttlMs: retrieval.MEDIA_OVERLAY_TTL_MS });
    assert.equal(retrieval.getMediaInformation('microwave', 'not-heating', {})[0].id, 'admin-temp-media');
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(null);
  });

  it('malformed overlay on a cold start keeps shipped baseline', async () => {
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(async () => { throw new Error('malformed-overlay'); });
    await retrieval.ensureMediaOverlay({ now: Date.now(), ttlMs: 0 });
    assert.deepEqual(
      retrieval.getMediaInformation('vacuum', 'lost-suction', {}).map((m) => m.id),
      ['vac-lost-suction'],
    );
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(null);
  });

  it('getMediaInformation withholds a detached baseline mapping', async () => {
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(async () => {
      const ov = overlayBase();
      ov.detachedByKnowledgeId['dishwasher:not-draining'] = { 'dishwasher-filter': true };
      return ov;
    });
    await retrieval.ensureMediaOverlay({ now: Date.now(), ttlMs: 0 });
    assert.deepEqual(
      retrieval.getMediaInformation('dishwasher', 'not-draining', {}).map((m) => m.id),
      [],
    );
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(null);
  });

  it('getMediaInformation withholds a retired shipped identity', async () => {
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(async () => {
      const ov = overlayBase();
      ov.identities['vac-lost-suction'] = { origin: 'shipped', status: 'retired' };
      return ov;
    });
    await retrieval.ensureMediaOverlay({ now: Date.now(), ttlMs: 0 });
    assert.deepEqual(
      retrieval.getMediaInformation('vacuum', 'lost-suction', {}).map((m) => m.id),
      [],
    );
    assert.deepEqual(
      retrieval.getMediaInformation('vacuum', 'cuts-out', {}).map((m) => m.id),
      [],
    );
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(null);
  });

  it('getMediaInformation prefers a high-priority overlay attach over shipped', async () => {
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(async () => {
      const ov = overlayBase();
      ov.byKnowledgeId['dishwasher:not-draining'] = [{
        id: 'admin-temp-media', type: 'DIAGRAM', title: 'Temp drain diagram',
        description: 'Temporary admin mapping for tests.', applicability: 'GENERIC',
        asset: '/media/admin-temp-media.png', alt: 'Temporary test image',
        priority: 10000,
      }];
      return ov;
    });
    await retrieval.ensureMediaOverlay({ now: Date.now(), ttlMs: 0 });
    const items = retrieval.getMediaInformation('dishwasher', 'not-draining', {});
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'admin-temp-media');
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(null);
  });

  it('NoSuchKey after a good load returns to shipped baseline', async () => {
    retrieval.resetMediaOverlayCache();
    let n = 0;
    retrieval.setMediaOverlayLoader(async () => {
      n += 1;
      if (n === 1) {
        const ov = overlayBase();
        ov.byKnowledgeId['microwave:not-heating'] = [{
          id: 'admin-temp-media', type: 'IMAGE', title: 'Temp', description: 't',
          applicability: 'GENERIC', asset: '/media/t.png', alt: 't',
        }];
        return ov;
      }
      const err = new Error('The specified key does not exist.');
      err.name = 'NoSuchKey';
      err.Code = 'NoSuchKey';
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    });
    await retrieval.ensureMediaOverlay({ now: 1, ttlMs: 0 });
    assert.equal(retrieval.getMediaInformation('microwave', 'not-heating', {})[0].id, 'admin-temp-media');
    await retrieval.ensureMediaOverlay({ now: 1 + retrieval.MEDIA_OVERLAY_TTL_MS + 1, ttlMs: retrieval.MEDIA_OVERLAY_TTL_MS });
    assert.deepEqual(
      retrieval.getMediaInformation('microwave', 'not-heating', {}).map((m) => m.id),
      [],
    );
    retrieval.resetMediaOverlayCache();
    retrieval.setMediaOverlayLoader(null);
  });
});
