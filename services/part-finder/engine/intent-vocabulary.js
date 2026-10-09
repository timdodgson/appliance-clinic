/**
 * The typed vocabulary of the UNDERSTAND result: user intents, finding kinds, component mentions, remote-action
 * classes, and the intent schema.
 */
const { FAULT_IDS } = require('./catalogue.js');

// Closed set of follow-up intents. UNDERSTAND classifies the customer's latest
// turn into ONE of these, so COMPOSE can respond to the follow-up WITHOUT ever
// receiving the raw customer text (the injection channel between the two passes).
const USER_INTENTS = [
  'NEW_PROBLEM',        // a new/first symptom
  'ADDING_DETAIL',      // giving make/model/error-code/extra symptom detail
  'CORRECTION',         // correcting an earlier detail ("actually it's the spray arm")
  'PRICE_QUERY',        // asking about price / cheapest
  'ALTERNATIVES_QUERY', // asking for other options / other suppliers
  'AVAILABILITY_QUERY', // asking about stock / delivery
  'FITTING_HELP',       // how to fit / replace / repair it
  'PART_REQUEST',       // directly naming a part they want to buy
  'CANT_FIND_MODEL',    // says they can't find/read the model number
  'CONFIRMATION',       // short ack ("yes", "ok", "thanks")
  'EVIDENCE_UPDATE',    // result of a check, confirmed/rejected discriminator, or "I already did that"
  'OTHER',              // anything else -> COMPOSE gives a safe on-topic response
];

const FINDING_KINDS = ['condition', 'check', 'subsystem', 'component', 'external', 'usage', 'contamination', 'unknown'];

const COMPONENT_MENTION = { NONE: 'none', DISCUSS: 'discuss', PURCHASE: 'purchase' };

const REMOTE_ACTION = {
  CUSTOMER_SAFE: 'CUSTOMER_SAFE',
  CAUTION: 'CUSTOMER_SAFE_WITH_CAUTION',
  COMPETENT_PERSON: 'COMPETENT_PERSON',
  STOP_USE: 'STOP_USE',
};

// Strict JSON schema for the understand pass — guarantees valid, conforming JSON.
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    onTopic: { type: 'boolean' },
    needMoreInfo: { type: 'boolean' },
    userIntent: { type: 'string', enum: USER_INTENTS },
    make: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    applianceType: { type: ['string', 'null'] },
    fault: { type: ['string', 'null'] },
    reportedSymptoms: { type: 'array', items: { type: 'string' } },
    faultId: { type: ['string', 'null'], enum: [...FAULT_IDS, null] },
    primaryFinding: { type: ['string', 'null'] },
    errorCode: { type: ['string', 'null'] },
    modelUnavailable: { type: 'boolean' },
    catalogueQuery: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    alternatives: { type: 'array', items: { type: 'string', enum: FAULT_IDS } },
    candidateComponents: { type: 'array', items: { type: 'string' } },
    provenGood: { type: 'array', items: { type: 'string' } },
    alreadyReplaced: { type: 'array', items: { type: 'string' } },
    nextBestCheck: { type: ['string', 'null'] },
    nextCheckCustomerSafe: {
      type: 'boolean',
      description: 'True only if nextBestCheck is a simple look/listen/settings/accessible-cleaning action with no tools or panel removal.',
    },
    furtherGenericCheckJustified: {
      type: 'boolean',
      description: 'True only when a further model-independent observation is a different discriminator from a check they already reported (a programme/command result is not the same as completing a physical inspection), and its answer would change the next action without make/model — including when the appliance family is not yet confirmed.',
    },
    normalBehaviour: { type: 'boolean' },
    clarifyingQuestion: { type: ['string', 'null'] },
    primaryFindingKind: {
      type: 'string',
      enum: ['condition', 'check', 'subsystem', 'component', 'external', 'usage', 'contamination', 'unknown'],
      description: 'Grain of primaryFinding: subsystem/condition/check until evidence justifies a component.',
    },
    customerTheories: {
      type: 'array',
      items: { type: 'string' },
      description: 'Customer guesses about the cause. Not observations. Must not be treated as facts.',
    },
    declinedFacts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Fact IDs the customer could not or would not answer. Do not re-ask these.',
    },
    newEvidenceThisTurn: {
      type: ['string', 'null'],
      description: 'What the LATEST customer turn newly established. Null on the opening turn.',
    },
    checksReported: {
      type: 'array',
      items: { type: 'string' },
      description: 'Every scoped check the customer already reported in this conversation, including earlier turns. Keep them when the latest turn is only a confirmation or identification.',
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string', enum: ['TRUE', 'FALSE', 'UNKNOWN'] },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'onTopic',
    'needMoreInfo',
    'userIntent',
    'make',
    'model',
    'applianceType',
    'fault',
    'reportedSymptoms',
    'faultId',
    'primaryFinding',
    'errorCode',
    'modelUnavailable',
    'catalogueQuery',
    'confidence',
    'alternatives',
    'candidateComponents',
    'provenGood',
    'alreadyReplaced',
    'nextBestCheck',
    'nextCheckCustomerSafe',
    'furtherGenericCheckJustified',
    'normalBehaviour',
    'clarifyingQuestion',
    'primaryFindingKind',
    'customerTheories',
    'declinedFacts',
    'newEvidenceThisTurn',
    'checksReported',
    'facts',
  ],
  additionalProperties: false,
};

module.exports = { USER_INTENTS, FINDING_KINDS, COMPONENT_MENTION, REMOTE_ACTION, INTENT_SCHEMA };
