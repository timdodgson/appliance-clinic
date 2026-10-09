/**
 * Evidence: facts collected from the conversation, differential adjustment, commit rules, discriminator questions,
 * positive-observation constraints and material ambiguity.
 */
const { canonicalComponent } = require('../retrieval');
const { discriminatorQuestion } = require('../identity.js');
const { asciiFold, progressCustomerText, messageText, customerProposedDrainPathPart } = require('./conversation.js');
const {
  CATALOGUE, applianceKey, resolveFault, humanizeFact, phraseRefersToComponent, refersToSameComponent,
} = require('./catalogue.js');

function overlapsComponents(phrase, components) {
  return (components || []).some((c) => refersToSameComponent(phrase, c));
}

function dedupePhrases(list) {
  const out = [];
  const seen = new Set();
  for (const p of list || []) {
    const k = String(p || '').toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// Principled fact->component-keyword backstop for the STANDARD "it works" facts (NOT a big hand
// table). A TRUE "works" fact proves that subsystem is good ONLY when it is a DIFFERENT function
// from the grounded complaint. The same function operating under some conditions is not proof.
const FACT_PROVEN_GOOD = {
  heatsAtAll: ['heater', 'heating element'],                 // it does heat -> heating side is fine
  drainsNormally: ['drain pump', 'pump filter', 'drain hose'], // it drains -> not a drainage part
  drumTurnsByHand: ['drum bearing'],                         // drum free by hand -> not a seized bearing
};

function worksFactContradictsNode(factName, node) {
  if (!factName || !node || !Array.isArray(node.signals)) return false;
  // A "works" fact (heatsAtAll / drainsNormally / drumTurnsByHand) that the grounded fault lists as
  // arguing AGAINST it — at EITHER strength — is evidence about THIS fault's OWN function, so it is
  // only condition-limited proof, never different-function proof. The strength encodes how hard it
  // argues (a dead fan-oven element is only weakly ruled out by "it heats at all", because the grill
  // or top oven can still heat — hence oven-cooker/element lists heatsAtAll as AGAINST, not
  // STRONG_AGAINST), but weak-vs-strong does NOT change WHICH function the observation belongs to.
  // Only a SUPPORT signal means a genuinely DIFFERENT function is confirmed working (e.g. "it drains
  // fine" SUPPORTS a spin-only motor fault), which is the real proven-good case. Treating a plain
  // AGAINST as a different-function proof wrongly promoted the failing heating path to proven-good.
  return node.signals.some((s) => s && s.fact === factName
    && (s.effect === 'STRONG_AGAINST' || s.effect === 'AGAINST'));
}

function isSameFunctionWorksPhrase(phrase, node) {
  if (!node) return false;
  for (const [factName, parts] of Object.entries(FACT_PROVEN_GOOD)) {
    if (!worksFactContradictsNode(factName, node)) continue;
    if ((parts || []).some((p) => refersToSameComponent(phrase, p))) return true;
  }
  return false;
}

function isConditionLimitedWorksFact(factName, conditionLimited) {
  const parts = FACT_PROVEN_GOOD[factName];
  if (!parts || !conditionLimited || !conditionLimited.length) return false;
  return parts.some((p) => overlapsComponents(p, conditionLimited));
}

/**
 * A works-fact that only shows the failing function can operate under some conditions
 * must not remain TRUE in structured evidence (that is what COMPOSE over-reads as
 * "the pump/heater is fine"). A FALSE STRONG_SUPPORT on the same node, paired with
 * that condition-limited works-fact, is the same over-inference and is also dropped.
 */
function neutralizeConditionLimitedFacts(intent, node, conditionLimited) {
  if (!intent || !Array.isArray(intent.facts) || !conditionLimited || !conditionLimited.length) return;
  const limitedWorks = Object.keys(FACT_PROVEN_GOOD).filter((fn) => isConditionLimitedWorksFact(fn, conditionLimited));
  if (!limitedWorks.length) return;
  intent.facts = intent.facts.map((f) => {
    if (!f) return f;
    if (f.value === 'TRUE' && limitedWorks.includes(f.name)) return { name: f.name, value: 'UNKNOWN' };
    if (
      node
      && f.value === 'FALSE'
      && (node.signals || []).some((s) => s && s.fact === f.name && s.effect === 'STRONG_SUPPORT')
      && limitedWorks.some((fn) => worksFactContradictsNode(fn, node))
    ) {
      return { name: f.name, value: 'UNKNOWN' };
    }
    return f;
  });
}

// Universal "I replaced/changed/fitted-new X" phrasing (no per-fault knowledge). Captures the named component.
const REPLACED_RE = /\b(?:replaced|changed|renewed|swapped(?: out)?|(?:fitted|put in|installed|got|bought)\s+(?:a\s+)?new)\s+(?:the\s+|a\s+|my\s+)?([a-z][a-z0-9 /-]{2,28})/gi;

/**
 * Gather proven-good + already-replaced evidence from the intent (LLM) plus deterministic backstops.
 * `fault` (optional) scopes "works" evidence: parts of the grounded fault's own function that were
 * merely seen to operate under some conditions are conditionLimited, not provenGood.
 */
function collectEvidence(intent, rawText, fault) {
  const alreadyReplaced = [...(intent.alreadyReplaced || [])];
  const candidates = intent.candidateComponents || [];
  const node = fault && fault.node;
  const factLimitedParts = [];
  const factProvenParts = [];
  const heatPresent = (intent.facts || []).some((f) => f && f.name === 'heatPresent' && f.value === 'TRUE');
  for (const f of intent.facts || []) {
    if (!f || f.value !== 'TRUE' || !FACT_PROVEN_GOOD[f.name]) continue;
    if (!node || worksFactContradictsNode(f.name, node)) factLimitedParts.push(...FACT_PROVEN_GOOD[f.name]);
    else factProvenParts.push(...FACT_PROVEN_GOOD[f.name]);
  }
  if (heatPresent) factLimitedParts.push('heater', 'heating element');
  const commandedDrain = (intent.facts || []).some((f) => f && f.name === 'commandedDrain' && f.value === 'TRUE');
  if (commandedDrain) factLimitedParts.push('drain pump', 'pump filter', 'drain hose');
  const txt = String(rawText || '');
  const thermalPoles = /\b(hot|heat(?:ing)?|warm)\b/i.test(txt) && /\b(cool|cold|cools)\b/i.test(txt);
  if (thermalPoles) {
    if (/\bdrain|empty/i.test(txt)) factLimitedParts.push('drain pump', 'pump filter', 'drain hose');
    if (/\b(heat(?:ing)?|element|oven)\b/i.test(txt) && !/\bdrain|empty/i.test(txt)) {
      factLimitedParts.push('heater', 'heating element');
    }
  }
  const provenGood = [];
  const conditionLimited = [...factLimitedParts];
  const incoming = [...(intent.provenGood || []), ...factProvenParts];
  for (const p of incoming) {
    if (!p) continue;
    const heatPresentHeater = heatPresent && /heater|heating element/i.test(String(p));
    const sameFunction = heatPresentHeater
      || isSameFunctionWorksPhrase(p, node)
      || overlapsComponents(p, factLimitedParts)
      || (!node && overlapsComponents(p, Object.values(FACT_PROVEN_GOOD).flat()));
    const sameAsOnlySuspects = overlapsComponents(p, candidates)
      && !(candidates || []).some((c) => !refersToSameComponent(p, c));
    if (sameFunction || sameAsOnlySuspects) conditionLimited.push(p);
    else provenGood.push(p);
  }
  REPLACED_RE.lastIndex = 0;
  let m;
  while ((m = REPLACED_RE.exec(txt)) && alreadyReplaced.length < 12) {
    const cap = m[1].trim().replace(/\s+(and|but|it|so|still|then|because|which|that).*$/i, '').trim();
    if (cap.length >= 3) alreadyReplaced.push(cap);
  }
  return {
    provenGood: dedupePhrases(provenGood),
    conditionLimited: dedupePhrases(conditionLimited),
    alreadyReplaced,
  };
}

/**
 * Remove proven-good components (evidence proves they work); DEMOTE already-replaced ones to the end
 * (never dropped — a new part can be faulty/badly-fitted). Guarded so the differential is never
 * emptied by an over-eager rule-out. Non-destructive (returns a new array).
 */
function adjustDifferential(components, adj) {
  if (!Array.isArray(components) || !components.length || !adj) return components;
  const { provenGood = [], alreadyReplaced = [] } = adj;
  if (!provenGood.length && !alreadyReplaced.length) return components;
  const kept = [], demoted = [];
  for (const c of components) {
    if (provenGood.some((p) => phraseRefersToComponent(p, c))) continue;
    if (alreadyReplaced.some((p) => phraseRefersToComponent(p, c))) { demoted.push(c); continue; }
    kept.push(c);
  }
  const out = [...kept, ...demoted];
  return out.length ? out : components;
}

function computeEvidence(faultNode, facts) {
  if (!faultNode || !Array.isArray(faultNode.signals) || !Array.isArray(facts) || !facts.length) {
    return null;
  }
  const byName = new Map(facts.map((f) => [f.name.toLowerCase(), f.value]));
  const supports = [];
  const against = [];
  for (const sig of faultNode.signals) {
    const v = byName.get(String(sig.fact || '').toLowerCase());
    if (!v || v === 'UNKNOWN') continue;
    const e = sig.effect;
    const h = humanizeFact(sig.fact);
    if (v === 'TRUE') {
      if (e === 'STRONG_SUPPORT' || e === 'SUPPORT') supports.push(h);
      else if (e === 'AGAINST' || e === 'STRONG_AGAINST') against.push(h);
    } else if (v === 'FALSE') {
      // Absence of a strong indicator is itself evidence (this powers
      // "evidence against the initial diagnosis").
      if (e === 'STRONG_SUPPORT') against.push(`not ${h}`);
      else if (e === 'STRONG_AGAINST') supports.push(`not ${h}`);
    }
  }
  if (!supports.length && !against.length) return null;
  return { supports, against };
}

/**
 * FACT FIDELITY (deterministic contradiction gate). A resolved fault must not LEAD when the
 * customer's OWN stated facts strongly contradict it. Reads ONLY the node's structured `signals[]`
 * (the same authored evidence `computeEvidence` uses) — no journey ids, no phrase tables, no LLM
 * judge. A signal marked STRONG_AGAINST that the customer stated TRUE (or a STRONG_SUPPORT they
 * stated FALSE) is a genuine contradiction: an observation the candidate cannot be reconciled with.
 * UNKNOWN/absent facts are neutral (never treated as TRUE or FALSE). Returns { contradicted, reasons }.
 */
function factConflict(node, facts, conditionLimited) {
  if (!node || !Array.isArray(node.signals) || !Array.isArray(facts) || !facts.length) {
    return { contradicted: false, reasons: [] };
  }
  const byName = new Map(facts.map((f) => [String(f.name || '').toLowerCase(), f.value]));
  const reasons = [];
  for (const sig of node.signals) {
    const v = byName.get(String(sig.fact || '').toLowerCase());
    if (!v || v === 'UNKNOWN') continue; // unknown stays unknown — never a contradiction
    if (v === 'TRUE' && sig.effect === 'STRONG_AGAINST') {
      // A works-fact that only shows the failing function can operate under some
      // conditions must not contradict that function's own fault node.
      if (isConditionLimitedWorksFact(sig.fact, conditionLimited)) continue;
      reasons.push(humanizeFact(sig.fact));
    } else if (v === 'FALSE' && sig.effect === 'STRONG_SUPPORT') reasons.push(`not ${humanizeFact(sig.fact)}`);
  }
  return { contradicted: reasons.length > 0, reasons };
}

/**
 * When a symptom/classified fault is contradicted by the stated facts, prefer an alternative the
 * UNDERSTAND pass already offered (intent.alternatives) that the SAME facts do NOT contradict and DO
 * support. Evidence-driven and deterministic: the alternative must be a real node for this appliance,
 * not itself contradicted, and have net-positive fact support (supports > against via computeEvidence).
 * Never re-routes an error-code-resolved fault (that authority is owned upstream). Returns a
 * { faultId, node, via:'evidence-reground', score } or null (→ caller demotes + hedges instead).
 */
function chooseCompatibleFault(intent, fault, appKey) {
  if (!fault || fault.via === 'errorCode') return null;
  const faultsForAppliance = (appKey && CATALOGUE.faults && CATALOGUE.faults[appKey]) || {};
  const candIds = [...new Set(intent.alternatives || [])].filter(
    (id) => faultsForAppliance[id] && id !== fault.faultId,
  );
  let best = null;
  for (const id of candIds) {
    const node = faultsForAppliance[id];
    if (factConflict(node, intent.facts).contradicted) continue;
    const ev = computeEvidence(node, intent.facts);
    const support = ev ? ev.supports.length : 0;
    const against = ev ? ev.against.length : 0;
    if (support > 0 && support > against) {
      const score = support - against;
      if (!best || score > best.score) best = { faultId: id, node, via: 'evidence-reground', score };
    }
  }
  return best;
}

// -------- ANSWERED-DISCRIMINATOR PROGRESSION (deterministic, structural) --------
// Customer OBSERVATION facts (noise, water fill/remaining, drum movement, commanded drain, …) are
// now produced authoritatively by Jev's typed evidence contract (Story 2); the prose regex/keyword
// extractors that used to rediscover them from customer language have been removed. What remains
// here is STRUCTURAL: which discriminator question the prior advisor turn asked, and whether a
// question was already asked — these read the trusted conversation structure, not customer prose.

function askedDiscriminatorFact(progress) {
  const prior = String((progress && progress.priorAdvisorText) || '').toLowerCase();
  if (!prior) return null;
  for (const [fact, q] of Object.entries(DISCRIMINATOR_QUESTION)) {
    if (!q) continue;
    const needle = String(q).toLowerCase().slice(0, 40);
    if (needle && prior.includes(needle)) return fact;
  }
  if (/without filling|water start coming/.test(prior)) return 'waterEntering';
  if (/water left in the bottom/.test(prior) && /should be draining|machine should be draining/.test(prior)) {
    return 'drainEvent';
  }
  return null;
}

function discriminatorAlreadyAsked(progress, question) {
  if (!progress || !question) return false;
  const prior = String(progress.priorAdvisorText || '').toLowerCase();
  const needle = String(question).toLowerCase().slice(0, 48);
  return Boolean(needle && prior.includes(needle));
}

// Every TYPED discriminator the advisor has asked across the WHOLE thread (not just the last turn).
// Structural identity only: each assistant turn is matched against the canonical DISCRIMINATOR_QUESTION
// needle (the same mechanism askedDiscriminatorFact uses), so this recovers WHICH typed discriminators
// were put to the customer — it is not raw assistant-text repetition detection. Part-finder keeps no
// durable per-turn discriminator state, so without this a discriminator asked two turns ago is
// "forgotten" and can resurface after a later cannot-answer. On a cannot-answer turn these are added
// to declinedFacts so none of them is ever re-asked (answered ones are already in the known set, so
// including them is harmless).
function allAskedDiscriminatorFacts(messages) {
  const out = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== 'assistant') continue;
    const t = asciiFold(messageText(m).trim()).toLowerCase();
    if (!t) continue;
    for (const [fact, q] of Object.entries(DISCRIMINATOR_QUESTION)) {
      if (!q) continue;
      const needle = String(q).toLowerCase().slice(0, 40);
      if (needle && t.includes(needle)) out.add(fact);
    }
  }
  return [...out];
}

/**
 * A generic-hum observation must not be rewritten as a named-component hum. If UNDERSTAND
 * localised the noise onto a *Humming fact (pumpHumming, drainPumpHumming, …) but the customer
 * never named that path, strip the localisation back to UNKNOWN so humNoise stays unlocalised.
 */
function dropUnstatedComponentHum(intent, queryText, derived) {
  if (!intent || !Array.isArray(intent.facts) || !intent.facts.length) return;
  const genericHum = (derived || []).some((d) => d && d.name === 'humNoise' && d.value === 'TRUE');
  if (!genericHum) return;
  const t = ` ${String(queryText || '').toLowerCase()} `;
  intent.facts = intent.facts.map((f) => {
    if (!f || f.value !== 'TRUE') return f;
    const name = String(f.name || '');
    if (!/humming$/i.test(name) || /^humNoise$/i.test(name)) return f;
    const bits = name.replace(/Humming$/i, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase().split(/\s+/);
    const mentioned = bits.some((w) => w.length > 2 && t.includes(w));
    return mentioned ? f : { name: f.name, value: 'UNKNOWN' };
  });
}

/**
 * Merge deterministically-derived facts into the intent's facts WITHOUT overriding anything the
 * customer/LLM already stated. A fact is added ONLY when it is absent or UNKNOWN in intent.facts, so
 * an explicit TRUE/FALSE the customer gave (e.g. "it's NOT on spin") always wins. Preserves
 * TRUE/FALSE/UNKNOWN semantics. Returns the merged array (new array; input untouched).
 */
function mergeDerivedFacts(existing, derived) {
  const facts = Array.isArray(existing) ? existing.slice() : [];
  const idx = new Map(facts.map((f, i) => [String(f.name || '').toLowerCase(), i]));
  for (const d of derived) {
    const key = d.name.toLowerCase();
    if (!idx.has(key)) { facts.push(d); idx.set(key, facts.length - 1); }
    else if (facts[idx.get(key)].value === 'UNKNOWN') { facts[idx.get(key)] = d; }
    // else: an explicit TRUE/FALSE already stated — never override it.
  }
  return facts;
}

// Weighted evidence score for a node given the customer's facts (reuses the SAME signals[] that
// computeEvidence/factConflict read). STRONG_SUPPORT satisfied = +2, SUPPORT = +1, AGAINST = -1;
// STRONG_AGAINST is handled by factConflict (contradiction) upstream, and also -3 here. FALSE facts
// invert strong signals (mirrors computeEvidence). Also returns strongSupport count so a commit can
// require a genuinely DECISIVE (strong) discriminator, not a pile of weak keyword hits.
function scoreNodeEvidence(node, facts) {
  if (!node || !Array.isArray(node.signals) || !Array.isArray(facts) || !facts.length) {
    return { score: 0, strongSupport: 0, against: 0 };
  }
  const byName = new Map(facts.map((f) => [String(f.name || '').toLowerCase(), f.value]));
  let score = 0, strongSupport = 0, against = 0;
  for (const sig of node.signals) {
    const v = byName.get(String(sig.fact || '').toLowerCase());
    if (!v || v === 'UNKNOWN') continue;
    const e = sig.effect;
    if (v === 'TRUE') {
      if (e === 'STRONG_SUPPORT') { score += 2; strongSupport++; }
      else if (e === 'SUPPORT') score += 1;
      else if (e === 'AGAINST') { score -= 1; against++; }
      else if (e === 'STRONG_AGAINST') { score -= 3; against++; }
    } else if (v === 'FALSE') {
      if (e === 'STRONG_SUPPORT') { score -= 2; against++; }         // absence of a strong indicator
      else if (e === 'STRONG_AGAINST') { score += 2; strongSupport++; }
    }
  }
  return { score, strongSupport, against };
}

/**
 * COMMIT ON ANSWERED DISCRIMINATOR (evidence-grounded). When the customer's OWN facts decisively
 * point to a SINGLE compatible fault, ground to it — this is what lets an answered discriminator
 * ("loud grinding on the spin") progress to a diagnosis instead of another open question. It is
 * purely evidence-driven (reuses node signals[] via scoreNodeEvidence + factConflict), never keyed
 * off "a discriminator was pending". Eligible nodes: not contradicted AND at least ONE STRONG signal
 * satisfied (a genuine discriminator, not weak keyword overlap). Commit ONLY when there is a clear
 * leader: score >= COMMIT_MIN and it beats the runner-up by >= COMMIT_MARGIN (or is the sole eligible
 * node). Both thresholds are one STRONG signal on the existing evidence scale (STRONG=2), so a lone
 * strong discriminator with no rival commits, but two materially-close candidates do NOT (caller then
 * asks a discriminating question). Never runs for error-code faults (that authority is owned upstream).
 * Returns { faultId, node, via:'evidence-commit', score } or null.
 */
const COMMIT_MIN = 2;

      // >= one STRONG signal
const COMMIT_MARGIN = 2;

   // leader must beat the runner-up by one STRONG signal

function commitFromEvidence(intent, appKey) {
  const faults = (appKey && CATALOGUE.faults && CATALOGUE.faults[appKey]) || null;
  if (!faults || !Array.isArray(intent.facts) || !intent.facts.length) return null;
  const ranked = [];
  for (const [faultId, node] of Object.entries(faults)) {
    if (!Array.isArray(node.signals) || !node.signals.length) continue;
    if (factConflict(node, intent.facts).contradicted) continue; // STRONG_AGAINST excludes
    const { score, strongSupport } = scoreNodeEvidence(node, intent.facts);
    if (strongSupport >= 1 && score >= COMMIT_MIN) ranked.push({ faultId, node, score });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const runnerUp = ranked[1];
  if (runnerUp && (leader.score - runnerUp.score) < COMMIT_MARGIN) return null; // materially ambiguous
  return { faultId: leader.faultId, node: leader.node, via: 'evidence-commit', score: leader.score };
}

/**
 * Is the grounded fault DECISIVELY supported by the customer's facts (>=1 STRONG signal satisfied,
 * nothing pointing against)? Used to let a grounded-but-low-LLM-confidence diagnosis COMMIT (stop
 * asking) when the evidence is actually strong. Reuses computeEvidence semantics via scoreNodeEvidence.
 */
function evidenceDecisive(node, facts) {
  const { strongSupport, against } = scoreNodeEvidence(node, facts);
  return strongSupport >= 1 && against === 0;
}

// -------- MATERIAL DIAGNOSTIC AMBIGUITY (ask the highest-value discriminator BEFORE committing) --------
// Reusable, evidence-driven. BEFORE committing a symptom/classified diagnosis to a component, check
// whether a materially-DIFFERENT alternative (a different component family, OR a free no-part fix vs a
// replacement part) is still PLAUSIBLE and would be SEPARATED by a currently-UNKNOWN observable
// discriminator fact. If so, we should ASK that discriminator rather than commit — a grounded, fluent
// reply can still pick the wrong component family. Reuses the SAME node `signals[]` as
// computeEvidence/scoreNodeEvidence/factConflict — it is NOT a phrase table, NOT a "grinding->X" rule
// and NOT a journey/appliance special-case. Never runs for authoritative error codes or deterministic
// evidence-commits. Returns { fact, altId, altNode, leaderId } (the pivotal discriminator) or null.
//
// A customer-safe reusable phrasing per pivotal FACT (the "HOW to ask"; the fact decides WHAT). Kept
// tiny and diagnostic-dimension-based (sound quality, timing) — reusable across appliances, never a
// per-fault/journey question. Absent => a generic "describe it a bit more" fallback.
const DISCRIMINATOR_QUESTION = {
  grindingNoise: 'Is it more of a harsh grinding, rumbling or scraping noise, or more of a smooth hum or drone?',
  humNoise: 'Is it more of a smooth hum or drone, or a harsh grinding/rumbling/scraping noise?',
  noiseOnDrain: 'Does the noise happen while it is washing/running, or only when it is draining or pumping the water out?',
  noiseOnWash: 'Does the noise happen while it is washing/running, or only when it is draining or pumping the water out?',
  noiseOnSpin: 'Does the noise happen on the spin, or at another point in the cycle?',
  waterRemaining: 'Is there water left standing in the bottom, or does it drain away fully?',
  waterEntering: 'Does any water start coming into the machine, or does it just sit there without filling?',
  drainEvent: 'When it hums, is there water left in the bottom, and is that happening when the machine should be draining?',
  // Hob: technology (candidate families differ completely by type), affected-zone scope, and the
  // induction pan-test (cookware/user cause vs the zone's own hardware) — all safe, observable.
  inductionHob: 'Is it an induction hob, a ceramic/electric one, or a gas hob?',
  gasHob: 'Is it an induction hob, a ceramic/electric one, or a gas hob?',
  ceramicHob: 'Is it an induction hob, a ceramic/electric one, or a gas hob?',
  singleZoneAffected: 'Is it just this one zone that is affected, or are the others playing up too?',
  allZonesAffected: 'Is it just this one zone that is affected, or are the others playing up too?',
  worksWithKnownGoodPan: 'If you take a pan that heats fine on another zone and put it on the affected one, does it work there too, or does it fail on that zone as well?',
  failsKnownGoodPan: 'If you take a pan that heats fine on another zone and put it on the affected one, does it work there too, or does it fail on that zone as well?',
  // Drying (dishwasher / washer-dryer / tumble-dryer): heat state at the end separates a drying/
  // rinse-aid/airflow issue (usually no part) from a genuine heating fault (a part).
  heatPresent: 'At the end of the cycle, is everything warm or hot to the touch but still wet, or does it come out stone cold?',
  noHeat: 'At the end of the cycle, is everything warm or hot to the touch but still wet, or does it come out stone cold?',
  // Vacuum: "lost power" is ambiguous - won't switch on at all (electrical/battery) vs runs but weak
  // suction (filter/blockage). A cut-out (runs then stops) is a third, materially different state.
  noPower: 'Do you mean it won\u2019t switch on at all, or does it power up but the suction is weak?',
  weakSuction: 'Do you mean it won\u2019t switch on at all, or does it power up but the suction is weak?',
  cutsOut: 'Does it not switch on at all, run then cut out after a short time, or run fine but with weak suction?',
  // Washing-machine leak: WHERE the water first appears best separates the leak sources; WHEN in the
  // cycle is the secondary discriminator. Safe, observable, one question at a time.
  leakAtDoor: 'Where do you first see the water \u2014 around the door/front, at the detergent drawer, underneath the machine, or at the back?',
  leakAtDrawer: 'Where do you first see the water \u2014 around the door/front, at the detergent drawer, underneath the machine, or at the back?',
  leakUnderneath: 'Where do you first see the water \u2014 around the door/front, at the detergent drawer, underneath the machine, or at the back?',
  leakAtRear: 'Where do you first see the water \u2014 around the door/front, at the detergent drawer, underneath the machine, or at the back?',
  leaksOnFill: 'Does it leak while it\u2019s filling with water, while it\u2019s draining or spinning, or all the time?',
  leaksOnDrain: 'Does it leak while it\u2019s filling with water, while it\u2019s draining or spinning, or all the time?',
  // Fridge-freezer warm-fridge/cold-freezer: heavy ice on the rear panel best separates a defrost
  // fault from an evaporator-fan/airflow fault; compartment scope separates fridge-only from whole
  // appliance; fan audibility and blocked vents are secondary. All safe, observable, no disassembly.
  heavyIce: 'Is there a thick build-up of ice or frost on the inside back wall of the freezer, or does it look clear?',
  fanNotAudible: 'With the doors closed and the fridge running, can you hear the internal fan whirring, or is it silent?',
  fanAudible: 'With the doors closed and the fridge running, can you hear the internal fan whirring, or is it silent?',
  ventsBlocked: 'Are the internal air vents (usually at the back or between the two compartments) clear, or is food packed against them?',
  fridgeOnlyWarm: 'Is it just the fridge that\u2019s warm while the freezer is still cold, or are both compartments warm?',
  bothCompartmentsWarm: 'Is it just the fridge that\u2019s warm while the freezer is still cold, or are both compartments warm?',
  // Microwave not-heating: the highest-value SAFE discriminator separates a door/start/interlock fault
  // from the heating (high-voltage) path — all from the doorway, no disassembly, no HV access.
  runsNormally: 'When you press start, does it light up and run normally \u2014 turntable turning and timer counting down \u2014 but the food just stays cold? Or does it struggle to start, only start when you move or reclose the door, or cut out when the door is nudged?',
  doorStartProblem: 'When you press start, does it light up and run normally \u2014 turntable turning and timer counting down \u2014 but the food just stays cold? Or does it struggle to start, only start when you move or reclose the door, or cut out when the door is nudged?',
};

function discriminatorQuestionText(fact, family) {
  const q = DISCRIMINATOR_QUESTION[fact];
  if (!q) return null;
  const vacuumOnly = fact === 'noPower' || fact === 'weakSuction' || fact === 'cutsOut';
  if (vacuumOnly) {
    return discriminatorQuestion(fact, family, { [fact]: { q, families: ['vacuum'] } });
  }
  return q;
}

const _DECLINED_ANSWER_RE = /\b(i don'?t know|don'?t know|not sure|no idea|can'?t tell|cannot tell|can not tell|unsure|couldn'?t say|no way of (?:knowing|telling)|can'?t (?:check|see|tell)|haven'?t (?:checked|looked)|unable to (?:tell|check|say))\b/i;

const _NEGATED_CLAIM_RE = /(?:won'?t|wont|doesn'?t|does not|didn'?t|isn'?t|is not|not)\s+([a-z]+)/gi;

const _NEGATION_BEFORE_RE = /(?:won'?t|wont|doesn'?t|does not|didn'?t|isn'?t|is not|not|never|no)\s+(?:\w+\s+){0,2}$/i;

function stemWord(word) {
  let s = String(word || '').toLowerCase();
  if (s.length <= 3) return s;
  if (s.endsWith('ing') && s.length > 5) {
    s = s.slice(0, -3);
    if (s.length >= 2 && s[s.length - 1] === s[s.length - 2]) s = s.slice(0, -1);
  } else if (s.endsWith('ied') && s.length > 5) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('es') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
}

function customerAffirmsStem(text, stem) {
  const t = String(text || '').toLowerCase().replace(/[\u2019\u02bc]/g, "'");
  const token = String(stem || '').toLowerCase();
  if (token.length < 3) return false;
  const re = new RegExp(`\\b${token}\\w{0,4}\\b`, 'gi');
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 28), m.index);
    if (_NEGATION_BEFORE_RE.test(before)) continue;
    return true;
  }
  return false;
}

function invertedStemsAgainst(text, phrases) {
  const inverted = [];
  for (const phrase of phrases || []) {
    const p = String(phrase || '').toLowerCase().replace(/[\u2019\u02bc]/g, "'");
    _NEGATED_CLAIM_RE.lastIndex = 0;
    let m;
    while ((m = _NEGATED_CLAIM_RE.exec(p))) {
      const stem = stemWord(m[1]);
      if (stem.length < 3) continue;
      if (customerAffirmsStem(text, stem)) inverted.push(stem);
    }
  }
  return [...new Set(inverted)];
}

function collectPositiveObservations(queryText, fault, intent, retrievedDocs) {
  const phrases = [];
  if (intent && intent.fault) phrases.push(intent.fault);
  if (fault && fault.node) {
    phrases.push(fault.node.label, ...(fault.node.synonyms || []));
  }
  for (const d of retrievedDocs || []) {
    if (!d) continue;
    phrases.push(d.label, ...(d.symptoms || []));
  }
  return invertedStemsAgainst(queryText, phrases);
}

function nodeInvertsPositiveObservation(queryText, node) {
  if (!node) return [];
  return invertedStemsAgainst(queryText, [node.label, ...(node.synonyms || [])]);
}

function localisingQuestionAfterObservation(intent, appKey, progress, queryText) {
  const facts = (intent && intent.facts) || [];
  const has = (n, v) => facts.some((f) => f && f.name === n && f.value === v);
  const unknown = (n) => !facts.some((f) => f && f.name === n && f.value && f.value !== 'UNKNOWN');
  const waterFamily = appKey === 'washing-machine' || appKey === 'washer-dryer' || appKey === 'dishwasher';
  const humUnlocalised = has('humNoise', 'TRUE')
    && !has('noiseOnDrain', 'TRUE') && !has('noiseOnSpin', 'TRUE') && !has('noiseOnWash', 'TRUE');
  if (has('waterRemaining', 'TRUE') || has('drumTurns', 'FALSE')) return null;
  const customerBlob = `${((intent && intent.customerTheories) || []).join(' ')} ${((intent && intent.checksReported) || []).join(' ')} ${progressCustomerText(progress)} ${queryText || ''}`;
  const t = customerBlob.replace(/[\u2019\u02bc]/g, "'").toLowerCase();
  const filterAlreadyDone = /\bfilter\b/i.test(t)
    && /\b(clear|cleaned|done|ok|okay|already)\b/i.test(t);
  const proposedDrain = customerProposedDrainPathPart(intent, customerBlob);
  const doorLocked = /\block/.test(t) && !/\b(won'?t lock|will not lock|doesn'?t lock|does not lock|not lock)\b/.test(t);
  const cycleUnstarted = /\b(won'?t start|will not start|doesn'?t start|does not start|never starts?)\b/.test(t);
  if (waterFamily && humUnlocalised && unknown('waterEntering') && unknown('waterRemaining')) {
    if (doorLocked && cycleUnstarted && DISCRIMINATOR_QUESTION.waterEntering) {
      const q = DISCRIMINATOR_QUESTION.waterEntering;
      if (discriminatorAlreadyAsked(progress, q)) return null;
      return { fact: 'waterEntering', question: q };
    }
    if ((proposedDrain || filterAlreadyDone) && DISCRIMINATOR_QUESTION.drainEvent) {
      const q = DISCRIMINATOR_QUESTION.drainEvent;
      if (discriminatorAlreadyAsked(progress, q)) return null;
      return { fact: 'drainEvent', question: q };
    }
  }
  return null;
}

function factKnownOnIntent(intent, name) {
  if (!name) return false;
  return ((intent && intent.facts) || []).some((f) => f && f.name === name && f.value && f.value !== 'UNKNOWN');
}

/**
 * Has the water/drain observation discriminator we asked been answered? Jev is authoritative
 * for the observation facts (Story 2), so "answered" = the corresponding fact is now KNOWN on
 * the intent (Jev re-evaluates the whole conversation each turn, so a follow-up answer surfaces
 * as a known fact). `asked` is the STRUCTURAL discriminator id from askedDiscriminatorFact.
 */
function askedObservationDiscriminatorAnswered(intent, asked) {
  if (asked === 'waterEntering') return factKnownOnIntent(intent, 'waterEntering');
  if (asked === 'drainEvent') {
    return factKnownOnIntent(intent, 'waterRemaining') || factKnownOnIntent(intent, 'noiseOnDrain');
  }
  return false;
}

/**
 * Explicit positive observations constrain the diagnosis. If the leading fault's label/synonyms
 * (or the free-text fault phrase) are the NEGATION of something the customer said happened, do not
 * headline that negation, downrank a simple/complete failure of that function, and ask the
 * discriminator that localises remaining hypotheses. Error-code authority is left untouched.
 * If that discriminator was already asked (or its fact is now known), do not ask it again.
 */
function constrainByPositiveObservations(intent, fault, queryText, retrievedDocs, metric, progress) {
  if (!intent) return fault;
  const positive = collectPositiveObservations(queryText, fault, intent, retrievedDocs);
  if (!positive.length) return fault;
  intent._positiveObservations = positive;
  if (metric) metric.positiveObservations = positive.join('|');
  if (intent.fault && invertedStemsAgainst(queryText, [intent.fault]).length) {
    if (metric) metric.invertedFaultCleared = intent.fault;
    intent.fault = null;
  }
  if (Array.isArray(intent.reportedSymptoms) && intent.reportedSymptoms.length) {
    intent.reportedSymptoms = intent.reportedSymptoms.filter(
      (s) => !invertedStemsAgainst(queryText, [s]).length,
    );
  }
  if (fault && fault.via === 'errorCode') return fault;
  const invertedNode = fault && nodeInvertsPositiveObservation(queryText, fault.node);
  if (!invertedNode || !invertedNode.length) return fault;
  // SCOPED SIBLING guard. A node may cover several independent function-components (e.g. the oven
  // element node spans the fan-oven, grill, base and top elements). When Jev has already scoped the
  // customer's positive observation to a proven-good SIBLING (grill element works) AND a DISTINCT
  // suspect remains in candidateComponents (the fan-oven element), the observation is handled — do
  // NOT unground the shared node and loop a discriminator. Trust the typed provenGood/candidate
  // decision: downrank the sibling, keep the distinct suspect grounded.
  {
    const pg = (intent.provenGood || []).map((c) => canonicalComponent(c)).filter(Boolean);
    const remaining = (intent.candidateComponents || [])
      .map((c) => canonicalComponent(c)).filter((c) => c && !pg.includes(c));
    if (pg.length && remaining.length) {
      if (metric) metric.positiveObsScopedToSibling = `${pg.join('|')}=>${remaining.join('|')}`;
      return fault;
    }
  }
  if (!Array.isArray(intent.alternatives)) intent.alternatives = [];
  if (fault.faultId && !intent.alternatives.includes(fault.faultId)) {
    intent.alternatives.unshift(fault.faultId);
  }
  const loc = localisingQuestionAfterObservation(intent, applianceKey(intent.applianceType), progress, queryText);
  const askedFact = askedDiscriminatorFact(progress);
  const answeredFact = (loc && loc.fact && factKnownOnIntent(intent, loc.fact))
    ? loc.fact
    : (askedFact && factKnownOnIntent(intent, askedFact) ? askedFact : '');
  const alreadyAsked = Boolean(askedFact) || (loc && discriminatorAlreadyAsked(progress, loc.question));
  intent.primaryFinding = null;
  intent.candidateComponents = [];
  intent.nextBestCheck = null;
  intent.faultId = null;
  if (metric) metric.observationUngrounded = `${fault.faultId}:${invertedNode.join('|')}`;
  if (!loc || alreadyAsked || answeredFact) {
    intent._observationAmbiguity = null;
    intent.nextCheckCustomerSafe = false;
    intent.furtherGenericCheckJustified = false;
    if (discriminatorAlreadyAsked(progress, intent.clarifyingQuestion)) intent.clarifyingQuestion = null;
    if (answeredFact) {
      intent._discriminatorJustAnswered = answeredFact;
      if (metric) metric.discriminatorJustAnswered = answeredFact;
    }
    return null;
  }
  intent._observationAmbiguity = loc;
  intent.needMoreInfo = true;
  intent.clarifyingQuestion = loc.question;
  return null;
}

function deriveDeclinedFacts(text) {
  const t = String(text || '');
  if (!t || !_DECLINED_ANSWER_RE.test(t)) return [];
  const lower = t.toLowerCase();
  const out = [];
  for (const [fact, q] of Object.entries(DISCRIMINATOR_QUESTION)) {
    if (!q) continue;
    const needle = String(q).toLowerCase().slice(0, 48);
    if (needle && lower.includes(needle)) out.push(fact);
  }
  return [...new Set(out)];
}

function _canonComps(node) {
  const list = (node && Array.isArray(node.components)) ? node.components : [];
  return new Set(list.map((c) => canonicalComponent(String(c || ''))).filter(Boolean));
}

function _componentsDisjoint(a, b) {
  for (const c of a) if (b.has(c)) return false;
  return true;
}

// The PRIMARY (check-first / stock) component defines a node's component family. Comparing primary
// components avoids a generic shared tertiary suspect (e.g. "main pcb", present on many nodes) making
// two genuinely different repairs — a radiant element vs an induction generator module — look like
// the same family and suppressing a material discriminator.
function _primaryComp(node) {
  const list = (node && Array.isArray(node.components)) ? node.components : [];
  const first = list.find((c) => c && String(c).trim());
  return first ? canonicalComponent(String(first)) : null;
}

// Materially different when: one side is a no-part (ADVICE_ONLY) fix and the other a replacement;
// OR their PRIMARY components differ; OR (both have parts) their component sets are fully disjoint.
function _materiallyDifferent(leaderNode, altNode) {
  if ((altNode.outcome === 'ADVICE_ONLY') !== (leaderNode.outcome === 'ADVICE_ONLY')) return true;
  const lp = _primaryComp(leaderNode);
  const ap = _primaryComp(altNode);
  if (lp && ap && lp !== ap) return true;
  return _componentsDisjoint(_canonComps(leaderNode), _canonComps(altNode));
}

function materialAmbiguity(leaderId, leaderNode, facts, appKey, declinedFacts) {
  if (!leaderNode || !Array.isArray(leaderNode.signals) || !leaderNode.signals.length) return null;
  // Advice-first nodes: do not delay a no-part check to discriminate a replacement part.
  // Progress with the advice; a heating-hardware leader with unknown heat still asks below.
  if (leaderNode.outcome === 'ADVICE_ONLY') return null;
  const faults = (appKey && CATALOGUE.faults && CATALOGUE.faults[appKey]) || null;
  if (!faults || !Array.isArray(facts)) return null;
  // NOTE: an EMPTY facts set is allowed — a discriminator can be material before any fact is known
  // (e.g. "dishwasher not drying" with heat-state unknown). The contradiction test below still
  // requires that some ANSWER could rule out the leader, so this never fires spuriously.
  // A leader the customer's own facts already CONTRADICT is not a valid leader to defend — the
  // fact-fidelity gate owns re-grounding it. Never ask a discriminator around a contradicted leader.
  if (factConflict(leaderNode, facts).contradicted) return null;
  const known = new Set(facts.filter((f) => f && f.value && f.value !== 'UNKNOWN')
    .map((f) => String(f.name).toLowerCase()));
  // A declined discriminator must not be re-asked. Facts that share the SAME customer question
  // (e.g. heatPresent / noHeat) are one question — declining one declines the pair.
  const declinedQuestions = new Set();
  for (const name of declinedFacts || []) {
    if (!name) continue;
    known.add(String(name).toLowerCase());
    const q = DISCRIMINATOR_QUESTION[name] || DISCRIMINATOR_QUESTION[String(name)];
    if (q) declinedQuestions.add(q);
  }
  if (declinedQuestions.size) {
    for (const [fact, q] of Object.entries(DISCRIMINATOR_QUESTION)) {
      if (declinedQuestions.has(q)) known.add(String(fact).toLowerCase());
    }
  }
  const leaderScore = scoreNodeEvidence(leaderNode, facts).score;
  let best = null;
  for (const [altId, altNode] of Object.entries(faults)) {
    if (altId === leaderId) continue;
    if (!Array.isArray(altNode.signals) || !altNode.signals.length) continue;
    if (factConflict(altNode, facts).contradicted) continue; // already ruled out -> not a live alternative
    // Materially different: a different component family (by PRIMARY component), OR part-vs-no-part.
    if (!_materiallyDifferent(leaderNode, altNode)) continue;
    const altScore = scoreNodeEvidence(altNode, facts).score;
    if ((leaderScore - altScore) >= COMMIT_MARGIN) continue; // leader already decisively ahead of this alt
    // Pivotal UNKNOWN discriminator: a currently-unknown fact whose value would lift the alt to
    // tie/beat the leader — either STRONG_SUPPORT on the alt, or (STRONG_)AGAINST on the leader.
    for (const sig of [...altNode.signals, ...leaderNode.signals]) {
      const f = String(sig.fact || '').toLowerCase();
      if (!f || known.has(f)) continue; // already answered -> not a discriminator to ask again (no loop)
      // Only ask a discriminator we actually know how to phrase as ONE safe, observable question.
      // This confines the gate to the curated set of high-value MATERIAL dimensions (sound quality,
      // timing, water-state, hob technology/scope/pan, drying heat-state) and prevents asking a vague
      // generic question for an arbitrary fact.
      if (!DISCRIMINATOR_QUESTION[sig.fact]) continue;
      // A complete drive failure after a successful fill is not localised by asking whether
      // water remains — that question belongs to drain vs spin, not "drum never turns".
      if (String(sig.fact).toLowerCase() === 'waterremaining') {
        const has = (n, v) => facts.some((row) => row && row.name === n && row.value === v);
        // A reported drive failure is not localised by asking whether water remains.
        if (has('drumTurns', 'FALSE')) continue;
      }
      // PIVOTAL = an ANSWER to this fact could RULE OUT the leader (factConflict) AND leave the
      // materially-different alternative viable and positively supported. This is what makes the
      // question genuinely change the leading component FAMILY, and it is why the gate can fire even
      // with no facts yet (heat-state unknown) without firing when the leader is merely weakened on a
      // tangential dimension (a noise-timing fact that only mildly counts AGAINST a bearings commit
      // never CONTRADICTS it, so it is not pivotal).
      let pivotal = false;
      for (const hypoVal of ['TRUE', 'FALSE']) {
        const hypo = facts.concat([{ name: sig.fact, value: hypoVal }]);
        if (!factConflict(leaderNode, hypo).contradicted) continue;        // must be able to rule out the leader
        if (factConflict(altNode, hypo).contradicted) continue;            // alt must survive that answer
        if (scoreNodeEvidence(altNode, hypo).score <= 0) continue;         // and be positively supported
        pivotal = true; break;
      }
      if (pivotal && (!best || altScore > best._altScore)) {
        best = { fact: sig.fact, altId, altNode, leaderId, _altScore: altScore };
      }
    }
  }
  return best;
}

// The customer already had a diagnostic description AND their latest move is that they cannot
// resolve a discriminator ("I'm not sure", "don't know", "can't tell"). Used to stop the material-
// ambiguity gate re-asking the same question; the most-likely grounded fault is then stated instead.
// First-turn hedges ("I'm not sure what's wrong with my washer") have no prior symptom → false.
const _DECLINED_DISCRIMINATOR_RE = /\b(?:i(?:['’]m| am) not sure|not sure(?: about (?:that|it|this))?(?:\s|$)|don['’]?t know|do not know|can['’]?t tell|cannot tell|no idea|not a clue|couldn['’]?t say|haven['’]?t (?:a )?clue)\b/i;

function customerDeclinedDiscriminator(text) {
  const t = String(text || '').replace(/[\u2019\u02bc]/g, "'");
  if (!t) return false;
  const re = new RegExp(_DECLINED_DISCRIMINATOR_RE.source, 'gi');
  let lastIdx = -1, m;
  while ((m = re.exec(t))) lastIdx = m.index;
  if (lastIdx < 0) return false;
  const prior = t.slice(0, lastIdx).trim();
  const after = t.slice(lastIdx).replace(_DECLINED_DISCRIMINATOR_RE, '');
  const afterContent = after.replace(/[.!?,;:'"\s]+/g, '');
  if (afterContent.length > 40) return false;
  return prior.length >= 12;
}

function catalogueNodeFromRetrievalDoc(doc, appKey) {
  if (!doc || !appKey) return null;
  const faults = CATALOGUE.faults && CATALOGUE.faults[appKey];
  if (!faults) return null;
  let fid = doc.faultId ? String(doc.faultId) : '';
  const kid = String(doc.knowledgeId || '');
  if (!fid && kid.includes(':')) {
    const colon = kid.indexOf(':');
    const fam = kid.slice(0, colon);
    const rest = kid.slice(colon + 1);
    if (fam === appKey || applianceKey(fam) === appKey) fid = rest;
  }
  if (fid && faults[fid]) return { faultId: fid, node: faults[fid], via: 'classified' };
  return null;
}

/**
 * After the customer cannot answer a discriminator, stop asking and ground to the best
 * ALREADY-AVAILABLE evidence. Never invents a node: existing grounded fault, then resolveFault
 * (faultId / fault field / synonym), then commitFromEvidence, then the first retrieval doc that
 * maps to a catalogue node for this appliance. Clears needMoreInfo / clarifyingQuestion.
 * First-turn hedges never enter (customerDeclinedDiscriminator is false). Mutates intent in place.
 */
function progressAfterDeclinedDiscriminator(intent, fault, docs, queryText, cannotAnswer) {
  if (!intent) return { fault: fault || null, progressed: false };
  // Fire on Jev's TYPED cannot-answer (authoritative) OR the legacy prose fallback. A sparse
  // "I'm not sure" that the regex misses but Jev typed as cannot_answer still progresses. The CALLER
  // only invokes this when no materially-different ALTERNATIVE discriminator was chosen this turn, so
  // here we always ground the declined discriminator to the best available evidence.
  if (!cannotAnswer && !customerDeclinedDiscriminator(queryText)) {
    return { fault: fault || null, progressed: false };
  }
  intent.needMoreInfo = false;
  intent.clarifyingQuestion = null;
  if (intent._materialAmbiguity) delete intent._materialAmbiguity;
  intent._discriminatorDeclined = true;

  if (fault && fault.node) return { fault, progressed: true };

  const resolved = resolveFault(intent);
  if (resolved) return { fault: resolved, progressed: true };

  const committed = commitFromEvidence(intent, applianceKey(intent.applianceType));
  if (committed) {
    intent.faultId = committed.faultId;
    return { fault: committed, progressed: true };
  }

  const appKey = applianceKey(intent.applianceType);
  for (const d of Array.isArray(docs) ? docs : []) {
    const hit = catalogueNodeFromRetrievalDoc(d, appKey);
    if (hit) {
      intent.faultId = hit.faultId;
      return { fault: hit, progressed: true };
    }
  }
  return { fault: null, progressed: true };
}

module.exports = {
  neutralizeConditionLimitedFacts, collectEvidence, adjustDifferential, computeEvidence, factConflict,
  chooseCompatibleFault, askedDiscriminatorFact, discriminatorAlreadyAsked, allAskedDiscriminatorFacts,
  dropUnstatedComponentHum, mergeDerivedFacts, scoreNodeEvidence, commitFromEvidence, evidenceDecisive,
  DISCRIMINATOR_QUESTION, discriminatorQuestionText, invertedStemsAgainst, collectPositiveObservations,
  localisingQuestionAfterObservation, factKnownOnIntent, askedObservationDiscriminatorAnswered,
  constrainByPositiveObservations, deriveDeclinedFacts, materialAmbiguity, customerDeclinedDiscriminator,
  progressAfterDeclinedDiscriminator,
};
