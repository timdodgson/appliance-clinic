'use strict';
/**
 * Washer-dryer journey 5 — overfilling. PURE. Reuses the accepted washing-machine j5 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-overfilling`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-overfilling', j: 'j5' });
