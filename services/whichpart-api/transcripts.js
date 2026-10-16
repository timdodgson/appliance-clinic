'use strict';

/**
 * ApplianceClinic production transcript observability.
 *
 * An anonymous record of diagnostic conversations, one DynamoDB item per session. The browser localStorage session
 * remains the customer UX source of truth. This module must never alter diagnostic semantics, never store photo
 * bytes / EXIF / model reasoning / IP / credentials, and never throw into the customer path.
 *
 * Each turn stores what the customer saw and, for the ac2 turn, the engine's bounded audit (ac2-turn.js auditOf):
 * provider, timings, token usage, tool calls, hazards and gates, the part decision and the advisor's outcome.
 */

const ddb = require('./ddb');

const DEFAULT_TABLE = process.env.TRANSCRIPT_TABLE || 'whichpart-transcripts';
const DEFAULT_RETENTION_DAYS = Number(process.env.TRANSCRIPT_RETENTION_DAYS) || 90;
const DEFAULT_INACTIVE_MS = (Number(process.env.TRANSCRIPT_INACTIVE_MINUTES) || 120) * 60 * 1000;
const GSI_NAME = process.env.TRANSCRIPT_GSI || 'gsi_activity';
const GSI_PK = 'T';
const MAX_TURNS = 80;
// The whole session is ONE DynamoDB item (400 KB hard limit). Older turns keep only the summary form of their audit;
// above this payload budget the full-detail window narrows further before the write.
const AUDIT_FULL_TURNS = 16;
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
  };
}

function compactPart(p) {
  if (!p || typeof p !== 'object') return null;
  const name = p.name || p.title || null;
  if (!name) return null;
  return { name: clip(name, 160), fitStatus: p.fitStatus ? String(p.fitStatus).slice(0, 40) : null };
}

function compactMedia(m) {
  if (!m || typeof m !== 'object') return null;
  if (!m.id && !m.title && !m.type) return null;
  return { id: m.id ? clip(m.id, 80) : null, type: m.type ? clip(m.type, 20) : null, title: m.title ? clip(m.title, 160) : '' };
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
  return { reply: clip(v.reply || '', MAX_TEXT), safetyText: safetyText ? clip(safetyText, 900) : null, parts, media };
}

/** Turn metadata: what the record knows (the engine's audit) and what the view carried. */
function metadataFromPath(orch, view, rid, ac2) {
  const safety = (orch && orch.safety) || {};
  const si = view && view.safetyInformation;
  const c = (ac2 && ac2.customer) || {};
  return {
    requestId: rid || (view && view.requestId) || null,
    route: (orch && orch.route) || null,
    outcome: (view && view.error) ? 'ERROR' : ((orch && orch.outcome) || null),
    family: c.appliance || null,
    make: c.brand || null,
    model: c.model ? clip(c.model, 80) : ((orch && orch.resolvedModel) ? clip(orch.resolvedModel, 80) : null),
    errorCode: ac2 && ac2.tags && ac2.tags.enrichment && Array.isArray(ac2.tags.enrichment.codes) && ac2.tags.enrichment.codes[0] ? clip(ac2.tags.enrichment.codes[0].code, 16) : null,
    safetyStop: Boolean(view && view.safety) || Boolean(safety.stopUse) || (orch && orch.outcome === 'SAFETY_STOP'),
    safetyClass: safety.class || (si && si.classification) || null,
    apiError: Boolean(view && view.error),
  };
}

function stripSecrets(obj) {
  // Defence in depth: never persist obvious secret/debug shapes even if a caller accidentally forwarded them.
  const json = JSON.stringify(obj, (k, v) => {
    const key = String(k || '').toLowerCase();
    if (/password|secret|authorization|cookie|api.?token|access.?token|api.?key|access.?key|exif|chain.of.thought|reasoning|ipaddress|ip_address|user-agent|useragent|fingerprint/.test(key)) {
      return undefined;
    }
    if (typeof v === 'string' && /^data:image\//i.test(v)) return '[photo omitted]';
    if (typeof v === 'string' && v.length > 200 && /^[A-Za-z0-9+/=]{80,}$/.test(v) && !/\s/.test(v)) return '[binary omitted]';
    return v;
  });
  return JSON.parse(json);
}

// ---- the ac2 audit (ac2-turn.js auditOf) --------------------------------------------------------------
// Stored on the turn as `ac2`. Bounded here regardless of what the engine sent: lists are capped, strings clipped, and
// only known fields are kept. A turn stored before change 23.3 (schema /1) carries the same core fields.
const AC2_SCHEMAS = new Set(['ac2-transcript-audit/1', 'ac2-transcript-audit/2']);
const AC2_SCHEMA = 'ac2-transcript-audit/2';
const AC2_MAX_LIST = 20;
function ac2Str(v, n) { return v == null ? null : clip(String(v), n || 120); }
function ac2List(v, n) { return Array.isArray(v) ? v.slice(0, n || AC2_MAX_LIST) : []; }
function ac2Num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function ac2NumMap(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of Object.keys(o).slice(0, 12)) { if (ac2Num(o[k]) != null) out[clip(k, 40)] = o[k]; }
  return out;
}
function ac2Safety(sf) {
  if (!sf || typeof sf !== 'object') return null;
  return {
    hazards: ac2List(sf.hazards).map((h) => ac2Str(h, 40)),
    terminated: ac2Str(sf.terminated, 40),
    gates: ac2List(sf.gates).map((g) => (g && typeof g === 'object'
      ? { gate: ac2Str(g.gate, 40), rule: ac2Str(g.rule, 80), type: ac2Str(g.type, 40), removed: ac2Num(g.removed), ids: ac2List(g.ids, 6).map((x) => ac2Str(x, 40)) } : { gate: ac2Str(g, 40) })),
  };
}
function ac2Customer(a) {
  const c = a.customer && typeof a.customer === 'object' ? a.customer : (a.ledger && typeof a.ledger === 'object' ? a.ledger : {});
  const v = (x) => (x && typeof x === 'object' ? x.value : x);
  return { appliance: ac2Str(v(c.appliance), 40), brand: ac2Str(v(c.brand), 40), model: ac2Str(v(c.model), 40) };
}
function ac2Tags(t) {
  if (!t || typeof t !== 'object') return null;
  const e = t.enrichment && typeof t.enrichment === 'object' ? t.enrichment : {};
  return {
    outcome: ac2Str(t.outcome, 40),
    media: ac2Str(t.media, 120),
    enrichment: { knowledgeIds: ac2List(e.knowledgeIds).map((x) => ac2Str(x, 80)), codes: ac2List(e.codes).map((x) => ({ code: ac2Str(x && x.code, 16), status: ac2Str(x && x.status, 24) })), recalls: ac2Num(e.recalls), parts: ac2Str(e.parts, 40) },
  };
}
/** Bounded ac2 audit for the transcript turn (or null when the input is not an ac2 audit object). */
function slimAc2Audit(a, opts) {
  if (!a || typeof a !== 'object' || !AC2_SCHEMAS.has(a.schemaVersion)) return null;
  const summaryOnly = Boolean(opts && opts.summary) || Boolean(a.slim);
  const pv = a.provider && typeof a.provider === 'object' ? { name: ac2Str(a.provider.name, 40), model: ac2Str(a.provider.model, 80) } : null;
  const out = {
    schemaVersion: AC2_SCHEMA,
    path: 'ac2',
    turn: ac2Num(a.turn),
    error: a.error ? ac2Str(a.error, 80) : null,
    provider: pv,
    timings: ac2NumMap(a.timings),
    ms: ac2Num(a.ms),
    usage: ac2NumMap(a.usage),
    outcome: ac2Str(a.outcome || (a.status && typeof a.status === 'object' ? a.status.value : a.status), 40),
    customer: ac2Customer(a),
    hazards: ac2List(a.hazards).map((h) => ac2Str(h && typeof h === 'object' ? h.type : h, 40)).filter(Boolean),
    partGate: a.partGate && typeof a.partGate === 'object' ? { outcome: ac2Str(a.partGate.outcome, 40), component: ac2Str(a.partGate.component, 80) } : null,
    escalation: a.escalation && typeof a.escalation === 'object'
      ? { to: ac2Str(a.escalation.to, 40), reason: ac2Str(a.escalation.reason, 200), forced: Boolean(a.escalation.forced) } : null,
    safety: ac2Safety(a.safety),
  };
  if (summaryOnly) { out.slim = true; return out; }
  out.toolCalls = ac2List(a.toolCalls, 12).map((c) => ac2Str(c && typeof c === 'object' ? c.tool : c, 40)).filter(Boolean);
  out.tags = ac2Tags(a.tags);
  return out;
}

// Keep the full audit for the most recent AUDIT_FULL_TURNS turns; older ones keep the summary form.
function boundAuditHistory(turns, keep) {
  if (!Array.isArray(turns)) return;
  const cut = turns.length - (keep == null ? AUDIT_FULL_TURNS : keep);
  for (let i = 0; i < cut; i++) {
    const t = turns[i];
    if (t && t.ac2 && !t.ac2.slim) t.ac2 = slimAc2Audit(t.ac2, { summary: true });
  }
}

// Keep the session item under budget: progressively narrow the full-detail window (never drops turns or text).
function enforcePayloadBudget(rec) {
  for (const keep of [8, 4, 1, 0]) {
    if (Buffer.byteLength(JSON.stringify(rec.turns || []), 'utf8') <= PAYLOAD_BUDGET_BYTES) return;
    boundAuditHistory(rec.turns, keep);
  }
}

/** Session-level summary of the ac2 turns, computed on read (historical records need no migration). */
function ac2Summary(rec) {
  const turns = (rec && rec.turns) || [];
  const out = { turns: 0, errors: 0, outcome: null, hazards: [], partRecommended: false, escalation: null, appliance: null };
  for (const t of turns) {
    if (t && t.customerVisible && Array.isArray(t.customerVisible.parts) && t.customerVisible.parts.length) out.partRecommended = true;
    const x = t && t.ac2;
    if (!x || !AC2_SCHEMAS.has(x.schemaVersion)) continue;
    out.turns += 1;
    if (x.error) { out.errors += 1; continue; }
    // Audits written by the earlier schema (/1) carry a ledger and a status instead of customer and outcome.
    const cust = ac2Customer(x);
    if (cust.appliance) out.appliance = cust.appliance;
    const outcome = x.outcome || (x.status && typeof x.status === 'object' ? x.status.value : x.status);
    if (outcome) out.outcome = ac2Str(outcome, 40);
    if (x.partGate && x.partGate.outcome === 'verified') out.partRecommended = true;
    if (x.escalation && x.escalation.to) out.escalation = x.escalation.to;
    for (const h of (x.safety && x.safety.hazards) || []) { if (h && !out.hazards.includes(h)) out.hazards.push(h); }
  }
  return out;
}

function buildTurn(input) {
  const now = input.now || new Date();
  const customer = customerTextFromMessages(input.messages);
  const visible = customerVisibleFromView(input.view);
  const ac2 = input.ac2 ? slimAc2Audit(stripSecrets(input.ac2)) : null;
  const meta = metadataFromPath(input.orch, input.view, input.requestId, ac2);
  const turn = stripSecrets({
    seq: 0,
    at: nowIso(now),
    clientTurnId: input.clientTurnId || null,
    customer: { text: customer.text, photo: customer.photo },
    customerVisible: visible,
    metadata: meta,
  });
  if (ac2) turn.ac2 = ac2;
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
    // A later turn after New Chat belongs to a new browser session id, not this record. Ignore (idempotent no-op)
    // rather than resurrecting an ended session.
    return rec;
  }
  rec.status = 'active';
  const turns = Array.isArray(rec.turns) ? rec.turns.slice() : [];
  const id = turn.clientTurnId;
  let idx = -1;
  if (id) idx = turns.findIndex((t) => t && t.clientTurnId === id);
  if (idx >= 0) {
    turn.seq = turns[idx].seq;
    turns[idx] = turn;
  } else {
    turn.seq = turns.length + 1;
    turns.push(turn);
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
  }
  boundAuditHistory(turns);
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
  rec.partsCount = (last && last.customerVisible && last.customerVisible.parts) ? last.customerVisible.parts.length : rec.partsCount;
  rec.mediaCount = (last && last.customerVisible && last.customerVisible.media) ? last.customerVisible.media.length : rec.mediaCount;
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
  const counts = { all: 0, safety: 0, errors: 0, parts: 0 };
  for (const rec of records || []) {
    counts.all += 1;
    if (rec && rec.safetyStop) counts.safety += 1;
    if (rec && rec.hasError) counts.errors += 1;
    if (ac2Summary(rec).partRecommended) counts.parts += 1;
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
  const s = ac2Summary(rec);
  return {
    sessionId: rec.sessionId,
    shortId: String(rec.sessionId || '').slice(0, 8),
    createdAt: rec.createdAt,
    lastActivityAt: rec.lastActivityAt,
    endedAt: rec.endedAt || null,
    lifecycle: deriveLifecycle(rec, now),
    turnCount: rec.turnCount || 0,
    family: rec.family || s.appliance || null,
    make: rec.make || null,
    model: rec.model || null,
    errorCode: rec.errorCode || null,
    outcome: rec.outcome || null,
    safetyStop: Boolean(rec.safetyStop),
    safetyClass: rec.safetyClass || null,
    hasError: Boolean(rec.hasError),
    partsCount: rec.partsCount || 0,
    mediaCount: rec.mediaCount || 0,
    openingPreview: openingPreview(rec),
    ac2: s,
    partRecommended: s.partRecommended,
  };
}

function drillDown(rec, now) {
  const turnList = rec.turns || [];
  const turns = turnList.map((t) => ({
    seq: t.seq,
    at: t.at,
    customer: t.customer || { text: '', photo: false },
    applianceClinic: t.customerVisible || { reply: '' },
    ac2: t.ac2 || null,
    runtime: t.metadata ? { route: t.metadata.route || null, outcome: t.metadata.outcome || null, requestId: t.metadata.requestId || null,
      safetyStop: Boolean(t.metadata.safetyStop), safetyClass: t.metadata.safetyClass || null, apiError: Boolean(t.metadata.apiError) } : null,
  }));
  const last = turnList[turnList.length - 1] || {};
  return {
    retention: {
      days: rec.retentionDays || retentionDays(),
      expiresAt: rec.expiresAt || null,
      policy: 'Anonymous production transcripts are kept for ' + (rec.retentionDays || retentionDays()) + ' days, then deleted automatically (DynamoDB TTL).',
    },
    overview: overviewRow(rec, now),
    customerVisible: { label: 'CUSTOMER SAW THIS', turns },
    diagnosticMetadata: {
      label: 'INTERNAL DIAGNOSTIC METADATA',
      createdAt: rec.createdAt,
      lastActivityAt: rec.lastActivityAt,
      endedAt: rec.endedAt,
      lifecycle: deriveLifecycle(rec, now),
      family: rec.family || (last.metadata && last.metadata.family) || null,
      make: rec.make || (last.metadata && last.metadata.make) || null,
      model: rec.model || (last.metadata && last.metadata.model) || null,
      errorCode: rec.errorCode || (last.metadata && last.metadata.errorCode) || null,
      outcome: rec.outcome || (last.metadata && last.metadata.outcome) || null,
      safetyStop: Boolean(rec.safetyStop),
      safetyClass: rec.safetyClass || null,
      hasError: Boolean(rec.hasError),
      lastRequestId: rec.lastRequestId || null,
      partsSurfaced: last.customerVisible ? last.customerVisible.parts : [],
      mediaSurfaced: last.customerVisible ? last.customerVisible.media : [],
    },
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
  const fam = rec.family || ac2Summary(rec).appliance || '';
  if (f.family && String(fam).toLowerCase() !== String(f.family).toLowerCase()) return false;
  if (f.make && String(rec.make || '').toLowerCase() !== String(f.make).toLowerCase()) return false;
  if (f.errors === true && !rec.hasError) return false;
  if (f.safety === true && !rec.safetyStop) return false;
  if (f.partRecommended != null || f.degraded === true || f.outcome) {
    const s = ac2Summary(rec);
    if (f.partRecommended != null && s.partRecommended !== f.partRecommended) return false;
    if (f.degraded === true && !s.errors) return false;
    if (f.outcome && f.outcome !== 'all' && s.outcome !== f.outcome) return false;
  }
  if (f.q) {
    const q = String(f.q).toLowerCase();
    if (q.length >= 3) {
      const blob = rec.searchBlob || searchBlobFrom(rec);
      if (!blob.includes(q)) return false;
    }
  }
  return true;
}

const OUTCOMES = ['diagnosing', 'part_needed', 'engineer', 'normal', 'fixed', 'out_of_scope', 'safety_stop'];

function parseListQuery(qs) {
  const q = qs || {};
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 25));
  const from = q.from ? String(q.from) : null;
  const to = q.to ? String(q.to) : null;
  const filters = {
    family: q.family ? String(q.family).slice(0, 40) : '',
    make: q.make ? String(q.make).slice(0, 40) : '',
    lifecycle: q.lifecycle ? String(q.lifecycle).slice(0, 20) : '',
    errors: q.errors === '1' || q.errors === 'true',
    safety: q.safety === '1' || q.safety === 'true',
    q: q.q ? String(q.q).slice(0, 80) : '',
    outcome: OUTCOMES.includes(q.outcome) ? q.outcome : '',
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
  let partSessions = 0;
  const families = {};
  for (const r of rows) {
    const last = r.lastActivityAt || r.createdAt || '';
    if (last >= today) {
      sessionsToday += 1;
      turnsToday += r.turnCount || 0;
      if (r.hasError) errorSessions += 1;
      if (r.safetyStop) safetySessions += 1;
      if (ac2Summary(r).partRecommended) partSessions += 1;
      const fam = r.family || ac2Summary(r).appliance || 'unknown';
      families[fam] = (families[fam] || 0) + 1;
    }
  }
  const familyDistribution = Object.keys(families).sort((a, b) => families[b] - families[a]).map((k) => ({ family: k, count: families[k] }));
  return {
    generatedAt: nowIso(now),
    retentionDays: retentionDays(),
    inactiveAfterMinutes: Math.round(inactiveAfterMs() / 60000),
    sessionsToday,
    turnsToday,
    errorSessionsToday: errorSessions,
    safetySessionsToday: safetySessions,
    partSessionsToday: partSessions,
    familyDistribution,
    recent: rows.slice(0, 8).map((r) => overviewRow(r, now)),
  };
}

function policy() {
  return {
    retentionDays: retentionDays(),
    inactiveAfterMinutes: Math.round(inactiveAfterMs() / 60000),
    table: process.env.TRANSCRIPT_TABLE || DEFAULT_TABLE,
    ttlAttribute: 'expiresAt',
    summary: 'Anonymous diagnostic transcripts are stored for ' + retentionDays() + ' days and then deleted by DynamoDB TTL. They are not customer accounts. '
      + 'Browser localStorage remains the live chat source of truth. A session is marked ended only when the customer uses New Chat. '
      + 'Sessions with no further activity after ' + Math.round(inactiveAfterMs() / 60000) + ' minutes are shown as inactive — not completed.',
    stored: [
      'anonymous session id',
      'created / last-activity timestamps',
      'ordered customer and ApplianceClinic turns (visible text)',
      'photo-present flag (never bytes)',
      'appliance, make and model as the advisor recorded them',
      'outcome, safety classification, parts/media surfaced, request ids',
      'the engine\'s bounded per-turn audit: provider, timings, token usage, tool calls, hazards and gates, part decision',
      'API error flag',
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
  };
}

function createMemoryStore(seed) {
  const items = new Map(seed || []);
  const sorted = () => Array.from(items.values()).sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
  return {
    kind: 'memory',
    async get(sessionId) { return items.get(sessionId) || null; },
    async put(rec) { items.set(rec.sessionId, rec); return rec; },
    async list(query, now) {
      const { limit, from, to, cursor, filters } = parseListQuery(query);
      const decoded = decodeCursor(cursor) || {};
      const offset = Number(decoded.offset) || 0;
      const dated = sorted().filter((r) => inDateWindow(r, from, to));
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
    async stats(now) { return statsFromRows(sorted(), now); },
    async listRecentRecords(limit) {
      const cap = Math.min(200, Math.max(1, Number(limit) || 80));
      return sorted().slice(0, cap);
    },
    async listRecordsSince(fromIso, limit) {
      const cap = Math.min(400, Math.max(1, Number(limit) || 200));
      const from = fromIso ? String(fromIso) : '';
      return sorted().filter((r) => !from || String(r.lastActivityAt || '') >= from).slice(0, cap);
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
      const res = await call('GetItem', { TableName: table, Key: { pk: ddb.S(pkOf(sessionId)) }, ConsistentRead: true });
      return res.Item ? itemToRecord(res.Item) : null;
    },
    async put(rec) {
      await call('PutItem', { TableName: table, Item: recordToItem(rec) });
      return rec;
    },
    async list(query, now) {
      const { limit, from, to, cursor, filters } = parseListQuery(query);
      const esk = decodeCursor(cursor);
      // Only declare #sk when the KeyConditionExpression references it: DynamoDB rejects an unused name.
      const exprNames = { '#gsiPk': 'gsiPk' };
      const exprValues = { ':pk': ddb.S(GSI_PK) };
      let keyCond = '#gsiPk = :pk';
      if (from && to) {
        exprNames['#sk'] = 'lastActivityAt'; exprValues[':from'] = ddb.S(from); exprValues[':to'] = ddb.S(to);
        keyCond += ' AND #sk BETWEEN :from AND :to';
      } else if (from) {
        exprNames['#sk'] = 'lastActivityAt'; exprValues[':from'] = ddb.S(from);
        keyCond += ' AND #sk >= :from';
      } else if (to) {
        exprNames['#sk'] = 'lastActivityAt'; exprValues[':to'] = ddb.S(to);
        keyCond += ' AND #sk <= :to';
      }
      // Fetch a window larger than page size so the filters still fill a page.
      const res = await call('Query', ddb.compact({
        TableName: table, IndexName: GSI_NAME, KeyConditionExpression: keyCond,
        ExpressionAttributeNames: exprNames, ExpressionAttributeValues: exprValues,
        ScanIndexForward: false, Limit: Math.min(100, Math.max(limit * 4, limit)), ExclusiveStartKey: esk || undefined,
      }));
      const rows = (res.Items || []).map(itemToRecord).filter(Boolean).filter((r) => matchesFilters(r, filters, now));
      const page = rows.slice(0, limit);
      const next = res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
      let countSource;
      if (from) countSource = await this.listRecordsSince(from, 400);
      else countSource = await this.listRecentRecords(400);
      if (to) countSource = (countSource || []).filter((r) => inDateWindow(r, null, to));
      return { items: page.map((r) => overviewRow(r, now)), nextCursor: next, retention: policy(), viewCounts: viewCountsFromRecords(countSource) };
    },
    async stats(now) {
      const from = startOfUtcDay(now || new Date());
      const res = await call('Query', {
        TableName: table, IndexName: GSI_NAME, KeyConditionExpression: '#gsiPk = :pk AND #sk >= :from',
        ExpressionAttributeNames: { '#gsiPk': 'gsiPk', '#sk': 'lastActivityAt' }, ExpressionAttributeValues: { ':pk': ddb.S(GSI_PK), ':from': ddb.S(from) },
        ScanIndexForward: false, Limit: 200,
      });
      return statsFromRows((res.Items || []).map(itemToRecord).filter(Boolean), now);
    },
    async listRecentRecords(limit) {
      const cap = Math.min(200, Math.max(1, Number(limit) || 80));
      const res = await call('Query', {
        TableName: table, IndexName: GSI_NAME, KeyConditionExpression: '#gsiPk = :pk',
        ExpressionAttributeNames: { '#gsiPk': 'gsiPk' }, ExpressionAttributeValues: { ':pk': ddb.S(GSI_PK) }, ScanIndexForward: false, Limit: cap,
      });
      return (res.Items || []).map(itemToRecord).filter(Boolean);
    },
    async listRecordsSince(fromIso, limit) {
      const cap = Math.min(400, Math.max(1, Number(limit) || 200));
      const from = fromIso ? String(fromIso) : startOfUtcDay(new Date());
      const res = await call('Query', {
        TableName: table, IndexName: GSI_NAME, KeyConditionExpression: '#gsiPk = :pk AND #sk >= :from',
        ExpressionAttributeNames: { '#gsiPk': 'gsiPk', '#sk': 'lastActivityAt' }, ExpressionAttributeValues: { ':pk': ddb.S(GSI_PK), ':from': ddb.S(from) },
        ScanIndexForward: false, Limit: cap,
      });
      return (res.Items || []).map(itemToRecord).filter(Boolean);
    },
  };
}

async function persistTurn(store, obs, input) {
  if (!store || !obs || obs.event === 'end') return { skipped: true };
  if (!isValidSessionId(obs.sessionId)) return { skipped: true };
  const turn = buildTurn({ messages: input.messages, view: input.view, orch: input.orch, requestId: input.requestId, clientTurnId: obs.clientTurnId, now: input.now, ac2: input.ac2 || null });
  let rec = await store.get(obs.sessionId);
  if (!rec) rec = emptyRecord(obs.sessionId, input.now);
  rec = applyTurn(rec, turn, input.now);
  await store.put(rec);
  return { ok: true, sessionId: obs.sessionId, turnCount: rec.turnCount };
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
    if (typeof log === 'function') log({ evt: 'transcript-persist-failed', error: String(e && e.message || e) });
    return { ok: false, error: 'persist-failed' };
  }
}

module.exports = {
  ac2Summary, slimAc2Audit, AC2_SCHEMA, boundAuditHistory, enforcePayloadBudget, PAYLOAD_BUDGET_BYTES, AUDIT_FULL_TURNS,
  HELP_HUBS, DEFAULT_TABLE, DEFAULT_RETENTION_DAYS, DEFAULT_INACTIVE_MS, MAX_TURNS, OUTCOMES,
  takeObservability, isValidSessionId, isValidTurnId, retentionDays, inactiveAfterMs, policy, emptyRecord, buildTurn, applyTurn, applyEnd,
  deriveLifecycle, overviewRow, openingPreview, viewCountsFromRecords, drillDown, parseListQuery, matchesFilters, encodeCursor, decodeCursor,
  statsFromRows, createMemoryStore, createDynamoStore, persistTurn, persistEnd, persistSafely,
  customerTextFromMessages, customerVisibleFromView, metadataFromPath, stripSecrets,
};
