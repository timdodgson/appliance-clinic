'use strict';
/**
 * The conversation record (ac3/1), stored by the BFF in DynamoDB between messages.
 *
 *   customer   what the customer told us (labelled by Jev from their own words): appliance, brand, model, codes,
 *              symptom, checks they did and what happened, whether they can reach the model label
 *   knowledge  what our tools added (RAG fault notes, likely causes and components, error-code meanings, model info)
 *              kept apart from customer facts so a guess is never recorded as something the customer said
 *   asked      questions we asked and how they were answered
 *   advice     what each of our replies did (Jev's reply label), the check it gave and the question it asked, so the
 *              next reply builds on it instead of repeating it
 *   hazards    hazards seen so far and whether the fixed wording was shown
 *   stage      1 = broad help and safe checks, 2 = DIY checks failed: narrow, get the model, suggest a part
 */
const SCHEMA = 'ac3/1';

function empty() {
  return {
    schema: SCHEMA,
    turn: 0,
    customer: { appliance: null, brand: null, model: null, codes: [], symptom: null, symptomArea: null, checks: [], modelUnavailable: false },
    knowledge: { knowledgeIds: [], fault: null, causes: [], components: [], codeMeanings: [], modelInfo: [] },
    asked: [],
    advice: [],
    hazards: [],
    stage: 1,
    narrowed: null,
    outcome: null,
  };
}

function load(state) {
  if (!state || state.schema !== SCHEMA) return empty();
  const base = empty();
  return { ...base, ...JSON.parse(JSON.stringify(state)), customer: { ...base.customer, ...state.customer }, knowledge: { ...base.knowledge, ...state.knowledge } };
}

/** Set a labelled customer value; a confident new label replaces the old one (the customer corrected it). */
function setValue(rec, field, value, confidence, turn) {
  if (!value) return;
  const cur = rec.customer[field];
  if (cur && cur.value === value) { cur.confidence = Math.max(cur.confidence || 0, confidence || 0); return; }
  rec.customer[field] = { value, confidence: confidence == null ? null : Math.round(confidence * 100) / 100, turn };
}

function addCode(rec, code, turn) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || rec.customer.codes.some((x) => x.code === c)) return;
  rec.customer.codes.push({ code: c, turn });
}

function addCheck(rec, check, result, turn) {
  const c = String(check || '').trim().slice(0, 120);
  if (!c) return;
  const r = String(result || '').trim().slice(0, 160);
  const prior = rec.customer.checks.find((x) => x.check.toLowerCase() === c.toLowerCase());
  if (prior) { prior.result = r || prior.result; prior.turn = turn; return; }
  rec.customer.checks.push({ check: c, result: r, turn });
  if (rec.customer.checks.length > 12) rec.customer.checks.shift();
}

function noteAsked(rec, question, turn) {
  const q = String(question || '').trim().slice(0, 200);
  if (!q) return;
  rec.asked.push({ question: q, turn, answer: null });
  if (rec.asked.length > 10) rec.asked.shift();
}

function resolveLastAsked(rec, answer) {
  const last = rec.asked[rec.asked.length - 1];
  if (last && !last.answer && answer) last.answer = answer;
}

/** What one of our replies did: its action label, the check it gave and the question it asked. */
function noteAdvice(rec, { turn, action, check, question }) {
  rec.advice.push({ turn, action: action || null, check: check ? String(check).slice(0, 160) : null, question: question ? String(question).slice(0, 200) : null });
  if (rec.advice.length > 8) rec.advice.shift();
}

/** Our earlier replies in one line each, for the plan. */
function adviceSummary(rec) {
  return rec.advice.map((a) => [`turn ${a.turn}: ${String(a.action || 'reply').replace(/_/g, ' ')}`, a.check ? `check given: "${a.check}"` : null, a.question ? `asked: "${a.question}"` : null].filter(Boolean).join(', '));
}

/** What we already know, for the prompts: the reply must never ask for any of it. */
function known(rec) {
  const c = rec.customer;
  const v = (x) => (x ? x.value : null);
  return {
    appliance: v(c.appliance), brand: v(c.brand), model: v(c.model), codes: c.codes.map((x) => x.code),
    symptom: v(c.symptom), checksDone: c.checks.map((x) => `${x.check}: ${x.result || 'done'}`),
    modelLabelUnreachable: c.modelUnavailable || false,
  };
}

module.exports = { SCHEMA, empty, load, setValue, addCode, addCheck, noteAsked, resolveLastAsked, noteAdvice, adviceSummary, known };
