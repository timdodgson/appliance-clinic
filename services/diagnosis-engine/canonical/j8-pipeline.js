'use strict';
/** Journey 8 pipeline — washing machine · noisy (shared model-part pipeline). PURE. */
const JP = require('./journey-pipeline.js');
const { codeFaultFor } = require('./j2-diagnostics.js');

module.exports = JP.makeModelPartPipeline({
  D: require('./j8-diagnostics.js'), P: require('./j8-policy.js'), schema: 'j8/1', codeFaultFor,
  PART_MATCH: {
    // a drain pump, never the pump FILTER (same rule as Journey 1)
    'drain-pump': { re: /drain(age)?\s+pump|\bpump\s+(assembly|motor)\b|\bpump\b/i, not: /filter|seal|circulation|heat\s*pump/i },
    'drive-belt': { re: /\bbelt\b/i, not: /tumble|agitator|dryer/i },
  },
  MEDIA_BY_KEY: { 'drain-filter': { knowledgeId: 'washing-machine:not-draining', ids: ['wm-pump-filter'], concepts: ['drainage-appliance'] } },
});
