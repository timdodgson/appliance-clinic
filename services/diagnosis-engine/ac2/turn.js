'use strict';
/**
 * One customer turn (ADR 0023, refactor 2026-10-16).
 *
 *   1 receive    the BFF loads the chat's record and sends the turn (signed)
 *   2 emergency  gas or an active fire in the latest message: the fixed emergency wording, nothing else
 *   3 hazards    the hazard word lists over the customer's words (persist for the chat unless denied); unsafe requests
 *   4 notes      the fault notes, normal-behaviour notes and pictures for the appliance and what they describe
 *   5 advisor    Claude reads the chat and the notes, looks up error codes and parts when it needs to, writes the reply
 *                (advisor.js)
 *   6 final      fixed safety rules on the reply: banned advice removed, no reassurance under a must-be-checked hazard,
 *                part numbers and prices only from the customer or the catalogue; hazard warnings and the isolation
 *                step added in fixed wording; parts only from the catalogue and never under a blocking hazard
 *   7 send       response, record and audit back to the BFF
 *
 * If the model cannot run, the turn fails explicitly (ProviderUnavailableError): no fallback answer.
 */
const Rec = require('./record.js');
const S = require('./safety.js');
const K = require('./knowledge.js');
const A = require('./advisor.js');
const { textOf, ProviderUnavailableError } = require('./util.js');

// Hazards under which the appliance must not be used, and no part is offered, until it has been checked.
const BLOCKING = new Set(['gas', 'fire', 'burning', 'battery', 'electric_shock', 'microwave_arcing', 'supply_trip']);
const MUST_BE_CHECKED = new Set(['burning', 'battery', 'electric_shock', 'microwave_arcing', 'electrical_water', 'supply_trip']);
// Under such a hazard, a sentence that says or implies it is safe to use again, or that an engineer may not be needed.
const UNSAFE_REASSURANCE = /\b(without (?:needing|calling|having to call|the need for) (?:an? )?(?:engineer|electrician|repair)|(?:no|don'?t|won'?t|may not|might not) (?:even )?need (?:to call )?(?:an? )?(?:engineer|electrician)|safe to (?:use|run|switch on|turn on) (?:it )?again|(?:fine|ok|okay) to (?:use|run) (?:it )?(?:again|now)|(?:carry on|continue|keep) using (?:it|the)|before (?:calling|you call) an? (?:engineer|electrician))\b/i;
const SENTENCES = /[^.!?\n]+[.!?]*[ \t]*|\n+/g;

const customerTexts = (messages) => messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
const tidy = (s) => String(s || '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Hazards from the customer's words; they persist for the conversation unless the latest message denies one. */
function applyHazards(rec, messages, recalls, appliance) {
  const texts = customerTexts(messages);
  const latest = texts[texts.length - 1] || '';
  const denied = S.deniedHazards(latest, appliance);
  for (const h of rec.hazards) if (denied.has(h.type) && !h.cleared) { h.cleared = true; h.clearedTurn = rec.turn; }
  const add = (type, clause, extra = {}, { reactivate = false } = {}) => {
    if (!type || denied.has(type)) return;
    const prior = rec.hazards.find((h) => h.type === type);
    if (!prior) { rec.hazards.push({ type, clause: String(clause || '').slice(0, 160), turn: rec.turn, shown: false, ...extra }); return; }
    if (prior.cleared && reactivate) { prior.cleared = false; prior.shown = false; prior.turn = rec.turn; prior.clause = String(clause || '').slice(0, 160); }
  };
  for (const h of S.detectHazards([{ role: 'user', content: latest }], appliance)) add(h.type, h.clause, { source: 'words' }, { reactivate: true });
  // Earlier messages only add what was never recorded; they never undo a denial.
  for (const h of S.detectHazards(messages, appliance)) add(h.type, h.clause, { source: 'words' });
  if (recalls.length) add('recall', recalls[0].title || 'recall notice', { url: recalls[0].url || null, source: 'recall-store' });
  const top = S.mostSerious(activeHazards(rec));
  return top ? { ...top, policy: S.POLICY[top.type] || {} } : null;
}
function activeHazards(rec) { return rec.hazards.filter((h) => !h.cleared); }

/** Part numbers and prices may come only from the catalogue or the customer's own words. */
const IDENT = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z0-9]{6,})[A-Z0-9][A-Z0-9-]{5,}\b|£\s?\d+(?:\.\d{2})?/g;
function removeUnverifiedIdentifiers(reply, known) {
  const k = String(known || '').toUpperCase().replace(/\s+/g, '');
  const removed = [];
  const kept = (String(reply).match(SENTENCES) || []).filter((s) => {
    const ids = (s.toUpperCase().match(IDENT) || []).filter((id) => !k.includes(id.replace(/\s+/g, '')));
    if (ids.length) { removed.push(ids.slice(0, 3)); return false; }
    return true;
  });
  return { text: tidy(kept.join('')), removed };
}

// A physical check without isolation gets the isolation step first.
const PHYSICAL = /\b(unscrew|remove|take (?:out|off)|pull (?:out|off|back)|open (?:the |up )?(?:filter|flap|panel|cover|back|door seal|pump|sump)|lift (?:out|off)|(?:clean|wash|rinse) (?:the )?(?:filters?|condenser|pump|sump|drain|coils?|brush)|detach (?:the )?(?:wand|hose|head|floorhead|bin)|clear (?:the )?(?:filter|drain|hose|pump|blockage)|turn the impeller|reach (?:in|into)|tilt (?:it|the)|pull (?:it|the machine) (?:out|forward)|check inside|flush (?:the|out))\b/i;
const ISOLATED = /\b(?:switch|spur|isolator)\b[^.!?\n]{0,30}\b(?:is |turned |switched )?off\b|\b(unplug|unplugged|switch(?:ed)? (?:it |the \w+ )?off|isolat\w+|turn(?:ed)? (?:it )?off at|power off|power is off|off at the (?:wall|socket|fuse|consumer|cooker switch)|remove the battery|take the battery off)\b/i;
function stepPrecaution(reply, recentText, appliance, hazards = []) {
  if (!PHYSICAL.test(reply) || ISOLATED.test(reply) || ISOLATED.test(recentText || '')) return null;
  if (hazards.some((h) => h.type === 'electrical_water')) return 'First switch the circuit off at the consumer unit (fuse box); don\'t touch the plug or socket while anything is wet.';
  if (appliance === 'microwave') return 'Unplug it first and never remove the outer casing.';
  if (appliance === 'vacuum') return 'Switch it off and unplug it (or take the battery off) first.';
  if (appliance === 'oven-cooker' || appliance === 'hobs') return 'First switch it off at the wall or cooker switch and let it cool completely.';
  return 'Before you start, switch it off and unplug it.';
}

/** The notes the advisor reads: fault notes, normal-behaviour notes, pictures it may show, active hazards. */
function notesFor({ appliance, texts, rec, hazards, unsafe, recalls, media }) {
  const knowledge = appliance ? K.retrieve({ appliance, text: texts.slice(-4).join(' ; ') }) : [];
  const normal = appliance ? K.normalNotes({ appliance, text: texts.join(' ') }) : [];
  const lines = [];
  lines.push(`Known so far: ${JSON.stringify({ appliance: rec.customer.appliance || appliance || null, make: rec.customer.brand, model: rec.customer.model })}`);
  if (hazards.length) lines.push(`ACTIVE HAZARDS (their fixed warning is shown separately): ${hazards.map((h) => h.type).join(', ')}`);
  if (unsafe) lines.push(`The customer asked about something unsafe (${unsafe.replace(/_/g, ' ')}): do not explain how; a fixed warning is shown. Offer the safe alternative.`);
  if (recalls.length) lines.push(`PRODUCT RECALL that may match: ${JSON.stringify(recalls)}`);
  if (knowledge.length) {
    const brief = knowledge.map((k) => ({ id: k.knowledgeId, fault: k.fault, causes: k.causes, discriminators: k.discriminators, ownerSafeChecks: k.ownerSafeChecks,
      beforeReplacingAPart: k.beforeReplacingAPart, commonConfusion: k.commonConfusion }));
    lines.push(`FAULT NOTES (reference; use your own judgement): ${JSON.stringify(brief)}`);
  }
  if (normal.length) lines.push(`NORMAL BEHAVIOUR NOTES: ${JSON.stringify(normal)}`);
  if (media.length) lines.push(`PICTURES you may show (mediaId): ${JSON.stringify(media.map((m) => ({ id: m.id, title: m.title, shows: m.caption || m.description || '' })))}`);
  return { text: lines.join('\n'), knowledge };
}

/**
 * input: { messages, state, tools: { recalls } }
 * deps:  { provider (Claude, with converse), resolveCode, lookupParts, mediaCandidates, now? }
 */
async function runTurn(input, deps) {
  const now = deps.now || Date.now;
  const t0 = now();
  const messages = (input.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
  const rec = Rec.load(input.state);
  rec.turn += 1;
  const texts = customerTexts(messages);
  const latest = texts[texts.length - 1] || '';
  const recalls = Array.isArray(input.tools && input.tools.recalls) ? input.tools.recalls.slice(0, 3) : [];
  const audit = { schema: 'ac4-audit/1', turn: rec.turn, timings: {}, provider: deps.provider ? { name: deps.provider.name || null, model: deps.provider.model || null } : null, safety: { hazards: [], gates: [] } };
  const appliance = rec.customer.appliance || K.applianceHints(texts.join(' '))[0] || null;

  // 2. Gas or an active fire in the latest message: the fixed emergency wording at once, without any model.
  const early = S.mostSerious(S.detectHazards([{ role: 'user', content: latest }], appliance).filter((h) => (S.POLICY[h.type] || {}).terminate));
  if (early) {
    const prior = rec.hazards.find((h) => h.type === early.type);
    if (prior) Object.assign(prior, { cleared: false, shown: true, turn: rec.turn });
    else rec.hazards.push({ type: early.type, clause: String(early.clause || '').slice(0, 160), turn: rec.turn, shown: true, source: 'words' });
    rec.outcome = 'safety_stop';
    audit.safety = { hazards: rec.hazards.map((h) => h.type), terminated: early.type, gates: [] };
    audit.timings.totalMs = now() - t0;
    const policy = S.POLICY[early.type];
    const escalation = { to: policy.escalate, reason: early.type };
    // The stored audit carries the same escalation as the response (the transcript summary reads the audit).
    audit.escalation = { ...escalation, forced: true };
    return { state: rec, response: { outcome: 'SAFETY_STOP', message: S.copyFor(early.type), safety: { class: early.type, stopUse: true, message: S.copyFor(early.type) }, escalation }, audit };
  }

  // 3. Hazards and unsafe requests (word lists).
  let hazard = applyHazards(rec, messages, recalls, appliance);
  const unsafe = S.detectUnsafeRequest(latest, appliance);

  // 4. Notes and pictures.
  const pre = notesFor({ appliance, texts, rec, hazards: [], unsafe, recalls, media: [] });
  const kids = pre.knowledge.map((k) => k.knowledgeId).filter((id) => K.knownKnowledgeId(id));
  const stopNow = Boolean(hazard && BLOCKING.has(hazard.type));
  let media = [];
  if (!stopNow && kids.length && deps.mediaCandidates) {
    try { media = (await deps.mediaCandidates(kids, { make: rec.customer.brand, model: rec.customer.model, messages })).filter((m) => m && m.id); } catch { media = []; }
  }
  const notes = notesFor({ appliance, texts, rec, hazards: activeHazards(rec), unsafe, recalls, media });

  // 5. The advisor.
  const adv = await A.advise({ messages, notes: notes.text }, { provider: deps.provider, resolveCode: deps.resolveCode, lookupParts: deps.lookupParts, now });
  audit.timings.adviseMs = adv.ms;
  audit.usage = adv.usage;
  audit.toolCalls = adv.toolCalls;
  const a = adv.answer;
  Rec.learn(rec, a);
  const app = rec.customer.appliance || appliance;
  // Hazard word lists that depend on the appliance (microwave arcing) now apply.
  hazard = applyHazards(rec, messages, recalls, app);
  const stop = Boolean(hazard && BLOCKING.has(hazard.type));

  // 6. Final checks on the reply.
  const gate = S.gateReply(a.reply, { hazards: activeHazards(rec), appliance: app });
  for (const v of gate.violations) audit.safety.gates.push({ gate: 'prohibited-advice', rule: v.rule });
  let reply = gate.text;
  if (hazard && MUST_BE_CHECKED.has(hazard.type)) {
    const sents = reply.match(SENTENCES) || [];
    const kept = sents.filter((x) => !UNSAFE_REASSURANCE.test(x));
    if (kept.length < sents.length) audit.safety.gates.push({ gate: 'unsafe-reassurance', removed: sents.length - kept.length });
    reply = tidy(kept.join(''));
  }
  const catParts = (adv.catalogue && adv.catalogue.parts) || [];
  const known = [texts.join(' '), rec.customer.model || '', ...catParts.map((p) => `${p.partNo} ${p.title} £${Number(p.price)} £${Number(p.price).toFixed(2)}`)].join(' ');
  const ids = removeUnverifiedIdentifiers(reply, known);
  for (const b of ids.removed) audit.safety.gates.push({ gate: 'unverified-identifier', ids: b });
  reply = ids.text || 'Could you tell me a little more about what it is doing at the moment?';

  const prefix = [];
  for (const h of activeHazards(rec)) {
    if (h.shown) continue;
    prefix.push(h.type === 'recall' ? `${S.copyFor('recall')} Notice: ${h.clause}${h.url ? ` (https://applianceclinic.ai${h.url})` : ''}.` : S.copyFor(h.type));
    h.shown = true;
  }
  const unsafeCopy = unsafe === 'repeated_reset' ? S.copyFor('supply_trip') : (unsafe ? S.copyFor(unsafe) : null);
  if (unsafe && unsafeCopy && !prefix.includes(unsafeCopy)) { prefix.push(unsafeCopy); audit.safety.gates.push({ gate: 'unsafe-request', type: unsafe }); }
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  // A hazard warning shown this turn already says how to make it safe: no second isolation line.
  const caution = prefix.length ? null : stepPrecaution(reply, `${texts.slice(-2).join(' ')} ${lastAssistant ? textOf(lastAssistant.content) : ''}`, app, activeHazards(rec));
  if (caution) { prefix.push(caution); audit.safety.gates.push({ gate: 'step-precaution' }); }
  if (prefix.length) reply = `${prefix.filter(Boolean).join('\n\n')}\n\n${reply}`;
  audit.safety.hazards = activeHazards(rec).map((h) => h.type);

  // Parts: only ids the catalogue returned this turn, never under a blocking hazard.
  const wanted = new Set((a.partIds || []).map(String));
  const parts = stop ? [] : catParts.filter((p) => wanted.has(String(p.partNo))).filter((p, i, l) => l.findIndex((q) => q.partNo === p.partNo) === i).slice(0, 3);
  if (stop && wanted.size) audit.safety.gates.push({ gate: 'part-held-under-hazard' });
  const shown = !stop && a.mediaId ? media.find((m) => m.id === a.mediaId) || null : null;

  rec.outcome = a.outcome || null;
  const escalation = hazard ? { to: hazard.policy.escalate || 'engineer', reason: hazard.type, forced: true } : (a.outcome === 'engineer' ? { to: 'engineer', reason: 'reply' } : null);
  audit.partGate = { outcome: parts.length ? 'verified' : (adv.catalogue ? 'no_catalogue_part' : 'none'), component: null, reason: null };
  // This turn's tags, in the shape the admin transcript view reads (whichpart-api transcripts.js ac2Tags).
  audit.tags = { outcome: a.outcome || null, media: shown ? shown.id : null,
    enrichment: { knowledgeIds: kids, codes: adv.codes, recalls: recalls.length, parts: parts.length ? 'verified' : (adv.catalogue ? 'no_catalogue_part' : 'none') } };
  audit.escalation = escalation;
  audit.timings.totalMs = now() - t0;

  const response = {
    outcome: 'ANSWER',
    message: reply,
    parts: parts.length ? parts : null,
    resolvedModel: parts.length ? (adv.catalogue.model && adv.catalogue.model.modelNumber) || adv.catalogue.asked : null,
    safety: stop ? { class: hazard.type, stopUse: true, message: S.copyFor(hazard.type) } : null,
    safetyInformation: !stop && kids.length ? K.safetyInformation(kids[0]) : null,
    media: shown ? [shown] : null,
    escalation,
  };
  return { state: rec, response, audit };
}

module.exports = { runTurn, ProviderUnavailableError, UNSAFE_REASSURANCE, applyHazards, removeUnverifiedIdentifiers, stepPrecaution, notesFor, BLOCKING, MUST_BE_CHECKED };
