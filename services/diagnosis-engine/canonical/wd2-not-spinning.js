'use strict';
/**
 * Washer-dryer journey 2 — not spinning. PURE. Reuses the accepted washing-machine j2 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-not-spinning`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-not-spinning', j: 'j2' });
