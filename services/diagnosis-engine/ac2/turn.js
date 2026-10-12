'use strict';
/**
 * One customer turn: models reason, deterministic code verifies and constrains.
 *
 *   customer words ─► deterministic pre-pass (hazards in the customer's words, tool lookups: error codes, model hints,
 *                     knowledge, normal behaviour)
 *                  ─► diagnostic reasoner (LLM): understanding, ledger proposals, candidate causes, next question, reply
 *                  ─► kernel: evidence ledger (grounded quotes, contradictions), scope, safety gate, claim verifier,
 *                     repeated-question guard ─► (one regeneration with the kernel's objections, if any)
 *                  ─► part gate, escalation policy, fixed safety wording ─► response + audit
 *
 * There is no other diagnostic path. If the reasoner or the claim extractor cannot run, the turn fails explicitly
 * (ProviderUnavailableError) and the customer is told the service is temporarily unavailable.
 */
const L = require('./ledger.js');
const S = require('./safety.js');
const K = require('./knowledge.js');
const M = require('./models.js');
const V = require('./verifier.js');
const P = require('./parts.js');
const R = require('./reasoner.js');

let EC = null;
try { EC = require('./errorcodes.js'); } catch { EC = null; }

const SUPPORTED = new Set(K.APPLIANCES);
const OUT_OF_SCOPE_RE = /\b(boiler|central heating|radiators?|combi|immersion heater|car|van|engine|tv|television|laptop|computer|pc|monitor|phone|printer|kettle|toaster|air ?fryer|coffee machine|extractor (?:fan|hood)|cooker hood|dehumidifier|air con(?:ditioner)?|heat pump(?! dryer)|e-?bike|boat|caravan|lawn ?mower)\b/i;

class ProviderUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.category = (cause && (cause.category || cause.name)) || 'UNAVAILABLE';
    this.status = (cause && cause.status) || null;
    this.detail = cause && cause.detail ? String(cause.detail).slice(0, 300) : null;
  }
}

const SCOPE_COPY = 'Appliance Clinic covers washing machines, washer-dryers, tumble dryers, dishwashers, fridges and freezers, ovens and cookers, hobs, microwaves and vacuum cleaners, so I can\'t diagnose that one.';
const SCOPE_POINTER = [
  [/boiler|central heating|radiator|combi|immersion/i, ' For a boiler or heating fault, a Gas Safe registered engineer is the right person (and if you ever smell gas, call 0800 111 999).'],
  [/\b(car|van|engine|boat|caravan|e-?bike)\b/i, ' A garage or the manufacturer\'s support line is the best place to start.'],
  [/tv|television|laptop|computer|pc|monitor|phone|printer/i, ' The manufacturer\'s support line or a specialist electronics repairer is the best place to start; please don\'t open the case, as the power supply inside can hold a dangerous charge.'],
];

function customerTexts(messages) {
  return messages.filter((m) => m && m.role === 'user').map((m) => R.textOf(m.content));
}

/** Deterministic tool pass over the customer's words. */
function tools(st, texts) {
  const all = texts.join('\n');
  const latest = texts[texts.length - 1] || '';
  const out = { errorCodes: [], modelHints: [], brandsSeen: [] };
  const brandList = EC && EC.brands ? EC.brands() : Object.keys(M.SERIES);
  const low = ` ${all.toLowerCase()} `;
  for (const b of brandList) {
    const re = new RegExp(`[^a-z]${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z]`);
    if (re.test(low)) out.brandsSeen.push(b);
  }
  const brand = (st.brand && st.brand.value ? st.brand.value.toLowerCase() : null) || out.brandsSeen[0] || null;
  const appliance = st.appliance && st.appliance.value && SUPPORTED.has(st.appliance.value) ? st.appliance.value : (K.applianceHints(all)[0] || null);

  // Model hints: model-shaped tokens, and short series tokens that follow a brand name ("Dyson V6").
  const tokens = new Set(M.candidateModels(all));
  if (st.model && st.model.value) tokens.add(st.model.value);
  for (const b of out.brandsSeen) {
    const m = all.toLowerCase().match(new RegExp(`${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+([a-z]{1,3}\\d{1,3}[a-z]?)\\b`));
    if (m) tokens.add(m[1].toUpperCase());
  }
  for (const t of tokens) {
    const h = M.hints(t, brand);
    if (h.length) out.modelHints.push({ token: t, hints: h });
  }

  // Error codes: every code-like token, looked up with whatever brand/appliance context exists. The reasoner decides
  // whether a token is a code at all.
  if (EC && EC.candidateTokens && EC.lookup) {
    const seen = new Set();
    const cands = [...EC.candidateTokens(all), ...(st.codes || []).map((c) => ({ token: c.code }))];
    for (const c of cands) {
      const tok = c.token || c.code;
      if (!tok || seen.has(tok)) continue;
      seen.add(tok);
      try {
        const r = EC.lookup({ code: tok, brand, appliance });
        if (r && r.status !== 'NOT_FOUND') out.errorCodes.push(r);
        else if (r) out.errorCodes.push({ code: tok, status: 'NOT_FOUND', brand, appliance });
      } catch { /* a lookup failure is reported as no result */ }
      if (out.errorCodes.length >= 4) break;
    }
  }
  out.latestHasCode = Boolean(EC && EC.candidateTokens && EC.candidateTokens(latest).length);
  return { ...out, brand, appliance };
}

function hazardState(st, messages) {
  const appliance = st.appliance && st.appliance.value;
  const found = S.detectHazards(messages, appliance);
  // Hazards persist for the conversation even after older messages leave the window.
  const prior = st.hazards || [];
  const merged = [...prior];
  for (const h of found) if (!merged.some((p) => p.type === h.type)) merged.push({ type: h.type, clause: h.clause.slice(0, 160), turn: st.turn, shown: false });
  st.hazards = merged;
  const top = S.mostSerious(merged);
  return top ? { ...top, policy: S.POLICY[top.type] } : null;
}

function safetyContext(st, hazard, unsafeRequest) {
  return {
    activeHazards: (st.hazards || []).map((h) => ({ type: h.type, customerSaid: h.clause, warningAlreadyShown: Boolean(h.shown), prohibited: (S.POLICY[h.type] || {}).prohibit || [], continueHelping: !((S.POLICY[h.type] || {}).terminate) })),
    unsafeRequestThisTurn: unsafeRequest,
    note: hazard ? 'A hazard is active: the system shows the fixed safety wording. Continue helping only with checks that are safe with the appliance switched off and isolated; do not suggest running, testing or using it.' : null,
  };
}

function sim(a, b) {
  const wa = new Set(K.words(a));
  const wb = new Set(K.words(b));
  if (!wa.size || !wb.size) return 0;
  let n = 0;
  for (const w of wa) if (wb.has(w)) n += 1;
  return n / Math.min(wa.size, wb.size);
}

/** The question in this reply repeats one the customer could not or would not answer, or was asked twice already. */
function repeatedQuestion(st, proposal) {
  if (!proposal.next) return null;
  const key = String(proposal.next.key || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const closed = L.closedQuestions(st);
  if (key && closed.includes(key)) return { key, why: 'closed' };
  for (const a of st.asked) {
    if ((a.resolution === 'unknown' || a.resolution === 'declined' || a.times >= 2) && sim(a.text, proposal.next.question) >= 0.75) return { key: a.key, why: 'similar' };
  }
  return null;
}

function stripQuestion(reply, question) {
  const sents = V.sentences(reply);
  const kept = sents.filter((s) => !(s.includes('?') && sim(s, question) >= 0.6));
  return kept.join('').trim();
}

/**
 * Run one turn.
 * input: { messages, state, image }
 * deps:  { reasoner: provider, extractor: provider, lookupParts: async (model) => {parts, model}, mediaFor: (kids, ctx) => media[] }
 */
async function runTurn(input, deps) {
  const t0 = Date.now();
  const messages = (input.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
  const st = input.state && input.state.schema === L.SCHEMA ? L.clone(input.state) : L.empty();
  st.turn += 1;
  const texts = customerTexts(messages);
  const latest = texts[texts.length - 1] || '';
  const ctx = { turn: st.turn, customerTexts: texts };
  const audit = { schema: 'ac2-audit/1', turn: st.turn, timings: {}, toolCalls: [], safety: { hazards: [], gates: [] }, claims: { rejected: [], checked: 0 }, regenerated: false, provider: null };

  // 1. Deterministic pre-pass.
  let hazard = hazardState(st, messages);
  const unsafeRequest = S.detectUnsafeRequest(latest, st.appliance && st.appliance.value);
  const tl = tools(st, texts);
  audit.toolCalls.push({ tool: 'error-codes', results: tl.errorCodes.map((r) => ({ code: r.code, status: r.status })) });
  audit.toolCalls.push({ tool: 'model-hints', results: tl.modelHints.map((m) => ({ token: m.token, families: m.hints.map((h) => h.family) })) });
  const knowledge = K.retrieve({ appliance: tl.appliance, text: texts.join(' ') });
  const normal = K.normalNotes({ appliance: tl.appliance, text: texts.join(' ') });
  audit.toolCalls.push({ tool: 'knowledge', results: knowledge.map((k) => k.knowledgeId) });
  if (normal.length) audit.toolCalls.push({ tool: 'normal-behaviour', results: normal.map((n) => n.id) });

  // 2. A hazard where continuing is itself unsafe: fixed wording only, no reasoning.
  if (hazard && hazard.policy.terminate) {
    for (const h of st.hazards) h.shown = true;
    audit.safety.hazards = st.hazards.map((h) => h.type);
    audit.safety.terminated = hazard.type;
    st.outcome = { status: 'safety_stop', hazard: hazard.type };
    audit.timings.totalMs = Date.now() - t0;
    return {
      state: st,
      response: { outcome: 'SAFETY_STOP', message: S.copyFor(hazard.type), safety: { class: hazard.type, stopUse: true, message: S.copyFor(hazard.type) }, escalation: { to: hazard.policy.escalate, reason: hazard.type } },
      audit,
    };
  }

  // 3. The reasoner.
  const context = {
    turn: st.turn,
    messages,
    ledger: L.promptView(st),
    tools: { errorCodes: tl.errorCodes, modelHints: tl.modelHints, brandsMentioned: tl.brandsSeen },
    knowledge,
    normal,
    safety: safetyContext(st, hazard, unsafeRequest),
  };
  let r;
  try {
    r = await R.reason(deps.reasoner, context);
  } catch (e) {
    throw new ProviderUnavailableError('diagnostic reasoner unavailable', e);
  }
  audit.timings.reasonMs = r.ms;
  audit.usage = r.usage;
  audit.provider = { name: deps.reasoner.name || null, model: deps.reasoner.model || null };
  let proposal = r.proposal;

  // 4. The ledger takes what is grounded.
  applyUnderstanding(st, proposal, ctx);
  recordToolFacts(st, tl, ctx);
  hazard = hazardState(st, messages); // appliance-specific detectors (microwave arcing) may now apply

  // 5. Scope.
  const u = proposal.understanding;
  const supported = st.appliance && SUPPORTED.has(st.appliance.value);
  const oosWord = (latest.match(OUT_OF_SCOPE_RE) || [])[0];
  if (!supported && (u.outOfScope.is || (oosWord && !K.applianceHints(texts.join(' ')).length))) {
    const what = `${u.outOfScope.what || ''} ${oosWord || ''} ${latest}`;
    const pointer = (SCOPE_POINTER.find(([re]) => re.test(what)) || [null, ''])[1];
    st.scope = { status: 'out', what: (u.outOfScope.what || oosWord || '').slice(0, 60) };
    st.outcome = { status: 'out_of_scope' };
    audit.scope = st.scope;
    audit.timings.totalMs = Date.now() - t0;
    const hz = hazard ? `${S.copyFor(hazard.type)} ` : '';
    return { state: st, response: { outcome: 'ANSWER', message: `${hz}${SCOPE_COPY}${pointer}`.trim() }, audit };
  }

  // 6. Kernel checks, with one regeneration if the proposal breaks a rule.
  let reply = proposal.reply;
  let check = await kernelChecks(reply, proposal, st, hazard, texts, deps, audit);
  // Regenerate only when the deterministic clean-up would leave a damaged reply: a safety violation or a repeated
  // question always; unsupported claims only when removing them loses much of the reply or its question.
  if (needsRegeneration(proposal.reply, check)) {
    audit.regenerated = true;
    const feedback = check.issues.map((i) => i.text);
    try {
      const r2 = await R.reason(deps.reasoner, { ...context, ledger: L.promptView(st) }, { feedback });
      audit.timings.regenerateMs = r2.ms;
      proposal = { ...r2.proposal, understanding: proposal.understanding };
      reply = proposal.reply;
    } catch (e) {
      throw new ProviderUnavailableError('diagnostic reasoner unavailable', e);
    }
    check = await kernelChecks(reply, proposal, st, hazard, texts, deps, audit);
  }
  reply = check.reply; // deterministic clean-up of anything still unsupported or prohibited
  if (!reply.trim()) reply = 'Sorry — I need a bit more to go on. What is the appliance doing (or not doing) at the moment?';

  // 7. Fixed safety wording: shown once when a hazard first appears, and on any unsafe request.
  const prefix = [];
  for (const h of st.hazards) {
    if (!h.shown) { prefix.push(S.copyFor(h.type)); h.shown = true; }
  }
  if (unsafeRequest && S.copyFor(unsafeRequest) && !reply.includes(S.copyFor(unsafeRequest))) prefix.push(S.copyFor(unsafeRequest));
  if (unsafeRequest) audit.safety.gates.push({ gate: 'unsafe-request', type: unsafeRequest });
  if (prefix.length) reply = `${prefix.join(' ')} ${reply}`;
  audit.safety.hazards = st.hazards.map((h) => h.type);

  // 8. Questions asked, answered.
  if (proposal.next) L.noteAsked(st, proposal.next.key, proposal.next.question, st.turn);

  // 9. Part gate.
  const partDecision = await P.gate(proposal, st, hazard, { lookup: deps.lookupParts, appliance: st.appliance && st.appliance.value });
  audit.partGate = { outcome: partDecision.outcome, component: partDecision.component || null, failed: partDecision.failed || [], matcher: partDecision.matcher || null, cited: partDecision.cited || [] };

  // 10. Escalation policy: hazards force their escalation; otherwise the reasoner's.
  const escalation = hazard ? { to: hazard.policy.escalate, reason: hazard.type, forced: true } : proposal.escalation;
  audit.escalation = escalation || null;

  // 11. Assemble.
  const a = proposal.assessment;
  const stop = Boolean(hazard);
  const kids = a.knowledgeIds.filter((id) => K.knownKnowledgeId(id));
  const usedCode = tl.errorCodes.find((e) => e.status === 'RESOLVED' && st.codes.some((c) => c.code === String(e.code).toUpperCase()));
  st.outcome = { status: a.status, confidence: a.confidence, summary: a.summary, candidates: a.candidates, part: partDecision.outcome };
  const response = {
    outcome: 'ANSWER',
    message: reply,
    diagnosis: a.summary && a.status !== 'gathering' ? { summary: a.summary, likelyArea: a.candidates[0] ? a.candidates[0].cause : null, confidenceBand: a.confidence === 'high' ? 'likely' : 'possible' } : null,
    suggestedChecks: [],
    parts: partDecision.outcome === 'verified' ? partDecision.parts : null,
    resolvedModel: partDecision.outcome === 'verified' ? partDecision.catalogueModel : null,
    modelRequired: partDecision.outcome === 'model_needed',
    safety: stop ? { class: hazard.type, stopUse: true, message: S.copyFor(hazard.type) } : null,
    safetyInformation: !stop && kids.length ? K.safetyInformation(kids[0]) : null,
    media: !stop && kids.length && deps.mediaFor ? await deps.mediaFor(kids, { make: st.brand && st.brand.value, model: st.model && st.model.value, messages }) : null,
    codeResult: usedCode ? { displayed: usedCode.code, meaning: (usedCode.candidates && usedCode.candidates[0] && usedCode.candidates[0].meaning) || null, recordType: (usedCode.candidates && usedCode.candidates[0] && usedCode.candidates[0].recordType) || null, status: 'RESOLVED' } : null,
    escalation: escalation || null,
    candidates: a.candidates,
    confidence: a.confidence,
    status: a.status,
  };
  audit.candidates = a.candidates;
  audit.status = a.status;
  audit.ledger = { facts: st.facts.length, contradictions: L.contradictions(st).length };
  audit.timings.totalMs = Date.now() - t0;
  return { state: st, response, audit };
}

/** Deterministic tool results become tool facts: the meaning of a code the customer reported, from the catalogue. */
function recordToolFacts(st, tl, ctx) {
  for (const r of tl.errorCodes) {
    if (r.status !== 'RESOLVED' || !r.candidates || !r.candidates[0]) continue;
    if (!st.codes.some((c) => c.code === String(r.code).toUpperCase())) continue;
    L.recordFact(st, { field: `error_code_${String(r.code).toLowerCase().replace(/[^a-z0-9]+/g, '_')}_meaning`, value: r.candidates[0].meaning, source: 'tool', status: 'observed' }, { ...ctx, fromTool: true });
  }
}

function applyUnderstanding(st, proposal, ctx) {
  const u = proposal.understanding;
  if (u.appliance && u.appliance.value && u.appliance.value !== 'unknown') L.setIdentity(st, 'appliance', u.appliance, ctx);
  if (u.brand) L.setIdentity(st, 'brand', u.brand, ctx);
  if (u.model) L.setIdentity(st, 'model', u.model, ctx);
  for (const c of u.codes) L.addCode(st, c.code, c.quote, ctx);
  for (const f of u.newFacts) L.recordFact(st, { field: f.field, value: f.value, quote: f.quote, source: 'customer', status: f.status === 'uncertain' ? 'uncertain' : 'stated' }, ctx);
  L.resolveAsked(st, u.lastQuestionAnswer);
}

function needsRegeneration(original, check) {
  if (!check.issues.length) return false;
  if (check.issues.some((i) => i.kind !== 'claim')) return true;
  const before = String(original || '').trim();
  const after = String(check.reply || '').trim();
  if (!after) return true;
  if (before.includes('?') && !after.includes('?')) return true;
  return after.length < before.length * 0.65;
}

// Identifiers the kernel cannot verify: part numbers and prices may only come from the parts catalogue (tool) or the
// customer's own words.
const IDENT = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z0-9]{6,})[A-Z0-9][A-Z0-9-]{5,}\b|£\s?\d+(?:\.\d{2})?/g;
function unverifiedIdentifiers(reply, texts, st) {
  const known = `${texts.join(' ')} ${(st.model && st.model.value) || ''} ${(st.codes || []).map((c) => c.code).join(' ')}`.toUpperCase().replace(/\s+/g, '');
  const sents = V.sentences(reply);
  const bad = [];
  const kept = sents.filter((x) => {
    const ids = (x.toUpperCase().match(IDENT) || []).filter((id) => !known.includes(id.replace(/\s+/g, '')));
    if (ids.length) { bad.push({ sentence: x.trim().slice(0, 200), ids }); return false; }
    return true;
  });
  return { text: kept.join('').replace(/\s{2,}/g, ' ').trim(), bad };
}

/** Safety gate, claim verification and the repeated-question guard. Returns { reply (cleaned), issues }. */
async function kernelChecks(reply, proposal, st, hazard, texts, deps, audit) {
  const issues = [];
  const gate = S.gateReply(reply, { hazards: st.hazards || [], appliance: st.appliance && st.appliance.value });
  for (const v of gate.violations) {
    audit.safety.gates.push({ gate: 'prohibited-advice', rule: v.rule });
    issues.push({ kind: 'safety', text: `Do not advise this (unsafe): "${v.sentence}"` });
  }
  let cleaned = gate.text;
  const ids = unverifiedIdentifiers(cleaned, texts, st);
  for (const b of ids.bad) {
    audit.safety.gates.push({ gate: 'unverified-identifier', ids: b.ids.slice(0, 3) });
    issues.push({ kind: 'identifier', text: `Do not give part numbers or prices (${b.ids.join(', ')}): they are not verified. Name the component type; the system checks the catalogue.` });
  }
  cleaned = ids.text;
  const extract = deps.extractor ? async (system, user) => {
    const res = await deps.extractor.infer({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 700, temperature: 0, timeoutMs: 30000, responseFormat: V.EXTRACT_FORMAT, stream: false });
    if (res.status !== 200) { const e = new Error(`extractor http ${res.status}`); e.category = 'HTTP'; e.status = res.status; e.detail = res.errorDetail || null; throw e; }
    return { json: R.parseJson(res.text), usage: res.usage };
  } : null;
  let verdict;
  try {
    verdict = await V.verify(cleaned, st, texts, { extract });
  } catch (e) {
    throw new ProviderUnavailableError('claim extractor unavailable', e);
  }
  audit.claims.checked += verdict.claims.length;
  audit.timings.verifyMs = (audit.timings.verifyMs || 0) + (verdict.extractor.ms || 0);
  for (const rj of verdict.rejected) {
    audit.claims.rejected.push({ claim: rj.claim, source: rj.source });
    issues.push({ kind: 'claim', text: `Unsupported claim about the customer (they did not say this): "${rj.claim}". Do not state it as fact; ask or hedge instead.` });
  }
  if (verdict.rejected.length) cleaned = V.neutralise(verdict);
  const rep = repeatedQuestion(st, proposal);
  if (rep) {
    audit.safety.gates.push({ gate: 'repeated-question', key: rep.key, why: rep.why });
    issues.push({ kind: 'repeat', text: `Do not ask "${proposal.next.question}" again: the customer could not or would not answer it, or it was already asked twice. Reason around it, answer what you can, or take a different route.` });
    cleaned = stripQuestion(cleaned, proposal.next.question);
  }
  return { reply: cleaned, issues };
}

module.exports = { runTurn, ProviderUnavailableError, SCOPE_COPY };
