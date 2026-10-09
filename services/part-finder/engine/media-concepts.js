/**
 * Media concepts: presentation-only concept tokens derived from the established diagnosis, for the media matcher.
 */
// -------- MEDIA CONCEPTS (additive, deterministic, PRESENTATION-ONLY) --------
// Derive presentation "concept" tokens from the ALREADY-established diagnostic result — the grounded
// faultId plus the structured diagnostic facts the customer's own evidence produced. This is NOT a
// second diagnosis: no LLM call, no retrieval, no reply parsing, no media/title inspection. It NEVER
// changes faultId/confidence/components/safety/parts (the facts it reads are inert to routing — none
// are wired into any node `signals[]` or the proven-good backstop). Its ONLY consumer is the
// deterministic media matcher, so a single broad faultId can present the right image when it spans
// genuinely different engineering situations. Reusable: keyed off (appliance, faultId, facts); extend
// per family as needed. Flow stays: customer -> UNDERSTAND/RAG -> diagnosis -> THESE concepts ->
// media matcher. Never media -> diagnosis.
function deriveMediaConcepts(appKey, fault, facts) {
  if (!appKey || !fault || !fault.faultId) return [];
  const byName = new Map((Array.isArray(facts) ? facts : []).map((f) => [String(f.name || '').toLowerCase(), f.value]));
  const isTrue = (name) => byName.get(String(name).toLowerCase()) === 'TRUE';
  const id = fault.faultId;
  const concepts = [];

  // Washing-machine / washer-dryer: distinguish an APPLIANCE drainage problem ("full of water,
  // won't empty" / blocked filter/pump) from HOUSEHOLD WASTE-PLUMBING backflow ("it pumps out but
  // dirty water returns / drains smell"). The engine already reaches this conclusion in its
  // not-draining and odour knowledge; the discriminating customer evidence is captured structurally
  // as the `wasteBackflow` diagnostic fact.
  if (appKey === 'washing-machine' || appKey === 'washer-dryer') {
    if ((id === 'not-draining' || id === 'odour') && isTrue('wasteBackflow')) {
      concepts.push('waste-backflow');
    } else if (id === 'not-draining') {
      concepts.push('drainage-appliance');
    } else if (id === 'odour') {
      // A smell that is NOT drain/sewer plumbing is an appliance-hygiene (biofilm/mould) issue —
      // its own concept so the hygiene media never shows for a household-plumbing drain smell.
      concepts.push('appliance-hygiene');
    }
  }
  return concepts;
}

module.exports = { deriveMediaConcepts };
