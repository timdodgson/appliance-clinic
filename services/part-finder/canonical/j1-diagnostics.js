'use strict';
/**
 * Journey 1 diagnostics — washing machine · not draining. PURE, deterministic.
 *
 * Design: services/whichpart-api/docs/diagnostics/wm-not-draining-evidence.md (§3 families, §5 projection,
 * §6 signals, §7 codes, §8 ranking/commit, §10 part evidence (diagnostic half), §15 fixtures D01–D23).
 *
 *   diagnose(state, {codeArea}) -> inferred
 *   evidenceFacts(state, {codeArea}) -> [{name, value:'TRUE'|'FALSE'}]   (projection, never persisted)
 *   codeAreaFor(state, errorCodesTable) -> 'not-draining' | 'drain-pump' | null
 *
 * Reads cs/1 ONLY (observations, checks, displayedCodes via codeArea, resolution). Never reads prose,
 * the transcript, requests[] (policy's) or safety (D18: diagnostics is safety-independent).
 * scoreNodeEvidence / factConflict semantics are identical to part-finder-lambda.js (equivalence-tested).
 */

const COMMIT_MIN = 2;
const COMMIT_MARGIN = 2;

const FAMILY = {
  FB: 'filter-blockage', IO: 'impeller-obstruction', HR: 'hose-or-waste-restriction',
  HW: 'household-waste-backflow', ES: 'excess-suds', DP: 'drain-pump', PL: 'pressure-or-level', CT: 'control',
};
// §8 step 5: prior = check-first order, tie-break only.
const PRIOR = ['FB', 'IO', 'HR', 'ES', 'DP', 'PL', 'CT', 'HW'];

const SS = 'STRONG_SUPPORT', S = 'SUPPORT', A = 'AGAINST', SA = 'STRONG_AGAINST';
// §6 signals table, authored per family (fact -> effect).
const SIGNALS = {
  FB: {
    waterRemaining: S, pumpHumming: S, commandedDrainFails: S, commandedDrainWorks: A, filterClear: SA,
    filterObstructionCleared: SS, filterObstructionStuck: SS, restoredAfterFilterClear: SS, failsAfterFilterClear: SA,
    waterReturnsAfterDrain: A, drainsNormally: SA, filterDamaged: SS, codeDrainArea: S,
  },
  IO: {
    waterRemaining: S, pumpHumming: S, commandedDrainFails: S, commandedDrainWorks: SA, impellerClear: SA,
    impellerObstructionCleared: SS, impellerJammed: SS, restoredAfterImpellerClear: SS, failsAfterImpellerClear: SA,
    waterReturnsAfterDrain: A, drainsNormally: SA, codeDrainArea: S,
  },
  HR: {
    waterRemaining: S, pumpHumming: S, pumpSilent: A, commandedDrainFails: S, commandedDrainWorks: A, hoseClear: SA,
    hoseRestrictionCleared: SS, hoseRestrictionStuck: SS, restoredAfterHoseClear: SS, failsAfterHoseClear: SA,
    waterReturnsAfterDrain: A, drainsNormally: SA, hoseDamaged: SS, codeDrainArea: S,
  },
  HW: { pumpSilent: SA, waterReturnsAfterDrain: SS },
  ES: { commandedDrainWorks: S, excessiveFoam: SS },
  DP: {
    waterRemaining: S, pumpHumming: S, commandedDrainFails: S, commandedDrainWorks: A,
    restoredAfterFilterClear: SA, restoredAfterImpellerClear: SA, restoredAfterHoseClear: SA,
    waterReturnsAfterDrain: SA, drainsNormally: SA, drainPathClearPumpEnergised: SS,
    drainPathClearExceptHosePumpEnergised: S, drainPathClearPumpSilent: S, impellerDamaged: SS,
    codeDrainArea: S, codePumpCircuit: S,
  },
  PL: { waterRemaining: S, commandedDrainFails: SA, commandedDrainWorks: SS, waterReturnsAfterDrain: A, drainsNormally: SA },
  CT: { pumpHumming: SA, commandedDrainWorks: A, waterReturnsAfterDrain: A, drainPathClearPumpSilent: S, codePumpCircuit: S },
};
const nodeOf = (key) => ({ signals: Object.entries(SIGNALS[key]).map(([fact, effect]) => ({ fact, effect })) });

// D-P2: decisive facts that may justify a part, and the component they name.
const DECISIVE_PART = {
  DP: { drainPathClearPumpEnergised: 'drain-pump', impellerDamaged: 'drain-pump' },
  FB: { filterDamaged: 'pump-filter' },
  HR: { hoseDamaged: 'drain-hose' },
};
const RESTORED_FOR = { FB: 'restoredAfterFilterClear', IO: 'restoredAfterImpellerClear', HR: 'restoredAfterHoseClear' };
const CHECK_FOR = { FB: 'drain-filter', IO: 'pump-impeller', HR: 'drain-hose' };

// Human trace labels (never customer prose; COMPOSE gets typed facts).
const FACT_LABEL = {
  waterRemaining: 'water left in the drum', pumpHumming: 'pump hums when draining', pumpSilent: 'pump silent when draining',
  commandedDrainWorks: 'a drain/spin command empties it', commandedDrainFails: 'a drain/spin command does not empty it',
  filterClear: 'pump filter checked clear', filterObstructionCleared: 'blockage found and cleared at the filter',
  filterObstructionStuck: 'blockage at the filter that could not be cleared', filterDamaged: 'pump filter damaged',
  impellerClear: 'impeller turns freely', impellerObstructionCleared: 'object removed from the impeller',
  impellerJammed: 'impeller jammed', impellerDamaged: 'impeller damaged', hoseClear: 'drain hose checked clear',
  hoseRestrictionCleared: 'hose/waste restriction cleared', hoseRestrictionStuck: 'hose/waste restriction not cleared',
  hoseDamaged: 'drain hose damaged', restoredAfterFilterClear: 'drains after clearing the filter',
  restoredAfterImpellerClear: 'drains after clearing the impeller', restoredAfterHoseClear: 'drains after clearing the hose',
  failsAfterFilterClear: 'still fails after clearing the filter', failsAfterImpellerClear: 'still fails after clearing the impeller',
  failsAfterHoseClear: 'still fails after clearing the hose', waterReturnsAfterDrain: 'water comes back / sink backs up',
  excessiveFoam: 'excess foam', drainsNormally: 'drains normally',
  drainPathClearPumpEnergised: 'path checked clear, pump hums but moves nothing',
  drainPathClearExceptHosePumpEnergised: 'path clear except unchecked hose, pump hums but moves nothing',
  drainPathClearPumpSilent: 'path clear, pump silent', codeDrainArea: 'drain-timeout error code', codePumpCircuit: 'pump-circuit error code',
};

// ---- scoring engine: shared (evidence-engine.js), identical semantics to part-finder-lambda.js ----------
const engine = require('./evidence-engine.js');
const scoreNodeEvidence = engine.scoreNodeEvidence;
const factConflict = (node, facts) => engine.factConflict(node, facts, FACT_LABEL);

// ---- projection (§5) -------------------------------------------------------------------------------
const obsVal = (state, k) => {
  const f = state && state.evidence && state.evidence.observations && state.evidence.observations[k];
  return f && f.value != null ? f.value : null;
};
const obsTurn = (state, k) => {
  const f = state && state.evidence && state.evidence.observations && state.evidence.observations[k];
  if (!f || f.value == null) return null;
  // lastTurn = the latest turn the SAME value was re-stated (merge M2); turn = when the value was set.
  return Number.isInteger(f.lastTurn) ? Math.max(f.lastTurn, f.turn) : f.turn;
};
const chk = (state, c) => (state && state.evidence && state.evidence.checks && state.evidence.checks[c]) || null;
const res = (state, c) => { const k = chk(state, c); return k && k.status === 'done' ? k.result : null; };
const clr = (state, c) => { const k = chk(state, c); return k && k.status === 'done' && k.result === 'found_and_cleared' ? k.turn : null; };

function evidenceFacts(state, ctx = {}) {
  const t = new Set();
  const on = (name, cond) => { if (cond) t.add(name); };
  const wr = obsVal(state, 'waterRemaining');
  const hum = obsVal(state, 'pumpHumming');
  const cmd = obsVal(state, 'commandedDrain');
  const cmdTurn = obsTurn(state, 'commandedDrain');
  const dn = obsVal(state, 'drainsNormally');
  const dnTurn = obsTurn(state, 'drainsNormally');
  const clears = { FB: clr(state, 'drain-filter'), IO: clr(state, 'pump-impeller'), HR: clr(state, 'drain-hose') };
  const clearTurns = Object.values(clears).filter((x) => x != null);
  const latestClear = clearTurns.length ? Math.max(...clearTurns) : null;
  // A report of normal draining AFTER a clearance is the restoration itself (it is consumed as
  // restoredAfter…; projecting it as `drainsNormally` too would contradict the very cause just cleared).
  const restoredByNormal = dn === true && latestClear != null && dnTurn >= latestClear;

  on('waterRemaining', wr === true);
  on('pumpHumming', hum === true);
  on('pumpSilent', hum === false);
  on('commandedDrainWorks', cmd === true && !clearTurns.some((x) => x <= cmdTurn));
  on('commandedDrainFails', cmd === false);
  const r = { f: res(state, 'drain-filter'), i: res(state, 'pump-impeller'), h: res(state, 'drain-hose') };
  on('filterClear', r.f === 'clear');
  on('filterObstructionCleared', r.f === 'found_and_cleared');
  on('filterObstructionStuck', r.f === 'found_not_cleared');
  on('filterDamaged', r.f === 'fault_seen');
  on('impellerClear', r.i === 'clear');
  on('impellerObstructionCleared', r.i === 'found_and_cleared');
  on('impellerJammed', r.i === 'found_not_cleared');
  on('impellerDamaged', r.i === 'fault_seen');
  on('hoseClear', r.h === 'clear');
  on('hoseRestrictionCleared', r.h === 'found_and_cleared');
  on('hoseRestrictionStuck', r.h === 'found_not_cleared');
  on('hoseDamaged', r.h === 'fault_seen');
  const names = { FB: 'Filter', IO: 'Impeller', HR: 'Hose' };
  for (const [fam, ct] of Object.entries(clears)) {
    if (ct == null) continue;
    // Same-turn reports ("cleared it and it drains now") count as after the clearance.
    const restored = (cmd === true && cmdTurn >= ct) || (state && state.resolution === 'resolved') || (dn === true && dnTurn >= ct);
    on(`restoredAfter${names[fam]}Clear`, restored);
    on(`failsAfter${names[fam]}Clear`, cmd === false && cmdTurn >= ct);
  }
  on('waterReturnsAfterDrain', obsVal(state, 'waterReturnsAfterDrain') === true);
  on('excessiveFoam', obsVal(state, 'excessiveFoam') === true);
  on('drainsNormally', dn === true && !restoredByNormal);
  const hoseStatus = chk(state, 'drain-hose') ? chk(state, 'drain-hose').status : null;
  const fails = cmd === false;
  on('drainPathClearPumpEnergised', t.has('filterClear') && t.has('impellerClear') && t.has('hoseClear') && hum === true && fails);
  on('drainPathClearExceptHosePumpEnergised', t.has('filterClear') && t.has('impellerClear')
    && (hoseStatus === 'unable' || hoseStatus === 'declined') && hum === true && fails);
  on('drainPathClearPumpSilent', t.has('filterClear') && t.has('impellerClear') && hum === false && fails);
  on('codeDrainArea', ctx.codeArea === 'not-draining');
  on('codePumpCircuit', ctx.codeArea === 'drain-pump');

  const facts = [...t].map((name) => ({ name, value: 'TRUE' }));
  if (wr === false) facts.push({ name: 'waterRemaining', value: 'FALSE' }); // passes through (S only: no effect)
  return facts;
}

// ---- eligibility (§3) ----------------------------------------------------------------------------------
function eligible(key, has) {
  if (key === 'HW') return has('waterReturnsAfterDrain');
  if (key === 'ES') return has('excessiveFoam');
  if (key === 'CT') return has('drainPathClearPumpSilent') || has('codePumpCircuit');
  return true;
}

// ---- ranking / commit / part evidence (§8, §10) -----------------------------------------------------------
function diagnose(state, ctx = {}) {
  const facts = evidenceFacts(state, ctx);
  const trueSet = new Set(facts.filter((f) => f.value === 'TRUE').map((f) => f.name));
  const has = (n) => trueSet.has(n);
  const rank = [];
  const contradicted = [];
  for (const key of PRIOR) {
    if (!eligible(key, has)) continue;
    const node = nodeOf(key);
    const conflict = factConflict(node, facts);
    if (conflict.contradicted) { contradicted.push({ family: FAMILY[key], key, reasons: conflict.reasons }); continue; }
    const sc = scoreNodeEvidence(node, facts);
    const support = []; const againstReasons = [];
    for (const [fact, eff] of Object.entries(SIGNALS[key])) {
      if (!has(fact)) continue;
      if (eff === SS || eff === S) support.push(FACT_LABEL[fact] || fact); else againstReasons.push(FACT_LABEL[fact] || fact);
    }
    rank.push({ family: FAMILY[key], key, score: sc.score, strongSupport: sc.strongSupport, against: sc.against, support, againstReasons });
  }
  rank.sort((a, b) => (b.score - a.score) || (b.strongSupport - a.strongSupport) || (PRIOR.indexOf(a.key) - PRIOR.indexOf(b.key)));

  const top = rank[0] || null;
  const second = rank[1] || null;
  let leader = null;
  if (top) {
    const margin = second ? top.score - second.score : top.score;
    // §8 step 6. The runner-up is the next RANKED family (D20: ES 2 vs 1 is margin 1, not committed).
    const committed = top.strongSupport >= 1 && top.score >= COMMIT_MIN && margin >= COMMIT_MARGIN;
    const decisive = DECISIVE_PART[top.key] ? Object.keys(DECISIVE_PART[top.key]).find((f) => has(f)) || null : null;
    const damaged = decisive && /Damaged$/.test(decisive);
    const level = committed && ((top.key === 'DP') || damaged) ? 'component' : 'cause_family';
    leader = {
      family: top.family, key: top.key, committed, level, margin,
      component: level === 'component' ? (decisive ? DECISIVE_PART[top.key][decisive] : 'drain-pump') : null,
      decisive,
    };
  }
  const likelyResolved = Boolean(leader && leader.committed && RESTORED_FOR[leader.key] && has(RESTORED_FOR[leader.key]));

  // Diagnostic half of the part gate (D-P1..D-P4).
  const reasons = [];
  let component = null;
  if (!leader) reasons.push('no-leader');
  else {
    if (!leader.committed) reasons.push('leader-not-committed');
    const decisiveMap = DECISIVE_PART[leader.key];
    if (!decisiveMap) reasons.push('leader-not-part-eligible');
    else if (!leader.decisive) reasons.push('no-decisive-fact');
    else component = decisiveMap[leader.decisive];
    if (['restoredAfterFilterClear', 'restoredAfterImpellerClear', 'restoredAfterHoseClear', 'waterReturnsAfterDrain',
      'commandedDrainWorks', 'drainsNormally'].some(has)) reasons.push('restored-or-works-evidence');
    if (second && leader.margin < COMMIT_MARGIN) reasons.push('alternative-within-margin');
  }
  if (has('drainPathClearExceptHosePumpEnergised') && reasons.length) reasons.push('hose-unverified-alternative-live');
  if (has('drainPathClearPumpSilent') && reasons.length) reasons.push('silent-pump-pump-or-control');
  if (has('codePumpCircuit') && reasons.length) reasons.push('code-is-support-only');
  const sufficient = reasons.length === 0;
  const partEvidence = { sufficient, component: sufficient ? component : null, reasons };

  return {
    schema: 'j1-diag/1',
    facts: [...trueSet].sort(),
    rank: rank.map(({ key, ...r }) => r),
    contradicted: contradicted.map(({ key, ...c }) => c),
    leader,
    likelyResolved,
    partEvidence,
    pivotal: pivotal(rank, has, state),
    noViableCause: rank.length === 0,
    codeArea: ctx.codeArea || null,
  };
}

// §9: advisory only (trace). The first unknown journey target whose answer would contradict the leader.
const PIVOTAL_TARGETS = [
  ['drain-filter', 'filterClear'], ['drain-command', 'commandedDrainWorks'], ['pumpHumming', 'pumpHumming'],
  ['pump-impeller', 'impellerClear'], ['drain-hose', 'hoseClear'], ['waterReturnsAfterDrain', 'waterReturnsAfterDrain'],
];
function pivotal(rank, has, state) {
  if (rank.length < 2) return null;
  const leaderKey = rank[0].key;
  for (const [target, fact] of PIVOTAL_TARGETS) {
    if (has(fact)) continue;
    if (['drain-filter', 'pump-impeller', 'drain-hose'].includes(target) && chk(state, target)) continue;
    if (target === 'drain-command' && obsVal(state, 'commandedDrain') != null) continue;
    if (target === 'pumpHumming' && obsVal(state, 'pumpHumming') != null) continue;
    if (SIGNALS[leaderKey][fact] === SA) return { target, separates: [rank[0].family, rank[1].family] };
  }
  return null;
}

// ---- codeArea (§7, K4) from the catalogue error-code tables ------------------------------------------------
const normCode = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
function areaOf(v) {
  const id = typeof v === 'string' ? v : (v && typeof v === 'object' ? v.faultId : null);
  return id === 'not-draining' || id === 'drain-pump' ? id : null;
}
/**
 * codeAreaFor(state, errorCodes) — the latest active displayed code, mapped through the brand family
 * (make ∈ appliesTo) WM table. Without a make, an unambiguous cross-family mapping is used; drain-area
 * vs pump-circuit disagreement degrades to the weaker `not-draining` (support only either way).
 */
function codeAreaFor(state, errorCodes) {
  if (!state || !errorCodes || typeof errorCodes !== 'object') return null;
  const codes = (state.identity && state.identity.displayedCodes) || [];
  const active = codes.filter((f) => f && f.status === 'active' && f.value);
  if (!active.length) return null;
  const code = normCode(active[active.length - 1].value);
  const make = state.identity.make && state.identity.make.value ? String(state.identity.make.value).toLowerCase().trim() : null;
  const lookup = (table) => {
    if (!table || typeof table !== 'object') return null;
    const k = Object.keys(table).find((x) => x && !x.startsWith('_') && normCode(x) === code);
    return k ? areaOf(table[k]) : null;
  };
  if (make) {
    for (const def of Object.values(errorCodes)) {
      if (!def || !Array.isArray(def.appliesTo)) continue;
      if (def.appliesTo.some((m) => String(m).toLowerCase() === make)) return lookup(def['washing-machine']);
    }
    return null;
  }
  const hits = new Set();
  for (const def of Object.values(errorCodes)) {
    const a = def && lookup(def['washing-machine']);
    if (a) hits.add(a);
  }
  if (!hits.size) return null;
  return hits.size === 1 ? [...hits][0] : 'not-draining';
}

module.exports = {
  COMMIT_MIN, COMMIT_MARGIN, FAMILY, PRIOR, SIGNALS, FACT_LABEL, DECISIVE_PART,
  scoreNodeEvidence, factConflict, evidenceFacts, diagnose, codeAreaFor,
};
