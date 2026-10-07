/**
 * ACQ Question Library + Run Builder tests — import, versioning, CRUD,
 * duplicate, review/enable/archive, safe-delete history preservation,
 * balanced/seeded/manual selection, approved-only default, manifest freeze,
 * exact rerun resolution, comparison safeguards. Offline: in-memory S3.
 * Includes the required mutation proofs.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const lib = require('../benchmark/acq-library.js');
const { memoryS3 } = require('../benchmark/acq-store.js');
const corpus = require('../benchmark/acq-corpus.js');

let CLK = 1000;
const clock = () => (CLK += 1000);
function freshApi() { return lib.createLibrary({ s3: memoryS3(), now: clock }); }
async function seeded() {
  const api = freshApi();
  const c = corpus.loadCorpus();
  await api.ensureSeeded(c.journeys);
  return api;
}

describe('import from ACQ-100', () => {
  it('imports all 121 journeys as v1, sourceType ACQ, APPROVED, preserving ids', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    expect(L.journeys.length).toBe(121);
    const wm001 = L.journeys.find((j) => j.journeyId === 'WM-001');
    expect(wm001.currentVersion).toBe(1);
    expect(wm001.sourceType).toBe('ACQ');
    expect(wm001.reviewStatus).toBe('APPROVED');
    expect(wm001.versions[0].gold.expectedOutcome).toBe('DIAGNOSIS');
  });
  it('is idempotent (does not double-import)', async () => {
    const api = await seeded();
    const r = await api.ensureSeeded(corpus.loadCorpus().journeys);
    expect(r.seeded).toBe(false);
    expect((await api.loadLibrary()).journeys.length).toBe(121);
  });
  it('derives multiple categories and difficulty', async () => {
    const api = await seeded();
    const dw013 = await api.getJourney('DW-013'); // safety journey
    expect(dw013.categories).toContain('Safety');
  });
});

describe('metrics + coverage', () => {
  it('reports family/category/review distribution', async () => {
    const api = await seeded();
    const m = api.metrics(await api.loadLibrary());
    expect(m.total).toBe(121);
    expect(m.approved).toBe(121);
    expect(Object.keys(m.byFamily).length).toBe(9);
    expect(m.safety).toBeGreaterThan(0);
  });
});

describe('CRUD + versioning (mutation proof: editing gold does not mutate history)', () => {
  it('editing gold creates a NEW version; old version body is preserved immutable', async () => {
    const api = await seeded();
    const before = await api.getJourney('WM-023');
    const v1gold = JSON.parse(JSON.stringify(before.versions[0].gold));
    await api.editJourney('WM-023', { gold: { expectedOutcome: 'NORMAL' }, versionNote: 'changed outcome' }, 'tom@x.com');
    const after = await api.getJourney('WM-023');
    expect(after.currentVersion).toBe(2);
    expect(after.versions.length).toBe(2);
    // v1 preserved exactly (historical runs pinned to v1 stay reproducible)
    expect(after.versions[0].gold.expectedOutcome).toBe(v1gold.expectedOutcome);
    expect(after.versions[1].gold.expectedOutcome).toBe('NORMAL');
    // resolving v1 still yields the ORIGINAL gold
    const resolvedV1 = lib.resolveVersion(after, 1);
    expect(resolvedV1.gold.expectedOutcome).toBe(v1gold.expectedOutcome);
  });
  it('metadata-only edit (title/enabled) does NOT create a version', async () => {
    const api = await seeded();
    await api.editJourney('WM-001', { title: 'Renamed', enabled: false }, 'tom@x.com');
    const j = await api.getJourney('WM-001');
    expect(j.currentVersion).toBe(1);
    expect(j.title).toBe('Renamed');
    expect(j.enabled).toBe(false);
  });
  it('create validates and rejects structurally impossible journeys', async () => {
    const api = await seeded();
    await expect(api.createJourney({ family: 'washing-machine', opening: '', gold: { expectedOutcome: 'NONSENSE' } }, 'x')).rejects.toThrow(/validation/);
  });
  it('create then it starts as DRAFT (not in approved pool)', async () => {
    const api = await seeded();
    const rec = await api.createJourney({ family: 'dishwasher', title: 'New DW', opening: 'dishwasher wont drain', gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['filter'], mustInclude: ['filter'] } }, 'tom@x.com');
    expect(rec.reviewStatus).toBe('DRAFT');
    const pool = api.eligiblePool(await api.loadLibrary(), {});
    expect(pool.find((j) => j.journeyId === rec.journeyId)).toBeUndefined();
  });
  it('duplicate creates a new stable id, DRAFT, copying gold', async () => {
    const api = await seeded();
    const dup = await api.duplicateJourney('DW-003', { title: 'Bosch dishwasher E09' }, 'tom@x.com');
    expect(dup.journeyId).not.toBe('DW-003');
    expect(dup.reviewStatus).toBe('DRAFT');
    expect(dup.sourceReference).toBe('duplicated:DW-003');
  });
});

describe('safe delete — history preservation (mutation proof)', () => {
  it('a journey used in a run is ARCHIVED not hard-deleted', async () => {
    const api = await seeded();
    const r = await api.safeDelete('WM-001', true);
    expect(r.deleted).toBe(false);
    expect(r.archived).toBe(true);
    const j = await api.getJourney('WM-001');
    expect(j.archived).toBe(true);
  });
  it('a never-run DRAFT can be hard-deleted', async () => {
    const api = await seeded();
    const rec = await api.createJourney({ family: 'vacuum', opening: 'no suction', gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['filter'], mustInclude: ['filter'] } }, 'x');
    const r = await api.safeDelete(rec.journeyId, false);
    expect(r.deleted).toBe(true);
    expect(await api.getJourney(rec.journeyId)).toBe(null);
  });
});

describe('selection — approved-only default, balanced, seeded random, manual', () => {
  it('archived/draft journeys do NOT leak into the default pool (mutation proof)', async () => {
    const api = await seeded();
    await api.createJourney({ family: 'hobs', opening: 'draft hob', gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['coil'], mustInclude: ['coil'] } }, 'x'); // DRAFT
    await api.setFlags('WM-002', { archived: true });
    const pool = api.eligiblePool(await api.loadLibrary(), {});
    expect(pool.some((j) => j.reviewStatus !== 'APPROVED')).toBe(false);
    expect(pool.some((j) => j.archived)).toBe(false);
    expect(pool.some((j) => j.journeyId === 'WM-002')).toBe(false);
  });
  it('seeded random reproduces the exact same selection', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const pool = api.eligiblePool(L, {});
    const a = lib.selectRandom(pool, 15, 12345).map((j) => j.journeyId);
    const b = lib.selectRandom(pool, 15, 12345).map((j) => j.journeyId);
    const c = lib.selectRandom(pool, 15, 99999).map((j) => j.journeyId);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
  it('balanced selection spreads across families (not a random N-pick)', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const pool = api.eligiblePool(L, {});
    const picked = lib.selectBalanced(pool, 18, { seed: 7 });
    const fams = new Set(picked.map((j) => j.family));
    expect(picked.length).toBe(18);
    expect(fams.size).toBeGreaterThanOrEqual(7); // spread across most families
  });
  it('balanced honours category filter', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const pool = api.eligiblePool(L, { categories: ['Safety', 'Error Code'] });
    const picked = lib.selectBalanced(pool, 8, { seed: 3, categories: ['Safety', 'Error Code'] });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((j) => j.categories.some((c) => ['Safety', 'Error Code'].includes(c)))).toBe(true);
  });
});

describe('manifest freeze + resolve + comparison safeguards', () => {
  it('freezes exact journeyId+version and pins even after later edits', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const man = lib.buildManifest({ lib: L, mode: 'BALANCED', n: 10, filters: {}, seed: 42 }, api);
    expect(man.journeyCount).toBe(10);
    expect(man.journeys.every((m) => m.version === 1)).toBe(true);
    // edit one of the chosen journeys -> new version; manifest still pins v1
    const firstId = man.journeys[0].journeyId;
    await api.editJourney(firstId, { gold: { mustInclude: ['changed'] } }, 'x');
    const L2 = await api.loadLibrary();
    const resolved = lib.resolveManifest(L2, man);
    const pinned = resolved.find((r) => r.journeyId === firstId);
    expect(pinned.version).toBe(1); // pinned to the frozen version, not the new one
  });
  it('MANUAL selection picks exactly the ticked journeys', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const man = lib.buildManifest({ lib: L, mode: 'MANUAL', manualIds: ['WM-001', 'DW-013', 'HB-003'] }, api);
    expect(man.journeys.map((m) => m.journeyId).sort()).toEqual(['DW-013', 'HB-003', 'WM-001']);
  });
  it('manifestDiff flags identical vs differing sets and version mismatches', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const m1 = lib.buildManifest({ lib: L, mode: 'MANUAL', manualIds: ['WM-001', 'DW-013'] }, api);
    const same = lib.manifestDiff(m1, m1);
    expect(same.identical).toBe(true);
    const m2 = lib.buildManifest({ lib: L, mode: 'MANUAL', manualIds: ['WM-001', 'HB-003'] }, api);
    const diff = lib.manifestDiff(m1, m2);
    expect(diff.identical).toBe(false);
    expect(diff.commonCount).toBe(1);
    // version mismatch detection
    await api.editJourney('WM-001', { gold: { mustInclude: ['x'] } }, 'x');
    const L2 = await api.loadLibrary();
    const m3 = lib.buildManifest({ lib: L2, mode: 'MANUAL', manualIds: ['WM-001', 'DW-013'] }, api);
    const vd = lib.manifestDiff(m1, m3);
    expect(vd.versionMismatches.find((v) => v.journeyId === 'WM-001')).toBeTruthy();
  });
});


// ============================================================================
// BALANCED sampler — representativeness contract (family + difficulty + turn +
// outcome), reproducibility, sparse/small/large-n, and mutation proofs that the
// tests catch the original "shuffle-then-deterministic-sort" defect and each
// dropped dimension. Corpus proportions are derived DYNAMICALLY (no magic counts).
// ============================================================================

// deterministic PRNG (mirrors the library's, used only to build mutant fixtures)
function _hashSeed(s){let h=2166136261>>>0;s=String(s);for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return h>>>0;}
function _mul(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function _shuffle(arr,seed){const r=_mul(typeof seed==='number'?seed:_hashSeed(seed));const a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));const t=a[i];a[i]=a[j];a[j]=t;}return a;}
const _outcome = (j) => (lib.resolveVersion(j, j.currentVersion).gold || {}).expectedOutcome || 'UNKNOWN';
async function pool25() { const api = await seeded(); const L = await api.loadLibrary(); return api.eligiblePool(L, {}); }

// A configurable deficit sampler used ONLY to build mutants (dims dropped / seed ignored).
const _DIMS = { family:(j)=>j.family||'U', difficulty:(j)=>j.difficulty||'U', turn:(j)=>j.multiTurn?'M':'S', outcome:(j)=>_outcome(j) };
function mutantSampler(dimNames, seedMatters) {
  return (pool, n, opts) => {
    const total = Math.min(n, pool.length); if (!total) return [];
    const ordered = seedMatters ? _shuffle(pool, (opts&&opts.seed)!=null?opts.seed:'b') : pool.slice();
    const dims = dimNames.map((x)=>_DIMS[x]);
    const pc = dims.map(()=>new Map());
    for (const j of pool) dims.forEach((f,d)=>{const k=f(j);pc[d].set(k,(pc[d].get(k)||0)+1);});
    const sc = dims.map(()=>new Map()); const out=[]; const used=new Set();
    for (let s=0;s<total;s++){ let best=null,bs=-Infinity; for(const j of ordered){ if(used.has(j.journeyId))continue; let sco=0; dims.forEach((f,d)=>{const k=f(j);const tgt=total*(pc[d].get(k)/pool.length);const need=(tgt-(sc[d].get(k)||0))/tgt;if(need>0)sco+=need;}); if(sco>bs){bs=sco;best=j;} } if(!best)break; out.push(best); used.add(best.journeyId); dims.forEach((f,d)=>{const k=f(best);sc[d].set(k,(sc[d].get(k)||0)+1);}); }
    return out;
  };
}
// The ORIGINAL defective algorithm (seeded shuffle immediately overridden by a deterministic sort).
function _spreadKey(j){return j.family+'|'+j.difficulty+'|'+(j.multiTurn?'M':'S');}
function originalDefectSampler(pool,n,opts){
  const seed=(opts&&opts.seed)!=null?opts.seed:'b';const total=Math.min(n,pool.length);
  const m=new Map();for(const j of pool){if(!m.has(j.family))m.set(j.family,[]);m.get(j.family).push(j);}
  const buckets=[...m.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,arr])=>{const sh=_shuffle(arr,seed+':'+k);sh.sort((x,y)=>_spreadKey(x).localeCompare(_spreadKey(y)));return{arr:sh,i:0};});
  const out=[];const seen=new Set();let prog=true;
  while(out.length<total&&prog){prog=false;for(const b of buckets){while(b.i<b.arr.length&&seen.has(b.arr[b.i].journeyId))b.i++;if(b.i<b.arr.length){const j=b.arr[b.i++];seen.add(j.journeyId);out.push(j);prog=true;if(out.length>=total)break;}}}
  return out;
}

describe('BALANCED contract — reproducibility + no duplicates + exact n', () => {
  it('A. same seed => byte-identical manifest', async () => {
    const pool = await pool25();
    const a = lib.selectBalanced(pool, 25, { seed: 42 }).map((j) => j.journeyId);
    const b = lib.selectBalanced(pool, 25, { seed: 42 }).map((j) => j.journeyId);
    expect(a).toEqual(b);
  });
  it('B. different seeds materially vary journey identity', async () => {
    const pool = await pool25();
    const union = new Set(); let maxOverlap = 0; let prev = null;
    for (const s of [1,2,3,4,5,6,7,8,9,10]) {
      const ids = lib.selectBalanced(pool, 25, { seed: s }).map((j) => j.journeyId);
      ids.forEach((x) => union.add(x));
      if (prev) { const p = new Set(prev); maxOverlap = Math.max(maxOverlap, ids.filter((x) => p.has(x)).length / ids.length); }
      prev = ids;
    }
    expect(union.size).toBeGreaterThan(25);      // far more than one manifest's worth of journeys
    expect(maxOverlap).toBeLessThan(0.85);         // consecutive seeds are materially different
  });
  it('C. no duplicate journeys within a manifest (n=25 and n=50, many seeds)', async () => {
    const pool = await pool25();
    for (const n of [25, 50]) for (let s = 1; s <= 30; s++) {
      const ids = lib.selectBalanced(pool, n, { seed: s }).map((j) => j.journeyId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it('D. selects exactly n when n <= pool', async () => {
    const pool = await pool25();
    for (const n of [1, 5, 25, 50]) expect(lib.selectBalanced(pool, n, { seed: 5 }).length).toBe(n);
  });
});

describe('BALANCED contract — coverage', () => {
  it('E. family coverage: n>=families => every family represented (every seed)', async () => {
    const pool = await pool25();
    const fams = new Set(pool.map((j) => j.family)).size;
    for (let s = 1; s <= 20; s++) {
      const got = new Set(lib.selectBalanced(pool, 25, { seed: s }).map((j) => j.family));
      expect(got.size).toBe(fams);
    }
  });
  it('F. difficulty coverage: all present difficulties appear every seed (n=25)', async () => {
    const pool = await pool25();
    for (let s = 1; s <= 20; s++) {
      const d = new Set(lib.selectBalanced(pool, 25, { seed: s }).map((j) => j.difficulty));
      expect(d.has('EASY') && d.has('MEDIUM') && d.has('HARD')).toBe(true);
    }
  });
  it('G. multi-turn representation near corpus proportion (n=25)', async () => {
    const pool = await pool25();
    const corpusMT = pool.filter((j) => j.multiTurn).length / pool.length;
    let sum = 0; const N = 100; let minMT = 99, maxMT = 0;
    for (let s = 1; s <= N; s++) {
      const mt = lib.selectBalanced(pool, 25, { seed: s }).filter((j) => j.multiTurn).length;
      sum += mt; minMT = Math.min(minMT, mt); maxMT = Math.max(maxMT, mt);
    }
    const avgRatio = (sum / N) / 25;
    expect(Math.abs(avgRatio - corpusMT)).toBeLessThan(0.06); // within 6pp of corpus (was 8% flat, corpus ~35.5%)
    expect(minMT).toBeGreaterThanOrEqual(8);   // never starved (proportional quota ~8.9)
    expect(maxMT).toBeLessThanOrEqual(10);
  });
  it('H. outcome representation: minority outcomes (incl. SAFETY_STOP) never starved (n=25)', async () => {
    const pool = await pool25();
    const outcomes = new Set(pool.map(_outcome));
    for (let s = 1; s <= 20; s++) {
      const got = new Set(lib.selectBalanced(pool, 25, { seed: s }).map(_outcome));
      expect(got.has('SAFETY_STOP')).toBe(true);           // rare (6/121) but must be exercised
      expect(got.size).toBe(outcomes.size);                 // every outcome present
    }
  });
});

describe('BALANCED contract — small n, large n, sparse strata, missing metadata', () => {
  it('J. small n is deterministic, exact, dup-free, never throws (n=1,2,5,9)', async () => {
    const pool = await pool25();
    for (const n of [1, 2, 5, 9]) {
      const a = lib.selectBalanced(pool, n, { seed: 3 }).map((j) => j.journeyId);
      const b = lib.selectBalanced(pool, n, { seed: 3 }).map((j) => j.journeyId);
      expect(a).toEqual(b);
      expect(a.length).toBe(n);
      expect(new Set(a).size).toBe(n);
    }
  });
  it('K. large n: n=pool => every journey once; n>pool => capped at pool, no dupes', async () => {
    const pool = await pool25();
    const all = lib.selectBalanced(pool, pool.length, { seed: 1 });
    expect(all.length).toBe(pool.length);
    expect(new Set(all.map((j) => j.journeyId)).size).toBe(pool.length);
    const over = lib.selectBalanced(pool, pool.length + 79, { seed: 1 });
    expect(over.length).toBe(pool.length);
    expect(new Set(over.map((j) => j.journeyId)).size).toBe(pool.length);
  });
  it('I. sparse strata: 1 HARD, 1 safety, a family with no multi-turn — no throw/loop/dup, rare picked', async () => {
    const mk = (id, family, difficulty, multiTurn, outcome) => ({ journeyId: id, family, difficulty, multiTurn, currentVersion: 1, versions: [{ version: 1, gold: { expectedOutcome: outcome } }] });
    const sparse = [
      mk('A-1', 'hobs', 'EASY', false, 'DIAGNOSIS'), mk('A-2', 'hobs', 'EASY', false, 'DIAGNOSIS'),
      mk('A-3', 'hobs', 'EASY', true, 'NORMAL'), mk('B-1', 'vacuum', 'EASY', false, 'DIAGNOSIS'),
      mk('B-2', 'vacuum', 'HARD', false, 'DIAGNOSIS'),           // the ONLY HARD
      mk('C-1', 'oven-cooker', 'EASY', false, 'SAFETY_STOP'),    // the ONLY safety
    ];
    const picked = lib.selectBalanced(sparse, 4, { seed: 9 });
    expect(picked.length).toBe(4);
    expect(new Set(picked.map((j) => j.journeyId)).size).toBe(4);
    // rare strata should be pulled in by the deficit objective when n permits
    const ids = picked.map((j) => j.journeyId);
    expect(ids).toContain('B-2'); // only HARD
    expect(ids).toContain('C-1'); // only safety
  });
  it('21. missing metadata (no difficulty / no versions) is bucketed, never discarded or thrown', async () => {
    const broken = [
      { journeyId: 'X-1', family: 'hobs', currentVersion: 1, versions: [] },            // no gold, no difficulty
      { journeyId: 'X-2', family: undefined, difficulty: undefined, multiTurn: false, versions: [{ version: 1, gold: {} }], currentVersion: 1 },
      { journeyId: 'X-3', family: 'vacuum', difficulty: 'EASY', multiTurn: false, currentVersion: 1, versions: [{ version: 1, gold: { expectedOutcome: 'DIAGNOSIS' } }] },
    ];
    const picked = lib.selectBalanced(broken, 3, { seed: 1 });
    expect(picked.length).toBe(3);
    expect(new Set(picked.map((j) => j.journeyId)).size).toBe(3);
  });
});

describe('BALANCED distribution bands across 100 seeds (n=25)', () => {
  it('difficulty + multi-turn counts track corpus proportion within tolerance', async () => {
    const pool = await pool25();
    const target = (v, f) => 25 * pool.filter(f).length / pool.length;
    const tHard = target('HARD', (j) => j.difficulty === 'HARD');
    const tMed = target('MEDIUM', (j) => j.difficulty === 'MEDIUM');
    const tMT = target('MT', (j) => j.multiTurn);
    let sH = 0, sM = 0, sMT = 0; const N = 100;
    for (let s = 1; s <= N; s++) {
      const p = lib.selectBalanced(pool, 25, { seed: s });
      sH += p.filter((j) => j.difficulty === 'HARD').length;
      sM += p.filter((j) => j.difficulty === 'MEDIUM').length;
      sMT += p.filter((j) => j.multiTurn).length;
    }
    // Bands: average count within +/-1.5 of the proportional target (tight because the proportional
    // quota is intentional; the SEED varies which journeys fill it, proven by test B).
    expect(Math.abs(sH / N - tHard)).toBeLessThan(1.5);
    expect(Math.abs(sM / N - tMed)).toBeLessThan(1.5);
    expect(Math.abs(sMT / N - tMT)).toBeLessThan(1.5);
  });
});

describe('BALANCED mutation proofs — tests catch the defect and each dropped dimension', () => {
  // Reusable property probes over a selector (n=25).
  const allDiff = (sel, pool) => { for (let s = 1; s <= 20; s++) { const d = new Set(sel(pool, 25, { seed: s }).map((j) => j.difficulty)); if (!(d.has('EASY') && d.has('MEDIUM') && d.has('HARD'))) return false; } return true; };
  const hardStable = (sel, pool) => { let mn = 99; for (let s = 1; s <= 100; s++) mn = Math.min(mn, sel(pool, 25, { seed: s }).filter((j) => j.difficulty === 'HARD').length); return mn >= 5; };
  const mtStable = (sel, pool) => { let mn = 99, mx = 0; for (let s = 1; s <= 100; s++) { const mt = sel(pool, 25, { seed: s }).filter((j) => j.multiTurn).length; mn = Math.min(mn, mt); mx = Math.max(mx, mt); } return mn >= 8 && mx <= 10; };
  const allFam = (sel, pool) => { const fams = new Set(pool.map((j) => j.family)).size; for (let s = 1; s <= 20; s++) if (new Set(sel(pool, 25, { seed: s }).map((j) => j.family)).size < fams) return false; return true; };
  const safetyAlways = (sel, pool) => { for (let s = 1; s <= 20; s++) if (!sel(pool, 25, { seed: s }).map(_outcome).includes('SAFETY_STOP')) return false; return true; };
  const seedMatters = (sel, pool) => { const a = sel(pool, 25, { seed: 1 }).map((j) => j.journeyId).join(','); const b = sel(pool, 25, { seed: 2 }).map((j) => j.journeyId).join(','); return a !== b; };

  it('the REAL selector satisfies every property', async () => {
    const pool = await pool25();
    expect(allDiff(lib.selectBalanced, pool)).toBe(true);
    expect(hardStable(lib.selectBalanced, pool)).toBe(true);
    expect(mtStable(lib.selectBalanced, pool)).toBe(true);
    expect(allFam(lib.selectBalanced, pool)).toBe(true);
    expect(safetyAlways(lib.selectBalanced, pool)).toBe(true);
    expect(seedMatters(lib.selectBalanced, pool)).toBe(true);
  });
  it('31. ORIGINAL defect (shuffle then deterministic spreadKey sort) is caught', async () => {
    const pool = await pool25();
    // The defect selects EASY-only and ~2 multi-turn at n=25 regardless of seed.
    expect(allDiff(originalDefectSampler, pool)).toBe(false);   // never reaches MEDIUM/HARD
    expect(mtStable(originalDefectSampler, pool)).toBe(false);  // multi-turn starved (~2)
  });
  it('34. ignore-difficulty is caught (HARD not stable near target)', async () => {
    const pool = await pool25();
    expect(hardStable(mutantSampler(['family', 'turn', 'outcome'], true), pool)).toBe(false);
  });
  it('35. ignore-turn-depth is caught (multi-turn not stable near target)', async () => {
    const pool = await pool25();
    expect(mtStable(mutantSampler(['family', 'difficulty', 'outcome'], true), pool)).toBe(false);
  });
  it('32. ignore-family is caught (a family missing on some seed)', async () => {
    const pool = await pool25();
    expect(allFam(mutantSampler(['difficulty', 'turn', 'outcome'], true), pool)).toBe(false);
  });
  it('33. ignore-outcome is caught (SAFETY_STOP starved on some seeds)', async () => {
    const pool = await pool25();
    expect(safetyAlways(mutantSampler(['family', 'difficulty', 'turn'], true), pool)).toBe(false);
  });
  it('36. seed-has-no-effect is caught (identical manifests across seeds)', async () => {
    const pool = await pool25();
    expect(seedMatters(mutantSampler(['family', 'difficulty', 'turn', 'outcome'], false), pool)).toBe(false);
  });
});

describe('BALANCED — exact rerun, version pinning, historical immutability unchanged', () => {
  it('L/M. exact rerun resolves the frozen ids at pinned versions even after a later edit', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const man = lib.buildManifest({ lib: L, mode: 'BALANCED', n: 12, filters: {}, seed: 77 }, api);
    expect(man.journeys.length).toBe(12);
    const editId = man.journeys[0].journeyId;
    await api.editJourney(editId, { gold: { mustInclude: ['drift'] } }, 'x'); // -> v2 in library
    const L2 = await api.loadLibrary();
    const resolved = lib.resolveManifest(L2, man);              // rerun uses the FROZEN manifest
    expect(resolved.length).toBe(12);
    const pinned = resolved.find((r) => r.journeyId === editId);
    expect(pinned.version).toBe(1);                             // pinned to frozen version, not v2
    expect(man.journeys.every((m) => m.version === 1)).toBe(true);
  });
  it('N. rebuilding a manifest with the same seed reproduces the same frozen id set', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const a = lib.buildManifest({ lib: L, mode: 'BALANCED', n: 25, filters: {}, seed: 2026 }, api);
    const b = lib.buildManifest({ lib: L, mode: 'BALANCED', n: 25, filters: {}, seed: 2026 }, api);
    expect(lib.manifestDiff(a, b).identical).toBe(true);
  });
});

describe('list summaries + ordered customer turns', () => {
  it('summariseJourney exposes opener, turnCount and semantic flags without migrating records', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const rows = api.listJourneys(L, {});
    expect(rows.length).toBe(121);
    const one = rows.find((j) => j.journeyId === 'WM-001');
    expect(one.opening).toBeTruthy();
    expect(one.turnCount).toBeGreaterThanOrEqual(1);
    expect(one).toHaveProperty('expectMedia');
    expect(one).toHaveProperty('mustSafetyStop');
  });
  it('search matches customer opener text', async () => {
    const api = await seeded();
    const L = await api.loadLibrary();
    const wm = await api.getJourney('WM-001');
    const opening = wm.versions[0].opening;
    const needle = String(opening).slice(0, 12).toLowerCase();
    const rows = api.listJourneys(L, { q: needle });
    expect(rows.some((j) => j.journeyId === 'WM-001')).toBe(true);
  });
  it('create persists ordered customer turns and a new identity', async () => {
    const api = await seeded();
    const rec = await api.createJourney({
      family: 'vacuum',
      title: 'TEMP validation pulsing',
      opening: 'my dyson v6 is pulsing',
      turns: ['my dyson v6 is pulsing', "I'm not sure"],
      gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['filter'] },
    }, 'x');
    expect(rec.journeyId).toMatch(/^VC-/);
    expect(rec.versions[0].turns).toEqual(['my dyson v6 is pulsing', "I'm not sure"]);
    expect(rec.multiTurn).toBe(true);
    const listed = api.listJourneys(await api.loadLibrary(), { q: 'dyson v6 is pulsing' });
    expect(listed.find((j) => j.journeyId === rec.journeyId).turnCount).toBe(2);
  });
  it('edit preserves identity, keeps opener first, and versions semantic turn changes', async () => {
    const api = await seeded();
    const rec = await api.createJourney({
      family: 'vacuum', title: 'Pulse', opening: 'my dyson v6 is pulsing',
      turns: ['my dyson v6 is pulsing'],
      gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['filter'] },
    }, 'x');
    const after = await api.editJourney(rec.journeyId, {
      turns: ['my dyson v6 is pulsing', "I'm not sure", ''],
      opening: 'my dyson v6 is pulsing',
      gold: rec.versions[0].gold,
      versionNote: 'added later customer turn',
    }, 'x');
    expect(after.journeyId).toBe(rec.journeyId);
    expect(after.currentVersion).toBe(2);
    expect(after.versions[0].turns).toEqual(['my dyson v6 is pulsing']);
    expect(after.versions[1].turns).toEqual(['my dyson v6 is pulsing', "I'm not sure"]);
  });
  it('duplicate copies turns onto a new id without mutating the original', async () => {
    const api = await seeded();
    const rec = await api.createJourney({
      family: 'vacuum', title: 'Pulse', opening: 'my dyson v6 is pulsing',
      turns: ['my dyson v6 is pulsing', "I'm not sure"],
      gold: { expectedOutcome: 'DIAGNOSIS', goldSuspects: ['filter'] },
    }, 'x');
    const dup = await api.duplicateJourney(rec.journeyId, { title: 'Pulse after filter cleaned' }, 'x');
    expect(dup.journeyId).not.toBe(rec.journeyId);
    expect(dup.versions[0].turns).toEqual(['my dyson v6 is pulsing', "I'm not sure"]);
    const orig = await api.getJourney(rec.journeyId);
    expect(orig.title).toBe('Pulse');
    expect(orig.versions[0].turns).toEqual(['my dyson v6 is pulsing', "I'm not sure"]);
  });
});

