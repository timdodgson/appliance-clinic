'use strict';
/** Hob journey 4 — gas ignition (rules GH1–GH22): the shared conservative gas model (gas-ignition.js). PURE. */
const F = require('./hob-family.js');
module.exports = require('./gas-ignition.js').build({
  KEY: 'hob-ignition-gas', P: 'GH', appliance: 'hob', journeys: ['wont-light'], owns: F.owns, codeAppliance: 'hobs', applianceAsk: F.HOB_APPLIANCE_ASK,
});
