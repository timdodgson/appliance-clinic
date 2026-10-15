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
const EV = require('./evidence.js');

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

function chooseRequest({ texts, known, notes, normal, given, allowEngineer = true }) {
  const o = options({ notes, normal, given });
  const label = (x) => (x.kind === 'normal' ? `Normal behaviour, not a fault: ${x.text}` : x.text);
  const show = (s) => (s.length > 220 ? `${s.slice(0, 219)}…` : s);
  const sit = o.situations.map((x, i) => ({ id: `s${i + 1}`, ...x }));
  const nxt = o.next.map((x, i) => ({ id: `n${i + 1}`, ...x }));
  const questions = {
    situation: { type: 'choice', instructions: 'From everything the customer has said (customerMessages) and the checks they reported (knownSoFar), which ONE best describes their situation? Use the guidance (the notes\' discriminators, the evidence for and against each component, and the normal-behaviour notes with their warning signs). Prefer a simple, common cause unless the evidence rules it out. engineer = their checks are done and the fault now needs an engineer, or the next step is beyond safe owner checks.',
      // "Needs an engineer" only once the customer has done checks: never as the first answer to a new fault.
      criteria: { ...Object.fromEntries(sit.map((x) => [x.id, show(label(x))])), ...(allowEngineer ? { engineer: 'Needs an engineer now' } : {}) } },
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
    if (next.kind === 'check' || next.kind === 'question' || next.kind === 'retest') out.push(sentence(next.text));
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
async function composeLed({ jev, qwen, question, rec, texts, known, notes, normal, codeMeanings, hazardBlocking, parts, appliance, model, labelWhere, evidenceNote = null }) {
  const c = rec.customer;
  // Qwen answers a direct question, except where code already answers it: a fixed fault, or an error code given this turn
  // (its meaning is the first line).
  const codeNow = c.codes.some((x) => x.turn === rec.turn);
  // A generic "what next?" is answered by the next step itself, not by Qwen.
  const generic = /\b(what (should|do|can) i (do|check|try)( next| now)?|what next|what now|anything else|is there (anything|something) else)\b/i.test(String(question || ''));
  const answer = rec.outcome === 'fixed' || codeNow || generic ? null : await answerQuestion(qwen, { question, known });
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
  if (evidenceNote) {
    // Evidence mode: Jev reads the customer's words item by item; code scores the causes and picks the next step.
    const t1 = Date.now();
    const ev = await EV.readEvidence(jev, { texts, known, note: evidenceNote });
    const ranked = EV.rank(evidenceNote, ev.said);
    const step = EV.nextStep(ranked, ev.steps, given);
    const lead0 = ranked[0];
    const sitKey = lead0 ? key(lead0.name) : null;
    const sameCause = sitKey && rec.led && rec.led.situation === sitKey;
    rec.led = { situation: sitKey, evidence: true };
    if (step.kind === 'engineer') {
      if (lead0 && lead0.type === 'part' && lead0.score >= 1) {
        rec.narrowed = { component: lead0.name, confidence: null, turn: rec.turn };
        rec.stage = 2;
        const ask = !model && !c.modelUnavailable ? ` To find the right part, could you give me the ${c.brand ? '' : 'make and '}model number? It is usually ${labelWhere}.` : '';
        lines.push(`From what you have checked, this points to the ${lower(lead0.name)}.${ask || ' An appliance engineer can confirm it and fit the part.'}`);
        return { reply: lines.join(' '), given: ask ? { question: ask.trim() } : {}, chosen: { state: 'evidence', answered: Boolean(answer), ranked: ranked.slice(0, 3), next: 'part', ms: Date.now() - t1 } };
      }
      lines.push(ENGINEER);
      return { reply: lines.join(' '), given: {}, chosen: { state: 'evidence', answered: Boolean(answer), ranked: ranked.slice(0, 3), next: 'engineer', ms: Date.now() - t1 } };
    }
    if (lead0 && !sameCause) lines.push(`From what you have described, the most likely cause is ${stop(lower(lead0.name))}`);
    lines.push(...words({ situation: null, next: step }));
    return { reply: lines.join(' '), given: step.kind === 'question' ? { question: step.text } : { check: step.text },
      chosen: { state: 'evidence', answered: Boolean(answer), ranked: ranked.slice(0, 3), next: { kind: step.kind, text: step.text }, ms: Date.now() - t1 } };
  }
  // Round 2 (the review of tests 1-10): one note, clean options, steps the customer did, answered, refused or made
  // pointless are removed before Jev picks, and once the findings show the fault no more diagnostic steps.
  const t0 = Date.now();
  const note = (await EV.pickNote(jev, { texts, known, notes })) || notes[0] || null;
  const o = cleanOptions({ note, normal, given, afterFindings: c.checks.length > 0 });
  const sit = o.situations.map((x, i) => ({ id: `s${i + 1}`, ...x }));
  const steps = o.steps.map((x, i) => ({ id: `n${i + 1}`, ...x }));
  const allowEngineer = c.checks.length > 0 || rec.stage === 2;
  const state = { customerMessages: texts, knownSoFar: known, errorCodeMeanings: (codeMeanings || []).filter((m) => m.status === 'RESOLVED').map((m) => `${m.code}: ${m.meaning}`),
    alreadyGiven: given, guidance: note ? { fault: note.fault, discriminators: note.discriminators, evidence: note.componentEvidence } : null, normalBehaviour: normal || [] };
  const show = (x) => (x.length > 220 ? `${x.slice(0, 219)}…` : x);
  const q2 = {
    situation: { type: 'choice', instructions: 'From everything the customer has said (customerMessages), the checks they reported (knownSoFar) and the error-code meanings, which ONE best describes their situation? Use the guidance (discriminators, evidence for and against each cause) and the normal-behaviour notes. Prefer a simple, common cause unless their evidence rules it out.' + (allowEngineer ? ' engineer = their checks are done and it now needs an engineer.' : ''),
      criteria: { ...Object.fromEntries(sit.map((x) => [x.id, show(x.kind === 'normal' ? `Normal behaviour, not a fault: ${x.text}` : x.text)])), ...(allowEngineer ? { engineer: 'Needs an engineer now' } : {}) } },
    settled: { type: 'noul', instructions: 'Do the customer\'s own findings already show what the fault is (for example they found the blockage, the damaged part, or the cause is clearly confirmed)?', criteria: { true: 'Yes, the findings show it', false: 'Not yet' } },
  };
  steps.forEach((x) => {
    q2[`done_${x.id}`] = { type: 'noul', instructions: `Has the customer already done this, or already given the answer (customerMessages): "${show(x.text)}"?`, criteria: { true: 'Already done or answered', false: 'No' } };
    q2[`refused_${x.id}`] = { type: 'noul', instructions: `Has the customer said they cannot or will not do this: "${show(x.text)}"?`, criteria: { true: 'Cannot or will not', false: 'No' } };
    q2[`pointless_${x.id}`] = { type: 'noul', instructions: `Does what the customer has already said make this step pointless or contradict it (for example it checks something they already ruled out): "${show(x.text)}"?`, criteria: { true: 'Pointless now', false: 'Still useful' } };
  });
  const a2 = await askJev(jev, state, q2);
  const yes = (v) => Boolean(v && v.type === 'noul' && typeof v.noul === 'number' && v.noul >= 0.65);
  const sId = top(a2.situation);
  const situation = sId === 'engineer' ? 'engineer' : sit.find((x) => x.id === sId) || null;
  const settled = yes(a2.settled);
  const usable = steps.filter((x) => !yes(a2[`done_${x.id}`]) && !yes(a2[`refused_${x.id}`]) && !yes(a2[`pointless_${x.id}`]));
  const removed = steps.length - usable.length;

  let next = null;
  const sitKey = situation === 'engineer' ? 'engineer' : situation ? key(situation.text) : null;
  const sameCause = sitKey && sitKey !== 'engineer' && rec.led && rec.led.situation === sitKey;
  rec.led = { situation: sitKey };
  const ev = note && situation && situation !== 'engineer' && situation.kind === 'cause' ? (note.componentEvidence || []).find((x) => key(x.name) === key(situation.text)) : null;
  if (settled && situation && situation !== 'engineer' && situation.kind === 'cause') {
    // The findings show the fault: no more diagnosis. A part: the parts path (model number). A check-type cause: test it.
    if (ev && ev.type === 'part') {
      rec.narrowed = { component: situation.text, confidence: null, turn: rec.turn };
      rec.stage = 2;
      const ask = !model && !c.modelUnavailable ? ` To find the right part, could you give me the ${c.brand ? '' : 'make and '}model number? It is usually ${labelWhere}.` : ' An appliance engineer can confirm it and fit the part.';
      lines.push(`From what you have found, this points to the ${lower(situation.text)}.${ask}`);
      return { reply: lines.join(' '), given: { question: ask.trim() }, chosen: { state: 'settled-part', answered: Boolean(answer), situation: situation.text, removed, ms: Date.now() - t0 } };
    }
    const retest = usable.find((x) => x.kind === 'retest');
    next = retest || { kind: 'question', text: 'Once that is sorted, run it again: does it work normally now?' };
    lines.push(`That fits ${stop(lower(situation.text))}`);
    lines.push(sentence(next.text));
  } else {
    if (usable.length > 1) {
      const a3 = await askJev(jev, { ...state, mostLikely: situation === 'engineer' ? 'needs an engineer' : situation && situation.text }, {
        next: { type: 'choice', instructions: 'Which ONE of these should the customer do next: the simplest, safest step that best confirms or rules out the most likely situation (mostLikely), or the question whose answer would best separate the likely causes?',
          criteria: Object.fromEntries(usable.map((x) => [x.id, show(`${x.kind === 'question' ? 'Ask: ' : 'Do: '}${x.text}`)])) } });
      next = usable.find((x) => x.id === top(a3.next)) || usable[0];
    } else next = usable[0] || null;
    lines.push(...words({ situation: sameCause ? null : situation, next: situation === 'engineer' ? null : next }));
    if (!next && situation !== 'engineer') {
      next = { kind: 'question', text: (note && note.clarifyingQuestion && !given.some((g) => key(g) === key(note.clarifyingQuestion))) ? note.clarifyingQuestion : MORE };
      lines.push(next.text);
    }
  }
  return {
    reply: lines.join(' '),
    given: next ? (next.kind === 'question' ? { question: next.text } : { check: next.text }) : {},
    chosen: { state: 'chosen', answered: Boolean(answer), note: note && note.knowledgeId, settled, situation: situation === 'engineer' ? 'engineer' : situation && { kind: situation.kind, text: situation.text },
      next: next && { kind: next.kind, text: next.text }, ms: Date.now() - t0,
      // What Jev had to choose from (for review), and how many steps were removed as done, refused or pointless.
      offered: { situations: sit.map((x) => `${x.kind}: ${x.text}`), next: usable.map((x) => `${x.kind}: ${x.text}`), removed: steps.filter((x) => !usable.includes(x)).map((x) => x.text.slice(0, 80)), engineerAllowed: allowEngineer } },
  };
}

async function askJev(jev, state, questions) {
  try { return ((await jev.evaluate({ state, questions })) || {}).answers || {}; } catch (e) { throw new ProviderUnavailableError('Jev unavailable', e); }
}

// Note steps written to follow an earlier step: dropped ("change that"), or kept only as a re-test after a finding.
const IN_SEQUENCE = /^if you haven'?t already\b|\b(change|do) that\b|\bthat option\b/i;
const RETEST = /^now that\b|^now (turn|run|start)\b|\bagain\b.*\?$|^(turn|run) .* (back on|again)/i;

/** One note's options, cleaned: causes in one wording, steps that stand on their own, nothing already given. */
function cleanOptions({ note, normal, given, afterFindings }) {
  const old = new Set((given || []).map(key));
  const seen = new Set();
  const once = (t) => { const k = key(t); if (!t || seen.has(k) || old.has(k)) return false; seen.add(k); return true; };
  const causes = note ? ((note.componentEvidence || []).length ? note.componentEvidence.map((x) => x.name) : (note.causes || []).length ? note.causes : (note.likelyComponents || [])) : [];
  const situations = [...causes.slice(0, 10).map((text) => ({ kind: 'cause', text })), ...(normal || []).slice(0, 3).map((n) => ({ kind: 'normal', text: n.normal, warning: n.warningSigns }))];
  const raw = note ? [
    ...(note.ownerSafeChecks || []).map((text) => ({ kind: 'check', text: String(text).replace(/^next,\s*/i, '') })),
    ...(note.beforeReplacingAPart || []).map((text) => ({ kind: 'step', text })),
    ...[note.clarifyingQuestion, note.secondaryQuestion].filter(Boolean).map((text) => ({ kind: 'question', text })),
  ] : [];
  const steps = raw.filter((x) => !IN_SEQUENCE.test(x.text)).map((x) => (RETEST.test(x.text) ? { ...x, kind: 'retest' } : x))
    .filter((x) => (x.kind !== 'retest' || afterFindings) && once(x.text)).slice(0, 12);
  return { situations, steps };
}

module.exports = { composeLed, answerQuestion, chooseRequest, options, cleanOptions, words, QUESTION_SYSTEM, FIXED, ENGINEER, ASK_APPLIANCE };
