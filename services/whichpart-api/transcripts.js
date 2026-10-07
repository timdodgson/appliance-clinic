'use strict';

/**
 * ApplianceClinic production transcript observability.
 *
 * Additional record of anonymous diagnostic conversations. The browser
 * localStorage session remains the customer UX source of truth. This module
 * must never alter diagnostic semantics, never store photo bytes / EXIF /
 * chain-of-thought / IP / credentials, and never throw into the customer path.
 */

const ddb = require('./ddb');
const reviewSchema = require('./transcript-review/schema');
const reviewEligibility = require('./transcript-review/eligibility');
const reviewDashboard = require('./transcript-review/dashboard');
const reviewStateEvidence = require('./transcript-review/state-evidence');
const canonicalAudit = require('./canonical-audit');

const DEFAULT_TABLE = process.env.TRANSCRIPT_TABLE || 'whichpart-transcripts';
const DEFAULT_RETENTION_DAYS = Number(process.env.TRANSCRIPT_RETENTION_DAYS) || 90;
const DEFAULT_INACTIVE_MS = (Number(process.env.TRANSCRIPT_INACTIVE_MINUTES) || 120) * 60 * 1000;
const GSI_NAME = process.env.TRANSCRIPT_GSI || 'gsi_activity';
const GSI_PK = 'T';
const MAX_TURNS = 80;
// Bounded trace-size policy: keep the full diagnostic trace only for the most recent turns; older
// turns keep stage id/evidence/summary but drop the heavy `detail` and long progression values. This
// keeps the per-record trace footprint small so a long conversation cannot approach the DynamoDB
// 400 KB item limit. Delta-safe: state progression only compares to the immediately previous turn,
// which is always within the retained-full window.
const TRACE_FULL_TURNS = 16;
// The whole session is ONE DynamoDB item (400 KB hard limit). Above this payload budget older turns are slimmed
// further (trace detail + canonical audit reduced to summary form) before the write.
const PAYLOAD_BUDGET_BYTES = 300 * 1024;
const MAX_TEXT = 4000;
const MAX_SEARCH = 4000;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/;
const TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,79}$/;

const HELP_HUBS = [
  { family: 'washing machine', slug: 'washing-machines', title: 'Washing machine help — drain, leaks and noise' },
  { family: 'washer-dryer', slug: 'washer-dryers', title: 'Washer dryer help — wash, dry and leaks' },
  { family: 'tumble-dryer', slug: 'tumble-dryers', title: 'Tumble dryer help — drying, heat and filters' },
  { family: 'dishwasher', slug: 'dishwashers', title: 'Dishwasher help — draining, cleaning and leaks' },
  { family: 'fridge-freezer', slug: 'fridge-freezers', title: 'Fridge-freezer help — cooling, ice and seals' },
  { family: 'oven-cooker', slug: 'ovens-cookers', title: 'Oven and cooker help — heat, fans and gas safety' },
  { family: 'hobs', slug: 'hobs', title: 'Hob help — zones, ignition and cracked glass' },
  { family: 'microwave', slug: 'microwaves', title: 'Microwave help — not heating, sparks and doors' },
  { family: 'vacuum', slug: 'vacuum-cleaners', title: 'Vacuum cleaner help — suction, blockages and brush bars' },
];

function retentionDays() {
  const n = Number(process.env.TRANSCRIPT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 && n <= 730 ? n : DEFAULT_RETENTION_DAYS;
}

function inactiveAfterMs() {
  const n = Number(process.env.TRANSCRIPT_INACTIVE_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : 120) * 60 * 1000;
}

function nowIso(now) {
  return (now || new Date()).toISOString();
}

function ttlEpoch(now, days) {
  const d = days || retentionDays();
  const ms = (now || new Date()).getTime() + d * 86400000;
  return Math.floor(ms / 1000);
}

function clip(s, n) {
  if (s == null) return '';
  const t = String(s);
  return t.length > n ? t.slice(0, n) : t;
}

function isValidSessionId(id) {
  if (typeof id !== 'string') return false;
  if (!SESSION_ID_RE.test(id)) return false;
  if (/@/.test(id) || /live\.|sessiontoken|password/i.test(id)) return false;
  return true;
}

function isValidTurnId(id) {
  return typeof id === 'string' && TURN_ID_RE.test(id);
}

function takeObservability(body) {
  if (!body || typeof body !== 'object') return null;
  const raw = body.observability;
  delete body.observability;
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (!isValidSessionId(sessionId)) return null;
  const event = raw.event === 'end' ? 'end' : 'turn';
  const clientTurnId = isValidTurnId(raw.clientTurnId) ? raw.clientTurnId : null;
  return { sessionId, event, clientTurnId };
}

function pkOf(sessionId) { return 'SESSION#' + sessionId; }

function emptyRecord(sessionId, now) {
  const ts = nowIso(now);
  return {
    sessionId,
    createdAt: ts,
    lastActivityAt: ts,
    expiresAt: ttlEpoch(now),
    retentionDays: retentionDays(),
    status: 'active',
    endedAt: null,
    turnCount: 0,
    family: null,
    make: null,
    model: null,
    errorCode: null,
    route: null,
    outcome: null,
    safetyStop: false,
    safetyClass: null,
    hasError: false,
    lastRequestId: null,
    lastTraceId: null,
    partsCount: 0,
    mediaCount: 0,
    turns: [],
    review: reviewSchema.emptyReviewState(),
  };
}

function compactPart(p) {
  if (!p || typeof p !== 'object') return null;
  const name = p.name || p.title || null;
  if (!name) return null;
  return {
    name: clip(name, 160),
    fitStatus: p.fitStatus ? String(p.fitStatus).slice(0, 40) : null,
  };
}

function compactMedia(m) {
  if (!m || typeof m !== 'object') return null;
  if (!m.id && !m.title && !m.type) return null;
  return {
    id: m.id ? clip(m.id, 80) : null,
    type: m.type ? clip(m.type, 20) : null,
    title: m.title ? clip(m.title, 160) : '',
  };
}

function customerTextFromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return { text: '', photo: false };
  let lastUser = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') { lastUser = messages[i]; break; }
  }
  if (!lastUser) return { text: '', photo: false };
  const c = lastUser.content;
  let text = '';
  let photo = false;
  if (typeof c === 'string') {
    text = c;
    photo = /\[Sent a photo\]/i.test(c) || /Photo of rating plate/i.test(c);
  } else if (Array.isArray(c)) {
    text = c.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
    photo = c.some((p) => p && (p.type === 'image_url' || p.type === 'image'));
  }
  // Never persist data: URLs / base64 even if a client smuggled them into text.
  text = String(text || '').replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g, '[photo omitted]');
  return { text: clip(text, MAX_TEXT), photo: Boolean(photo) };
}

function customerVisibleFromView(view) {
  const v = view || {};
  const parts = Array.isArray(v.parts) ? v.parts.map(compactPart).filter(Boolean).slice(0, 8) : [];
  const media = Array.isArray(v.media) ? v.media.map(compactMedia).filter(Boolean).slice(0, 8) : [];
  const si = v.safetyInformation;
  const safetyText = si && typeof si === 'object' ? si.text : (typeof si === 'string' ? si : null);
  return {
    reply: clip(v.reply || '', MAX_TEXT),
    diagnosisLabel: v.diagnosis && v.diagnosis.label ? clip(v.diagnosis.label, 240) : null,
    safetyText: safetyText ? clip(safetyText, 900) : null,
    needsModel: Boolean(v.needsModel),
    extractedModel: v.extractedModel ? clip(v.extractedModel, 80) : null,
    parts: parts,
    media: media,
  };
}

function metadataFromPath(orch, view, rid) {
  const submitted = (orch && orch._telemetry && orch._telemetry.submitted) || {};
  const safety = (orch && orch.safety) || {};
  const si = view && view.safetyInformation;
  return {
    requestId: rid || (view && view.requestId) || null,
    traceId: (orch && orch.traceId) || (view && view.traceId) || null,
    route: (orch && orch.route) || null,
    outcome: (view && view.error) ? 'ERROR' : ((orch && orch.outcome) || null),
    family: submitted.applianceFamily || null,
    make: submitted.make || null,
    model: (orch && orch.resolvedModel) ? clip(orch.resolvedModel, 80) : null,
    extractedModel: (view && view.extractedModel) ? clip(view.extractedModel, 80) : null,
    errorCode: submitted.displayedCode || null,
    safetyStop: Boolean(view && view.safety) || Boolean(safety.stopUse) || (orch && orch.outcome === 'SAFETY_STOP'),
    safetyClass: safety.class || (si && si.classification) || null,
    apiError: Boolean(view && view.error),
  };
}

function forbiddenKeysIn(obj, keys) {
  const blob = JSON.stringify(obj || {});
  return keys.filter((k) => blob.toLowerCase().includes(k.toLowerCase()));
}

function stripSecrets(obj) {
  // Defence in depth: never persist obvious secret/debug shapes even if a caller
  // accidentally forwarded them. Does not attempt to redact free-text PII.
  const json = JSON.stringify(obj, (k, v) => {
    const key = String(k || '').toLowerCase();
    if (/password|secret|authorization|cookie|api.?token|access.?token|api.?key|access.?key|exif|chain.of.thought|reasoning|ipaddress|ip_address|user-agent|useragent|fingerprint/.test(key)) {
      return undefined;
    }
    if (typeof v === 'string' && /^data:image\//i.test(v)) return '[photo omitted]';
    if (typeof v === 'string' && v.length > 200 && /^[A-Za-z0-9+/=]{80,}$/.test(v) && !/\s/.test(v)) {
      return '[binary omitted]';
    }
    return v;
  });
  return JSON.parse(json);
}

function safeTraceValue(value) {
  return stripSecrets(value);
}

function normaliseDiagnosticTrace(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.stages)) return null;
  const allowedEvidence = new Set(['OBSERVED', 'DERIVED', 'NOT_CAPTURED']);
  return safeTraceValue({
    schemaVersion: clip(raw.schemaVersion || '1.0', 20),
    latenciesMs: raw.latenciesMs && typeof raw.latenciesMs === 'object' ? raw.latenciesMs : {},
    stages: raw.stages.slice(0, 20).map((stage, i) => ({
      id: clip(stage && stage.id || ('stage-' + i), 60),
      label: clip(stage && stage.label || 'Runtime stage', 100),
      evidence: allowedEvidence.has(stage && stage.evidence) ? stage.evidence : 'NOT_CAPTURED',
      summary: clip(stage && stage.summary || '', 300),
      detail: stage && stage.detail != null ? stage.detail : null,
    })),
  });
}

// Slim a single turn's trace: keep id/label/evidence/summary, drop heavy stage `detail`, and reduce
// progression to path+change only. Deterministic; preserves the shape (evidence labels stay honest).
function slimTrace(trace) {
  if (!trace || trace.bounded || !Array.isArray(trace.stages)) return trace;
  for (const s of trace.stages) { if (s && s.detail != null) s.detail = null; }
  if (Array.isArray(trace.stateProgression)) {
    trace.stateProgression = trace.stateProgression.map((x) => ({ path: x.path, change: x.change }));
  }
  trace.bounded = true;
  return trace;
}

// Keep the full trace for the most recent TRACE_FULL_TURNS turns; slim older ones so the per-record
// trace footprint stays bounded regardless of conversation length (DynamoDB 400 KB item limit).
function boundTraceHistory(turns, keep) {
  if (!Array.isArray(turns)) return;
  const cut = turns.length - (keep == null ? TRACE_FULL_TURNS : keep);
  for (let i = 0; i < cut; i++) {
    const t = turns[i];
    if (t && t.diagnosticTrace) slimTrace(t.diagnosticTrace);
    if (t && t.canonical) t.canonical = canonicalAudit.slim(t.canonical);
  }
}

// Keep the session item under budget: progressively narrow the full-detail window (never drops turns or text).
function enforcePayloadBudget(rec) {
  for (const keep of [8, 4, 1, 0]) {
    if (Buffer.byteLength(JSON.stringify(rec.turns || []), 'utf8') <= PAYLOAD_BUDGET_BYTES) return;
    boundTraceHistory(rec.turns, keep);
  }
}

/**
 * Session-level canonical summary for the list (derived from the stored per-turn audits; old transcripts with no
 * audit are 'legacy'). Computed on read, so historical records need no migration.
 */
function canonicalSummary(rec) {
  const turns = (rec && rec.turns) || [];
  const counts = { control: 0, shadow: 0, legacy: 0, degraded: 0 };
  let journey = null; let appliance = null; let ref = null; let audited = 0; let partRecommended = false;
  for (const t of turns) {
    const c = t && t.canonical;
    if (t && t.customerVisible && Array.isArray(t.customerVisible.parts) && t.customerVisible.parts.length) partRecommended = true;
    if (!c || c.schemaVersion !== 'canonical-audit/1') { counts.legacy += 1; continue; }
    audited += 1;
    counts[c.path] = (counts[c.path] || 0) + 1;
    if (c.owner) journey = c.owner;
    if (c.appliance) appliance = c.appliance;
    if (c.ref) ref = c.ref;
    if (c.nextAction && c.nextAction.kind === 'recommend_part') partRecommended = true;
  }
  let path = 'legacy';
  if (counts.control && (counts.legacy || counts.shadow || counts.degraded)) path = 'mixed';
  else if (counts.control) path = 'control';
  else if (counts.shadow) path = 'shadow';
  else if (counts.degraded && !counts.legacy) path = 'degraded';
  return { path, counts, audited, journey, appliance, ref, degraded: counts.degraded > 0, partRecommended };
}

function traceState(trace) {
  if (!trace || !Array.isArray(trace.stages)) return {};
  const state = trace.stages.find((s) => s && s.id === 'orchestrator-state');
  return (state && state.detail && typeof state.detail === 'object') ? state.detail : {};
}

function flattenState(value, prefix, out) {
  out = out || {};
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
  } else if (value && typeof value === 'object') {
    Object.keys(value).sort().forEach((k) => flattenState(value[k], prefix ? prefix + '.' + k : k, out));
  } else if (value !== undefined) {
    out[prefix] = value;
  }
  return out;
}

function stateProgression(previousTrace, currentTrace) {
  if (!currentTrace) return [];
  const before = flattenState(traceState(previousTrace), '', {});
  const after = flattenState(traceState(currentTrace), '', {});
  const keys = Array.from(new Set(Object.keys(before).concat(Object.keys(after)))).sort();
  return keys.filter(Boolean).map((key) => {
    const had = Object.prototype.hasOwnProperty.call(before, key) && before[key] != null && before[key] !== '';
    const has = Object.prototype.hasOwnProperty.call(after, key) && after[key] != null && after[key] !== '';
    if (!had && has) return { path: key, change: 'NEW', value: after[key] };
    if (had && !has) return { path: key, change: 'REMOVED_OR_CONTRADICTED', previous: before[key] };
    if (had && has && JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      return { path: key, change: 'UPDATED', previous: before[key], value: after[key] };
    }
    if (had && has) return { path: key, change: 'RETAINED', value: after[key] };
    return null;
  }).filter(Boolean).slice(0, 80);
}

function buildTurn(input) {
  const now = input.now || new Date();
  const customer = customerTextFromMessages(input.messages);
  const visible = customerVisibleFromView(input.view);
  const meta = metadataFromPath(input.orch, input.view, input.requestId);
  const turn = stripSecrets({
    seq: 0,
    at: nowIso(now),
    clientTurnId: input.clientTurnId || null,
    customer: { text: customer.text, photo: customer.photo },
    customerVisible: visible,
    metadata: meta,
    diagnosticTrace: normaliseDiagnosticTrace(input.orch && input.orch._diagnosticTrace),
    // canonical-audit/1 (canonical-audit.js): bounded snapshot of this turn's canonical decisions. Audit only —
    // never read back into runtime; canonical state lives in STATE# / STATETURN#. Absent on legacy-only BFFs.
    canonical: input.canonical && typeof input.canonical === 'object' ? input.canonical : null,
  });
  return turn;
}

function searchBlobFrom(rec) {
  const parts = [];
  for (const t of rec.turns || []) {
    if (t.customer && t.customer.text) parts.push(t.customer.text);
    if (t.customerVisible && t.customerVisible.reply) parts.push(t.customerVisible.reply);
  }
  return clip(parts.join('\n').toLowerCase(), MAX_SEARCH);
}

function applyTurn(record, turn, now) {
  const rec = record || emptyRecord(turn && turn.metadata && turn.sessionId, now);
  const ts = nowIso(now);
  rec.lastActivityAt = ts;
  rec.expiresAt = ttlEpoch(now);
  rec.retentionDays = retentionDays();
  if (rec.status === 'ended') {
    // A later turn after New Chat belongs to a new browser session id, not this
    // record. Ignore (idempotent no-op) rather than resurrecting an ended session.
    return rec;
  }
  rec.status = 'active';
  // A new turn means the conversation is no longer a frozen snapshot. Drop any
  // previous semantic review rather than leaving stale product-quality labels.
  if (rec.review && rec.review.status && rec.review.status !== 'none') {
    rec.review = reviewSchema.emptyReviewState();
  }
  const turns = Array.isArray(rec.turns) ? rec.turns.slice() : [];
  const id = turn.clientTurnId;
  let idx = -1;
  if (id) idx = turns.findIndex((t) => t && t.clientTurnId === id);
  if (idx >= 0) {
    turn.seq = turns[idx].seq;
    // An idempotent duplicate (same clientTurnId, nothing merged again): keep the ORIGINAL turn's canonical audit
    // and record the replay, instead of overwriting the real decision with the duplicate's empty one.
    const was = turns[idx].canonical;
    const dup = turn.canonical && turn.canonical.persistence && turn.canonical.persistence.duplicate;
    if (was && dup && !(was.persistence && was.persistence.duplicate)) turn.canonical = canonicalAudit.markReplay(was, turn.at);
    turns[idx] = turn;
  } else {
    turn.seq = turns.length + 1;
    turns.push(turn);
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
  }
  // State changes are computed from structured snapshots, never response/customer phrase matching.
  const currentIndex = turns.findIndex((t) => t === turn);
  const previous = currentIndex > 0 ? turns[currentIndex - 1] : null;
  if (turn.diagnosticTrace) {
    turn.diagnosticTrace.stateProgression = stateProgression(previous && previous.diagnosticTrace, turn.diagnosticTrace);
  }
  boundTraceHistory(turns);
  rec.turns = turns;
  enforcePayloadBudget(rec);
  rec.turnCount = turns.length;
  const last = turns[turns.length - 1];
  const md = (last && last.metadata) || {};
  if (md.family) rec.family = md.family;
  if (md.make) rec.make = md.make;
  if (md.model) rec.model = md.model;
  if (md.errorCode) rec.errorCode = md.errorCode;
  if (md.route) rec.route = md.route;
  rec.outcome = md.outcome || rec.outcome;
  rec.safetyStop = Boolean(md.safetyStop) || Boolean(rec.safetyStop);
  if (md.safetyClass) rec.safetyClass = md.safetyClass;
  rec.hasError = Boolean(rec.hasError) || Boolean(md.apiError);
  rec.lastRequestId = md.requestId || rec.lastRequestId;
  rec.lastTraceId = md.traceId || rec.lastTraceId;
  rec.partsCount = (last && last.customerVisible && last.customerVisible.parts)
    ? last.customerVisible.parts.length : rec.partsCount;
  rec.mediaCount = (last && last.customerVisible && last.customerVisible.media)
    ? last.customerVisible.media.length : rec.mediaCount;
  rec.searchBlob = searchBlobFrom(rec);
  return rec;
}

function applyEnd(record, now) {
  const rec = record;
  if (!rec) return null;
  const ts = nowIso(now);
  rec.lastActivityAt = ts;
  rec.endedAt = rec.endedAt || ts;
  rec.status = 'ended';
  rec.expiresAt = ttlEpoch(now);
  return rec;
}

function deriveLifecycle(rec, now) {
  if (!rec) return 'unknown';
  if (rec.status === 'ended') return 'ended';
  const last = rec.lastActivityAt ? Date.parse(rec.lastActivityAt) : 0;
  const t = (now || new Date()).getTime();
  if (last && (t - last) >= inactiveAfterMs()) return 'inactive';
  return 'active';
}

function reviewOverview(rec, now) {
  const review = reviewSchema.compactReview(rec && rec.review);
  const a = review.assessment;
  return {
    status: reviewEligibility.displayReviewStatus(rec, now),
    storedStatus: review.status,
    version: review.version,
    reviewedAt: review.reviewedAt,
    error: review.error,
    overallAssessment: a ? a.overallAssessment : null,
    outcome: a ? a.outcome : null,
    reviewPriority: a ? a.reviewPriority : null,
    suggestedProductAreas: a ? (a.suggestedProductAreas || []) : [],
    looping: a ? a.looping : null,
    safetyHandling: a ? a.safetyHandling : null,
    stateProgression: a ? (a.stateProgression || null) : null,
  };
}

const OPENING_PREVIEW_MAX = 160;

function openingPreview(rec) {
  const turns = (rec && rec.turns) || [];
  for (let i = 0; i < turns.length; i++) {
    const raw = turns[i] && turns[i].customer && turns[i].customer.text;
    if (!raw) continue;
    const compact = String(raw).replace(/\s+/g, ' ').trim();
    if (!compact) continue;
    if (compact.length <= OPENING_PREVIEW_MAX) return compact;
    return compact.slice(0, OPENING_PREVIEW_MAX - 1) + '…';
  }
  return '';
}

function viewCountsFromRecords(records) {
  const counts = { all: 0, attention: 0, poor: 0, safety: 0, loops: 0, progression: 0 };
  for (const rec of records || []) {
    counts.all += 1;
    if (reviewDashboard.needsAttention(rec)) counts.attention += 1;
    const a = rec && rec.review && rec.review.status === 'reviewed' ? rec.review.assessment : null;
    if (!a) continue;
    if (a.overallAssessment === 'poor') counts.poor += 1;
    if (a.safetyHandling === 'concern') counts.safety += 1;
    if (a.looping === 'significant') counts.loops += 1;
    if (a.stateProgression === 'poor') counts.progression += 1;
  }
  return counts;
}

function inDateWindow(rec, from, to) {
  const t = String((rec && (rec.lastActivityAt || rec.createdAt)) || '');
  if (from && t < String(from)) return false;
  if (to && t > String(to)) return false;
  return true;
}

function overviewRow(rec, now) {
  const lifecycle = deriveLifecycle(rec, now);
  const review = reviewOverview(rec, now);
  const reviewed = review.storedStatus === 'reviewed';
  return {
    sessionId: rec.sessionId,
    shortId: String(rec.sessionId || '').slice(0, 8),
    createdAt: rec.createdAt,
    lastActivityAt: rec.lastActivityAt,
    endedAt: rec.endedAt || null,
    lifecycle: lifecycle,
    turnCount: rec.turnCount || 0,
    family: rec.family || null,
    make: rec.make || null,
    model: rec.model || null,
    errorCode: rec.errorCode || null,
    route: rec.route || null,
    outcome: rec.outcome || null,
    safetyStop: Boolean(rec.safetyStop),
    safetyClass: rec.safetyClass || null,
    hasError: Boolean(rec.hasError),
    partsCount: rec.partsCount || 0,
    mediaCount: rec.mediaCount || 0,
    openingPreview: openingPreview(rec),
    canonical: (() => { const c = canonicalSummary(rec); return { path: c.path, journey: c.journey, appliance: c.appliance, ref: c.ref,
      degraded: c.degraded, counts: c.counts }; })(),
    partRecommended: canonicalSummary(rec).partRecommended,
    needsAttention: reviewDashboard.needsAttention(rec),
    reviewStatus: review.status,
    reviewOverall: review.overallAssessment,
    reviewOutcome: review.outcome,
    reviewPriority: review.reviewPriority,
    reviewLooping: reviewed ? review.looping : null,
    reviewSafetyHandling: reviewed ? review.safetyHandling : null,
    reviewStateProgression: reviewed ? review.stateProgression : null,
    reviewVersion: review.version,
    reviewError: review.error,
  };
}

function drillDown(rec, now) {
  const turnList = rec.turns || [];
  const turns = turnList.map((t) => ({
    seq: t.seq,
    at: t.at,
    customer: t.customer || { text: '', photo: false },
    applianceClinic: t.customerVisible || { reply: '' },
    diagnosticTrace: t.diagnosticTrace || null,
    canonical: t.canonical || null,
    runtime: t.metadata ? { route: t.metadata.route || null, outcome: t.metadata.outcome || null, requestId: t.metadata.requestId || null,
      safetyStop: Boolean(t.metadata.safetyStop), safetyClass: t.metadata.safetyClass || null, apiError: Boolean(t.metadata.apiError) } : null,
  }));
  const last = turnList[turnList.length - 1] || {};
  return {
    retention: {
      days: rec.retentionDays || retentionDays(),
      expiresAt: rec.expiresAt || null,
      policy: 'Anonymous production transcripts are kept for '
        + (rec.retentionDays || retentionDays())
        + ' days, then deleted automatically (DynamoDB TTL).',
    },
    overview: overviewRow(rec, now),
    customerVisible: {
      label: 'CUSTOMER SAW THIS',
      turns: turns,
    },
    diagnosticMetadata: {
      label: 'INTERNAL DIAGNOSTIC METADATA',
      createdAt: rec.createdAt,
      lastActivityAt: rec.lastActivityAt,
      endedAt: rec.endedAt,
      lifecycle: deriveLifecycle(rec, now),
      family: rec.family || (last.metadata && last.metadata.family) || null,
      make: rec.make || (last.metadata && last.metadata.make) || null,
      model: rec.model || (last.metadata && last.metadata.model) || null,
      extractedModel: last.metadata ? last.metadata.extractedModel : null,
      errorCode: rec.errorCode || (last.metadata && last.metadata.errorCode) || null,
      route: rec.route || (last.metadata && last.metadata.route) || null,
      outcome: rec.outcome || (last.metadata && last.metadata.outcome) || null,
      safetyStop: Boolean(rec.safetyStop),
      safetyClass: rec.safetyClass || null,
      hasError: Boolean(rec.hasError),
      lastRequestId: rec.lastRequestId || null,
      lastTraceId: rec.lastTraceId || null,
      partsSurfaced: last.customerVisible ? last.customerVisible.parts : [],
      mediaSurfaced: last.customerVisible ? last.customerVisible.media : [],
      needsModel: last.customerVisible ? Boolean(last.customerVisible.needsModel) : false,
    },
    semanticReview: semanticReviewView(rec, now),
    // Bounded, typed state-progression evidence (structural change labels from the trace, not a raw
    // trace dump and not prose). Lets a human triager see where facts were retained / added / lost.
    stateEvidence: reviewStateEvidence.compactStateEvidence(reviewStateEvidence.buildStateEvidence(rec)),
  };
}

function semanticReviewView(rec, now) {
  const review = reviewSchema.compactReview(rec && rec.review);
  const display = reviewEligibility.displayReviewStatus(rec, now);
  const eligible = reviewEligibility.isReviewable(rec, now);
  return {
    label: 'SEMANTIC REVIEW',
    notice: 'LLM product-quality assessment. Not facts recorded during the conversation, and not a change to what the customer saw.',
    status: display,
    storedStatus: review.status,
    eligible: eligible,
    canRereview: eligible,
    version: review.version,
    promptVersion: review.promptVersion,
    reviewedAt: review.reviewedAt,
    lastAttemptAt: review.lastAttemptAt,
    attemptCount: review.attemptCount,
    model: review.model,
    provider: review.provider,
    error: review.error,
    assessment: review.assessment,
  };
}

function encodeCursor(obj) {
  if (!obj) return null;
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function decodeCursor(s) {
  if (!s) return null;
  try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); }
  catch { return null; }
}

function matchesFilters(rec, f, now) {
  if (!f) return true;
  const life = deriveLifecycle(rec, now);
  if (f.lifecycle && f.lifecycle !== 'all' && life !== f.lifecycle) return false;
  if (f.family && String(rec.family || '').toLowerCase() !== String(f.family).toLowerCase()) return false;
  if (f.make && String(rec.make || '').toLowerCase() !== String(f.make).toLowerCase()) return false;
  if (f.route && String(rec.route || '') !== String(f.route)) return false;
  if (f.errors === true && !rec.hasError) return false;
  if (f.safety === true && !rec.safetyStop) return false;
  if (f.journey || f.canonical || f.degraded === true || f.partRecommended != null) {
    const cs = canonicalSummary(rec);
    if (f.journey && cs.journey !== f.journey) return false;
    if (f.canonical && f.canonical !== 'all' && cs.path !== f.canonical) return false;
    if (f.degraded === true && !cs.degraded) return false;
    if (f.partRecommended != null && cs.partRecommended !== f.partRecommended) return false;
  }
  if (f.q) {
    const q = String(f.q).toLowerCase();
    if (q.length >= 3) {
      const blob = rec.searchBlob || searchBlobFrom(rec);
      if (!blob.includes(q)) return false;
    }
  }
  const reviewDisp = reviewEligibility.displayReviewStatus(rec, now);
  if (f.reviewStatus && f.reviewStatus !== 'all' && reviewDisp !== f.reviewStatus) return false;
  const a = rec.review && rec.review.assessment;
  if (f.overall && f.overall !== 'all') {
    if (!a || a.overallAssessment !== f.overall) return false;
  }
  if (f.priority && f.priority !== 'all') {
    if (!a || a.reviewPriority !== f.priority) return false;
  }
  if (f.reviewOutcome && f.reviewOutcome !== 'all') {
    if (!a || a.outcome !== f.reviewOutcome) return false;
  }
  if (f.productArea && f.productArea !== 'all') {
    const areas = (a && a.suggestedProductAreas) || [];
    if (areas.indexOf(f.productArea) === -1) return false;
  }
  if (f.looping && f.looping !== 'all') {
    if (!a || a.looping !== f.looping) return false;
  }
  if (f.safetyHandling && f.safetyHandling !== 'all') {
    if (!a || a.safetyHandling !== f.safetyHandling) return false;
  }
  if (f.stateProgression && f.stateProgression !== 'all') {
    if (!a || a.stateProgression !== f.stateProgression) return false;
  }
  if (f.attention === true) {
    if (!reviewDashboard.needsAttention(rec)) return false;
  }
  return true;
}

function parseListQuery(qs) {
  const q = qs || {};
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 25));
  const from = q.from ? String(q.from) : null;
  const to = q.to ? String(q.to) : null;
  const filters = {
    family: q.family ? String(q.family).slice(0, 40) : '',
    make: q.make ? String(q.make).slice(0, 40) : '',
    route: q.route ? String(q.route).slice(0, 40) : '',
    lifecycle: q.lifecycle ? String(q.lifecycle).slice(0, 20) : '',
    errors: q.errors === '1' || q.errors === 'true',
    safety: q.safety === '1' || q.safety === 'true',
    q: q.q ? String(q.q).slice(0, 80) : '',
    reviewStatus: q.reviewStatus ? String(q.reviewStatus).slice(0, 24) : '',
    overall: q.overall ? String(q.overall).slice(0, 32) : '',
    priority: q.priority ? String(q.priority).slice(0, 24) : '',
    reviewOutcome: q.reviewOutcome ? String(q.reviewOutcome).slice(0, 32) : '',
    productArea: q.productArea ? String(q.productArea).slice(0, 40) : '',
    looping: q.looping ? String(q.looping).slice(0, 24) : '',
    safetyHandling: q.safetyHandling ? String(q.safetyHandling).slice(0, 24) : '',
    stateProgression: q.stateProgression ? String(q.stateProgression).slice(0, 24) : '',
    attention: q.attention === '1' || q.attention === 'true',
    // canonical filters (evaluated in JS on the same GSI page as family / route; no extra scan)
    journey: q.journey && /^[a-z][a-z0-9-]{1,60}$/.test(String(q.journey)) ? String(q.journey) : '',
    canonical: ['control', 'shadow', 'legacy', 'mixed', 'degraded'].includes(q.canonical) ? q.canonical : '',
    degraded: q.degraded === '1' || q.degraded === 'true',
    partRecommended: q.partRecommended === '1' || q.partRecommended === 'true' ? true : (q.partRecommended === '0' || q.partRecommended === 'false' ? false : null),
  };
  return { limit, from, to, cursor: q.cursor || null, filters };
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function statsFromRows(rows, now) {
  const today = startOfUtcDay(now || new Date());
  let sessionsToday = 0;
  let turnsToday = 0;
  let errorSessions = 0;
  let safetySessions = 0;
  const families = {};
  for (const r of rows) {
    const last = r.lastActivityAt || r.createdAt || '';
    if (last >= today) {
      sessionsToday += 1;
      turnsToday += r.turnCount || 0;
      if (r.hasError) errorSessions += 1;
      if (r.safetyStop) safetySessions += 1;
      const fam = r.family || 'unknown';
      families[fam] = (families[fam] || 0) + 1;
    }
  }
  const familyDistribution = Object.keys(families).sort((a, b) => families[b] - families[a])
    .map((k) => ({ family: k, count: families[k] }));
  return {
    generatedAt: nowIso(now),
    retentionDays: retentionDays(),
    inactiveAfterMinutes: Math.round(inactiveAfterMs() / 60000),
    sessionsToday,
    turnsToday,
    errorSessionsToday: errorSessions,
    safetySessionsToday: safetySessions,
    familyDistribution,
    recent: rows.slice(0, 8).map((r) => overviewRow(r, now)),
    quality: require('./transcript-review/aggregates').fromRecords(rows, now),
  };
}

function policy() {
  return {
    retentionDays: retentionDays(),
    inactiveAfterMinutes: Math.round(inactiveAfterMs() / 60000),
    table: process.env.TRANSCRIPT_TABLE || DEFAULT_TABLE,
    ttlAttribute: 'expiresAt',
    summary: 'Anonymous diagnostic transcripts are stored for '
      + retentionDays()
      + ' days and then deleted by DynamoDB TTL. They are not customer accounts. '
      + 'Browser localStorage remains the live chat source of truth. '
      + 'A session is marked ended only when the customer uses New Chat. '
      + 'Sessions with no further activity after '
      + Math.round(inactiveAfterMs() / 60000)
      + ' minutes are shown as inactive — not completed. '
      + 'Semantic review metadata is stored on the same record and expires with it.',
    stored: [
      'anonymous session id',
      'created / last-activity timestamps',
      'ordered customer and ApplianceClinic turns (visible text)',
      'photo-present flag (never bytes)',
      'appliance family / make / model / error code when the request path knew them',
      'route, outcome, safety classification, parts/media surfaced, request/trace ids',
      'best-effort redacted diagnostic trace and structured per-turn state progression when captured',
      'API error flag',
      'semantic review status, versioned LLM assessment, model/provider provenance (same TTL)',
    ],
    notStored: [
      'email addresses or names as fields (customers may still type them into free text)',
      'IP addresses',
      'authentication credentials',
      'browser fingerprints or device identifiers',
      'uploaded photo bytes or EXIF',
      'LLM chain-of-thought / hidden reasoning',
      'debug secrets',
      'separate long-lived copies of transcripts for analysis',
    ],
  };
}

function recordToItem(rec) {
  const payload = JSON.stringify({
    turns: rec.turns,
    endedAt: rec.endedAt,
    lastRequestId: rec.lastRequestId,
    lastTraceId: rec.lastTraceId,
    partsCount: rec.partsCount,
    mediaCount: rec.mediaCount,
    safetyClass: rec.safetyClass,
    extractedModel: rec.turns && rec.turns.length
      ? ((rec.turns[rec.turns.length - 1].metadata || {}).extractedModel || null)
      : null,
    review: rec.review || reviewSchema.emptyReviewState(),
  });
  return ddb.compact({
    pk: ddb.S(pkOf(rec.sessionId)),
    gsiPk: ddb.S(GSI_PK),
    lastActivityAt: ddb.S(rec.lastActivityAt),
    createdAt: ddb.S(rec.createdAt),
    expiresAt: ddb.N(rec.expiresAt),
    sessionId: ddb.S(rec.sessionId),
    status: ddb.S(rec.status),
    turnCount: ddb.N(rec.turnCount),
    family: ddb.S(rec.family),
    make: ddb.S(rec.make),
    model: ddb.S(rec.model),
    errorCode: ddb.S(rec.errorCode),
    route: ddb.S(rec.route),
    outcome: ddb.S(rec.outcome),
    safetyStop: ddb.BOOL(rec.safetyStop),
    hasError: ddb.BOOL(rec.hasError),
    searchBlob: ddb.S(rec.searchBlob || ''),
    payload: ddb.S(payload),
    retentionDays: ddb.N(rec.retentionDays || retentionDays()),
    reviewStatus: ddb.S(rec.review && rec.review.status && rec.review.status !== 'none' ? rec.review.status : null),
    reviewPriority: ddb.S(rec.review && rec.review.assessment && rec.review.assessment.reviewPriority),
    reviewOverall: ddb.S(rec.review && rec.review.assessment && rec.review.assessment.overallAssessment),
    reviewOutcome: ddb.S(rec.review && rec.review.assessment && rec.review.assessment.outcome),
  });
}

function itemToRecord(item) {
  if (!item) return null;
  const row = ddb.unmarshall(item);
  let extra = {};
  try { extra = row.payload ? JSON.parse(row.payload) : {}; } catch { extra = {}; }
  return {
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    expiresAt: row.expiresAt,
    retentionDays: row.retentionDays || retentionDays(),
    status: row.status || 'active',
    endedAt: extra.endedAt || null,
    turnCount: row.turnCount || 0,
    family: row.family || null,
    make: row.make || null,
    model: row.model || null,
    errorCode: row.errorCode || null,
    route: row.route || null,
    outcome: row.outcome || null,
    safetyStop: Boolean(row.safetyStop),
    safetyClass: extra.safetyClass || null,
    hasError: Boolean(row.hasError),
    lastRequestId: extra.lastRequestId || null,
    lastTraceId: extra.lastTraceId || null,
    partsCount: extra.partsCount || 0,
    mediaCount: extra.mediaCount || 0,
    turns: Array.isArray(extra.turns) ? extra.turns : [],
    searchBlob: row.searchBlob || '',
    review: extra.review && typeof extra.review === 'object'
      ? reviewSchema.compactReview(extra.review)
      : reviewSchema.emptyReviewState(),
  };
}

function createMemoryStore(seed) {
  const items = new Map(seed || []);
  return {
    kind: 'memory',
    async get(sessionId) {
      return items.get(sessionId) || null;
    },
    async put(rec) {
      items.set(rec.sessionId, rec);
      return rec;
    },
    async list(query, now) {
      const { limit, from, to, cursor, filters } = parseListQuery(query);
      const decoded = decodeCursor(cursor) || {};
      const offset = Number(decoded.offset) || 0;
      const all = Array.from(items.values()).sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
      const dated = all.filter((r) => inDateWindow(r, from, to));
      const filtered = dated.filter((r) => matchesFilters(r, filters, now));
      const slice = filtered.slice(offset, offset + limit);
      const nextOffset = offset + slice.length;
      return {
        items: slice.map((r) => overviewRow(r, now)),
        nextCursor: nextOffset < filtered.length ? encodeCursor({ offset: nextOffset }) : null,
        retention: policy(),
        viewCounts: viewCountsFromRecords(dated),
      };
    },
    async stats(now) {
      const all = Array.from(items.values()).sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
      return statsFromRows(all, now);
    },
    async listRecentRecords(limit, now) {
      const cap = Math.min(200, Math.max(1, Number(limit) || 80));
      const all = Array.from(items.values()).sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
      return all.slice(0, cap);
    },
    async listRecordsSince(fromIso, limit) {
      const cap = Math.min(400, Math.max(1, Number(limit) || 200));
      const all = Array.from(items.values()).sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
      const from = fromIso ? String(fromIso) : '';
      return all.filter((r) => !from || String(r.lastActivityAt || '') >= from).slice(0, cap);
    },
    _items: items,
  };
}

function createDynamoStore(opts) {
  const table = (opts && opts.table) || DEFAULT_TABLE;
  const clientOpts = opts || {};
  async function call(action, payload) {
    return ddb.dynamodb(action, payload, clientOpts);
  }
  return {
    kind: 'dynamodb',
    table: table,
    async get(sessionId) {
      const res = await call('GetItem', {
        TableName: table,
        Key: { pk: ddb.S(pkOf(sessionId)) },
        ConsistentRead: true,
      });
      return res.Item ? itemToRecord(res.Item) : null;
    },
    async put(rec) {
      await call('PutItem', { TableName: table, Item: recordToItem(rec) });
      return rec;
    },
    async list(query, now) {
      const { limit, from, to, cursor, filters } = parseListQuery(query);
      const esk = decodeCursor(cursor);
      // Only declare #sk when the KeyConditionExpression actually references it.
      // With no date filter the query is partition-only (#gsiPk = :pk); declaring an
      // unused #sk makes DynamoDB reject the whole Query with a ValidationException
      // ("ExpressionAttributeNames unused ... {#sk}"), which is what emptied the
      // unfiltered "All" view. The sort key is always #sk = lastActivityAt when present.
      const exprNames = { '#gsiPk': 'gsiPk' };
      const exprValues = { ':pk': ddb.S(GSI_PK) };
      let keyCond = '#gsiPk = :pk';
      if (from && to) {
        exprNames['#sk'] = 'lastActivityAt';
        exprValues[':from'] = ddb.S(from);
        exprValues[':to'] = ddb.S(to);
        keyCond += ' AND #sk BETWEEN :from AND :to';
      } else if (from) {
        exprNames['#sk'] = 'lastActivityAt';
        exprValues[':from'] = ddb.S(from);
        keyCond += ' AND #sk >= :from';
      } else if (to) {
        exprNames['#sk'] = 'lastActivityAt';
        exprValues[':to'] = ddb.S(to);
        keyCond += ' AND #sk <= :to';
      }
      // Fetch a window larger than page size so FilterExpression still fills a page.
      const res = await call('Query', ddb.compact({
        TableName: table,
        IndexName: GSI_NAME,
        KeyConditionExpression: keyCond,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ScanIndexForward: false,
        Limit: Math.min(100, Math.max(limit * 4, limit)),
        ExclusiveStartKey: esk || undefined,
      }));
      const rows = (res.Items || []).map(itemToRecord).filter(Boolean)
        .filter((r) => matchesFilters(r, filters, now));
      const page = rows.slice(0, limit);
      const next = res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
      let countSource;
      if (from) countSource = await this.listRecordsSince(from, 400);
      else countSource = await this.listRecentRecords(400);
      if (to) countSource = (countSource || []).filter((r) => inDateWindow(r, null, to));
      return {
        items: page.map((r) => overviewRow(r, now)),
        nextCursor: next,
        retention: policy(),
        viewCounts: viewCountsFromRecords(countSource),
      };
    },
    async stats(now) {
      const from = startOfUtcDay(now || new Date());
      const res = await call('Query', {
        TableName: table,
        IndexName: GSI_NAME,
        KeyConditionExpression: '#gsiPk = :pk AND #sk >= :from',
        ExpressionAttributeNames: { '#gsiPk': 'gsiPk', '#sk': 'lastActivityAt' },
        ExpressionAttributeValues: { ':pk': ddb.S(GSI_PK), ':from': ddb.S(from) },
        ScanIndexForward: false,
        Limit: 200,
      });
      const rows = (res.Items || []).map(itemToRecord).filter(Boolean);
      const recent = await this.listRecentRecords(200, now);
      const today = statsFromRows(rows, now);
      today.quality = require('./transcript-review/aggregates').fromRecords(recent, now);
      return today;
    },
    async listRecentRecords(limit) {
      const cap = Math.min(200, Math.max(1, Number(limit) || 80));
      const res = await call('Query', {
        TableName: table,
        IndexName: GSI_NAME,
        KeyConditionExpression: '#gsiPk = :pk',
        ExpressionAttributeNames: { '#gsiPk': 'gsiPk' },
        ExpressionAttributeValues: { ':pk': ddb.S(GSI_PK) },
        ScanIndexForward: false,
        Limit: cap,
      });
      return (res.Items || []).map(itemToRecord).filter(Boolean);
    },
    async listRecordsSince(fromIso, limit) {
      const cap = Math.min(400, Math.max(1, Number(limit) || 200));
      const from = fromIso ? String(fromIso) : startOfUtcDay(new Date());
      const res = await call('Query', {
        TableName: table,
        IndexName: GSI_NAME,
        KeyConditionExpression: '#gsiPk = :pk AND #sk >= :from',
        ExpressionAttributeNames: { '#gsiPk': 'gsiPk', '#sk': 'lastActivityAt' },
        ExpressionAttributeValues: { ':pk': ddb.S(GSI_PK), ':from': ddb.S(from) },
        ScanIndexForward: false,
        Limit: cap,
      });
      return (res.Items || []).map(itemToRecord).filter(Boolean);
    },
  };
}

async function persistTurn(store, obs, input) {
  if (!store || !obs || obs.event === 'end') return { skipped: true };
  if (!isValidSessionId(obs.sessionId)) return { skipped: true };
  const turn = buildTurn({
    messages: input.messages,
    view: input.view,
    orch: input.orch,
    requestId: input.requestId,
    clientTurnId: obs.clientTurnId,
    now: input.now,
    canonical: input.canonical || null,
  });
  let rec = await store.get(obs.sessionId);
  if (!rec) rec = emptyRecord(obs.sessionId, input.now);
  rec = applyTurn(rec, turn, input.now);
  await store.put(rec);
  return { ok: true, sessionId: obs.sessionId, turnCount: rec.turnCount };
}

/**
 * An idempotent duplicate was answered from the cached view (no orchestrator call, nothing merged): mark the
 * ORIGINAL turn's canonical audit as replayed. Text, trace and decisions of that turn are left untouched.
 */
async function persistReplay(store, obs, now) {
  if (!store || !obs || !isValidSessionId(obs.sessionId) || !obs.clientTurnId) return { skipped: true };
  const rec = await store.get(obs.sessionId);
  if (!rec) return { skipped: true, reason: 'unknown-session' };
  const t = (rec.turns || []).find((x) => x && x.clientTurnId === obs.clientTurnId);
  if (!t) return { skipped: true, reason: 'unknown-turn' };
  t.canonical = canonicalAudit.markReplay(t.canonical || { schemaVersion: canonicalAudit.SCHEMA_VERSION, path: 'legacy', persistence: {} }, nowIso(now));
  rec.lastActivityAt = nowIso(now);
  await store.put(rec);
  return { ok: true, sessionId: obs.sessionId, seq: t.seq };
}

async function persistEnd(store, obs, now) {
  if (!store || !obs || !isValidSessionId(obs.sessionId)) return { skipped: true };
  const rec = await store.get(obs.sessionId);
  if (!rec) return { skipped: true, reason: 'unknown-session' };
  await store.put(applyEnd(rec, now));
  return { ok: true, sessionId: obs.sessionId, status: 'ended' };
}

async function persistSafely(store, fn, log) {
  try {
    return await fn();
  } catch (e) {
    if (typeof log === 'function') {
      log({ evt: 'transcript-persist-failed', error: String(e && e.message || e) });
    }
    return { ok: false, error: 'persist-failed' };
  }
}

module.exports = {
  canonicalSummary,
  enforcePayloadBudget,
  PAYLOAD_BUDGET_BYTES,
  HELP_HUBS,
  DEFAULT_TABLE,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_INACTIVE_MS,
  MAX_TURNS,
  takeObservability,
  isValidSessionId,
  isValidTurnId,
  retentionDays,
  inactiveAfterMs,
  policy,
  emptyRecord,
  buildTurn,
  applyTurn,
  applyEnd,
  deriveLifecycle,
  overviewRow,
  openingPreview,
  viewCountsFromRecords,
  drillDown,
  parseListQuery,
  matchesFilters,
  encodeCursor,
  decodeCursor,
  statsFromRows,
  createMemoryStore,
  createDynamoStore,
  persistTurn,
  persistEnd,
  persistReplay,
  persistSafely,
  reviewOverview,
  semanticReviewView,
  customerTextFromMessages,
  customerVisibleFromView,
  metadataFromPath,
  forbiddenKeysIn,
  stripSecrets,
  normaliseDiagnosticTrace,
  stateProgression,
  slimTrace,
  boundTraceHistory,
  TRACE_FULL_TURNS,
};
