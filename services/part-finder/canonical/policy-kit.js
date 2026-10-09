'use strict';
/**
 * Shared, PURE journey-policy helpers over cs/1 (extracted from Journey 1; used by every canonical journey).
 *
 *   makeKit({checks, observations, outcomeObs, resetAfter}) -> state readers + G2 request predicates
 *   effectiveSafety(state) -> {level, hazard, stop}   (journey stickiness L5 / journey doc §9.3)
 *
 * Request semantics (journey doc §6.5, G2): a target gets at most one `ask` and one `reoffer`; a reoffer only
 * after not_done / partial; ignored / superseded / declined / unable / cannot_answer never re-asked. A functional check
 * may be reset by a later fix (resetAfter[target](state) -> turn): then only requests since that turn count.
 */

const { SAFETY_ORDER, HAZARD_LEVEL, strongestLevel } = require('./cs1.js');
const rq = require('./requests.js');

const STICKY = new Set(['electrical_water', 'electric_shock', 'gas_escape', 'gas_smell']);
// A reoffer only when the customer said they have not done it yet; an ignored request is not asked again word for
// word (the policy moves on, and an owner check is carried into the conclusion instead).
const REOFFERABLE = new Set(['not_done', 'partial']);
const HARD_BLOCK = new Set(['declined', 'unable', 'cannot_answer']);

const obsFact = (s, k) => (s.evidence && s.evidence.observations && s.evidence.observations[k]) || null;
const obs = (s, k) => { const f = obsFact(s, k); return f && f.value != null ? f.value : null; };
/** Latest turn the value was (re)stated (merge M2 lastTurn). */
const obsTurn = (s, k) => {
  const f = obsFact(s, k); if (!f || f.value == null) return null;
  return Number.isInteger(f.lastTurn) ? Math.max(f.lastTurn, f.turn) : f.turn;
};
const chk = (s, c) => (s.evidence && s.evidence.checks && s.evidence.checks[c]) || null;
const res = (s, c) => { const k = chk(s, c); return k && k.status === 'done' ? k.result : null; };
function modelKnown(s) { return Boolean(s.identity.model && s.identity.model.value && s.identity.model.confirmed); }
function problemOf(s) {
  const ps = s.problems || [];
  for (let i = ps.length - 1; i >= 0; i -= 1) if (ps[i].status === 'active') return ps[i];
  const last = ps[ps.length - 1];
  return last && last.status === 'resolved' ? last : null;
}

function makeKit({ checks = [], observations = [], outcomeObs = {}, resetAfter = {} } = {}) {
  const done = (s, t) => {
    if (outcomeObs[t]) return obs(s, outcomeObs[t]) != null || Boolean(chk(s, t) && chk(s, t).status === 'done');
    if (checks.includes(t)) return Boolean(chk(s, t) && chk(s, t).status === 'done');
    if (observations.includes(t)) return obs(s, t) != null;
    if (t === 'model') return modelKnown(s);
    if (t === 'appliance') return Boolean(s.identity.appliance && s.identity.appliance.value);
    if (t === 'resolution') return s.resolution === 'resolved';
    return false;
  };
  /** Requests for a target that count towards the no-loop limit. */
  function counted(s, t) {
    const all = rq.requestsFor(s, t);
    if (resetAfter[t]) {
      const c = resetAfter[t](s);
      return c == null ? all.filter((r) => r.kind !== 'retest') : all.filter((r) => r.askedTurn >= c);
    }
    return all.filter((r) => r.kind === 'ask' || r.kind === 'reoffer');
  }
  function lastOf(s, t) { const rs = counted(s, t); return rs.length ? rs[rs.length - 1].outcome : null; }
  function blocked(s, t) {
    if ((s.declined || []).some((d) => d.target === t && d.resolvedTurn == null)) return true;
    const k = chk(s, t);
    if (k && (k.status === 'declined' || k.status === 'unable')) return true;
    return HARD_BLOCK.has(rq.lastOutcome(s, t));
  }
  function askable(s, t) {
    if (done(s, t) || blocked(s, t)) return false;
    const n = counted(s, t).length;
    return n === 0 || (n === 1 && REOFFERABLE.has(lastOf(s, t)));
  }
  const settled = (s, t) => done(s, t) || blocked(s, t) || !askable(s, t);
  function modelAskable(s) {
    if (modelKnown(s) || s.identity.modelStatus === 'unavailable') return false;
    // "I'll go and look" (pending_lookup) counts as asked once; the next need may re-ask once.
    if (s.identity.modelStatus === 'pending_lookup' && !blocked(s, 'model') && counted(s, 'model').length === 1) return true;
    return askable(s, 'model');
  }
  return { obs, obsTurn, chk, res, done, counted, lastOf, blocked, askable, settled, modelKnown, modelAskable, problemOf };
}

function effectiveHazards(s) {
  return ((s.safety && s.safety.hazards) || []).filter((h) => h.status === 'active' || (h.status === 'corrected' && STICKY.has(h.hazard)));
}
function effectiveSafety(s) {
  const hs = effectiveHazards(s);
  const level = strongestLevel(hs.map((h) => HAZARD_LEVEL[h.hazard] || 'NORMAL_DIAGNOSTIC'));
  let top = null;
  for (const h of hs) {
    const i = SAFETY_ORDER.indexOf(HAZARD_LEVEL[h.hazard] || 'NORMAL_DIAGNOSTIC');
    if (!top || i >= SAFETY_ORDER.indexOf(HAZARD_LEVEL[top.hazard] || 'NORMAL_DIAGNOSTIC')) top = h;
  }
  return { level, hazard: top ? top.hazard : null, stop: SAFETY_ORDER.indexOf(level) >= SAFETY_ORDER.indexOf('STOP_USE') };
}
const SAFETY_REQUIRES = {
  gas_escape: ['gas_emergency'], gas_smell: ['gas_emergency'],
  electrical_water: ['stop_use', 'do_not_touch_plug_if_wet', 'isolate_at_consumer_unit_if_safe'],
  electric_shock: ['stop_use', 'isolate_at_consumer_unit_if_safe'],
};

/**
 * Step policy for the batch-2 washing-machine and the dishwasher-family journeys (same rule order as Journey 3, written once):
 *   P1 safety (sticky kit) / P1 containment (journey-specific, e.g. uncontrolled water)  → safety_stop
 *   P2 resolved → close · P3 wrong appliance / not this journey → exit · P4 appliance unknown → ask
 *   early(...)  journey-specific conclusions that must pre-empt checks (household supply, plumbing, normal behaviour)
 *   P6 an owner fix was made and not yet re-run → retest (outcome `faultPersists`)
 *   P7 likelyResolved → conclude, no part, CONFIRM
 *   steps[]     the minimum useful discriminator / safe owner check, in research order (first askable wins)
 *   P20 committed component-level part family + model askable → ask model
 *   P21 part gate passes → recommend_part · P22 otherwise → conclude leader (or unconfirmed) with handoff + no-part flag
 * cfg = {JOURNEY, P, appliance (default washing-machine), journeys, codeFaults, drainOwned, claims(h), ownedElsewhere(h),
 *        CHECKS, OBS_TARGETS, REQUIRES, FIX_CHECKS, steps, early, containment, PART_FAMILIES, HANDOFF, partExtra, unconfirmedHandoff}
 * claims(h): typed state that makes this journey own a problem typed as another journey (e.g. water in the base →
 * leaking). ownedElsewhere(h): the mirror exclusion, so exactly one journey owns a turn (a handoff happens once, no bounce).
 * Reads ONLY cs/1, the journey diagnostics and the typed part lookup. No prose.
 */
function makeStepPolicy(cfg) {
  const { JOURNEY, P } = cfg;
  const APPLIANCE = cfg.appliance || 'washing-machine';
  const OBS_TARGETS = cfg.OBS_TARGETS || {};
  const CHECKS = [...(cfg.CHECKS || []), 'retest'];
  const FIX_CHECKS = cfg.FIX_CHECKS || [];
  const R = (n) => `${P}${n}`;
  function fixTurn(s) {
    let t = null;
    for (const c of FIX_CHECKS) {
      const k = chk(s, c);
      const ok = (cfg.fixResults && cfg.fixResults[c]) || ['found_and_cleared', 'found_not_cleared'];
      if (k && k.status === 'done' && ok.includes(k.result) && (t == null || k.turn > t)) t = k.turn;
    }
    return t;
  }
  const K = makeKit({ checks: CHECKS, observations: [], outcomeObs: { retest: 'faultPersists' }, resetAfter: { retest: fixTurn } });
  const OUT = cfg.outcomeObs || {};
  const groupKnown = (s, t) => OBS_TARGETS[t].some((k) => obs(s, k) != null);
  const isObs = (t) => Object.prototype.hasOwnProperty.call(OBS_TARGETS, t);
  // A functional test whose result is an observation is done when the check is done, or when that observation
  // was (re)stated AFTER the test was asked — the opener's own statement ("door won't open") is not the test.
  function done(s, t) {
    if (isObs(t)) return groupKnown(s, t);
    if (OUT[t]) {
      const k = chk(s, t); if (k && k.status === 'done') return true;
      const ot = obsTurn(s, OUT[t]);
      return ot != null && rq.requestsFor(s, t).some((r) => r.askedTurn < ot);
    }
    return K.done(s, t);
  }
  function askable(s, t) {
    if (t === 'model') return K.modelAskable(s);
    if (done(s, t) || K.blocked(s, t)) return false;
    const n = K.counted(s, t).length;
    return n === 0 || (n === 1 && REOFFERABLE.has(rq.lastOutcome(s, t)));
  }
  function retestDue(s) {
    const f = fixTurn(s); const t = obsTurn(s, 'faultPersists');
    return f != null && (t == null || t < f) && !rq.requestsFor(s, 'retest').some((r) => r.askedTurn >= f) && !K.blocked(s, 'retest');
  }
  const helpers = (s, d) => {
    const facts = new Set((d && d.facts) || []);
    return { s, d, has: (f) => facts.has(f), obs: (k) => obs(s, k), res: (c) => res(s, c), done: (t) => done(s, t),
      scope: () => { const p = problemOf(s); return p && p.scope ? p.scope.value : null; } };
  };
  function nextStep(s, d) {
    const h = helpers(s, d);
    for (const st of cfg.steps) if (st.when(h) && askable(s, st.target)) return st;
    return null;
  }
  const pathExhausted = (s, d) => nextStep(s, d) === null && !retestDue(s);
  /** Active stop-level hazards are ALL continuable for this journey → {hazard, now}; otherwise null. */
  function continuable(s) {
    const map = cfg.continueAfterHazard; if (!map) return null;
    const stops = effectiveHazards(s).filter((h) => SAFETY_ORDER.indexOf(HAZARD_LEVEL[h.hazard] || 'NORMAL_DIAGNOSTIC') >= SAFETY_ORDER.indexOf('STOP_USE'));
    if (!stops.length || stops.some((h) => !map[h.hazard])) return null;
    // "now" = first reported this turn; restating the same hazard later ("it trips after a while") is an answer, not a new stop
    const now = stops.find((h) => h.turn === s.version && !stops.some((o) => o.hazard === h.hazard && o.turn < s.version));
    return { hazard: (now || stops[stops.length - 1]).hazard, now: Boolean(now) };
  }
  const containmentNow = (s, d) => (cfg.containment ? cfg.containment(s, d, helpers(s, d)) : null);

  function entry(s, diag) {
    const Pr = problemOf(s);
    const appliance = s.identity.appliance && s.identity.appliance.value;
    const journey = Pr && Pr.journey ? Pr.journey.value : null;
    const E1 = appliance === APPLIANCE && ['working', 'established'].includes(s.identity.applianceEstablishment);
    const h0 = helpers(s, diag);
    const mine = cfg.journeys.includes(journey) || (journey === 'error-code-only' && (cfg.codeFaults || []).includes(diag && diag.codeFault))
      || Boolean(cfg.claims && journey && cfg.claims(h0, journey));
    const drainOwned = Boolean((cfg.drainOwned && obs(s, 'waterRemaining') === true) // retained water belongs to Journey 1
      || (cfg.ownedElsewhere && cfg.ownedElsewhere(h0, journey)));
    const E2 = mine && !drainOwned;
    const E3 = Boolean(Pr && (Pr.status === 'active' || Pr.status === 'resolved'));
    if (!(E1 && E2 && E3) && E1 && !drainOwned && effectiveSafety(s).stop
        && (s.problems || []).some((p) => p.status === 'active' && p.journey && cfg.journeys.includes(p.journey.value))) {
      return { E1, E2: true, E3: true, candidate: true, applies: true, journey, appliance, safetyCarry: true, drainOwned };
    }
    return { E1, E2, E3, candidate: (appliance === APPLIANCE || appliance == null) && mine, applies: E1 && E2 && E3, journey, appliance: appliance || null, drainOwned };
  }

  function partGate(s, diag, partLookup) {
    const d = diag || {}; const pe = d.partEvidence || { sufficient: false }; const comp = pe.component || null;
    const failed = [];
    if (!modelKnown(s)) failed.push('K1-model-not-known');
    if (s.resolution === 'resolved' || d.likelyResolved) failed.push('K2-resolved-or-likely');
    if (!pathExhausted(s, d)) failed.push('K3-accessible-path-not-settled');
    if (!pe.sufficient) failed.push('K4-evidence-insufficient');
    if (!(partLookup && partLookup.available === true && (!partLookup.component || partLookup.component === comp))) failed.push('K5-no-compatible-part');
    const ch = continuable(s);
    if ((effectiveSafety(s).stop && !(ch && cfg.continueAfterHazard[ch.hazard].partOk)) || containmentNow(s, d)) failed.push('K6-active-safety');
    if (cfg.partExtra) failed.push(...cfg.partExtra(s, d, comp));
    return { eligible: failed.length === 0, component: comp, failed };
  }

  function action(kind, target, reason, rule, extra = {}) {
    return { kind, target, reason, requires: [], expects: [], pending: null, conclusion: null, journey: JOURNEY, rule, requestKind: null, ...extra };
  }
  const kindFor = (s, t, retest) => (retest ? 'retest' : (K.counted(s, t).length ? 'reoffer' : 'ask'));
  function ask(s, t, reason, rule, retest = false) {
    if (isObs(t)) {
      return action('ask_observation', t, reason, rule, { requires: ((cfg.REQUIRES || {})[t] || []).slice(), expects: OBS_TARGETS[t].map((k) => `observations.${k}`),
        requestKind: kindFor(s, t), pending: { slot: 'OBSERVATION', target: t, purpose: 'DIAGNOSIS' } });
    }
    const out = (cfg.outcomeObs || {})[t] || (t === 'retest' ? 'faultPersists' : null);
    return action('ask_check', t, reason, rule, { requires: ((cfg.REQUIRES || {})[t] || []).slice(), expects: [`checks.${t}`, ...(out ? [`observations.${out}`] : [])],
      requestKind: kindFor(s, t, retest), pending: { slot: 'CHECK', target: t, purpose: 'DIAGNOSIS' } });
  }
  /**
   * The owner check offered most recently that the customer moved past without reporting on (superseded / ignored /
   * "not sure"), still not done and not refused or impossible for them. A conclusion carries it as the first thing to do
   * (with its safety requirements) instead of the question being asked again.
   */
  const refused = (s, t) => (s.declined || []).some((x) => x.target === t && x.kind === 'declined' && x.resolvedTurn == null)
    || ['declined', 'unable'].includes((chk(s, t) || {}).status);
  function outstandingOwnerCheck(s) {
    const rs = (s.requests || []).filter((r) => r.slot === 'CHECK' && ['superseded', 'ignored', 'cannot_answer'].includes(r.outcome));
    for (let i = rs.length - 1; i >= 0; i -= 1) {
      const t = rs[i].target;
      if (CHECKS.includes(t) && t !== 'retest' && !OUT[t] && !done(s, t) && !refused(s, t)) return t;
    }
    return null;
  }
  /**
   * The conclusion was already given last turn (no request was issued then) and this message added nothing new: the
   * reply follows up briefly instead of repeating the whole conclusion.
   */
  function concludedAgain(s) {
    const v = s.version;
    if (!(v > 1) || (s.requests || []).some((r) => r.askedTurn === v - 1)) return false;
    const ev = s.evidence || {};
    const fresh = Object.values(ev.observations || {}).some((f) => f && f.turn === v && f.basis !== 'derived')
      || Object.values(ev.checks || {}).some((k) => k && k.turn === v)
      || Boolean(s.identity && s.identity.model && s.identity.model.turn === v);
    return !fresh;
  }
  function concludeWith(s, kind, target, reason, rule, conclusion) {
    const oc = conclusion.handoff !== 'plumbing' ? outstandingOwnerCheck(s) : null;
    const again = concludedAgain(s);
    const c = { ...conclusion, ...(oc ? { ownerCheck: oc } : {}), ...(again ? { repeat: true } : {}) };
    return action(kind, target, reason, rule, { conclusion: c, ...(oc && !again ? { requires: ((cfg.REQUIRES || {})[oc] || []).slice() } : {}) });
  }
  function alternativesOf(d) {
    const r = d.rank || [];
    if (!r.length || (d.leader && d.leader.committed)) return [];
    return r.slice(1).filter((x) => r[0].score - x.score < 2 && x.score > 0).map((x) => x.family);
  }
  const confirmPending = (s) => (askable(s, 'resolution') ? { slot: 'OBSERVATION', target: 'resolution', purpose: 'CONFIRM' } : null);
  const PART_FAMILIES = cfg.PART_FAMILIES || new Set();

  function policy(s, diag, ctx = {}) {
    const d = diag || {};
    const en = entry(s, d);
    const appliance = en.appliance;
    const L = d.leader;
    const saf = effectiveSafety(s);
    // cfg.continueAfterHazard (opt-in): a diagnosable stop-use hazard (microwave arcing, an oven trip) stops use on the turn
    // it is reported — with one safe question — and the journey then carries on WITHOUT use (no retest, no part while active
    // unless the journey's own gate allows it). Any other stop-level hazard keeps the ordinary sticky stop.
    const chz = continuable(s);
    if (chz && chz.now) {
      const c = cfg.continueAfterHazard[chz.hazard];
      const pend = c.pending && askable(s, c.pending) ? { slot: isObs(c.pending) ? 'OBSERVATION' : 'CHECK', target: c.pending, purpose: 'DIAGNOSIS' } : null;
      return action('safety_stop', c.stop, 'continuable-hazard', R(1), { requires: ['stop_use'], pending: pend, requestKind: pend ? kindFor(s, pend.target) : null,
        expects: pend && isObs(pend.target) ? OBS_TARGETS[pend.target].map((k) => `observations.${k}`) : [] });
    }
    if (saf.stop && !chz) return action('safety_stop', saf.hazard, 'active-hazard', R(1), { requires: (SAFETY_REQUIRES[saf.hazard] || ['stop_use']).slice() });
    const cont = containmentNow(s, d);
    if (cont) {
      const pend = cont.pending && askable(s, cont.pending.target) ? cont.pending : null;
      return action('safety_stop', cont.target, cont.reason, R(1), { requires: cont.requires.slice(), pending: pend, requestKind: pend ? kindFor(s, pend.target) : null,
        expects: pend && isObs(pend.target) ? OBS_TARGETS[pend.target].map((k) => `observations.${k}`) : [] });
    }
    if (s.resolution === 'resolved') {
      return action('close_resolved', L && L.committed ? L.family : null, 'resolved', R(2), { conclusion: { cause: L && L.committed ? L.family : null, level: 'cause_family', confidence: 'likely', handoff: 'none', alternatives: [] } });
    }
    if ((appliance && appliance !== APPLIANCE) || !en.candidate) return action('exit_journey', appliance === 'washer-dryer' ? 'washer-dryer' : 'router', 'wrong-journey', R(3));
    if (!appliance) return action('ask_identity', 'appliance', 'appliance-unknown', R(4), { expects: ['identity.appliance'], requestKind: kindFor(s, 'appliance'), pending: { slot: 'IDENTITY', target: 'appliance', purpose: 'DIAGNOSIS' } });
    const h = helpers(s, d);
    // P8 (opt-in, cfg.declineUnsafe): the customer asks how to do something unsafe THIS turn (re-gas, bypass an interlock,
    // live testing) → decline with the fixed copy, no part; the next turn carries on with the journey.
    const unsafe = cfg.declineUnsafe ? ((s.safety && s.safety.unsafeActions) || []).filter((u) => u.turn === s.version && cfg.declineUnsafe.includes(u.action)).pop() : null;
    if (unsafe) {
      return action('conclude', 'unsafe-request-declined', 'unsafe-action-requested', R(8), { conclusion: { cause: 'unsafe-request-declined', level: 'cause_family', confidence: 'likely',
        handoff: 'engineer', alternatives: [], noPart: true, unsafeAction: unsafe.action } });
    }
    const early = cfg.early ? cfg.early(h, L) : null;
    if (early) {
      return action('conclude', early.target, early.reason, early.rule, { conclusion: { cause: early.target, level: 'cause_family', confidence: early.confidence || 'likely',
        handoff: early.handoff || 'none', alternatives: [], noPart: true } });
    }
    if (retestDue(s)) return ask(s, 'retest', 'retest-after-owner-fix', R(6), true);
    if (d.likelyResolved && L) {
      return action('conclude', L.family, 'owner-fix-restored', R(7), { conclusion: { cause: L.family, level: 'cause_family', confidence: 'likely', handoff: 'none', alternatives: [], noPart: true },
        pending: confirmPending(s), expects: ['reply.outcome'] });
    }
    const step = nextStep(s, d);
    if (step) return ask(s, step.target, step.reason, R(step.n));
    const faultRemains = s.resolution !== 'resolved' && !d.likelyResolved;
    if (faultRemains && L && L.committed && L.level === 'component' && PART_FAMILIES.has(L.key) && K.modelAskable(s)) {
      return action('ask_identity', 'model', 'model-required-for-part-fit', R(20), { expects: ['identity.model', 'identity.modelStatus'], requestKind: kindFor(s, 'model'),
        pending: { slot: 'IDENTITY', target: 'model', purpose: 'PART_FIT' } });
    }
    const gate = partGate(s, d, ctx.partLookup || null);
    if (gate.eligible) {
      return action('recommend_part', gate.component, 'part-gate-met', R(21), { conclusion: { cause: L.family, level: 'component', confidence: 'likely', handoff: 'none', component: gate.component, alternatives: [] } });
    }
    if (!L) return concludeWith(s, 'conclude', 'fault-source-unconfirmed', 'nothing-askable', R(22), { cause: 'fault-source-unconfirmed', level: 'cause_family', confidence: 'possible', handoff: cfg.unconfirmedHandoff || 'engineer', alternatives: [], noPart: true });
    return concludeWith(s, 'conclude', L.family, 'best-supported-conclusion', R(22), { cause: L.family, level: L.level, confidence: L.committed ? 'likely' : 'possible',
      handoff: (cfg.HANDOFF || {})[L.key] || 'engineer', component: L.level === 'component' ? L.component : null, alternatives: alternativesOf(d),
      noPart: !PART_FAMILIES.has(L.key) || L.level !== 'component' });
  }

  return { JOURNEY, APPLIANCE, REQUIRES: { ...(cfg.REQUIRES || {}) }, CHECKS, policy, entry, partGate,
    _helpers: { askable, done, pathExhausted, retestDue, fixTurn, nextStep, containmentNow, continuable } };
}

module.exports = { STICKY, REOFFERABLE, HARD_BLOCK, SAFETY_REQUIRES, makeKit, effectiveSafety, effectiveHazards,
  obs, obsTurn, chk, res, modelKnown, problemOf, makeStepPolicy };
