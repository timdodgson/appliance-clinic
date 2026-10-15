'use strict';
/**
 * Jev-led reply (experiment, AI config pipeline.mode = 'jev-led'). Qwen only reads the message (understand); after that
 * Jev chooses and code writes. No language model writes the reply:
 *
 *   1. code: fixed wording for the states code already knows (fixed, appliance unknown, part found / model needed)
 *   2. Jev:  from the retrieved notes, ONE situation (a cause, normal behaviour, or needs an engineer) and ONE next step
 *            (a check or a question), always its top choice, never one already given
 *   3. code: the reply from fixed wording and the notes' own text (error-code meaning, the cause, the check word for
 *            word, the normal-behaviour note, the engineer line)
 */
const { stripThinking, ProviderUnavailableError } = require('./util.js');

// The one free-text part (the owner's design, 2026-10-15): a direct question the customer asked ("is it worth fixing?")
// is answered by Qwen in a few sentences, above the fixed diagnosis. It answers that question only.
const QUESTION_SYSTEM = `You are Appliance Clinic, a UK home-appliance repair advisor. The customer asked a direct question. Answer ONLY that question, honestly and plainly, in 1 to 3 short sentences. Do not diagnose the fault, give checks or repeat what follows (the system adds the diagnosis and the next check after your answer). Use only what the customer said and the facts given; if the answer depends on something unknown, say what it depends on. Never suggest anything unsafe (no testing with the power on, no opening a microwave, no gas or refrigerant work, no bypassing safety devices). Do not invent part numbers, prices or model details. Plain text, no greeting.`;

const FIXED = 'Good news, that has sorted it. If it happens again, start with the same check. Is there anything else I can help with?';
const ASK_APPLIANCE = 'Which appliance is this (for example washing machine, dishwasher, oven), and what make is it?';
const ENGINEER = 'From what you have checked, this needs an appliance engineer to look at it: the next steps are beyond the checks that are safe to do yourself.';
const MORE = 'Could you tell me a bit more about what it is doing, and when it happens?';

const key = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
const sentence = (s) => { const t = String(s || '').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; };
const lower = (s) => { const t = String(s || '').trim(); return t ? t.charAt(0).toLowerCase() + t.slice(1) : ''; };
const stop = (s) => (/[.!?]$/.test(String(s).trim()) ? String(s).trim() : `${String(s).trim()}.`);

/** The options Jev chooses from: situations (causes, normal behaviour, engineer) and next steps (checks, questions). */
function options({ notes, normal, given }) {
  const seen = new Set();
  const uniq = (list) => list.filter((x) => { const k = key(x.text); if (!x.text || seen.has(k)) return false; seen.add(k); return true; });
  const causes = uniq(notes.flatMap((n) => [...(n.causes || []), ...(n.componentEvidence || []).map((c) => c.name)]).map((text) => ({ kind: 'cause', text }))).slice(0, 14);
  const normals = (normal || []).map((n) => ({ kind: 'normal', text: n.normal, warning: n.warningSigns })).slice(0, 3);
  const done = new Set((given || []).map(key));
  const fresh = (x) => !done.has(key(x.text));
  const checks = uniq(notes.flatMap((n) => [
    ...(n.ownerSafeChecks || []).map((text) => ({ kind: 'check', text })),
    ...(n.beforeReplacingAPart || []).map((text) => ({ kind: 'step', text })),
  ])).filter(fresh).slice(0, 16);
  const questions = uniq(notes.flatMap((n) => [n.clarifyingQuestion, n.secondaryQuestion]).filter(Boolean).map((text) => ({ kind: 'question', text }))).filter(fresh).slice(0, 6);
  return { situations: [...causes, ...normals], next: [...checks, ...questions] };
}

function chooseRequest({ texts, known, notes, normal, given }) {
  const o = options({ notes, normal, given });
  const label = (x) => (x.kind === 'normal' ? `Normal behaviour, not a fault: ${x.text}` : x.text);
  const show = (s) => (s.length > 220 ? `${s.slice(0, 219)}…` : s);
  const sit = o.situations.map((x, i) => ({ id: `s${i + 1}`, ...x }));
  const nxt = o.next.map((x, i) => ({ id: `n${i + 1}`, ...x }));
  const questions = {
    situation: { type: 'choice', instructions: 'From everything the customer has said (customerMessages) and the checks they reported (knownSoFar), which ONE best describes their situation? Use the guidance (the notes\' discriminators, the evidence for and against each component, and the normal-behaviour notes with their warning signs). Prefer a simple, common cause unless the evidence rules it out. engineer = their checks are done and the fault now needs an engineer, or the next step is beyond safe owner checks.',
      criteria: { ...Object.fromEntries(sit.map((x) => [x.id, show(label(x))])), engineer: 'Needs an engineer now' } },
  };
  if (nxt.length) {
    questions.next = { type: 'choice', instructions: 'Which ONE next step should the customer take now: the simplest, safest check that best confirms or rules out the most likely situation, or the question whose answer would best separate the likely causes? Never one already given (alreadyGiven) or already done (knownSoFar.checksDone). none = only if every step that applies has been done or given.',
      criteria: { ...Object.fromEntries(nxt.map((x) => [x.id, show(`${x.kind === 'question' ? 'Ask: ' : 'Check: '}${x.text}`)])), none: 'No step fits' } };
  }
  const guidance = notes.map((n) => ({ fault: n.fault, discriminators: n.discriminators, evidence: n.componentEvidence }));
  return { state: { customerMessages: texts, knownSoFar: known, alreadyGiven: given || [], guidance, normalBehaviour: normal || [] }, questions, plan: { sit, nxt } };
}

/** Jev's top choice, whatever its confidence; only an explicit none/engineer is not an option id. */
const top = (a) => (a && a.type === 'choice' && typeof a.choice === 'string' ? a.choice : null);

/** The reply's parts from Jev's choice. Each part is fixed wording or the notes' own text. */
function words({ situation, next }) {
  const out = [];
  if (situation === 'engineer') out.push(ENGINEER);
  else if (situation && situation.kind === 'normal') {
    out.push(`This sounds like normal behaviour rather than a fault: ${stop(situation.text)}`);
    if (situation.warning) out.push(`It would be worth a closer look if ${stop(lower(situation.warning))}`);
  } else if (situation) out.push(`From what you have described, the most likely cause is ${stop(lower(situation.text))}`);
  if (situation !== 'engineer' && next) {
    if (next.kind === 'check' || next.kind === 'question') out.push(sentence(next.text));
    else out.push(`Next: ${stop(sentence(next.text))} Let me know what you find.`);
  }
  return out;
}

/** Qwen answers the customer's direct question only; on any failure the reply goes without it. */
async function answerQuestion(qwen, { question, known }) {
  if (!qwen || !question) return null;
  try {
    const res = await qwen.infer({ messages: [{ role: 'system', content: QUESTION_SYSTEM }, { role: 'user', content: `What we know: ${JSON.stringify(known)}\n\nThe customer's question: ${question}` }], maxTokens: 220, temperature: 0.2, timeoutMs: 20000, stream: false });
    const t = res && res.status === 200 ? stripThinking(res.text).trim() : '';
    // At most two sentences: the answer, not a diagnosis.
    const sents = (t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) || [t]).slice(0, 2).join(' ').trim();
    return sents ? sents.slice(0, 400) : null;
  } catch { return null; }
}

/**
 * Compose one reply. Returns { reply, given: { check, question }, chosen } (given = what to record so it is never
 * offered again).
 */
async function composeLed({ jev, qwen, question, rec, texts, known, notes, normal, codeMeanings, hazardBlocking, parts, appliance, model, labelWhere }) {
  const c = rec.customer;
  // Qwen answers a direct question, except where code already answers it: a fixed fault, or an error code given this turn
  // (its meaning is the first line).
  const codeNow = c.codes.some((x) => x.turn === rec.turn);
  const answer = rec.outcome === 'fixed' || codeNow ? null : await answerQuestion(qwen, { question, known });
  const lead = answer ? [answer] : [];
  if (rec.outcome === 'fixed') return { reply: [...lead, FIXED].join(' '), given: {}, chosen: { state: 'fixed', answered: Boolean(answer) } };
  if (!appliance) return { reply: [...lead, ASK_APPLIANCE].join(' '), given: { question: ASK_APPLIANCE }, chosen: { state: 'no-appliance', answered: Boolean(answer) } };

  const lines = [...lead];
  // The error code, explained once, on the turn it was given.
  for (const code of c.codes.filter((x) => x.turn === rec.turn)) {
    const r = (codeMeanings || []).find((m) => m.code === code.code);
    if (r && r.status === 'RESOLVED' && r.meaning) lines.push(`${code.code}${c.brand ? ` on your ${c.brand.value}` : ''} means: ${stop(r.meaning)}`);
    else lines.push(`I can't confirm what ${code.code} means on your model, so I'll go by what it is doing.`);
  }

  // Parts: code already knows (the checks narrowed it to one component).
  if (rec.narrowed) {
    const comp = rec.narrowed.component;
    if (parts && parts.outcome === 'verified') {
      lines.push(`The checks point to the ${comp}. A matching part for model ${parts.catalogueModel} is shown below; check the listing matches your model before ordering. If you would rather not fit it yourself, an appliance engineer can.`);
      return { reply: lines.join(' '), given: {}, chosen: { state: 'part-verified', component: comp } };
    }
    if (!model && !c.modelUnavailable) {
      const ask = `To find the right part, could you give me the ${c.brand ? '' : 'make and '}model number? It is usually ${labelWhere}.`;
      lines.push(`The checks point to the ${comp}. ${ask}`);
      return { reply: lines.join(' '), given: { question: ask }, chosen: { state: 'model-needed', component: comp } };
    }
    if (parts && parts.outcome === 'no_catalogue_part') {
      lines.push(`The checks point to the ${comp}. I could not find a confirmed match for model ${model} in our parts catalogue, so check with the manufacturer or a parts supplier using the full model number, or ask an appliance engineer to fit it.`);
      return { reply: lines.join(' '), given: {}, chosen: { state: 'part-not-found', component: comp } };
    }
  }

  if (hazardBlocking) {
    lines.push(ENGINEER);
    return { reply: lines.join(' '), given: {}, chosen: { state: 'hazard' } };
  }

  const given = [...rec.advice.map((a) => a.check), ...rec.asked.map((a) => a.question)].filter(Boolean);
  const req = chooseRequest({ texts, known, notes, normal, given });
  let situation = null;
  let next = null;
  const t0 = Date.now();
  if (req.plan.sit.length || req.plan.nxt.length) {
    let r;
    try { r = await jev.evaluate({ state: req.state, questions: req.questions }); } catch (e) { throw new ProviderUnavailableError('Jev unavailable', e); }
    const a = (r && r.answers) || {};
    const s = top(a.situation);
    situation = s === 'engineer' ? 'engineer' : req.plan.sit.find((x) => x.id === s) || null;
    const n = top(a.next);
    next = req.plan.nxt.find((x) => x.id === n) || null;
  }
  const ms = Date.now() - t0;
  // The cause is said when it is new or has changed; the next step is new every turn.
  const sitKey = situation === 'engineer' ? 'engineer' : situation ? key(situation.text) : null;
  const sameCause = sitKey && sitKey !== 'engineer' && rec.led && rec.led.situation === sitKey;
  lines.push(...words({ situation: sameCause ? null : situation, next }));
  rec.led = { situation: sitKey };
  if (!next && situation !== 'engineer') {
    // Nothing left to check: the top note's own question, if not asked yet, else ask for more.
    const q = notes.map((n) => n.clarifyingQuestion).find((x) => x && !given.some((g) => key(g) === key(x)));
    lines.push(q || MORE);
    next = { kind: 'question', text: q || MORE };
  }
  return {
    reply: lines.join(' '),
    given: next ? (next.kind === 'question' ? { question: next.text } : { check: next.text }) : {},
    chosen: { state: 'chosen', answered: Boolean(answer), situation: situation === 'engineer' ? 'engineer' : situation && { kind: situation.kind, text: situation.text }, next: next && { kind: next.kind, text: next.text }, ms },
  };
}

module.exports = { composeLed, answerQuestion, chooseRequest, options, words, QUESTION_SYSTEM, FIXED, ENGINEER, ASK_APPLIANCE };
