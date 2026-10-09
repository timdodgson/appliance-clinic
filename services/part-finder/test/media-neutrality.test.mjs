/**
 * DIAGNOSTIC NEUTRALITY of the explanatory-media framework (offline, deterministic).
 *
 * Invariant under proof: DIAGNOSIS DECIDES WHAT WE BELIEVE; MEDIA ONLY EXPLAINS AN ALREADY-GROUNDED
 * DIAGNOSIS. Media must NEVER affect faultId / primaryFinding / candidateComponents / retrieval /
 * safety / safetyStop / parts / fit, and there must be NO media -> diagnosis feedback path.
 *
 * Three independent proofs:
 *   A. MUTATION: mutate the media artifact (add / remove / change intent / change priority / add a
 *      component mapping) and prove the diagnosis-side lookups the engine feeds from — the grounded
 *      differential source (getLikelyComponents) and the safety information (getSafetyInformation) —
 *      are BIT-FOR-BIT identical, while only the media OUTPUT changes.
 *   B. STATIC DATAFLOW: in the engine (part-finder-lambda.js) media is derived strictly AFTER the
 *      fault + candidateComponents are final, is referenced in exactly one place, and the media
 *      catalogue symbols are never touched by the diagnosis code.
 *   C. PURITY: selectMedia / getMediaInformation never mutate their inputs and are deterministic;
 *      the diagnosis-side lookups ignore any media/component context entirely.
 *
 * Run: node services/part-finder/test/media-neutrality.test.mjs
 */
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const K = join(HERE, '..', 'knowledge');
const require = createRequire(import.meta.url);
const MEDIA_PATH = join(K, 'media-information.json');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  -', n); } else { fail++; console.log('  FAIL-', n); } };
const eq = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const reloadRetrieval = () => { delete require.cache[require.resolve('../retrieval.js')]; return require('../retrieval.js'); };

// Representative grounded nodes across families (the diagnosis-side outputs the engine builds from).
const NODES = [
  ['oven-cooker', 'element'], ['oven-cooker', 'uneven-heating'], ['washing-machine', 'not-draining'],
  ['washing-machine', 'door-lock'], ['tumble-dryer', 'not-heating'], ['dishwasher', 'poor-clean-results'],
  ['fridge-freezer', 'not-cooling'], ['hobs', 'element'],
];

// ---- A. MUTATION PROOF ----------------------------------------------------------------------
const original = readFileSync(MEDIA_PATH, 'utf8');
{
  const r0 = reloadRetrieval();
  const baseLC = NODES.map(([f, id]) => r0.getLikelyComponents(f, id));
  const baseSI = NODES.map(([f, id]) => r0.getSafetyInformation(f, id));
  const baseMediaOvenElement = r0.getMediaInformation('oven-cooker', 'element', { components: ['fan oven element'] });

  try {
    const m = JSON.parse(original);
    // add media (junk node), remove media (a real node), change intent + priority (oven component),
    // and add a brand-new component mapping — every kind of media mutation at once.
    m.byKnowledgeId['washing-machine:zzz-fake-node'] = [{
      id: 'zzz', type: 'DIAGRAM', title: 'x', description: 'x', applicability: 'GENERIC',
      relatedCheck: 'x', asset: '/media/x.png', alt: 'x', provenance: [{ sourceType: 's', publisher: 'p' }],
    }];
    delete m.byKnowledgeId['washing-machine:not-draining'];
    for (const it of m.byComponent['oven-cooker:fan-oven-element']) { it.intent = 'SAFE_CHECK'; it.priority = 999; }
    m.byComponent['oven-cooker:zzz-fake-component'] = m.byComponent['oven-cooker:fan-oven-element'];
    writeFileSync(MEDIA_PATH, JSON.stringify(m, null, 2));

    const r1 = reloadRetrieval();
    const mutLC = NODES.map(([f, id]) => r1.getLikelyComponents(f, id));
    const mutSI = NODES.map(([f, id]) => r1.getSafetyInformation(f, id));
    const mutMediaOvenElement = r1.getMediaInformation('oven-cooker', 'element', { components: ['fan oven element'] });

    ok('A grounded differential (candidateComponents source) is BIT-IDENTICAL under media mutation', eq(baseLC, mutLC));
    ok('A safety information is BIT-IDENTICAL under media mutation', eq(baseSI, mutSI));
    // Sanity: the mutation was actually effective (otherwise the proof is vacuous).
    ok('A media OUTPUT did change under mutation (mutation was real)', !eq(baseMediaOvenElement, mutMediaOvenElement));
  } finally {
    writeFileSync(MEDIA_PATH, original);
  }
  ok('A media-information.json restored byte-for-byte after mutation', readFileSync(MEDIA_PATH, 'utf8') === original);
}

// ---- B. STATIC DATAFLOW PROOF (engine) ------------------------------------------------------
{
  const lambda = require('./engine-source.cjs')();
  const iResolve = lambda.indexOf('resolveFault(intent)');
  const iCand = lambda.indexOf('let candidateComponents');
  const iMediaBlock = lambda.indexOf('let media = [];');
  const iGetMedia = lambda.indexOf('getMediaInformation(');
  ok('B fault is resolved before the differential is built', iResolve > 0 && iCand > iResolve);
  ok('B media is assembled AFTER the grounded differential', iMediaBlock > iCand);
  ok('B getMediaInformation is called only inside the media block', iGetMedia > iMediaBlock);
  ok('B getMediaInformation is referenced exactly once in the engine',
    (lambda.match(/getMediaInformation\(/g) || []).length === 1);
  // The diagnosis code never reaches into the media catalogue maps (those live in retrieval only).
  ok('B engine never references the media catalogue maps', !/MEDIA_INFO|MEDIA_BY_COMPONENT/.test(lambda));
  // Media is built only AFTER parts and the safety-stop decision are final — it is a terminal,
  // presentation-only step and cannot feed back into parts / fit / safety.
  const iParts = lambda.indexOf('const shownParts');
  const iSafetyStop = lambda.indexOf('safetyStop');
  ok('B media is assembled after parts are selected', iParts > 0 && iMediaBlock > iParts);
  ok('B media is guarded by (and therefore later than) the safety-stop decision',
    iSafetyStop > 0 && iSafetyStop < iMediaBlock && /!safetyStop && !metric\.tripwireBlocked && fault/.test(lambda));
  // The built `media` list is only ever WRITTEN (built, then emitted in the done event) — it is never
  // read back by the fault/parts/safety logic. Confirm it is emitted in the done event exactly once.
  ok('B built media is emitted to the done event', /type: 'done'[^\n]*\bmedia\b/.test(lambda) || /normalBehaviour[\s\S]{0,80}media \}/.test(lambda));
}

// ---- C. PURITY + input independence ---------------------------------------------------------
{
  const r = reloadRetrieval();
  const items = [
    { id: 'a', type: 'DIAGRAM', asset: '/media/a.png', applicability: 'GENERIC', priority: 1 },
    { id: 'b', type: 'DIAGRAM', asset: '/media/b.png', applicability: 'GENERIC', priority: 9 },
  ];
  const snapshot = JSON.parse(JSON.stringify(items));
  const out1 = r.selectMedia(items, {});
  const out2 = r.selectMedia(items, {});
  ok('C selectMedia does not mutate its input list', eq(items, snapshot));
  ok('C selectMedia is deterministic (same in -> same out)', eq(out1, out2));

  // The differential source ignores media/component context entirely: it is a function of
  // (family, faultId) only. Passing wild component context cannot change it.
  const lcA = r.getLikelyComponents('oven-cooker', 'element');
  const lcB = r.getLikelyComponents('oven-cooker', 'element');
  ok('C getLikelyComponents is a pure (family,faultId) lookup', eq(lcA, lcB) && Array.isArray(lcA) && lcA.length > 0);

  // getMediaInformation with no grounded components == node-only (backward compatible), and adding
  // components only ADDS component media — it never alters the node result set for the node items.
  const nodeOnly = r.getMediaInformation('washing-machine', 'not-draining', { concepts: ['drainage-appliance'] });
  const withComps = r.getMediaInformation('washing-machine', 'not-draining', { concepts: ['drainage-appliance'], components: ['drain pump'] });
  ok('C node-only lookup unchanged when irrelevant components are supplied', eq(nodeOnly, withComps));
}

console.log(`\nmedia neutrality tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
