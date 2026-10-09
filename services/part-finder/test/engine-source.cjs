/**
 * The diagnosis engine's source text, for the static checks some tests make on it: the handler file followed by its
 * engine/ modules. Since Phase 8 the engine is split across these files; the checks apply to the engine as a whole.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['part-finder-lambda.js', ...fs.readdirSync(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.js')).sort().map((f) => `engine/${f}`)];

module.exports = function engineSource() {
  return FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
};
