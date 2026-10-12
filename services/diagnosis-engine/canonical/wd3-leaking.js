'use strict';
/**
 * Washer-dryer journey 3 — leaking. PURE. Reuses the accepted washing-machine j3 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-leaking`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-leaking', j: 'j3' });
