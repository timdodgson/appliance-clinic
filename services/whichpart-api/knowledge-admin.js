'use strict';
/**
 * Admin Knowledge management: drafts, explicit publish, immutable versions, rollback, archive.
 *
 * Storage (LEARNING_BUCKET, prefix knowledge-admin/):
 *   state.json                 admin bookkeeping: per-record drafts, revision counter, version list, archive flag.
 *   versions/<id>/v<N>.json    immutable published versions (content + embedded doc + vector).
 *   published.json             the ACTIVE overlay part-finder merges over its shipped index (docs + vectors,
 *                              archived ids). Only publish / rollback / archive / restore write it.
 *
 * Saving a draft only ever touches state.json, so it cannot change production RAG behaviour.
 * Publishing is the boundary: the doc text is assembled exactly as the offline build does, embedded
 * with the same model as the shipped index, written as an immutable version, then switched live in
 * published.json. The switch is only reported as successful once part-finder confirms it has loaded
 * that overlay version; otherwise the previous live entry is restored and the version file removed.
 *
 * The shipped knowledge-docs.json / knowledge-index.json stay the read-only baseline ("v0").
 * Concurrency: every record carries a revision the client must echo back (expectedRevision), and
 * every S3 write is conditional on the ETag it read (IfMatch / IfNoneMatch).
 */
const crypto = require('crypto');
const knowledgeInspect = require('./knowledge-inspect');

const PREFIX = 'knowledge-admin/';
const STATE_KEY = PREFIX + 'state.json';
// Must match services/part-finder/retrieval.js KNOWLEDGE_OVERLAY_KEY.
const PUBLISHED_KEY = PREFIX + 'published.json';
const STATE_SCHEMA = 'knowledge-admin/1';
const OVERLAY_SCHEMA = 'knowledge-overlay/1';

const FAMILIES = knowledgeInspect.FAMILIES;
const OUTCOMES = ['PART_ROUTING', 'ADVICE_ONLY'];
const PROVENANCE = ['engineer', 'catalogue'];
const COMPONENT_TYPES = ['part', 'check'];
const SAFETY_CLASSES = ['DO_NOT_OPEN', 'STOP_USE', 'EMERGENCY_ACTION', 'MAINTENANCE_SAFETY'];
const FAULT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX = { label: 160, item: 2000, list: 100, question: 600, note: 300 };

function versionKey(id, n) {
  return PREFIX + 'versions/' + encodeURIComponent(id) + '/v' + n + '.json';
}

function err(code, message, status, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = status || 400;
  if (extra) e.extra = extra;
  return e;
}

function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

// ---------------------------------------------------------------------------------------------
// Text assembly — a byte-identical port of services/part-finder/knowledge/build-knowledge.mjs
// assembleText(). The embedded body must match the offline build or retrieval would score a
// published record differently from a shipped one. Parity is asserted in the test-suite.
// ---------------------------------------------------------------------------------------------
const titleCase = (s) => s.replace(/-/g, ' ');
function assembleText(d) {
  const parts = [];
  parts.push(`Appliance: ${titleCase(d.applianceFamily)}`);
  parts.push(`Fault: ${d.label}`);
  if (d.symptoms && d.symptoms.length) parts.push(`Customer phrases: ${d.symptoms.join('; ')}`);
  if (d.components && d.components.length) {
    const hasTypes = d.components.some((c) => c.type);
    const header = hasTypes
      ? 'Candidate causes in initial diagnostic order (re-rank by the evidence below, do not treat the order as fixed). CHECK = a condition to inspect/clean/clear first, not automatically a part to sell; PART = a replacement component:'
      : 'Candidate causes in initial diagnostic order (re-rank by the evidence below, do not treat the order as fixed):';
    const lines = [header];
    d.components.forEach((c, i) => {
      const tag = c.type ? ` [${String(c.type).toUpperCase()}]` : '';
      lines.push(`${i + 1}. ${c.name}${tag}`);
      if (c.supports && c.supports.length) lines.push(`   More likely if: ${c.supports.join('; ')}.`);
      if (c.against && c.against.length) lines.push(`   Less likely if: ${c.against.join('; ')}.`);
    });
    parts.push(lines.join('\n'));
  }
  if (d.commonConfusion && d.commonConfusion.length) {
    const lines = ['Common confusion — semantically related but NOT a leading cause for this symptom unless the stated evidence is present; do not surface these first without it:'];
    for (const c of d.commonConfusion) {
      const bits = [`- ${c.name}`];
      if (c.note) bits.push(c.note);
      lines.push(bits.join(': '));
      if (c.wouldApplyIf && c.wouldApplyIf.length) lines.push(`   Only consider if: ${c.wouldApplyIf.join('; ')}.`);
    }
    parts.push(lines.join('\n'));
  }
  if (d.discriminators && d.discriminators.length) parts.push(`Engineering notes: ${d.discriminators.join(' ')}`);
  if (d.likelyComponents && d.likelyComponents.length) parts.push(`Likely parts in order: ${d.likelyComponents.join(', ')}`);
  if (d.alternatives && d.alternatives.length) parts.push(`Confused with: ${d.alternatives.join(', ')}`);
  const advice = (d.adviceBeforeReplacement && d.adviceBeforeReplacement.length) ? d.adviceBeforeReplacement : d.checks;
  if (advice && advice.length) parts.push(`Advice before replacing parts: ${advice.join('; ')}`);
  if (d.clarifyingQuestion) parts.push(`Best question to ask if unsure: ${d.clarifyingQuestion}`);
  if (d.secondaryQuestion) parts.push(`Follow-up question if still unclear: ${d.secondaryQuestion}`);
  return parts.join('\n');
}

// Same derivation the offline build applies to typed components (physical part where present;
// pure CHECKs are not purchasable parts).
function deriveLikelyComponents(components) {
  const list = components || [];
  const typed = list.some((c) => c.type || c.partName);
  const names = typed
    ? list.filter((c) => c.type === 'part' || c.partName).map((c) => c.partName || c.name)
    : list.map((c) => c.name);
  return Array.from(new Set(names.filter(Boolean)));
}

// ---------------------------------------------------------------------------------------------
// Editable content: the structured fields an admin can change. Identity (applianceFamily,
// faultId, knowledgeId) is fixed at creation. make/platform/componentFamilies/checks are preserved.
// ---------------------------------------------------------------------------------------------
function editableFrom(doc, safety) {
  if (!doc) return null;
  const si = safety !== undefined ? safety : (doc.safetyInformation || null);
  return {
    knowledgeId: doc.knowledgeId,
    applianceFamily: doc.applianceFamily,
    faultId: doc.faultId,
    label: doc.label || '',
    outcome: doc.outcome || 'PART_ROUTING',
    provenance: typeof doc.provenance === 'string' ? doc.provenance : 'engineer',
    symptoms: (doc.symptoms || []).slice(),
    components: (doc.components || []).map((c) => ({
      name: c.name || '',
      type: c.type || null,
      partName: c.partName || null,
      supports: (c.supports || []).slice(),
      against: (c.against || []).slice(),
    })),
    likelyComponents: (doc.likelyComponents || []).slice(),
    discriminators: (doc.discriminators || []).slice(),
    clarifyingQuestion: doc.clarifyingQuestion || null,
    secondaryQuestion: doc.secondaryQuestion || null,
    adviceBeforeReplacement: (doc.adviceBeforeReplacement || []).slice(),
    commonConfusion: (doc.commonConfusion || []).map((c) => ({
      name: c.name || '',
      note: c.note || null,
      wouldApplyIf: (c.wouldApplyIf || []).slice(),
    })),
    alternatives: (doc.alternatives || []).slice(),
    safetyInformation: si ? clone(si) : null,
    make: doc.make || null,
    platform: doc.platform || null,
    componentFamilies: (doc.componentFamilies || []).slice(),
    checks: (doc.checks || []).slice(),
  };
}

// --- validation -------------------------------------------------------------------------------
function makeValidator() {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  function str(v, field, max, opts) {
    opts = opts || {};
    if (v == null || v === '') {
      if (opts.required) add(field, opts.requiredMessage || 'Required');
      return opts.nullable ? null : '';
    }
    if (typeof v !== 'string') { add(field, 'Must be text'); return opts.nullable ? null : ''; }
    const t = v.trim();
    if (!t) {
      if (opts.required) add(field, opts.requiredMessage || 'Required');
      return opts.nullable ? null : '';
    }
    if (t.length > max) add(field, 'Too long (max ' + max + ' characters)');
    return t;
  }
  // List of strings: blank rows are dropped. Duplicates are only removed where the offline build
  // removes them (symptoms) so an unchanged record reproduces its shipped text exactly.
  function list(v, field, max, opts) {
    opts = opts || {};
    if (v == null) v = [];
    if (!Array.isArray(v)) { add(field, 'Must be a list'); return []; }
    const out = [];
    v.forEach((x, i) => {
      if (x == null || (typeof x === 'string' && !x.trim())) return;
      if (typeof x !== 'string') { add(field + '[' + i + ']', 'Must be text'); return; }
      const t = x.trim();
      if (t.length > (max || MAX.item)) add(field + '[' + i + ']', 'Too long (max ' + (max || MAX.item) + ' characters)');
      if (!opts.dedupe || out.indexOf(t) === -1) out.push(t);
    });
    if (out.length > MAX.list) add(field, 'Too many entries (max ' + MAX.list + ')');
    if (opts.min && out.length < opts.min) add(field, opts.minMessage || ('Add at least ' + opts.min));
    return out;
  }
  return { errors, add, str, list };
}

/**
 * Normalise + validate editable content.
 * mode 'draft'   — structural checks only (incomplete drafts are fine).
 * mode 'publish' — everything production needs (symptoms, sourced safety, resolvable related topics).
 * ctx.knownIds   — Set of live knowledge ids (for related-topic resolution at publish).
 */
function validateContent(input, mode, ctx) {
  ctx = ctx || {};
  const strict = mode === 'publish';
  const V = makeValidator();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw err('validation', 'Knowledge content must be an object', 400, { errors: [{ field: '', message: 'Must be an object' }] });
  }
  const family = String(input.applianceFamily || '').trim();
  if (FAMILIES.indexOf(family) === -1) V.add('applianceFamily', 'Choose a supported appliance');
  const faultId = String(input.faultId || '').trim();
  if (!FAULT_ID_RE.test(faultId)) V.add('faultId', 'Use lower-case letters, digits and hyphens (2–64 characters)');
  const knowledgeId = family + ':' + faultId;

  const out = {
    knowledgeId,
    applianceFamily: family,
    faultId,
    label: V.str(input.label, 'label', MAX.label, { required: true, requiredMessage: 'Add a topic label' }),
    outcome: input.outcome || 'PART_ROUTING',
    provenance: input.provenance || 'engineer',
    symptoms: V.list(input.symptoms, 'symptoms', MAX.item, strict ? { min: 1, minMessage: 'Add at least one customer symptom', dedupe: true } : { dedupe: true }),
    components: [],
    likelyComponents: V.list(input.likelyComponents, 'likelyComponents', MAX.label),
    discriminators: V.list(input.discriminators, 'discriminators'),
    clarifyingQuestion: V.str(input.clarifyingQuestion, 'clarifyingQuestion', MAX.question, { nullable: true }),
    secondaryQuestion: V.str(input.secondaryQuestion, 'secondaryQuestion', MAX.question, { nullable: true }),
    adviceBeforeReplacement: V.list(input.adviceBeforeReplacement, 'adviceBeforeReplacement'),
    commonConfusion: [],
    alternatives: V.list(input.alternatives, 'alternatives', 140),
    safetyInformation: null,
    make: input.make || null,
    platform: input.platform || null,
    componentFamilies: Array.isArray(input.componentFamilies) ? input.componentFamilies.filter((x) => typeof x === 'string' && x.trim()) : [],
    checks: Array.isArray(input.checks) ? input.checks.filter((x) => typeof x === 'string' && x.trim()) : [],
  };
  if (OUTCOMES.indexOf(out.outcome) === -1) V.add('outcome', 'Choose Part routing or Advice only');
  if (PROVENANCE.indexOf(out.provenance) === -1) V.add('provenance', 'Choose a provenance');

  if (input.components != null && !Array.isArray(input.components)) V.add('components', 'Must be a list');
  (Array.isArray(input.components) ? input.components : []).forEach((c, i) => {
    const f = 'components[' + i + ']';
    if (!c || typeof c !== 'object') { V.add(f, 'Must be an object'); return; }
    const blank = !String(c.name || '').trim() && !String(c.partName || '').trim()
      && !(c.supports || []).some((x) => String(x || '').trim()) && !(c.against || []).some((x) => String(x || '').trim());
    if (blank) return; // empty editor row
    const type = c.type == null || c.type === '' ? null : c.type;
    if (type !== null && COMPONENT_TYPES.indexOf(type) === -1) V.add(f + '.type', 'Type must be Part or Check');
    out.components.push({
      name: V.str(c.name, f + '.name', MAX.label, { required: true, requiredMessage: 'Name the cause or component' }),
      type,
      partName: V.str(c.partName, f + '.partName', MAX.label, { nullable: true }),
      supports: V.list(c.supports, f + '.supports'),
      against: V.list(c.against, f + '.against'),
    });
  });
  if (out.components.length > MAX.list) V.add('components', 'Too many components');

  if (input.commonConfusion != null && !Array.isArray(input.commonConfusion)) V.add('commonConfusion', 'Must be a list');
  (Array.isArray(input.commonConfusion) ? input.commonConfusion : []).forEach((c, i) => {
    const f = 'commonConfusion[' + i + ']';
    if (!c || typeof c !== 'object') { V.add(f, 'Must be an object'); return; }
    const blank = !String(c.name || '').trim() && !String(c.note || '').trim()
      && !(c.wouldApplyIf || []).some((x) => String(x || '').trim());
    if (blank) return;
    out.commonConfusion.push({
      name: V.str(c.name, f + '.name', MAX.label, { required: true, requiredMessage: 'Name the confused component' }),
      note: V.str(c.note, f + '.note', MAX.item, { nullable: true }),
      wouldApplyIf: V.list(c.wouldApplyIf, f + '.wouldApplyIf'),
    });
  });

  // Related topics: either a faultId in the same appliance or a full knowledge id.
  out.alternatives.forEach((a, i) => {
    const id = a.indexOf(':') !== -1 ? a : (family + ':' + a);
    if (id === knowledgeId) V.add('alternatives[' + i + ']', 'A topic cannot be related to itself');
    else if (strict && ctx.knownIds && !ctx.knownIds.has(id)) V.add('alternatives[' + i + ']', 'Unknown related topic “' + a + '”');
  });

  const si = input.safetyInformation;
  if (si != null && si !== '') {
    if (typeof si !== 'object' || Array.isArray(si)) V.add('safetyInformation', 'Must be an object');
    else out.safetyInformation = validateSafety(si, V, strict);
  }

  return { content: out, errors: V.errors };
}

// Mirrors build-knowledge.mjs validateSafetyInformation: every customer safety statement must carry
// pre-written text, hazard, class, applicability and at least one sourced provenance entry.
function validateSafety(si, V, strict) {
  const f = 'safetyInformation';
  const opt = (field, msg) => ({ required: strict, requiredMessage: msg, nullable: !strict });
  const out = {
    text: V.str(si.text, f + '.text', 1200, opt(null, 'Add the customer safety text')) || '',
    hazard: V.str(si.hazard, f + '.hazard', MAX.item, opt(null, 'Describe the hazard')) || '',
    classification: si.classification || '',
    applicability: V.str(si.applicability, f + '.applicability', MAX.item, opt(null, 'Say when this applies')) || '',
    provenance: [],
  };
  if (out.classification && SAFETY_CLASSES.indexOf(out.classification) === -1) V.add(f + '.classification', 'Choose a safety class');
  if (strict && !out.classification) V.add(f + '.classification', 'Choose a safety class');
  const prov = Array.isArray(si.provenance) ? si.provenance : [];
  if (si.provenance != null && !Array.isArray(si.provenance)) V.add(f + '.provenance', 'Must be a list');
  prov.forEach((p, i) => {
    const pf = f + '.provenance[' + i + ']';
    if (!p || typeof p !== 'object') { V.add(pf, 'Must be an object'); return; }
    const blank = ['sourceType', 'publisher', 'title', 'section', 'url', 'retrieved'].every((k) => !String(p[k] || '').trim());
    if (blank) return;
    const entry = {
      sourceType: V.str(p.sourceType, pf + '.sourceType', MAX.label, { required: true, requiredMessage: 'Source type required' }),
      publisher: V.str(p.publisher, pf + '.publisher', MAX.label, { required: true, requiredMessage: 'Publisher required' }),
      title: V.str(p.title, pf + '.title', MAX.item, { nullable: true }),
    };
    const section = V.str(p.section, pf + '.section', MAX.item, { nullable: true });
    if (section) entry.section = section;
    entry.url = V.str(p.url, pf + '.url', 1000, { required: true, requiredMessage: 'Source URL required' });
    if (entry.url && !/^https?:\/\//i.test(entry.url)) V.add(pf + '.url', 'Use an http(s) URL');
    entry.retrieved = V.str(p.retrieved, pf + '.retrieved', 40, { nullable: true });
    out.provenance.push(entry);
  });
  if (strict && !out.provenance.length) V.add(f + '.provenance', 'Safety information needs at least one source');
  return out;
}

// The doc part-finder serves (same shape as a shipped index doc, minus the vector).
function buildPublishedDoc(content, docsVersion) {
  const c = content;
  const likely = c.likelyComponents && c.likelyComponents.length ? c.likelyComponents.slice() : deriveLikelyComponents(c.components);
  const doc = {
    knowledgeId: c.knowledgeId,
    version: docsVersion || '1.0.0',
    applianceFamily: c.applianceFamily,
    faultId: c.faultId,
    make: c.make || null,
    platform: c.platform || null,
    label: c.label,
    outcome: c.outcome || 'PART_ROUTING',
    componentFamilies: (c.componentFamilies || []).slice(),
    likelyComponents: likely,
    symptoms: c.symptoms.slice(),
    discriminators: c.discriminators.slice(),
    alternatives: c.alternatives.slice(),
    clarifyingQuestion: c.clarifyingQuestion || null,
    checks: (c.checks || []).slice(),
    provenance: c.provenance,
    components: c.components.map((x) => {
      const o = { name: x.name };
      if (x.type) o.type = x.type;
      if (x.partName) o.partName = x.partName;
      o.supports = x.supports.slice();
      o.against = x.against.slice();
      return o;
    }),
    commonConfusion: c.commonConfusion.map((x) => {
      const o = { name: x.name };
      if (x.note) o.note = x.note;
      o.wouldApplyIf = x.wouldApplyIf.slice();
      return o;
    }),
    secondaryQuestion: c.secondaryQuestion || null,
    adviceBeforeReplacement: c.adviceBeforeReplacement.slice(),
  };
  doc.text = assembleText(doc);
  return doc;
}

// Field-level summary of what a publish would change (used by the confirm dialog + audit).
const DIFF_FIELDS = [
  'label', 'outcome', 'provenance', 'symptoms', 'components', 'likelyComponents', 'discriminators',
  'clarifyingQuestion', 'secondaryQuestion', 'adviceBeforeReplacement', 'commonConfusion', 'alternatives',
  'safetyInformation',
];
function diffContent(before, after) {
  if (!before) return []; // nothing live yet: a first publish adds the whole topic
  const norm = (v) => (v == null || v === '' || (Array.isArray(v) && !v.length) ? null : v);
  const changed = [];
  DIFF_FIELDS.forEach((k) => {
    const a = JSON.stringify(norm(before[k]));
    const b = JSON.stringify(norm(after ? after[k] : null));
    if (a !== b) changed.push(k);
  });
  return changed;
}

function emptyState() { return { schema: STATE_SCHEMA, updatedAt: null, records: {} }; }
function emptyOverlay() { return { schema: OVERLAY_SCHEMA, version: 0, updatedAt: null, docs: {}, archived: [] }; }

function statusFor(rec, hasBaseline, live) {
  const archived = !!(rec && rec.archived);
  const currentVersion = (rec && rec.currentVersion) || 0;
  const published = hasBaseline || currentVersion > 0 || !!live;
  const draftPending = !!(rec && rec.draft);
  let state = 'published';
  let label = 'Published';
  if (archived) { state = 'archived'; label = 'Archived'; }
  else if (!published) { state = 'draft'; label = 'Draft'; }
  else if (draftPending) { label = 'Draft changes pending'; }
  return {
    state, stateLabel: label, draftPending, archived, everPublished: published,
    currentVersion,
    liveVersionLabel: currentVersion > 0 ? 'v' + currentVersion : (hasBaseline ? 'Baseline (shipped)' : null),
    revision: (rec && rec.revision) || 0,
  };
}

/**
 * deps:
 *   s3: { get(key) -> {body, etag}|null, put(key, body, {ifMatch, ifNoneMatch}) -> {etag}, del(key) }
 *       put must throw an error with code 'precondition' when a condition fails.
 *   embed(text) -> Promise<number[]>
 *   engineHealth() -> Promise<object|null>   (part-finder GET /health JSON)
 *   now(), sleep(ms), confirmTimeoutMs, confirmIntervalMs, log
 */
function createStore(deps) {
  deps = deps || {};
  const s3 = deps.s3;
  const now = deps.now || (() => new Date());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || (() => {});
  const confirmTimeoutMs = deps.confirmTimeoutMs != null ? deps.confirmTimeoutMs : 15000;
  const confirmIntervalMs = deps.confirmIntervalMs != null ? deps.confirmIntervalMs : 1500;

  function corpus() { return knowledgeInspect.loadCorpus(); }
  function baselineDoc(id) { return corpus().docs.find((d) => d.knowledgeId === id) || null; }
  function baselineEditable(id) {
    const d = baselineDoc(id);
    if (!d) return null;
    const si = corpus().safetyById[id] || d.safetyInformation || null;
    return editableFrom(d, si);
  }
  function indexModel() {
    const meta = corpus().indexMeta || {};
    return { embedModel: meta.embedModel || 'text-embedding-nomic-embed-text-v1.5', dims: meta.dims || 768 };
  }
  function iso() { return now().toISOString(); }
  function actorOf(a) { return (a && (a.email || a.username)) || 'admin'; }

  async function readJson(key, empty) {
    let r;
    try { r = await s3.get(key); } catch (e) { throw err('store', 'Knowledge store unavailable', 503); }
    if (!r || r.body == null || r.body === '') return { doc: empty ? empty() : null, etag: null, exists: false };
    let doc;
    try { doc = JSON.parse(r.body); } catch { throw err('store', 'Knowledge store is unreadable', 503); }
    return { doc, etag: r.etag || null, exists: true };
  }

  // Read-modify-write with a conditional put; retries when another writer got there first.
  async function mutate(key, empty, fn, tries) {
    tries = tries || 4;
    for (let i = 0; i < tries; i++) {
      const cur = await readJson(key, empty);
      const before = clone(cur.doc);
      const working = clone(cur.doc);
      const result = await fn(working, before);
      try {
        const res = await s3.put(key, JSON.stringify(working), cur.exists ? { ifMatch: cur.etag } : { ifNoneMatch: '*' });
        return { before, after: working, result, etag: res && res.etag };
      } catch (e) {
        if (e && e.code === 'precondition') continue;
        throw err('store', 'Knowledge store write failed', 503);
      }
    }
    throw err('conflict', 'The knowledge store changed while saving. Please try again.', 409);
  }

  function checkRevision(rec, expectedRevision) {
    const have = (rec && rec.revision) || 0;
    if (expectedRevision == null || Number(expectedRevision) !== have) {
      throw err('conflict', 'This record was changed by someone else. Reload to see the latest version.', 409, { revision: have });
    }
  }

  async function loadAll() {
    const st = await readJson(STATE_KEY, emptyState);
    const pub = await readJson(PUBLISHED_KEY, emptyOverlay);
    return { state: st.doc, overlay: pub.doc };
  }

  function knownIds(state, overlay) {
    const ids = new Set(corpus().docs.map((d) => d.knowledgeId));
    Object.keys((overlay && overlay.docs) || {}).forEach((id) => ids.add(id));
    return ids;
  }

  function liveEditable(id, overlay) {
    const live = overlay && overlay.docs && overlay.docs[id];
    if (live) return live.content ? clone(live.content) : editableFrom(live, live.safetyInformation || null);
    return baselineEditable(id);
  }

  function viewOf(id, state, overlay) {
    const rec = state.records[id] || null;
    const hasBaseline = !!baselineDoc(id);
    const live = overlay.docs && overlay.docs[id];
    if (!rec && !hasBaseline && !live) return null;
    const status = statusFor(rec, hasBaseline, live);
    const versions = ((rec && rec.versions) || []).slice().sort((a, b) => b.version - a.version);
    if (hasBaseline) versions.push({ version: 0, source: 'baseline', label: 'Baseline (shipped)', publishedAt: null, publishedBy: null });
    const liveContent = status.everPublished ? liveEditable(id, overlay) : null;
    return Object.assign(status, {
      knowledgeId: id,
      origin: rec ? rec.origin : 'baseline',
      hasBaseline,
      liveSource: live ? 'overlay' : (hasBaseline ? 'baseline' : null),
      overlayVersion: overlay.version || 0,
      draft: rec && rec.draft ? clone(rec.draft) : null,
      draftUpdatedAt: (rec && rec.draftUpdatedAt) || null,
      draftUpdatedBy: (rec && rec.draftUpdatedBy) || null,
      draftBaseVersion: rec && rec.draft ? (rec.draftBaseVersion || 0) : null,
      live: liveContent,
      pendingChanges: rec && rec.draft ? diffContent(liveContent, rec.draft) : [],
      archivedAt: (rec && rec.archivedAt) || null,
      archivedBy: (rec && rec.archivedBy) || null,
      createdAt: (rec && rec.createdAt) || null,
      createdBy: (rec && rec.createdBy) || null,
      createdFrom: (rec && rec.createdFrom) || null,
      versions,
      canDelete: !!rec && !status.everPublished && !(rec.versions || []).length,
      canPublish: !!(rec && rec.draft) && !status.archived,
      canArchive: status.everPublished && !status.archived,
      canRestore: status.archived,
      canRollback: status.everPublished && !status.archived && !(rec && rec.draft) && versions.length > 1,
    });
  }

  // ---------------------------------------------------------------- reads
  async function getView(id) {
    const { state, overlay } = await loadAll();
    const v = viewOf(id, state, overlay);
    if (!v) throw err('not_found', 'Knowledge record not found', 404);
    return v;
  }

  // Everything knowledge-inspect needs to show drafts / published overlay / archive state.
  async function inspectView() {
    const { state, overlay } = await loadAll();
    const records = {};
    const ids = new Set(Object.keys(state.records).concat(Object.keys(overlay.docs || {})));
    (overlay.archived || []).forEach((id) => ids.add(id));
    ids.forEach((id) => {
      const rec = state.records[id] || null;
      const st = statusFor(rec, !!baselineDoc(id), overlay.docs && overlay.docs[id]);
      if (overlay.archived && overlay.archived.indexOf(id) !== -1) { st.state = 'archived'; st.stateLabel = 'Archived'; st.archived = true; }
      records[id] = Object.assign(st, { draft: rec && rec.draft ? clone(rec.draft) : null });
    });
    const published = {};
    Object.keys(overlay.docs || {}).forEach((id) => {
      const d = Object.assign({}, overlay.docs[id]);
      delete d.vector;
      delete d.content;
      published[id] = d;
    });
    return { overlayVersion: overlay.version || 0, overlayUpdatedAt: overlay.updatedAt || null, published, archived: overlay.archived || [], records };
  }

  async function listVersions(id) {
    const v = await getView(id);
    return { knowledgeId: id, currentVersion: v.currentVersion, liveVersionLabel: v.liveVersionLabel, versions: v.versions, state: v.state, stateLabel: v.stateLabel, revision: v.revision, archived: v.archived, draftPending: v.draftPending };
  }

  async function getVersion(id, n) {
    n = Number(n);
    if (!Number.isInteger(n) || n < 0) throw err('validation', 'Invalid version', 400);
    if (n === 0) {
      const content = baselineEditable(id);
      if (!content) throw err('not_found', 'No baseline version for this record', 404);
      const d = baselineDoc(id);
      return { knowledgeId: id, version: 0, source: 'baseline', label: 'Baseline (shipped)', content, text: d.text || null };
    }
    const r = await readJson(versionKey(id, n));
    if (!r.doc) throw err('not_found', 'Version not found', 404);
    const out = clone(r.doc);
    const text = out.doc && out.doc.text;
    delete out.vector;
    delete out.doc;
    out.text = text || null;
    return out;
  }

  // ---------------------------------------------------------------- drafts (never touch published.json)
  // opts.createdFrom: "Duplicate as new draft" — the source id is recorded as provenance only
  // (no version/history relationship; the new record starts unpublished at v0).
  async function createDraft(input, actor, opts) {
    const { content, errors } = validateContent(input, 'draft');
    if (errors.length) throw err('validation', 'Please fix the highlighted fields', 400, { errors });
    const id = content.knowledgeId;
    if (baselineDoc(id)) throw err('exists', 'A knowledge record with this id already exists', 409);
    let createdFrom = null;
    if (opts && opts.createdFrom) {
      const src = String(opts.createdFrom);
      const { state, overlay } = await loadAll();
      const srcView = viewOf(src, state, overlay);
      if (!srcView) throw err('validation', 'The record you duplicated from no longer exists', 400, { errors: [{ field: 'createdFrom', message: 'Unknown source record' }] });
      createdFrom = { knowledgeId: src, version: srcView.liveVersionLabel || null };
    }
    const at = iso();
    await mutate(STATE_KEY, emptyState, (s) => {
      if (s.records[id]) throw err('exists', 'A knowledge record with this id already exists', 409);
      s.records[id] = {
        knowledgeId: id, origin: 'admin', revision: 1, currentVersion: 0, versions: [],
        draft: content, draftBaseVersion: 0, draftUpdatedAt: at, draftUpdatedBy: actorOf(actor),
        archived: false, createdAt: at, createdBy: actorOf(actor),
      };
      if (createdFrom) s.records[id].createdFrom = createdFrom;
      s.updatedAt = at;
    });
    log({ evt: 'knowledge-draft-created', id, by: actorOf(actor), createdFrom: createdFrom && createdFrom.knowledgeId });
    return getView(id);
  }

  // Start a draft from the current live content (no-op content change if one already exists).
  async function startDraft(id, expectedRevision, actor) {
    const { overlay } = await loadAll();
    const at = iso();
    await mutate(STATE_KEY, emptyState, (s) => {
      let rec = s.records[id];
      if (!rec && !baselineDoc(id)) throw err('not_found', 'Knowledge record not found', 404);
      checkRevision(rec, expectedRevision);
      if (rec && rec.draft) throw err('draft_exists', 'A draft already exists for this record', 409, { revision: rec.revision });
      if (rec && rec.archived) throw err('invalid_state', 'Restore this record before editing it', 409);
      if (!rec) rec = s.records[id] = { knowledgeId: id, origin: 'baseline', revision: 0, currentVersion: 0, versions: [], archived: false, createdAt: at, createdBy: actorOf(actor) };
      const live = liveEditable(id, overlay);
      if (!live) throw err('not_found', 'Nothing to copy into a draft', 404);
      rec.draft = live;
      rec.draftBaseVersion = rec.currentVersion || 0;
      rec.draftUpdatedAt = at;
      rec.draftUpdatedBy = actorOf(actor);
      rec.revision = (rec.revision || 0) + 1;
      s.updatedAt = at;
    });
    return getView(id);
  }

  async function saveDraft(id, expectedRevision, input, actor) {
    if (!input || typeof input !== 'object') throw err('validation', 'Draft content required', 400);
    const [family, faultId] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    if ((input.applianceFamily && input.applianceFamily !== family) || (input.faultId && input.faultId !== faultId)) {
      throw err('validation', 'Appliance and faultId cannot be changed after creation', 400,
        { errors: [{ field: 'faultId', message: 'Identity is fixed after creation' }] });
    }
    const { content, errors } = validateContent(Object.assign({}, input, { applianceFamily: family, faultId }), 'draft');
    if (errors.length) throw err('validation', 'Please fix the highlighted fields', 400, { errors });
    const at = iso();
    await mutate(STATE_KEY, emptyState, (s) => {
      let rec = s.records[id];
      if (!rec && !baselineDoc(id)) throw err('not_found', 'Knowledge record not found', 404);
      checkRevision(rec, expectedRevision);
      if (rec && rec.archived) throw err('invalid_state', 'Restore this record before editing it', 409);
      if (!rec) rec = s.records[id] = { knowledgeId: id, origin: 'baseline', revision: 0, currentVersion: 0, versions: [], archived: false, createdAt: at, createdBy: actorOf(actor) };
      if (!rec.draft) rec.draftBaseVersion = rec.currentVersion || 0;
      rec.draft = content;
      rec.draftUpdatedAt = at;
      rec.draftUpdatedBy = actorOf(actor);
      rec.revision = (rec.revision || 0) + 1;
      s.updatedAt = at;
    });
    return getView(id);
  }

  // Never-published draft → hard delete the record. Published record → discard the pending draft only.
  async function deleteDraft(id, expectedRevision, actor) {
    const { overlay } = await loadAll();
    let deleted = false;
    await mutate(STATE_KEY, emptyState, (s) => {
      const rec = s.records[id];
      if (!rec) throw err('not_found', 'No draft for this record', 404);
      checkRevision(rec, expectedRevision);
      const everPublished = !!baselineDoc(id) || (rec.currentVersion || 0) > 0 || (rec.versions || []).length > 0
        || !!(overlay.docs && overlay.docs[id]);
      if (!everPublished) { delete s.records[id]; deleted = true; }
      else {
        if (!rec.draft) throw err('invalid_state', 'There is no pending draft to discard', 409);
        rec.draft = null; rec.draftBaseVersion = null; rec.draftUpdatedAt = null; rec.draftUpdatedBy = null;
        rec.revision = (rec.revision || 0) + 1;
      }
      s.updatedAt = iso();
    });
    log({ evt: deleted ? 'knowledge-draft-deleted' : 'knowledge-draft-discarded', id, by: actorOf(actor) });
    if (deleted) return { knowledgeId: id, deleted: true };
    return getView(id);
  }

  // Read-only readiness check: the SAME publish validation publish() runs, over unsaved editor content.
  // Never writes. For a new record (no id yet) it also reports an id that is already taken.
  async function checkDraft(input, id) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw err('validation', 'Content required', 400);
    const { state, overlay } = await loadAll();
    let content = input;
    if (id) {
      const i = id.indexOf(':');
      content = Object.assign({}, input, { applianceFamily: id.slice(0, i), faultId: id.slice(i + 1) });
    }
    const { errors } = validateContent(content, 'publish', { knownIds: knownIds(state, overlay) });
    if (!id) {
      const newId = String(content.applianceFamily || '') + ':' + String(content.faultId || '');
      if (baselineDoc(newId) || state.records[newId] || (overlay.docs && overlay.docs[newId])) {
        errors.push({ field: 'faultId', message: 'A knowledge record with this id already exists' });
      }
    }
    return { ready: errors.length === 0, errors };
  }

  // ---------------------------------------------------------------- live changes
  async function embedDoc(text) {
    const model = indexModel();
    if (typeof deps.embed !== 'function') throw err('embed_failed', 'Embedding service is not configured; nothing was published', 502);
    let vec;
    try { vec = await deps.embed(text, model.embedModel); }
    catch (e) { throw err('embed_failed', 'Could not embed the knowledge text; nothing was published', 502); }
    if (!Array.isArray(vec) || vec.length !== model.dims || !vec.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw err('embed_failed', 'Embedding returned an unexpected shape (expected ' + model.dims + ' dimensions); nothing was published', 502);
    }
    return { vector: vec.map((x) => Math.round(x * 1e6) / 1e6), embedModel: model.embedModel, dims: model.dims };
  }

  async function confirmEngine(targetVersion) {
    if (typeof deps.engineHealth !== 'function') return { confirmed: false, reason: 'engine health not configured' };
    const deadline = Date.now() + confirmTimeoutMs;
    let last = null;
    for (;;) {
      try {
        const h = await deps.engineHealth();
        const ko = h && h.knowledgeOverlay;
        last = ko || null;
        if (ko && ko.state === 'active' && Number(ko.version) >= targetVersion) {
          return { confirmed: true, seenVersion: Number(ko.version), records: h.knowledge && h.knowledge.records };
        }
      } catch (e) { last = { error: String(e && e.message || e) }; }
      if (Date.now() + confirmIntervalMs > deadline) break;
      await sleep(confirmIntervalMs);
    }
    return { confirmed: false, reason: 'part-finder did not report the new knowledge overlay', last };
  }

  function overlayEntryOf(p, id) {
    return {
      doc: (p.docs && p.docs[id]) ? p.docs[id] : null,
      archived: (p.archived || []).indexOf(id) !== -1,
    };
  }
  function setOverlayEntry(p, id, entry) {
    p.docs = p.docs || {};
    p.archived = (p.archived || []).filter((x) => x !== id);
    if (entry.doc) p.docs[id] = entry.doc; else delete p.docs[id];
    if (entry.archived) p.archived.push(id);
  }

  async function revertOverlay(id, prevEntry, actor) {
    try {
      await mutate(PUBLISHED_KEY, emptyOverlay, (p) => {
        setOverlayEntry(p, id, prevEntry);
        p.version = (p.version || 0) + 1;
        p.updatedAt = iso();
        p.updatedBy = actorOf(actor);
      });
      return true;
    } catch (e) {
      log({ evt: 'knowledge-overlay-revert-failed', id, error: String(e && e.message || e) });
      return false;
    }
  }

  /**
   * Switch one record's live entry, confirm part-finder consumed it, then commit admin state.
   * Any failure after the switch restores the previous live entry (the previous live version stays).
   */
  async function goLive(id, nextEntry, versionRecord, applyState, actor) {
    if (versionRecord) {
      try {
        await s3.put(versionKey(id, versionRecord.version), JSON.stringify(versionRecord), { ifNoneMatch: '*' });
      } catch (e) {
        if (e && e.code === 'precondition') throw err('conflict', 'That version number was just taken by another publish. Reload and try again.', 409);
        throw err('store', 'Could not store the new version; nothing was published', 503);
      }
    }
    const dropVersion = async () => {
      if (!versionRecord) return;
      try { await s3.del(versionKey(id, versionRecord.version)); } catch (e) { log({ evt: 'knowledge-version-cleanup-failed', id, error: String(e && e.message || e) }); }
    };
    let prevEntry;
    let switched;
    try {
      switched = await mutate(PUBLISHED_KEY, emptyOverlay, (p) => {
        prevEntry = overlayEntryOf(p, id);
        setOverlayEntry(p, id, nextEntry(prevEntry));
        p.schema = OVERLAY_SCHEMA;
        p.version = (p.version || 0) + 1;
        p.updatedAt = iso();
        p.updatedBy = actorOf(actor);
        const m = indexModel();
        p.embedModel = m.embedModel;
        p.dims = m.dims;
      });
    } catch (e) {
      await dropVersion();
      throw e.status ? e : err('store', 'Could not update the live knowledge overlay; nothing was published', 503);
    }
    const target = switched.after.version;
    const fail = async (status, code, message, extra) => {
      const reverted = await revertOverlay(id, prevEntry, actor);
      await dropVersion();
      throw err(code, message + (reverted ? ' The previous live version is still active.' : ' Restoring the previous live entry also failed — check the knowledge overlay.'), status,
        Object.assign({ reverted }, extra || {}));
    };
    // Read back exactly what production will load.
    const rb = await readJson(PUBLISHED_KEY, emptyOverlay).catch(() => null);
    if (!rb || !rb.doc || Number(rb.doc.version) < target) {
      await fail(502, 'live_unconfirmed', 'The live knowledge overlay could not be read back.');
    }
    const engine = await confirmEngine(target);
    if (!engine.confirmed) {
      await fail(502, 'live_unconfirmed', 'Production did not confirm it loaded the change, so it was not published.', { engine });
    }
    try {
      await mutate(STATE_KEY, emptyState, (s) => applyState(s));
    } catch (e) {
      await fail(e.status === 409 ? 409 : 503, e.code || 'store', e.message || 'Could not record the change.', e.extra);
    }
    return { overlayVersion: target, engine };
  }

  async function publish(id, expectedRevision, note, actor) {
    const { state, overlay } = await loadAll();
    const rec = state.records[id];
    if (!rec || !rec.draft) throw err('no_draft', 'There is no draft to publish', 409);
    checkRevision(rec, expectedRevision);
    if (rec.archived) throw err('invalid_state', 'Restore this record before publishing', 409);
    const { content, errors } = validateContent(rec.draft, 'publish', { knownIds: knownIds(state, overlay) });
    if (errors.length) throw err('validation', 'This draft is not ready to publish', 400, { errors });
    const doc = buildPublishedDoc(content, corpus().docsVersion);
    const emb = await embedDoc(doc.text);
    const n = (rec.currentVersion || 0) + 1;
    const at = iso();
    const before = liveEditable(id, overlay);
    const meta = {
      version: n, publishedAt: at, publishedBy: actorOf(actor), note: note ? String(note).slice(0, MAX.note) : null,
      source: 'draft', rolledBackFrom: null, textHash: sha(doc.text), changed: diffContent(before, content),
    };
    const versionRecord = Object.assign({ schema: 'knowledge-version/1', knowledgeId: id }, meta,
      { content, doc, vector: emb.vector, embedModel: emb.embedModel, dims: emb.dims });
    const live = await goLive(id,
      () => ({ doc: Object.assign({}, doc, { vector: emb.vector, safetyInformation: content.safetyInformation || null, publishedVersion: n, publishedAt: at, publishedBy: meta.publishedBy, content }), archived: false }),
      versionRecord,
      (s) => {
        const r = s.records[id];
        checkRevision(r, expectedRevision);
        r.versions = (r.versions || []).concat([meta]);
        r.currentVersion = n;
        r.draft = null; r.draftBaseVersion = null; r.draftUpdatedAt = null; r.draftUpdatedBy = null;
        r.revision = (r.revision || 0) + 1;
        r.lastPublishedAt = at; r.lastPublishedBy = meta.publishedBy;
        s.updatedAt = at;
      }, actor);
    log({ evt: 'knowledge-published', id, version: n, by: meta.publishedBy, overlayVersion: live.overlayVersion });
    return Object.assign(await getView(id), { published: { version: n, overlayVersion: live.overlayVersion, engine: live.engine } });
  }

  async function rollback(id, expectedRevision, toVersion, note, actor) {
    const { state, overlay } = await loadAll();
    const rec = state.records[id];
    if (!rec || !(rec.currentVersion > 0)) throw err('invalid_state', 'This record has no published versions to roll back', 409);
    checkRevision(rec, expectedRevision);
    if (rec.archived) throw err('invalid_state', 'Restore this record before rolling back', 409);
    if (rec.draft) throw err('draft_pending', 'Publish or discard the pending draft before rolling back', 409);
    const k = Number(toVersion);
    if (!Number.isInteger(k) || k < 0) throw err('validation', 'Choose a version to roll back to', 400);
    if (k === rec.currentVersion) throw err('validation', 'That version is already live', 400);
    let content;
    let reuse = null;
    if (k === 0) {
      content = baselineEditable(id);
      if (!content) throw err('not_found', 'This record has no baseline version', 404);
    } else {
      const v = await readJson(versionKey(id, k));
      if (!v.doc) throw err('not_found', 'Version v' + k + ' not found', 404);
      content = v.doc.content;
      reuse = v.doc;
    }
    // Re-validate the old content against today's rules (e.g. a related topic may since be archived).
    const checked = validateContent(content, 'publish', { knownIds: knownIds(state, overlay) });
    if (checked.errors.length) throw err('validation', 'v' + k + ' no longer passes validation', 400, { errors: checked.errors });
    const doc = buildPublishedDoc(checked.content, corpus().docsVersion);
    const model = indexModel();
    const emb = (reuse && reuse.doc && reuse.doc.text === doc.text && reuse.embedModel === model.embedModel
      && Array.isArray(reuse.vector) && reuse.vector.length === model.dims)
      ? { vector: reuse.vector, embedModel: reuse.embedModel, dims: reuse.dims }
      : await embedDoc(doc.text);
    const n = rec.currentVersion + 1;
    const at = iso();
    const meta = {
      version: n, publishedAt: at, publishedBy: actorOf(actor), note: note ? String(note).slice(0, MAX.note) : null,
      source: 'rollback', rolledBackFrom: k, textHash: sha(doc.text), changed: diffContent(liveEditable(id, overlay), checked.content),
    };
    const versionRecord = Object.assign({ schema: 'knowledge-version/1', knowledgeId: id }, meta,
      { content: checked.content, doc, vector: emb.vector, embedModel: emb.embedModel, dims: emb.dims });
    const live = await goLive(id,
      () => ({ doc: Object.assign({}, doc, { vector: emb.vector, safetyInformation: checked.content.safetyInformation || null, publishedVersion: n, publishedAt: at, publishedBy: meta.publishedBy, content: checked.content }), archived: false }),
      versionRecord,
      (s) => {
        const r = s.records[id];
        checkRevision(r, expectedRevision);
        r.versions = (r.versions || []).concat([meta]);
        r.currentVersion = n;
        r.revision = (r.revision || 0) + 1;
        r.lastPublishedAt = at; r.lastPublishedBy = meta.publishedBy;
        s.updatedAt = at;
      }, actor);
    log({ evt: 'knowledge-rolled-back', id, version: n, from: k, by: meta.publishedBy });
    return Object.assign(await getView(id), { published: { version: n, rolledBackFrom: k, overlayVersion: live.overlayVersion, engine: live.engine } });
  }

  async function archive(id, expectedRevision, actor) {
    const { state, overlay } = await loadAll();
    const rec = state.records[id] || null;
    const v = viewOf(id, state, overlay);
    if (!v) throw err('not_found', 'Knowledge record not found', 404);
    checkRevision(rec, expectedRevision);
    if (!v.everPublished) throw err('invalid_state', 'A never-published draft cannot be archived; delete it instead', 409);
    if (v.archived) throw err('invalid_state', 'Already archived', 409);
    const at = iso();
    const live = await goLive(id, (prev) => ({ doc: prev.doc, archived: true }), null, (s) => {
      let r = s.records[id];
      checkRevision(r, expectedRevision);
      if (!r) r = s.records[id] = { knowledgeId: id, origin: 'baseline', revision: 0, currentVersion: 0, versions: [], createdAt: at, createdBy: actorOf(actor) };
      r.archived = true; r.archivedAt = at; r.archivedBy = actorOf(actor);
      r.revision = (r.revision || 0) + 1;
      s.updatedAt = at;
    }, actor);
    log({ evt: 'knowledge-archived', id, by: actorOf(actor) });
    return Object.assign(await getView(id), { archivedLive: { overlayVersion: live.overlayVersion, engine: live.engine } });
  }

  async function restore(id, expectedRevision, actor) {
    const { state } = await loadAll();
    const rec = state.records[id] || null;
    if (!rec || !rec.archived) throw err('invalid_state', 'This record is not archived', 409);
    checkRevision(rec, expectedRevision);
    const at = iso();
    const live = await goLive(id, (prev) => ({ doc: prev.doc, archived: false }), null, (s) => {
      const r = s.records[id];
      checkRevision(r, expectedRevision);
      r.archived = false; r.restoredAt = at; r.restoredBy = actorOf(actor);
      r.revision = (r.revision || 0) + 1;
      s.updatedAt = at;
    }, actor);
    log({ evt: 'knowledge-restored', id, by: actorOf(actor) });
    return Object.assign(await getView(id), { restoredLive: { overlayVersion: live.overlayVersion, engine: live.engine } });
  }

  return {
    getView, inspectView, listVersions, getVersion, checkDraft,
    createDraft, startDraft, saveDraft, deleteDraft,
    publish, rollback, archive, restore,
  };
}

module.exports = {
  PREFIX, STATE_KEY, PUBLISHED_KEY, OUTCOMES, PROVENANCE, COMPONENT_TYPES, SAFETY_CLASSES, FAULT_ID_RE,
  assembleText, deriveLikelyComponents, editableFrom, validateContent, buildPublishedDoc, diffContent,
  statusFor, versionKey, createStore, err,
};
