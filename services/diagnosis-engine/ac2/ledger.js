'use strict';
/**
 * The canonical evidence ledger (ac2/1). Deterministic.
 *
 * Every fact the conversation relies on is recorded here with its provenance: which turn it came from, the
 * customer's exact words where it came from the customer, its source (customer | tool | observation | inference)
 * and its status (stated | observed | inferred | uncertain | contradicted). The reasoner proposes updates; this
 * module decides what is recorded. A proposed customer fact whose quote is not in the customer's own messages is
 * never recorded as a customer fact: it is kept as an inference. A new customer value for a field that already
 * holds a different customer value marks the older one contradicted and keeps both.
 */

const SCHEMA = 'ac2/1';
const SOURCES = new Set(['customer', 'tool', 'observation', 'inference']);
const STATUSES = new Set(['stated', 'observed', 'inferred', 'uncertain', 'contradicted']);
const CUSTOMER_STATUSES = new Set(['stated', 'observed', 'uncertain']);
const MAX_FACTS = 80;
const MAX_ASKED = 40;

function empty() {
  return {
    schema: SCHEMA,
    turn: 0,
    appliance: null, // { value, status: 'stated'|'inferred', quote, turn, confidence }
    brand: null, // { value, status, quote, turn }
    model: null, // { value, status: 'stated'|'provisional'|'unavailable', quote, turn, family }
    codes: [], // { code, quote, turn }
    facts: [], // see recordFact
    asked: [], // { key, text, turn, times, resolution: 'open'|'answered'|'unknown'|'declined' }
    hazard: null, // { type, turn, quote, terminate }
    scope: null, // { status: 'in'|'out', appliance }
    outcome: null, // last structured outcome, for audit only
    nextId: 1,
  };
}

/** Lower-case, collapse whitespace and strip punctuation, for quote matching. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'%./-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when `quote` is the customer's own words: it appears, normalised, in one of their messages. */
const QSTOP = new Set('a an the and or but it its is are was were be i my me we our to of in on at for with so it\'s that this there just'.split(' '));
function qwords(s) { return norm(s).split(' ').filter((w) => w && !QSTOP.has(w)); }
function grounded(quote, customerTexts) {
  const q = norm(quote);
  if (q.length < 2) return false;
  if (customerTexts.some((t) => norm(t).includes(q))) return true;
  // A lightly paraphrased quote still counts when nearly all its words are in one customer message.
  const qw = qwords(quote);
  if (qw.length < 2) return false;
  return customerTexts.some((t) => {
    const tw = new Set(qwords(t));
    const hit = qw.filter((w) => tw.has(w) || tw.has(w.replace(/(s|ly|ing|ed)$/, ''))).length;
    return hit / qw.length >= 0.75;
  });
}

function clone(state) {
  return JSON.parse(JSON.stringify(state || empty()));
}

function valueKey(v) {
  return norm(typeof v === 'string' ? v : JSON.stringify(v));
}

/**
 * Record one fact proposal. Returns the stored fact (or null when rejected).
 * proposal: { field, value, quote?, source?, status?, confidence? }
 */
function recordFact(state, proposal, ctx) {
  const field = String((proposal && proposal.field) || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!field || proposal.value === undefined || proposal.value === null || proposal.value === '') return null;
  let source = SOURCES.has(proposal.source) ? proposal.source : 'customer';
  let status = STATUSES.has(proposal.status) ? proposal.status : (source === 'customer' ? 'stated' : 'inferred');
  const quote = proposal.quote ? String(proposal.quote).slice(0, 240) : null;
  const notes = [];

  if (source === 'customer') {
    if (!quote || !grounded(quote, ctx.customerTexts)) {
      // Never silently turn an inference into a customer fact.
      source = 'inference';
      status = 'inferred';
      notes.push('quote-not-found');
    } else if (!CUSTOMER_STATUSES.has(status)) {
      status = 'stated';
    }
  } else if (source === 'inference') {
    status = status === 'uncertain' ? 'uncertain' : 'inferred';
  }
  // Only the kernel's tools produce tool facts.
  if (source === 'tool' && !ctx.fromTool) { source = 'inference'; status = 'inferred'; notes.push('tool-source-claimed'); }

  const value = typeof proposal.value === 'string' ? proposal.value.slice(0, 200) : proposal.value;
  const confidence = typeof proposal.confidence === 'number' ? Math.max(0, Math.min(1, proposal.confidence)) : null;
  const live = state.facts.filter((f) => f.field === field && f.status !== 'contradicted');

  // Same field, same value: refresh rather than duplicate.
  const same = live.find((f) => valueKey(f.value) === valueKey(value));
  if (same) {
    if (rank(source) > rank(same.source)) Object.assign(same, { source, status, quote, turn: ctx.turn });
    return same;
  }
  const fact = { id: `f${state.nextId++}`, field, value, turn: ctx.turn, quote: source === 'customer' ? quote : null, source, status, confidence };
  if (notes.length) fact.notes = notes;

  if (source === 'customer') {
    // A new customer value contradicts an earlier customer value for the same field; an inference is superseded.
    for (const f of live) {
      if (f.source === 'customer') {
        f.status = 'contradicted';
        f.contradictedBy = fact.id;
        fact.contradicts = (fact.contradicts || []).concat(f.id);
      } else if (f.source === 'inference') {
        f.status = 'contradicted';
        f.contradictedBy = fact.id;
      }
    }
  } else if (live.some((f) => f.source === 'customer' || f.source === 'tool')) {
    // An inference never overrides what the customer said or a tool returned.
    return null;
  }
  state.facts.push(fact);
  if (state.facts.length > MAX_FACTS) state.facts.splice(0, state.facts.length - MAX_FACTS);
  return fact;
}

function rank(source) {
  return { inference: 0, observation: 1, tool: 2, customer: 3 }[source] || 0;
}

/** Facts usable as evidence for a customer-facing factual claim. */
function supportingFacts(state) {
  return state.facts.filter((f) => f.status === 'stated' || f.status === 'observed' || (f.source === 'tool' && f.status !== 'contradicted'));
}

function contradictions(state) {
  return state.facts.filter((f) => f.status === 'contradicted' && f.contradictedBy).map((f) => ({ field: f.field, earlier: f.id, later: f.contradictedBy }));
}

function setIdentity(state, kind, proposal, ctx) {
  if (!proposal || !proposal.value) return;
  const quote = proposal.quote ? String(proposal.quote).slice(0, 120) : null;
  const isGrounded = quote && grounded(quote, ctx.customerTexts);
  const value = String(proposal.value).slice(0, 60);
  if (kind === 'appliance') {
    const status = isGrounded && proposal.basis !== 'inferred' ? 'stated' : 'inferred';
    if (state.appliance && state.appliance.status === 'stated' && status !== 'stated') return;
    state.appliance = { value, status, quote: isGrounded ? quote : null, turn: ctx.turn, confidence: proposal.confidence ?? null };
  } else if (kind === 'brand') {
    if (!isGrounded) return; // a brand is only ever what the customer wrote
    state.brand = { value, status: 'stated', quote, turn: ctx.turn };
  } else if (kind === 'model') {
    if (!isGrounded) return;
    state.model = { value: value.toUpperCase(), status: 'stated', quote, turn: ctx.turn };
  }
}

function addCode(state, code, quote, ctx) {
  const c = String(code || '').trim().toUpperCase().slice(0, 16);
  if (!c || !quote || !grounded(quote, ctx.customerTexts)) return false;
  if (state.codes.some((x) => x.code === c)) return false;
  state.codes.push({ code: c, quote: String(quote).slice(0, 80), turn: ctx.turn });
  return true;
}

/** Track the question asked this turn. */
function noteAsked(state, key, text, turn) {
  if (!key) return;
  const k = String(key).toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 60);
  const prev = state.asked.find((a) => a.key === k);
  if (prev) { prev.times += 1; prev.turn = turn; prev.text = String(text || '').slice(0, 200); prev.resolution = 'open'; } else state.asked.push({ key: k, text: String(text || '').slice(0, 200), turn, times: 1, resolution: 'open' });
  if (state.asked.length > MAX_ASKED) state.asked.splice(0, state.asked.length - MAX_ASKED);
}

/** The customer's answer to the last open question. */
function resolveAsked(state, resolution) {
  const open = [...state.asked].reverse().find((a) => a.resolution === 'open');
  if (open && ['answered', 'unknown', 'declined'].includes(resolution)) open.resolution = resolution;
}

/** Question keys the reasoner must not ask again: the customer could not or would not answer them. */
function closedQuestions(state) {
  return state.asked.filter((a) => a.resolution === 'unknown' || a.resolution === 'declined' || a.times >= 2).map((a) => a.key);
}

/** A compact view of the ledger for the reasoner prompt. */
function promptView(state) {
  return {
    appliance: state.appliance,
    brand: state.brand,
    model: state.model,
    codes: state.codes,
    facts: state.facts.map((f) => ({ id: f.id, field: f.field, value: f.value, source: f.source, status: f.status, turn: f.turn, ...(f.quote ? { quote: f.quote } : {}) })),
    contradictions: contradictions(state),
    questionsAlreadyAsked: state.asked.map((a) => ({ key: a.key, times: a.times, resolution: a.resolution })),
    doNotAskAgain: closedQuestions(state),
    hazard: state.hazard,
  };
}

module.exports = {
  SCHEMA, empty, clone, norm, grounded, recordFact, supportingFacts, contradictions, setIdentity, addCode,
  noteAsked, resolveAsked, closedQuestions, promptView,
};
