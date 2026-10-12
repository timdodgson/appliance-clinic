'use strict';
/**
 * Dishwasher family — shared typed predicates for the six dishwasher journeys (PURE). Only cross-journey ownership
 * lives here; every journey keeps its own evidence model. Each predicate reads typed cs/1 (via the step-policy helpers)
 * or the diagnostics' displayed-code faultId — never prose.
 *
 * Ownership (exactly one journey owns a turn; a handoff happens once and never bounces):
 *   flood  : water in the base tray / continuous pumping / an anti-flood code → dw-leaking (from any dishwasher journey)
 *   fill   : no / too little water on a poor-cleaning report                  → dw-not-filling
 *   heat   : cold water / dishes on a poor-cleaning report (and filling OK)   → dw-not-heating-drying
 */
const { codeFaultFor } = require('./j2-diagnostics.js');

const DW_JOURNEYS = ['not-draining', 'not-filling', 'leaking', 'poor-results', 'no-heat', 'not-drying', 'door-problem', 'wont-start', 'controls-unresponsive'];
const flood = (h) => h.obs('waterInBase') === true || h.obs('pumpRunsContinuously') === true || (h.d && h.d.codeFault === 'leak-flood');
const fillIssue = (h) => h.obs('waterEntering') === false || h.obs('fillsSlowly') === true;
const heatIssue = (h) => h.obs('noHeat') === true;
const dwCodeFault = (state, errorCodes) => codeFaultFor(state, errorCodes, 'dishwasher');

module.exports = { DW_JOURNEYS, flood, fillIssue, heatIssue, dwCodeFault };
