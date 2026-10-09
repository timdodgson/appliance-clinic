'use strict';

/** Structured JSON logging. */
function log(o) {
  try { console.log(JSON.stringify(o)); } catch { /* ignore */ }
}

module.exports = { log };
