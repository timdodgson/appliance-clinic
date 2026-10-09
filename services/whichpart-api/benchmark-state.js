'use strict';

/**
 * Benchmark run storage and the batch routing override (benchmark/routing-override.js): the API reads its status, blocks
 * Settings inference writes while a batch owns live routing, and recovers orphaned runs.
 */
const aiConfig = require('./ai-config.js');
const settingsAdmin = require('./settings-admin.js');
const { createStore: createAcqStore } = require('./benchmark/acq-store.js');
const { createRoutingOverride } = require('./benchmark/routing-override.js');
const { log } = require('./log.js');
const { acqS3 } = require('./s3.js');

const acqStore = createAcqStore({ s3: acqS3 });

const routingOverride = createRoutingOverride({
  lockStore: { get: (k) => acqS3.getWithEtag(k), put: (k, body, opts) => acqS3.putConditional(k, body, opts) },
  loadDoc: () => aiConfig.loadConfigDocument(),
  saveDoc: (doc) => aiConfig.saveConfigDocument(doc),
  revisionOf: (doc) => settingsAdmin.configRevision(doc),
  log: (o) => log(o),
});
async function routingOverrideStatusSafe() {
  try { return await routingOverride.status(); } catch (e) { return { state: 'unknown', active: false, blocked: false, error: 'Routing override status could not be read.' }; }
}
async function recoverRoutingOverride(actor) {
  return routingOverride.recover({ getRun: (id) => acqStore.getRun(id), markRunLost: (id, note, ok) => acqStore.markRunLost(id, note, ok), actor });
}

module.exports = { acqStore, routingOverride, routingOverrideStatusSafe, recoverRoutingOverride };
