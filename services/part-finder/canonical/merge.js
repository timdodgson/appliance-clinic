'use strict';
/**
 * Pure deterministic merge: merge(state, classification, {turn}) -> {state, trace}. services/whichpart-api/docs/canonical-architecture.md §5.
 *
 * Implements canonical-semantic-state.md §12 rules M0–M21 (M21 is the policy-side helper in
 * requests.js; merge never issues requests). Inputs are typed only: a cs/1 state and an mc/1
 * classification. No prose, transcript, Jev probabilities, regex semantics or diagnostics are read.
 * The input state is never mutated. The same inputs always produce the same output.
 *
 * Turn numbering: `turn` defaults to state.version + 1 and becomes the new state.version
 * (the BFF persists it). Every Fact/turn field in the output uses this value.
 */

const {
  SCHEMA_VERSION, HAZARD_LEVEL, strongestLevel, newFact, supersedeFact, emptyFact, emptyState, activeProblem,
} = require('./cs1.js');
const requests = require('./requests.js');

const clone = (x) => JSON.parse(JSON.stringify(x));

// Exclusive observation dimensions in canonical keys (source: part-finder EXCLUSIVE_OBSERVATION_GROUPS,
// with the keys canonical moved elsewhere removed: singleZone/allZones -> problem.scope; fanAudible pair
// collapsed in mc/1). fridgeOnlyWarm participates only as a D1-derived member.
const EXCLUSIVE_GROUPS = [
  ['inductionHob', 'gasHob', 'ceramicHob'],
  ['worksWithKnownGoodPan', 'failsKnownGoodPan'],
  ['heatPresent', 'noHeat'],
  ['noPower', 'cutsOut', 'weakSuction'],
  ['leakAtDoor', 'leakAtDrawer', 'leakUnderneath', 'leakAtRear', 'leakAtFilter'],
  ['fridgeOnlyWarm', 'bothCompartmentsWarm'],
  ['runsNormally', 'doorStartProblem'],
];

const norm = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const basisOrInferred = (b) => (b === 'stated' || b === 'read_from_image' ? b : 'inferred');

/**
 * Identity-style Fact merge (M1–M5). Returns {fact, rule}.
 *   kind: 'identity' (appliance/make/model: stated contradiction -> keep + conflict)
 */
function mergeIdentityFact(old, incomingValue, incomingBasis, turn, corrected) {
  if (incomingValue == null) return { fact: old, rule: null };
  const basis = basisOrInferred(incomingBasis);
  if (old.value == null) return { fact: { ...newFact(incomingValue, basis, turn), ...carry(old) }, rule: 'M1' };
  if (old.value === incomingValue) {
    // M2: repeated. Upgrade inferred/read_from_image -> stated; keep the first-assertion turn.
    if (basis === 'stated' && old.basis !== 'stated') return { fact: { ...old, basis: 'stated' }, rule: 'M2' };
    return { fact: old, rule: 'M2' };
  }
  const clearConflict = (f) => { const o = { ...f }; if (o.conflict && typeof o.conflict === 'object') delete o.conflict; return o; };
  if (corrected) return { fact: clearConflict(supersedeFact(old, incomingValue, basis, turn, 'correction')), rule: 'M3' };
  if (old.basis !== 'stated') return { fact: clearConflict(supersedeFact(old, incomingValue, basis, turn, 'update')), rule: 'M4' };
  // M5: stated contradiction, no correction -> keep the old value, record the conflict.
  return { fact: { ...old, conflict: { value: incomingValue, basis, turn } }, rule: 'M5' };
}
function carry(old) {
  const out = {};
  if ('confirmed' in old) out.confirmed = old.confirmed;
  if ('conflict' in old && typeof old.conflict === 'boolean') out.conflict = old.conflict;
  return out;
}

/** Problem-field Fact merge (journey / faultDomain / scope). Message problem facts are stated. */
function mergeProblemFact(old, value, turn, corrected) {
  if (value == null) return { fact: old, rule: null };
  const cur = old || emptyFact();
  if (cur.value == null) return { fact: newFact(value, 'stated', turn), rule: 'M1' };
  if (cur.value === value) return { fact: cur.basis === 'stated' ? cur : { ...cur, basis: 'stated' }, rule: 'M2' };
  if (corrected) return { fact: supersedeFact(cur, value, 'stated', turn, 'correction'), rule: 'M3' };
  if (cur.basis !== 'stated') return { fact: supersedeFact(cur, value, 'stated', turn, 'update'), rule: 'M4' };
  return { fact: { ...cur, conflict: { value, basis: 'stated', turn } }, rule: 'M5' };
}

function openProblem(next, turn, origin) {
  const id = `p${next.problems.length + 1}`;
  const p = {
    id, status: 'active', origin: origin || 'stated',
    journey: emptyFact(), faultDomain: emptyFact(), scope: emptyFact(),
    openedTurn: turn, resolvedTurn: null, recurrences: [], archive: null,
  };
  next.problems.push(p);
  return p;
}

function hasProblemContent(pr) {
  return Boolean(pr && (pr.journey || pr.faultDomain || pr.scope));
}

function fills(c, target) {
  if (!target) return false;
  if (['appliance', 'make', 'model'].includes(target)) return Boolean(c.identity[target] && c.identity[target].value);
  if (target === 'fuel') return Boolean(c.identity.fuel);
  if ((c.checks || []).some((k) => k.check === target && k.status === 'done')) return true;
  const obsKey = requests.CHECK_OUTCOME_OBSERVATION[target]; // G3: a functional check's outcome is an observation
  if (obsKey && (c.observations || []).some((o) => o.key === obsKey)) return true;
  return (c.observations || []).some((o) => o.key === target);
}

/**
 * merge(state, classification, opts) -> { state, trace }
 * trace = { turn, rules: [ruleId...], requestOutcome }
 */
function merge(state, classification, opts = {}) {
  const prev = state && state.schemaVersion === SCHEMA_VERSION ? state : emptyState(opts.sessionId);
  const c = classification;
  const turn = Number.isInteger(opts.turn) ? opts.turn : prev.version + 1;
  const rules = [];
  const hit = (r) => { if (r && !rules.includes(r)) rules.push(r); };
  let next = clone(prev);
  next.version = turn;

  // ---- M0: prompt attack / unrelated -> no semantic merge; pending request stays pending ----------
  if (!c || c.scope === 'prompt_attack' || c.scope === 'unrelated') {
    next.scope.lastRequestClass = c ? c.scope : null;
    next.scope.refusals += 1;
    hit('M0');
    return { state: next, trace: { turn, rules, requestOutcome: null } };
  }
  next.scope.lastRequestClass = c.scope;

  const corrections = new Set((c.reply && c.reply.correction) || []);
  const req = requests.pending(prev);
  const pr = c.problem || {};

  // ---- M11 (part 1): different problem on a DIFFERENT appliance = a new job ------------------------
  const incomingAppliance = c.identity.appliance && c.identity.appliance.value;
  const applianceChanged = Boolean(incomingAppliance && next.identity.appliance.value
    && incomingAppliance !== next.identity.appliance.value);
  if (pr.relation === 'different') {
    const archive = applianceChanged ? {
      identity: { appliance: next.identity.appliance, make: next.identity.make, model: next.identity.model,
        displayedCodes: next.identity.displayedCodes, modelStatus: next.identity.modelStatus },
      evidence: next.evidence,
    } : null;
    for (const p of next.problems) {
      if (p.status === 'active') { p.status = 'superseded'; p.resolvedTurn = turn; if (archive) p.archive = archive; }
    }
    if (applianceChanged) {
      next.identity.appliance = supersedeFact(next.identity.appliance, incomingAppliance,
        basisOrInferred(c.identity.appliance.basis), turn, 'update');
      next.identity.make = emptyFact();
      next.identity.model = emptyFact({ confirmed: false });
      next.identity.displayedCodes = [];
      next.identity.modelStatus = null;
      next.evidence = emptyState().evidence;
    }
    next.resolution = null;
    hit('M11');
  }

  // ---- identity (M1–M5, M8, M9, M16) ------------------------------------------------------------------
  for (const field of ['appliance', 'make']) {
    const inc = c.identity[field];
    if (field === 'appliance' && pr.relation === 'different' && applianceChanged) continue; // set by M11
    const r = mergeIdentityFact(next.identity[field], inc && inc.value, inc && inc.basis, turn, corrections.has(`identity.${field}`));
    next.identity[field] = r.fact; hit(r.rule);
  }
  // model (M8): stated -> confirmed + known; read_from_image -> unconfirmed until confirmed (M2 upgrade).
  {
    const inc = c.identity.model;
    const r = mergeIdentityFact(next.identity.model, inc && inc.value, inc && inc.basis, turn, corrections.has('identity.model'));
    next.identity.model = r.fact; hit(r.rule);
    if (inc && inc.value && r.rule !== 'M5') {
      const confirmed = next.identity.model.basis === 'stated';
      next.identity.model.confirmed = confirmed;
      if (confirmed) { next.identity.modelStatus = 'known'; hit('M8'); }
    }
  }
  // M9: unavailable is monotonic until a confirmed model; will_look -> pending_lookup (not a refusal).
  if (c.identity.modelStatus && !next.identity.model.confirmed) {
    if (c.identity.modelStatus === 'unavailable') { next.identity.modelStatus = 'unavailable'; hit('M9'); }
    else if (c.identity.modelStatus === 'will_look' && next.identity.modelStatus !== 'unavailable') {
      next.identity.modelStatus = 'pending_lookup'; hit('M9');
    }
  }
  // fuel (M1–M5): a stated contradiction sets conflict=true and value null.
  if (c.identity.fuel) {
    const old = next.identity.fuel;
    const v = c.identity.fuel;
    if (old.value == null && !old.conflict) { next.identity.fuel = { ...newFact(v, 'stated', turn), conflict: false }; hit('M1'); }
    else if (old.value === v) hit('M2');
    else if (corrections.has('identity.fuel')) { next.identity.fuel = { ...supersedeFact(old, v, 'stated', turn, 'correction'), conflict: false }; hit('M3'); }
    else if (old.conflict) { hit('M5'); }
    else { next.identity.fuel = { ...supersedeFact(old, null, null, turn, 'conflict'), conflict: true }; hit('M5'); }
  }
  // M16: displayed codes — append; latest active; a token now typed as the model supersedes the code.
  if (c.identity.displayedCode) {
    const code = c.identity.displayedCode;
    const active = next.identity.displayedCodes.filter((f) => f.status === 'active');
    const last = active[active.length - 1];
    if (!last || last.value !== code) {
      for (const f of active) f.status = 'superseded';
      next.identity.displayedCodes.push(newFact(code, 'stated', turn));
    }
    hit('M16');
  }
  if (next.identity.model.value) {
    for (const f of next.identity.displayedCodes) {
      if (f.status === 'active' && norm(f.value) === norm(next.identity.model.value)) { f.status = 'superseded'; hit('M16'); }
    }
  }

  // ---- M17 intent ---------------------------------------------------------------------------------------
  if (c.intent) { next.intent.active = c.intent; next.intent.history.push({ intent: c.intent, turn }); hit('M17'); }

  // ---- problems (M11 same/additional, M1–M5 on problem facts, M13 recurrence) ----------------------------
  if (hasProblemContent(pr)) {
    let target = activeProblem(next);
    if (pr.relation === 'additional' || pr.relation === 'different' || !target) {
      // M13: same journey reported again after the last problem was resolved -> re-open it.
      const last = next.problems[next.problems.length - 1];
      if (!target && pr.relation !== 'additional' && pr.relation !== 'different'
          && last && last.status === 'resolved' && pr.journey && last.journey.value === pr.journey) {
        last.status = 'active'; last.resolvedTurn = null; last.recurrences.push(turn);
        next.resolution = 'unresolved';
        target = last; hit('M13');
      } else {
        target = openProblem(next, turn, 'stated');
        if (pr.relation === 'additional') hit('M11');
      }
    }
    for (const f of ['journey', 'faultDomain', 'scope']) {
      const path = f === 'journey' ? 'problem.journey' : (f === 'scope' ? 'problem.scope' : 'problem.faultDomain');
      const r = mergeProblemFact(target[f], pr[f], turn, corrections.has(path));
      target[f] = r.fact; hit(r.rule);
    }
    if (target.origin === 'derived' && target.journey.basis === 'stated') target.origin = 'stated';
  }

  // ---- observations (M1–M3, M5 latest stated wins) ----------------------------------------------------------
  for (const o of c.observations || []) {
    const old = next.evidence.observations[o.key];
    if (!old || old.value == null) { next.evidence.observations[o.key] = newFact(o.value, 'stated', turn); hit('M1'); continue; }
    if (old.value === o.value) {
      // M2 keeps the first-assertion turn; `lastTurn` records the re-statement so a re-test after a
      // clearance ("still won't drain") is ordered after it (Journey 1 diagnostics restoredAfter/failsAfter).
      next.evidence.observations[o.key] = old.basis === 'stated' ? { ...old, lastTurn: turn } : { ...old, basis: 'stated', turn };
      hit('M2'); continue;
    }
    const corrected = corrections.has(`observations.${o.key}`);
    next.evidence.observations[o.key] = supersedeFact(old, o.value, 'stated', turn, corrected ? 'correction' : 'update');
    hit(corrected ? 'M3' : (old.basis === 'stated' ? 'M5' : 'M4'));
  }

  // ---- M3b: a correction of an exclusive observation that the message replaces with a sibling ------------
  // ("sorry, it's actually at the back" corrects leakAtDoor while stating leakAtRear): the corrected member is
  // superseded to FALSE by correction. Typed only (correction path + exclusivity group); never prose.
  for (const path of corrections) {
    const m = /^observations\.(.+)$/.exec(path);
    if (!m || (c.observations || []).some((o) => o.key === m[1])) continue;
    const group = EXCLUSIVE_GROUPS.find((g) => g.includes(m[1]));
    const old = next.evidence.observations[m[1]];
    if (group && old && old.value === true && (c.observations || []).some((o) => o.value === true && o.key !== m[1] && group.includes(o.key))) {
      next.evidence.observations[m[1]] = supersedeFact(old, false, 'stated', turn, 'correction');
      hit('M3');
    }
  }

  // ---- checks (M10) ---------------------------------------------------------------------------------------------
  for (const k of c.checks || []) {
    const old = next.evidence.checks[k.check];
    const corrected = corrections.has(`checks.${k.check}`);
    const hist = old ? [...(old.history || []), { status: old.status, result: old.result, turn: old.turn,
      supersededBy: corrected ? 'correction' : 'update' }].slice(-5) : [];
    next.evidence.checks[k.check] = { status: k.status, result: k.result || null, turn, history: hist };
    if (k.status === 'declined' || k.status === 'unable') {
      next.declined.push({ target: k.check, kind: k.status, turn, resolvedTurn: null });
      hit('M6');
    }
    hit('M10');
  }

  // ---- M6 cannot-answer / refusal of the pending request -----------------------------------------------------------
  const tp = c.reply && c.reply.toPending;
  // A typed check status for the pending target is more specific than the reply class: "not done yet"
  // (check not_done) is never a refusal / cannot-answer, so it does not block the target.
  const pendingNotDone = req && (c.checks || []).some((k) => k.check === req.target && k.status === 'not_done');
  if (req && !pendingNotDone && (tp === 'cannot_answer' || tp === 'declined')) {
    const already = next.declined.some((d) => d.target === req.target && d.turn === turn);
    if (!already) next.declined.push({ target: req.target, kind: tp, turn, resolvedTurn: null });
    if (req.target === 'model' && !next.identity.model.confirmed) next.identity.modelStatus = 'unavailable';
    hit('M6');
  }

  // ---- M7 a later answer resolves an earlier decline -------------------------------------------------------------
  for (const d of next.declined) {
    if (d.resolvedTurn == null && d.turn < turn && fills(c, d.target)) { d.resolvedTurn = turn; hit('M7'); }
  }

  // ---- M12 resolution -------------------------------------------------------------------------------------------
  const outcome = c.reply && c.reply.outcome;
  if (outcome) {
    const ap = activeProblem(next);
    if (outcome === 'resolved') {
      if (ap) { ap.status = 'resolved'; ap.resolvedTurn = turn; }
      next.resolution = 'resolved';
    } else {
      next.resolution = outcome; // temporary | unresolved — problem stays active
    }
    hit('M12');
  }

  // ---- M14 safety (append-only history; correction marks earlier active hazards corrected) ------------------------
  if (corrections.has('safety.hazard')) {
    for (const h of next.safety.hazards) {
      if (h.status === 'active' && h.turn < turn) { h.status = 'corrected'; h.correctedTurn = turn; }
    }
    hit('M14');
  }
  if (c.safety && c.safety.hazard) {
    next.safety.hazards.push({ hazard: c.safety.hazard, turn, status: 'active', correctedTurn: null });
    hit('M14');
  }
  next.safety.peakLevel = strongestLevel([prev.safety.peakLevel,
    ...next.safety.hazards.map((h) => HAZARD_LEVEL[h.hazard] || 'NORMAL_DIAGNOSTIC')]);
  next.safety.activeLevel = strongestLevel(next.safety.hazards
    .filter((h) => h.status === 'active').map((h) => HAZARD_LEVEL[h.hazard] || 'NORMAL_DIAGNOSTIC'));

  // ---- M15 unsafe action (append-only) ------------------------------------------------------------------------------
  if (c.safety && c.safety.unsafeAction) {
    next.safety.unsafeActions.push({ action: c.safety.unsafeAction, turn });
    hit('M15');
  }

  // ---- M18 / M18a derived facts (recomputed every turn; never overwrite stated) ----------------------------------------
  applyDerived(next, turn, hit);

  // ---- M19 appliance establishment (derived) ------------------------------------------------------------------------------
  const a = next.identity.appliance;
  next.identity.applianceEstablishment = a.value == null ? 'unknown' : (a.basis === 'stated' ? 'established' : 'working');
  hit('M19');

  // ---- M20 request outcome ----------------------------------------------------------------------------------------------------
  let requestOutcome = null;
  if (req) {
    // new facts are judged against the state BEFORE this message was merged
    const r = requests.recordOutcome(next, c, turn, prev);
    next = r.state; requestOutcome = r.outcome; hit('M20');
    // G3: a pending functional check answered through its outcome observation is a performed check.
    const obsKey = requests.CHECK_OUTCOME_OBSERVATION[req.target];
    if (r.outcome === 'answered' && req.slot === 'CHECK' && obsKey && !(c.checks || []).some((k) => k.check === req.target)) {
      const old = next.evidence.checks[req.target];
      const hist = old ? [...(old.history || []), { status: old.status, result: old.result, turn: old.turn, supersededBy: 'update' }].slice(-5) : [];
      next.evidence.checks[req.target] = { status: 'done', result: null, turn, history: hist };
      hit('M20');
    }
  }

  return { state: next, trace: { turn, rules, requestOutcome } };
}

function applyDerived(next, turn, hit) {
  const obs = next.evidence.observations;
  // Drop last turn's derived values; recompute from current sources.
  for (const k of Object.keys(obs)) if (obs[k] && obs[k].basis === 'derived') delete obs[k];
  const setDerived = (key, value, rule) => {
    if (obs[key] && obs[key].basis !== 'derived') return; // never overwrite a stated value
    obs[key] = newFact(value, 'derived', turn, { derivedBy: rule });
    hit('M18a');
  };
  // D1: fridge-only scope -> fridgeOnlyWarm (catalogue signals[] consumer).
  const ap = activeProblem(next);
  if (ap && ap.scope && ap.scope.value === 'fridge_only') setDerived('fridgeOnlyWarm', true, 'D1');
  // D2 / M18: exclusivity siblings of a TRUE member are FALSE.
  for (const group of EXCLUSIVE_GROUPS) {
    const on = group.find((k) => obs[k] && obs[k].value === true);
    if (!on) continue;
    for (const k of group) if (k !== on) setDerived(k, false, 'D2');
    hit('M18');
  }
  // D4: a noise the customer hears while it tries to drain means the drain pump is running (not silent).
  if (obs.noiseOnDrain && obs.noiseOnDrain.value === true) setDerived('pumpHumming', true, 'D4');
  // D3: active supply trip and no other active (non-derived) journey -> derived trips-electrics problem.
  const tripActive = next.safety.hazards.some((h) => h.hazard === 'supply_trip' && h.status === 'active');
  const statedJourney = next.problems.some((p) => p.status === 'active' && p.journey && p.journey.value
    && p.journey.basis !== 'derived');
  const derivedIdx = next.problems.findIndex((p) => p.origin === 'derived' && p.status === 'active'
    && p.journey && p.journey.basis === 'derived');
  if (tripActive && !statedJourney) {
    if (derivedIdx < 0) {
      const p = openProblem(next, turn, 'derived');
      p.journey = newFact('trips-electrics', 'derived', turn, { derivedBy: 'D3' });
    }
    hit('M18a');
  } else if (derivedIdx >= 0) {
    next.problems.splice(derivedIdx, 1); // derived, not history: disappears when its source is gone
  }
}

/** Fold classifications from an empty state (replay). */
function replay(classifications, opts = {}) {
  let s = emptyState(opts.sessionId);
  for (const c of classifications) s = merge(s, c, {}).state;
  return s;
}

module.exports = { merge, replay, EXCLUSIVE_GROUPS };
