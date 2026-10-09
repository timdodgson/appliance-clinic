/**
 * The API's request-handling source text, for the static checks some tests make on it: index.js followed by the
 * modules it was split into in Phase 8 (the root-level routing modules and admin/). The checks apply to the API as a
 * whole.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['index.js', 'config.js', 'log.js', 'http-io.js', 'rate-limiting.js', 'session.js', 's3.js',
  'benchmark-state.js', 'transcript-store.js',
  ...fs.readdirSync(path.join(ROOT, 'admin')).filter((f) => f.endsWith('.js')).sort().map((f) => `admin/${f}`)];

module.exports = function apiSource() {
  return FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
};
