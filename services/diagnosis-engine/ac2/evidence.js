'use strict';
/**
 * Evidence mode (experiment, AI config pipeline.mode = 'jev-evidence'). The owner's design: Jev only answers questions
 * about the customer's own words, each in the form that fits it, and code does the reasoning.
 *
 *   1. Jev (choice):   which retrieved fault note matches what the customer describes (or none)
 *   2. Jev (per item): for each piece of evidence in that note: the customer says it is so / says it is not / not said;
 *                      for each check and question: has the customer already done or answered it (yes / no)
 *   3. code:           scores each cause from the evidence (supports +1, a support denied -0.5, against -2), takes the
 *                      top cause, and chooses the next step: the question that separates two close causes, else the
 *                      first check not done, else the note's question, else the engineer
 *
 * Only notes with component evidence (supports / against) can be scored; for the others the turn keeps the usual path.
 */
const { ProviderUnavailableError } = require('./util.js');

const key = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
const MAX_ITEMS = 36;
const MAX_STEPS = 12;

async function ask(jev, state, questions) {
  try { return ((await jev.evaluate({ state, questions })) || {}).answers || {}; } catch (e) { throw new ProviderUnavailableError('Jev unavailable', e); }
}
const top = (a) => (a && a.type === 'choice' && typeof a.choice === 'string' ? a.choice : null);
const yes = (a) => Boolean(a && a.type === 'noul' && typeof a.noul === 'number' && a.noul >= 0.65);

/** 1. Which note the customer's description matches. */
async function pickNote(jev, { texts, known, notes }) {
  if (!notes.length) return null;
  const opts = notes.map((n, i) => ({ id: `f${i + 1}`, note: n }));
  const a = await ask(jev, { customerMessages: texts, knownSoFar: known }, {
    fault: { type: 'choice', instructions: 'Which of these faults matches what the customer describes (customerMessages)? none = none of them.',
      criteria: { ...Object.fromEntries(opts.map((o) => [o.id, `${o.note.fault} (${o.note.knowledgeId})`])), none: 'None of these' } },
  });
  const id = top(a.fault);
  return (opts.find((o) => o.id === id) || {}).note || null;
}

/** The evidence items of a note (deduplicated), and the candidate steps. */
function itemsOf(note) {
  const seen = new Map();
  for (const c of note.componentEvidence || []) {
    for (const s of c.supports || []) if (!seen.has(key(s))) seen.set(key(s), s);
    for (const s of c.against || []) if (!seen.has(key(s))) seen.set(key(s), s);
  }
  const items = [...seen.values()].slice(0, MAX_ITEMS);
  const steps = [
    ...(note.ownerSafeChecks || []).map((text) => ({ kind: 'check', text })),
    ...(note.beforeReplacingAPart || []).map((text) => ({ kind: 'step', text })),
    ...[note.clarifyingQuestion, note.secondaryQuestion].filter(Boolean).map((text) => ({ kind: 'question', text })),
  ].slice(0, MAX_STEPS);
  return { items, steps };
}

/** 2. What the customer has said about each item, and which steps they have already done or answered. */
async function readEvidence(jev, { texts, known, note }) {
  const { items, steps } = itemsOf(note);
  const questions = {};
  items.forEach((it, i) => {
    questions[`e${i}`] = { type: 'choice', instructions: `From everything the customer has said (customerMessages), is this true of their appliance: "${it}"?`,
      criteria: { said_yes: 'The customer says or clearly shows this is so', said_no: 'The customer says or clearly shows this is not so', not_said: 'Not said either way' } };
  });
  steps.forEach((s, i) => {
    questions[`d${i}`] = { type: 'noul', instructions: s.kind === 'question'
      ? `Has the customer already given the answer to this question (customerMessages): "${s.text}"?`
      : `Has the customer already done this check or reported what it showed (customerMessages): "${s.text}"?`, criteria: { true: 'Already done or answered', false: 'Not yet' } };
  });
  const a = await ask(jev, { customerMessages: texts, knownSoFar: known }, questions);
  const said = new Map(items.map((it, i) => [key(it), top(a[`e${i}`]) || 'not_said']));
  const done = steps.map((s, i) => ({ ...s, done: yes(a[`d${i}`]) }));
  return { said, steps: done };
}

/** 3a. Score each cause from the evidence (code, deterministic). Ties keep the note's own order (simplest first). */
function rank(note, said) {
  return (note.componentEvidence || []).map((c, order) => {
    let score = 0;
    for (const s of c.supports || []) { const v = said.get(key(s)); if (v === 'said_yes') score += 1; else if (v === 'said_no') score -= 0.5; }
    for (const s of c.against || []) if (said.get(key(s)) === 'said_yes') score -= 2;
    const unknown = (c.supports || []).filter((s) => (said.get(key(s)) || 'not_said') === 'not_said');
    return { name: c.name, type: c.type, score, order, unknown };
  }).sort((x, y) => y.score - x.score || x.order - y.order);
}

/** 3b. The next step (code). given: what earlier replies already gave or asked. */
function nextStep(ranked, steps, given) {
  const old = new Set((given || []).map(key));
  const fresh = (t) => !old.has(key(t));
  const [first, second] = ranked;
  // Two causes close together: ask about evidence that would separate them.
  if (first && second && first.score - second.score < 1) {
    const q = first.unknown.find((u) => !second.unknown.some((v) => key(v) === key(u)) && fresh(`Can you tell me whether ${u}?`));
    if (q) return { kind: 'question', text: `Can you tell me whether ${q}?` };
  }
  const check = steps.find((s) => s.kind !== 'question' && !s.done && fresh(s.text));
  if (check) return check;
  const question = steps.find((s) => s.kind === 'question' && !s.done && fresh(s.text));
  if (question) return question;
  return { kind: 'engineer' };
}

module.exports = { pickNote, readEvidence, rank, nextStep, itemsOf };
