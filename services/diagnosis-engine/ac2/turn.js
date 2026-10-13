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
 *                     anything already in the record; build on what earlier replies already told them
 *   8  reason, reply  the first rebuild's reasoner (Qwen) reasons over the record, tools, knowledge and the plan, and
 *                     writes the reply; the claim verifier removes customer-specific claims the record does not
 *                     support (one regeneration with its objections when the clean-up would damage the reply)
 *   9  final check    unsafe advice and unverified part numbers or prices removed; certainty a check has not proved
 *                     softened; parts only when the catalogue confirms them for the customer's model
 *   10 media          Jev picks the picture or video that matches the reply's check, and tags what the reply does
 *   11 send           response, record and audit back to the BFF
 *
 * If Qwen, the claim extractor or Jev cannot run, the turn fails explicitly (ProviderUnavailableError): no fallback answer.
 */
const Rec = require('./record.js');
const S = require('./safety.js');
const K = require('./knowledge.js');
const M = require('./models.js');
const P = require('./parts.js');
const J = require('./labels.js');
const { understand } = require('./understand.js');
const R = require('./reasoner.js');
const V = require('./verifier.js');
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
// A regeneration must be expected to finish by 26 s, so it never makes a customer wait much over half a minute.
// whichpart-api waits up to 45 s for the engine (AC2_ENGINE_TIMEOUT_MS), which covers a slow single reasoning pass.
const REGENERATION_BUDGET_MS = 26000;
const BLOCKING = new Set(['gas', 'fire', 'burning', 'battery', 'electric_shock', 'microwave_arcing', 'supply_trip']);
// Hazards after which the appliance must not be used until an engineer (or the manufacturer) has checked it.
const MUST_BE_CHECKED = new Set(['burning', 'battery', 'electric_shock', 'microwave_arcing', 'electrical_water', 'supply_trip']);
// Under such a hazard, a sentence that says or implies it is safe to use again, or that an engineer may not be needed.
const UNSAFE_REASSURANCE = /\b(without (?:needing|calling|having to call|the need for) (?:an? )?(?:engineer|electrician|repair)|(?:no|don'?t|won'?t|may not|might not) (?:even )?need (?:to call )?(?:an? )?(?:engineer|electrician)|safe to (?:use|run|switch on|turn on) (?:it )?again|(?:fine|ok|okay) to (?:use|run) (?:it )?(?:again|now)|(?:carry on|continue|keep) using (?:it|the)|before (?:calling|you call) an? (?:engineer|electrician))\b/i;
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
  if (L.symptomArea.value) Rec.setValue(rec, 'symptomArea', L.symptomArea.value, L.symptomArea.confidence, t);
  // The customer's own description of the fault, kept from the first message that gives one.
  if (reading.symptom && !rec.customer.symptom) Rec.setValue(rec, 'symptom', reading.symptom, L.symptomArea.confidence, t);
  // Checks and facts Qwen read are recorded only when Jev finds them in the customer's own words.
  const checks = (L.checksConfirmed || []).map((i) => reading.checksReported[i]).filter(Boolean);
  for (const c of checks) Rec.addCheck(rec, c.check, c.result, t);
  if (checks.length) Rec.markChecksReported(rec, t);
  for (const i of L.factsConfirmed || []) Rec.addFact(rec, (reading.facts || [])[i], t);
  if (L.lastAnswer.value) Rec.resolveLastAsked(rec, L.lastAnswer.value === 'answered' ? (reading.answerToLastQuestion || 'answered') : L.lastAnswer.value);
  if (L.modelUnreachable.value && !rec.customer.model) rec.customer.modelUnavailable = true;
  if (L.checkOutcome.value === 'fixed') rec.outcome = 'fixed';
  // Stage 2 only when a check was actually reported (Qwen and Jev agree) and the fault is still there.
  if ((L.checkOutcome.value === 'still_faulty' || L.checkOutcome.value === 'helped_then_returned') && checks.length) rec.stage = 2;
  if (L.narrowed.value) { rec.narrowed = { component: L.narrowed.value, confidence: L.narrowed.confidence, turn: t }; rec.stage = 2; }
}

/**
 * Step 6: hazards from Jev's label and the word-list backstop; they persist for the conversation. The backstop is
 * independent of Jev on purpose: a hazard in the customer's words is active whatever Jev says.
 */
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
function decide(rec, reading, hazard, unsafe, parts, { nothingNew = false } = {}) {
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
  if (hazard && !hazard.policy.terminate) {
    const who = String(hazard.policy.escalate || 'an engineer').replace(/-/g, ' ');
    plan.push(MUST_BE_CHECKED.has(hazard.type)
      ? `Safety: a ${hazard.type.replace(/_/g, ' ')} hazard is active. The fixed safety warning is shown separately, do not repeat it. It must not be used again until a qualified engineer has checked it: say that plainly. You may explain the likely cause and suggest checks that are safe with it switched off ${hazard.type === 'electrical_water' ? 'at the consumer unit (fuse box), never touching the plug or socket while anything is wet' : 'and unplugged'}, but never say or imply that a check could make it safe to use, or that they might not need an engineer.`
      : `Safety: a ${hazard.type.replace(/_/g, ' ')} hazard is active. The fixed safety warning is shown separately, do not repeat it. Only suggest checks that are safe with the appliance switched off and unplugged, never running or testing it; recommend ${who} where the fault needs one.`);
  }
  // What we have already told them: the reply builds on it instead of repeating it.
  if (rec.advice.length) {
    plan.push(`Already told them (do not repeat any of it; build on it): ${Rec.adviceSummary(rec).join('; ')}.`);
    const waiting = Rec.checksAwaitingResult(rec);
    if (waiting.length) plan.push(`They have not reported the result of: ${waiting.map((x) => `"${x}"`).join('; ')}. Never say or imply they did it or what it showed.`);
    if (nothingNew) plan.push('Their latest message adds no new facts about the fault. Give the next step after what you already told them: if a check you gave is still outstanding, ask how it went; if an engineer is needed, explain how to arrange one.');
  }
  if (c.checks.length) plan.push(`Checks they have done and what they found: ${c.checks.map((x) => `${x.check} - ${x.result || 'done'}`).join('; ')}.`);
  const knownIds = [c.brand && `make ${c.brand.value}`, model && `model ${model}`, c.codes.length && `code${c.codes.length > 1 ? 's' : ''} ${c.codes.map((x) => x.code).join(', ')}`].filter(Boolean);
  if (knownIds.length) plan.push(`Already given by the customer, never ask for it again: ${knownIds.join('; ')}.`);
  const symptom = c.symptom && c.symptom.value;
  if (symptom) plan.push(`The fault they reported is: "${symptom}". Keep to it: never describe a symptom, result or state they have not told you.`);
  if (unsafe) plan.push(`They asked about something unsafe (${unsafe.replace(/_/g, ' ')}): do not explain how to do it; the fixed safety wording is shown separately. Offer the safe alternative.`);
  const declined = rec.asked.filter((a) => a.answer === 'does_not_know' || a.answer === 'cannot_or_will_not').map((a) => a.question);
  if (declined.length) plan.push(`Do not ask again (they could not or would not answer): ${declined.map((q) => `"${q}"`).join('; ')}.`);
  if (rec.stage === 1) {
    plan.push('Stage 1 (broad help): say what could cause this, most likely first, as possibilities rather than certainties, including simple causes (settings, loading, detergent, installation, or normal behaviour) where they fit. Then give the one or two safe checks, or the one question, that would best tell those causes apart. Do not ask for the model number in this reply. Do not tell them to buy, order or replace a part yet.');
    if (c.codes.length) plan.push('Explain what the error code means using ERROR CODES. If ERROR CODES does not resolve it, say plainly that you cannot confirm what it means on their model (it may not be an error code at all, for example part of the model name), never guess a meaning, and work from the symptoms.');
    return plan;
  }
  // Stage 2: the owner's checks did not fix it.
  if (!model && !c.modelUnavailable) {
    const where = LABEL_WHERE[appliance] || 'on the rating label';
    plan.push(`Stage 2: the checks they reported did not fix it. Say what that suggests, then ask for the ${c.brand ? '' : 'make and '}model number so we can find the right part; say it is usually ${where}. If the label cannot be reached right now (for example the door will not open), say it can wait.`);
  } else if (!model) {
    plan.push('Stage 2: the checks they reported did not fix it and they cannot reach the model label right now. Carry on without it: give the next check or say what the likely part is, and tell them where to find the model number later.');
  } else if (parts && parts.outcome === 'verified') {
    plan.push(`Stage 2: the checks point to the ${parts.component}. Say that, and that a matching part for model ${parts.catalogueModel} is shown below; they should check the listing matches their model before ordering. Mention when an engineer is the better choice.`);
  } else if (parts && parts.outcome === 'no_catalogue_part') {
    plan.push(`Stage 2: the checks point to the ${parts.component}, but we could not find a confirmed match for model ${model}. Say so, and suggest the manufacturer's spares or an engineer.`);
  } else {
    plan.push('Stage 2: the checks they reported did not fix it. Give the next check that best separates the remaining likely causes, or say what the likely faulty part is if the checks already point to one. Until a check has confirmed which part has failed, name it as the likely part and the check that would confirm it; do not tell them to buy, order or replace it.');
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

/**
 * A cause is a possibility until a check proves it: certainty words in the reply ("that confirms a defrost fault",
 * "it is definitely the pump") are softened, whatever the customer has checked. The customer's own "I confirmed" is
 * left alone (only the present-tense claim is changed).
 */
const CERTAINTY = [[/\bconfirms\b/g, 'suggests'], [/\bConfirms\b/g, 'Suggests'], [/\bdefinitely\b/g, 'most likely'], [/\bDefinitely\b/g, 'Most likely'], [/\bcertainly (?=(?:is|means|points|caused))/g, 'probably '], [/\bwithout (?:a|any) doubt\b/gi, 'most likely'], [/\balmost certainly\b/g, 'probably'], [/\bAlmost certainly\b/g, 'Probably'], [/\bstrongly suggests\b/g, 'suggests'], [/\bStrongly suggests\b/g, 'Suggests'], [/\ba classic sign of\b/g, 'a common sign of'], [/\bA classic sign of\b/g, 'A common sign of'], [/\b(?:the|The) classic sign of\b/g, 'a common sign of'], [/\bstrongly points to\b/g, 'points to'], [/\bstrongly point to\b/g, 'point to'], [/\bStrongly points to\b/g, 'Points to'], [/\bhighly likely\b/g, 'likely'], [/\bHighly likely\b/g, 'Likely'], [/\bis exactly what (?:we|you) (?:would )?expect\b/g, 'is consistent with what you would expect'], [/\bthe most reliable fix is to\b/g, 'the likely fix may be to'], [/\bThe most reliable fix is to\b/g, 'The likely fix may be to']];
function calibrate(reply) {
  let text = String(reply);
  let changed = 0;
  for (const [re, to] of CERTAINTY) text = text.replace(re, () => { changed += 1; return to; });
  return { text, changed };
}

// A physical check without isolation gets the isolation step first.
const PHYSICAL = /\b(unscrew|remove|take (?:out|off)|pull (?:out|off|back)|open (?:the |up )?(?:filter|flap|panel|cover|back|door seal|pump|sump)|lift (?:out|off)|(?:clean|wash|rinse) (?:the )?(?:filters?|condenser|pump|sump|drain|coils?|brush)|detach (?:the )?(?:wand|hose|head|floorhead|bin)|clear (?:the )?(?:filter|drain|hose|pump|blockage)|turn the impeller|reach (?:in|into)|tilt (?:it|the)|pull (?:it|the machine) (?:out|forward)|check inside|flush (?:the|out))\b/i;
const ISOLATED = /\b(unplug|unplugged|switch(?:ed)? (?:it |the \w+ )?off|isolat\w+|turn(?:ed)? (?:it )?off at|power off|power is off|off at the (?:wall|socket|fuse|consumer|cooker switch)|remove the battery|take the battery off)\b/i;
function stepPrecaution(reply, recentText, appliance, hazards = []) {
  if (!PHYSICAL.test(reply) || ISOLATED.test(reply) || ISOLATED.test(recentText || '')) return null;
  if (hazards.some((h) => h.type === 'electrical_water')) return 'First switch the circuit off at the consumer unit (fuse box); don\'t touch the plug or socket while anything is wet.';
  if (appliance === 'microwave') return 'Unplug it first and never remove the outer casing.';
  if (appliance === 'vacuum') return 'Switch it off and unplug it (or take the battery off) first.';
  if (appliance === 'oven-cooker' || appliance === 'hobs') return 'First switch it off at the wall or cooker switch and let it cool completely.';
  return 'Before you start, switch it off and unplug it.';
}

/**
 * Advice the evidence does not support yet, removed sentence by sentence:
 *   - buying, ordering or fitting a part before the fault is narrowed to one (Jev's label) or the catalogue confirms it;
 *   - saying the appliance has no recall: the recall store lists the notices it holds, so an empty result never proves
 *     there is none.
 */
const BUY_PART = /\b(?:buy|order|purchase|get hold of)\b[^.!?]{0,60}\b(?:part|replacement|pump|element|heater|belt|board|pcb|battery|thermostat|motor|pulley|kit|fuse|seal|sensor|valve|switch|module)\b|\b(?:you(?:'ll| will)? need to|you should) (?:replace|fit|order|buy)\b|\bthe (?:fix|solution|repair) is to (?:replace|fit)\b/i;
const RECALL_DENIAL = /\b(?:no|not any)\s+(?:known\s+|specific\s+|current\s+|active\s+|official\s+)*(?:safety\s+)?recalls?\b|\bnot (?:been )?(?:subject to|part of|affected by|covered by) (?:a|any) (?:safety )?recall\b|\bisn'?t (?:subject to|affected by|covered by|part of) (?:a|any) (?:safety )?recall\b|\bdon'?t need to worry about (?:a|any) (?:hidden )?(?:recall|modification)\b/i;
const REPLACE_COMPONENT = /\b(replace|replacing|Replace|Replacing)\b(?= (?:the|a|an|your|both|it with a|a new|the whole)(?: [\w()-]+){0,3} (?:pump|pulley|belt|element|heater|thermostat|board|pcb|motor|switch|interlock|bearing|sensor|valve|plate|battery|capacitor|magnetron|module|compressor|fuse|coupler|assembly|timer|lock|brushes)s?\b)/;
const NEGATED = /\b(?:don'?t|do not|never|avoid|no need to|shouldn'?t|before you)\b/i;
function removeUnconfirmedAdvice(reply, { narrowed }) {
  const sents = String(reply).match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [];
  const removed = [];
  const kept = sents.filter((x) => {
    if (RECALL_DENIAL.test(x)) { removed.push('recall-denial'); return false; }
    if (!narrowed && BUY_PART.test(x) && !NEGATED.test(x)) { removed.push('part-before-confirmed'); return false; }
    return true;
  }).map((x) => {
    // Replacing a component before a check confirms it becomes checking it; the advice (and any engineer) stays.
    if (narrowed || NEGATED.test(x) || !REPLACE_COMPONENT.test(x)) return x;
    removed.push('replace-before-confirmed');
    return x.replace(REPLACE_COMPONENT, (verb) => ({ replace: 'check', replacing: 'checking', Replace: 'Check', Replacing: 'Checking' })[verb]);
  });
  return { text: kept.join('').replace(/[ \t]{2,}/g, ' ').trim(), removed };
}

/** True when a reply copies one of our earlier replies (same opening, ignoring case, spacing and punctuation). */
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
function copiesEarlier(reply, messages) {
  const r = norm(reply);
  return r.length >= 60 && messages.some((m) => m.role === 'assistant' && norm(textOf(m.content)) === r);
}

/**
 * The claim check (the first rebuild's verifier): customer-specific claims the record does not support are objections
 * for the regeneration, and their sentences are removed from what is sent. A copied earlier reply is an objection too.
 * If the claim extractor cannot run, the turn fails explicitly.
 */
async function claimCheck(reply, facts, texts, messages, deps, audit) {
  const issues = [];
  const extract = async (system, user) => {
    const res = await deps.qwen.infer({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 700, temperature: 0, timeoutMs: 30000, responseFormat: V.EXTRACT_FORMAT, stream: false });
    if (res.status !== 200) { const e = new Error(`extractor http ${res.status}`); e.category = 'HTTP'; e.status = res.status; e.detail = res.errorDetail || null; throw e; }
    return { json: R.parseJson(res.text), usage: res.usage };
  };
  let verdict;
  try { verdict = await V.verify(reply, facts, texts, { extract }); } catch (e) { throw new ProviderUnavailableError('claim extractor unavailable', e); }
  audit.claims.checked += verdict.claims.length;
  audit.timings.verifyMs = (audit.timings.verifyMs || 0) + (verdict.extractor.ms || 0);
  for (const rj of verdict.rejected) {
    audit.claims.rejected.push({ claim: rj.claim, source: rj.source });
    issues.push({ kind: 'claim', text: `Unsupported claim about the customer (they did not say this): "${rj.claim}". Do not state it as fact; ask or hedge instead.` });
  }
  if (copiesEarlier(reply, messages)) issues.push({ kind: 'copied', text: 'Your draft repeated one of your earlier replies word for word. Do not repeat it: respond to what they just said and give a different next step (or say plainly that an engineer is needed and why).' });
  return { reply: verdict.rejected.length ? V.neutralise(verdict) : String(reply).trim(), issues };
}

/** Regenerate when removing unsupported claims would leave a damaged reply (empty, its question lost, most of it gone). */
function needsRegeneration(original, check) {
  if (!check.issues.length) return false;
  if (check.issues.some((i) => i.kind !== 'claim')) return true;
  const before = String(original || '').trim();
  const after = String(check.reply || '').trim();
  if (!after) return true;
  if (before.includes('?') && !after.includes('?')) return true;
  return after.length < before.length * 0.4;
}

function lastQuestion(reply) {
  const qs = (String(reply).match(/[^.!?\n]*\?/g) || []).map((s) => s.trim()).filter(Boolean);
  return qs.length ? qs[qs.length - 1] : null;
}

/**
 * input: { messages, state, tools: { recalls } }
 * deps:  { qwen: provider, jev: { evaluate({state, questions}) }, resolveCode, lookupParts, mediaCandidates, now? }
 */
async function runTurn(input, deps) {
  const now = deps.now || Date.now;
  const t0 = now();
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
    audit.timings.totalMs = now() - t0;
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
  const knownBefore = JSON.stringify(Rec.known(rec));
  applyLabels(rec, labels, u.reading);
  const nothingNew = knownBefore === JSON.stringify(Rec.known(rec)) && !labels.checkOutcome.value && labels.lastAnswer.value !== 'answered';
  const tags = { labels, reading: { appliance: u.reading.appliance, brand: u.reading.brand, model: u.reading.model, codes: u.reading.codes, symptom: u.reading.symptom }, stage: rec.stage };

  // 6 (first): safety. Gas or an active fire: fixed wording only.
  let hazard = applyHazards(rec, labels, messages, recalls);
  const unsafe = labels.unsafeRequest.value || S.detectUnsafeRequest(latest, rec.customer.appliance && rec.customer.appliance.value);
  if (hazard && hazard.policy.terminate) {
    for (const h of rec.hazards) h.shown = true;
    rec.outcome = 'safety_stop';
    audit.safety = { hazards: rec.hazards.map((h) => h.type), terminated: hazard.type, gates: [] };
    audit.tags = { ...tags, replyAction: { value: 'safety_stop', confidence: null } };
    audit.timings.totalMs = now() - t0;
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
    audit.timings.totalMs = now() - t0;
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

  // 7. Decide; 8. reason and reply (Qwen), then the claim check.
  const safetyNotes = [];
  const codeSafety = found.codeMeanings.find((r) => r.safety && r.safety.stopUse);
  if (codeSafety) safetyNotes.push(`The error code ${codeSafety.code} means it should not be used until checked${codeSafety.safety.reason ? ` (${codeSafety.safety.reason})` : ''}.`);
  const plan = decide(rec, u.reading, hazard, unsafe, parts, { nothingNew });
  const facts = Rec.evidence(rec);
  const context = {
    turn: rec.turn,
    messages,
    ledger: { facts, known: Rec.known(rec), alreadyAsked: rec.asked.map((a) => ({ question: a.question, answer: a.answer })) },
    tools: { errorCodes: found.codeMeanings, modelHints: rec.knowledge.modelInfo, recalls: found.recalls },
    knowledge: found.knowledge,
    normal: found.normal,
    safety: { activeHazards: rec.hazards.map((h) => h.type), unsafeRequest: unsafe || null, notes: safetyNotes },
    plan,
  };
  const reason = async (feedback) => {
    try { return await R.reason(deps.qwen, context, feedback ? { feedback } : {}); } catch (e) { throw new ProviderUnavailableError('diagnostic reasoner unavailable', e); }
  };
  audit.claims = { checked: 0, rejected: [] };
  let r = await reason(null);
  audit.timings.reasonMs = r.ms;
  audit.usage = r.usage;
  audit.plan = plan;
  let check = await claimCheck(r.proposal.reply, facts, texts, messages, deps, audit);
  // One regeneration with the objections when the clean-up would damage the reply, or when it copies an earlier one;
  // never replaced by fixed text. Only when another reasoning pass and claim check (estimated from this turn's) fit in
  // the turn's time budget: otherwise the claim check's clean-up stands, as a reply that never arrives helps nobody.
  const elapsed = now() - t0;
  const fits = elapsed + r.ms + (audit.timings.verifyMs || 0) <= REGENERATION_BUDGET_MS;
  if (needsRegeneration(r.proposal.reply, check) && !fits) {
    audit.safety.gates.push({ gate: 'regeneration-skipped', reason: 'time-budget', elapsedMs: elapsed });
  } else if (needsRegeneration(r.proposal.reply, check)) {
    audit.regenerated = true;
    if (check.issues.some((i) => i.kind === 'copied')) audit.safety.gates.push({ gate: 'copied-earlier-reply', rewritten: true });
    r = await reason(check.issues.map((i) => i.text));
    audit.timings.regenerateMs = r.ms;
    check = await claimCheck(r.proposal.reply, facts, texts, messages, deps, audit);
  }
  const a = r.proposal.assessment;
  audit.reasoning = { status: a.status, confidence: a.confidence, candidates: a.candidates.map((x) => `${x.cause} (${x.likelihood})`), next: r.proposal.next ? r.proposal.next.question : null };

  // 9. Final check.
  const gate = S.gateReply(check.reply || (r.proposal.next && r.proposal.next.question) || '', { hazards: rec.hazards, appliance });
  for (const v of gate.violations) audit.safety.gates.push({ gate: 'prohibited-advice', rule: v.rule });
  let gated = gate.text;
  if (hazard && MUST_BE_CHECKED.has(hazard.type)) {
    const sents = String(gated).match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [];
    const kept = sents.filter((x) => !UNSAFE_REASSURANCE.test(x));
    if (kept.length < sents.length) audit.safety.gates.push({ gate: 'unsafe-reassurance', removed: sents.length - kept.length });
    gated = kept.join('').trim();
  }
  const cal = calibrate(gated);
  if (cal.changed) audit.safety.gates.push({ gate: 'certainty', softened: cal.changed });
  gated = cal.text;
  const held = removeUnconfirmedAdvice(gated, { narrowed: Boolean(rec.narrowed) || Boolean(parts && parts.outcome === 'verified') });
  for (const g of held.removed) audit.safety.gates.push({ gate: g });
  gated = held.text;
  const ids = removeUnverifiedIdentifiers(gated, texts, rec);
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
  const caution = stepPrecaution(reply, `${texts.slice(-2).join(' ')} ${priorAssistant || ''}`, appliance, rec.hazards);
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
  const checks = found.knowledge.flatMap((k) => k.ownerSafeChecks || []);
  const rl = await J.labelReply(deps.jev, { reply, media: pool, checks });
  audit.timings.replyLabelMs = rl.ms;

  const q = lastQuestion(reply);
  if (q) Rec.noteAsked(rec, q, rec.turn);
  const action = rl.replyAction.value;
  Rec.noteAdvice(rec, { turn: rec.turn, action, check: rl.check, question: q });
  if (action === 'recommends_engineer' && rec.outcome !== 'fixed') rec.outcome = 'engineer';
  else if (action === 'suggests_part' && parts && parts.outcome === 'verified') rec.outcome = 'part';
  else if (action === 'says_normal') rec.outcome = 'normal';

  const escalation = hazard ? { to: hazard.policy.escalate || 'engineer', reason: hazard.type, forced: true } : (action === 'recommends_engineer' ? { to: 'engineer', reason: 'reply' } : null);
  audit.tags = { ...tags, stage: rec.stage, replyAction: rl.replyAction, checkGiven: rl.check || null, media: rl.media ? rl.media.id || rl.media.title || null : null,
    enrichment: { knowledgeIds: rec.knowledge.knowledgeIds, codes: found.codeMeanings.map((x) => ({ code: x.code, status: x.status })), recalls: recalls.length, parts: parts ? parts.outcome : 'none' } };
  audit.partGate = parts ? { outcome: parts.outcome, component: parts.component, reason: parts.reason || null } : { outcome: 'none' };
  audit.escalation = escalation;
  audit.timings.totalMs = now() - t0;

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

module.exports = { runTurn, ProviderUnavailableError, SCOPE_COPY, UNSAFE_REASSURANCE, decide, claimCheck, needsRegeneration, applyLabels, applyHazards, candidatesFor, removeUnverifiedIdentifiers, removeUnconfirmedAdvice, calibrate, copiesEarlier, stepPrecaution, lastQuestion };
