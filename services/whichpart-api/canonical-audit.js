'use strict';
/**
 * canonical-audit/1 — the bounded, admin-safe per-turn snapshot of canonical decisions that the transcript stores
 * (services/whichpart-api/docs/transcript-canonical-audit.md).
 *
 * buildCanonicalTranscriptAudit({ ctx, out, result, trace }) receives STRUCTURED data only:
 *   ctx     the BFF canonical turn context (conversation-state.prepareTurn): mode, csid, version, priorState, …
 *   out     part-finder's merged transport result (`orch._canonical`): classification, state, journey, rules, …
 *   result  canonicalFinish's persistence result: written, recordWritten, degraded
 *   trace   the orchestrator diagnostic trace (only the part-finder `canonical-control` stage is read: COMPOSE)
 *
 * The transcript is an AUDIT copy, never a source of truth: canonical state lives in STATE# / STATETURN#, and
 * nothing reads this block back into runtime. It never contains the state body, the csid (only `ref`), the
 * signed token, prompts, secrets or customer prose (the message itself is already the transcript text).
 * The state delta is computed from the typed prior / new cs/1 states, never from prose.
 */
const crypto = require('crypto');

const SCHEMA_VERSION = 'canonical-audit/1';
const MAX_AUDIT_BYTES = 8 * 1024;        // hard ceiling per turn (tested); larger blocks are trimmed, then reduced
const MAX_DELTA = 40;
const MAX_LIST = 12;
const STR = 80;

const s = (v, n = STR) => (v == null || v === '' ? null : String(v).slice(0, n));
const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const sessionRef = (csid) => (csid ? crypto.createHash('sha256').update('cs-ref:' + csid).digest('hex').slice(0, 12) : null);
const digest16 = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
/** Drop null / undefined / empty-array / empty-object keys (the UI never shows dozens of nulls). */
function prune(o) {
  if (Array.isArray(o)) return o.map(prune);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const p = prune(v);
    if (p == null) continue;
    if (Array.isArray(p) && !p.length) continue;
    if (typeof p === 'object' && !Array.isArray(p) && !Object.keys(p).length) continue;
    out[k] = p;
  }
  return out;
}

// ---- 1. classification (mc/1 tags of the latest message) ----------------------------------------------------
function classificationTags(c) {
  if (!c || typeof c !== 'object') return null;
  const id = c.identity || {};
  const p = c.problem || {};
  const sf = c.safety || {};
  const r = c.reply || {};
  const m = c.mentions || {};
  return prune({
    scope: s(c.scope),
    appliance: id.appliance && id.appliance.value ? { value: s(id.appliance.value), basis: s(id.appliance.basis) } : null,
    make: id.make && id.make.value ? { value: s(id.make.value), basis: s(id.make.basis) } : null,
    model: id.model && id.model.value ? { value: s(id.model.value, 40), basis: s(id.model.basis) } : null,
    modelStatus: s(id.modelStatus),
    fuel: s(id.fuel),
    displayedCode: s(id.displayedCode, 20),
    intent: s(c.intent),
    faultDomain: s(p.faultDomain),
    journey: s(p.journey),
    symptomScope: s(p.scope),
    relation: s(p.relation),
    hazard: s(sf.hazard),
    unsafeAction: s(sf.unsafeAction),
    reply: { toPending: s(r.toPending), outcome: s(r.outcome), correction: (r.correction || []).slice(0, 6).map((x) => s(typeof x === 'string' ? x : (x && (x.field || x.path)))) },
    observations: (c.observations || []).slice(0, MAX_LIST).map((o) => o && { key: s(o.key), value: o.value == null ? null : (typeof o.value === 'object' ? s(JSON.stringify(o.value)) : o.value) }),
    checks: (c.checks || []).slice(0, MAX_LIST).map((k) => k && { check: s(k.check), status: s(k.status), result: s(k.result) }),
    mentions: { replacedParts: (m.replacedParts || []).slice(0, 6).map((x) => s(typeof x === 'string' ? x : x && x.part)),
      customerTheories: (m.customerTheories || []).slice(0, 6).map((x) => s(typeof x === 'string' ? x : x && x.theory)) },
  });
}

// ---- 2. state delta (typed prior cs/1 → new cs/1) -----------------------------------------------------------
const factVal = (f) => (f && f.value != null && f.status !== 'superseded' ? f.value : null);
const activeProblem = (st) => ((st && st.problems) || []).filter((p) => p && p.status === 'active').pop() || null;
const reqById = (st, id) => ((st && st.requests) || []).find((r) => r && r.id === id) || null;
function compactRequest(r) {
  return r ? prune({ slot: s(r.slot), target: s(r.target), purpose: s(r.purpose), kind: s(r.kind), askedTurn: Number.isInteger(r.askedTurn) ? r.askedTurn : null,
    rule: s(r.rule, 20), journey: s(r.journey) }) : null;
}
function flatState(st) {
  const f = {};
  if (!st || typeof st !== 'object') return f;
  const id = st.identity || {};
  f['appliance'] = factVal(id.appliance);
  f['appliance.establishment'] = id.applianceEstablishment || null;
  f['make'] = factVal(id.make);
  f['model'] = factVal(id.model);
  f['modelConfirmed'] = id.model && id.model.value ? Boolean(id.model.confirmed) : null;
  f['modelStatus'] = id.modelStatus || null;
  f['fuel'] = factVal(id.fuel);
  f['displayedCode'] = ((id.displayedCodes || []).filter((x) => x && x.status === 'active').map((x) => x.value).join(',')) || null;
  f['intent'] = (st.intent && st.intent.active) || null;
  const ap = activeProblem(st);
  f['problem'] = ap ? ap.id : null;
  f['journey'] = ap ? factVal(ap.journey) : null;
  f['faultDomain'] = ap ? factVal(ap.faultDomain) : null;
  f['symptomScope'] = ap ? factVal(ap.scope) : null;
  const ev = st.evidence || {};
  for (const [k, o] of Object.entries(ev.observations || {})) f[`observation.${k}`] = o && o.status !== 'superseded' && o.value != null ? o.value : null;
  for (const [k, c] of Object.entries(ev.checks || {})) f[`check.${k}`] = c ? [c.status, c.result].filter(Boolean).join(' / ') : null;
  const sf = st.safety || {};
  for (const h of sf.hazards || []) if (h && h.status === 'active') f[`hazard.${h.hazard}`] = 'active';
  // the default level is not a change worth showing; any raised level is
  f['safetyLevel'] = sf.activeLevel && sf.activeLevel !== 'NORMAL_DIAGNOSTIC' ? sf.activeLevel : null;
  for (const u of sf.unsafeActions || []) if (u && u.action) f[`unsafeAction.${u.action}`] = 'stated';
  for (const d of st.declined || []) if (d && d.target && d.resolvedTurn == null) f[`declined.${d.target}`] = d.kind || 'declined';
  f['resolution'] = st.resolution || null;
  return f;
}
const show = (v) => (v == null ? null : (typeof v === 'object' ? s(JSON.stringify(v)) : (typeof v === 'string' ? s(v) : v)));
function stateDelta(prior, next) {
  if (!next || typeof next !== 'object') return null;
  const a = flatState(prior); const b = flatState(next);
  const changes = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const was = a[k] == null ? null : a[k]; const now = b[k] == null ? null : b[k];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    if (k === 'problem') {
      if (now && now !== was) changes.push({ op: 'add', field: 'problem', to: `opened ${now}` });
      if (was && !now) changes.push({ op: 'remove', field: 'problem', from: `${was} closed` });
      continue;
    }
    if (was == null) changes.push({ op: 'add', field: k, to: show(now) });
    else if (now == null) changes.push({ op: 'remove', field: k, from: show(was) });
    else changes.push({ op: 'change', field: k, from: show(was), to: show(now) });
  }
  // Request lifecycle: outcomes recorded this turn, and the pending request before → after.
  for (const r of (next.requests || [])) {
    const before = reqById(prior, r.id);
    if (before && before.outcome !== r.outcome) changes.push({ op: 'change', field: `request.${r.target}`, from: s(before.outcome), to: s(r.outcome) });
  }
  const pb = reqById(prior, prior && prior.pendingRequest); const pa = reqById(next, next.pendingRequest);
  if ((pb && pb.id) !== (pa && pa.id)) {
    if (pa) changes.push({ op: 'add', field: 'pendingRequest', to: `${pa.kind === 'reoffer' ? 'reoffered' : 'issued'} ${pa.slot}:${pa.target}` });
    if (pb && !pa) changes.push({ op: 'remove', field: 'pendingRequest', from: `${pb.slot}:${pb.target} cleared` });
  }
  return changes.slice(0, MAX_DELTA);
}

// ---- 3–7. diagnostics, policy, NextAction, pending request, part gate ---------------------------------------
function diagnosticsSummary(d) {
  if (!d || typeof d !== 'object') return null;
  const ev = Object.fromEntries((d.evidence || []).map((e) => [e.family, e]));
  return prune({
    leader: d.leader ? { cause: s(d.leader.family), committed: Boolean(d.leader.committed), level: s(d.leader.level), margin: d.leader.margin,
      component: s(d.leader.component) } : null,
    ranked: (d.rank || []).slice(0, 5).map(([cause, score, strong]) => ({ cause: s(cause), score, strong,
      for: ev[cause] ? ev[cause].for.slice(0, 6).map((x) => s(x)) : undefined,
      against: ev[cause] ? ev[cause].against.slice(0, 6).map((x) => s(x)) : undefined })),
    ruledOut: (d.contradicted || []).slice(0, 8).map((x) => s(x)),
    likelyResolved: d.likelyResolved || null,
    noViableCause: d.noViableCause || null,
    pivotal: d.pivotal ? { target: s(d.pivotal.target), separates: (d.pivotal.separates || []).slice(0, 4).map((x) => s(x)) } : null,
    partEvidence: d.partEvidence ? { sufficient: Boolean(d.partEvidence.sufficient), component: s(d.partEvidence.component),
      reasons: (d.partEvidence.reasons || []).slice(0, 6).map((x) => s(x)) } : null,
    architecture: d.architecture ? s(typeof d.architecture === 'object' ? JSON.stringify(d.architecture) : d.architecture, 120) : null,
  });
}
function conclusionOf(c) {
  return c ? prune({ cause: s(c.cause), level: s(c.level), confidence: s(c.confidence), handoff: s(c.handoff), noPart: c.noPart || null, component: s(c.component) }) : null;
}
function policySummary(a) {
  if (!a) return null;
  const c = a.conclusion || null;
  return prune({ rule: s(a.rule, 20), label: s(a.reason), kind: s(a.kind), target: s(a.target), requestKind: s(a.requestKind),
    conclusion: c ? s(c.level || 'conclusion') : null, outcome: c ? s(c.cause) : null,
    handoff: c && c.handoff && c.handoff !== 'none' ? s(c.handoff) : null, safetyStop: a.kind === 'safety_stop' ? s(a.target) : null });
}
function nextActionSnapshot(a, partLookup) {
  if (!a) return null;
  const part = a.kind === 'recommend_part' && partLookup && partLookup.available ? (partLookup.parts || [])[0] : null;
  return prune({
    kind: s(a.kind), target: s(a.target), rule: s(a.rule, 20), reason: s(a.reason),
    purpose: a.pending ? s(a.pending.purpose) : null,
    pending: a.pending ? { slot: s(a.pending.slot), target: s(a.pending.target), purpose: s(a.pending.purpose) } : null,
    requiredSafety: (a.requires || []).slice(0, 8).map((x) => s(x)),
    requiresModel: a.kind === 'ask_identity' && a.target === 'model' ? true : null,
    conclusion: conclusionOf(a.conclusion),
    part: part ? { partNo: s(part.partNo, 40), title: s(part.title, 120) } : null,
  });
}
function pendingSummary(ctx, out) {
  const before = compactRequest(reqById(ctx && ctx.priorState, ctx && ctx.priorState && ctx.priorState.pendingRequest));
  const after = out && out.state ? compactRequest(reqById(out.state, out.state.pendingRequest)) : before;
  const same = JSON.stringify(before) === JSON.stringify(after);
  const change = !before && !after ? 'none' : same ? 'unchanged' : !after ? 'cleared' : !before ? 'issued' : 'replaced';
  return prune({ before, after, change, outcome: out && out.requestOutcome ? s(typeof out.requestOutcome === 'object' ? (out.requestOutcome.outcome || JSON.stringify(out.requestOutcome)) : out.requestOutcome) : null });
}
function partGateSummary(j) {
  const g = j && j.partGate;
  if (!g) return null;
  const pl = j.partLookup || null;
  return prune({
    eligible: Boolean(g.eligible), component: s(g.component), blockers: (g.failed || []).slice(0, 10).map((x) => s(x)),
    lookup: pl ? { available: Boolean(pl.available), component: s(pl.component), reason: s(pl.reason),
      matched: (pl.parts || []).slice(0, 3).map((p) => ({ partNo: s(p.partNo, 40), title: s(p.title, 120) })) } : null,
    modelParts: Number.isInteger(j.modelParts) ? j.modelParts : null,
  });
}

// ---- 8. COMPOSE (from the diagnose-time canonical-control stage; no prompt, no wording) ---------------------
function composeSummary(trace, a) {
  const st = trace && Array.isArray(trace.stages) ? trace.stages.find((x) => x && x.id === 'canonical-control') : null;
  const c = st && st.detail && st.detail.compose;
  if (!c) return null;
  const violations = (c.violations || []).slice(0, 8).map((x) => s(x));
  let mode;
  if (c.source === 'compose') mode = 'llm';
  else if (a && a.kind === 'safety_stop') mode = 'fixed_safety';
  else if (a && a.target === 'unsafe-request-declined') mode = 'fixed_decline';
  else mode = 'fixed_fallback';
  return prune({ mode, valid: c.source === 'compose', violations, fallbackReason: mode === 'fixed_fallback' ? (violations[0] || 'template') : null,
    latencyMs: Number.isFinite(c.latencyMs) ? c.latencyMs : null, outputChars: Number.isFinite(c.outputChars) ? c.outputChars : null });
}

// ---- build --------------------------------------------------------------------------------------------------
/**
 * @returns canonical-audit/1 block, or null when canonical is off for this BFF (legacy turns carry no audit).
 */
function buildCanonicalTranscriptAudit({ ctx, out, result, trace, error } = {}) {
  if (!ctx || ctx.mode === 'off') return null;
  const res = result || {};
  const valid = Boolean(out && typeof out === 'object' && !out.degraded && out.state);
  const j = valid && out.journey && typeof out.journey === 'object' ? out.journey : null;
  const a = j && j.nextAction ? j.nextAction : null;
  const gateWanted = Boolean(j && j.applies && j.control && a);
  const compose = composeSummary(trace, a);
  // The orchestrator's gate ran the canonical flow only if part-finder's diagnose-time control stage is present.
  const controlled = gateWanted && Boolean(compose);
  const degraded = res.degraded || ctx.degraded || (out && out.degraded) || (error ? s(error, 40) : null);
  let path;
  if (degraded && !valid) path = 'degraded';
  else if (controlled) path = 'control';
  else if (j && j.applies) path = 'shadow';
  else path = 'legacy';
  const audit = prune({
    schemaVersion: SCHEMA_VERSION,
    path, mode: ctx.mode, controlled,
    owner: j && j.applies ? s(j.key) : null,
    gateNotTaken: gateWanted && !controlled ? true : null,   // policy wanted control but the orchestrator answered legacy
    ref: sessionRef(ctx.csid),
    appliance: valid ? s(flatState(out.state).appliance) : null,
    journey: j ? { key: s(j.key), applies: Boolean(j.applies), control: Boolean(j.control), schema: s(j.schema, 20) } : null,
    version: { before: ctx.block || ctx.duplicate ? ctx.version : null, after: res.written && out ? out.version : (ctx.block ? ctx.version : null),
      stateDigest: res.written && out && out.state ? digest16(out.state) : null },
    classification: valid ? classificationTags(out.classification) : null,
    stateDelta: valid ? stateDelta(ctx.priorState, out.state) : null,
    diagnostics: j && j.applies ? diagnosticsSummary(j.diagnostics) : null,
    policy: j && j.applies ? policySummary(a) : null,
    nextAction: j && j.applies ? nextActionSnapshot(a, j.partLookup) : null,
    pendingRequest: valid || ctx.block ? pendingSummary(ctx, valid ? out : null) : null,
    partGate: j && j.applies ? partGateSummary(j) : null,
    compose,
    rulesFired: valid ? (out.rulesFired || []).slice(0, 30).map((x) => s(x, 12)) : null,
    persistence: {
      written: Boolean(res.written), recordWritten: Boolean(res.recordWritten), recovered: ctx.recovered || null,
      duplicate: ctx.duplicate ? s(ctx.duplicate.source, 20) : null, idempotentReplay: null,
      conflict: /conflict/.test(String(degraded || '')) || null, degraded: s(degraded, 40), demoted: ctx.demoted || null,
    },
    classifier: out && out.classifier ? { source: s(out.classifier.source, 40), degraded: Boolean(out.classifier.degraded) || null, reason: s(out.classifier.reason, 40) } : null,
  });
  return bound(audit);
}

/** Enforce MAX_AUDIT_BYTES: trim the long lists first, then fall back to the summary-only form. */
function bound(audit) {
  if (bytes(audit) <= MAX_AUDIT_BYTES) return audit;
  const t = JSON.parse(JSON.stringify(audit));
  t.truncated = true;
  if (t.stateDelta) t.stateDelta = t.stateDelta.slice(0, 15);
  if (t.diagnostics && t.diagnostics.ranked) t.diagnostics.ranked = t.diagnostics.ranked.slice(0, 3);
  if (t.classification) { delete t.classification.mentions; if (t.classification.observations) t.classification.observations = t.classification.observations.slice(0, 6); }
  if (bytes(t) <= MAX_AUDIT_BYTES) return t;
  return slim(t);
}

/** Summary-only form (older transcript turns are slimmed to this so a long session stays far under 400 KB). */
function slim(audit) {
  if (!audit || audit.slim) return audit;
  const a = audit;
  return prune({
    schemaVersion: a.schemaVersion, slim: true, truncated: a.truncated || null, path: a.path, mode: a.mode, controlled: a.controlled, owner: a.owner,
    ref: a.ref, appliance: a.appliance, version: a.version,
    policy: a.policy ? { rule: a.policy.rule, kind: a.policy.kind, target: a.policy.target, outcome: a.policy.outcome, safetyStop: a.policy.safetyStop } : null,
    nextAction: a.nextAction ? { kind: a.nextAction.kind, target: a.nextAction.target, rule: a.nextAction.rule } : null,
    pendingRequest: a.pendingRequest ? { change: a.pendingRequest.change, after: a.pendingRequest.after } : null,
    partGate: a.partGate ? { eligible: a.partGate.eligible, blockers: (a.partGate.blockers || []).slice(0, 4) } : null,
    compose: a.compose ? { mode: a.compose.mode, valid: a.compose.valid } : null,
    persistence: a.persistence,
  });
}

/** Mark a stored turn's audit as replayed by an idempotent duplicate (the cached view was returned again). */
function markReplay(audit, at) {
  const a = audit && typeof audit === 'object' ? JSON.parse(JSON.stringify(audit)) : null;
  if (!a) return a;
  a.persistence = a.persistence || {};
  const prev = a.persistence.idempotentReplay || { count: 0 };
  a.persistence.idempotentReplay = { count: (prev.count || 0) + 1, lastAt: s(at, 30) };
  return a;
}

module.exports = { SCHEMA_VERSION, MAX_AUDIT_BYTES, buildCanonicalTranscriptAudit, classificationTags, stateDelta, diagnosticsSummary,
  policySummary, nextActionSnapshot, partGateSummary, composeSummary, slim, markReplay, sessionRef };
