'use strict';
/**
 * The conversation record (ac3/1), stored by the BFF in DynamoDB between messages. Since the 2026-10-16 refactor it
 * holds only what the code needs between turns; the conversation itself carries everything else.
 *
 *   customer   appliance, make and model the advisor recorded (they choose the fault notes and the hazard word lists)
 *   hazards    hazards seen in the customer's words and whether their fixed warning was shown
 *   outcome    the advisor's latest outcome (diagnosing, part_needed, engineer, normal, fixed, out_of_scope, safety_stop)
 */
const SCHEMA = 'ac3/1';

function empty() {
  return { schema: SCHEMA, turn: 0, customer: { appliance: null, brand: null, model: null }, hazards: [], outcome: null };
}

/** An earlier record (any ac3/1 shape) keeps its turn, hazards and what we knew; the rest is dropped. */
function load(state) {
  if (!state || state.schema !== SCHEMA) return empty();
  const s = JSON.parse(JSON.stringify(state));
  const v = (x) => (x && typeof x === 'object' ? x.value || null : x || null);
  const c = s.customer || {};
  return {
    schema: SCHEMA,
    turn: Number.isInteger(s.turn) ? s.turn : 0,
    customer: { appliance: v(c.appliance), brand: v(c.brand), model: v(c.model) },
    hazards: Array.isArray(s.hazards) ? s.hazards : [],
    outcome: s.outcome || null,
  };
}

/** Keep what the advisor learnt; a value it did not give leaves the earlier one. */
function learn(rec, { appliance, brand, model } = {}) {
  if (appliance && appliance !== 'other' && appliance !== 'unknown') rec.customer.appliance = appliance;
  if (brand) rec.customer.brand = String(brand).slice(0, 40);
  if (model) rec.customer.model = String(model).slice(0, 40);
}

module.exports = { SCHEMA, empty, load, learn };
