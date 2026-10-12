#!/usr/bin/env node
/**
 * Build intentional diagnostic KNOWLEDGE DOCUMENTS from the structured
 * faults-catalogue plus curated engineer overrides.
 *
 * We do NOT embed the raw catalogue as arbitrary chunks. Each fault node
 * becomes one deliberate document (symptoms, discriminators, likely components
 * with check-order, alternatives, clarifying question, checks, provenance) with
 * metadata for filtered retrieval. Curated overrides (overrides.json) layer real
 * engineer domain knowledge on top (e.g. oven base-element / FFD / commoned
 * neutrals) and can reorder components or add checks.
 *
 * Output: knowledge-docs.json  (consumed by build-index.mjs)
 *
 * Usage: node build-knowledge.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAT = JSON.parse(readFileSync(join(HERE, '..', 'faults-catalogue.json'), 'utf8'));
const OVERRIDES = JSON.parse(readFileSync(join(HERE, 'overrides.json'), 'utf8'));
const VERSION = OVERRIDES._version || '1.0.0';

// SINGLE source of truth for canonical component identity: the same pure function the runtime uses
// to key/lookup component media, imported directly so authored keys and runtime lookups never drift.
const { canonicalComponent } = createRequire(import.meta.url)('../retrieval.js');

const titleCase = (s) => s.replace(/-/g, ' ');

const SAFETY_CLASSES = new Set(['DO_NOT_OPEN', 'STOP_USE', 'EMERGENCY_ACTION', 'MAINTENANCE_SAFETY']);
const MEDIA_TYPES = new Set(['IMAGE', 'DIAGRAM', 'VIDEO']);
const MEDIA_APPLICABILITY = new Set(['GENERIC', 'MAKE_SPECIFIC', 'MODEL_SPECIFIC']);
// Customer-presentation safety class for a media item. Governs the DETERMINISTIC runtime matcher
// only (which of several media items for an ALREADY-grounded node is shown) — never diagnosis,
// retrieval, routing, parts or the safety-stop. TECHNICIAN_ONLY items are catalogued but the
// runtime NEVER projects them to a customer.
const MEDIA_SAFETY_CLASSES = new Set(['CUSTOMER_SAFE', 'IDENTIFICATION_ONLY', 'TECHNICIAN_ONLY', 'REJECT']);
// Explanatory-media INTENT (smallest first-class set). Absent => SAFE_CHECK (backward-compatible).
//   SAFE_CHECK — customer-safe instructional/check media for the grounded diagnosis.
//   ABOUT      — identification/location/explanation only; the ONLY intent that may surface
//                IDENTIFICATION_ONLY media, and never framed as a DIY repair instruction.
const MEDIA_INTENTS = new Set(['SAFE_CHECK', 'ABOUT']);

// Validate + normalise the OPTIONAL additive selection fields shared by every media type. These
// let the runtime matcher pick the single most relevant item for a grounded node (make / error-code
// aware) and gate presentation by safety class. All fields are optional and backward-compatible:
// absent => GENERIC, CUSTOMER_SAFE, priority 0, no make/code constraint. They live ONLY in the
// node-identity media artifact (never embedded, never in the index) so they cannot affect retrieval.
function mediaSelectionFields(m, err) {
  const out = {};
  if (m.makes !== undefined) {
    if (!Array.isArray(m.makes) || m.makes.length === 0
      || !m.makes.every((x) => typeof x === 'string' && x.trim())) err('makes must be a non-empty string[]');
    out.makes = m.makes.map((x) => x.trim());
  }
  if (m.errorCodes !== undefined) {
    if (!Array.isArray(m.errorCodes) || m.errorCodes.length === 0
      || !m.errorCodes.every((x) => typeof x === 'string' && x.trim())) err('errorCodes must be a non-empty string[]');
    out.errorCodes = m.errorCodes.map((x) => x.trim());
  }
  if (m.concepts !== undefined) {
    if (!Array.isArray(m.concepts) || m.concepts.length === 0
      || !m.concepts.every((x) => typeof x === 'string' && x.trim())) err('concepts must be a non-empty string[]');
    out.concepts = m.concepts.map((x) => x.trim());
  }
  if (m.safetyClass !== undefined) {
    if (!MEDIA_SAFETY_CLASSES.has(m.safetyClass)) err(`invalid safetyClass "${m.safetyClass}"`);
    out.safetyClass = m.safetyClass;
  }
  if (m.intent !== undefined) {
    if (!MEDIA_INTENTS.has(m.intent)) err(`invalid intent "${m.intent}"`);
    out.intent = m.intent;
  }
  if (m.priority !== undefined) {
    if (typeof m.priority !== 'number' || !Number.isFinite(m.priority)) err('priority must be a finite number');
    out.priority = m.priority;
  }
  // HONESTY GATE: IDENTIFICATION_ONLY media may only ever be presented as ABOUT (identification /
  // explanation), never as an instructional SAFE_CHECK. Build-fail otherwise so a repair/teardown
  // asset can never ship framed as a customer check.
  if (m.safetyClass === 'IDENTIFICATION_ONLY' && (m.intent || 'SAFE_CHECK') !== 'ABOUT') {
    err('IDENTIFICATION_ONLY media must declare intent "ABOUT" (never SAFE_CHECK)');
  }
  // Honesty: a brand-matched item MUST be gated as make/model-specific (never shown for the wrong
  // brand), and a make-specific item MUST name the makes it applies to (else it can't be matched).
  if (out.makes && m.applicability !== 'MAKE_SPECIFIC' && m.applicability !== 'MODEL_SPECIFIC') {
    err('makes[] requires applicability MAKE_SPECIFIC or MODEL_SPECIFIC');
  }
  if (m.applicability === 'MAKE_SPECIFIC' && !out.makes) {
    err('MAKE_SPECIFIC media must declare makes[]');
  }
  return out;
}

// Validate a customer INSTRUCTIONAL MEDIA item at build time. Media SUPPORTS an existing
// customer-safe check; it never influences diagnosis. Fail the build on an incomplete item so a
// media entry can never ship without: stable id, valid type, customer title, honest applicability,
// the check it relates to, an asset, alt text, and non-empty provenance.
function validateMediaItem(knowledgeId, m) {
  const err = (msg) => { throw new Error(`mediaInformation[${knowledgeId}]: ${msg}`); };
  // Fields common to EVERY media type: stable id, valid type, customer title, honest applicability,
  // the check it relates to, and non-empty sourced provenance.
  if (!m.id || typeof m.id !== 'string') err('missing id');
  if (!MEDIA_TYPES.has(m.type)) err(`invalid type "${m.type}"`);
  if (typeof m.title !== 'string' || !m.title.trim()) err('missing title');
  if (!MEDIA_APPLICABILITY.has(m.applicability)) err(`invalid applicability "${m.applicability}"`);
  if (typeof m.relatedCheck !== 'string' || !m.relatedCheck.trim()) err('missing relatedCheck');
  if (!Array.isArray(m.provenance) || m.provenance.length === 0) err('provenance MUST be a non-empty array');
  for (const p of m.provenance) {
    if (!p || typeof p !== 'object' || !p.sourceType || !p.publisher) err('provenance entry needs sourceType + publisher');
  }
  // Provenance is server-only (never projected to the client); preserve the sourced attribution
  // fields for both own diagrams and curated external embeds (channel/videoTitle/embedPermission).
  const provenance = m.provenance.map((p) => ({
    sourceType: p.sourceType, publisher: p.publisher,
    ...(p.title ? { title: p.title } : {}),
    ...(p.channel ? { channel: p.channel } : {}),
    ...(p.videoTitle ? { videoTitle: p.videoTitle } : {}),
    ...(p.embedPermission ? { embedPermission: p.embedPermission } : {}),
    ...(p.url ? { url: p.url } : {}),
    ...(p.basis ? { basis: p.basis } : {}),
  }));

  if (m.type === 'VIDEO') {
    // VIDEO is an embedded player (privacy-enhanced YouTube), NOT a local asset. Validate the exact
    // runtime/UI contract the projection consumes: caption (shown), provider+videoId+embedUrl (the
    // player), and the optional sourcePageUrl/attribution (creator credit). No local asset/alt.
    if (typeof m.caption !== 'string' || !m.caption.trim()) err('VIDEO missing caption');
    if (m.provider !== 'YOUTUBE') err(`VIDEO provider must be "YOUTUBE" (got "${m.provider}")`);
    if (typeof m.videoId !== 'string' || !m.videoId.trim()) err('VIDEO missing videoId');
    if (typeof m.embedUrl !== 'string' || !/^https:\/\/www\.youtube-nocookie\.com\/embed\//.test(m.embedUrl)) {
      err('VIDEO embedUrl must be a privacy-enhanced youtube-nocookie embed URL');
    }
    return {
      id: m.id, type: m.type, title: m.title, caption: m.caption,
      applicability: m.applicability, relatedCheck: m.relatedCheck,
      provider: m.provider, videoId: m.videoId, embedUrl: m.embedUrl,
      ...(m.sourcePageUrl ? { sourcePageUrl: m.sourcePageUrl } : {}),
      ...(m.attribution ? { attribution: m.attribution } : {}),
      ...mediaSelectionFields(m, err),
      provenance,
    };
  }

  // IMAGE / DIAGRAM: a local /media asset with alt text and a customer-facing description.
  if (typeof m.description !== 'string' || !m.description.trim()) err('missing description');
  if (typeof m.asset !== 'string' || !m.asset.trim()) err('missing asset');
  if (typeof m.alt !== 'string' || !m.alt.trim()) err('missing alt text');
  return {
    id: m.id, type: m.type, title: m.title, description: m.description,
    applicability: m.applicability, relatedCheck: m.relatedCheck, asset: m.asset, alt: m.alt,
    ...mediaSelectionFields(m, err),
    provenance,
  };
}

// Validate a safetyInformation record at build time. Fail the build (rather than ship a bad
// customer-safety record) if the evidence chain is incomplete: every displayed statement MUST carry
// non-empty pre-written text AND at least one provenance source. No LLM text, no unsourced text.
function validateSafetyInformation(knowledgeId, si) {
  const err = (m) => { throw new Error(`safetyInformation[${knowledgeId}]: ${m}`); };
  if (typeof si.text !== 'string' || !si.text.trim()) err('missing text');
  if (typeof si.hazard !== 'string' || !si.hazard.trim()) err('missing hazard');
  if (!SAFETY_CLASSES.has(si.classification)) err(`invalid classification "${si.classification}"`);
  if (typeof si.applicability !== 'string' || !si.applicability.trim()) err('missing applicability');
  if (!Array.isArray(si.provenance) || si.provenance.length === 0) err('provenance MUST be a non-empty array');
  for (const p of si.provenance) {
    if (!p || typeof p !== 'object') err('provenance entry must be an object');
    if (!p.publisher || !p.url || !p.sourceType) err('provenance entry needs sourceType, publisher, url');
  }
  // Return a fresh object with a fixed key order (stable generated artifact).
  return {
    text: si.text,
    hazard: si.hazard,
    classification: si.classification,
    applicability: si.applicability,
    provenance: si.provenance.map((p) => ({
      sourceType: p.sourceType, publisher: p.publisher, title: p.title || null,
      ...(p.section ? { section: p.section } : {}), url: p.url, retrieved: p.retrieved || null,
    })),
  };
}

function assembleText(d) {
  // Body that gets embedded. Structured with explicit labelled sections and a
  // dedicated "Customer phrases" block: a small embedding model (nomic) maps a
  // user query onto the customer-language section far more cleanly when it isn't
  // blended into the technical prose. Newline-separated so section boundaries
  // are clear to the encoder.
  const parts = [];
  parts.push(`Appliance: ${titleCase(d.applianceFamily)}`);
  parts.push(`Fault: ${d.label}`);
  // Customer language first — this is what a query is matched against.
  if (d.symptoms?.length) parts.push(`Customer phrases: ${d.symptoms.join('; ')}`);

  // RICHER STRUCTURED REASONING (optional; present only on enriched nodes).
  // Renders per-candidate evidence FOR/AGAINST and common-confusion components
  // into clear labelled prose so UNDERSTAND can re-rank candidateComponents by
  // the customer's actual evidence rather than a static order. Source stays
  // structured in overrides.json; this is only the rendering for the encoder+LLM.
  if (d.components?.length) {
    const hasTypes = d.components.some((c) => c.type);
    const header = hasTypes
      ? 'Candidate causes in initial diagnostic order (re-rank by the evidence below, do not treat the order as fixed). CHECK = a condition to inspect/clean/clear first, not automatically a part to sell; PART = a replacement component:'
      : 'Candidate causes in initial diagnostic order (re-rank by the evidence below, do not treat the order as fixed):';
    const lines = [header];
    d.components.forEach((c, i) => {
      const tag = c.type ? ` [${String(c.type).toUpperCase()}]` : '';
      lines.push(`${i + 1}. ${c.name}${tag}`);
      if (c.supports?.length) lines.push(`   More likely if: ${c.supports.join('; ')}.`);
      if (c.against?.length) lines.push(`   Less likely if: ${c.against.join('; ')}.`);
    });
    parts.push(lines.join('\n'));
  }
  if (d.commonConfusion?.length) {
    const lines = ['Common confusion — semantically related but NOT a leading cause for this symptom unless the stated evidence is present; do not surface these first without it:'];
    for (const c of d.commonConfusion) {
      const bits = [`- ${c.name}`];
      if (c.note) bits.push(c.note);
      lines.push(bits.join(': '));
      if (c.wouldApplyIf?.length) lines.push(`   Only consider if: ${c.wouldApplyIf.join('; ')}.`);
    }
    parts.push(lines.join('\n'));
  }

  // Engineer/technical language kept separate from the customer phrases above.
  if (d.discriminators?.length) parts.push(`Engineering notes: ${d.discriminators.join(' ')}`);
  if (d.likelyComponents?.length) parts.push(`Likely parts in order: ${d.likelyComponents.join(', ')}`);
  if (d.alternatives?.length) parts.push(`Confused with: ${d.alternatives.join(', ')}`);
  const advice = d.adviceBeforeReplacement?.length ? d.adviceBeforeReplacement : d.checks;
  if (advice?.length) parts.push(`Advice before replacing parts: ${advice.join('; ')}`);
  if (d.clarifyingQuestion) parts.push(`Best question to ask if unsure: ${d.clarifyingQuestion}`);
  if (d.secondaryQuestion) parts.push(`Follow-up question if still unclear: ${d.secondaryQuestion}`);
  return parts.join('\n');
}

const docs = [];
for (const [appliance, faults] of Object.entries(CAT.faults || {})) {
  for (const [faultId, node] of Object.entries(faults)) {
    const knowledgeId = `${appliance}:${faultId}`;
    const ov = OVERRIDES.docs?.[knowledgeId] || {};
    // When a node carries the richer `components` structure (name + evidence
    // for/against), derive the flat likelyComponents order from it so every
    // downstream consumer (formatKnowledge "likely parts in order", part
    // ranking) keeps working unchanged. Explicit likelyComponents still wins if
    // given; otherwise fall back to the catalogue node components.
    // For part search/ranking use the physical part (partName) where present,
    // else the cause name. In the TYPED style, a pure CHECK with no partName
    // (e.g. water supply, door sequencing, siphoning) is NOT a purchasable part
    // and is excluded from likelyComponents, so a correct diagnosis isn't turned
    // into a part sale. Untyped legacy docs keep the old behaviour (all names).
    let derivedComponents = null;
    if (Array.isArray(ov.components)) {
      const typed = ov.components.some((c) => c.type || c.partName);
      derivedComponents = typed
        ? [...new Set(ov.components.filter((c) => c.type === 'part' || c.partName).map((c) => c.partName || c.name))]
        : [...new Set(ov.components.map((c) => c.name))];
    }
    const doc = {
      knowledgeId,
      version: VERSION,
      applianceFamily: appliance,
      faultId,
      make: ov.make || null,
      platform: ov.platform || null,
      label: node.label || faultId,
      outcome: node.outcome || 'PART_ROUTING',
      componentFamilies: ov.componentFamilies || [],
      // curated ordering wins; else derive from rich components; else catalogue components
      likelyComponents: ov.likelyComponents || derivedComponents || node.components || [],
      symptoms: [...new Set([...(node.synonyms || []), ...(ov.symptoms || [])])],
      discriminators: [...(node.discriminators || []), ...(ov.discriminators || [])],
      alternatives: ov.alternatives || [],
      clarifyingQuestion: ov.clarifyingQuestion || null,
      checks: ov.checks || [],
      provenance: ov.provenance || 'catalogue',
      // richer structured reasoning (optional; only on enriched nodes)
      components: ov.components || [],
      commonConfusion: ov.commonConfusion || [],
      secondaryQuestion: ov.secondaryQuestion || null,
      adviceBeforeReplacement: ov.adviceBeforeReplacement || [],
    };
    doc.text = assembleText(doc);
    // Customer-visible SAFETY INFORMATION (additive, optional). Evidence-backed, pre-written text
    // attached by node identity. DELIBERATELY carried as a structured field and NOT folded into
    // `doc.text` — so it is NEVER embedded (retrieval isolation) and NEVER reaches the LLM.
    // Distinct from the legacy inert `safety` string, which is intentionally left untouched.
    if (ov.safetyInformation) {
      doc.safetyInformation = validateSafetyInformation(knowledgeId, ov.safetyInformation);
    }
    // Customer INSTRUCTIONAL MEDIA (additive, optional). Same isolation stance as safetyInformation:
    // a structured field, NEVER folded into doc.text (never embedded), attached by node identity.
    if (Array.isArray(ov.mediaInformation) && ov.mediaInformation.length) {
      doc.mediaInformation = ov.mediaInformation.map((m) => validateMediaItem(knowledgeId, m));
    }
    docs.push(doc);
  }
}

// Standalone curated docs not tied to a single catalogue node (e.g. cross-fault
// engineer knowledge) can be added via overrides.extraDocs.
for (const extra of OVERRIDES.extraDocs || []) {
  const doc = { version: VERSION, provenance: 'engineer', ...extra };
  doc.text = doc.text || assembleText(doc);
  docs.push(doc);
}

// Only write artifacts when run directly (`node build-knowledge.mjs`), so tests can import
// validateSafetyInformation without triggering a rebuild / file writes.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
export { validateSafetyInformation, validateMediaItem };
if (!IS_MAIN) {
  // imported for its exports only — skip artifact writes
} else {
writeFileSync(join(HERE, 'knowledge-docs.json'),
  JSON.stringify({ version: VERSION, count: docs.length, docs }, null, 1));
console.log(`built ${docs.length} knowledge docs (version ${VERSION}) -> knowledge-docs.json`);

// Emit a SEPARATE, node-identity-keyed safety-information artifact. This is what the runtime loads
// (by grounded knowledgeId) — it is NOT part of the retrieval index, so customer safety text can
// never influence retrieval similarity. Only docs with a validated safetyInformation appear here.
const byKnowledgeId = {};
for (const d of docs) {
  if (d.safetyInformation) byKnowledgeId[d.knowledgeId] = d.safetyInformation;
}
writeFileSync(join(HERE, 'safety-information.json'),
  JSON.stringify({ version: VERSION, count: Object.keys(byKnowledgeId).length, byKnowledgeId }, null, 2));
console.log(`built ${Object.keys(byKnowledgeId).length} safety-information records -> safety-information.json`);

// SEPARATE, identity-keyed EXPLANATORY-MEDIA artifact — loaded at runtime by grounded identity, NOT
// part of the retrieval index, so explanatory media can never influence retrieval similarity.
//   byKnowledgeId : node identity  "applianceFamily:faultId"  (from each doc's mediaInformation)
//   byComponent   : component identity "applianceFamily:<canonical component>" (from componentMedia)
const mediaByKnowledgeId = {};
for (const d of docs) {
  if (d.mediaInformation) mediaByKnowledgeId[d.knowledgeId] = d.mediaInformation;
}
const mediaItemCount = Object.values(mediaByKnowledgeId).reduce((n, a) => n + a.length, 0);

// Component-keyed explanatory media. Source keys are human-readable "applianceFamily:component
// phrase"; the component segment is canonicalised with the SAME function the runtime uses, so an
// already-grounded component name resolves deterministically. Validated by the shared validator.
const mediaByComponent = {};
for (const [srcKey, items] of Object.entries(OVERRIDES.componentMedia || {})) {
  const ci = srcKey.indexOf(':');
  if (ci < 0) throw new Error(`componentMedia key "${srcKey}" must be "applianceFamily:component"`);
  const family = srcKey.slice(0, ci).trim();
  const component = srcKey.slice(ci + 1).trim();
  const key = `${family}:${canonicalComponent(component)}`;
  if (mediaByComponent[key]) throw new Error(`componentMedia duplicate canonical key "${key}"`);
  if (!Array.isArray(items) || !items.length) throw new Error(`componentMedia[${srcKey}] must be a non-empty array`);
  mediaByComponent[key] = items.map((m) => validateMediaItem(`component:${key}`, m));
}
const componentItemCount = Object.values(mediaByComponent).reduce((n, a) => n + a.length, 0);

writeFileSync(join(HERE, 'media-information.json'),
  JSON.stringify({
    version: VERSION,
    nodes: Object.keys(mediaByKnowledgeId).length,
    items: mediaItemCount,
    components: Object.keys(mediaByComponent).length,
    componentItems: componentItemCount,
    byKnowledgeId: mediaByKnowledgeId,
    byComponent: mediaByComponent,
  }, null, 2));
console.log(`built ${mediaItemCount} node media items across ${Object.keys(mediaByKnowledgeId).length} nodes + ${componentItemCount} component media items across ${Object.keys(mediaByComponent).length} components -> media-information.json`);
}
