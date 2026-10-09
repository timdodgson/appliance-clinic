/**
 * Safety and normal behaviour: displayed-status identity, safety stops, unsafe intent, owner-check precautions,
 * and normal-behaviour matching.
 */
const { getNormalBehaviourRecords } = require('../retrieval');
const { productIdentitySufficient } = require('./conversation.js');
const { applianceKey } = require('./catalogue.js');

// ---------------------------------------------------------------------------
// PASS 2: COMPOSE
// ---------------------------------------------------------------------------

// Deterministic SAFETY gate — never left to the LLM's grounding mood. Scans the
// customer's own words for an emergency (a gas escape or an electric shock) and,
// if found, forces a SAFETY_STOP outcome (parts suppressed, safety-first reply)
// even if the model grounded the message to an ordinary part fault. Returns a
// category ('gas' | 'shock') or null.
const EVIDENCE_KIND = {
  CUSTOMER_FACT: 'CUSTOMER_FACT',
  CUSTOMER_OBSERVATION: 'CUSTOMER_OBSERVATION',
  INFERENCE: 'INFERENCE',
  RETRIEVED_KNOWLEDGE: 'RETRIEVED_KNOWLEDGE',
  SYSTEM_SAFETY_RULE: 'SYSTEM_SAFETY_RULE',
  HYPOTHESIS: 'HYPOTHESIS',
  INTERVENTION_RESULT: 'INTERVENTION_RESULT',
};

/**
 * A repeating display/status indication is not an electrical-arc flash.
 * "flashes E15", "the clock is flashing", "blue light flashing" are CUSTOMER_OBSERVATION
 * of a control state — they must not become a reported burning/overheating hazard.
 */
function isStatusIndicationFlash(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  if (/(clock|programmer|timer|display|colon|\bled\b|error|code|message).{0,32}flash/.test(t)) return true;
  if (/flash\w*.{0,32}(clock|programmer|timer|display|\bled\b|colon|error|code|message)/.test(t)) return true;
  if (/\bflash(?:es|ing|ed)\b/.test(t) && /\b(light|lights|beep(?:ing|s)?|display|clock|programmer|timer|error|code|message)\b/.test(t)) return true;
  // Verb "flashes/flashing" taking a short displayed token (code, status word).
  // Exclude prepositions so "flashing from the socket" stays an electrical flash EVENT.
  if (/\bflash(?:es|ing)\s+(?!from\b|at\b|out\b|of\b|in\b|on\b|near\b|inside\b|off\b|by\b|the\b|a\b|an\b|and\b|then\b)[a-z0-9][a-z0-9-]{0,12}\b/.test(t)) return true;
  return false;
}

/**
 * A short displayed status token (code or status word) the customer says is shown/flashing.
 * Not a fire flash, and not a manufacturer-specific meaning until identity exists.
 */
function extractDisplayedStatusToken(text) {
  const raw = String(text || '');
  const m = raw.match(
    /\bflash(?:es|ing)\s+["']?([A-Za-z][A-Za-z0-9-]{0,12})["']?/i,
  );
  if (!m) return null;
  const tok = m[1];
  if (/^(from|at|out|of|in|on|near|inside|off|by|the|a|an|and|then|up|down|is|was|been|still|now|again|red|blue|green|amber|light|lights|clock|time|error|code|message)$/i.test(tok)) {
    return null;
  }
  return tok.toUpperCase();
}

/**
 * A displayed code/status word cannot be given a manufacturer-specific meaning without
 * make AND appliance family. Retrieved knowledge about what that word "usually" means is
 * RETRIEVED_KNOWLEDGE, not a customer-grounded diagnosis.
 */
function displayedIndicationNeedsIdentity(intent, queryText) {
  if (!intent) return false;
  if (productIdentitySufficient(intent)) return false;
  const token = extractDisplayedStatusToken(queryText)
    || (intent.errorCode ? String(intent.errorCode).trim() : '');
  if (!token) return false;
  const named = applianceKey(intent.applianceType);
  if (intent.make && named) return false;
  return true;
}

function applyDisplayedIndicationIdentity(intent, queryText, metric) {
  if (!displayedIndicationNeedsIdentity(intent, queryText)) return intent;
  const token = extractDisplayedStatusToken(queryText);
  if (token && !intent.errorCode) {
    intent.errorCode = token;
    if (metric) metric.displayedStatusToken = token;
  }
  intent.needMoreInfo = true;
  intent.furtherGenericCheckJustified = false;
  intent.nextCheckCustomerSafe = false;
  intent._nextAction = 'identification';
  intent.faultId = null;
  intent.fault = null;
  intent.candidateComponents = [];
  const named = applianceKey(intent.applianceType);
  if (!named && !intent.make) {
    intent.nextBestCheck = 'Ask for make, appliance type, and the model or a rating-plate photo so the displayed indication can be interpreted.';
    if (!intent.clarifyingQuestion) {
      intent.clarifyingQuestion = 'What make is it, and which appliance (washing machine, dishwasher, oven, etc.)? The model is on the rating plate if you can see it.';
    }
  } else if (!named) {
    intent.nextBestCheck = 'Ask which kind of appliance this is, and the model or a rating-plate photo.';
    if (!intent.clarifyingQuestion) {
      intent.clarifyingQuestion = `Which kind of ${intent.make} appliance is this, and what is the model number on the rating plate?`;
    }
  } else if (!intent.make) {
    intent.nextBestCheck = 'Ask for the make and the model or a rating-plate photo.';
    if (!intent.clarifyingQuestion) {
      intent.clarifyingQuestion = 'What make is it, and what is the model number on the rating plate?';
    }
  }
  if (metric) metric.displayedIndicationNeedsIdentity = true;
  return intent;
}

/**
 * A flash EVENT of electrical discharge (noun "a flash", flash FROM/AT a supply point,
 * flashing inside a cavity) is a customer-reported fire/arc hazard.
 */
function isElectricalFlashEvent(text, { microwaveCtx = false, externalElecCtx = false } = {}) {
  const t = ` ${String(text || '').toLowerCase()} `;
  if (/\ba flash\b/.test(t)) return true;
  if (/\bflash(?:es|ed|ing)?\s+(?:from|at|out of)\b/.test(t)) return true;
  if (/\bflashing\b/.test(t) && (microwaveCtx || externalElecCtx || /\b(cavity|inside)\b/.test(t))) return true;
  return false;
}

/**
 * The customer is proposing physical access / disassembly (future/intent), not reporting that
 * they already did it. Isolation before that action is a SYSTEM_SAFETY_RULE — it is not
 * evidence that they reported burning, smoke, or a live fault.
 */
function proposedPhysicalAccess(text) {
  const raw = String(text || '');
  const t = ` ${raw.toLowerCase()} `;
  const alreadyDone = /\b(already (?:replaced|changed|fitted|removed|took|taken)|i (?:replaced|changed|fitted|removed|took)\b)/.test(t);
  if (alreadyDone) return false;
  const proposed = /\b(i(?:['’]?m| am) going to|i(?:['’]?ll| will)|about to|want to|going to|how do i|can i|should i)\b/.test(t);
  if (!proposed) return false;
  return /\b(take (?:the |it |this )?(?:[\w-]+[ -]){0,3}(?:out|off)\b|remove|open (?:it |the )?(?:up|cover|panel|casing)|strip (?:it )?down|pull (?:the )?\w+ (?:out|off)|unscrew|take apart|check the plug)\b/.test(t);
}

function detectSafetyStop(text) {
  const r = classifySafetyStop(text);
  return r ? r.category : null;
}

// Fine-grained deterministic safety classification. Returns { category, reason } or null.
//   category — one of the orchestrator-recognised ESCALATING values ('gas' | 'shock' | 'burning').
//              We deliberately reuse these proven values (rather than inventing new strings the
//              out-of-repo orchestrator might not whitelist) so escalation is guaranteed and is
//              identical for LOCAL/LOCAL, FRONTIER/LOCAL, LOCAL/FRONTIER and FRONTIER/FRONTIER:
//              the decision is made HERE, deterministically, before any compose model runs.
//   reason   — the specific hazard ('gas-smell' | 'gas-escape' | 'electric-shock' |
//              'electrical-water' | 'burning'), recorded on the metric for observability.
function classifySafetyStop(text, appliance = null) {
  const t = ` ${String(text || '').toLowerCase()} `;
  // (A) GAS ESCAPE. Require the word "gas" together with a credible escape cue — a smell/odour, a
  // leak, OR an audible escape (hissing / escaping). "gas oven won't heat" and "gas hob clicks but
  // won't light" have NO escape cue and are NOT emergencies; "I can hear gas hissing" and "smell of
  // gas" ARE. `hiss`/`escap` only ever trigger in the presence of the word "gas", so a hissing
  // washing machine (no gas) never trips this.
  if ((/\bgas\b/.test(t) && /(smell|smelt|leak|odou?r|hiss|escap)/.test(t)) || /smell(s|t)? of gas|gas leak|escaping gas/.test(t)) {
    const audibleEscape = /(hiss|escap)/.test(t) && !/(smell|smelt|leak|odou?r)/.test(t);
    return { category: 'gas', reason: audibleEscape ? 'gas-escape' : 'gas-smell' };
  }
  // (B) ELECTRIC SHOCK from the appliance. Cover the natural TENSES/phrasings a customer uses to
  // report a shock — present ("it gives me a shock"), PAST ("it gave me a shock", "I got a shock",
  // "it's shocked me"), and UK idiom ("a belt off it"). A shock is a zero-tolerance electrocution
  // hazard, so tense must never gate the stop. The verb+shock window is short so it stays a genuine
  // shock report (not "shock absorber" / "in shock"). Generic phrasing coverage; not journey-specific.
  if (/(electric shock|(?:gave|give|gives|giving|got|get|gets|getting|had|have|has|felt|feel|feels|received)\s+(?:me\s+|myself\s+)?(?:an?\s+)?(?:electric\s+|little\s+|slight\s+|nasty\s+|small\s+)?shock|shock(?:ed|s)?\s+me|been\s+shocked|got\s+shocked|shock(?:ed)?\s+off\s+(?:it|the)|shock\s+(?:off|from)\s+(?:it|the)|getting shocks?|shock off it|tingl\w+ when|belt (?:of|off) (?:electricity|it|the))/.test(t)) {
    return { category: 'shock', reason: 'electric-shock' };
  }
  // (C) ELECTRICITY + WATER in credible contact/proximity — a high-consequence electrocution hazard
  // where waiting for a probabilistic interpretation is inappropriate. Requires ALL THREE of:
  //   1. a WATER token (water / leak / flood / dripping / wet / damp / soaked)
  //   2. an ELECTRICAL-SUPPLY token (plug / socket / mains / consumer unit / fuse box / wiring …)
  //   3. a CONTACT/PROXIMITY/WETNESS cue (near / onto / into / running down / dripping / wet …)
  // so ordinary "water left in the drum", "water in the sump", "condensation inside", "not filling"
  // (no electrical-supply token) and "the plug won't go into the socket" (no water) do NOT trip it,
  // while "water is getting near the plug socket" and "the plug is wet" correctly escalate. Mapped to
  // 'shock' (an electrical hazard) so it reuses the proven electrical-hazard escalation + messaging.
  const hasWater = /(water|leak|leaking|flood|flooding|dripping|wet|damp|soaked|soaking)/.test(t);
  const hasElecSupply = /(plug|socket|mains|outlet|electrics|electrical (?:supply|connection|outlet|box)|consumer unit|fuse (?:box|board)|wall socket|power point|wiring|live wire|terminal block|\bcable\b)/.test(t);
  // Water MOVING TOWARD / reaching the electrics — directional proximity only (NOT bare "into", which
  // matches innocuous phrasing like "plugged into the mains").
  const waterReaching = /(near|nearby|onto|reaching|reaches|getting (?:to|near|into)|running (?:down|into)|dripping (?:on|onto|into|down)|pooling|close to|next to|splash|leak(?:ing|s|ed)? (?:onto|into|near|down|towards?|by))/.test(t);
  // An electrical-supply node described as WET (either word order, within a short window) — e.g.
  // "the plug is wet", "wet socket", "water in the fuse box".
  const elecWet = /(?:plug|socket|mains|outlet|wall socket|power point|wiring|\bcable\b|connection|fuse (?:box|board)|consumer unit)[^.]{0,25}?(?:wet|soaked|damp|drenched|water)|(?:wet|soaked|damp|drenched|water)[^.]{0,25}?(?:plug|socket|mains|outlet|wall socket|power point|wiring|\bcable\b|fuse (?:box|board)|consumer unit)/.test(t);
  if ((hasWater && hasElecSupply && waterReaching) || elecWet) {
    return { category: 'shock', reason: 'electrical-water' };
  }
  // (C2) HOUSEHOLD ELECTRICAL TRIP (RCD / breaker / consumer unit / "the electrics"). This is a
  // live-supply earth/overload trip — STOP_USE. A thermal fuse that has blown is a component
  // failure, not a household trip. "Cuts out" without electrics/RCD/breaker language is a
  // functional stop, not a supply trip. Scraping/noise alone never matches.
  if (!/\bthermal\s+fuse\b/.test(t)) {
    const supplyTrip = (
      /\b(?:trips?|tripped|tripping|knock(?:s|ing|ed)?\s+(?:the\s+)?electrics?\s+out|knocks?\s+(?:the\s+)?(?:power|electric)s?\s+(?:out|off))\b/.test(t)
      && /\b(?:electrics?|electric|rcd|rcbo|mcb|breaker|fuse\s*box|consumer\s+unit|house(?:hold)?\s+(?:power|electrics?))\b/.test(t)
    ) || /\b(?:rcd|rcbo|breaker|mcb)\s+trips?\b/.test(t)
      || /\btrips?\s+(?:the\s+)?(?:rcd|rcbo|breaker|mcb|fuse\s*box|electrics?)\b/.test(t)
      || /\btripped\s+(?:the\s+)?(?:rcd|rcbo|breaker|mcb|fuse\s*box|electrics?|house(?:hold)?\s+(?:power|electrics?))\b/.test(t);
    if (supplyTrip) {
      return { category: 'electrical', reason: 'supply-trip' };
    }
  }
  // (D) MICROWAVE CAVITY ARCING/SPARKING — a STOP-USE hazard that is nonetheless SAFELY DIAGNOSABLE.
  // Distinct from a hard fire/smoke stop: the customer must stop using it, but the cause is almost
  // always something we can explain safely (metal/foil in the cavity, a dirty/burnt waveguide cover,
  // food/carbon deposits, or chipped internal paint) with NON-INVASIVE visual checks — no casing
  // removal, no high-voltage access. Returned as its own tier ('STOP_USE_DIAGNOSE') so it stays
  // SEPARATE from the hard stops (gas/shock/burning-smell/smoke), which still suppress diagnosis.
  // Tightly scoped: a spark/arc/flash cue in a MICROWAVE context, with NO harder-fire cue
  // (smoke/flames/melting/scorching/burning material or smell) and NO external mains/socket/wiring
  // context (sparks at a plug/socket/cable stay a hard electrical/fire stop, handled below).
  const microwaveCtx = /\bmicrowave\b/.test(t) || appliance === 'microwave';
  // A spark/arc is a FIRE cue only when it is a genuine fire/electrical-arc hazard — not when it is
  // gas/hob/burner IGNITION sparking (the intended spark at an electrode, including uncommanded
  // clicking). Absence-of-ignition ("won't spark") is also not a fire. Microwave cavity arcing is
  // handled above as STOP-USE-DIAGNOSE. Sparks at a plug/socket/mains cable remain a hard stop.
  const sparkNegated = /\b(?:won'?t|wont|will not|does ?n'?t|doesn'?t|do not|not|no|never|without|lost|lacks?|lacking|missing|needs?|isn'?t|hasn'?t|no longer)\s+(?:a\s+|any\s+|the\s+)?spark(?:s|ing|ed)?\b/.test(t);
  // Melting is a fire/electrical cue only when the thing melting is electrical material — a melted
  // drive belt / gasket is mechanical wear, not a reported burning smell.
  const meltingElectrical = /(?:melt(?:s|ed|ing)?\s+(?:the\s+)?(?:wire|wiring|plastic|rubber|cable|insulation|plug|socket)|(?:wire|wiring|plastic|rubber|cable|insulation).{0,20}melt)/.test(t);
  const harderFireCue = /(smoke|smoking|flames?|on fire|catch(?:es|ing)? fire|scorch|burning (?:wire|wiring|plastic|rubber|cable|insulation|smell)|hot plastic|electrical burning|burning electrical|smells? electrical)/.test(t)
    || meltingElectrical;
  const externalElecCtx = /(plug|socket|wall socket|power point|\bmains\b|outlet|fuse (?:box|board)|consumer unit|wiring|\bcable\b|live wire|terminal)/.test(t);
  // Spark/arc, or a flash EVENT at a cavity/plug/socket. A flashing CLOCK / PROGRAMMER /
  // DISPLAY / LED / error-light / displayed token is a control-state observation, not a fire
  // flash. Treating "flashes" as a spark invented a customer-reported burning/overheating
  // hazard and aborted diagnosis. Retrieval mentioning fire risk is also not this cue —
  // this detector reads only the customer's words.
  const sparkWord = /(\bspark(?:s|ing|ed)?\b|\barc\b|arcs|arcing|arced)/.test(t);
  const statusIndicationFlash = isStatusIndicationFlash(t);
  const electricalFlashEvent = isElectricalFlashEvent(t, { microwaveCtx, externalElecCtx });
  const flashAsFire = electricalFlashEvent && !statusIndicationFlash;
  const sparkCue = !sparkNegated && (sparkWord || flashAsFire);
  if (microwaveCtx && sparkCue && !harderFireCue && !externalElecCtx) {
    return { category: 'arcing', reason: 'microwave-arcing', tier: 'STOP_USE_DIAGNOSE' };
  }
  // Burning / overheating ELECTRICAL smell — a family-independent fire/shock cue that must stop use
  // even when the appliance family has no bespoke safety card (e.g. vacuum). Deliberately EXCLUDES
  // ordinary cooking smells (burnt food/toast) and the harmless first-use "burning-in" smell of a
  // new oven/element, which are not electrical faults.
  const foodOrNewCtx = /\b(food|toast|dinner|meal|cooking|baking|roast|burnt on|burnt-on|first time|first use|brand new|new oven|when new|burning in|burning-in)\b/.test(t);
  // Gas/hob/burner ignition sparking is an IGNITION observation, not a fire report, unless a harder
  // fire cue or sparks at the plug/socket/mains are also present. Uncommanded electrode clicking
  // must not be rewritten as a burning/hot-plastic smell.
  const ignitionSparkCtx = sparkCue && !externalElecCtx && !harderFireCue
    && (/\b(gas|hob|burner|ignit(?:e|ion|er)|cooktop)\b/.test(t) || appliance === 'hobs' || appliance === 'hob');
  const sparkAsFire = sparkCue && !ignitionSparkCtx;
  // STRONG fire / electrical-overheat cues — a credible fire/shock hazard that ALWAYS forces a stop
  // (smoke, plug/socket sparks, scorching, melting wiring/plastic). Ignition sparking on a
  // gas hob is NOT in this set. Status-indication flashing is not in this set.
  const strongBurn = sparkAsFire || meltingElectrical || /(electrical burning|burning electrical|smells? electrical|burning (?:wire|wiring|plastic|rubber|cable|insulation)|wiring burning|hot plastic smell|smoke|smoking|scorch)/.test(t);
  const burningCue = /(burning|burnt|acrid|hot plastic|melting|scorch)/.test(t)
    && /(smell|smells|smelt|smelling|odou?r|fumes|melting|scorch)/.test(t);
  // TUMBLE-DRYER OVERHEATING is a distinct, well-understood MAINTENANCE-SAFETY scenario: a dryer that
  // "gets hot" with a plain burning-ish smell is almost always restricted airflow / lint / a blocked
  // filter or condenser. The tumble-dryer:overheating knowledge node OWNS this — it delivers the
  // fire-risk advisory AND tells the customer to stop and unplug if it smells of burning. So a plain
  // hot/burning DRYER smell must NOT be force-escalated by this deterministic detector over that
  // richer node; a genuine fire cue (strongBurn above) still stops regardless. This is a principled
  // family-level distinction (A: dryer overheating/airflow/lint maintenance) vs (B: burning/smoke/
  // scorching/electrical fire) — not phrase-matching, and it does NOT weaken burning-smell protection
  // for other families (e.g. a vacuum burning smell still stops).
  const dryerOverheatCtx = /(tumble[\s-]?dry|\bdryer\b)/.test(t)
    && /(hot|overheat|warm|too hot|smell(?:s|ing)?(?: of| like)? burning|burning smell)/.test(t);
  if (strongBurn) return { category: 'burning', reason: 'burning' };
  if (burningCue && !foodOrNewCtx && !dryerOverheatCtx) return { category: 'burning', reason: 'burning' };
  return null;
}

// Detect a request to PERFORM a dangerous ACTION (distinct from REPORTING a hazard). The customer is
// asking HOW to do something unsafe: bypass/defeat a safety device, test/probe LIVE parts, work on it
// while plugged in/powered, keep resetting the trip to see what happens, discharge a capacitor,
// re-gas/recharge a sealed refrigeration system, or hunt a gas leak with a flame. Family-independent,
// conservative (requires an explicit unsafe action phrasing), and used only to attach an ACTIVE
// WARNING — never to provide the action. Returns true/false.
function stripOutOfScopeElectricalTests(reply) {
  const src = String(reply || '');
  const cue = /\b(?:insulation[- ]?(?:resistance|tests?|testing)|megger|live[- ]?(?:voltage|electrical)?\s*test(?:ing)?|live probing)\b/i;
  if (!cue.test(src)) return src;
  const cleaned = src
    .replace(/[^.!?\n]*\b(?:insulation[- ]?(?:resistance|tests?|testing)|megger|live[- ]?(?:voltage|electrical)?\s*test(?:ing)?|live probing)\b[^.!?\n]*[.!?]?/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || src;
}

// Defense-in-depth safety net (NOT the primary mechanism — the REMOTE ACTION BOUNDARY out-of-scope
// list + the COMPOSE "NO INTERNAL ELECTRICAL ACCESS" rule are). Removes an OWNER-DIRECTED imperative
// to open the appliance or inspect/test an internal electrical component (element/thermostat/thermal
// cut-out/PCB/wiring/terminal/coil). It is deliberately conservative: it only drops a sentence that
// pairs such a component with a hands-on verb AND is NOT already routed to an engineer, so
// engineer-routed advice ("a qualified engineer should test the element") is preserved. If stripping
// leaves no next action, an engineer-routing clause is appended so the reply still progresses.
function stripOwnerInternalElectricalInspection(reply) {
  const src = String(reply || '');
  if (!src.trim()) return src;
  // Internal electrical component + a hands-on access/test verb, OR explicit meter/measurement
  // procedure wording (continuity / resistance / multimeter / ohm / megger). We remove the WHOLE
  // sentence whether it is addressed to the owner OR attributed to an engineer: for the owner-facing
  // product, describing the test procedure at all is unnecessary and the judge treats "an engineer
  // can test continuity with a multimeter" as owner-facing electrical-test detail. The customer only
  // needs the referral, not the method.
  const comp = /\b(heating element|element|thermostat|thermal (?:cut[- ]?out|fuse)|pcb|control board|main board|circuit board|wiring|terminals?|heater element|\bcoil\b|windings?)\b/i;
  const accessVerb = /\b(inspect|examine|look (?:at|for|inside|behind)|open up|take (?:the )?(?:back|rear|panel|cover) off|remove (?:the )?(?:back|rear|panel|cover))\b/i;
  const meterProc = /\b(continuity|resistance|multimeter|multi-meter|ohm(?:s|meter)?|megger|insulation[- ]?(?:test|resistance)|voltage test|test (?:the )?(?:element|thermostat|wiring|terminals?|coil|windings?)|measure (?:the )?(?:element|thermostat|resistance|continuity|voltage))\b/i;
  const sentences = src.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  let removed = false;
  const kept = sentences.filter((s) => {
    const hit = meterProc.test(s) || (comp.test(s) && accessVerb.test(s));
    if (hit) { removed = true; return false; }
    return true;
  });
  if (!removed) return src;
  // SEMANTIC REPLACEMENT (not surgical fragment deletion): rebuild from only the clean kept
  // sentences, drop any that are now grammatically broken fragments, and always finish with a single
  // clean engineer-referral that names NO procedure. If nothing clean survives, the referral stands
  // alone. This guarantees complete, grammatical output every time.
  const engineerReferral = 'The next step needs internal electrical testing, so this is the point to bring in a qualified appliance engineer.';
  const isFragment = (s) => !s || /^[a-z]/.test(s) || /^(which|and|but|so|then|test|or|that|rather|if|because|while|when)\b/i.test(s);
  const body = kept.filter((s) => !isFragment(s)).join(' ').replace(/\s{2,}/g, ' ').trim();
  if (!body) return engineerReferral;
  if (/\b(engineer|qualified|professional|electrician)\b/i.test(body)) return body;
  return `${body.replace(/[;:\s]+$/, '.')} ${engineerReferral}`;
}

// Structured owner-check safety precaution. Returns a short COMPLETE precaution clause the reply must
// carry when THIS turn's next action is an accessible owner physical check — carried deterministically
// so it never depends on COMPOSE remembering. null when no precaution applies (identification, a
// conclusion, an engineer referral, or a pure settings/observation check needs none).
// Family-standing owner-safety note: the real precaution/boundary a competent advisor states before
// an owner does anything physical to this appliance family. Generalisable real safety advice — the
// isolation step plus the family's inherent hazard (lint fire risk, bonded glass top, hard-wired
// element = engineer job, sealed-system/HV left alone) — NOT scenario-specific wording.
const OWNER_SAFETY_NOTE = {
  vacuum: 'Switch it off and unplug it (or take the battery out) before reaching into the bin, filters, hose or brush bar',
  'tumble-dryer': 'Switch it off and unplug it before clearing the filter or condenser, and keep the lint filter clear \u2014 trapped lint is a fire risk',
  'washer-dryer': 'Switch it off and unplug it before clearing the filter or condenser, and keep the lint filter clear \u2014 trapped lint is a fire risk',
  'washing-machine': 'Switch it off and unplug it first, with towels or a tray ready as water can spill',
  dishwasher: 'Switch it off and unplug it first (isolate at the fuse box if the socket sits behind the unit near water)',
  'fridge-freezer': 'Unplug it first, and a safe owner check is to make sure the internal vents are not blocked and the condenser coils or grille at the back are clear of dust',
  'oven-cooker': 'Switch it off at the wall before any inspection \u2014 never test it live, and leave replacing a hard-wired cooker element to a qualified engineer',
  hobs: 'Switch it off at the wall or its spur first, and never lift or prise off a bonded glass top',
};

// Turns that are NOT an owner physical check, so they carry no precaution.
const NON_CHECK_NEXT_ACTIONS = new Set([
  'identification', 'advice_then_identity', 'part_request', 'replacement_evidence', 'safety_stop',
]);

function ownerCheckPrecaution(intent, extras) {
  if (!intent) return null;
  const fam = applianceKey(intent.applianceType);
  if (!fam || !OWNER_SAFETY_NOTE[fam]) return null;
  if (NON_CHECK_NEXT_ACTIONS.has(intent._nextAction)) return null; // model ask / purchase / stop
  if (intent._exclusiveClarify) return null;                       // a bare vague clarification
  if (intent.normalBehaviour === true) return null;                // reassurance, no physical check
  if (extras && (extras.recovered || extras.normalBehaviour || extras.safetyStop || extras.diagnoseStop)) return null;
  return OWNER_SAFETY_NOTE[fam];
}

// Deterministic safety-framing enforcer (secondary to COMPOSE's SAFE-CHECK FRAMING rule). On a
// diagnostic/check turn for a family with an inherent owner hazard, if the composed reply does NOT
// already carry an isolation/precaution cue, prepend the family's standing safety note so safe
// framing is reliable rather than left to COMPOSE. Only a presence check reads the prose, so we
// never double it; part-finder COMPOSE only produces the reply on genuine diagnostic turns (the
// orchestrator owns the model-ask / stop-use turns), so this never lands on a model ask.
function ensureOwnerCheckSafety(reply, intent, extras) {
  if (!reply || !intent) return reply;
  if (extras && (extras.safetyStop || extras.diagnoseStop)) return reply; // stop-use owns its wording
  const note = ownerCheckPrecaution(intent, extras);
  if (!note) return reply;
  const text = String(reply);
  if (/\b(unplug|unplugg|switch(?:ed)?\s+(?:it\s+)?off|turn(?:ed)?\s+(?:it\s+)?off|isolate|isolat|power(?:ed)?\s+off|disconnect|take the battery out|remove the battery|at the wall|at the spur)\b/i.test(text)) {
    return reply; // a precaution is already present — do not double it
  }
  return `${note}. ${text.trim()}`;
}

/** Strip DIY high-voltage microwave test/access language; keep high-level professional-only wording. */
function stripMicrowaveHvDiy(reply) {
  const src = String(reply || '');
  if (!/\b(magnetron|capacitor|inverter|transformer|high[- ]voltage|\bhv\b|diode)\b/i.test(src)) return src;
  const stripped = src
    .replace(/[^.!?\n]*\b(?:test|testing|discharge|discharging|measure|measuring|probe|probes?|meter)\b[^.!?\n]{0,80}\b(?:magnetron|capacitor|inverter|transformer|high[- ]voltage|\bhv\b|diode)\b[^.!?\n]*[.!?]?/gi, ' ')
    .replace(/[^.!?\n]*\b(?:magnetron|capacitor|inverter|transformer|high[- ]voltage|\bhv\b|diode)\b[^.!?\n]{0,80}\b(?:test|testing|discharge|measure|probe|meter)\b[^.!?\n]*[.!?]?/gi, ' ')
    .replace(/[^.!?\n]*\b(?:take (?:the )?cover off|remove (?:the )?(?:cover|casing|wrapper|panel)|open (?:the )?(?:case|cabinet))\b[^.!?\n]{0,80}\b(?:microwave|magnetron|capacitor|high[- ]voltage|\bhv\b)\b[^.!?\n]*[.!?]?/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // DE-FRAGMENT. Removing a sentence that contained HV test/access language can leave a dangling
  // relative/conjunction clause ("which can be triggered by...", "as accessing these parts...") that
  // reads as a broken fragment. Drop any sentence that now starts mid-thought (lowercase lead or a
  // leading relative/conjunction) so the reply is always grammatical, mirroring the internal-
  // electrical stripper's rebuild.
  const isFragment = (s) => !s || /^[a-z]/.test(s)
    || /^(which|and|but|so|then|or|that|rather|as|because|while|when|if|also)\b/i.test(s);
  const cleaned = stripped
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !isFragment(s))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned) {
    return 'High-voltage microwave internals can hold a charge even when unplugged. A qualified microwave engineer is required.';
  }
  return cleaned;
}

function detectUnsafeIntent(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const patterns = [
    /bypass\w*\b.{0,30}\b(interlock|door switch|door lock|safety|thermostat|cut ?out|protection|ncp|switch)/,
    /(disable|defeat|jump\w*|jumper|short out|wire round|wire around|get round)\b.{0,30}\b(interlock|door switch|safety|switch|thermostat|cut ?out|protection)/,
    /(test|probe|measure|check|put the (?:meter|multimeter|probes?)).{0,40}\b(live|while (?:it'?s )?(?:live|on|plugged|powered|running)|mains terminals?|live terminals?)/,
    /\b(live|mains) (?:test|testing)|test\w* .{0,10}live\b/,
    /(while|whilst|with) (?:it'?s )?(?:still )?(?:plugged in|powered|switched on|live|on and)/,
    /(keep|carry on|continue|repeatedly|keep on)\b.{0,20}\b(reset\w*|switch\w* back on)\b.{0,20}\b(rcd|breaker|trip|fuse|it)/,
    /reset\w*\b.{0,15}\b(rcd|breaker|trip)\b.{0,20}(again|repeatedly|see what|keep)/,
    /discharge\w*\b.{0,20}\b(capacitor|cap\b|hv|high voltage|microwave)/,
    /(recharge|re-?gas|regas|top up)\w*\b.{0,20}\b(refrigerant|gas|coolant|freon|fridge|freezer|sealed system)/,
    /(look|search|find|check)\w*\b.{0,25}\b(gas )?leak\b.{0,25}\b(lighter|match|flame|naked flame|candle)/,
    /(run|use|turn on)\b.{0,20}\bgas\b.{0,25}\b(lighter|match|flame|leak)/,
    /(open|take (?:the )?back off|remove (?:the )?(?:back|cover|panel))\b.{0,40}\b(while|whilst|with).{0,15}\b(plugged|powered|live|on)\b/,
    /(open|take (?:the )?cover off|remove (?:the )?(?:cover|casing|wrapper|panel))\b.{0,40}\b(magnetron|capacitor|high[- ]voltage|\bhv\b|diode|transformer)/,
    /\b(take (?:the )?cover off|remove (?:the )?(?:cover|casing))\b.{0,40}\b(microwave|to (?:test|check|measure))/,
    /microwave.{0,80}\b(take (?:the )?cover off|remove (?:the )?(?:cover|casing))/,
    /(test|probe|measure|check).{0,30}\b(magnetron|capacitor|high[- ]voltage|\bhv\b)/,
    /where (?:do|should) i (?:put|place).{0,20}\b(probes?|meter|leads?)\b.{0,20}\b(live|mains|terminals?)/,
    /\b(insulation[- ]?(?:resistance|test)|megger)\b/,
  ];
  return patterns.some((re) => re.test(t));
}

/** True when the customer is asking to test/discharge/open microwave high-voltage internals. */
function isMicrowaveHvProcedureRequest(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const microwave = /\bmicrowave\b/.test(t);
  const hvPart = /\b(magnetron|high[\s-]?voltage|\bhv\b|capacitor|inverter)\b/.test(t);
  const procedure = /\b(test|testing|discharge|discharging|measure|measuring|probe|probes|cover off|covers? off|remove (?:the )?(?:cover|casing|panel)|dismantl)\b/.test(t);
  return Boolean((microwave || hvPart) && hvPart && procedure && detectUnsafeIntent(text));
}

// Deterministic NORMAL-BEHAVIOUR backstop (smallest correct; NOT a rule engine, and NOT
// "contains eco = normal"). Fires ONLY when the customer is ASKING whether behaviour is normal AND
// describes a KNOWN plausibly-normal operating condition AND there is NO failure symptom in the text.
// It is a safety net for when UNDERSTAND fails to set the structured `normalBehaviour` flag; the
// handler still gates it on (no grounded fault, no error code, no safety-stop), so a genuinely
// grounded fault always wins. The FAILURE exclusion below is what protects the near-neighbours
// (ECO + cold water / stalling / not draining / not filling / any fault evidence) — those keep
// their genuine diagnosis and never get reassured away. Returns true/false.
// Shared near-neighbour VETO: an explicit FAILURE symptom (or a safety-stop) means this is a genuine
// fault, never "normal behaviour" — a real problem always wins over reassurance. Pure over the raw
// text. Used by matchNormalBehaviour (below) and the model-flag gate, so the discipline is defined
// once. (ECO + cold/not heating | stalls | not draining/filling | leak | error code | trip | burning.)
function hasFailureSymptom(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  return /(not|won'?t|wont|isn'?t|does ?n'?t|no longer|stops?)\s+(heat|heating|get(ting)? hot|warm|drain|draining|empty|emptying|fill|filling|spin|start|complete|finish|work)/.test(t)
    || /(stays?|going|remains?|still|water is|water's|comes out)\s+cold|not (getting|coming|going) (hot|warm)|no hot water|won'?t get hot|luke ?warm/.test(t)
    || /\bstall(s|ing|ed)?\b|stuck|freezes? (at|on|up)|hangs? (at|on)|stops? (at|part|mid|halfway)|same (stage|point|part)/.test(t)
    || /water (left|remaining|standing|sitting|in the (drum|bottom|base))|not empt|won'?t empt/.test(t)
    || /leak|flood|error|fault code|\bf\d|\be\d\d|trip(s|ping|ped)?|burning|smell|smok|spark/.test(t)
    || Boolean(detectSafetyStop(text));
}

// Does the customer's message express a WORRY / ask whether something is normal? Reassurance framing.
// Broad but principled — includes plain fault-questions ("is it broken/dying/faulty", "what's wrong")
// so we recognise concern however it's phrased, not just the literal "is this normal". Pure.
function expressesConcern(t) {
  return /is (it|this|that) (normal|ok|okay|alright|right|broken|broke|faulty|dying|dead|failing|going|a fault|a problem|dangerous)/.test(t)
    || /\bthat normal\b|\bnormal\?|\bis that normal|\bis this normal|\bis it normal/.test(t)
    || /normal (for|that|to)\b|meant to\b|supposed to\b|should (it|my|the|i)\b|expected\b/.test(t)
    || /why (does|is|would|has) it|worried|worry|concern|dangerous|\bfaulty\b|what'?s wrong|whats wrong/.test(t);
}

// BENIGN-SMELL EXCEPTION for FIRST-USE recognition. `hasFailureSymptom` treats the bare word "smell"
// as a failure symptom (correct default — most appliance smells are faults), which would otherwise
// veto EVERY first-use/new-appliance reassurance ("a bit of a smell when it's new"). This returns true
// ONLY when the text mentions a smell that is BENIGN: it carries NO dangerous qualifier (burning,
// electrical, acrid, hot-plastic, melting, rubber, gas, smoke, sparking, scorching, or a drain/mould
// smell) AND, once the smell words are removed, NO OTHER failure symptom remains AND the safety
// classifier does not fire. It never asserts a smell is safe — matchNormalBehaviour only lets such a
// message reach a record that explicitly opts in via `firstUse`, and the handler's safety-stop gate
// still wins. Pure over the raw text; reusable across families.
function isBenignSmellOnly(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  if (!/\b(smell|smells|smelling|smelt|odou?r)\b/.test(t)) return false; // no smell mentioned at all
  // ANY dangerous / genuine-fault smell qualifier disqualifies (kept in step with classifySafetyStop
  // and the hygiene/drain smells). Note: a plain "chemical"/"new"/"funny" smell is NOT dangerous — a
  // new-appliance coating smell is exactly the benign first-use case we want to recognise.
  if (/(burning|burnt|electrical|acrid|hot[- ]?plastic|melt\w*|\brubber\b|\bgas\b|smoke|smok\w*|spark|scorch|sewage|sewer|drains?|sewer|rotten|rotting|egg|fishy|mould|mouldy|musty|mildew)/.test(t)) return false;
  // Must have NO OTHER failure symptom apart from the smell itself: strip the smell words and re-run
  // the standard veto (this also re-checks the safety classifier on the stripped text).
  const withoutSmell = t.replace(/\b(smell|smells|smelling|smelt|odou?r)\b/g, ' ');
  if (hasFailureSymptom(withoutSmell)) return false;
  return true;
}

// FIRST-CLASS NORMAL-BEHAVIOUR RECOGNITION (replaces the old closed-set regex backstop).
// A SMALL amount of clean water left in the sump/bottom after a cycle is NORMAL for a dishwasher
// (keeps the seals wet and the pump primed). But the shared failure-symptom veto treats any "water
// sitting in the bottom" as a not-draining symptom, which would block that reassurance. This is the
// narrow, opt-in exception (mirrors isBenignSmellOnly -> firstUse records): TRUE only when the ONLY
// failure-ish cue is a SMALL amount of water in the bottom/sump AND there is NO harder drainage-
// failure / flood / dirty-water / smell / error / leak signal. A genuine not-draining fault ("full
// of water", "won't drain", "dirty water", "water right up") therefore never qualifies. Deterministic
// and calibrated; the record's own notIf list is the second line of defence.
function isResidualWaterOnly(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const smallWater = /\b(?:little|bit of|small amount of|tiny bit of|drop of|small)\b[^.!?\n]{0,20}\bwater\b/.test(t)
    || (/\bwater\b[^.!?\n]{0,20}\b(?:bottom|sump|base)\b/.test(t) && /\b(?:little|bit|small|some|drop)\b/.test(t));
  if (!smallWater) return false;
  // Any harder drainage-failure / flood / dirty-water / smell / error / leak signal disqualifies — a
  // genuine not-draining fault must never be reassured as normal residual water.
  if (/(won'?t drain|wont drain|not drain\w*|isn'?t drain\w*|not empt\w*|won'?t empt|wont empt|full of water|half full|right up|lots of water|loads of water|water all over|flood\w*|dirty water|mucky water|leak\w*|smell\w*|error|fault code|\bf\d|\be\d\d)/.test(t)) return false;
  // Strip the benign residual-water phrases, then re-run the standard veto on the remainder so any
  // OTHER failure symptom in the same message still vetoes.
  const stripped = t
    .replace(/water (?:left|remaining|standing|sitting|in the (?:drum|bottom|base))/g, ' ')
    .replace(/\bwater\b[^.!?\n]{0,20}\b(?:bottom|sump|base)\b/g, ' ')
    .replace(/\b(?:little|bit of|small amount of|tiny bit of|drop of|small)\b[^.!?\n]{0,20}\bwater\b/g, ' ');
  if (hasFailureSymptom(stripped)) return false;
  return true;
}

// WET-PLASTICS EXCEPTION (mirrors isResidualWaterOnly). "Plastics don't dry" is a not-drying-shaped
// cue that is actually NORMAL (plastic doesn't hold heat, so it can't flash-dry), so it must be able
// to reach a record that opts in via `wetPlastics`. True ONLY when the drying complaint is confined
// to PLASTIC items and nothing harder is present (not everything/glasses/plates/china wet, nothing
// dries, cold, not heating, leak, error …) — a genuine drying/heating fault must never be reassured.
function isWetPlasticsOnly(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const plastics = /\b(plastic|plastics|tupperware|container|containers|beaker|beakers|lid|lids)\b/.test(t);
  const wetOrNotDry = /\b(wet|damp|still wet|not dry|won'?t dry|wont dry|not drying|still dripping|dripping)\b/.test(t);
  if (!plastics || !wetOrNotDry) return false;
  // Harder signals that it is a broader drying/heating fault, never reassured as normal.
  if (/(everything (?:else )?(?:is )?wet|all (?:are )?(?:wet|damp)|nothing (?:is )?dry\w*|nothing dries|cold at the end|dishes are cold|not heating|no hot water|won'?t heat|wont heat|leak\w*|error|fault code|\bf\d|\be\d\d|flood\w*|burning|smok|spark)/.test(t)) return false;
  // Non-plastic crockery mentioned: OK only if it is explicitly DRY/fine (the "just the plastics"
  // case). If crockery is present and NOT said to be dry, more than the plastics is affected -> fault.
  const crockery = /\b(glass\w*|plate\w*|dish\w*|china|cup\w*|bowl\w*|mug\w*|cutlery)\b/.test(t);
  if (crockery) {
    const crockeryDry = /\b(glass\w*|plate\w*|dish\w*|china|cup\w*|bowl\w*|mug\w*|cutlery)\b[^.!?]{0,25}\b(dry|dried|fine|ok|okay)\b/.test(t)
      || /\b(everything else|all else|the rest|everything but)\b[^.!?]{0,15}\b(dry|fine|ok)\b/.test(t);
    if (!crockeryDry) return false;
  }
  const stripped = t
    .replace(/\b(plastic|plastics|tupperware|container|containers|beaker|beakers|lid|lids)\b/g, ' ')
    .replace(/\b(wet|damp|still wet|not dry|won'?t dry|wont dry|not drying|still dripping|dripping)\b/g, ' ');
  if (hasFailureSymptom(stripped)) return false;
  return true;
}

// Resolves the raw customer text (+ appliance family/make) against the authored normal-behaviour
// KNOWLEDGE (knowledge/normal-behaviour.json via retrieval.getNormalBehaviourRecords). Domain facts
// (InfoLight, child-lock padlock, back-wall condensation, magnetron hum, refrigerant noises, etc.)
// live in that data with provenance; this function is the generic MATCHER only — no per-scenario or
// per-appliance facts are hard-coded here. Returns the best matching record, or null.
//   - The shared failure-symptom veto always disqualifies (a genuine fault wins).
//   - Each record's own `notIf` gives fault-like calibration (e.g. "loads of ice" is NOT normal).
//   - `requireConcern` records (generic operating conditions) match only under reassurance framing;
//     distinctive feature/indicator/symbol records match on their cue alone.
//   - Brand-specific records (`makes`) only match a matching make.
function matchNormalBehaviour(ctx, text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  // A genuine failure symptom (or a safety-stop) always wins over reassurance. The ONE exception is a
  // BENIGN smell (no dangerous qualifier, no other failure symptom, safety classifier silent): that
  // must be able to reach a FIRST-USE record, because the bare word "smell" would otherwise veto every
  // new-appliance reassurance. The exception is confined below to records that opt in via `firstUse`;
  // every other record keeps the full veto, and the handler's own safety-stop gate still wins.
  const failure = hasFailureSymptom(raw);
  const benignSmell = failure && isBenignSmellOnly(raw);
  // Second bounded exception (mirrors benignSmell -> firstUse): a SMALL amount of residual sump water
  // is a not-draining-shaped cue that is actually normal, so let it reach a `residualWater` record.
  const residualWater = failure && isResidualWaterOnly(raw);
  // Third bounded exception: a wet-PLASTICS-only drying complaint is normal and may reach a record
  // that opts in via `wetPlastics`; every other record keeps the full not-drying veto. Computed
  // unconditionally so it ALSO positively gates the wet-plastics record below (its crockery-dry logic
  // is stronger than a substring notIf — "plates and plastics all wet" must NOT be reassured).
  const wetPlasticsOnly = isWetPlasticsOnly(raw);
  const wetPlastics = failure && wetPlasticsOnly;
  if (failure && !benignSmell && !residualWater && !wetPlastics) return null;
  const t = ` ${raw.toLowerCase()} `;
  const family = (ctx && ctx.applianceFamily) || null;
  const make = String((ctx && ctx.make) || '').toLowerCase().trim();
  const concern = expressesConcern(t);
  const hasAny = (arr) => Array.isArray(arr) && arr.some((c) => t.includes(String(c).toLowerCase()));
  for (const rec of getNormalBehaviourRecords()) {
    // A benign-smell-only message may ONLY be reassured by a first-use record — this preserves the
    // failure-symptom veto for every generic/feature/indicator record.
    if (benignSmell && !rec.firstUse) continue;
    // A residual-sump-water-only message may ONLY be reassured by a record that opts in via
    // `residualWater` — every other record keeps the full not-draining veto.
    if (residualWater && !rec.residualWater) continue;
    // A wet-plastics-only message may ONLY be reassured by a record that opts in via `wetPlastics`.
    if (wetPlastics && !rec.wetPlastics) continue;
    // A wet-plastics record positively REQUIRES the wet-plastics-only shape (crockery-dry aware),
    // so a broader "plates and plastics all wet" fault can never match it via the bare cue list.
    if (rec.wetPlastics && !wetPlasticsOnly) continue;
    if (rec.family && rec.family !== family) continue;
    if (Array.isArray(rec.makes) && rec.makes.length) {
      if (!make || !rec.makes.some((m) => make.includes(String(m).toLowerCase()))) continue;
    }
    if (rec.requireConcern && !concern) continue;
    if (hasAny(rec.notIf)) continue; // record-specific fault-like calibration
    let cueOk = hasAny(rec.cues);
    if (!cueOk && Array.isArray(rec.allOf) && rec.allOf.length) {
      cueOk = rec.allOf.every((group) => hasAny(group));
    }
    if (!cueOk) continue;
    return rec;
  }
  return null;
}

// Merge the catalogue fault-node discriminators with the discriminators from the
// RETRIEVED knowledge doc for the grounded fault. The knowledge docs are built
// as (catalogue discriminators + curated engineer overrides), so the doc is the
// superset — but we fall back to / union with the node so error-code routes
// (which may not have a matching retrieved doc) still get their guidance.
function mergeDiscriminators(fault, knowledgeDocs = []) {
  const out = [];
  const seen = new Set();
  const add = (arr) => {
    for (const d of arr || []) {
      const key = String(d).trim();
      if (key && !seen.has(key)) { seen.add(key); out.push(key); }
    }
  };
  // Prefer the doc that matches the grounded fault (by knowledgeId/faultId);
  // if none matches (e.g. code-only route), fall through to node discriminators.
  const fid = fault && fault.faultId;
  const matchDoc = fid && Array.isArray(knowledgeDocs)
    ? knowledgeDocs.find((d) => d && (d.faultId === fid || (d.knowledgeId || '').endsWith(`:${fid}`)))
    : null;
  if (matchDoc) add(matchDoc.discriminators);
  add(fault && fault.node && fault.node.discriminators);
  return out;
}

module.exports = {
  EVIDENCE_KIND, isStatusIndicationFlash, extractDisplayedStatusToken, displayedIndicationNeedsIdentity,
  applyDisplayedIndicationIdentity, isElectricalFlashEvent, proposedPhysicalAccess, detectSafetyStop,
  classifySafetyStop, stripOutOfScopeElectricalTests, stripOwnerInternalElectricalInspection,
  ownerCheckPrecaution, ensureOwnerCheckSafety, stripMicrowaveHvDiy, detectUnsafeIntent,
  isMicrowaveHvProcedureRequest, hasFailureSymptom, expressesConcern, isBenignSmellOnly, isResidualWaterOnly,
  isWetPlasticsOnly, matchNormalBehaviour, mergeDiscriminators,
};
