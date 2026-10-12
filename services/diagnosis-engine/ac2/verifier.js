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

const EXTRACT_SYSTEM = `You check a draft reply from an appliance-repair assistant. List every sentence-level claim the draft makes that asserts a FACT ABOUT THIS PARTICULAR CUSTOMER: what they said, saw, heard, did, tried or checked, or the current state of their appliance (e.g. "your pump is humming", "you've cleaned the filter", "the door seal is torn", "it's draining normally").
Do NOT list: general knowledge ("pumps can block"), advice or instructions, questions, conditional or hedged statements ("if the filter is clear…", "it may be…", "it sounds like…" when clearly an opinion), or statements about what the assistant will do.
For each claim, give the ids of the evidence facts that support it (only if a listed fact states the same thing), or [] if none does.
Return ONLY JSON: {"claims":[{"sentence": number, "claim": string, "supportedBy": [ids]}]}`;

const ATTRIBUTION = /\b(you(?:'ve| have)?|you'd|you've) (?:already )?(said|mentioned|told me|confirmed|checked|tried|noticed|found|cleaned|cleared|replaced|reset|described|tested|seen|heard|removed|emptied|unblocked|descaled)\b|\bas you (?:said|mentioned|described|noted)\b|\bsince you(?:'ve| have)? (?:said|mentioned|checked|cleaned|tried|confirmed)\b|\byou (?:can|could) (?:see|hear|smell)\b(?![^.?!]*\?)|\b(?:i've|i have) noted\b|\bthanks for (?:checking|confirming|cleaning|clearing|trying|testing|looking)\b|\bgood (?:that|to hear) (?:you|it|the)\b/i;

const STOP = new Set('the a an and or but if is are was were be been it its it\'s this that there your you you\'ve i we to of in on at for with from so as not no do does did has have had can could would should will just still also now then when which what about into out up very really'.split(' '));
function content(s) {
  return new Set(L.norm(s).split(' ').map(stem).filter((w) => w.length > 2 && !STOP.has(w)));
}
function stem(w) {
  return w.replace(/'s$/, '').replace(/(ing|ed|es|s)$/, '');
}
function overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

/** Split into sentences, keeping the separators so the reply can be rebuilt. */
function sentences(text) {
  return String(text || '').match(/[^.!?\n]+(?:[.!?]+|$)\s*|\n+/g) || [];
}

/**
 * Deterministic support check for one claim.
 * facts: supporting ledger facts; customerTexts: the customer's messages.
 */
function supported(claimText, citedIds, facts, customerTexts) {
  const c = content(claimText);
  if (!c.size) return { ok: true, basis: 'empty' };
  const byId = new Map(facts.map((f) => [f.id, f]));
  for (const id of citedIds || []) {
    const f = byId.get(id);
    if (!f) continue;
    const fc = content(`${f.field.replace(/_/g, ' ')} ${f.value} ${f.quote || ''}`);
    if (overlap(c, fc) >= 1) return { ok: true, basis: `fact:${f.id}` };
  }
  // Restating the customer's own words is supported: most of the claim's content words appear in one message.
  for (const t of customerTexts) {
    const tc = content(t);
    const n = overlap(c, tc);
    if (n >= 2 && n / c.size >= 0.6) return { ok: true, basis: 'customer-words' };
  }
  // Any supporting fact that strongly matches the claim (the extractor may have failed to cite it).
  for (const f of facts) {
    const fc = content(`${f.field.replace(/_/g, ' ')} ${f.value} ${f.quote || ''}`);
    const n = overlap(c, fc);
    if (n >= 2 && n / c.size >= 0.5) return { ok: true, basis: `fact:${f.id}` };
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
      customerLatestMessage: customerTexts[customerTexts.length - 1] || '',
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
          claims.push({ sentence: n, claim: String(c.claim).slice(0, 200), cited: Array.isArray(c.supportedBy) ? c.supportedBy.map(String) : [], source: 'extractor' });
        }
      }
    } catch (e) {
      ext.ms = Date.now() - t0;
      ext.error = String((e && e.category) || (e && e.message) || e).slice(0, 80);
      // An extractor failure is a provider failure for this turn: the caller treats it like any other.
      throw e;
    }
  }
  // Deterministic backstop: every sentence attributing something to the customer is a claim.
  sents.forEach((s, i) => {
    if (ATTRIBUTION.test(s) && !claims.some((c) => c.sentence === i + 1)) claims.push({ sentence: i + 1, claim: s.trim(), cited: [], source: 'detector' });
  });
  const rejected = [];
  for (const c of claims) {
    // Hedged sentences are opinions, not claims of fact.
    // (judged on the claim itself: a hedge elsewhere in the sentence does not excuse an asserted fact).
    if (c.source === 'extractor' && /^(?:if|it may|it might|it could|possibly|perhaps|it sounds like|this suggests|probably|it seems)\b/i.test(c.claim.trim()) && !ATTRIBUTION.test(c.claim)) continue;
    const r = supported(c.claim, c.cited, facts, customerTexts);
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

module.exports = { verify, neutralise, sentences, supported, EXTRACT_SYSTEM, ATTRIBUTION };
