'use strict';
/** Journey 4 pipeline — washing machine · not filling (shared model-part pipeline). PURE. */
const JP = require('./journey-pipeline.js');
const { codeFaultFor } = require('./j2-diagnostics.js');

module.exports = JP.makeModelPartPipeline({
  D: require('./j4-diagnostics.js'), P: require('./j4-policy.js'), schema: 'j4/1', codeFaultFor,
  PART_MATCH: {
    'inlet-hose': { re: /(inlet|fill|supply)\s+hose/i, not: /drain/i },
    'inlet-valve': { re: /(inlet|fill|water)\s+valve|\bsolenoid\b/i, not: /drain|non[- ]?return/i },
    'door-lock': { re: /door\s+(lock|interlock)|\binterlock\b/i, not: /seal|handle|hinge|gasket/i },
  },
  MEDIA_BY_KEY: {
    'inlet-filter': { knowledgeId: 'washing-machine:inlet-valve', ids: ['wm-inlet-hose-filter'], concepts: [] },
    'door-closed-latched': { knowledgeId: 'washing-machine:door-lock', ids: ['wm-door-lock-about'], concepts: [] },
  },
});
