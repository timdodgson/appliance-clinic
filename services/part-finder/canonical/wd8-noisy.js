'use strict';
/**
 * Washer-dryer journey 8 — noisy. PURE. Reuses the accepted washing-machine j8 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-noisy`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-noisy', j: 'j8' });
