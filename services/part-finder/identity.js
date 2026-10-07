'use strict';
/**
 * Conversation identity: family + fuel/energy as three-state conversation state.
 *
 * States (family and fuel independently):
 *   UNKNOWN              — insufficient or conflicting evidence
 *   WORKING / INFERRED   — strong structured evidence; operationally useful; NOT customer-stated
 *   CUSTOMER-ESTABLISHED — customer explicitly named or corrected the appliance
 *
 * Authority order (highest first):
 *   1. explicit current-turn customer correction
 *   2. explicit customer identification in this conversation
 *   3. previously established identity (caller), iff it agrees with customer evidence
 *   4. WORKING inference from catalogue/model, unique make+code, or mutually supporting
 *      distinctive function evidence
 *   5. inferred (LLM / retrieval / COMPOSE / assistant text) — never established, never working
 *
 * WORKING must not be promoted to ESTABLISHED by retrieval, COMPOSE, or assistant text.
 */

const FAMILY_STATE = {
  UNKNOWN: 'unknown',
  WORKING: 'working',
  ESTABLISHED: 'established',
};

const EXPLICIT_FAMILY_CUES = [
  ['washer-dryer', /\bwasher[\s-]?dryers?\b|\bwashing[\s-]?and[\s-]?dry/i],
  ['tumble-dryer', /\btumble[\s-]?dryers?\b|\bcondenser dryers?\b|\bheat[\s-]?pump dryers?\b/],
  ['washing-machine', /\bwashing machines?\b/i],
  ['dishwasher', /\bdish\s?washers?\b/i],
  ['microwave', /\bmicrowaves?\b/i],
  ['hobs', /\b(?:induction |ceramic |gas |electric )?hobs?\b|\bcooktops?\b/i],
  ['oven-cooker', /\bovens?\b|\bcookers?\b|\brange cookers?\b/i],
  ['fridge-freezer', /\bfridge[\s-]?freezers?\b|\bfridges?\b|\bfreezers?\b|\brefrigerators?\b/i],
  ['vacuum', /\bvacuum(?:\s+cleaners?)?s?\b/i],
];
const SECONDARY_FAMILY_CUES = [
  ['tumble-dryer', /\bdryers?\b/i],
  ['washing-machine', /\bwashers?\b/i],
];
const DISTINCTIVE_FAMILY_CUES = [
  ['washer-dryer', /\bwasher[\s-]?dryers?\b/i],
  ['tumble-dryer', /\btumble[\s-]?dryers?\b|\bcondenser dryers?\b|\bheat[\s-]?pump dryers?\b/i],
  ['washing-machine', /\bwashing machines?\b/i],
  ['dishwasher', /\bdish\s?washers?\b/i],
  ['microwave', /\bmicrowaves?\b/i],
  ['vacuum', /\bvacuum(?:\s+cleaners?)?s?\b/i],
];
// Brand names are weak family evidence and must not override an explicit appliance word
// ("Hoover tumble dryer" is a dryer, not a vacuum). Used only as WORKING evidence when no
// other family is named — never as customer-established identity.
const VACUUM_BRAND_RE = /\b(?:dyson|henry)\b/i;
const VACUUM_WORD_RE = /\bvacuum(?:\s+cleaners?)?s?\b/i;
const HOOVER_AS_APPLIANCE_RE = /\b(?:my|the|this|our)\s+hoovers?\b/i;
const FRAMED_FAMILY_CUES = [
  ['hobs', /\b(?:induction |ceramic |gas |electric )?hobs?\b|\bcooktops?\b/i],
  ['oven-cooker', /\bovens?\b|\bcookers?\b|\brange cookers?\b/i],
  ['fridge-freezer', /\bfridge[\s-]?freezers?\b|\bfridges?\b|\bfreezers?\b|\brefrigerators?\b/i],
];

const FAMILY_SYNONYM = {
  'washing machine': 'washing-machine', washer: 'washing-machine', 'washing-machine': 'washing-machine',
  'washer dryer': 'washer-dryer', 'washer-dryer': 'washer-dryer',
  'tumble dryer': 'tumble-dryer', dryer: 'tumble-dryer', 'tumble-dryer': 'tumble-dryer',
  dishwasher: 'dishwasher',
  oven: 'oven-cooker', cooker: 'oven-cooker', 'oven cooker': 'oven-cooker', 'oven-cooker': 'oven-cooker',
  hob: 'hobs', hobs: 'hobs', cooktop: 'hobs',
  microwave: 'microwave', 'microwave oven': 'microwave',
  fridge: 'fridge-freezer', freezer: 'fridge-freezer', 'fridge freezer': 'fridge-freezer',
  'fridge-freezer': 'fridge-freezer', refrigerator: 'fridge-freezer',
  vacuum: 'vacuum', hoover: 'vacuum', 'vacuum cleaner': 'vacuum',
};

const CATALOGUE_CATEGORY_TO_FAMILY = {
  'washing machine': 'washing-machine',
  'washer dryer': 'washer-dryer',
  'washer-dryer': 'washer-dryer',
  'tumble dryer': 'tumble-dryer',
  'tumble-dryer': 'tumble-dryer',
  dishwasher: 'dishwasher',
  'fridge freezer': 'fridge-freezer',
  'fridge-freezer': 'fridge-freezer',
  fridge: 'fridge-freezer',
  freezer: 'fridge-freezer',
  refrigerator: 'fridge-freezer',
  oven: 'oven-cooker',
  cooker: 'oven-cooker',
  'range cooker': 'oven-cooker',
  hob: 'hobs',
  hobs: 'hobs',
  cooktop: 'hobs',
  microwave: 'microwave',
  'microwave oven': 'microwave',
  vacuum: 'vacuum',
  'vacuum cleaner': 'vacuum',
};

const ELECTRIC_ONLY_FAMILIES = new Set([
  'microwave', 'vacuum', 'dishwasher', 'washing-machine', 'washer-dryer', 'fridge-freezer',
]);
const GAS_EXCLUSIVE_FAULTS = new Set(['ignition']);
const GAS_DIAGNOSIS_RE = /\b(?:gas safe|flame[ -]?failure|thermocouple|\bfsd\b|\bffd\b|gas valve|gas supply|pilot (?:light|flame)|ignition module|gas ignition|gas burner)\b/i;
const IDENTITY_CLARIFICATION_RE = /what kind of appliance|what appliance (?:is|was) it|which appliance|what type of (?:appliance|machine)/i;

// Shared functions that exist on several families. Presence of these words is not
// by itself a foreign-family instruction. Exclusive programme/part language from
// another family's catalogue still is.
const SHARED_FUNCTION_TOKENS = new Set([
  'drain', 'draining', 'empty', 'emptying', 'motor', 'pump', 'heat', 'heating', 'heated',
  'thermal', 'exchanger',
  'water', 'door', 'filter', 'hose', 'seal', 'valve', 'switch', 'board', 'pcb',
  'cable', 'fuse', 'lead', 'fan', 'element', 'sensor', 'heater', 'inlet', 'outlet',
  'cycle', 'programme', 'program', 'cancel', 'start', 'stop', 'power', 'mains',
  'plug', 'socket', 'display', 'button', 'control', 'reset', 'unplug',
  'leak', 'leaking', 'overflow', 'foam', 'suds', 'bubbles', 'detergent', 'soap',
  'dose', 'rinse', 'wash', 'washing', 'clean', 'cleaning', 'block', 'blocked',
  'noise', 'noisy', 'hum', 'humming', 'fault', 'error', 'issue',
  'load', 'loads', 'items', 'item', 'contents', 'part', 'parts',
  'run', 'runs', 'running', 'failed', 'failure', 'fail', 'weak', 'clear',
  'cleared', 'gone', 'reaching', 'reach', 'still', 'keep', 'keeps',
  'making', 'going', 'come', 'comes', 'left', 'take', 'takes', 'taking',
  'base', 'tray', 'cabinet', 'sump',
  'turn', 'turns', 'turning', 'spin', 'spins', 'spinning', 'rotate', 'rotating',
  'vent', 'vents', 'duct', 'ducts', 'impeller', 'housing', 'trap',
]);
const LEXICON_STOP = new Set([
  'the', 'and', 'for', 'not', 'with', 'from', 'that', 'this', 'have', 'has', 'was',
  'are', 'its', 'you', 'get', 'out', 'off', 'all', 'any', 'now', 'still', 'just',
  'been', 'does', 'wont', 'cant', 'machine', 'appliance', 'when', 'then', 'than',
  'into', 'onto', 'over', 'under', 'after', 'before', 'while', 'only', 'also',
  'more', 'less', 'most', 'some', 'very', 'will', 'would', 'could', 'should',
  'make', 'like', 'used', 'using', 'type', 'correct', 'first', 'check', 'reduce',
  'replace', 'detected', 'problem', 'coming', 'everywhere', 'loads', 'lots',
  'much', 'stay', 'stays', 'belong', 'another', 'kind', 'rather',
]);
// Observation, material, and ambiguous part-ish unigrams. Exclusive matching uses
// the full component phrase (e.g. "moisture sensor", "door glass", "lint filter")
// so shared diagnostic language is not treated as another family's procedure.
const GENERIC_UNIGRAMS = new Set([
  'cold', 'cool', 'warm', 'hot', 'damp', 'wet', 'moisture', 'humidity',
  'blockage', 'obstruction', 'restriction', 'jammed', 'clogged',
  'glass', 'glasses', 'plastic', 'plastics', 'crockery', 'ceramic',
  'lock', 'pressure', 'shock', 'catch', 'hall', 'carbon', 'chamber',
  'drawer', 'fluff', 'lint', 'inner', 'outer', 'broken', 'cracked',
  'spots', 'film', 'cloudy', 'marks', 'dirty', 'air', 'bars', 'felt',
  'support', 'position', 'thermal', 'wiring', 'bearing', 'belt',
  'paddle', 'float', 'diode', 'inverter', 'absorber', 'brushes', 'brush',
  'relay', 'lamp', 'bulb', 'hinge', 'gasket', 'coupler', 'burning',
  'smell', 'full', 'empty', 'rear', 'front', 'main', 'start', 'drive',
  'dispenser', 'softener', 'container', 'spray', 'away', 'fully',
  'remaining', 'standing', 'coming',
]);

let CATALOGUE_FOR_LEXICON = { faults: {} };
try {
  // eslint-disable-next-line global-require
  CATALOGUE_FOR_LEXICON = require('./faults-catalogue.json');
} catch {
  CATALOGUE_FOR_LEXICON = { faults: {} };
}

const FAMILY_TERM_INDEX = buildFamilyTermIndex(CATALOGUE_FOR_LEXICON);

function canonFamily(value) {
  if (!value) return null;
  const t = String(value).toLowerCase().trim();
  if (FAMILY_SYNONYM[t]) return FAMILY_SYNONYM[t];
  const dashed = t.replace(/\s+/g, '-');
  return FAMILY_SYNONYM[dashed] || dashed;
}

function customerOnlyText(text) {
  return String(text || '')
    .split(/\n+/)
    .filter((line) => !/^\s*(advisor asked|assistant)\s*:/i.test(line))
    .join('\n')
    .replace(/\b(?:advisor asked|assistant)\s*:\s*[^\n]*/gi, '')
    .trim();
}

function namedFromCues(text, cues) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const hits = [];
  for (const [family, re] of cues) {
    if (re.test(t) && !hits.includes(family)) hits.push(family);
  }
  return hits;
}

function namedFamiliesIn(text, { explicitOnly = false } = {}) {
  const cues = explicitOnly ? EXPLICIT_FAMILY_CUES : EXPLICIT_FAMILY_CUES.concat(SECONDARY_FAMILY_CUES);
  return namedFromCues(text, cues);
}

function identityNamedFamilies(text) {
  const t = String(text || '');
  const hits = namedFromCues(t, DISTINCTIVE_FAMILY_CUES);
  for (const [family, re] of FRAMED_FAMILY_CUES) {
    re.lastIndex = 0;
    const m = re.exec(t);
    if (!m) continue;
    const before = t.slice(Math.max(0, m.index - 28), m.index);
    const framed = /\b(?:my|our|this)\s*$/i.test(before)
      || /\b(?:it'?s|its|is)\s+(?:a |an |the )$/i.test(before)
      || new RegExp(`\\b(?:my|our|this)\\s+${m[0].replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`, 'i').test(t)
      || /\bactually\b.{0,20}\b(?:a |an |the )?/i.test(before)
      || /\b(?:meant|not the|not a|not an)\b/i.test(before);
    if (framed && !hits.includes(family)) hits.push(family);
  }
  const nonVacuum = hits.filter((f) => f !== 'vacuum');
  if (VACUUM_WORD_RE.test(t) && !hits.includes('vacuum')) hits.push('vacuum');
  else if (!hits.includes('vacuum') && !nonVacuum.length && HOOVER_AS_APPLIANCE_RE.test(t)
      && !/\b(?:tumble[\s-]?dryers?|dryers?|washing machines?|washers?)\b/i.test(t)) {
    hits.push('vacuum');
  }
  if (nonVacuum.length && hits.includes('vacuum') && !VACUUM_WORD_RE.test(t)) {
    return hits.filter((f) => f !== 'vacuum');
  }
  return hits;
}

function userTurnsFromMessages(messages) {
  const userTurns = [];
  if (!Array.isArray(messages)) return userTurns;
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') userTurns.push(customerOnlyText(m.content));
    else if (Array.isArray(m.content)) {
      const t = m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join(' ');
      if (t) userTurns.push(customerOnlyText(t));
    }
  }
  return userTurns;
}

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join(' ');
      }
    }
  }
  return '';
}

/**
 * Split a single labelled blob ("Customer: …\\nAdvisor asked: …") into roles so assistant
 * guesses cannot be read as customer evidence.
 */
function hydrateConversationRoles(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages || [];
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role !== 'user' || Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const text = String(m.content || '');
    if (!/(?:^|\n)\s*(?:Customer|Advisor asked|Assistant)\s*:/i.test(text)
        && !/\b(?:Customer|Advisor asked|Assistant)\s*:/.test(text)) {
      out.push(m);
      continue;
    }
    const chunks = text.split(/(?=(?:Customer|Advisor asked|Assistant)\s*:)/i).map((s) => s.trim()).filter(Boolean);
    if (chunks.length < 2) {
      out.push(m);
      continue;
    }
    for (const chunk of chunks) {
      const cm = /^(Customer|Advisor asked|Assistant)\s*:\s*([\s\S]*)$/i.exec(chunk.trim());
      if (!cm) {
        out.push({ role: 'user', content: chunk });
        continue;
      }
      const role = /^customer$/i.test(cm[1]) ? 'user' : 'assistant';
      out.push({ role, content: cm[2].trim() });
    }
  }
  return out.length ? out : messages;
}

const SHORT_FOLLOWUP_RE = /^(?:yes|yep|yeah|yup|ok|okay|no|nope|nah|correct|right|i don'?t know|don'?t know|not sure|no idea|already tried(?: that)?|already done(?: that)?)\s*[.!]?\s*$/i;
const DONT_KNOW_PREFIX_RE = /^(?:i don'?t know|don'?t know|not sure|no idea)\b/i;

function isShortFollowUp(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (SHORT_FOLLOWUP_RE.test(t)) return true;
  return DONT_KNOW_PREFIX_RE.test(t) && t.length <= 96;
}

function looksLikeModelToken(token) {
  const c = String(token || '').replace(/[\s-]/g, '').toUpperCase();
  if (!c) return false;
  if (/^([EFHCU]\d{1,3}[A-Z]?|I\d{1,2}|AL\d{1,2}|\d{1,2}[CE])$/.test(c)) return false;
  if (/^[A-Z]{2,}\d{2,}[A-Z0-9]*$/.test(c)) return true;
  if (/^V\d{1,2}$/.test(c)) return true;
  return false;
}

function extractModelTokenFromText(text) {
  const parts = String(text || '').split(/[^\w]+/).filter(Boolean);
  const candidates = parts.slice();
  // Customers often split a model token ("v 6", "g 20"). Fuse a short letter
  // run with the following digits; looksLikeModelToken still rejects error codes.
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (/^[A-Za-z]{1,3}$/.test(parts[i]) && /^\d{1,3}[A-Za-z]?$/.test(parts[i + 1])) {
      candidates.push(parts[i] + parts[i + 1]);
    }
  }
  const found = [];
  for (const p of candidates) {
    if (looksLikeModelToken(p)) found.push(p);
  }
  found.sort((a, b) => b.length - a.length);
  return found[0] || null;
}

const KNOWN_FAMILIES = new Set([
  'washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher',
  'oven-cooker', 'hobs', 'microwave', 'fridge-freezer', 'vacuum',
]);

function familyFromCatalogueCategory(category) {
  if (!category) return null;
  const t = String(category).toLowerCase().trim().replace(/[_/]+/g, ' ');
  const mapped = CATALOGUE_CATEGORY_TO_FAMILY[t] || CATALOGUE_CATEGORY_TO_FAMILY[t.replace(/\s+/g, '-')] || canonFamily(t);
  return KNOWN_FAMILIES.has(mapped) ? mapped : null;
}

function uniqueFamilyForMakeAndCode(errorCodes, make, code) {
  if (!errorCodes || !make || !code) return null;
  const m = String(make).toLowerCase().trim();
  const norm = (s) => String(s).replace(/[^a-z0-9]/gi, '').toUpperCase();
  const want = norm(code);
  if (!want) return null;
  let brandKey = null;
  for (const [family, def] of Object.entries(errorCodes)) {
    if (!def || typeof def !== 'object') continue;
    if (family === m) { brandKey = family; break; }
    if (Array.isArray(def.appliesTo) && def.appliesTo.some((b) => m.includes(String(b)) || String(b).includes(m))) {
      brandKey = family;
      break;
    }
  }
  if (!brandKey) return null;
  const def = errorCodes[brandKey];
  const hits = [];
  for (const [appKey, table] of Object.entries(def)) {
    if (appKey === 'appliesTo' || appKey.startsWith('_') || !table || typeof table !== 'object' || Array.isArray(table)) continue;
    const match = Object.keys(table).some((k) => norm(k) === want);
    if (match) {
      const fam = canonFamily(appKey);
      if (fam && !hits.includes(fam)) hits.push(fam);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

function inferWorkingIdentity({ catalogueFamily, uniqueErrorCodeFamily, jevFamily } = {}) {
  // WORKING (operational, not customer-established) family from NON-prose evidence only: a resolved
  // catalogue model, a unique make+code, or Jev's typed INFERRED family. Jev is the sole interpreter
  // of the customer's words — there is no customer-prose function-cue inference here (the former
  // distinctiveWorkingHits machinery is deleted; Jev supplies the inferred family instead).
  const cat = canonFamily(catalogueFamily);
  if (cat) return { family: cat, source: 'catalogue-model', evidence: 'catalogue-category' };
  const codeFam = canonFamily(uniqueErrorCodeFamily);
  if (codeFam) return { family: codeFam, source: 'error-code-unique', evidence: 'make+unique-code' };
  const jev = KNOWN_FAMILIES.has(canonFamily(jevFamily)) ? canonFamily(jevFamily) : null;
  if (jev) return { family: jev, source: 'jev-typed-family', evidence: 'jev-appliance-family' };
  return null;
}

function hasOperationalFamily(identity) {
  if (!identity || !identity.family) return false;
  return identity.familyState === FAMILY_STATE.ESTABLISHED
    || identity.familyState === FAMILY_STATE.WORKING
    || Boolean(identity.familyEstablished);
}

/**
 * STAGE A — central deterministic appliance-family state precedence across conversation turns.
 *
 * Pure function. Jev owns the SEMANTIC provenance of the current turn; this function owns the
 * deterministic STATE precedence. No phrase/keyword/regex interpretation of customer language.
 *
 *   prior:   the previously persisted conversation identity for this session
 *            { family, familyState } (familyState one of FAMILY_STATE; may be null/UNKNOWN)
 *   current: THIS turn's typed Jev output
 *            { family, provenance, workingFamily }
 *              family        — Jev's typed applianceFamily this turn (canonical or null)
 *              provenance    — Jev's applianceFamilyProvenance: 'customer_named' | 'inferred' |
 *                              'none' | 'uncertain' | null. 'customer_named' denotes the customer
 *                              STATED OR CORRECTED the family in their own words (Jev contract).
 *              workingFamily — an operationally-committed family for this turn from NON-prose
 *                              WORKING evidence (resolved catalogue model / unique make+code /
 *                              Jev's inferred family the caller chose to commit), or null.
 *
 * Precedence (highest first):
 *   1. Explicit customer identification / correction THIS turn (provenance customer_named) wins and
 *      is ESTABLISHED. If it names a DIFFERENT family than an established prior it is a correction.
 *   2. An ESTABLISHED prior family is PRESERVED. A weak / null / unknown / uncertain / inferred
 *      current turn CANNOT overwrite it.
 *   3. No established prior: commit this turn's WORKING inference (WORKING); else retain a prior
 *      WORKING family across a null/weak turn; else UNKNOWN.
 *
 * A WORKING (inferred) family is NEVER promoted to ESTABLISHED — only an explicit customer naming
 * establishes identity.
 */
function nextFamilyIdentity(prior, current) {
  const p = prior || {};
  const c = current || {};
  const priorFam = KNOWN_FAMILIES.has(canonFamily(p.family)) ? canonFamily(p.family) : null;
  const priorEstablished = Boolean(priorFam)
    && (p.familyState === FAMILY_STATE.ESTABLISHED || p.familyEstablished === true);
  const priorWorking = Boolean(priorFam) && !priorEstablished && p.familyState === FAMILY_STATE.WORKING;

  const curFam = KNOWN_FAMILIES.has(canonFamily(c.family)) ? canonFamily(c.family) : null;
  const explicit = c.provenance === 'customer_named' && Boolean(curFam);
  const workingFam = KNOWN_FAMILIES.has(canonFamily(c.workingFamily)) ? canonFamily(c.workingFamily) : null;

  // 1. Explicit customer identification / correction this turn.
  if (explicit) {
    const corrected = priorEstablished && curFam !== priorFam;
    return {
      family: curFam,
      familyState: FAMILY_STATE.ESTABLISHED,
      familySource: corrected ? 'correction' : 'customer',
      familyEvidence: corrected ? 'customer-corrected' : 'customer-named',
      transition: corrected ? 'corrected' : 'established',
    };
  }
  // 2. Established prior identity is preserved against a weak/null/inferred current turn.
  if (priorEstablished) {
    return {
      family: priorFam,
      familyState: FAMILY_STATE.ESTABLISHED,
      familySource: 'established',
      familyEvidence: 'established-retained',
      transition: 'preserved',
    };
  }
  // 3. No established prior: commit this turn's WORKING inference, else retain prior WORKING, else unknown.
  if (workingFam) {
    return {
      family: workingFam,
      familyState: FAMILY_STATE.WORKING,
      familySource: 'working',
      familyEvidence: 'working-inference',
      transition: workingFam === priorFam ? 'preserved' : 'working',
    };
  }
  if (priorWorking) {
    return {
      family: priorFam,
      familyState: FAMILY_STATE.WORKING,
      familySource: 'working',
      familyEvidence: 'working-retained',
      transition: 'preserved',
    };
  }
  return {
    family: null,
    familyState: FAMILY_STATE.UNKNOWN,
    familySource: 'unresolved',
    familyEvidence: null,
    transition: 'unknown',
  };
}

function resolveConversationIdentity({
  bodyAppliance, bodyFuel, identitySource, messages, queryText,
  catalogueFamily, uniqueErrorCodeFamily, jevFamily, jevFamilyProvenance, jevFuel,
  priorIdentity,
} = {}) {
  const hydrated = hydrateConversationRoles(messages || []);
  const userTurns = userTurnsFromMessages(hydrated);
  const blob = customerOnlyText(userTurns.length ? userTurns.join('\n') : (queryText || ''));
  const latest = userTurns.length ? userTurns[userTurns.length - 1] : customerOnlyText(queryText || '');
  // FAMILY is Jev's. Jev types the appliance family AND its provenance:
  //   customer_named → the customer stated or corrected it in words → ESTABLISHED
  //   inferred       → Jev deduced it from symptom/function/model/context → WORKING
  // Structured caller identity and a resolved catalogue model / unique make+code remain NON-prose
  // WORKING evidence. There is NO customer-prose family-naming regex here. A later customer
  // correction is honoured because Jev re-reads the whole conversation and returns the corrected
  // family with customer_named provenance.
  const jf = KNOWN_FAMILIES.has(canonFamily(jevFamily)) ? canonFamily(jevFamily) : null;
  const customerNamedFamily = Boolean(jf) && jevFamilyProvenance === 'customer_named';

  const supplied = canonFamily(bodyAppliance);
  // Caller-supplied identity is STRUCTURED input (identitySource), not customer prose. When no source
  // is given we trust it only if it matches Jev's typed family — never by re-parsing customer words.
  const callerTrusted = identitySource === 'customer' || identitySource === 'established'
    || (!identitySource && Boolean(supplied) && supplied === jf);
  const inferredCaller = identitySource === 'inferred' || (supplied && !callerTrusted);
  const latestIsFollowUp = isShortFollowUp(latest);

  let family = null;
  let familySource = 'unresolved';
  let familyState = FAMILY_STATE.UNKNOWN;
  let familyEvidence = null;
  if (customerNamedFamily) {
    family = jf;
    familySource = 'customer';
    familyState = FAMILY_STATE.ESTABLISHED;
    familyEvidence = 'customer-named';
  } else if (supplied && callerTrusted) {
    family = supplied;
    familySource = 'caller';
    familyState = FAMILY_STATE.ESTABLISHED;
    familyEvidence = 'caller-established';
  } else {
    const working = inferWorkingIdentity({ catalogueFamily, uniqueErrorCodeFamily, jevFamily: jf });
    if (working && working.family) {
      family = working.family;
      familySource = working.source;
      familyState = FAMILY_STATE.WORKING;
      familyEvidence = working.evidence;
    } else if (supplied && inferredCaller) {
      family = null;
      familySource = 'inferred-rejected';
      familyState = FAMILY_STATE.UNKNOWN;
      familyEvidence = 'inferred-rejected';
    }
  }

  // STAGE A: cross-turn established-identity precedence. When the caller threads the previously
  // persisted conversation identity (priorIdentity), reconcile it with THIS turn's typed result via
  // the central deterministic state machine: a genuinely ESTABLISHED family is PRESERVED against a
  // weak/null/unknown/inferred current turn, and is replaced ONLY by an explicit customer
  // identification/correction this turn (Jev provenance customer_named). Additive and inert when no
  // priorIdentity is supplied, so single-turn resolution (and every existing caller) is unchanged.
  if (priorIdentity && priorIdentity.family) {
    const reconciled = nextFamilyIdentity(
      { family: priorIdentity.family, familyState: priorIdentity.familyState },
      {
        family: jf,
        provenance: jevFamilyProvenance,
        workingFamily: familyState !== FAMILY_STATE.UNKNOWN ? family : null,
      },
    );
    family = reconciled.family;
    familySource = reconciled.familySource;
    familyState = reconciled.familyState;
    familyEvidence = reconciled.familyEvidence;
  }

  // FUEL is Jev's: the customer's EXPLICIT energy statement (gas / electric / dual) or a genuine
  // conflict, typed by Jev. The family-inherent-electric default (a dishwasher/washer/microwave etc.
  // is electric) is a STRUCTURAL fact about the appliance family, not an interpretation of the
  // customer's words, so it is retained as a deterministic WORKING default. There is NO customer-prose
  // fuel regex here. A later fuel correction is honoured via Jev's re-read of the whole conversation.
  const jFuel = jevFuel && typeof jevFuel === 'object' ? jevFuel : null;
  let fuel = null;
  let fuelSource = 'unresolved';
  let fuelState = FAMILY_STATE.UNKNOWN;
  let fuelConflict = false;
  if (jFuel && jFuel.conflict) {
    fuelConflict = true;
    fuelState = FAMILY_STATE.UNKNOWN;
  } else if (jFuel && (jFuel.value === 'gas' || jFuel.value === 'electric' || jFuel.value === 'dual')) {
    fuel = jFuel.value;
    fuelSource = 'customer';
    fuelState = FAMILY_STATE.ESTABLISHED;
  } else if (bodyFuel && (bodyFuel === 'gas' || bodyFuel === 'electric') && identitySource !== 'inferred') {
    // Structured caller fuel (identitySource path; not exercised by the current customer flow).
    fuel = bodyFuel;
    fuelSource = 'caller';
    fuelState = identitySource === 'customer' || identitySource === 'established'
      ? FAMILY_STATE.ESTABLISHED
      : FAMILY_STATE.WORKING;
  }
  if (ELECTRIC_ONLY_FAMILIES.has(family) && fuel !== 'gas' && fuel !== 'dual') {
    fuel = 'electric';
    if (fuelState === FAMILY_STATE.UNKNOWN) {
      fuelSource = 'family-inherent';
      fuelState = FAMILY_STATE.WORKING;
    }
  }

  return {
    family,
    familySource,
    familyState,
    familyEstablished: familyState === FAMILY_STATE.ESTABLISHED,
    familyEvidence,
    fuel: fuel || null,
    fuelSource,
    fuelState,
    fuelEstablished: fuelState === FAMILY_STATE.ESTABLISHED,
    fuelConflict,
    inferredRejected: familySource === 'inferred-rejected' ? supplied : null,
    latestIsFollowUp,
    lastAssistantQuestion: lastAssistantText(hydrated),
    customerText: blob,
    latestTurn: latest,
  };
}

function questionAsksDifferentFamily(question, establishedFamily) {
  if (!question || !establishedFamily) return false;
  const named = namedFamiliesIn(question, { explicitOnly: true }).map(canonFamily);
  const want = canonFamily(establishedFamily);
  return named.some((f) => f && f !== want);
}

function discriminatorQuestion(fact, family, table) {
  const entry = table && table[fact];
  if (!entry) return null;
  const q = typeof entry === 'string' ? entry : entry.q;
  const families = typeof entry === 'string' ? null : entry.families;
  if (families && family) {
    const k = canonFamily(family);
    if (k && !families.includes(k)) return null;
  }
  return q || null;
}

// A dual-fuel range (gas hob + electric oven) HAS a gas path, so gas-exclusive diagnosis is permitted
// for gas and dual, and forbidden only when the fuel is known-electric or unknown.
function fuelPermitsGas(fuel) {
  return fuel === 'gas' || fuel === 'dual';
}

function faultAllowedForIdentity(faultId, identity) {
  if (!faultId) return true;
  if (GAS_EXCLUSIVE_FAULTS.has(faultId) && identity && !fuelPermitsGas(identity.fuel)) return false;
  return true;
}

function lockIdentityOnIntent(intent, identity, retrievalDocs) {
  if (!intent || typeof intent !== 'object') return intent;
  const id = identity || {};
  if (hasOperationalFamily(id)) {
    intent.applianceType = id.family;
    intent._applianceUnconfirmed = false;
    if (questionAsksDifferentFamily(intent.clarifyingQuestion, id.family)
        || IDENTITY_CLARIFICATION_RE.test(intent.clarifyingQuestion || '')) {
      intent.clarifyingQuestion = null;
    }
    if (intent.faultId && GAS_EXCLUSIVE_FAULTS.has(intent.faultId) && !fuelPermitsGas(id.fuel)) {
      intent.faultId = null;
      intent.confidence = 0;
    }
    constrainIntentToFamily(intent, id.family);
    return intent;
  }
  // UNKNOWN: inferred family from UNDERSTAND or retrieval must not survive.
  intent.applianceType = null;
  intent.needMoreInfo = true;
  intent.faultId = null;
  intent.clarifyingQuestion = id.fuelConflict
    ? 'Is this a gas appliance or an electric one?'
    : 'What kind of appliance is it?';
  if (Array.isArray(retrievalDocs) && retrievalDocs.length) {
    /* retrieval must not mint family; docs ignored here */
  }
  return intent;
}

function formatIdentityLock(identity) {
  if (!identity) return '';
  const lines = [
    'CONVERSATION IDENTITY (structured conversation state — retrieval, COMPOSE, and assistant text have ZERO authority to change it or to upgrade WORKING to ESTABLISHED):',
  ];
  if (identity.familyState === FAMILY_STATE.ESTABLISHED || identity.familyEstablished) {
    lines.push(`- applianceFamily: ${identity.family}`);
    lines.push(`- applianceFamilyState: CUSTOMER-ESTABLISHED (source=${identity.familySource}). You MUST keep applianceType exactly this. Retrieved documents, symptoms that resemble another family, component names, and short follow-ups cannot change it.`);
  } else if (identity.familyState === FAMILY_STATE.WORKING && identity.family) {
    lines.push(`- applianceFamily: ${identity.family}`);
    lines.push(`- applianceFamilyState: WORKING/INFERRED (source=${identity.familySource}; evidence=${identity.familyEvidence || identity.familySource}). Reason within this family. Do NOT ask what kind of appliance it is. This is NOT customer-stated fact — do not upgrade it to established. Explicit customer identification or correction MAY replace it. Retrieved documents cannot change it.`);
  } else {
    lines.push('- applianceFamily: UNKNOWN');
    lines.push('- applianceFamilyState: UNKNOWN. Leave applianceType null. Ask what kind of appliance it is only if that would change the next diagnostic action. Do NOT infer fridge/hob/vacuum/oven from generic symptoms (cold, heat, suction, spin, element) or from retrieved documents.');
  }
  if (identity.fuelConflict) {
    lines.push('- fuel/energy: CONFLICTING customer evidence. Ask whether it is gas or electric. Do not pick one silently.');
  } else if (identity.fuelState === FAMILY_STATE.ESTABLISHED && identity.fuel === 'electric') {
    lines.push('- fuel/energy: electric (CUSTOMER-ESTABLISHED). Do NOT use gas-only diagnosis (ignition, FSD/FFD, thermocouple, gas valve, Gas Safe, flame failure, pilot).');
  } else if (identity.fuelState === FAMILY_STATE.WORKING && identity.fuel === 'electric') {
    lines.push('- fuel/energy: electric (WORKING, not customer-stated). Do NOT use gas-only diagnosis. Do not upgrade this to customer-established. Do not invent gas from spark/ignition wording.');
  } else if (identity.fuel === 'electric') {
    lines.push('- fuel/energy: electric. Do NOT use gas-only diagnosis (ignition, FSD/FFD, thermocouple, gas valve, Gas Safe, flame failure, pilot).');
  } else if (identity.fuel === 'gas') {
    lines.push(`- fuel/energy: gas (${identity.fuelState === FAMILY_STATE.ESTABLISHED ? 'CUSTOMER-ESTABLISHED' : 'WORKING'}). Gas-path diagnosis is allowed where the evidence supports it.`);
  } else if (identity.fuel === 'dual') {
    lines.push('- fuel/energy: dual-fuel range (CUSTOMER-ESTABLISHED). Gas-path diagnosis is allowed for the gas side (e.g. hob ignition); the electric side stays on the heating/control path.');
  } else {
    lines.push('- fuel/energy: unknown. Do NOT assume gas. Do not diagnose ignition/FSD/thermocouple/gas valve. Stay on the heating/control path or ask fuel type if that would change the next action. Spark/ignition wording is not gas evidence.');
  }
  if (identity.latestIsFollowUp) {
    lines.push(`- The latest customer turn is a short follow-up binding to the previous assistant question: "${(identity.lastAssistantQuestion || '').slice(0, 240)}". It is not a new appliance and not a new fault description. Preserve the current identity state.`);
  }
  if (identity.family && (identity.familyState === FAMILY_STATE.ESTABLISHED
      || identity.familyState === FAMILY_STATE.WORKING || identity.familyEstablished)) {
    lines.push('- Customer-facing programmes, controls, named parts, and procedures MUST belong to this appliance family. Shared functions (drain, heat, water, motor, pump) do not licence another family\'s procedures or component language. Do not tell the customer to use a control, programme, or named part that this family does not have.');
  }
  lines.push('- An explicit customer correction ("sorry, I meant my washing machine", "actually it\'s electric") MAY update identity. Assistant guesses never become customer identity.');
  return `\n\n${lines.join('\n')}`;
}

function replyUsesForeignDiscriminator(text, family, table) {
  if (!text || !family || !table) return false;
  const want = canonFamily(family);
  for (const entry of Object.values(table)) {
    const q = typeof entry === 'string' ? entry : (entry && entry.q);
    const families = typeof entry === 'string' ? null : (entry && entry.families);
    if (!q || !families || !families.length) continue;
    if (families.includes(want)) continue;
    if (String(text).includes(String(q).slice(0, 40))) return true;
  }
  return false;
}

function familiesNamedInReply(text) {
  const blob = String(text || '');
  if (!blob.trim()) return [];
  const hits = identityNamedFamilies(blob).concat(namedFamiliesIn(blob)).map(canonFamily).filter(Boolean);
  return [...new Set(hits)];
}

function addLexiconTerm(into, family, raw) {
  const term = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!term || LEXICON_STOP.has(term) || SHARED_FUNCTION_TOKENS.has(term)) return;
  const parts = term.split(/\s+/).filter(Boolean);
  // "heating element", "drain pump", "vent hose" are shared-function compounds,
  // not another family's exclusive procedure, even if only some catalogues list them.
  if (parts.length && parts.every((p) => SHARED_FUNCTION_TOKENS.has(p) || LEXICON_STOP.has(p))) return;
  if (!into.has(term)) into.set(term, new Set());
  into.get(term).add(family);
}

function contentTokens(text) {
  return (String(text || '').toLowerCase().match(/\b[a-z][a-z0-9-]{3,}\b/g) || [])
    .filter((w) => !LEXICON_STOP.has(w) && !SHARED_FUNCTION_TOKENS.has(w));
}

function rawComponentTokens(text) {
  return (String(text || '').toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) || [])
    .filter((w) => !LEXICON_STOP.has(w));
}

function addComponentPhrases(into, family, chunk) {
  const raw = rawComponentTokens(chunk);
  if (!raw.length) return;
  addLexiconTerm(into, family, chunk);
  for (let n = 2; n <= raw.length; n++) {
    for (let i = 0; i + n <= raw.length; i++) {
      addLexiconTerm(into, family, raw.slice(i, i + n).join(' '));
    }
  }
}

function buildFamilyTermIndex(catalogue) {
  const termFamilies = new Map();
  const faults = (catalogue && catalogue.faults) || {};
  for (const [family, nodes] of Object.entries(faults)) {
    const fam = canonFamily(family);
    if (!fam || !nodes || typeof nodes !== 'object') continue;
    const distinctiveUnigrams = new Set();
    for (const node of Object.values(nodes)) {
      if (!node || typeof node !== 'object') continue;
      for (const comp of node.components || []) {
        const chunk = String(comp || '');
        if (/[/]/.test(chunk) || /^(reduce|use|run|try|clean|check|stop|cancel)\b/i.test(chunk.trim())) continue;
        const raw = rawComponentTokens(chunk);
        const words = contentTokens(chunk);
        if (!raw.length) continue;
        addComponentPhrases(termFamilies, fam, chunk);
        if (raw.length === 1) {
          addLexiconTerm(termFamilies, fam, raw[0]);
          distinctiveUnigrams.add(raw[0]);
          continue;
        }
        for (const w of words) {
          if (GENERIC_UNIGRAMS.has(w)) continue;
          addLexiconTerm(termFamilies, fam, w);
          distinctiveUnigrams.add(w);
        }
      }
    }
    for (const faultId of Object.keys(nodes)) {
      for (const part of String(faultId || '').split('-')) {
        if (distinctiveUnigrams.has(part)) addLexiconTerm(termFamilies, fam, part);
      }
    }
  }
  const sorted = [...termFamilies.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const regexes = new Map();
  for (const term of sorted) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    regexes.set(term, new RegExp(`\\b${escaped}\\b`, 'i'));
  }
  return { termFamilies, sorted, regexes };
}

function familyOwnsTerm(family, term) {
  const owners = FAMILY_TERM_INDEX.termFamilies.get(term);
  return Boolean(owners && owners.has(family));
}

function catalogueTermsIn(text, ownerPred) {
  const blob = String(text || '');
  if (!blob.trim()) return [];
  const hits = [];
  for (const term of FAMILY_TERM_INDEX.sorted) {
    if (SHARED_FUNCTION_TOKENS.has(term) || LEXICON_STOP.has(term)) continue;
    const owners = FAMILY_TERM_INDEX.termFamilies.get(term);
    if (!ownerPred(owners)) continue;
    const re = FAMILY_TERM_INDEX.regexes.get(term);
    if (re && re.test(blob)) hits.push(term);
  }
  return hits;
}

function foreignFamilyTermsIn(text, family) {
  const allowed = canonFamily(family);
  if (!allowed) return [];
  return catalogueTermsIn(text, (owners) => owners && owners.size && !owners.has(allowed));
}

/**
 * Catalogue terms that are not shared functions. Presence of these in a reply
 * is family-specific architecture/component language, even when more than one
 * family happens to share the same part name (drum on washer and dryer).
 */
function familySpecificCatalogueTermsIn(text) {
  return catalogueTermsIn(text, (owners) => owners && owners.size > 0);
}

function replyUsesForeignFamilyInstruction(text, family) {
  return foreignFamilyTermsIn(text, family).length > 0;
}

function stripTermsFromReply(text, hits) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  const sentenceHasHit = (s) => (hits || []).some((term) => {
    const re = FAMILY_TERM_INDEX.regexes.get(term);
    return re && re.test(s);
  });
  const sentences = raw.split(/(?<=[.!?])\s+|(?<=;)\s+/);
  const keptSentences = sentences.filter((s) => s && !sentenceHasHit(s));
  let out = keptSentences.join(' ').replace(/\s+/g, ' ').trim();
  if (out.length >= 24) return out;
  const clauses = raw.split(/[,:]\s+/);
  const keptClauses = clauses.filter((s) => s && !sentenceHasHit(s));
  out = keptClauses.join('. ').replace(/\s+/g, ' ').trim();
  if (out.length >= 24) return out;
  let inPlace = raw;
  for (const term of hits || []) {
    const re = FAMILY_TERM_INDEX.regexes.get(term);
    if (!re) continue;
    inPlace = inPlace.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ');
  }
  return inPlace.replace(/\s+/g, ' ').trim();
}

function stripForeignInstructionSentences(text, family) {
  return stripTermsFromReply(text, foreignFamilyTermsIn(text, family));
}

function stripFamilySpecificCatalogueSentences(text) {
  return stripTermsFromReply(text, familySpecificCatalogueTermsIn(text));
}

function familyCompatibleFallback(identity, original) {
  const stay = 'I will stay with the controls and checks that belong on this appliance rather than another kind of machine.';
  if (!hasOperationalFamily(identity)) return identitySafeFallback(identity);
  const src = String(original || '');
  if (/\b(foam|suds|bubbles)\b/i.test(src)) {
    return `${stay} If there is too much foam, stop or cancel the cycle, let it settle, scoop or wipe it, then drain or rinse using this appliance's own controls. This is not a failed part.`;
  }
  return stay;
}

function faultAllowedForFamily(faultId, family) {
  if (!faultId || !family) return true;
  const fam = canonFamily(family);
  const nodes = CATALOGUE_FOR_LEXICON.faults && CATALOGUE_FOR_LEXICON.faults[fam];
  if (!nodes) return true;
  return Object.prototype.hasOwnProperty.call(nodes, faultId);
}

function dropForeignInstruction(value, family) {
  if (!value) return value;
  return replyUsesForeignFamilyInstruction(value, family) ? null : value;
}

function constrainIntentToFamily(intent, family) {
  if (!intent || typeof intent !== 'object') return intent;
  const fam = canonFamily(family);
  if (!fam) return intent;
  if (intent.faultId && !faultAllowedForFamily(intent.faultId, fam)) {
    intent.faultId = null;
    intent.confidence = 0;
  }
  intent.nextBestCheck = dropForeignInstruction(intent.nextBestCheck, fam);
  intent.clarifyingQuestion = dropForeignInstruction(intent.clarifyingQuestion, fam);
  intent.primaryFinding = dropForeignInstruction(intent.primaryFinding, fam);
  intent._pendingDiscriminator = dropForeignInstruction(intent._pendingDiscriminator, fam);
  if (intent._materialAmbiguity) {
    const q = dropForeignInstruction(intent._materialAmbiguity.question, fam);
    if (!q) intent._materialAmbiguity = null;
    else intent._materialAmbiguity.question = q;
  }
  if (intent._areaDiscriminator) {
    const q = dropForeignInstruction(intent._areaDiscriminator.question, fam);
    if (!q) intent._areaDiscriminator = null;
    else intent._areaDiscriminator.question = q;
  }
  if (Array.isArray(intent.candidateComponents) && intent.candidateComponents.length) {
    intent.candidateComponents = intent.candidateComponents.filter(
      (c) => !replyUsesForeignFamilyInstruction(c, fam),
    );
  }
  return intent;
}

function constrainReplyToIdentity(reply, identity, opts = {}) {
  const text = String(reply || '');
  if (!text.trim() || !identity) return { text, changed: false, reason: null };
  const allowedFamily = canonFamily(opts.allowedFamily) || (hasOperationalFamily(identity) ? identity.family : null);
  const operational = Boolean(allowedFamily);
  if (operational && questionAsksDifferentFamily(text, allowedFamily)) {
    return {
      text: identitySafeFallback({ ...identity, family: allowedFamily, familyState: identity.familyState || FAMILY_STATE.WORKING }),
      changed: true,
      reason: 'foreign-family',
    };
  }
  if (operational && replyUsesForeignDiscriminator(text, allowedFamily, opts.discriminatorTable)) {
    return {
      text: identitySafeFallback({ ...identity, family: allowedFamily, familyState: identity.familyState || FAMILY_STATE.WORKING }),
      changed: true,
      reason: 'foreign-discriminator',
    };
  }
  if (operational && replyUsesForeignFamilyInstruction(text, allowedFamily)) {
    const stripped = stripForeignInstructionSentences(text, allowedFamily);
    if (stripped && stripped.length >= 24) {
      return { text: stripped, changed: true, reason: 'family-incompatible' };
    }
    return {
      text: familyCompatibleFallback({
        ...identity,
        family: allowedFamily,
        familyState: identity.familyState || FAMILY_STATE.WORKING,
      }, text),
      changed: true,
      reason: 'family-incompatible',
    };
  }
  if (!operational) {
    const named = familiesNamedInReply(text);
    if (named.length) {
      return {
        text: identitySafeFallback(identity),
        changed: true,
        reason: 'family-invented',
      };
    }
    const specific = familySpecificCatalogueTermsIn(text);
    if (specific.length) {
      const stripped = stripFamilySpecificCatalogueSentences(text);
      if (stripped && stripped.length >= 24 && familySpecificCatalogueTermsIn(stripped).length === 0) {
        return { text: stripped, changed: true, reason: 'family-instruction-unlocated' };
      }
      return {
        text: identitySafeFallback(identity),
        changed: true,
        reason: 'family-instruction-unlocated',
      };
    }
  }
  const gasForbidden = !fuelPermitsGas(identity.fuel);
  if (gasForbidden && GAS_DIAGNOSIS_RE.test(text)) {
    return {
      text: identitySafeFallback(identity),
      changed: true,
      reason: 'gas-without-fuel',
    };
  }
  return { text, changed: false, reason: null };
}

function identitySafeFallback(identity) {
  if (!hasOperationalFamily(identity)) {
    return 'I should not assume which appliance this is, or that it is fine to keep using, until the type is clear. What kind of appliance is it?';
  }
  if (identity.fuelConflict) {
    return 'Just to be sure I stay on the right path — is this a gas appliance or an electric one?';
  }
  const label = String(identity.family).replace(/-/g, ' ');
  const treating = identity.familyState === FAMILY_STATE.WORKING
    ? `I am working from the evidence that this is a ${label}`
    : `I am treating this as your ${label}`;
  if (!fuelPermitsGas(identity.fuel) && (identity.family === 'oven-cooker' || identity.family === 'tumble-dryer' || identity.family === 'hobs')) {
    return `${treating}. I will not assume it is a gas appliance. From what you have described, the next step is the heating/control path on that machine rather than a gas-ignition diagnosis. If it is actually a gas appliance, please say so.`;
  }
  return `${treating}. Could you describe what it is doing in a bit more detail so I can stay on that appliance?`;
}

function applyFuelFilter(docs, identity) {
  const list = docs || [];
  if (!identity || fuelPermitsGas(identity.fuel)) return list;
  return list.filter((d) => !d || !GAS_EXCLUSIVE_FAULTS.has(d.faultId));
}

function familyScopeIsStrict(familyEstablishedOrState) {
  return familyEstablishedOrState === true
    || familyEstablishedOrState === FAMILY_STATE.ESTABLISHED
    || familyEstablishedOrState === FAMILY_STATE.WORKING;
}

module.exports = {
  FAMILY_STATE,
  EXPLICIT_FAMILY_CUES,
  ELECTRIC_ONLY_FAMILIES,
  GAS_EXCLUSIVE_FAULTS,
  canonFamily,
  customerOnlyText,
  namedFamiliesIn,
  identityNamedFamilies,
  hydrateConversationRoles,
  isShortFollowUp,
  looksLikeModelToken,
  extractModelTokenFromText,
  familyFromCatalogueCategory,
  uniqueFamilyForMakeAndCode,
  inferWorkingIdentity,
  hasOperationalFamily,
  nextFamilyIdentity,
  resolveConversationIdentity,
  questionAsksDifferentFamily,
  discriminatorQuestion,
  faultAllowedForIdentity,
  lockIdentityOnIntent,
  formatIdentityLock,
  constrainReplyToIdentity,
  constrainIntentToFamily,
  familiesNamedInReply,
  identitySafeFallback,
  applyFuelFilter,
  lastAssistantText,
  replyUsesForeignDiscriminator,
  replyUsesForeignFamilyInstruction,
  foreignFamilyTermsIn,
  familySpecificCatalogueTermsIn,
  familyScopeIsStrict,
};
