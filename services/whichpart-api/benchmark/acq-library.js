'use strict';
/**
 * ACQ Question Library + Run Builder core.
 *
 * A reusable diagnostic-testing platform on top of the ACQ benchmark:
 *   - VERSIONED journeys (stable journeyId + immutable version bodies) so a
 *     historical run stays tied to the exact gold it used (editing gold creates
 *     a NEW version; old runs remain reproducible against their version).
 *   - Review lifecycle (DRAFT/REVIEWED/APPROVED/ARCHIVED) + enabled flag; the
 *     default selection pool is APPROVED + enabled + not archived.
 *   - Provenance (sourceType) so a future transcript-derived journey slots in
 *     without schema change. This library is EVALUATION evidence only — it is
 *     deliberately separate from RAG/diagnostic knowledge.
 *   - Selection: balanced / seeded-random / manual, producing a FROZEN manifest
 *     (exact journeyId+version list + seed + filters) that a run pins to.
 *
 * Storage: a single S3 document `acq/library.json` (one GET, fast metrics/list;
 * single-admin low-concurrency). The S3 client is INJECTED (unit-testable).
 * Existing ACQ-100 journeys are imported as v1, sourceType ACQ, APPROVED — so
 * the four historical ACQ-100-V1 runs (which reference journeyId) resolve to v1.
 */

const LIBRARY_KEY = 'acq/library.json';
const LIBRARY_SCHEMA = 'acq-library-v1';

const SOURCE_TYPES = ['AUTHORED', 'EXISTING_REGRESSION', 'ACQ', 'CUSTOMER_TRANSCRIPT', 'ENGINEER_REVIEW'];
const REVIEW_STATES = ['DRAFT', 'REVIEWED', 'APPROVED', 'ARCHIVED'];
const CATEGORIES = [
  'Straightforward Diagnosis', 'Ambiguous Symptom', 'Multi-turn', 'Error Code', 'Safety',
  'Normal Behaviour', 'No Part', 'Customer Correction', 'Already Replaced', 'Model / Fit',
  'Media', 'Near Neighbour', 'Messy Customer Language', 'Conflicting Evidence', 'Hard / Edge Case',
];
const FAMILIES = ['washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher', 'oven-cooker', 'hobs', 'fridge-freezer', 'microwave', 'vacuum'];

// ---- deterministic PRNG (seeded random selection is reproducible) -----------
function hashSeed(str) { let h = 2166136261 >>> 0; const s = String(str); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function seededShuffle(arr, seed) {
  const rnd = mulberry32(typeof seed === 'number' ? seed : hashSeed(seed));
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// ---- mapping ACQ-100 journeys -> library journeys ----------------------------

/** Derive human categories from an ACQ journey's gold + tags (a journey can have many). */
function deriveCategories(j) {
  const g = j.gold || {}; const cats = new Set(); const tags = (j.categories || []);
  const has = (t) => tags.indexOf(t) !== -1;
  if (g.expectedOutcome === 'SAFETY_STOP' || has('SAFETY')) cats.add('Safety');
  if (g.expectedOutcome === 'NORMAL' || has('NORMAL')) cats.add('Normal Behaviour');
  if (g.expectedOutcome === 'NO_PART' || g.expectedOutcome === 'EXTERNAL' || has('NO_PART') || has('EXTERNAL')) cats.add('No Part');
  if (has('ERROR_CODE') || has('BRAND_CODE')) cats.add('Error Code');
  if (g.followUpAppropriate === true || has('NEEDS_FOLLOWUP') || j.turnsMulti) cats.add('Multi-turn');
  if (has('AMBIGUOUS') || has('VAGUE') || has('INCOMPLETE')) cats.add('Ambiguous Symptom');
  if (has('CORRECTION')) cats.add('Customer Correction');
  if (has('ALREADY_REPLACED')) cats.add('Already Replaced');
  if (has('FIT_SENSITIVE') || has('MODEL_LATER') || has('MODEL_UNKNOWN')) cats.add('Model / Fit');
  if (has('MEDIA')) cats.add('Media');
  if (has('NEAR_NEIGHBOUR')) cats.add('Near Neighbour');
  if (has('MESSY_WORDING') || has('SPELLING') || has('NON_TECHNICAL')) cats.add('Messy Customer Language');
  if (has('CONFLICTING') || has('MULTI_CAUSE')) cats.add('Conflicting Evidence');
  if (has('MISLEADING')) cats.add('Hard / Edge Case');
  if (g.expectedOutcome === 'DIAGNOSIS' && g.immediateDiagnosis && !g.followUpAppropriate) cats.add('Straightforward Diagnosis');
  if (!cats.size) cats.add('Straightforward Diagnosis');
  return [...cats];
}
function difficultyOf(j) {
  const cats = j.categories || [];
  if (cats.some((c) => ['MISLEADING', 'CONFLICTING', 'MULTI_CAUSE', 'NEAR_NEIGHBOUR'].indexOf(c) !== -1)) return 'HARD';
  if (cats.some((c) => ['AMBIGUOUS', 'VAGUE', 'INCOMPLETE', 'NEEDS_FOLLOWUP', 'MODEL_LATER', 'SPELLING'].indexOf(c) !== -1)) return 'MEDIUM';
  return 'EASY';
}

function toLibraryJourney(j, now) {
  const g = j.gold || {};
  const multiTurn = g.followUpAppropriate === true;
  const gold = {
    expectedOutcome: g.expectedOutcome,
    acceptableAlternatives: g.acceptableAlternatives || [],
    goldSuspects: g.goldSuspects || [],
    mustInclude: g.mustInclude || [],
    expectedComponents: g.expectedComponents || g.goldSuspects || [],
    followUpAppropriate: g.followUpAppropriate === true,
    followUpTargetFact: g.followUpTargetFact || null,
    expectedQuestionIntent: g.followUpTargetFact || null,
    immediateDiagnosis: g.immediateDiagnosis === true,
    simulatedAnswers: g.simulatedAnswers || {},
    scriptedFollowups: g.scriptedFollowups || [],
    lateModel: g.lateModel || null,
    alreadyKnownFacts: g.alreadyKnownFacts || [],
    alreadyReplaced: g.alreadyReplaced || [],
    mustSafetyStop: g.mustSafetyStop === true,
    mustNotPart: g.mustNotPart === true,
    mustNotWrongBrandMedia: g.mustNotWrongBrandMedia !== false,
    modelKnown: g.modelKnown,
    expectMedia: g.expectMedia === true,
    forbiddenOutcomes: g.forbiddenOutcomes || [],
    idealTurns: g.idealTurns || null,
    maxTurns: g.maxTurns || 4,
  };
  return {
    journeyId: j.journeyId,
    title: j.title || (j.turns && j.turns[0] ? j.turns[0].slice(0, 70) : j.journeyId),
    family: j.family,
    make: j.make || null,
    model: g.lateModel || null,
    categories: deriveCategories(j),
    rawTags: j.categories || [],
    difficulty: difficultyOf(j),
    multiTurn,
    sourceType: 'ACQ',
    sourceReference: 'ACQ-100-V1',
    transcriptReference: null,
    reviewStatus: 'APPROVED',
    enabled: true,
    archived: false,
    currentVersion: 1,
    createdAt: now, updatedAt: now, createdBy: 'import',
    versions: [{ version: 1, createdAt: now, byEmail: 'import', note: 'Imported from ACQ-100-V1', opening: (j.turns && j.turns[0]) || '', turns: j.turns || [], gold }],
  };
}

/** Resolve a library journey at a specific version into the runnable shape the simulator expects. */
function resolveVersion(journey, version) {
  const v = (journey.versions || []).find((x) => x.version === version) || (journey.versions || [])[journey.versions.length - 1];
  if (!v) return null;
  return { journeyId: journey.journeyId, family: journey.family, title: journey.title, turns: v.turns && v.turns.length ? v.turns : [v.opening], gold: v.gold, version: v.version };
}

// ---- store factory ----------------------------------------------------------

function createLibrary(deps) {
  const s3 = deps.s3;
  const now = deps.now || (() => Date.now());
  const iso = () => new Date(now()).toISOString();

  async function loadLibrary() {
    const raw = await s3.getObject(LIBRARY_KEY);
    if (raw) { try { return JSON.parse(raw); } catch { /* fall through to empty */ } }
    return { schema: LIBRARY_SCHEMA, createdAt: iso(), updatedAt: iso(), journeys: [] };
  }
  async function saveLibrary(lib) { lib.updatedAt = iso(); await s3.putObject(LIBRARY_KEY, JSON.stringify(lib)); return lib; }

  /** Idempotent import: if the library is empty, seed it from the ACQ-100 corpus. */
  async function ensureSeeded(corpusJourneys) {
    const lib = await loadLibrary();
    if (lib.journeys && lib.journeys.length) return { seeded: false, count: lib.journeys.length };
    lib.journeys = corpusJourneys.map((j) => toLibraryJourney(j, iso()));
    await saveLibrary(lib);
    return { seeded: true, count: lib.journeys.length };
  }

  function find(lib, id) { return lib.journeys.find((j) => j.journeyId === id) || null; }
  function notFound() { const e = new Error('not found'); e.code = 'NOT_FOUND'; return e; }
  /**
   * Optimistic concurrency for the single-document library: when the caller passes the record's
   * last-seen `updatedAt`, refuse the write if the record has moved on since (STALE → HTTP 409).
   * Omitting it keeps the previous last-writer-wins behaviour (older clients, scripts).
   */
  function checkPrecondition(j, opts) {
    const expected = opts && opts.expectedUpdatedAt;
    if (expected == null || expected === '') return;
    if (String(j.updatedAt || '') !== String(expected)) {
      const e = new Error('stale: scenario changed since it was loaded'); e.code = 'STALE'; e.updatedAt = j.updatedAt || null; throw e;
    }
  }

  async function getJourney(id) { const lib = await loadLibrary(); return find(lib, id); }

  function eligiblePool(lib, filters) {
    const f = filters || {};
    return lib.journeys.filter((j) => {
      if (j.archived) return false;
      // default pool = APPROVED + enabled unless includeDrafts explicitly set
      if (!f.includeDrafts && (j.reviewStatus !== 'APPROVED' || !j.enabled)) return false;
      if (f.reviewStatus && j.reviewStatus !== f.reviewStatus) return false;
      if (f.families && f.families.length && f.families.indexOf(j.family) === -1) return false;
      if (f.difficulties && f.difficulties.length && f.difficulties.indexOf(j.difficulty) === -1) return false;
      if (f.categories && f.categories.length && !j.categories.some((c) => f.categories.indexOf(c) !== -1)) return false;
      if (f.multiTurn === true && !j.multiTurn) return false;
      if (f.multiTurn === false && j.multiTurn) return false;
      return true;
    });
  }

  function listJourneys(lib, filters) {
    const f = filters || {};
    let js = lib.journeys.slice();
    if (!f.includeArchived) js = js.filter((j) => !j.archived);
    if (f.reviewStatus) js = js.filter((j) => j.reviewStatus === f.reviewStatus);
    if (f.family) js = js.filter((j) => j.family === f.family);
    if (f.difficulty) js = js.filter((j) => j.difficulty === f.difficulty);
    if (f.category) js = js.filter((j) => j.categories.indexOf(f.category) !== -1);
    if (f.multiTurn != null) js = js.filter((j) => j.multiTurn === f.multiTurn);
    if (f.enabled != null) js = js.filter((j) => j.enabled === f.enabled);
    if (f.source) js = js.filter((j) => j.sourceType === f.source);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      js = js.filter((j) => {
        const v = currentVersionOf(j) || {};
        const hay = [
          j.journeyId, j.title, j.make || '', j.family, (j.categories || []).join(' '),
          v.opening || '', (v.turns || []).join(' '),
        ].join(' ').toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }
    // light summaries for the list view
    return js.map(summariseJourney);
  }

  function metrics(lib) {
    const active = lib.journeys.filter((j) => !j.archived);
    const byFamily = {}; const byCategory = {}; const byReview = {}; const byDifficulty = {};
    let single = 0; let multi = 0;
    for (const j of active) {
      byFamily[j.family] = (byFamily[j.family] || 0) + 1;
      byReview[j.reviewStatus] = (byReview[j.reviewStatus] || 0) + 1;
      byDifficulty[j.difficulty] = (byDifficulty[j.difficulty] || 0) + 1;
      for (const c of j.categories) byCategory[c] = (byCategory[c] || 0) + 1;
      if (j.multiTurn) multi++; else single++;
    }
    const gaps = [];
    for (const c of CATEGORIES) if ((byCategory[c] || 0) < 3) gaps.push({ category: c, count: byCategory[c] || 0 });
    for (const fam of FAMILIES) if ((byFamily[fam] || 0) < 5) gaps.push({ family: fam, count: byFamily[fam] || 0 });
    return {
      total: active.length, archived: lib.journeys.length - active.length,
      approved: byReview.APPROVED || 0, reviewed: byReview.REVIEWED || 0, draft: byReview.DRAFT || 0,
      byFamily, byCategory, byDifficulty, singleTurn: single, multiTurn: multi,
      safety: byCategory.Safety || 0, errorCode: byCategory['Error Code'] || 0, normalBehaviour: byCategory['Normal Behaviour'] || 0,
      coverageGaps: gaps,
    };
  }

  // ---- CRUD (with versioning) ----
  async function createJourney(input, byEmail) {
    const lib = await loadLibrary();
    const id = input.journeyId || genId(lib, input.family);
    if (find(lib, id)) throw new Error('journeyId exists: ' + id);
    const rec = normaliseNewJourney(id, input, iso(), byEmail);
    const problems = validateJourney(rec);
    if (problems.length) { const e = new Error('validation: ' + problems.join('; ')); e.problems = problems; throw e; }
    lib.journeys.push(rec);
    await saveLibrary(lib);
    return rec;
  }

  /**
   * Edit a journey. A change to gold/turns/opening is SEMANTIC and creates a new
   * immutable version (currentVersion++). Metadata-only edits (title, categories,
   * enabled, reviewStatus, make/model) update in place without a new version.
   */
  async function editJourney(id, changes, byEmail, opts) {
    const lib = await loadLibrary();
    const j = find(lib, id);
    if (!j) throw notFound();
    checkPrecondition(j, opts);
    const semantic = changes.gold !== undefined || changes.turns !== undefined || changes.opening !== undefined;
    // metadata
    for (const k of ['title', 'make', 'model', 'reviewStatus', 'enabled', 'sourceType', 'sourceReference', 'transcriptReference', 'categories', 'difficulty']) {
      if (changes[k] !== undefined) j[k] = changes[k];
    }
    if (changes.reviewStatus && REVIEW_STATES.indexOf(changes.reviewStatus) === -1) throw new Error('bad reviewStatus');
    if (semantic) {
      const prev = j.versions[j.versions.length - 1];
      const nextVersion = j.currentVersion + 1;
      const v = {
        version: nextVersion, createdAt: iso(), byEmail: byEmail || null, note: changes.versionNote || 'edited',
        opening: changes.opening !== undefined ? changes.opening : prev.opening,
        turns: changes.turns !== undefined ? cleanTurns(changes.turns) : prev.turns,
        gold: changes.gold !== undefined ? Object.assign({}, prev.gold, changes.gold) : prev.gold,
      };
      j.versions.push(v);
      j.currentVersion = nextVersion;
      const turnN = cleanTurns(v.turns).length;
      j.multiTurn = (v.gold && v.gold.followUpAppropriate === true) || turnN > 1;
    }
    j.updatedAt = iso();
    if (byEmail) j.updatedBy = byEmail;
    const problems = validateJourney(j);
    if (problems.length) { const e = new Error('validation: ' + problems.join('; ')); e.problems = problems; throw e; }
    await saveLibrary(lib);
    return j;
  }

  async function duplicateJourney(id, overrides, byEmail) {
    const lib = await loadLibrary();
    const src = find(lib, id);
    if (!src) throw notFound();
    const newId = (overrides && overrides.journeyId) || genId(lib, src.family);
    if (find(lib, newId)) throw new Error('journeyId exists: ' + newId);
    const srcV = src.versions[src.versions.length - 1];
    const rec = {
      journeyId: newId,
      title: (overrides && overrides.title) || ('Copy of ' + src.title),
      family: (overrides && overrides.family) || src.family,
      make: (overrides && overrides.make) !== undefined ? overrides.make : src.make,
      model: (overrides && overrides.model) !== undefined ? overrides.model : src.model,
      categories: (overrides && overrides.categories) || src.categories.slice(),
      rawTags: src.rawTags ? src.rawTags.slice() : [],
      difficulty: (overrides && overrides.difficulty) || src.difficulty,
      multiTurn: src.multiTurn,
      sourceType: (overrides && overrides.sourceType) || 'AUTHORED',
      sourceReference: 'duplicated:' + id,
      transcriptReference: null,
      reviewStatus: 'DRAFT', enabled: true, archived: false,
      currentVersion: 1, createdAt: iso(), updatedAt: iso(), createdBy: byEmail || null,
      versions: [{ version: 1, createdAt: iso(), byEmail: byEmail || null, note: 'duplicated from ' + id, opening: srcV.opening, turns: srcV.turns.slice(), gold: JSON.parse(JSON.stringify((overrides && overrides.gold) ? Object.assign({}, srcV.gold, overrides.gold) : srcV.gold)) }],
    };
    lib.journeys.push(rec);
    await saveLibrary(lib);
    return rec;
  }

  async function setFlags(id, changes, byEmail, opts) {
    const lib = await loadLibrary(); const j = find(lib, id); if (!j) throw notFound();
    checkPrecondition(j, opts);
    if (changes.enabled != null) j.enabled = !!changes.enabled;
    if (changes.reviewStatus) { if (REVIEW_STATES.indexOf(changes.reviewStatus) === -1) throw new Error('bad reviewStatus'); j.reviewStatus = changes.reviewStatus; }
    if (changes.archived != null) { j.archived = !!changes.archived; if (j.archived) j.reviewStatus = 'ARCHIVED'; }
    j.updatedAt = iso(); if (byEmail) j.updatedBy = byEmail;
    await saveLibrary(lib); return j;
  }

  /**
   * Safe delete: if the journey has EVER been used in a persisted run, it is
   * ARCHIVED (soft) to preserve historical evidence — never hard-deleted. Only a
   * never-run DRAFT can be hard-removed.
   */
  async function safeDelete(id, usedInRun, byEmail, opts) {
    const lib = await loadLibrary(); const j = find(lib, id); if (!j) throw notFound();
    checkPrecondition(j, opts);
    if (usedInRun) { j.archived = true; j.reviewStatus = 'ARCHIVED'; j.enabled = false; j.updatedAt = iso(); if (byEmail) j.updatedBy = byEmail; await saveLibrary(lib); return { deleted: false, archived: true }; }
    lib.journeys = lib.journeys.filter((x) => x.journeyId !== id);
    await saveLibrary(lib);
    return { deleted: true, archived: false };
  }

  return {
    LIBRARY_KEY, loadLibrary, saveLibrary, ensureSeeded, getJourney,
    listJourneys, metrics, eligiblePool,
    createJourney, editJourney, duplicateJourney, setFlags, safeDelete,
  };
}

// ---- selection + manifest ---------------------------------------------------

function currentVersionOf(j) {
  const vs = j && j.versions;
  if (!vs || !vs.length) return null;
  return vs.find((x) => x.version === j.currentVersion) || vs[vs.length - 1];
}
function cleanTurns(arr) {
  return (arr || []).map((t) => String(t == null ? '' : t).trim()).filter(Boolean);
}
function summariseJourney(j) {
  const v = currentVersionOf(j) || {};
  const gold = v.gold || {};
  const turns = cleanTurns(v.turns && v.turns.length ? v.turns : (v.opening ? [v.opening] : []));
  return {
    journeyId: j.journeyId, title: j.title, family: j.family, make: j.make, categories: j.categories,
    difficulty: j.difficulty, multiTurn: j.multiTurn, reviewStatus: j.reviewStatus, enabled: j.enabled,
    archived: !!j.archived, currentVersion: j.currentVersion, sourceType: j.sourceType,
    sourceReference: j.sourceReference || null, updatedAt: j.updatedAt,
    opening: String(v.opening || turns[0] || '').trim(),
    turnCount: Math.max(turns.length, String(v.opening || '').trim() ? 1 : 0),
    expectedOutcome: gold.expectedOutcome || null,
    expectMedia: gold.expectMedia === true,
    mustSafetyStop: gold.mustSafetyStop === true,
    mustNotPart: gold.mustNotPart === true,
  };
}

/** Seeded random selection of N from the eligible pool. */
function selectRandom(pool, n, seed) {
  const shuffled = seededShuffle(pool, seed);
  return (n === 'ALL' || n == null) ? shuffled : shuffled.slice(0, Math.min(n, shuffled.length));
}

/** Expected-outcome of a library journey, read from its CURRENT version's gold (metadata-driven;
 * never a magic journey id). Missing/unknown outcome becomes its own stratum rather than dropped. */
function outcomeKeyOf(j) {
  const vs = j && j.versions;
  if (!vs || !vs.length) return 'UNKNOWN';
  const v = vs.find((x) => x.version === j.currentVersion) || vs[vs.length - 1];
  return (v && v.gold && v.gold.expectedOutcome) || 'UNKNOWN';
}

/** The dimensions BALANCED balances, each read from journey METADATA only (no journey ids). Missing
 * values collapse to an explicit 'UNKNOWN' stratum so a valid journey is never silently discarded. */
const BALANCED_DIMENSIONS = [
  { name: 'family', weight: 1, valueOf: (j) => j.family || 'UNKNOWN' },
  { name: 'difficulty', weight: 1, valueOf: (j) => j.difficulty || 'UNKNOWN' },
  { name: 'turn', weight: 1, valueOf: (j) => (j.multiTurn ? 'MULTI' : 'SINGLE') },
  { name: 'outcome', weight: 1, valueOf: (j) => outcomeKeyOf(j) },
];

/**
 * BALANCED selection — representative stratified sampling across FOUR dimensions at once
 * (appliance family, difficulty, conversation depth, expected outcome), deterministic per seed.
 *
 * Contract (see acceptance): produces a sample whose composition tracks the POOL's proportions on
 * every dimension with anti-starvation for minority strata, while SEED decides WHICH specific
 * journeys fill each stratum (so different seeds materially vary journey identity but not the
 * balance). No duplicates; exactly min(n, pool) selections; graceful with sparse/missing strata.
 *
 * Algorithm: iterative maximum-need (largest proportional deficit) greedy WITHOUT replacement.
 * For each dimension value v present in the pool, target(v) = total * poolCount(v)/poolSize. At each
 * step every not-yet-picked journey is scored by the sum, over its dimension values, of that value's
 * PROPORTIONAL unmet need max(0, (target - selectedSoFar)/target). The journey with the highest
 * score is taken; ties are broken by a SEED-shuffled ordering of the pool. Proportional-deficit
 * scoring keeps each dimension near its pool share and lifts starved minority strata (their need
 * ratio starts at 1.0) without over-weighting large strata (need falls to 0 once the target is met).
 * Chosen over four independent quota selectors because the dimensions are correlated in this corpus
 * (e.g. MEDIUM/HARD are almost all DIAGNOSIS; NORMAL/SAFETY are almost all EASY); a single deficit
 * objective balances them jointly instead of four sorts fighting each other. n=121, so an O(total*pool)
 * greedy is trivial and fully reasoned-about.
 *
 * `opts.categories` is accepted for backwards compatibility but is NOT used for stratification: the
 * eligible pool is already category-filtered upstream (eligiblePool), so the sampler simply balances
 * whatever pool it is given.
 */
function selectBalanced(pool, n, opts) {
  const seed = (opts && opts.seed) != null ? opts.seed : 'balanced';
  const size = pool.length;
  const total = (n === 'ALL' || n == null) ? size : Math.min(n, size);
  if (total <= 0 || size === 0) return [];

  // Seeded ordering: drives identity diversity across seeds AND deterministic tie-breaking.
  const ordered = seededShuffle(pool, seed);

  // Pool counts per dimension value -> proportional targets for a sample of `total`.
  const poolCount = BALANCED_DIMENSIONS.map(() => new Map());
  for (const j of pool) {
    for (let d = 0; d < BALANCED_DIMENSIONS.length; d++) {
      const k = BALANCED_DIMENSIONS[d].valueOf(j);
      poolCount[d].set(k, (poolCount[d].get(k) || 0) + 1);
    }
  }
  const selCount = BALANCED_DIMENSIONS.map(() => new Map());

  const picked = [];
  const usedIds = new Set();
  for (let step = 0; step < total; step++) {
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < ordered.length; i++) {
      const j = ordered[i];
      if (usedIds.has(j.journeyId)) continue;
      let score = 0;
      for (let d = 0; d < BALANCED_DIMENSIONS.length; d++) {
        const dim = BALANCED_DIMENSIONS[d];
        const k = dim.valueOf(j);
        const target = total * (poolCount[d].get(k) / size); // > 0 (value exists in pool)
        const cur = selCount[d].get(k) || 0;
        const need = (target - cur) / target;                // proportional unmet need, <= 1
        if (need > 0) score += dim.weight * need;
      }
      if (score > bestScore) { bestScore = score; best = j; } // strict > => first in seeded order wins ties
    }
    if (!best) break;
    picked.push(best);
    usedIds.add(best.journeyId);
    for (let d = 0; d < BALANCED_DIMENSIONS.length; d++) {
      const k = BALANCED_DIMENSIONS[d].valueOf(best);
      selCount[d].set(k, (selCount[d].get(k) || 0) + 1);
    }
  }
  return picked;
}

/**
 * Freeze a run manifest: pins exact journeyId + version, records selection mode,
 * seed, filters and the library version. Once built, the run pins to this even
 * if the library is later edited.
 */
function buildManifest({ lib, mode, n, filters, seed, manualIds }, libApi) {
  const eligible = libApi.eligiblePool(lib, filters);
  let chosen;
  if (mode === 'MANUAL') {
    const set = new Set(manualIds || []);
    chosen = lib.journeys.filter((j) => set.has(j.journeyId) && !j.archived);
  } else if (mode === 'RANDOM') {
    chosen = selectRandom(eligible, n, seed);
  } else { // BALANCED (default)
    chosen = selectBalanced(eligible, n, { seed, categories: filters && filters.categories });
  }
  const journeys = chosen.map((j) => ({ journeyId: j.journeyId, version: j.currentVersion }));
  return {
    libraryVersion: lib.updatedAt || null,
    librarySchema: lib.schema || LIBRARY_SCHEMA,
    selectionMode: mode,
    seed: (mode === 'RANDOM' || mode === 'BALANCED') ? (seed != null ? seed : null) : null,
    filters: filters || {},
    journeyCount: journeys.length,
    journeys,
  };
}

/** Resolve a frozen manifest against the current library into runnable journeys at pinned versions. */
function resolveManifest(lib, manifest) {
  const byId = {}; for (const j of lib.journeys) byId[j.journeyId] = j;
  const out = [];
  for (const m of (manifest.journeys || [])) {
    const j = byId[m.journeyId]; if (!j) continue;
    const r = resolveVersion(j, m.version); if (r) out.push(r);
  }
  return out;
}

/** Compare two run manifests for like-for-like safety. */
function manifestDiff(manA, manB) {
  const key = (m) => (m.journeyId + '@' + m.version);
  const a = new Set((manA.journeys || []).map(key));
  const b = new Set((manB.journeys || []).map(key));
  const common = [...a].filter((k) => b.has(k));
  const identical = a.size === b.size && common.length === a.size;
  // journeys present in both by id but at a DIFFERENT version (silent-drift risk)
  const aIds = {}; (manA.journeys || []).forEach((m) => { aIds[m.journeyId] = m.version; });
  const versionMismatches = (manB.journeys || []).filter((m) => aIds[m.journeyId] != null && aIds[m.journeyId] !== m.version).map((m) => ({ journeyId: m.journeyId, a: aIds[m.journeyId], b: m.version }));
  return { identical, commonCount: common.length, aCount: a.size, bCount: b.size, versionMismatches, commonKeys: common };
}

// ---- validation + helpers ----------------------------------------------------
const VALID_OUTCOMES = new Set(['DIAGNOSIS', 'NORMAL', 'NO_PART', 'EXTERNAL', 'SAFETY_STOP']);
function validateJourney(rec) {
  const p = [];
  if (!rec.journeyId) p.push('missing journeyId');
  if (FAMILIES.indexOf(rec.family) === -1) p.push('bad family');
  const v = rec.versions[rec.versions.length - 1];
  if (!v) { p.push('no version'); return p; }
  const turns = cleanTurns(v.turns);
  if (!(turns.length && turns[0]) && !String(v.opening || '').trim()) p.push('missing opening turn');
  if (!VALID_OUTCOMES.has(v.gold.expectedOutcome)) p.push('bad expectedOutcome');
  if (v.gold.expectedOutcome === 'DIAGNOSIS' && !(v.gold.goldSuspects && v.gold.goldSuspects.length)) p.push('diagnosis needs goldSuspects');
  if (v.gold.followUpAppropriate === true && !v.gold.followUpTargetFact) p.push('followUp needs followUpTargetFact');
  if (v.gold.idealTurns && v.gold.maxTurns && v.gold.idealTurns > v.gold.maxTurns) p.push('idealTurns > maxTurns');
  return p;
}
function normaliseNewJourney(id, input, isoNow, byEmail) {
  const gold = Object.assign({ expectedOutcome: 'DIAGNOSIS', goldSuspects: [], mustInclude: [], followUpAppropriate: false, followUpTargetFact: null, immediateDiagnosis: true, simulatedAnswers: {}, alreadyKnownFacts: [], alreadyReplaced: [], mustSafetyStop: false, mustNotPart: false, forbiddenOutcomes: [], idealTurns: 1, maxTurns: 4 }, input.gold || {});
  const turns = cleanTurns(input.turns || (input.opening ? [input.opening] : []));
  const opening = String(input.opening || turns[0] || '').trim();
  return {
    journeyId: id, title: input.title || (opening ? opening.slice(0, 70) : id),
    family: input.family, make: input.make || null, model: input.model || gold.lateModel || null,
    categories: input.categories && input.categories.length ? input.categories : ['Straightforward Diagnosis'],
    rawTags: input.rawTags || [], difficulty: input.difficulty || 'MEDIUM',
    multiTurn: gold.followUpAppropriate === true || turns.length > 1,
    sourceType: input.sourceType && SOURCE_TYPES.indexOf(input.sourceType) !== -1 ? input.sourceType : 'AUTHORED',
    sourceReference: input.sourceReference || null, transcriptReference: input.transcriptReference || null,
    reviewStatus: 'DRAFT', enabled: input.enabled !== false, archived: false,
    currentVersion: 1, createdAt: isoNow, updatedAt: isoNow, createdBy: byEmail || null,
    versions: [{ version: 1, createdAt: isoNow, byEmail: byEmail || null, note: 'created', opening: opening, turns: turns.length ? turns : (opening ? [opening] : []), gold }],
  };
}
function genId(lib, family) {
  const prefix = ({ 'washing-machine': 'WM', 'washer-dryer': 'WD', 'tumble-dryer': 'TD', dishwasher: 'DW', 'oven-cooker': 'OV', hobs: 'HB', 'fridge-freezer': 'FF', microwave: 'MW', vacuum: 'VC' })[family] || 'JX';
  let max = 0;
  for (const j of lib.journeys) { const m = new RegExp('^' + prefix + '-(\\d+)$').exec(j.journeyId); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return prefix + '-' + String(max + 1).padStart(3, '0');
}

module.exports = {
  LIBRARY_KEY, LIBRARY_SCHEMA, SOURCE_TYPES, REVIEW_STATES, CATEGORIES, FAMILIES,
  hashSeed, mulberry32, seededShuffle,
  toLibraryJourney, deriveCategories, difficultyOf, resolveVersion, summariseJourney, currentVersionOf, cleanTurns,
  createLibrary, selectRandom, selectBalanced, buildManifest, resolveManifest, manifestDiff,
  validateJourney,
};
