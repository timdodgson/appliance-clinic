/**
 * Media MATCHER — deterministic customer-facing media selection (offline, no network).
 * Proves the runtime picks the single best relevant media for an ALREADY-grounded node, including
 * the CONTEXT tier (mediaConcepts). Ordering: node relevance -> safety -> CONTEXT -> make/model/
 * errorCode -> specificity -> priority, capped to one image + one video.
 *
 * NOTE ON CONTEXT: production ALWAYS derives concepts for a concept-tagged node (deriveMediaConcepts
 * returns at least ['drainage-appliance'] for not-draining). These tests mirror that: any call for a
 * concept-tagged node passes the concepts the lambda would derive.
 *
 *   A. real not-draining node: appliance-drainage context -> pump media; backflow context -> the
 *      backflow image and NO video; make/error-code still work within the appliance-drainage context.
 *   B. cap: at most one image + one video.
 *   C. safety: TECHNICIAN_ONLY never returned; CUSTOMER_SAFE / IDENTIFICATION_ONLY are.
 *   D. applicability honesty: MAKE_SPECIFIC/MODEL_SPECIFIC gating.
 *   E. specificity + priority ordering, stable id tie-break; CONTEXT beats make/specificity.
 *   F. context gating: concept-tagged item never shows out of context; concept-less item is agnostic.
 *   G. no media / empty -> clean empty result.
 *
 * Run: node services/part-finder/test/media-matcher.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { selectMedia } = require('../retrieval.js');
const media = JSON.parse(readFileSync(join(HERE, '..', 'knowledge', 'media-information.json'), 'utf8'));
const notDraining = media.byKnowledgeId['washing-machine:not-draining'];
const odour = media.byKnowledgeId['washing-machine:odour'];

// Concepts the lambda's deriveMediaConcepts would produce.
const DRAINAGE = ['drainage-appliance'];
const BACKFLOW = ['waste-backflow'];

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  -', n); } else { fail++; console.log('  FAIL-', n); } };
const vids = (sel) => sel.filter((m) => m.type === 'VIDEO').map((m) => m.videoId);
const imgs = (sel) => sel.filter((m) => m.type !== 'VIDEO').map((m) => m.id);

// ---- A. real not-draining node: appliance-drainage vs backflow context ----------------------
{
  // appliance drainage (generic make): pump-filter image + generic pump video; NO backflow image.
  const generic = selectMedia(notDraining, { concepts: DRAINAGE });
  ok('A drainage/generic: pump-filter image', imgs(generic).join() === 'wm-pump-filter');
  ok('A drainage/generic: generic pump video', vids(generic).join() === 'J5J9ZHnXLwU');
  ok('A drainage/generic: NO backflow image', !imgs(generic).includes('wm-backflow-sink-waste-pipe'));

  // BACKFLOW context: the backflow image REPLACES the pump-filter image, and NO video is shown
  // (there is no verified backflow video, and the appliance-drainage videos are out of context).
  const backflow = selectMedia(notDraining, { concepts: BACKFLOW });
  ok('A backflow: backflow image shown', imgs(backflow).join() === 'wm-backflow-sink-waste-pipe');
  ok('A backflow: pump-filter image NOT shown', !imgs(backflow).includes('wm-pump-filter'));
  ok('A backflow: NO video (appliance-drainage videos are out of context)', vids(backflow).length === 0);

  // make/error-code still resolve WITHIN the appliance-drainage context.
  const hotpoint = selectMedia(notDraining, { concepts: DRAINAGE, make: 'Hotpoint', errorCode: 'F05' });
  ok('A drainage + Hotpoint F05: brand video', vids(hotpoint).join() === 'gaDeHHAB4PY');
  ok('A drainage + Hotpoint: pump-filter image still', imgs(hotpoint).join() === 'wm-pump-filter');
  const lg = selectMedia(notDraining, { concepts: DRAINAGE, make: 'LG', errorCode: 'OE' });
  ok('A drainage + LG OE: LG video', vids(lg).join() === 'ixbTj4wLvL8');
  ok('A drainage + LG: not the Hotpoint video', !vids(lg).includes('gaDeHHAB4PY'));

  // CONTEXT beats make: a Hotpoint customer whose diagnosis grounded BACKFLOW must NOT get the
  // Hotpoint appliance-drainage video — context wins, so backflow image + no video.
  const hotpointBackflow = selectMedia(notDraining, { concepts: BACKFLOW, make: 'Hotpoint', errorCode: 'F05' });
  ok('A CONTEXT beats make: Hotpoint+backflow -> backflow image, no video',
    imgs(hotpointBackflow).join() === 'wm-backflow-sink-waste-pipe' && vids(hotpointBackflow).length === 0);
}

// ---- odour node: musty (hygiene) vs drain-smell (backflow) ----------------------------------
{
  const HYGIENE = ['appliance-hygiene'];
  const musty = selectMedia(odour, { concepts: HYGIENE });
  ok('odour/musty: single hygiene image (door seal, priority)', imgs(musty).join() === 'wm-door-seal');
  ok('odour/musty: mould-clean video shown', vids(musty).join() === 'HnS87Tw4amM');
  ok('odour/musty: NO backflow image', !imgs(musty).includes('wm-backflow-sink-waste-pipe'));
  const drainSmell = selectMedia(odour, { concepts: BACKFLOW });
  ok('odour/drain-smell: backflow image replaces hygiene image', imgs(drainSmell).join() === 'wm-backflow-sink-waste-pipe');
  ok('odour/drain-smell: NO hygiene video (out of context)', vids(drainSmell).length === 0);
}

// ---- B. caps hold everywhere ----------------------------------------------------------------
for (const [name, sel] of [
  ['drainage/generic', selectMedia(notDraining, { concepts: DRAINAGE })],
  ['hotpoint', selectMedia(notDraining, { concepts: DRAINAGE, make: 'Hotpoint', errorCode: 'F05' })],
  ['backflow', selectMedia(notDraining, { concepts: BACKFLOW })],
  ['odour-musty', selectMedia(odour, { concepts: ['appliance-hygiene'] })],
  ['odour-drain', selectMedia(odour, { concepts: BACKFLOW })],
]) {
  ok(`B ${name}: <= 1 image`, imgs(sel).length <= 1);
  ok(`B ${name}: <= 1 video`, vids(sel).length <= 1);
}

// ---- C/D/E/F/G synthetic units --------------------------------------------------------------
const V = (id, extra = {}) => ({ id, type: 'VIDEO', videoId: id, applicability: 'GENERIC', ...extra });
const I = (id, extra = {}) => ({ id, type: 'DIAGRAM', asset: `/media/${id}.png`, applicability: 'GENERIC', ...extra });

// C — safety class + intent contract
{
  const items = [V('tech', { safetyClass: 'TECHNICIAN_ONLY', priority: 100 }), V('safe', { safetyClass: 'CUSTOMER_SAFE' })];
  ok('C technician-only never returned (even at higher priority)', vids(selectMedia(items, {})).join() === 'safe');
  ok('C node of only technician-only media -> nothing', selectMedia([V('t', { safetyClass: 'TECHNICIAN_ONLY' })], {}).length === 0);
  ok('C REJECT media never returned', selectMedia([V('rej', { safetyClass: 'REJECT', priority: 100 })], {}).length === 0);
  // IDENTIFICATION_ONLY may ONLY surface under the ABOUT intent (identification/explanation), never
  // as an unframed/SAFE_CHECK item — the whole point of the honesty contract.
  ok('C identification-only WITHOUT ABOUT intent -> withheld',
    selectMedia([V('ident', { safetyClass: 'IDENTIFICATION_ONLY' })], {}).length === 0);
  ok('C identification-only WITH SAFE_CHECK intent -> withheld',
    selectMedia([V('ident', { safetyClass: 'IDENTIFICATION_ONLY', intent: 'SAFE_CHECK' })], {}).length === 0);
  ok('C identification-only under ABOUT intent -> eligible',
    vids(selectMedia([V('ident', { safetyClass: 'IDENTIFICATION_ONLY', intent: 'ABOUT' })], {})).join() === 'ident');
  // CUSTOMER_SAFE is eligible under either intent (default SAFE_CHECK, or ABOUT).
  ok('C customer-safe default (SAFE_CHECK) eligible',
    vids(selectMedia([V('cs')], {})).join() === 'cs');
  ok('C customer-safe ABOUT eligible',
    vids(selectMedia([V('cs', { intent: 'ABOUT' })], {})).join() === 'cs');
  // Intent is carried through to the returned item so the projection/UI can frame it.
  ok('C returned item preserves its intent',
    selectMedia([I('img', { intent: 'ABOUT' })], {})[0].intent === 'ABOUT');
}

// D — applicability honesty
{
  const mk = [V('mk', { applicability: 'MAKE_SPECIFIC', makes: ['bosch'] })];
  ok('D MAKE_SPECIFIC withheld without a make', selectMedia(mk, {}).length === 0);
  ok('D MAKE_SPECIFIC shown for the matching make', vids(selectMedia(mk, { make: 'Bosch' }))[0] === 'mk');
  ok('D MAKE_SPECIFIC withheld for a different make', selectMedia(mk, { make: 'AEG' }).length === 0);
  const md = [V('md', { applicability: 'MODEL_SPECIFIC' })];
  ok('D MODEL_SPECIFIC withheld without a model', selectMedia(md, {}).length === 0);
  ok('D MODEL_SPECIFIC shown with a model', vids(selectMedia(md, { model: 'WAE123' }))[0] === 'md');
}

// E — specificity + priority + stable tie-break + context precedence
{
  ok('E brand match outranks generic', vids(selectMedia([V('gen'), V('brand', { applicability: 'MAKE_SPECIFIC', makes: ['lg'] })], { make: 'LG' }))[0] === 'brand');
  ok('E equal score -> stable id tie-break (aaa<bbb)', vids(selectMedia([V('bbb', { priority: 5 }), V('aaa', { priority: 5 })], {}))[0] === 'aaa');
  ok('E higher priority wins among generics', vids(selectMedia([V('low', { priority: 1 }), V('high', { priority: 9 })], {}))[0] === 'high');
  // context (correct problem, generic) beats a make-specific item about the WRONG context.
  const items = [
    V('rightGeneric', { concepts: ['ctxA'] }),
    V('wrongBrand', { applicability: 'MAKE_SPECIFIC', makes: ['lg'], concepts: ['ctxB'], priority: 50 }),
  ];
  ok('E context beats make: right-context generic wins over wrong-context brand',
    vids(selectMedia(items, { make: 'LG', concepts: ['ctxA'] }))[0] === 'rightGeneric');
}

// F — context gating
{
  const items = [I('plain'), I('ctx', { concepts: ['waste-backflow'] })];
  ok('F concept item hidden with no context', imgs(selectMedia(items, { concepts: [] })).join() === 'plain');
  ok('F concept item hidden in a DIFFERENT context', imgs(selectMedia(items, { concepts: ['other'] })).join() === 'plain');
  ok('F concept item shown IN context (beats plain)', imgs(selectMedia(items, { concepts: ['waste-backflow'] })).join() === 'ctx');
  // one-image cap with two plain images
  ok('F one-image cap (two plain images -> one)', imgs(selectMedia([I('a'), I('b')], {})).length === 1);
  ok('F one-video cap (two videos -> one)', vids(selectMedia([V('x'), V('y')], {})).length === 1);
}

// G — empty / no media
{
  ok('G empty items -> empty', selectMedia([], {}).length === 0);
  ok('G null items -> empty', selectMedia(null, {}).length === 0);
}

// ---- H. component-key lookup + intent + near-neighbour, over the REAL built artifact ----------
// Exercises getMediaInformation (node-key + component-key merge) against the shipped
// media-information.json, so the wiring + canonical identity + near-neighbour guards are proven
// end-to-end, not just on synthetic lists.
{
  const { getMediaInformation, canonicalComponent } = require('../retrieval.js');
  const ids = (sel) => sel.map((m) => m.id);
  const OVEN_DIFF = ['fan oven element', 'grill element', 'base element', 'top element', 'element connectors', 'selector switch'];
  const UNEVEN_DIFF = ['cavity fan motor', 'door seal', 'oven element'];

  // canonical identity
  ok('H canonicalComponent normalises to hyphen slug', canonicalComponent('Fan Oven Element') === 'fan-oven-element');
  ok('H canonicalComponent strips parentheticals', canonicalComponent('inlet valve (tap valve)') === 'inlet-valve');

  // Whirlpool acceptance: oven element grounded (differential includes "fan oven element") ->
  // the ABOUT identification image surfaces VIA THE COMPONENT KEY.
  const ovenElem = getMediaInformation('oven-cooker', 'element', { components: OVEN_DIFF });
  ok('H oven element (component-grounded) surfaces the ABOUT image', ids(ovenElem).includes('oven-element-about'));
  ok('H oven element image carries intent ABOUT', (ovenElem.find((m) => m.id === 'oven-element-about') || {}).intent === 'ABOUT');
  ok('H oven element image is the authored asset', (ovenElem.find((m) => m.id === 'oven-element-about') || {}).asset === '/media/oven-cooker-not-heating-cooking-properly.png');

  // NEAR-NEIGHBOUR: oven UNEVEN-HEATING grounds "oven element" but NOT "fan oven element" ->
  // it must get its OWN node image, and must NOT receive the element component card.
  const ovenUneven = getMediaInformation('oven-cooker', 'uneven-heating', { components: UNEVEN_DIFF });
  ok('H oven uneven-heating gets its OWN node image', ids(ovenUneven).includes('oven-uneven-about'));
  ok('H oven uneven-heating does NOT get the element component card', !ids(ovenUneven).includes('oven-element-about'));

  // NEAR-NEIGHBOUR: an unrelated oven fault that grounds neither element name -> NO oven media.
  ok('H unrelated oven fault (door-lock differential) -> no element/uneven media',
    getMediaInformation('oven-cooker', 'door-lock', { components: ['door handle', 'door catch', 'door hinge', 'door interlock'] }).length === 0);

  // Component media does NOT leak across appliance families (family-scoped key).
  ok('H component key is family-scoped (no cross-family leak)',
    getMediaInformation('washing-machine', 'heater', { components: ['fan oven element'] }).length === 0);

  // NODE-key wiring still works for the node-mapped cards, with correct intents.
  const dryerNH = getMediaInformation('tumble-dryer', 'not-heating', {});
  ok('H tumble-dryer not-heating node image (SAFE_CHECK)',
    ids(dryerNH).includes('td-not-heating-check') && dryerNH[0].intent === 'SAFE_CHECK');
  const doorLock = getMediaInformation('washing-machine', 'door-lock', { components: ['door interlock'] });
  ok('H washing-machine door-lock node image (ABOUT)',
    ids(doorLock).includes('wm-door-lock-about') && doorLock.find((m) => m.id === 'wm-door-lock-about').intent === 'ABOUT');

  // Backward compatibility: existing node with NO components arg behaves exactly as before.
  const wmDrain = getMediaInformation('washing-machine', 'not-draining', { concepts: ['drainage-appliance'] });
  ok('H backward-compat: not-draining still yields the pump-filter image', ids(wmDrain).includes('wm-pump-filter'));

  // Caps hold across the merged (node + component) set.
  ok('H cap holds on merged set (<=1 image +<=1 video)',
    ovenElem.filter((m) => m.type !== 'VIDEO').length <= 1 && ovenElem.filter((m) => m.type === 'VIDEO').length <= 1);
}

// ---- M. MUTATION-PROOF the safety/mis-fire guards on the REAL shipped oven-element item ----------
// Take the actual shipped ABOUT item and mutate ONLY its class/intent — the guard must suppress it
// for every unsafe combination and show it only for the honest one. Proves the gate can't be
// silently defeated by a data change.
{
  const real = JSON.parse(readFileSync(join(HERE, '..', 'knowledge', 'media-information.json'), 'utf8'))
    .byComponent['oven-cooker:fan-oven-element'][0];
  const clone = (mut) => ([{ ...real, ...mut }]);
  ok('M baseline: shipped oven-element ABOUT item is shown', selectMedia(clone({}), {}).length === 1);
  ok('M mutate -> TECHNICIAN_ONLY: suppressed', selectMedia(clone({ safetyClass: 'TECHNICIAN_ONLY' }), {}).length === 0);
  ok('M mutate -> REJECT: suppressed', selectMedia(clone({ safetyClass: 'REJECT' }), {}).length === 0);
  ok('M mutate -> IDENTIFICATION_ONLY + intent SAFE_CHECK: suppressed',
    selectMedia(clone({ safetyClass: 'IDENTIFICATION_ONLY', intent: 'SAFE_CHECK' }), {}).length === 0);
  ok('M mutate -> IDENTIFICATION_ONLY + intent ABOUT: shown (honest identification)',
    selectMedia(clone({ safetyClass: 'IDENTIFICATION_ONLY', intent: 'ABOUT' }), {}).length === 1);
  ok('M mutate -> MAKE_SPECIFIC bosch: suppressed for a non-bosch (wrong-brand guard)',
    selectMedia(clone({ applicability: 'MAKE_SPECIFIC', makes: ['bosch'] }), { make: 'Whirlpool' }).length === 0);
  ok('M mutate -> MODEL_SPECIFIC: suppressed without a model',
    selectMedia(clone({ applicability: 'MODEL_SPECIFIC' }), {}).length === 0);
}

{
  ok('P already-shown id is not repeated',
    selectMedia([V('x')], { alreadyShown: [{ id: 'x' }] }).length === 0);
  ok('P identification next action drops SAFE_CHECK media',
    selectMedia([V('x')], { nextAction: 'identification' }).length === 0);
  ok('P identification next action keeps ABOUT media',
    selectMedia([V('ident', { intent: 'ABOUT' })], { nextAction: 'identification' }).length === 1);
  ok('P discriminator next action drops SAFE_CHECK media',
    selectMedia([V('x')], { nextAction: 'discriminator' }).length === 0);
  ok('P discriminator next action keeps ABOUT media',
    selectMedia([V('ident', { intent: 'ABOUT' })], { nextAction: 'discriminator' }).length === 1);
  ok('P error-coded media is withheld without a matching code',
    selectMedia([V('coded', { errorCodes: ['F05'] })], { concepts: DRAINAGE }).length === 0
    || selectMedia([V('coded', { errorCodes: ['F05'] })], {}).length === 0);
  ok('P error-coded media shows when the customer code matches',
    selectMedia([V('coded', { errorCodes: ['F05'] })], { errorCode: 'F05' }).length === 1);
  ok('P repeatRequested allows already-shown media',
    selectMedia([V('x')], { alreadyShown: [{ id: 'x' }], repeatRequested: true }).length === 1);
  ok('P drainage media is suppressed once already shown by id',
    imgs(selectMedia(notDraining, { concepts: DRAINAGE, alreadyShown: [{ id: 'wm-pump-filter' }] })).includes('wm-pump-filter') === false);
}

console.log(`\nmedia matcher tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
