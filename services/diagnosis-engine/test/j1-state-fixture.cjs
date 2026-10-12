'use strict';
/**
 * Journey 1 BASE state builder for layer C/D fixtures (journey doc §16 BASE; evidence doc §15).
 * Builds real cs/1 shapes directly (no merge), so fixtures pin diagnostics/policy only.
 */
const { emptyState, newFact } = require('../canonical/cs1.js');

function base(opts = {}) {
  const s = emptyState('cs_fixture');
  s.version = opts.version || 1;
  s.identity.appliance = newFact('washing-machine', 'stated', 1);
  s.identity.applianceEstablishment = 'established';
  s.problems = [{ id: 'p1', status: 'active', origin: 'stated', journey: newFact('not-draining', 'stated', 1),
    faultDomain: newFact('water', 'stated', 1), scope: { value: null, basis: null, turn: null, status: 'active', history: [] },
    openedTurn: 1, resolvedTurn: null, recurrences: [], archive: null }];
  s.evidence.observations.waterRemaining = newFact(true, 'stated', 1);
  return s;
}
const obs = (s, key, value, turn) => { s.evidence.observations[key] = newFact(value, 'stated', turn); return s; };
const delObs = (s, key) => { delete s.evidence.observations[key]; return s; };
const check = (s, c, status, result, turn) => { s.evidence.checks[c] = { status, result: result || null, turn, history: [] }; return s; };
const model = (s, value, make) => {
  s.identity.model = { ...newFact(value, 'stated', 2), confirmed: true };
  s.identity.modelStatus = 'known';
  if (make) s.identity.make = newFact(make, 'stated', 2);
  return s;
};
const make = (s, value) => { s.identity.make = newFact(value, 'stated', 1); return s; };
const code = (s, value) => { s.identity.displayedCodes = [newFact(value, 'stated', 1)]; return s; };
const journey = (s, j) => { s.problems[0].journey = newFact(j, 'stated', 1); return s; };
const hazard = (s, h, status = 'active') => {
  s.safety.hazards.push({ hazard: h, turn: 1, status, correctedTurn: status === 'corrected' ? 2 : null });
  s.safety.activeLevel = status === 'active' ? 'STOP_USE' : 'NORMAL_DIAGNOSTIC';
  s.safety.peakLevel = 'STOP_USE';
  return s;
};
const declined = (s, target, kind = 'declined', turn = 2) => { s.declined.push({ target, kind, turn, resolvedTurn: null }); return s; };
const request = (s, target, kind, outcome, askedTurn = 1, slot = 'CHECK') => {

  s.requests.push({ id: `q${s.requests.length + 1}`, slot, target, purpose: 'DIAGNOSIS', kind, askedTurn,
    journey: 'wm-not-draining', rule: null, outcome, resolvedTurn: outcome === 'pending' ? null : askedTurn + 1 });
  if (outcome === 'pending') s.pendingRequest = s.requests[s.requests.length - 1].id;
  return s;
};

module.exports = { base, obs, delObs, check, model, make, code, journey, hazard, declined, request };
