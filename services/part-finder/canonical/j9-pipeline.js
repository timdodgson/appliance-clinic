'use strict';
/** Journey 9 pipeline — washing machine · not heating (shared model-part pipeline). PURE. */
const JP = require('./journey-pipeline.js');
const { codeFaultFor } = require('./j2-diagnostics.js');

module.exports = JP.makeModelPartPipeline({
  D: require('./j9-diagnostics.js'), P: require('./j9-policy.js'), schema: 'j9/1', codeFaultFor,
  PART_MATCH: { heater: { re: /\bheater\b|\b(wash|heating|heater)\s+element\b/i, not: /dryer|tumble|drying|thermostat|sensor|ntc/i } },
  MEDIA_BY_KEY: {},
});
