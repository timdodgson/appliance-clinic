'use strict';
/**
 * Shared Stage C test doubles (no AWS, no network):
 *  - mockDdb(): in-memory GetItem/PutItem that ENFORCES the two condition expressions used by
 *    conversation-state.js and fails with a ConditionalCheckFailedException-shaped error.
 *  - intentFor(answers): a real Jev-adapted intent (jev-understand.adaptJevToIntent).
 *  - mc1For(intent): an mc/1 classification carrying the same facts (washing machine, not draining, water left).
 *  - partFinderUnderstand(block, intent): exactly what part-finder understand mode returns as `canonical`
 *    (the real canonicalTransportMerge, no handler).
 */
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (f) => f, HttpResponseStream: { from: (s) => s } };
const { _internal } = require('../../part-finder/part-finder-lambda.js');
const { adaptJevToIntent } = require('../../part-finder/jev-understand.js');
const mc1 = require('../../part-finder/canonical/mc1.js');

const SECRET = 'stage-c-test-secret-0123456789abcdef0123'; // deterministic, test only
const SECRETS = { current: SECRET, previous: null };

function condError() {
  const e = new Error('The conditional request failed');
  e.body = { __type: 'com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException' };
  return e;
}

function mockDdb() {
  const items = new Map();
  const calls = [];
  const faults = []; // [{action, match(pk, payload) -> bool, error}]
  async function call(action, p) {
    const pk = ((p.Key || p.Item || {}).pk || {}).S;
    calls.push({ action, pk, cond: p.ConditionExpression || null });
    const f = faults.find((x) => x.action === action && x.match(pk, p));
    if (f) { if (f.once) faults.splice(faults.indexOf(f), 1); throw f.error || new Error('boom'); }
    if (action === 'GetItem') return items.has(pk) ? { Item: JSON.parse(JSON.stringify(items.get(pk))) } : {};
    if (action === 'PutItem') {
      const cur = items.get(pk);
      if (p.ConditionExpression === 'attribute_not_exists(pk)' && cur) throw condError();
      if (p.ConditionExpression === 'stateVersion = :v'
          && (!cur || !cur.stateVersion || cur.stateVersion.N !== p.ExpressionAttributeValues[':v'].N)) throw condError();
      items.set(pk, JSON.parse(JSON.stringify(p.Item)));
      return {};
    }
    throw new Error('unexpected action ' + action);
  }
  return { items, calls, faults, call, condError };
}

const choice = (c, conf = 0.95) => ({ type: 'choice', choice: c, confidence: conf, probabilities: { [c]: conf } });
const noul = (v) => ({ type: 'noul', noul: v });
const BASE_ANSWERS = {
  onTopic: noul(0.99), requestClass: choice('appliance_request'), userIntent: choice('NEW_PROBLEM'),
  applianceFamily: choice('washing-machine'), applianceFamilyProvenance: choice('customer_named'),
  identitySufficiency: choice('need_model'), candidateTokenMeaning: choice('none'),
  answeredPrevious: choice('not_applicable'), partReadiness: choice('diagnosis_only'),
  cannotAnswer: noul(0.01), safetySignificance: choice('none'), symptomFamily: choice('not_draining'),
  needMoreInfo: noul(0.5), moreDiscriminationRequired: noul(0.2), normalBehaviour: noul(0.02),
  modelUnavailable: noul(0.02), latestTurnEstablishes: choice('symptom'), evStandingWater: noul(0.95),
};
function intentFor(overrides = {}) {
  const answers = { ...BASE_ANSWERS, ...overrides };
  return adaptJevToIntent({ model: 'jev', answers }, { questions: answers, candidates: { primary: null, secondary: null }, latestUserText: '' });
}

/** A typed mc/1 classification for the turn the intent describes (the transport test input). */
function mc1For(intent = intentFor()) {
  const appliance = intent && intent.applianceType ? intent.applianceType : 'washing-machine';
  return mc1.validateClassification({
    messageId: 'm', scope: 'appliance', intent: 'report_fault',
    identity: { appliance: { value: appliance, basis: 'stated' } },
    problem: { journey: 'not-draining', faultDomain: 'water' },
    observations: [{ key: 'waterRemaining', value: true }],
  });
}
function partFinderUnderstand(block, intent = intentFor()) {
  return _internal.canonicalTransportMerge(mc1For(intent), JSON.parse(JSON.stringify(block)));
}

module.exports = { SECRET, SECRETS, mockDdb, condError, intentFor, mc1For, partFinderUnderstand, internal: _internal };
