'use strict';
/**
 * Washer-dryer journey 4 — not filling. PURE. Reuses the accepted washing-machine j4 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-not-filling`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-not-filling', j: 'j4' });
