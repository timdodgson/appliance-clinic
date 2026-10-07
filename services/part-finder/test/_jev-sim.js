'use strict';
/**
 * TEST-ONLY Jev simulation.
 *
 * Production `identity.js` / `resolveConversationIdentity` no longer parse customer prose for
 * appliance family or fuel — those are Jev's TYPED decisions (applianceType, applianceFamilyProvenance,
 * fuel), forwarded from the single UNDERSTAND pass. Unit tests still describe scenarios in prose, so
 * this helper derives the typed Jev signals the deployed Jev would return (the same pattern as
 * FakeDiagnosticService in the orchestration tests) and lets tests pass them in. It is NEVER used by
 * production code.
 */

const _NAMED_FAM = [
  ['washer-dryer', /\bwasher[\s-]?dryers?\b|\bwashing[\s-]?and[\s-]?dry/i],
  ['tumble-dryer', /\btumble[\s-]?dryers?\b|\bcondenser dryers?\b|\bheat[\s-]?pump dryers?\b|\bdryers?\b/i],
  ['washing-machine', /\bwashing machines?\b|\bwashers?\b/i],
  ['dishwasher', /\bdish\s?washers?\b/i],
  ['microwave', /\bmicrowaves?\b/i],
  ['hobs', /\bhobs?\b|\bcooktops?\b|\binduction hob\b/i],
  ['oven-cooker', /\bovens?\b|\bcookers?\b|\brange cookers?\b/i],
  ['fridge-freezer', /\bfridge[\s-]?freezers?\b|\bfridges?\b|\bfreezers?\b|\brefrigerators?\b/i],
  ['vacuum', /\bvacuum(?:\s+cleaners?)?s?\b|\bdysons?\b|\bhenry\b/i],
];
const _INFERRED_FAM = [
  ['microwave', /\b(?:cover off|take the cover|stirrer|turntables?)\b/i],
  ['washing-machine', /\bfront[\s-]?loaders?\b|\b(?:soap|detergent|fabric[\s-]?conditioner)[\s-]?(?:drawer|dispenser)\b/i],
  ['dishwasher', /\b(?:3|all)[\s-]?in[\s-]?1 tablets?\b|\b(?:rinse aid|dishwasher salt|dishwasher tablets?|crockery|cutlery basket)\b/i],
  ['hobs', /\binduction\b|\b(?:cooking )?zones?\b/i],
];
const _SHORT = /^(?:yes|yep|yeah|no|nope|ok|okay|correct|right|i don'?t know|don'?t know|not sure|no idea|already tried that|already done that)\s*[.!]?$/i;

function _turns(messages, queryText) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.role !== 'user') continue;
    const c = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join(' ') : '';
    out.push(String(c).replace(/\b(?:advisor asked|assistant)\s*:\s*[^\n]*/gi, ''));
  }
  if (!out.length && queryText) out.push(String(queryText));
  return out;
}

function simulateJev(messages, queryText) {
  const turns = _turns(messages, queryText);
  const blob = turns.join('\n');
  let jevFamily = null;
  let jevFamilyProvenance = 'none';
  for (const t of turns) {
    if (_SHORT.test(String(t).trim())) continue;
    for (const [fam, re] of _NAMED_FAM) { if (re.test(t)) { jevFamily = fam; jevFamilyProvenance = 'customer_named'; break; } }
  }
  if (!jevFamily) {
    for (const [fam, re] of _INFERRED_FAM) { if (re.test(blob)) { jevFamily = fam; jevFamilyProvenance = 'inferred'; break; } }
  }
  let fuelValue = null;
  let fuelConflict = false;
  const hasGas = /\b(?:lpg|natural gas)\b|\bgas\b(?:\s+\w+){0,2}\s+(?:oven|cooker|hob|grill|dryer|tumble)|\bit'?s gas\b|\bgas appliance\b/i.test(blob);
  const hasElectric = /\belectric\b(?:\s+\w+){0,2}\s+(?:oven|cooker|hob|dryer|tumble|grill|double)|\bit'?s electric\b|\binduction\b/i.test(blob);
  if (hasGas && hasElectric && !/\b(?:actually|sorry)\b/i.test(blob)) fuelConflict = true;
  else if (hasGas) fuelValue = 'gas';
  else if (hasElectric) fuelValue = 'electric';
  return {
    jevFamily,
    jevFamilyProvenance,
    jevFuel: { value: fuelValue, conflict: fuelConflict, stated: Boolean(fuelValue) },
  };
}

/** Wrap a resolver (resolveConversationIdentity / resolveEstablishedFamily) so prose-only test calls
 *  get the simulated typed Jev inputs; explicit jevFamily/jevFuel in opts are left untouched. */
function withJevSim(fn) {
  return (opts = {}) => {
    if (opts && (opts.messages || opts.queryText) && opts.jevFamily === undefined && opts.jevFuel === undefined) {
      return fn({ ...opts, ...simulateJev(opts.messages, opts.queryText) });
    }
    return fn(opts);
  };
}

module.exports = { simulateJev, withJevSim };
