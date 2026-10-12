'use strict';
/**
 * Claim verification. Invariant: customer-specific factual claims ⊆ recorded evidence.
 *
 * Before a reply is returned:
 *   1. its customer-specific factual claims are extracted (a model extracts them; a deterministic detector also flags
 *      every sentence that attributes something to the customer, so extraction failures cannot hide those);
 *   2. each claim is checked DETERMINISTICALLY against the ledger: it must cite facts that exist, are customer- or
 *      tool-sourced and not contradicted, and that share content with the claim — or restate the customer's own words;
 *   3. unsupported claims are rejected; the caller regenerates once with the rejections as feedback, then removes any
 *      sentence that still carries an unsupported claim.
 * The extractor decides nothing: a claim it marks as supported is still checked here.
 */
const L = require('./ledger.js');

const EXTRACT_SYSTEM = `You check a draft reply from an appliance-repair assistant against what the customer actually said. List every claim in the draft that states, as a fact, something about THIS customer: what they said, saw, heard, smelled, did, tried, checked or measured, or the current state of their appliance (e.g. "your pump is humming", "you've cleaned the filter", "the door seal is torn", "it's draining normally", "the impeller spins freely").
Do NOT list: general knowledge ("pumps can block", "E24 on Bosch dishwashers means a drain fault"), the assistant's own reasoning, conclusions or diagnoses ("so the pump has failed", "this confirms the motor is fine", "the most likely cause is…"), advice or instructions, questions, conditional or hedged statements ("if the filter is clear…", "it may be…"), or what the assistant will do.
For each claim listed, give its kind: "customer_report" (says the customer said/did/saw/checked/tried something), "appliance_state" (states the current condition of their appliance as observed fact), or "conclusion" (the assistant's own inference or diagnosis, even if stated firmly). Then show where the customer said it: copy the customer's own words exactly into "customerQuote" (from customerMessages), and/or give the ids of evidence facts that state the same thing. If the customer never said it, use null and [].
Return ONLY JSON: {"claims":[{"sentence": number, "claim": string, "kind": string, "customerQuote": string or null, "supportedBy": [ids]}]}`;

const EXTRACT_FORMAT = { type: 'json_schema', json_schema: { name: 'ac2_claims', strict: true, schema: { type: 'object', properties: { claims: { type: 'array', items: { type: 'object', properties: { sentence: { type: 'integer' }, claim: { type: 'string' }, kind: { type: 'string', enum: ['customer_report', 'appliance_state', 'conclusion'] }, customerQuote: { type: ['string', 'null'] }, supportedBy: { type: 'array', items: { type: 'string' } } }, required: ['sentence', 'claim', 'kind', 'customerQuote', 'supportedBy'] } } }, required: ['claims'] } } };

const ATTRIBUTION = /\b(?:you've|you have|you had|you'd) (?:already |now |just |since |also )?(?!to\b|got to\b)(?:[a-z]+(?:ed|en|wn|ght|ung|ept|elt|ound|one|ade|aid|ld|nt)|reset|put|cut|set|shut|run|let|read|got|swapped|fit)\b|\byou (?:already |just |also )?(?:said|mentioned|told me|confirmed|checked|tried|noticed|found|cleaned|cleared|replaced|reset|described|tested|saw|heard|removed|emptied|unblocked|descaled|straightened|unplugged|did)\b|\bas you (?:said|mentioned|described|noted)\b|\bsince you(?:'ve| have)? (?:said|mentioned|checked|cleaned|tried|confirmed)\b|\byou (?:can|could) (?:see|hear|smell)\b(?![^.?!]*\?)|\b(?:i've|i have) noted\b|\bthanks for (?:checking|confirming|cleaning|clearing|trying|testing|looking)\b|\bgood (?:that|to hear) (?:you|it|the)\b/i;

// A sentence asserting the current state of the customer's appliance ("your fan is running", "the filter is clear").
// It is a customer-specific claim unless it is general, conditional, hedged or a question.
const STATE = /\b(?:your|the|its)\s+(?:[a-z-]+\s+){0,3}(?:is|are|was|were|has been|have been|isn't|aren't|wasn't|weren't|hasn't|haven't|seems|looks)\s+(?:now\s+|still\s+|definitely\s+|clearly\s+|completely\s+|fully\s+|not\s+)*(?:clear|clean|cleaned|blocked|unblocked|working|running|fine|ok|okay|broken|faulty|failed|damaged|torn|split|turning|spinning|draining|heating|hot|warm|cold|empty|full|tripping|leaking|dry|wet|level|seated|connected|disconnected|kinked|free|stuck|jammed|intact|cracked|burnt|burned|on|off)\b|\b(?:your|the|its)\s+(?:[a-z-]+\s+){0,3}(?:has|have)\s+(?:now\s+|already\s+|definitely\s+)?(?:failed|broken|burnt|burned|blown|gone|stopped|seized|cracked|split|worn|perished|tripped|leaked)\b|\b(?:your|the)\s+(?:[a-z-]+\s+){0,2}(?:works|turns|spins|drains|heats|runs|lights|fills|cools|hums|clicks|beeps|leaks|trips)\b(?!\s*\?)/i;
const GENERAL = /\b(if|when|whether|unless|usually|typically|generally|often|sometimes|most|many|some|can|could|may|might|should|would|check|make sure|ensure|see if|look for|tends?|common|likely|probably|possibly|perhaps|sounds like|suggests|means)\b/i;
// "If you've cleaned the filter…", "Once you have checked…": conditional, not an attribution.
const CONDITIONAL_ATTRIBUTION = /\b(if|once|when|after|before|until|unless|whether)\s+(?:\w+\s+){0,2}you(?:'ve| have| had)?\b/i;
function attributes(sentence) {
  return ATTRIBUTION.test(sentence) && !CONDITIONAL_ATTRIBUTION.test(sentence);
}
function stateClaim(sentence) {
  const t = String(sentence || '').trim();
  return !t.endsWith('?') && STATE.test(t) && !GENERAL.test(t);
}

const STOP = new Set('the a an and or but if is are was were be been it its it\'s this that there your you you\'ve i we to of in on at for with from so as not no do does did has have had can could would should will just still also now then when which what about into out up very really'.split(' '));
function content(s) {
  return new Set(L.norm(s).split(/[ /]+/).map((w) => stem(w.replace(/^[.'-]+|[.'-]+$/g, ''))).filter((w) => (w.length > 2 || /\d/.test(w)) && !STOP.has(w)));
}
function stem(w) {
  return w.replace(/'s$/, '').replace(/(ing|ed|es|s)$/, '');
}
const NEGATION = /\b(no|not|none|never|nothing|nobody|without|n't|cannot|can't|won't|doesn't|isn't|hasn't|haven't|didn't|wasn't|aren't)\b|n't\b/i;
/** A fact supports a claim only with the same polarity ("not checked anything" never supports "you checked …"). */
function samePolarity(claim, f) {
  const factText = `${f.value} ${f.quote || ''}`;
  const factNeg = NEGATION.test(factText) || /^(no|false|none|0)$/i.test(String(f.value).trim());
  return NEGATION.test(claim) === factNeg;
}
function overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

/** Split into sentences, keeping the separators so the reply can be rebuilt. Abbreviations and decimals do not end a
 * sentence ("e.g. a coin", "approx. 2.5 kg"). */
const ABBREV = /\b(e\.g|i\.e|etc|approx|vs|no|mr|mrs|ms|dr|st|min|max|incl)\.$/i;
function sentences(text) {
  const raw = String(text || '').match(/[^.!?\n]+(?:[.!?]+|$)\s*|\n+/g) || [];
  const out = [];
  for (const piece of raw) {
    const prev = out[out.length - 1];
    // Re-join when the previous piece ended in an abbreviation or a digit-dot followed by a digit.
    if (prev && (ABBREV.test(prev.trim()) || (/\d\.$/.test(prev.trim()) && /^\d/.test(piece)) || /^[a-z]/.test(piece.trim()) && /\b[a-z]\.$/i.test(prev.trim()))) out[out.length - 1] = prev + piece;
    else out.push(piece);
  }
  return out;
}

/**
 * Anchor check for a claim the extractor found and matched semantically: the anchor must be real (a recorded customer or
 * tool fact that is not contradicted, or a quote that is in the customer's words), share content with the claim and
 * have the same polarity. The extractor's paraphrase matching is trusted only this far; sentences that attribute
 * something to the customer are also checked by the strict rule below.
 */
function anchored(claimText, citedIds, facts, customerTexts, customerQuote = null) {
  const c = content(claimText);
  if (!c.size) return { ok: true, basis: 'empty' };
  if (customerQuote && L.grounded(customerQuote, customerTexts) && overlap(c, content(customerQuote)) >= 1
    && NEGATION.test(claimText) === NEGATION.test(customerQuote)) return { ok: true, basis: 'customer-quote' };
  const byId = new Map(facts.map((f) => [f.id, f]));
  for (const id of citedIds || []) {
    const f = byId.get(id);
    if (f && overlap(c, content(`${f.field.replace(/_/g, ' ')} ${f.value} ${f.quote || ''}`)) >= 1 && samePolarity(claimText, f)) return { ok: true, basis: `fact:${f.id}` };
  }
  return supported(claimText, [], facts, customerTexts, null);
}

/**
 * Deterministic support check for one claim.
 * facts: supporting ledger facts; customerTexts: the customer's messages.
 */
function supported(claimText, citedIds, facts, customerTexts, customerQuote = null) {
  const c = content(claimText);
  if (!c.size) return { ok: true, basis: 'empty' };
  // The customer's own words, located by the extractor and checked here: the quote must really be in the customer's
  // messages, carry the same polarity, and share a real part of the claim's content.
  if (customerQuote && L.grounded(customerQuote, customerTexts)) {
    const qc = content(customerQuote);
    const n = overlap(c, qc);
    if (n >= 1 && n / c.size > 0.5 && NEGATION.test(claimText) === NEGATION.test(customerQuote)) return { ok: true, basis: 'customer-quote' };
  }
  const byId = new Map(facts.map((f) => [f.id, f]));
  for (const id of citedIds || []) {
    const f = byId.get(id);
    if (!f) continue;
    const fc = content(`${f.field.replace(/_/g, ' ')} ${f.value} ${f.quote || ''}`);
    const n = overlap(c, fc);
    // The cited fact must cover most of what the claim asserts, with the same polarity.
    if (n >= 1 && n / c.size > 0.5 && samePolarity(claimText, f)) return { ok: true, basis: `fact:${f.id}` };
  }
  // Restating the customer's own words is supported: most of the claim's content words appear in one message.
  for (const t of customerTexts) {
    const tc = content(t);
    const n = overlap(c, tc);
    if (n >= 2 && n / c.size >= 0.5 && NEGATION.test(claimText) === NEGATION.test(t)) return { ok: true, basis: 'customer-words' };
  }
  // Any supporting fact that strongly matches the claim (the extractor may have failed to cite it).
  for (const f of facts) {
    const fc = content(`${f.field.replace(/_/g, ' ')} ${f.value} ${f.quote || ''}`);
    const n = overlap(c, fc);
    if (n >= 2 && n / c.size > 0.5 && samePolarity(claimText, f)) return { ok: true, basis: `fact:${f.id}` };
  }
  return { ok: false };
}

/**
 * Verify a reply. extract: async (system, user) -> parsed JSON (the claim extractor), or null to skip the model step.
 * Returns { ok, rejected: [{sentence, claim, reason}], claims, extractor: {ok, ms, usage} }.
 */
async function verify(reply, state, customerTexts, { extract = null } = {}) {
  const sents = sentences(reply);
  const facts = L.supportingFacts(state);
  const claims = [];
  const ext = { ok: false, ms: 0, usage: null };
  if (extract) {
    const numbered = sents.map((s, i) => ({ n: i + 1, text: s.trim() })).filter((s) => s.text);
    const user = JSON.stringify({
      draft: numbered,
      evidenceFacts: facts.map((f) => ({ id: f.id, field: f.field, value: f.value, ...(f.quote ? { quote: f.quote } : {}) })),
      customerMessages: customerTexts,
    });
    const t0 = Date.now();
    try {
      const out = await extract(EXTRACT_SYSTEM, user);
      ext.ms = Date.now() - t0;
      if (out && Array.isArray(out.json && out.json.claims)) {
        ext.ok = true;
        ext.usage = out.usage || null;
        for (const c of out.json.claims) {
          const n = Number(c.sentence);
          if (!Number.isInteger(n) || n < 1 || n > sents.length || !c.claim) continue;
          // The assistant's own conclusions are opinions about the cause, not claims about what the customer reported;
          // the reply wording rules (hedging) and the safety gate govern those. Sentences the deterministic detectors
          // flag are still verified below whatever kind the extractor gave them.
          if (c.kind === 'conclusion') continue;
          claims.push({ sentence: n, claim: String(c.claim).slice(0, 200), cited: Array.isArray(c.supportedBy) ? c.supportedBy.map(String) : [], quote: typeof c.customerQuote === 'string' ? c.customerQuote.slice(0, 300) : null, source: 'extractor' });
        }
      }
    } catch (e) {
      ext.ms = Date.now() - t0;
      ext.error = String((e && e.category) || (e && e.message) || e).slice(0, 80);
      // An extractor failure is a provider failure for this turn: the caller treats it like any other.
      throw e;
    }
  }
  // Deterministic backstop: every sentence attributing something to the customer, or asserting the state of their
  // appliance, is a claim checked by the strict rule, whatever the extractor said about it. The extractor's quote for
  // that sentence (if any) may still support it, but only with majority coverage.
  sents.forEach((s, i) => {
    if (attributes(s) || stateClaim(s)) {
      const ex = claims.find((c) => c.sentence === i + 1 && c.quote);
      claims.push({ sentence: i + 1, claim: s.trim(), cited: [], quote: ex ? ex.quote : null, source: 'detector' });
    }
  });
  const rejected = [];
  for (const c of claims) {
    // Hedged sentences are opinions, not claims of fact.
    // (judged on the claim itself: a hedge elsewhere in the sentence does not excuse an asserted fact).
    if (c.source === 'extractor' && /^(?:if|it may|it might|it could|possibly|perhaps|it sounds like|this suggests|probably|it seems)\b/i.test(c.claim.trim()) && !ATTRIBUTION.test(c.claim)) continue;
    const r = c.source === 'detector' ? supported(c.claim, c.cited, facts, customerTexts, c.quote || null) : anchored(c.claim, c.cited, facts, customerTexts, c.quote || null);
    if (!r.ok) rejected.push({ sentence: c.sentence, claim: c.claim, reason: 'no supporting evidence', source: c.source });
    else c.basis = r.basis;
  }
  return { ok: rejected.length === 0, rejected, claims, extractor: ext, sentences: sents };
}

/** Remove the sentences that carry rejected claims. Questions in a removed sentence are lost too, by design. */
function neutralise(verdict) {
  const drop = new Set(verdict.rejected.map((r) => r.sentence));
  return verdict.sentences.filter((_, i) => !drop.has(i + 1)).join('').replace(/\s{2,}/g, ' ').trim();
}

module.exports = { verify, neutralise, sentences, supported, stateClaim, content, EXTRACT_SYSTEM, EXTRACT_FORMAT, ATTRIBUTION };
