'use strict';
/** Journey 5 pipeline — washing machine · overfilling (shared model-part pipeline). PURE. */
const JP = require('./journey-pipeline.js');
const { codeFaultFor } = require('./j2-diagnostics.js');

module.exports = JP.makeModelPartPipeline({
  D: require('./j5-diagnostics.js'), P: require('./j5-policy.js'), schema: 'j5/1', codeFaultFor,
  PART_MATCH: { 'inlet-valve': { re: /(inlet|fill|water)\s+valve|\bsolenoid\b/i, not: /drain|non[- ]?return/i } },
  MEDIA_BY_KEY: {},
});
