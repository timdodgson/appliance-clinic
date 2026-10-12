'use strict';
/**
 * Washer-dryer journey 6 — door problem. PURE. Reuses the accepted washing-machine j6 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-door`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-door', j: 'j6' });
