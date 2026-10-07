'use strict';
/**
 * Washer-dryer journey 7 — excessive vibration. PURE. Reuses the accepted washing-machine j7 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-excessive-vibration`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-excessive-vibration', j: 'j7' });
