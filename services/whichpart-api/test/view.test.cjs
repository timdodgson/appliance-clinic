'use strict';

/**
 * Deterministic unit tests for the boundary — NO engine/network.
 * Locks the FIT INVARIANT (never claim MODEL_CONFIRMED without a resolved model + model-specific
 * part), safety part-suppression, the customer-safe projection of the ac2 turn's response, and the
 * structural conversation window the BFF forwards.
 *
 *   node services/whichpart-api/test/view.test.cjs
 */
const { toWhichPartView, conversationWindow } = require('../index.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

const orch = (extra = {}) => ({
  outcome: 'ANSWER', route: 'AC2', message: 'Likely a drain fault.',
  parts: [], resolvedModel: null, ...extra,
});
const part = (extra = {}) => ({ partNo: 'ABC123', title: 'Inverter', price: '80.00', ...extra });

// 1. No model + brand-only -> VERIFY_FIT
{
  const v = toWhichPartView(orch({ parts: [part({ _brandOnly: true })] }), 't');
  check('no model, _brandOnly -> VERIFY_FIT', v.parts[0].fitStatus === 'VERIFY_FIT', v.parts[0].fitStatus);
}
// 2. THE BUG: no model but NOT flagged brand-only -> invariant still forces VERIFY_FIT
{
  const v = toWhichPartView(orch({ parts: [part({ _brandOnly: false })] }), 't');
  check('no model, NOT flagged -> still VERIFY_FIT (invariant)', v.parts[0].fitStatus === 'VERIFY_FIT', v.parts[0].fitStatus);
  check('no model -> component rank PLAUSIBLE', v.components[0] && v.components[0].rank === 'PLAUSIBLE', v.components[0] && v.components[0].rank);
}
// 3. Model resolved + not brand-only -> MODEL_CONFIRMED
{
  const v = toWhichPartView(orch({ resolvedModel: 'NN-S560BF', parts: [part({ _brandOnly: false })] }), 't');
  check('model resolved, not brand-only -> MODEL_CONFIRMED', v.parts[0].fitStatus === 'MODEL_CONFIRMED', v.parts[0].fitStatus);
}
// 4. Model resolved + brand-only -> VERIFY_FIT
{
  const v = toWhichPartView(orch({ resolvedModel: 'NN-S560BF', parts: [part({ _brandOnly: true })] }), 't');
  check('model resolved, brand-only -> VERIFY_FIT', v.parts[0].fitStatus === 'VERIFY_FIT', v.parts[0].fitStatus);
}
// 5. Safety stop -> parts suppressed + safety flag
{
  const v = toWhichPartView({ outcome: 'SAFETY_STOP', message: 'Stop using it now.', safety: { class: 'STOP_USE', stopUse: true }, parts: [part()] }, 't');
  check('safety-stop suppresses parts', v.parts.length === 0 && v.safety === true, JSON.stringify(v.parts));
}
// 6. The reply is the diagnosis: its first sentence is the browser's lead line; markdown is flattened
{
  const v = toWhichPartView(orch({ message: 'Likely the **drain pump**. Check the [filter](/help) first.' }), 't');
  check('summary is the first sentence', v.diagnosis.summary === 'Likely the drain pump.', v.diagnosis.summary);
  check('markdown emphasis and links flattened', v.reply === 'Likely the drain pump. Check the filter first.', v.reply);
}
// 7. The view carries only the customer contract: no fields from the retired pipeline
{
  const v = toWhichPartView(orch({ message: 'Tell me more', modelRequired: true, codeResult: { meaning: 'x' }, suggestedChecks: ['a'], componentMention: 'none', traceId: null }), 't');
  check('view keys are the customer contract', Object.keys(v).sort().join(',') === 'components,diagnosis,media,parts,reply,requestId,safety,safetyInformation,traceId', Object.keys(v).sort().join(','));
  check('no internal ids leak', !/scheme|faultid|bsh_|suggestedChecks|codeResult/i.test(JSON.stringify(v)));
}

// 11. SAFETY INFORMATION passthrough (customer-safe projection)
const SI = {
  text: "Clean the lint filter after every load — a build-up of fluff is a fire risk and restricts airflow. Don't run the dryer overnight or while you're out.",
  hazard: 'lint build-up fire risk', classification: 'MAINTENANCE_SAFETY',
  applicability: 'this fault; always',
  provenance: [{ sourceType: 'uk-fire-authority', publisher: 'London Fire Brigade', url: 'https://www.london-fire.gov.uk/...' }],
};
{
  const v = toWhichPartView(orch({ safetyInformation: SI, resolvedModel: 'TD-X', parts: [part({ _brandOnly: false })] }), 't');
  check('safetyInformation surfaced', v.safetyInformation && v.safetyInformation.text === SI.text, JSON.stringify(v.safetyInformation));
  check('safetyInformation carries classification', v.safetyInformation.classification === 'MAINTENANCE_SAFETY');
  check('safetyInformation wording byte-exact', v.safetyInformation.text === SI.text);
  // provenance / hazard / applicability internals NOT exposed to the browser
  check('no provenance leaked to browser', v.safetyInformation.provenance === undefined && v.safetyInformation.hazard === undefined && v.safetyInformation.applicability === undefined, JSON.stringify(v.safetyInformation));
  // parts still behave normally alongside safety info
  check('parts unaffected by safetyInformation', v.parts.length === 1 && v.parts[0].fitStatus === 'MODEL_CONFIRMED');
}
// 12. Absent safetyInformation -> null (UI renders nothing)
{
  const v = toWhichPartView(orch({ parts: [part()] }), 't');
  check('absent safetyInformation -> null', v.safetyInformation === null);
}
// 13. Safety-STOP suppresses the safety-INFORMATION block (avoid duplicating the stop message)
{
  const v = toWhichPartView({ outcome: 'SAFETY_STOP', message: 'Stop using it now.', safety: { class: 'STOP_USE', stopUse: true }, safetyInformation: SI, parts: [] }, 't');
  check('safety-stop suppresses safetyInformation', v.safetyInformation === null && v.safety === true);
}

// 14. A turn that asks for the model carries no parts yet (parts: null from the engine)
{
  const v = toWhichPartView(orch({
    outcome: 'ANSWER', message: 'Based on what you\u2019ve described, this is likely a motor / drum fault. Could you tell me the make and model?',
    parts: null,
  }), 't');
  check('diagnosis summary present', v.diagnosis.summary.length > 0);
  check('NO parts shown before model', v.parts.length === 0);
  check('not flagged as safety', v.safety === false);
}
// 15. model resolved -> parts flow
{
  const v = toWhichPartView(orch({ outcome: 'ANSWER', resolvedModel: 'WAN28281GB', parts: [part({ _brandOnly: false })] }), 't');
  check('MODEL_CONFIRMED part', v.parts[0].fitStatus === 'MODEL_CONFIRMED');
}
// 16. a safety-information block coexists with a diagnosis that has no parts yet
{
  const v = toWhichPartView(orch({ outcome: 'ANSWER', parts: null, safetyInformation: SI }), 't');
  check('safetyInfo: safety block present', v.safetyInformation && v.safetyInformation.text === SI.text);
  check('safetyInfo: no parts', v.parts.length === 0);
}

// 21. INSTRUCTIONAL MEDIA surfaced with safe fields only
{
  const M = [{ type: 'DIAGRAM', title: 'Where the pump filter is', description: 'Behind the bottom flap. Typical — yours may differ.', url: '/media/wm-pump-filter.svg', alt: 'pump filter diagram' }];
  const v = toWhichPartView(orch({ media: M }), 't');
  check('media surfaced', v.media.length === 1 && v.media[0].url === '/media/wm-pump-filter.svg');
  check('media has only safe fields', Object.keys(v.media[0]).sort().join(',') === 'alt,description,id,intent,title,type,url');
  check('media title/alt present', v.media[0].title && v.media[0].alt);
}
// 22. media suppressed on a safety-stop
{
  const M = [{ type: 'DIAGRAM', title: 'x', description: 'y', url: '/media/x.svg', alt: 'z' }];
  const v = toWhichPartView({ outcome: 'SAFETY_STOP', message: 'Stop using it now.', safety: { class: 'STOP_USE', stopUse: true }, media: M, parts: [] }, 't');
  check('safety-stop suppresses media', v.media.length === 0 && v.safety === true);
}
// 23. absent media -> empty array (UI renders nothing)
{
  const v = toWhichPartView(orch(), 't');
  check('absent media -> []', Array.isArray(v.media) && v.media.length === 0);
}
// 24. media provenance / internal fields never reach the browser even if orch leaks them
{
  const leaky = [{ type: 'DIAGRAM', title: 't', description: 'd', url: '/media/x.svg', alt: 'a', id: 'wm-pump-filter', relatedCheck: 'clean the filter', applicability: 'GENERIC', provenance: [{ sourceType: 'own-generic-diagram', publisher: 'WhichPart' }] }];
  const v = toWhichPartView(orch({ media: leaky }), 't');
  const blob = JSON.stringify(v.media);
  check('media keeps a public id handle for later-turn dedupe', v.media[0].id === 'wm-pump-filter');
  check('media strips provenance/relatedCheck/applicability', !/relatedCheck|applicability|own-generic|"provenance"/.test(blob));
}

// 26. parts without a part number never become a card; duplicates collapse to one component
{
  const v = toWhichPartView(orch({ resolvedModel: 'WAN28281GB', parts: [part({ _brandOnly: false }), part({ _brandOnly: false }), { title: 'no number' }] }), 't');
  check('part without partNo dropped', v.parts.length === 2);
  check('components deduplicated by name', v.components.length === 1 && v.components[0].rank === 'PRIMARY');
}

{
  const seven = [];
  seven.push({ role: 'user', content: 'opening symptom' });
  for (let i = 0; i < 3; i++) {
    seven.push({ role: 'assistant', content: 'advice ' + i });
    seven.push({ role: 'user', content: 'follow up ' + i });
  }
  check('seven-turn window starts on the customer', conversationWindow(seven, 12)[0].role === 'user');
  const short = conversationWindow(seven, 6);
  check('short window that would be assistant-first keeps the opening', short[0].role === 'user' && short[0].content === 'opening symptom');
  check('short window still includes the latest user turn', short[short.length - 1].content === 'follow up 2');
}

console.log(`\nview tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
