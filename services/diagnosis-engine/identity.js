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

const ELECTRIC_ONLY_FAMILIES = new Set([
  'microwave', 'vacuum', 'dishwasher', 'washing-machine', 'washer-dryer', 'fridge-freezer',
]);

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

module.exports = {
  FAMILY_STATE,
  nextFamilyIdentity,
  looksLikeModelToken,
  extractModelTokenFromText,
  resolveConversationIdentity,
};
