'use strict';
/** Oven / cooker journey 8 — gas ignition (rules GC1–GC22): the shared conservative gas model (gas-ignition.js). PURE. */
const F = require('./ov-family.js');
module.exports = require('./gas-ignition.js').build({
  KEY: 'cooker-ignition-gas', P: 'GC', appliance: 'oven-cooker', journeys: ['wont-light'], owns: F.owns, codeAppliance: 'oven-cooker', applianceAsk: F.OVEN_APPLIANCE_ASK,
});
