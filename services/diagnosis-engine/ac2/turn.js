'use strict';
/**
 * One customer turn.
 *
 *   1  receive        the BFF loads the chat's record and sends the turn (signed)
 *   2  understand     Qwen reads the latest message and pulls out what it means (hints only)
 *   3  label          Jev labels it from the customer's words, with a confidence per label
 *   4  enrich         RAG fault notes, normal behaviour, error-code meanings (error-code service), recalls, model info,
 *                     parts (stage 2 only); kept apart from customer facts
 *   5  record         the BFF saves the record; this turn's labels are the transcript tags
 *   6  safety         Jev's hazard label plus the word-list backstop; fixed wording; stop only for gas or fire
 *   7  decide         what this reply must do: stage 1 broad help, stage 2 narrow / model / part; never ask for
 *                     anything already in the record
 *   8  reply          Qwen writes the reply as a normal chat
 *   9  final check    unsafe advice and unverified part numbers or prices removed; parts only when the catalogue
 *                     confirms them for the customer's model
 *   10 media          Jev picks the picture or video that matches the reply's check, and tags what the reply does
 *   11 send           response, record and audit back to the BFF
 *
 * If Qwen or Jev cannot run, the turn fails explicitly (ProviderUnavailableError): no fallback answer.
 */
const Rec = require('./record.js');
const S = require('./safety.js');
const K = require('./knowledge.js');
const M = require('./models.js');
const P = require('./parts.js');
const J = require('./labels.js');
const { understand } = require('./understand.js');
const { writeReply } = require('./reply.js');
const { textOf, ProviderUnavailableError } = require('./util.js');

let EC = null;
try { EC = require('./errorcodes.js'); } catch { EC = null; }

const SUPPORTED = new Set(K.APPLIANCES);
const SCOPE_COPY = 'Appliance Clinic covers washing machines, washer-dryers, tumble dryers, dishwashers, fridges and freezers, ovens and cookers, hobs, microwaves and vacuum cleaners, so I can\'t diagnose that one.';
const SCOPE_POINTER = [
  [/boiler|central heating|radiator|combi|immersion/i, ' For a boiler or heating fault, a Gas Safe registered engineer is the right person (and if you ever smell gas, call 0800 111 999).'],
  [/\b(car|van|engine|boat|caravan|e-?bike)\b/i, ' A garage or the manufacturer\'s support line is the best place to start.'],
  [/tv|television|laptop|computer|pc|monitor|phone|printer/i, ' The manufacturer\'s support line or a specialist electronics repairer is the best place to start; please don\'t open the case, as the power supply inside can hold a dangerous charge.'],
];
const ATTACK_COPY = 'I can only help with household appliance faults. What\'s going on with your appliance?';
const BLOCKING = new Set(['gas', 'fire', 'burning', 'battery', 'electric_shock', 'microwave_arcing', 'supply_trip']);
const LABEL_WHERE = {
  'washing-machine': 'on a sticker inside the door rim or on the back of the door', 'washer-dryer': 'on a sticker inside the door rim or on the back of the door',
  'tumble-dryer': 'on a sticker inside the door opening', dishwasher: 'on the side edge of the door', 'fridge-freezer': 'on a sticker inside the fridge, usually on a side wall near the salad drawer',
  'oven-cooker': 'on the frame around the oven door opening', hobs: 'on the underside of the hob or on the guarantee card', microwave: 'on the back or inside the door frame',
  vacuum: 'on the body, often under the bin or battery',
};

const customerTexts = (messages) => messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
const lastOf = (messages, role) => { for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === role) return textOf(messages[i].content); return null; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Candidate tokens and brands for Jev's make / model / code labels (from Qwen's reading and the message itself). */
function candidatesFor(latest, reading) {
  const tokens = [reading.model, ...reading.codes];
  for (const t of M.candidateModels(latest)) tokens.push(t);
  if (EC && EC.candidateTokens) for (const c of EC.candidateTokens(latest)) tokens.push(c.token || c.code);
  const brands = [reading.brand];
  if (EC && EC.brands) {
    const low = ` ${latest.toLowerCase()} `;
    for (const b of EC.brands()) {
      if (!new RegExp(`[^a-z]${esc(b)}[^a-z]`).test(low)) continue;
      brands.push(b);
      const m = low.match(new RegExp(`${esc(b)}\\s+([a-z]{1,3}\\d{1,3}[a-z]?)\\b`));
      if (m) tokens.push(m[1].toUpperCase());
    }
  }
  return { tokens: tokens.filter(Boolean), brands: brands.filter(Boolean) };
}

/** Step 3 → record: labelled customer values. */
function applyLabels(rec, L, reading) {
  const t = rec.turn;
  if (L.appliance.value && SUPPORTED.has(L.appliance.value)) Rec.setValue(rec, 'appliance', L.appliance.value, L.appliance.confidence, t);
  if (L.make.value) Rec.setValue(rec, 'brand', L.make.value, L.make.confidence, t);
  if (L.model.value) { Rec.setValue(rec, 'model', L.model.value.toUpperCase(), L.model.confidence, t); rec.customer.modelUnavailable = false; }
  if (L.code.value) Rec.addCode(rec, L.code.value, t);
  if (L.symptomArea.value) {
    Rec.setValue(rec, 'symptomArea', L.symptomArea.value, L.symptomArea.confidence, t);
    if (reading.symptom && !rec.customer.symptom) Rec.setValue(rec, 'symptom', reading.symptom, L.symptomArea.confidence, t);
  }
  if (L.checkOutcome.value || L.lastAnswer.value === 'answered') for (const c of reading.checksReported) Rec.addCheck(rec, c.check, c.result, t);
  if (L.lastAnswer.value) Rec.resolveLastAsked(rec, L.lastAnswer.value === 'answered' ? (reading.answerToLastQuestion || 'answered') : L.lastAnswer.value);
  if (L.modelUnreachable.value && !rec.customer.model) rec.customer.modelUnavailable = true;
  if (L.checkOutcome.value === 'fixed') rec.outcome = 'fixed';
  if (L.checkOutcome.value === 'still_faulty' || L.checkOutcome.value === 'helped_then_returned') rec.stage = 2;
  if (L.narrowed.value) { rec.narrowed = { component: L.narrowed.value, confidence: L.narrowed.confidence, turn: t }; rec.stage = 2; }
}

/** Step 6: hazards from Jev's label and the word-list backstop; they persist for the conversation. */
function applyHazards(rec, labels, messages, recalls) {
  const add = (type, clause, extra = {}) => { if (type && !rec.hazards.some((h) => h.type === type)) rec.hazards.push({ type, clause: String(clause || '').slice(0, 160), turn: rec.turn, shown: false, ...extra }); };
  if (labels.hazard.value) add(labels.hazard.value, `labelled: ${labels.hazard.value}`, { source: 'jev', confidence: labels.hazard.confidence });
  // The word list needs the appliance for appliance-specific hazards (microwave arcing): the record's, else a hint from the words.
  const appliance = (rec.customer.appliance && rec.customer.appliance.value) || K.applianceHints(customerTexts(messages).join(' '))[0] || null;
  for (const h of S.detectHazards(messages, appliance)) add(h.type, h.clause, { source: 'words' });
  if (recalls.length) add('recall', recalls[0].title || 'recall notice', { url: recalls[0].url || null, source: 'recall-store' });
  const top = S.mostSerious(rec.hazards);
  return top ? { ...top, policy: S.POLICY[top.type] || {} } : null;
}

/** Step 4: tools. */
async function enrich(rec, texts, deps, recalls) {
  const appliance = rec.customer.appliance && rec.customer.appliance.value;
  const symptomText = [rec.customer.symptom && rec.customer.symptom.value, texts.slice(-3).join(' ')].filter(Boolean).join(' ');
  const knowledge = appliance ? K.retrieve({ appliance, text: symptomText }) : [];
  const normal = appliance ? K.normalNotes({ appliance, text: symptomText }) : [];
  if (knowledge.length) {
    rec.knowledge.knowledgeIds = knowledge.map((k) => k.knowledgeId);
    rec.knowledge.fault = knowledge[0].fault || null;
    rec.knowledge.causes = [...new Set(knowledge.flatMap((k) => k.causes || []))].slice(0, 8);
    rec.knowledge.components = [...new Set(knowledge.flatMap((k) => k.likelyComponents || []))].slice(0, 12);
  }
  const brand = rec.customer.brand && rec.customer.brand.value;
  const model = rec.customer.model && rec.customer.model.value;
  const codeMeanings = [];
  for (const c of rec.customer.codes.slice(-3)) {
    const prior = rec.knowledge.codeMeanings.find((x) => x.code === c.code);
    if (prior && prior.status === 'RESOLVED') { codeMeanings.push(prior); continue; }
    const r = deps.resolveCode ? await deps.resolveCode({ make: brand, appliance, code: c.code, model }) : { code: c.code, status: 'UNAVAILABLE' };
    codeMeanings.push(r);
    rec.knowledge.codeMeanings = rec.knowledge.codeMeanings.filter((x) => x.code !== c.code).concat(r);
  }
  for (const r of codeMeanings) {
    if (r.status === 'RESOLVED' && r.components && r.components.length) rec.knowledge.components = [...new Set([...r.components, ...rec.knowledge.components])].slice(0, 12);
  }
  rec.knowledge.modelInfo = model ? M.hints(model, brand ? brand.toLowerCase() : null) : [];
  const compactKnowledge = knowledge.map((k) => ({ fault: k.fault, likelyCauses: k.causes, components: k.likelyComponents, ownerSafeChecks: k.ownerSafeChecks, discriminators: k.discriminators, commonConfusion: k.commonConfusion }));
  return { knowledge: compactKnowledge, normal, codeMeanings, recalls };
}

/** Step 7: the plan for this reply, decided in code. */
function decide(rec, reading, hazard, unsafe, parts) {
  const plan = [];
  const c = rec.customer;
  const appliance = c.appliance && c.appliance.value;
  const model = c.model && c.model.value;
  if (reading.customerQuestion) plan.push(`They asked: "${reading.customerQuestion}" - answer that first.`);
  if (rec.outcome === 'fixed') {
    plan.push('The customer says it is fixed: say so warmly, give one short tip to stop it happening again, and ask if there is anything else.');
    return plan;
  }
  if (!appliance) {
    plan.push('We do not know which appliance this is yet: ask which appliance it is (and the make, if they know it). Keep it short.');
    return plan;
  }
  if (hazard && !hazard.policy.terminate) plan.push(`Safety: a ${hazard.type.replace(/_/g, ' ')} hazard is active. The fixed safety warning is shown separately, do not repeat it. Only suggest checks that are safe with the appliance switched off and unplugged, never running or testing it; recommend ${String(hazard.policy.escalate || 'an engineer').replace(/-/g, ' ')} where the fault needs one.`);
  if (unsafe) plan.push(`They asked about something unsafe (${unsafe.replace(/_/g, ' ')}): do not explain how to do it; the fixed safety wording is shown separately. Offer the safe alternative.`);
  const declined = rec.asked.filter((a) => a.answer === 'does_not_know' || a.answer === 'cannot_or_will_not').map((a) => a.question);
  if (declined.length) plan.push(`Do not ask again (they could not or would not answer): ${declined.map((q) => `"${q}"`).join('; ')}.`);
  if (rec.stage === 1) {
    plan.push('Stage 1 (broad help): say the most likely cause in plain words and give one or two safe checks the owner can do for it, most likely first. Do not ask for the model number in this reply.');
    if (c.codes.length) plan.push('Explain what the error code means using ERROR CODES; if the catalogue could not resolve it, say what it usually means on this appliance and what would confirm it.');
    return plan;
  }
  // Stage 2: the owner's checks did not fix it.
  if (!model && !c.modelUnavailable) {
    const where = LABEL_WHERE[appliance] || 'on the rating label';
    plan.push(`Stage 2: their checks did not fix it. Say what that points to, then ask for the ${c.brand ? '' : 'make and '}model number so we can find the right part; say it is usually ${where}. If the label cannot be reached right now (for example the door will not open), say it can wait.`);
  } else if (!model) {
    plan.push('Stage 2: their checks did not fix it and they cannot reach the model label right now. Carry on without it: give the next check or say what the likely part is, and tell them where to find the model number later.');
  } else if (parts && parts.outcome === 'verified') {
    plan.push(`Stage 2: the checks point to the ${parts.component}. Say that, and that a matching part for model ${parts.catalogueModel} is shown below; they should check the listing matches their model before ordering. Mention when an engineer is the better choice.`);
  } else if (parts && parts.outcome === 'no_catalogue_part') {
    plan.push(`Stage 2: the checks point to the ${parts.component}, but we could not find a confirmed match for model ${model}. Say so, and suggest the manufacturer's spares or an engineer.`);
  } else {
    plan.push('Stage 2: their checks did not fix it. Give the next check that best separates the remaining likely causes, or say what the likely faulty part is if the checks already point to one.');
  }
  return plan;
}

/** Part numbers and prices may come only from the catalogue or the customer's own words. */
const IDENT = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z0-9]{6,})[A-Z0-9][A-Z0-9-]{5,}\b|£\s?\d+(?:\.\d{2})?/g;
function removeUnverifiedIdentifiers(reply, texts, rec) {
  const known = `${texts.join(' ')} ${(rec.customer.model && rec.customer.model.value) || ''} ${rec.customer.codes.map((c) => c.code).join(' ')}`.toUpperCase().replace(/\s+/g, '');
  const sents = String(reply).match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [];
  const removed = [];
  const kept = sents.filter((s) => {
    const ids = (s.toUpperCase().match(IDENT) || []).filter((id) => !known.includes(id.replace(/\s+/g, '')));
    if (ids.length) { removed.push(ids.slice(0, 3)); return false; }
    return true;
  });
  return { text: kept.join('').replace(/[ \t]{2,}/g, ' ').trim(), removed };
}

// A physical check without isolation gets the isolation step first.
const PHYSICAL = /\b(unscrew|remove|take (?:out|off)|pull (?:out|off|back)|open (?:the |up )?(?:filter|flap|panel|cover|back|door seal|pump|sump)|lift (?:out|off)|(?:clean|wash|rinse) (?:the )?(?:filters?|condenser|pump|sump|drain|coils?|brush)|detach (?:the )?(?:wand|hose|head|floorhead|bin)|clear (?:the )?(?:filter|drain|hose|pump|blockage)|turn the impeller|reach (?:in|into)|tilt (?:it|the)|pull (?:it|the machine) (?:out|forward)|check inside|flush (?:the|out))\b/i;
const ISOLATED = /\b(unplug|unplugged|switch(?:ed)? (?:it |the \w+ )?off|isolat\w+|turn(?:ed)? (?:it )?off at|power off|power is off|off at the (?:wall|socket|fuse|consumer|cooker switch)|remove the battery|take the battery off)\b/i;
function stepPrecaution(reply, recentText, appliance) {
  if (!PHYSICAL.test(reply) || ISOLATED.test(reply) || ISOLATED.test(recentText || '')) return null;
  if (appliance === 'microwave') return 'Unplug it first and never remove the outer casing.';
  if (appliance === 'vacuum') return 'Switch it off and unplug it (or take the battery off) first.';
  if (appliance === 'oven-cooker' || appliance === 'hobs') return 'First switch it off at the wall or cooker switch and let it cool completely.';
  return 'Before you start, switch it off and unplug it.';
}

function lastQuestion(reply) {
  const qs = (String(reply).match(/[^.!?\n]*\?/g) || []).map((s) => s.trim()).filter(Boolean);
  return qs.length ? qs[qs.length - 1] : null;
}

/**
 * input: { messages, state, tools: { recalls } }
 * deps:  { qwen: provider, jev: { evaluate({state, questions}) }, resolveCode, lookupParts, mediaCandidates }
 */
async function runTurn(input, deps) {
  const t0 = Date.now();
  const messages = (input.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
  const rec = Rec.load(input.state);
  rec.turn += 1;
  const texts = customerTexts(messages);
  const latest = texts[texts.length - 1] || '';
  const priorAssistant = lastOf(messages, 'assistant');
  const recalls = Array.isArray(input.tools && input.tools.recalls) ? input.tools.recalls.slice(0, 3) : [];
  const audit = { schema: 'ac3-audit/1', turn: rec.turn, timings: {}, provider: deps.qwen ? { name: deps.qwen.name || null, model: deps.qwen.model || null } : null, safety: { hazards: [], gates: [] } };

  // Gas or an active fire in the customer's words: the fixed emergency wording at once, before (and without) any model.
  const early = S.mostSerious(S.detectHazards(messages, rec.customer.appliance && rec.customer.appliance.value).filter((h) => (S.POLICY[h.type] || {}).terminate));
  if (early) {
    if (!rec.hazards.some((h) => h.type === early.type)) rec.hazards.push({ type: early.type, clause: String(early.clause || '').slice(0, 160), turn: rec.turn, shown: true, source: 'words' });
    rec.outcome = 'safety_stop';
    audit.safety = { hazards: rec.hazards.map((h) => h.type), terminated: early.type, gates: [] };
    audit.tags = { replyAction: { value: 'safety_stop', confidence: null } };
    audit.timings.totalMs = Date.now() - t0;
    const policy = S.POLICY[early.type];
    return { state: rec, response: { outcome: 'SAFETY_STOP', message: S.copyFor(early.type), safety: { class: early.type, stopUse: true, message: S.copyFor(early.type) }, escalation: { to: policy.escalate, reason: early.type } }, audit };
  }

  // 2. Understand (Qwen).
  const u = await understand(deps.qwen, { latest, priorAssistant });
  audit.timings.understandMs = u.ms;
  // 3. Label (Jev).
  const lab = await J.labelMessage(deps.jev, { latest, priorAssistant, reading: u.reading, known: Rec.known(rec), candidates: candidatesFor(latest, u.reading), components: rec.knowledge.components });
  audit.timings.labelMs = lab.ms;
  const labels = lab.labels;
  applyLabels(rec, labels, u.reading);
  const tags = { labels, reading: { appliance: u.reading.appliance, brand: u.reading.brand, model: u.reading.model, codes: u.reading.codes, symptom: u.reading.symptom }, stage: rec.stage };

  // 6 (first): safety. Gas or an active fire: fixed wording only.
  let hazard = applyHazards(rec, labels, messages, recalls);
  const unsafe = labels.unsafeRequest.value || S.detectUnsafeRequest(latest, rec.customer.appliance && rec.customer.appliance.value);
  if (hazard && hazard.policy.terminate) {
    for (const h of rec.hazards) h.shown = true;
    rec.outcome = 'safety_stop';
    audit.safety = { hazards: rec.hazards.map((h) => h.type), terminated: hazard.type, gates: [] };
    audit.tags = { ...tags, replyAction: { value: 'safety_stop', confidence: null } };
    audit.timings.totalMs = Date.now() - t0;
    return { state: rec, response: { outcome: 'SAFETY_STOP', message: S.copyFor(hazard.type), safety: { class: hazard.type, stopUse: true, message: S.copyFor(hazard.type) }, escalation: { to: hazard.policy.escalate, reason: hazard.type } }, audit };
  }

  // Scope.
  const supported = rec.customer.appliance && SUPPORTED.has(rec.customer.appliance.value);
  if (labels.scope.value === 'prompt_attack' || (!supported && (labels.scope.value === 'unrelated' || labels.appliance.value === 'other_appliance'))) {
    const attack = labels.scope.value === 'prompt_attack';
    const pointer = (SCOPE_POINTER.find(([re]) => re.test(latest)) || [null, ''])[1];
    const hz = hazard ? `${S.copyFor(hazard.type)} ` : '';
    for (const h of rec.hazards) h.shown = true;
    audit.scope = { status: attack ? 'attack' : 'out' };
    audit.tags = { ...tags, replyAction: { value: 'answers_only', confidence: null } };
    audit.timings.totalMs = Date.now() - t0;
    return { state: rec, response: { outcome: 'ANSWER', message: attack ? ATTACK_COPY : `${hz}${SCOPE_COPY}${pointer}`.trim() }, audit };
  }

  // 4. Enrich.
  const tE = Date.now();
  const found = await enrich(rec, texts, deps, recalls);
  audit.timings.enrichMs = Date.now() - tE;
  hazard = applyHazards(rec, labels, messages, recalls); // appliance-specific word detectors may now apply

  // Parts (stage 2 only): the catalogue must confirm a part for the customer's model.
  const appliance = rec.customer.appliance && rec.customer.appliance.value;
  const model = rec.customer.model && rec.customer.model.value;
  let parts = null;
  if (rec.stage === 2 && rec.narrowed && model && !(hazard && BLOCKING.has(hazard.type)) && deps.lookupParts) {
    let res;
    try { res = await deps.lookupParts(model); } catch { res = { parts: [] }; }
    const list = Array.isArray(res && res.parts) ? res.parts : [];
    const m = list.length ? P.matchParts(list, appliance, rec.narrowed.component) : { parts: [] };
    parts = m.parts.length
      ? { outcome: 'verified', component: rec.narrowed.component, parts: m.parts, catalogueModel: (res && res.model) || model }
      : { outcome: 'no_catalogue_part', component: rec.narrowed.component, reason: list.length ? 'no-matching-part' : 'model-not-in-catalogue' };
  }

  // 7. Decide; 8. reply (Qwen).
  const safetyNotes = [];
  const codeSafety = found.codeMeanings.find((r) => r.safety && r.safety.stopUse);
  if (codeSafety) safetyNotes.push(`The error code ${codeSafety.code} means it should not be used until checked${codeSafety.safety.reason ? ` (${codeSafety.safety.reason})` : ''}.`);
  const plan = decide(rec, u.reading, hazard, unsafe, parts);
  const r = await writeReply(deps.qwen, { messages, brief: { known: Rec.known(rec), knowledge: found.knowledge, codeMeanings: found.codeMeanings, normal: found.normal, plan, safetyNotes, recalls: found.recalls } });
  audit.timings.replyMs = r.ms;
  audit.usage = r.usage;
  audit.plan = plan;

  // 9. Final check.
  const gate = S.gateReply(r.text, { hazards: rec.hazards, appliance });
  for (const v of gate.violations) audit.safety.gates.push({ gate: 'prohibited-advice', rule: v.rule });
  const ids = removeUnverifiedIdentifiers(gate.text, texts, rec);
  for (const b of ids.removed) audit.safety.gates.push({ gate: 'unverified-identifier', ids: b });
  let reply = ids.text || 'Could you tell me a little more about what it is doing at the moment?';
  const prefix = [];
  for (const h of rec.hazards) {
    if (h.shown) continue;
    prefix.push(h.type === 'recall' ? `${S.copyFor('recall')} Notice: ${h.clause}${h.url ? ` (https://applianceclinic.ai${h.url})` : ''}.` : S.copyFor(h.type));
    h.shown = true;
  }
  const unsafeCopy = unsafe === 'repeated_reset' ? S.copyFor('supply_trip') : (unsafe ? S.copyFor(unsafe) : null);
  if (unsafe && unsafeCopy && !prefix.includes(unsafeCopy)) { prefix.push(unsafeCopy); audit.safety.gates.push({ gate: 'unsafe-request', type: unsafe }); }
  const caution = stepPrecaution(reply, `${texts.slice(-2).join(' ')} ${priorAssistant || ''}`, appliance);
  if (caution) { prefix.push(caution); audit.safety.gates.push({ gate: 'step-precaution' }); }
  if (prefix.length) reply = `${prefix.filter(Boolean).join(' ')} ${reply}`;
  audit.safety.hazards = rec.hazards.map((h) => h.type);

  // 10. Media and reply tags (Jev).
  const stop = Boolean(hazard && BLOCKING.has(hazard.type));
  const kids = rec.knowledge.knowledgeIds.filter((id) => K.knownKnowledgeId(id));
  let pool = [];
  if (!stop && kids.length && deps.mediaCandidates) {
    try { pool = await deps.mediaCandidates(kids, { make: rec.customer.brand && rec.customer.brand.value, model, messages }); } catch { pool = []; }
  }
  const rl = await J.labelReply(deps.jev, { reply, media: pool });
  audit.timings.replyLabelMs = rl.ms;

  const q = lastQuestion(reply);
  if (q) Rec.noteAsked(rec, q, rec.turn);
  const action = rl.replyAction.value;
  if (action === 'recommends_engineer' && rec.outcome !== 'fixed') rec.outcome = 'engineer';
  else if (action === 'suggests_part' && parts && parts.outcome === 'verified') rec.outcome = 'part';
  else if (action === 'says_normal') rec.outcome = 'normal';

  const escalation = hazard ? { to: hazard.policy.escalate || 'engineer', reason: hazard.type, forced: true } : (action === 'recommends_engineer' ? { to: 'engineer', reason: 'reply' } : null);
  audit.tags = { ...tags, stage: rec.stage, replyAction: rl.replyAction, media: rl.media ? rl.media.id || rl.media.title || null : null,
    enrichment: { knowledgeIds: rec.knowledge.knowledgeIds, codes: found.codeMeanings.map((x) => ({ code: x.code, status: x.status })), recalls: recalls.length, parts: parts ? parts.outcome : 'none' } };
  audit.partGate = parts ? { outcome: parts.outcome, component: parts.component, reason: parts.reason || null } : { outcome: 'none' };
  audit.escalation = escalation;
  audit.timings.totalMs = Date.now() - t0;

  const response = {
    outcome: 'ANSWER',
    message: reply,
    diagnosis: rec.narrowed ? { summary: `Likely cause: ${rec.narrowed.component}`, likelyArea: rec.narrowed.component, confidenceBand: 'likely' } : null,
    parts: parts && parts.outcome === 'verified' ? parts.parts : null,
    resolvedModel: parts && parts.outcome === 'verified' ? parts.catalogueModel : null,
    modelRequired: rec.stage === 2 && !model && !rec.customer.modelUnavailable,
    safety: stop ? { class: hazard.type, stopUse: true, message: S.copyFor(hazard.type) } : null,
    safetyInformation: !stop && kids.length ? K.safetyInformation(kids[0]) : null,
    media: rl.media ? [rl.media] : null,
    codeResult: null,
    escalation,
  };
  return { state: rec, response, audit };
}

module.exports = { runTurn, ProviderUnavailableError, SCOPE_COPY, decide, applyLabels, candidatesFor, removeUnverifiedIdentifiers, stepPrecaution, lastQuestion };
