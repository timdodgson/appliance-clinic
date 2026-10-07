/**
 * Read-only media inspector over the shipped catalogue, files, and diagnostic mappings.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const md = require('../media-inspect.js');

describe('canonical media identities', () => {
  it('loads unique identities across catalogue and mappings', () => {
    const list = md.listMedia({});
    expect(list.total).toBe(38);
    expect(list.frozen).toBe(true);
    expect(list.usedCount).toBe(22);
    expect(list.unusedCount).toBe(16);
  });

  it('does not invent a microwave family when no identities have one', () => {
    expect(md.listMedia({}).families.some((f) => f.family === 'microwave')).toBe(false);
  });
});

describe('search is deterministic admin discovery', () => {
  it('finds assets by title, id, fault and error code', () => {
    const ids = (q) => md.listMedia({ q }).records.map((r) => r.id);
    expect(ids('pump filter')).toContain('wm-pump-filter');
    expect(ids('vac-lost-suction')).toContain('vac-lost-suction');
    expect(ids('cuts-out')).toContain('vac-lost-suction');
    expect(ids('F05')).toContain('wm-drain-hotpoint-f05-f11');
  });

  it('filters by appliance, type and usage', () => {
    expect(md.listMedia({ family: 'vacuum' }).matching).toBe(1);
    expect(md.listMedia({ type: 'VIDEO' }).matching).toBe(4);
    expect(md.listMedia({ usage: 'unused' }).matching).toBe(16);
    expect(md.listMedia({ usage: 'unavailable' }).matching).toBe(0);
  });
});

describe('detail reflects mappings without mutating them', () => {
  it('exposes both vacuum knowledge records on vac-lost-suction', () => {
    const rec = md.getMedia('vac-lost-suction');
    expect(rec.title).toBe('Poor suction — what to check first');
    expect(rec.previewUrl).toBe('/media/vac-poor-suction-loss-of-power.png');
    expect(rec.knowledge.map((k) => k.knowledgeId).sort()).toEqual([
      'vacuum:cuts-out',
      'vacuum:lost-suction',
    ]);
    expect(JSON.stringify(rec)).not.toMatch(/AWS_|secret|credential/i);
  });

  it('states unused catalogue assets as absence, not waste', () => {
    const rec = md.getMedia('dishwasher-drain-hose-high-loop');
    expect(rec.used).toBe(false);
    expect(rec.gaps).toContain('Not linked to diagnostic knowledge');
    expect(rec.gaps).toContain('No alt text recorded');
  });

  it('returns null for unknown ids', () => {
    expect(md.getMedia('not-a-real-media')).toBeNull();
  });
});
