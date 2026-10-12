'use strict';
/** Journey 7 pipeline — washing machine · excessive vibration (shared model-part pipeline). PURE. */
const JP = require('./journey-pipeline.js');
const { codeFaultFor } = require('./j2-diagnostics.js');

module.exports = JP.makeModelPartPipeline({
  D: require('./j7-diagnostics.js'), P: require('./j7-policy.js'), schema: 'j7/1', codeFaultFor,
  PART_MATCH: { 'shock-absorber': { re: /shock\s+absorber|\bdamper\b/i, not: /door|lid/i } },
  MEDIA_BY_KEY: { 'transit-bolts': { knowledgeId: 'washing-machine:excessive-vibration', ids: ['wm-transit-bolts'], concepts: [] } },
});
