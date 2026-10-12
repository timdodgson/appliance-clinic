'use strict';
/** Journey 6 pipeline — washing machine · door (shared model-part pipeline). PURE. */
const JP = require('./journey-pipeline.js');
const { codeFaultFor } = require('./j2-diagnostics.js');

const DOOR_MEDIA = { knowledgeId: 'washing-machine:door-lock', ids: ['wm-door-lock-about'], concepts: [] };
module.exports = JP.makeModelPartPipeline({
  D: require('./j6-diagnostics.js'), P: require('./j6-policy.js'), schema: 'j6/1', codeFaultFor,
  PART_MATCH: {
    'door-lock': { re: /door\s+(lock|interlock)|\binterlock\b/i, not: /seal|handle|hinge|gasket|boot/i },
    'door-handle': { re: /door\s+handle|\bhandle\b|door\s+(catch|hook)/i, not: /seal|gasket|lock|interlock/i },
  },
  MEDIA_BY_KEY: { 'door-closed-latched': DOOR_MEDIA, 'door-release-wait': DOOR_MEDIA },
});
