'use strict';
/**
 * Shared deterministic evidence engine for canonical journey diagnostics. PURE.
 * Semantics are identical to part-finder-lambda.js scoreNodeEvidence / factConflict (equivalence-tested):
 *   TRUE:  STRONG_SUPPORT +2 (strong), SUPPORT +1, AGAINST -1, STRONG_AGAINST -3
 *   FALSE: STRONG_SUPPORT -2, STRONG_AGAINST +2 (strong)
 *   contradicted = a TRUE fact on STRONG_AGAINST, or a FALSE fact on STRONG_SUPPORT
 * Plus the generic ranking / commit used by every journey (evidence doc §8):
 *   sort score desc, strongSupport desc, prior; commit = strong >= 1, score >= COMMIT_MIN, margin to the
 *   next RANKED family >= COMMIT_MARGIN.
 */
const SS = 'STRONG_SUPPORT'; const S = 'SUPPORT'; const A = 'AGAINST'; const SA = 'STRONG_AGAINST';
const COMMIT_MIN = 2;
const COMMIT_MARGIN = 2;

function scoreNodeEvidence(node, facts) {
  if (!node || !Array.isArray(node.signals) || !Array.isArray(facts) || !facts.length) return { score: 0, strongSupport: 0, against: 0 };
  const byName = new Map(facts.map((f) => [String(f.name || '').toLowerCase(), f.value]));
  let score = 0; let strongSupport = 0; let against = 0;
  for (const sig of node.signals) {
    const v = byName.get(String(sig.fact || '').toLowerCase());
    if (!v || v === 'UNKNOWN') continue;
    const e = sig.effect;
    if (v === 'TRUE') {
      if (e === SS) { score += 2; strongSupport += 1; } else if (e === S) score += 1;
      else if (e === A) { score -= 1; against += 1; } else if (e === SA) { score -= 3; against += 1; }
    } else if (v === 'FALSE') {
      if (e === SS) { score -= 2; against += 1; } else if (e === SA) { score += 2; strongSupport += 1; }
    }
  }
  return { score, strongSupport, against };
}
function factConflict(node, facts, labels = {}) {
  if (!node || !Array.isArray(node.signals) || !Array.isArray(facts) || !facts.length) return { contradicted: false, reasons: [] };
  const byName = new Map(facts.map((f) => [String(f.name || '').toLowerCase(), f.value]));
  const reasons = [];
  for (const sig of node.signals) {
    const v = byName.get(String(sig.fact || '').toLowerCase());
    if (!v || v === 'UNKNOWN') continue;
    if (v === 'TRUE' && sig.effect === SA) reasons.push(labels[sig.fact] || sig.fact);
    else if (v === 'FALSE' && sig.effect === SS) reasons.push(`not ${labels[sig.fact] || sig.fact}`);
  }
  return { contradicted: reasons.length > 0, reasons };
}
const nodeOf = (signals) => ({ signals: Object.entries(signals).map(([fact, effect]) => ({ fact, effect })) });

/**
 * rankFamilies({families: {KEY: {name, signals}}, prior: [KEY...], facts, eligible(key, has), labels})
 *   -> {rank[], contradicted[], top, second, margin, committed}
 */
function rankFamilies({ families, prior, facts, eligible = () => true, labels = {} }) {
  const trueSet = new Set(facts.filter((f) => f.value === 'TRUE').map((f) => f.name));
  const has = (n) => trueSet.has(n);
  const rank = []; const contradicted = [];
  for (const key of prior) {
    if (!eligible(key, has)) continue;
    const fam = families[key];
    const node = nodeOf(fam.signals);
    const conflict = factConflict(node, facts, labels);
    if (conflict.contradicted) { contradicted.push({ family: fam.name, key, reasons: conflict.reasons }); continue; }
    const sc = scoreNodeEvidence(node, facts);
    const support = []; const againstReasons = [];
    for (const [fact, eff] of Object.entries(fam.signals)) {
      if (!has(fact)) continue;
      if (eff === SS || eff === S) support.push(labels[fact] || fact); else againstReasons.push(labels[fact] || fact);
    }
    rank.push({ family: fam.name, key, score: sc.score, strongSupport: sc.strongSupport, against: sc.against, support, againstReasons });
  }
  rank.sort((a, b) => (b.score - a.score) || (b.strongSupport - a.strongSupport) || (prior.indexOf(a.key) - prior.indexOf(b.key)));
  const top = rank[0] || null; const second = rank[1] || null;
  const margin = top ? (second ? top.score - second.score : top.score) : 0;
  const committed = Boolean(top && top.strongSupport >= 1 && top.score >= COMMIT_MIN && margin >= COMMIT_MARGIN);
  return { rank, contradicted, top, second, margin, committed, has, trueSet };
}

// ---- declarative journey diagnostics (batch-2 journeys; same semantics as Journey 3's hand-written diagnose) ----
const FOUND = new Set(['found_and_cleared', 'found_not_cleared']);
const obsFact = (s, k) => (s.evidence && s.evidence.observations && s.evidence.observations[k]) || null;
const obsVal = (s, k) => { const f = obsFact(s, k); return f && f.value != null ? f.value : null; };
const obsTurnOf = (s, k) => { const f = obsFact(s, k); if (!f || f.value == null) return null; return Number.isInteger(f.lastTurn) ? Math.max(f.lastTurn, f.turn) : f.turn; };
const checkOf = (s, c) => (s.evidence && s.evidence.checks && s.evidence.checks[c]) || null;
const checkResult = (s, c) => { const k = checkOf(s, c); return k && k.status === 'done' ? k.result : null; };
const checkDone = (s, c) => { const k = checkOf(s, c); return Boolean(k && k.status === 'done'); };
/** Turn of the latest owner fix on check c (found_and_cleared / found_not_cleared), else null. */
function fixTurnOf(s, c) { const k = checkOf(s, c); return k && k.status === 'done' && FOUND.has(k.result) ? k.turn : null; }

/**
 * Project cs/1 into TRUE facts from a declarative spec (typed state only; no prose):
 *   obs:    { fact: [obsKey, value] }
 *   checks: { check: { clear, found, cleared, notCleared, fault, done } }   (fact names per result)
 *   fix:    { FAMILY: [check, Label] } -> restoredAfter<Label>Fix / failsAfter<Label>Fix from `retestObs`
 *   retestObs: observation key whose FALSE (at/after the fix) means "no longer happens" (default faultPersists)
 *   extra(state, ctx, on): journey-specific projections (codes, scope, architecture)
 */
function projectFacts(state, spec, ctx = {}) {
  const t = new Set();
  const on = (n, c) => { if (c && n) t.add(n); };
  for (const [fact, [k, v]] of Object.entries(spec.obs || {})) on(fact, obsVal(state, k) === v);
  for (const [c, m] of Object.entries(spec.checks || {})) {
    const r = checkResult(state, c);
    on(m.done, checkDone(state, c));
    on(m.clear, r === 'clear'); on(m.found, FOUND.has(r)); on(m.cleared, r === 'found_and_cleared');
    on(m.notCleared, r === 'found_not_cleared'); on(m.fault, r === 'fault_seen');
  }
  const ro = spec.retestObs || 'faultPersists';
  const rec = obsVal(state, ro); const recT = obsTurnOf(state, ro);
  for (const [, [c, n]] of Object.entries(spec.fix || spec.FIX_CHECK || {})) {
    const ft = fixTurnOf(state, c);
    if (ft == null) continue;
    on(`restoredAfter${n}Fix`, (rec === false && recT >= ft) || state.resolution === 'resolved');
    on(`failsAfter${n}Fix`, rec === true && recT >= ft);
  }
  if (spec.extra) spec.extra(state, ctx, on);
  return [...t].map((name) => ({ name, value: 'TRUE' }));
}

/**
 * diagnoseSpec(spec, state, ctx) -> the same inferred shape as Journey 3's diagnose():
 *   {schema, facts, rank, contradicted, leader{family,key,committed,level,margin,component,decisive}, likelyResolved,
 *    partEvidence{sufficient, component, reasons}, noViableCause, architecture?}
 * spec: {schema, FAMILY, PRIOR, SIGNALS, FACT_LABEL, eligible(key,has), DECISIVE_PART {KEY:{fact:component}},
 *        FIX_CHECK, obs, checks, extra, partBlockers(has, ctx) -> [reason], architecture(state, ctx)}
 * Component level is reached ONLY by a committed leader with a decisive (owner-seen / code) fact.
 */
function diagnoseSpec(spec, state, ctx = {}) {
  const families = Object.fromEntries(Object.entries(spec.SIGNALS).map(([k, sig]) => [k, { name: spec.FAMILY[k], signals: sig }]));
  const architecture = spec.architecture ? spec.architecture(state, ctx) : null;
  const facts = projectFacts(state, spec, { ...ctx, architecture });
  const r = rankFamilies({ families, prior: spec.PRIOR, facts, eligible: (k, has) => (spec.eligible ? spec.eligible(k, has, { architecture }) : true), labels: spec.FACT_LABEL || {} });
  const { has } = r;
  let leader = null;
  if (r.top && r.top.score > 0) { // a family with no supporting evidence never leads
    const map = (spec.DECISIVE_PART || {})[r.top.key];
    const decisive = map ? Object.keys(map).find((f) => has(f)) || null : null;
    const level = r.committed && decisive ? 'component' : 'cause_family';
    leader = { family: r.top.family, key: r.top.key, committed: r.committed, level, margin: r.margin,
      component: level === 'component' ? map[decisive] : null, decisive };
  }
  // Likely resolved: the committed leader is supported (SS) by a "restored after <owner fix>" fact that is present.
  const leadSig = leader ? spec.SIGNALS[leader.key] : {};
  const likelyResolved = Boolean(leader && leader.committed && Object.keys(leadSig).some((f) => f.startsWith('restoredAfter') && leadSig[f] === SS && has(f)));
  const reasons = [];
  let component = null;
  if (!leader) reasons.push('no-leader');
  else {
    if (!leader.committed) reasons.push('leader-not-committed');
    const map = (spec.DECISIVE_PART || {})[leader.key];
    if (!map) reasons.push('leader-not-part-eligible');
    else if (!leader.decisive) reasons.push('no-decisive-fact');
    else component = map[leader.decisive];
    if (r.second && r.margin < COMMIT_MARGIN) reasons.push('alternative-within-margin');
    if (spec.partBlockers) reasons.push(...spec.partBlockers(has, { architecture, component, leader }));
  }
  const sufficient = reasons.length === 0;
  return {
    schema: spec.schema, facts: [...r.trueSet].sort(), codeFault: ctx.codeFault || null,
    rank: r.rank.map(({ key, ...x }) => x), contradicted: r.contradicted.map(({ key, ...x }) => x),
    leader, likelyResolved, partEvidence: { sufficient, component: sufficient ? component : null, reasons },
    noViableCause: r.rank.length === 0, ...(architecture ? { architecture } : {}),
  };
}

module.exports = { SS, S, A, SA, COMMIT_MIN, COMMIT_MARGIN, scoreNodeEvidence, factConflict, nodeOf, rankFamilies,
  projectFacts, diagnoseSpec, fixTurnOf, obsVal, obsTurnOf, checkResult, checkDone };
