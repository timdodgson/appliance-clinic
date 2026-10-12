'use strict';
/** Journey 2 BASE state builder (evidence doc §6 BASE): washing machine, active not-spinning, drains (waterRemaining=false). */
const F = require('./j1-state-fixture.cjs');
const { newFact } = require('../canonical/cs1.js');

function base() {
  const s = F.base();
  s.problems[0].journey = newFact('not-spinning', 'stated', 1);
  s.problems[0].faultDomain = newFact('motion', 'stated', 1);
  s.evidence.observations.waterRemaining = newFact(false, 'stated', 1);
  return s;
}
module.exports = { ...F, base };
