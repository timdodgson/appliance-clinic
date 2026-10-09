/**
 * The faults and error-code catalogue (faults-catalogue.json) and the deterministic lookups over it: appliance and
 * brand keys, fault resolution, component terms and matching, part ranking, procedures and platform notes.
 */
// Faults + error-code catalogue (draft, engineer-validated over time).
// Loaded at cold start. If it's missing/unparseable we degrade to no catalogue
// grounding rather than failing the request.
let CATALOGUE = { faults: {}, errorCodes: {} };

try {
  // eslint-disable-next-line global-require
  CATALOGUE = require('../faults-catalogue.json');
} catch (e) {
  console.error('[part-finder] faults catalogue not loaded:', e.message);
}

// Derived once at cold start: the set of valid fault ids (INTENT_SCHEMA).
const FAULT_IDS = collectFaultIds();

// Component alias boundary: repair-term → the terms the parts catalogue/retailer
// actually uses (e.g. "circulation pump" → "wash pump"). Lets the diagnostic
// taxonomy speak repair language while retrieval + matching speak product
// language. Keys/values normalised to lowercase.
const COMPONENT_ALIASES = (() => {
  const src = CATALOGUE.componentAliases || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!Array.isArray(v)) continue;
    out[k.toLowerCase()] = v.map((s) => String(s).toLowerCase());
  }
  return out;
})();

/** A component plus any catalogue aliases for it (all lowercase, deduped). */
function componentTerms(component) {
  const c = (component || '').toLowerCase().trim();
  if (!c) return [];
  return [...new Set([c, ...(COMPONENT_ALIASES[c] || [])])];
}

function collectFaultIds() {
  const set = new Set();
  for (const faults of Object.values(CATALOGUE.faults || {})) {
    for (const id of Object.keys(faults)) set.add(id);
  }
  return [...set];
}

// NOTE: the SSE streaming transport that used to live here (httpStream) now
// lives in inference.js behind the COMPOSE provider. composeStream() calls
// provider.infer(req, { onDelta }) instead of streaming LM Studio directly.

// ---------------------------------------------------------------------------
// FAULTS / ERROR-CODE CATALOGUE
// ---------------------------------------------------------------------------

/** Normalise a freeform appliance type to a catalogue key. */
function applianceKey(applianceType) {
  if (!applianceType) return null;
  const t = applianceType.toLowerCase().trim();
  const map = {
    'washing machine': 'washing-machine',
    washer: 'washing-machine',
    'washer dryer': 'washer-dryer',
    'washer-dryer': 'washer-dryer',
    'tumble dryer': 'tumble-dryer',
    dryer: 'tumble-dryer',
    dishwasher: 'dishwasher',
    oven: 'oven-cooker',
    cooker: 'oven-cooker',
    'oven cooker': 'oven-cooker',
    hob: 'hobs',
    hobs: 'hobs',
    'induction hob': 'hobs',
    'ceramic hob': 'hobs',
    'gas hob': 'hobs',
    cooktop: 'hobs',
    microwave: 'microwave',
    'microwave oven': 'microwave',
    'combination microwave': 'microwave',
    // Fridge/freezer synonyms — the fridge-freezer family was added to the catalogue later than the
    // original map, so customer/LLM phrasings ("American fridge freezer", "fridge", "freezer",
    // "refrigerator", "fridge/freezer") previously failed to normalise -> resolveFault bailed and a
    // valid brand error code (e.g. Samsung 22E) never resolved. Normalise them all to the canonical key.
    fridge: 'fridge-freezer',
    freezer: 'fridge-freezer',
    'fridge freezer': 'fridge-freezer',
    'fridge-freezer': 'fridge-freezer',
    'fridge/freezer': 'fridge-freezer',
    refrigerator: 'fridge-freezer',
    fridgefreezer: 'fridge-freezer',
    'american fridge freezer': 'fridge-freezer',
    'american fridge-freezer': 'fridge-freezer',
    'american style fridge freezer': 'fridge-freezer',
    vacuum: 'vacuum',
    'vacuum cleaner': 'vacuum',
    hoover: 'vacuum',
    'upright vacuum': 'vacuum',
    'cylinder vacuum': 'vacuum',
    'cordless vacuum': 'vacuum',
  };
  if (map[t]) return map[t];
  const dashed = t.replace(/\s+/g, '-');
  return CATALOGUE.faults?.[dashed] ? dashed : null;
}

/** Resolve a brand name to its catalogue brand-family key via appliesTo. */
function brandFamily(make) {
  if (!make) return null;
  const m = make.toLowerCase().trim();
  for (const [family, def] of Object.entries(CATALOGUE.errorCodes || {})) {
    if (family === m) return family;
    if (Array.isArray(def.appliesTo) && def.appliesTo.some((b) => m.includes(b) || b.includes(m))) {
      return family;
    }
  }
  return null;
}

/**
 * Resolve the intent to a fault node from the catalogue.
 * Priority: an error code (most precise) beats symptom text.
 * Returns { faultId, node, via } or null.
 */
/**
 * When the customer has not named an appliance family, a make+code pair may still
 * uniquely identify one catalogue mapping. Only then is the code authoritative
 * without a family. A code that exists on more than one family for that brand, or
 * an explicit (even unrecognised) applianceType, is left unresolved here.
 */
function errorCodeFragmentTokens(errorCode) {
  const raw = String(errorCode || '').toUpperCase();
  if (!/[/\-]|\bOR\b/.test(raw)) return [];
  return raw
    .split(/[^A-Z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => /^[EFHC]?\d{1,3}[A-Z]?$/.test(t) || /^[EFHC]\d{1,3}$/.test(t));
}

function lookupErrorCodeFaultId(table, errorCode) {
  if (!table || !errorCode) return null;
  const norm = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const want = norm(errorCode);
  const exact = Object.keys(table).find((k) => k && !String(k).startsWith('_') && norm(k) === want);
  if (exact) return { faultId: table[exact], ambiguous: false };
  const fragments = errorCodeFragmentTokens(errorCode);
  if (fragments.length < 2) return null;
  const ids = [];
  for (const frag of fragments) {
    const key = Object.keys(table).find((k) => k && !String(k).startsWith('_') && norm(k) === norm(frag));
    if (key && table[key]) ids.push(table[key]);
  }
  const unique = [...new Set(ids)];
  // A compound is only the same mapping when every fragment agrees. One known
  // fragment (or disagreeing fragments) is not the displayed code.
  if (unique.length === 1 && ids.length === fragments.length) {
    return { faultId: unique[0], ambiguous: false };
  }
  if (unique.length >= 1) return { faultId: null, ambiguous: true, fragmentFaultIds: unique };
  return null;
}

function compoundFragmentIdsForAppliance(appKey, errorCode) {
  const ids = new Set();
  const brandCodes = (CATALOGUE.errorCodes && typeof CATALOGUE.errorCodes === 'object')
    ? CATALOGUE.errorCodes : {};
  for (const def of Object.values(brandCodes)) {
    if (!def || typeof def !== 'object') continue;
    const table = def[appKey];
    if (!table || typeof table !== 'object') continue;
    const hit = lookupErrorCodeFaultId(table, errorCode);
    if (hit && hit.ambiguous) {
      for (const id of hit.fragmentFaultIds || []) ids.add(id);
    }
  }
  return [...ids];
}

function uniqueBrandCodeHit(make, errorCode) {
  const fam = brandFamily(make);
  if (!fam || !errorCode) return null;
  const brandDef = CATALOGUE.errorCodes && CATALOGUE.errorCodes[fam];
  if (!brandDef || typeof brandDef !== 'object') return null;
  const norm = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const want = norm(errorCode);
  if (!want) return null;
  const hits = [];
  for (const [app, table] of Object.entries(brandDef)) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    if (!CATALOGUE.faults || !CATALOGUE.faults[app]) continue;
    const key = Object.keys(table).find((k) => k && !String(k).startsWith('_') && norm(k) === want);
    if (key && CATALOGUE.faults[app][table[key]]) {
      hits.push({
        faultId: table[key],
        node: CATALOGUE.faults[app][table[key]],
        resolvedAppliance: app,
      });
    }
  }
  if (hits.length !== 1) return null;
  return hits[0];
}

function resolveFault(intent) {
  const appKey = applianceKey(intent.applianceType);
  const norm = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  let blockedFragmentIds = [];

  // 1) Error code. Needs a brand family (F03 differs by brand). If the customer
  //    named no appliance, a UNIQUE make+code mapping is still authoritative.
  if (intent.errorCode) {
    const fam = brandFamily(intent.make);
    if (appKey && CATALOGUE.faults?.[appKey]) {
      const faultsForAppliance = CATALOGUE.faults[appKey];
      const table = fam && CATALOGUE.errorCodes?.[fam]?.[appKey];
      if (table) {
        const hit = lookupErrorCodeFaultId(table, intent.errorCode);
        if (hit && hit.faultId && faultsForAppliance[hit.faultId]) {
          return { faultId: hit.faultId, node: faultsForAppliance[hit.faultId], via: 'errorCode' };
        }
        if (hit && hit.ambiguous) blockedFragmentIds = hit.fragmentFaultIds || [];
      }
      if (!blockedFragmentIds.length) {
        blockedFragmentIds = compoundFragmentIdsForAppliance(appKey, intent.errorCode);
      }
    }
    if (!intent.applianceType || intent._applianceUnconfirmed) {
      const unique = uniqueBrandCodeHit(intent.make, intent.errorCode);
      if (unique) {
        return {
          faultId: unique.faultId,
          node: unique.node,
          via: 'errorCode',
          resolvedAppliance: unique.resolvedAppliance,
        };
      }
    }
  }

  if (!appKey || !CATALOGUE.faults?.[appKey]) return null;
  const faultsForAppliance = CATALOGUE.faults[appKey];
  const blocked = new Set(blockedFragmentIds);

  // 2) LLM-classified faultId (primary — robust to any phrasing, unlike
  //    string matching). Validate it exists for this appliance.
  if (intent.faultId && faultsForAppliance[intent.faultId] && !blocked.has(intent.faultId)) {
    return { faultId: intent.faultId, node: faultsForAppliance[intent.faultId], via: 'classified' };
  }

  // 2b) Field-slip recovery (deterministic; does NOT change the diagnosis).
  //    The model intermittently emits the correct faultId in the free-text
  //    `fault` field while leaving `faultId` null (observed on condenser
  //    tumble-dryer cases: fault="not-emptying-condensate", faultId=null,
  //    confidence ~0.9, correct doc at rank 1). If `intent.fault` is EXACTLY a
  //    valid faultId key for this appliance, treat it as classified. Requires an
  //    exact id match, so it can never invent or mis-route a fault.
  if (intent.fault && faultsForAppliance[intent.fault] && !blocked.has(intent.fault)) {
    return { faultId: intent.fault, node: faultsForAppliance[intent.fault], via: 'classified-fault-field' };
  }

  // 3) Last-resort safety net: light synonym match if the classifier gave nothing.
  //    Normalise away filler words (the/a/an) and punctuation/whitespace so the
  //    LLM's short summary matches a synonym regardless of small joining words —
  //    e.g. "trips electrics" ↔ "trips the electrics".
  if (intent.fault) {
    const normPhrase = (s) =>
      s
        .toLowerCase()
        .replace(/\b(the|a|an|and)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
    const f = normPhrase(intent.fault);
    let best = null;
    if (f) {
      for (const [faultId, node] of Object.entries(faultsForAppliance)) {
        if (blocked.has(faultId)) continue;
        const phrases = [node.label, ...(node.synonyms || [])]
          .filter(Boolean)
          .map(normPhrase)
          .filter(Boolean);
        for (const p of phrases) {
          if (f.includes(p) || p.includes(f)) {
            const score = Math.min(p.length, f.length);
            if (!best || score > best.score) best = { faultId, node, score };
          }
        }
      }
    }
    if (best) return { faultId: best.faultId, node: best.node, via: 'symptom' };
  }

  return null;
}

/**
 * AUTHORITATIVE error-code differential. When a fault was resolved from a manufacturer error-code
 * table (fault.via === 'errorCode'), the code is an authoritative signal for the diagnostic area, so
 * the catalogue node's curated components LEAD the differential — a manufacturer code mapping is a
 * stronger signal than the UNDERSTAND model's free-text guess about what the code means (the model
 * frequently mis-guesses brand codes). Any extra model-suggested components follow, deduped. For a
 * non-errorCode fault (symptom/classified) the model's evidence-ordered components are returned
 * unchanged, preserving the evidence-based reordering used for multi-symptom cases. Pure/testable.
 */
function authoritativeCodeComponents(fault, modelComponents) {
  const model = Array.isArray(modelComponents) ? modelComponents.filter(Boolean) : [];
  if (!fault || fault.via !== 'errorCode' || !fault.node || !Array.isArray(fault.node.components) || !fault.node.components.length) {
    return model.slice();
  }
  const normc = (s) => String(s).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const nodeComps = fault.node.components.filter(Boolean);
  const have = new Set(nodeComps.map(normc));
  const extras = model.filter((c) => !have.has(normc(c)));
  return [...nodeComps, ...extras];
}

/**
 * Re-rank catalogue parts so those matching the fault's ordered components
 * float to the top (component[0] = check-first / stock fault). Parts matching
 * no component keep their order after the matched ones. Non-destructive.
 */
function rankPartsByFault(parts, faultNode) {
  if (!faultNode || !Array.isArray(faultNode.components) || parts.length === 0) return parts;
  const comps = faultNode.components.map((c) => c.toLowerCase());
  const scored = parts.map((p, idx) => {
    const title = (p.title || '').toLowerCase();
    let rank = comps.length; // default: after all matched
    for (let i = 0; i < comps.length; i++) {
      if (matchesComponent(title, comps[i])) {
        rank = i;
        break;
      }
    }
    return { p, rank, idx };
  });
  scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx); // stable within same rank
  return scored.map((s) => s.p);
}

/**
 * The cards to display = the parts the assistant actually recommended, detected
 * by their partNo appearing in the reply (we link as [Title](/partNo)). Ordered
 * by first appearance so cards follow the reply. Only known parts are eligible,
 * so a hallucinated part number can never become a card.
 */
function selectLinkedParts(reply, parts) {
  if (!reply || !Array.isArray(parts) || parts.length === 0) return [];
  const text = reply;
  const hits = [];
  for (const p of parts) {
    if (!p.partNo) continue;
    const idx = text.indexOf(String(p.partNo));
    if (idx !== -1) hits.push({ p, idx });
  }
  hits.sort((a, b) => a.idx - b.idx);
  // De-dupe by partId while preserving order.
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (seen.has(h.p.partId)) continue;
    seen.add(h.p.partId);
    out.push(h.p);
  }
  return out;
}

function _isFilterPart(p) {
  const t = String((p && p.title) || '').toLowerCase();
  return /\bfilters?\b/.test(t) && !/charger/.test(t);
}

function componentAlreadyAddressed(component, intent) {
  if (!component || !intent) return false;
  const phrases = [
    ...(intent.checksReported || []),
    ...(intent.provenGood || []),
    ...(intent.alreadyReplaced || []),
  ].filter(Boolean);
  return phrases.some((p) => refersToSameComponent(p, component));
}

/**
 * Drop catalogue cards that only match a component the customer has already
 * checked, replaced, or ruled out. A later remaining component stays.
 */
function partsStillInPlay(shown, fault, intent) {
  if (!Array.isArray(shown) || shown.length === 0) return shown || [];
  const comps = (fault && fault.node && Array.isArray(fault.node.components))
    ? fault.node.components.filter(Boolean)
    : [];
  if (!comps.length || !intent) return shown;
  const kept = shown.filter((p) => {
    const hits = comps.filter((c) => matchesComponent(p.title, c));
    if (!hits.length) return true;
    return hits.some((c) => !componentAlreadyAddressed(c, intent));
  });
  return kept;
}

/**
 * When the remaining check-first component is a filter, the customer-facing card
 * must lead with a filter from the ranked catalogue — not a later-listed
 * battery/charger the compose LLM happened to link. Non-destructive: the
 * originally linked parts stay, just not first. Do not force that card after
 * the customer has already checked or ruled out that area.
 */
function preferCheckFirstPart(shown, ranked, fault, intent) {
  if (!fault || !fault.node || !Array.isArray(shown) || shown.length === 0) return shown || [];
  const first = String((fault.node.components || [])[0] || '').toLowerCase();
  if (!/filter/.test(first)) return shown;
  // Do not force a filter card after the customer has already dealt with that area.
  if (componentAlreadyAddressed(first, intent) || componentAlreadyAddressed('filter', intent)) {
    return shown;
  }
  if (_isFilterPart(shown[0])) return shown;
  const filter = (ranked || []).find(_isFilterPart);
  if (!filter) return shown;
  return [filter, ...shown.filter((p) => p.partId !== filter.partId)];
}

/**
 * A part title matches a component if it (or any of the component's catalogue
 * aliases) is contained in the title, or all the term's key tokens are.
 */
function matchesComponent(title, component) {
  const t = String(title || '').toLowerCase();
  const c = String(component || '').toLowerCase().trim();
  if (!t || !c) return false;
  // A "battery charger" is not a battery pack. Substring "battery" must not promote
  // a charger as the battery component (and vice versa).
  if (c === 'battery' && /charger/.test(t)) return false;
  if (c === 'charger' && !/charger|adaptor|adapter|power supply/.test(t)) return false;
  for (const term of componentTerms(component)) {
    if (title.includes(term) || t.includes(term)) return true;
    const tokens = term.split(/\s+/).filter((w) => w.length >= 3);
    if (tokens.length > 0 && tokens.every((tok) => t.includes(tok))) return true;
  }
  return false;
}

/** camelCase/snake fact name → readable phrase, e.g. "noiseOnDrain" → "noise on drain". */
function humanizeFact(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Explainable diagnostic evidence: cross-reference the facts the customer
 * established against the fault node's `signals` fingerprints. Returns
 * { supports:[], against:[] } of readable phrases, or null if nothing applies.
 * This is structured evidence — distinct from the LLM's numeric `confidence`.
 */
// ---- evidence-aware differential adjustment (Fix #3 pruning + #4 already-replaced) ----------
// General and phrasing-independent. Uses ONLY signals the engine already has: the LLM's provenGood[]
// / alreadyReplaced[], a small principled fact->keyword backstop for the STANDARD "it works" facts,
// and a universal replaced/changed phrasing backstop over the customer's raw words. Matching requires
// EVERY significant token of the evidence phrase to be present in the candidate, so ruling out
// "grill element" can never remove "fan oven element".
const STOP_TOK = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'it', 'is', 'on', 'off', 'my', 'your', 'still', 'fault', 'faulty', 'broken', 'works', 'working', 'fine', 'okay']);

function sigTokens(s) {
  return String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((t) => t.length >= 3 && !STOP_TOK.has(t));
}

/** True if evidence `phrase` refers to `component` (every significant phrase token appears in it). */
function phraseRefersToComponent(phrase, component) {
  const pTok = sigTokens(phrase);
  if (!pTok.length) return false;
  const comp = String(component || '').toLowerCase();
  return pTok.every((t) => comp.includes(t));
}

function refersToSameComponent(a, b) {
  return phraseRefersToComponent(a, b) || phraseRefersToComponent(b, a);
}

/** True if a part matches any of the fault node's components (same rule as ranking). */
function partMatchesFault(part, faultNode) {
  if (!faultNode || !Array.isArray(faultNode.components)) return false;
  const title = (part.title || '').toLowerCase();
  return faultNode.components.some((c) => matchesComponent(title, (c || '').toLowerCase()));
}

/**
 * Heuristic: is this string actually an appliance error code that the LLM
 * mis-extracted into `model`? (e.g. AEG "i20", Samsung "4E".) Definite when the
 * string is a known code in the brand's catalogue table; otherwise a
 * conservative, code-shaped pattern — but only for brands we hold codes for, so
 * genuine (longer) model numbers are never reclassified.
 */
function looksLikeCode(s, make) {
  if (!s) return false;
  const c = s.replace(/\s+/g, '').toUpperCase();
  if (c.length < 2 || c.length > 5) return false; // real model numbers are longer
  const fam = brandFamily(make);
  if (!fam) return false; // no code table for this brand → don't touch `model`
  const block = CATALOGUE.errorCodes?.[fam] || {};
  for (const [k, codes] of Object.entries(block)) {
    if (k === 'appliesTo' || k === '_note' || typeof codes !== 'object') continue;
    if (Object.keys(codes).some((code) => code.replace(/\s+/g, '').toUpperCase() === c)) {
      return true; // definite: known code for this brand
    }
  }
  // Conservative net for codes not (yet) in the table but clearly code-shaped.
  return /^(I\d{1,2}|[EFHCPUL]\d{1,3}|\d{1,2}[A-Z]{1,2}|[A-Z]{2}|FLASH\d+)$/.test(c);
}

/** Reset + test-mode guidance for the brand (falls back to generic). */
function resolveProcedures(intent) {
  const p = CATALOGUE.procedures || {};
  const fam = brandFamily(intent.make);
  return (fam && p[fam]) || p._generic || null;
}

/** Brand-platform diagnostic note (e.g. Panasonic = inverter), by brand family. */
function resolvePlatform(make) {
  const p = CATALOGUE.platforms || {};
  const fam = brandFamily(make);
  return (fam && p[fam]) || null;
}

/**
 * Ordered list of search queries to try when there's no model match.
 * The fault's components first (curated part-category terms, e.g. "drain pump
 * filter", "ntc temperature sensor") — these are short enough for the catalogue
 * search to match — then the LLM's own query as a final fallback.
 * Brand/appliance are deliberately NOT prefixed: they over-narrow the search.
 */
function buildQueryCandidates(intent, fault) {
  const list = [];
  // Evidence-based candidate components from the reasoning pass come FIRST, so
  // retrieval reflects the CURRENT conversation rather than only a static list.
  for (const comp of intent.candidateComponents || []) list.push(...componentTerms(comp));
  if (fault && Array.isArray(fault.node.components)) {
    // Each component plus its catalogue aliases (e.g. "circulation pump" also
    // searches "wash pump") so the search finds parts under the retailer's term.
    for (const comp of fault.node.components) list.push(...componentTerms(comp));
  }
  if (intent.catalogueQuery) list.push(intent.catalogueQuery);
  return [...new Set(list.map((s) => (s || '').trim()).filter(Boolean))];
}

module.exports = {
  CATALOGUE, FAULT_IDS, collectFaultIds, applianceKey, brandFamily, errorCodeFragmentTokens, uniqueBrandCodeHit,
  resolveFault, authoritativeCodeComponents, rankPartsByFault, selectLinkedParts, partsStillInPlay,
  preferCheckFirstPart, matchesComponent, humanizeFact, phraseRefersToComponent, refersToSameComponent,
  partMatchesFault, looksLikeCode, resolveProcedures, resolvePlatform, buildQueryCandidates,
};
