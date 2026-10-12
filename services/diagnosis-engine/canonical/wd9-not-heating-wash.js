'use strict';
/**
 * Washer-dryer journey 9 — wash water not heating (asks the wash / dry side first). PURE. Reuses the accepted washing-machine j9 diagnostics / policy /
 * COMPOSE through the wash-side view (wd-family.js); certified and gated separately as `wd-not-heating-wash`.
 */
module.exports = require('./wd-family.js').makeWashWrapper({ KEY: 'wd-not-heating-wash', j: 'j9', sideQuestion: true });
