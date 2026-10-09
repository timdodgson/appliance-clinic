/**
 * Presentation: customer claims and theories, hazard provenance, remote-action boundaries, part readiness, the
 * presentation grain, replacement-language calibration, and the trusted customer-evidence block.
 */
const { productIdentitySufficient, customerFacingNextCheck } = require('./conversation.js');
const { applianceKey, phraseRefersToComponent } = require('./catalogue.js');
const { FINDING_KINDS, COMPONENT_MENTION, REMOTE_ACTION } = require('./intent-vocabulary.js');
const { evidenceDecisive } = require('./evidence.js');
const { classifySafetyStop } = require('./safety.js');

// ---------------------------------------------------------------------------
// Presentation grain, remote-action class, evidence provenance (Pass 2)
// Deterministic contracts: diagnosis grain controls catalogue presentation.
// Semantic diagnosis still belongs to UNDERSTAND/COMPOSE; these helpers only
// decide how far a retrieved candidate may surface to the customer.
// ---------------------------------------------------------------------------

function classifyCustomerClaim(phrase) {
  const p = String(phrase || '').trim();
  if (!p) return 'empty';
  if (/\b(i think|i suspect|i reckon|probably|must be|bet it'?s|someone said|they said (?:it'?s|its))\b/i.test(p)) {
    return 'theory';
  }
  if (/-?\d+(?:\.\d+)?\s*(?:°|degrees?\s*)c\b/i.test(p) || /\bmeasured\b/i.test(p)) return 'measured';
  return 'observation';
}

function refineCustomerTheories(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  const theories = Array.isArray(intent.customerTheories) ? intent.customerTheories.slice() : [];
  const symptoms = [];
  for (const s of intent.reportedSymptoms || []) {
    if (classifyCustomerClaim(s) === 'theory') theories.push(s);
    else symptoms.push(s);
  }
  const seen = new Set();
  intent.customerTheories = theories.filter((t) => {
    const k = String(t).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);
  intent.reportedSymptoms = symptoms;
  return intent;
}

function hazardProvenance({ queryText, safetyStop } = {}) {
  if (!safetyStop) return 'none';
  const classified = classifySafetyStop(queryText);
  if (classified && classified.category === safetyStop) return 'observed';
  return 'inferred';
}

function assertedHazardIsObserved(kind, queryText) {
  const classified = classifySafetyStop(queryText);
  if (!classified) return false;
  if (kind === 'burning') return classified.category === 'burning';
  if (kind === 'gas') return classified.category === 'gas';
  if (kind === 'shock') return classified.category === 'shock';
  if (kind === 'arcing') return classified.category === 'arcing';
  return false;
}

function applianceSafetyFamily(applianceType, queryText) {
  const t = `${applianceType || ''} ${queryText || ''}`.toLowerCase();
  const k = applianceKey(applianceType) || '';
  if (k === 'microwave' || /\bmicrowave\b/.test(t)) return 'high-voltage';
  if (/\bgas\b|\blpg\b/.test(t)) return 'fuel-burning';
  if (k === 'fridge-freezer' || /\bfridge|\bfreezer|\brefrigerat/.test(t)) return 'sealed-refrigeration';
  return 'general';
}

function classifyRemoteActionClass({ safetyStop, diagnoseStop, applianceType, queryText } = {}) {
  if (safetyStop === 'gas' || safetyStop === 'shock' || safetyStop === 'burning' || safetyStop === 'electrical') {
    return REMOTE_ACTION.STOP_USE;
  }
  if (diagnoseStop === 'arcing' || diagnoseStop === 'hv-service') return REMOTE_ACTION.STOP_USE;
  if (diagnoseStop === 'hv-boundary') return REMOTE_ACTION.COMPETENT_PERSON;
  const family = applianceSafetyFamily(applianceType, queryText);
  if (family === 'fuel-burning' || family === 'high-voltage' || family === 'sealed-refrigeration') {
    return REMOTE_ACTION.CAUTION;
  }
  return REMOTE_ACTION.CUSTOMER_SAFE;
}

function remoteActionBoundary(actionClass, applianceType, queryText) {
  const family = applianceSafetyFamily(applianceType, queryText);
  const cls = actionClass || REMOTE_ACTION.CUSTOMER_SAFE;
  const inScope = [
    'user-accessible observation',
    'cleaning or clearing parts the customer can reach without tools or panel removal',
    'settings, programmes, waiting or defrost observation',
    'supplying make, model or a rating-plate photo',
  ];
  const outOfScope = [
    'removing panels or covers',
    'live electrical testing or work on the mains',
    'inspecting, testing, probing or metering internal electrical components — heating elements, thermostats, thermal cut-outs, PCBs/control boards, wiring or terminals — including just looking for breaks/damage, as these sit behind panels or expose electrical parts',
    'defeating safety devices',
    'microwave high-voltage internals',
    'sealed refrigeration / refrigerant work',
    'accessing fuel/gas valves, ignition modules or flame-failure devices',
    'holding controls to test a safety device',
    'instructing replacement of gas or sealed-system components',
  ];
  let competentPerson = 'a qualified appliance engineer';
  if (family === 'fuel-burning') competentPerson = 'a Gas Safe registered engineer';
  if (family === 'high-voltage') competentPerson = 'a qualified microwave / appliance engineer';
  if (family === 'sealed-refrigeration') competentPerson = 'a refrigeration-competent engineer';
  return { class: cls, family, inScope, outOfScope, competentPerson };
}

function evidenceJustifiesComponent(fault, intent) {
  if (!fault) return false;
  if (fault.via === 'errorCode' || fault.via === 'evidence-commit') return true;
  return evidenceDecisive(fault.node, (intent && intent.facts) || []);
}

/** UNDERSTAND names, else the grounded node's catalogue components. Never invents a part. */
function namedOrCatalogueComponents(intent, fault) {
  const named = (intent && Array.isArray(intent.candidateComponents))
    ? intent.candidateComponents.filter(Boolean) : [];
  if (named.length) return named;
  const curated = (fault && fault.node && Array.isArray(fault.node.components))
    ? fault.node.components.filter(Boolean) : [];
  return curated;
}

function effectiveFindingKind(intent, fault, committedFinding) {
  const raw = intent && FINDING_KINDS.includes(intent.primaryFindingKind) ? intent.primaryFindingKind : 'unknown';
  if (intent && intent.userIntent === 'PART_REQUEST') return 'component';
  if (fault && fault.node && fault.node.outcome === 'ADVICE_ONLY') {
    return raw === 'component' ? 'condition' : (raw === 'unknown' ? 'condition' : raw);
  }
  if (raw === 'component' && intent.userIntent !== 'PART_REQUEST' && !evidenceJustifiesComponent(fault, intent)) {
    return 'subsystem';
  }
  if (raw !== 'unknown') return raw;
  if (evidenceJustifiesComponent(fault, intent) && committedFinding && (intent.candidateComponents || []).length) {
    return 'component';
  }
  return 'subsystem';
}

/**
 * Jev owns the semantic transition from diagnosis to replacement/purchase.
 * This clears stale diagnostic next-actions only when the customer has either
 * supplied direct replacement evidence or explicitly asked to source the part,
 * and we already hold enough product identity plus a grounded fault.
 * Safety/professional-only gates remain authoritative elsewhere.
 */
function applyPartReadinessProgression(intent, fault) {
  if (!intent || !fault) return intent;
  const readiness = intent._partReadiness;
  if (readiness !== 'replacement_evidence' && readiness !== 'explicit_purchase') return intent;
  if (!productIdentitySufficient(intent)) return intent;
  const comps = namedOrCatalogueComponents(intent, fault);
  if (!comps.length) return intent;

  intent.candidateComponents = [...new Set([...(intent.candidateComponents || []), ...comps])];
  intent.needMoreInfo = false;
  intent.clarifyingQuestion = null;
  intent.nextBestCheck = null;
  intent.nextCheckCustomerSafe = false;
  intent.furtherGenericCheckJustified = false;
  intent._pendingDiscriminator = null;
  intent._materialAmbiguity = null;
  intent._observationAmbiguity = null;
  intent._areaDiscriminator = null;
  intent._discriminatorJustAnswered = null;
  intent._nextAction = readiness === 'explicit_purchase' ? 'part_request' : 'replacement_evidence';
  if (readiness === 'explicit_purchase') intent.userIntent = 'PART_REQUEST';
  return intent;
}

function remainingActionBlocksPurchase(intent) {
  if (!intent) return false;
  if (intent._pendingDiscriminator || intent._unconfirmedIdentity) return true;
  if (intent._nextAction === 'discriminator' || intent._nextAction === 'check'
      || intent._nextAction === 'identification' || intent._nextAction === 'advice'
      || intent._nextAction === 'advice_then_identity') {
    return true;
  }
  if (intent.nextCheckCustomerSafe === true || intent.furtherGenericCheckJustified === true) return true;
  if (intent.needMoreInfo === true && intent.nextBestCheck) return true;
  return false;
}

function namedPartAlreadyReplaced(intent) {
  if (!intent) return false;
  const replaced = Array.isArray(intent.alreadyReplaced) ? intent.alreadyReplaced : [];
  const named = Array.isArray(intent.candidateComponents) ? intent.candidateComponents : [];
  if (!replaced.length || !named.length) return false;
  return named.some((c) => replaced.some((p) => phraseRefersToComponent(p, c)));
}

function computePresentationGrain({
  intent, fault, committedFinding, safetyStop, diagnoseStop, remoteAction, outcome, queryText,
} = {}) {
  const none = { mention: COMPONENT_MENTION.NONE, purchaseAppropriate: false, committedComponent: false };
  const discuss = { mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false, committedComponent: false };
  if (safetyStop || outcome === 'SAFETY_STOP' || remoteAction === REMOTE_ACTION.STOP_USE
      || remoteAction === REMOTE_ACTION.COMPETENT_PERSON) return none;
  if (diagnoseStop) return none;
  // A useful customer-safe check or discriminator is still the current action: name a
  // hypothesis if needed, do not sell. Naming a part as a question ("pressure sensor?")
  // does not skip advice-before-replacement.
  if (remainingActionBlocksPurchase(intent)) return discuss;
  if (intent && (intent._materialAmbiguity || intent._observationAmbiguity
      || intent._discriminatorJustAnswered || intent._areaDiscriminator)) {
    return none;
  }
  if (namedPartAlreadyReplaced(intent)) return discuss;
  if (intent && intent.userIntent === 'PART_REQUEST') {
    return { mention: COMPONENT_MENTION.PURCHASE, purchaseAppropriate: true, committedComponent: true };
  }
  // An unanswered diagnostic discriminator still in play: name the hypothesis, do not sell.
  // An unconfirmed rating-plate read is identity, not diagnostic confirmation.
  if (intent && (intent._pendingDiscriminator || intent._nextAction === 'discriminator'
      || intent._unconfirmedIdentity)) {
    return discuss;
  }
  if (outcome === 'ADVICE_ONLY' || (fault && fault.node && fault.node.outcome === 'ADVICE_ONLY')
      || (intent && intent.normalBehaviour)) {
    return none;
  }
  if (intent && intent._materialAmbiguity) return none;
  if (intent && intent._observationAmbiguity) return none;
  if (intent && intent._discriminatorJustAnswered) return none;
  if (intent && intent._areaDiscriminator) return none;

  const kind = effectiveFindingKind(intent, fault, committedFinding);
  const decisive = evidenceJustifiesComponent(fault, intent);
  const family = applianceSafetyFamily(intent && intent.applianceType, queryText);
  const comps = namedOrCatalogueComponents(intent, fault);
  const committedComponent = Boolean(
    committedFinding && kind === 'component' && decisive && (intent.candidateComponents || []).length,
  );

  if (kind !== 'component' || !committedFinding) {
    // A subsystem finding can still attach a candidate once identity is known and the
    // catalogue evidence is decisive. Diagnostic language stays a hypothesis
    // (committedComponent false); unanswered discriminators already returned above.
    // UNDERSTAND is instructed to leave candidateComponents empty for subsystem
    // findings — use the grounded node's catalogue list, not an LLM shopping list.
    if (intent && intent.model && decisive && committedFinding
        && kind === 'subsystem' && comps.length) {
      return { mention: COMPONENT_MENTION.PURCHASE, purchaseAppropriate: true, committedComponent: false };
    }
    return none;
  }

  if (family === 'fuel-burning') {
    return {
      mention: committedComponent ? COMPONENT_MENTION.DISCUSS : COMPONENT_MENTION.NONE,
      purchaseAppropriate: false,
      committedComponent,
    };
  }

  if (!decisive) {
    return { mention: COMPONENT_MENTION.DISCUSS, purchaseAppropriate: false, committedComponent: false };
  }

  return {
    mention: COMPONENT_MENTION.PURCHASE,
    purchaseAppropriate: true,
    committedComponent: true,
  };
}

function presentableCandidateComponents(intentComps, curated, presentation) {
  const mention = (presentation && presentation.mention) || COMPONENT_MENTION.NONE;
  const base = Array.isArray(intentComps) ? intentComps.filter(Boolean) : [];
  if (mention === COMPONENT_MENTION.NONE) return [];
  if (mention === COMPONENT_MENTION.DISCUSS) return base.slice(0, 2);
  const out = base.slice();
  const normc = (s) => String(s).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const have = new Set(out.map(normc));
  for (const c of curated || []) {
    const key = normc(c);
    if (key && !have.has(key)) { out.push(c); have.add(key); }
    if (out.length >= 8) break;
  }
  return out;
}

const LIKELY_FIT_TRAILER = 'This is a likely match — please verify it before ordering.';

function catalogueFitIsModelConfirmed(shownParts) {
  const rows = Array.isArray(shownParts) ? shownParts.filter((p) => p && p.partNo) : [];
  if (!rows.length) return false;
  return rows.every((p) => p._brandOnly !== true);
}

const REPLACEMENT_OVERCLAIM = /\b(?:correct replacement parts?|exact replacement parts?|compatible replacement parts?|(?:a |the )?compatible parts?|confirmed fit|(?:the |an )?exact parts?|correct parts? for your(?: specific)? machine)\b/i;

/**
 * Customer-facing replacement/compatibility language is gated by structured
 * catalogue-fit evidence — not by diagnostic confidence. Before a model-confirmed
 * catalogue row exists, rewrite over-claiming fit noun phrases. Diagnostic
 * wording (likely cause / leading possibility) is left alone.
 */
function constrainReplacementLanguage(reply, shownParts) {
  if (!reply) return reply;
  if (catalogueFitIsModelConfirmed(shownParts)) return reply;
  let out = String(reply);
  const subs = [
    [/identify the (?:correct|exact) replacement part(?:s)?(?: for your(?: specific)? machine)?/gi, 'check whether a suitable replacement is available'],
    [/identify the exact part(?:s)?/gi, 'check whether a suitable replacement is available'],
    [/(?:match|find) the (?:correct|exact) replacement part(?:s)?/gi, 'check whether a suitable replacement is available'],
    [/match the exact part(?:s)?/gi, 'check whether a suitable replacement is available'],
    [/find the exact part(?:s)?/gi, 'check whether a suitable replacement is available'],
    [/the correct replacement part(?:s)?(?: for your(?: specific)? machine)?/gi, 'whether a suitable replacement is available'],
    [/a correct replacement part(?:s)?(?: for your(?: specific)? machine)?/gi, 'a suitable replacement'],
    [/correct replacement part(?:s)?(?: for your(?: specific)? machine)?/gi, 'a suitable replacement'],
    [/the exact replacement part(?:s)?(?: for your(?: specific)? machine)?/gi, 'a suitable replacement'],
    [/an? exact replacement part(?:s)?/gi, 'a suitable replacement'],
    [/exact replacement part(?:s)?/gi, 'suitable replacement'],
    [/a compatible replacement part(?:s)?/gi, 'a suitable replacement'],
    [/the compatible replacement part(?:s)?/gi, 'a suitable replacement'],
    [/compatible replacement part(?:s)?/gi, 'suitable replacement'],
    [/a compatible part(?:s)?/gi, 'a suitable replacement'],
    [/the compatible part(?:s)?/gi, 'a suitable replacement'],
    [/\bcompatible parts?\b/gi, 'suitable replacement'],
    [/\bconfirmed fit\b/gi, 'likely fit'],
    [/the correct part(?:s)? for your(?: specific)? machine/gi, 'a suitable replacement once we have the model'],
    [/correct part(?:s)? for your(?: specific)? machine/gi, 'a suitable replacement once we have the model'],
    [/the exact part(?:s)?/gi, 'a suitable replacement'],
    [/\ban exact part\b/gi, 'a suitable replacement'],
    [/\bexact parts?\b/gi, 'a suitable replacement'],
  ];
  for (const [re, to] of subs) out = out.replace(re, to);
  out = out.replace(/\bthe whether a suitable replacement is available\b/gi, 'whether a suitable replacement is available');
  out = out.replace(/\ba whether a suitable replacement is available\b/gi, 'whether a suitable replacement is available');
  out = out.replace(/\s{2,}/g, ' ');
  return out;
}

function replacementLanguageOverclaimsFit(reply, shownParts) {
  if (catalogueFitIsModelConfirmed(shownParts)) return false;
  return REPLACEMENT_OVERCLAIM.test(String(reply || ''));
}

/**
 * Structured catalogue fit must control customer-facing certainty. When every
 * shown row is brand-family only, append a likely-fit trailer unless the reply
 * already carries that calibration. Does not invent confirmed-fit status.
 */
function calibrateLikelyFitProse(reply, shownParts, presentation) {
  const text = String(reply || '').trim();
  if (!text) return reply;
  if (!presentation || !presentation.purchaseAppropriate) return reply;
  const rows = Array.isArray(shownParts) ? shownParts.filter((p) => p && p.partNo) : [];
  if (!rows.length) return reply;
  if (!rows.every((p) => p._brandOnly)) return reply;
  if (/\b(likely match|please verify|likely fit|please check)\b/i.test(text)) return reply;
  return `${text} ${LIKELY_FIT_TRAILER}`;
}

const FACT_EVIDENCE_LABEL = {
  heatPresent: 'heat was produced / load came out warm',
  noHeat: 'no useful heat / came out cold',
  overheatsThenCuts: 'it overheats or thermally cuts out',
  heatsAtAll: 'it does heat at least sometimes',
  fridgeOnlyWarm: 'fridge warm while freezer still cold/working',
  bothCompartmentsWarm: 'both fridge and freezer warm',
  heavyIce: 'heavy ice/frost on the evaporator panel',
  fanNotAudible: 'internal fan not heard running',
  fanAudible: 'internal fan can be heard running',
  ventsBlocked: 'internal vents blocked or packed',
  grindingNoise: 'harsh grinding/rumbling/scraping noise',
  humNoise: 'smooth hum or drone',
  waterRemaining: 'water left standing in the bottom',
  waterEntering: 'water starts coming into the machine',
  commandedDrain: 'drainage worked when commanded or cancelled (that condition only)',
  drainsNormally: 'it drains normally',
  singleZoneAffected: 'only one zone/function affected',
  allZonesAffected: 'all zones/functions affected',
  inductionHob: 'induction hob',
  gasHob: 'gas hob',
  ceramicHob: 'ceramic/electric hob',
  noPower: 'will not switch on',
  cutsOut: 'runs then cuts out',
  weakSuction: 'runs with weak suction',
  filterCleaned: 'an accessible filter was cleaned',
};

// Jev's typed "customer already completed this accessible check and found it clear" facts, mapped to
// a short checksReported label. The KEY is a Jev typed fact name (not a customer-prose keyword), so
// surfacing it as a completed check is consuming Jev's semantic decision, not re-parsing the text.
const CHECK_DONE_LABEL = {
  filterChecked: 'accessible pump filter/trap checked and clear',
  hoseChecked: 'drain hose checked and clear',
  impellerClear: 'pump/impeller area checked and clear',
  airflowChecked: 'airflow / vent / condenser path checked and clear',
};

function answeredRowClause(row, label) {
  const name = String(label || '').trim();
  if (!name) return '';
  if (row && row.value === 'FALSE') return `${name} did not happen`;
  if (row && row.value === 'TRUE') return name;
  return name;
}

function formatTrustedCustomerEvidence(intent) {
  if (!intent || typeof intent !== 'object') return '';
  const lines = [];
  const symptoms = Array.isArray(intent.reportedSymptoms) ? intent.reportedSymptoms.filter(Boolean) : [];
  if (symptoms.length) lines.push(`- Observed problems: ${symptoms.join('; ')}.`);
  const theories = Array.isArray(intent.customerTheories) ? intent.customerTheories.filter(Boolean) : [];
  if (theories.length) {
    lines.push(`- Customer theories (NOT observations — do not treat as established fact): ${theories.join('; ')}.`);
  }
  const facts = Array.isArray(intent.facts) ? intent.facts : [];
  const describe = (name) => FACT_EVIDENCE_LABEL[name] || name;
  const trues = facts.filter((f) => f && f.value === 'TRUE').map((f) => describe(f.name));
  const falses = facts.filter((f) => f && f.value === 'FALSE').map((f) => describe(f.name));
  if (trues.length) lines.push(`- Established as true: ${trues.join('; ')}.`);
  if (falses.length) lines.push(`- Established as false: ${falses.join('; ')}.`);
  const positive = Array.isArray(intent._positiveObservations)
    ? intent._positiveObservations.filter(Boolean) : [];
  if (positive.length) {
    lines.push(`- Observed as happening (do NOT rewrite as the opposite failure; this downranks a simple/complete failure of that function, and does not prove the whole control path healthy): ${positive.join(', ')}.`);
  }
  const proven = Array.isArray(intent.provenGood) ? intent.provenGood.filter(Boolean) : [];
  if (proven.length) {
    lines.push(`- Still working / argues against these as the shared cause (a DIFFERENT subsystem from the complaint): ${proven.join(', ')}.`);
  }
  const limited = Array.isArray(intent.conditionLimited) ? intent.conditionLimited.filter(Boolean) : [];
  if (limited.length) {
    lines.push(`- Observed to operate under some conditions (does NOT confirm healthy; do NOT name this as a failed component; complete/permanent failure of this path is less convincing; intermittent or condition-dependent failure remains plausible): ${limited.join(', ')}.`);
  }
  const replaced = Array.isArray(intent.alreadyReplaced) ? intent.alreadyReplaced.filter(Boolean) : [];
  if (replaced.length) {
    lines.push(`- CUSTOMER_FACT — Already replaced with no cure (down-rank repeating these; do not treat as impossible — installation, wiring, supply/control, wrong or defective replacement remain possible): ${replaced.join(', ')}.`);
  }
  const declined = Array.isArray(intent.declinedFacts) ? intent.declinedFacts.filter(Boolean) : [];
  if (declined.length) {
    lines.push(`- Customer could not answer (do not re-ask): ${declined.join(', ')}.`);
  }
  const checks = Array.isArray(intent.checksReported) ? intent.checksReported.filter(Boolean) : [];
  if (checks.length) {
    lines.push(`- Checks already reported (do not recommend these again; scoped, not the whole path): ${checks.join('; ')}.`);
  }
  if (intent.newEvidenceThisTurn) {
    lines.push(`- New evidence this turn: ${intent.newEvidenceThisTurn}.`);
  }
  const interventions = Array.isArray(intent._interventionResults) ? intent._interventionResults.filter(Boolean) : [];
  if (interventions.length) {
    const bits = interventions.map((ir) => {
      const act = ir.action || 'prior action';
      if (ir.outcome === 'temporary') {
        return `${act} → temporary recovery then recurrence (do not prescribe the same action as the next diagnostic step; recurrence is evidence the underlying cause remains)`;
      }
      return `${act} → attempted (INTERVENTION_RESULT only — not proof the intended fault condition existed, and not proof it caused a later event)`;
    });
    lines.push(`- INTERVENTION_RESULT: ${bits.join('; ')}.`);
  }
  const nextCheck = customerFacingNextCheck(intent);
  if (nextCheck) lines.push(`- Next useful check: ${nextCheck}.`);
  if (intent.primaryFinding) {
    lines.push(`- Current diagnostic conclusion (calibrate to finding grain; not automatically a confirmed failed part): ${intent.primaryFinding}.`);
  }
  if (intent.primaryFindingKind && intent.primaryFindingKind !== 'unknown') {
    lines.push(`- Finding grain: ${intent.primaryFindingKind}.`);
  }
  return lines.join('\n');
}

module.exports = {
  classifyCustomerClaim, refineCustomerTheories, hazardProvenance, assertedHazardIsObserved,
  applianceSafetyFamily, classifyRemoteActionClass, remoteActionBoundary, evidenceJustifiesComponent,
  namedOrCatalogueComponents, effectiveFindingKind, applyPartReadinessProgression, remainingActionBlocksPurchase,
  computePresentationGrain, presentableCandidateComponents, catalogueFitIsModelConfirmed,
  constrainReplacementLanguage, replacementLanguageOverclaimsFit, calibrateLikelyFitProse, FACT_EVIDENCE_LABEL,
  CHECK_DONE_LABEL, answeredRowClause, formatTrustedCustomerEvidence,
};
