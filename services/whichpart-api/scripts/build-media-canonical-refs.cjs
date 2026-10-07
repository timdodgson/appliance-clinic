#!/usr/bin/env node
'use strict';
/**
 * Structured canonical-journey → media references (by media id, never by title/text).
 *
 * Every canonical journey module exports MEDIA_BY_KEY { actionKey: { knowledgeId?, ids: [mediaId] } }.
 * The Admin Media page uses this to show where an item is used and to block destructive deletes.
 *
 *   node services/whichpart-api/scripts/build-media-canonical-refs.cjs          # writes media-canonical-refs.json
 *   node services/whichpart-api/scripts/build-media-canonical-refs.cjs --check  # exits 1 if the file is stale
 */
const fs = require('fs');
const path = require('path');

const CANON = path.join(__dirname, '..', '..', 'part-finder', 'canonical');
const OUT = path.join(__dirname, '..', 'media-canonical-refs.json');

function build() {
  const registry = require(path.join(CANON, 'journey-registry.js'));
  const byMediaId = {};
  registry.JOURNEYS.forEach((j) => {
    const mod = require(path.join(CANON, j.module));
    const map = mod.MEDIA_BY_KEY || {};
    Object.keys(map).sort().forEach((actionKey) => {
      const ref = map[actionKey] || {};
      (ref.ids || []).forEach((id) => {
        (byMediaId[id] = byMediaId[id] || []).push({
          journey: j.key,
          family: j.family,
          actionKey,
          knowledgeId: ref.knowledgeId || j.knowledgeId,
        });
      });
    });
  });
  const sorted = {};
  Object.keys(byMediaId).sort().forEach((id) => { sorted[id] = byMediaId[id]; });
  return { version: 1, source: 'services/part-finder/canonical/*.js MEDIA_BY_KEY', byMediaId: sorted };
}

function main() {
  const next = JSON.stringify(build(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== next) { console.error('media-canonical-refs.json is stale. Re-run the build script.'); process.exit(1); }
    console.log('media-canonical-refs.json is current.');
    process.exit(0);
  }
  fs.writeFileSync(OUT, next);
  console.log('Wrote ' + path.relative(process.cwd(), OUT));
  process.exit(0);
}

if (require.main === module) main();
module.exports = { build };
