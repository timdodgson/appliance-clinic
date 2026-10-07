'use strict';
/**
 * Washer-dryer journey 1 — not draining / water left in the drum. PURE. Reuses the accepted washing-machine j1 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-not-draining`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-not-draining', j: 'j1' });
