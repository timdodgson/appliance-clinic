'use strict';

/**
 * Deterministic unit tests for the boundary — NO engine/network.
 * Locks the FIT INVARIANT (never claim MODEL_CONFIRMED without a resolved model + model-specific
 * part), safety part-suppression, the customer-safe projection of the ac2 turn's response, and the
 * structural conversation window / latest photo the BFF forwards.
 *
 *   node services/whichpart-api/test/view.test.cjs
 */
const { toWhichPartView, latestImageOf, conversationWindow } = require('../index.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

const orch = (extra = {}) => ({
  outcome: 'ANSWER', route: 'AC2', message: 'Likely a drain fault.',
  codeResult: null, diagnosis: { summary: 'Likely a drain fault.' },
  suggestedChecks: [], parts: [], resolvedModel: null, ...extra,
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
// 6. STATUS/MAINTENANCE mapping
{
  const v = toWhichPartView({ outcome: 'ANSWER', message: 'LOC is a status message, not a fault.', codeResult: { displayed: 'LOC', recordType: 'STATUS', meaning: 'Child lock active' }, parts: [] }, 't');
  check('STATUS not advisory, no parts', v.advisory === false && v.parts.length === 0);
  const m = toWhichPartView({ outcome: 'ANSWER', message: 'Descale required.', codeResult: { displayed: 'E12', recordType: 'MAINTENANCE', meaning: 'Descale' }, parts: [] }, 't');
  check('MAINTENANCE -> advisory tag', m.advisory === true);
}
// 7. needsModel only when the part gate asks for the model (modelRequired); retired fields stay null
{
  const id = toWhichPartView(orch({ message: 'What model?', modelRequired: true }), 't');
  check('model request -> needsModel true', id.needsModel === true);
  const sym = toWhichPartView(orch({ message: 'Tell me more' }), 't');
  check('no model request -> needsModel false', sym.needsModel === false);
  check('retired extractedModel / pendingRequest are null', sym.extractedModel === null && sym.pendingRequest === null);
}
// 8. no internal ids leak into the view
{
  const v = toWhichPartView(orch({ codeResult: { displayed: 'F06', meaning: 'NTC sensor', recordType: 'FAULT' } }), 't');
  const blob = JSON.stringify(v).toLowerCase();
  check('no scheme/faultId leak', !blob.includes('scheme') && v.diagnosis.faultId === null && !blob.includes('bsh_'));
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

// 14. STAGE-1 contract: grounded diagnosis + modelRequired coexist; NO parts; needsModel true
{
  const v = toWhichPartView(orch({
    outcome: 'ANSWER', message: 'Based on what you\u2019ve described, this is likely a motor / drum fault. ... could you tell me the make and model?',
    diagnosis: { summary: 'Motor / drum fault' }, modelRequired: true, parts: null,
  }), 't');
  check('stage1 grounded diagnosis present', v.diagnosis.label === 'Motor / drum fault' || v.diagnosis.summary.length > 0);
  check('stage1 needsModel true (from modelRequired)', v.needsModel === true);
  check('stage1 NO parts shown before model', v.parts.length === 0);
  check('stage1 not flagged as safety', v.safety === false);
}
// 15. STAGE-2: model resolved -> parts flow, needsModel false
{
  const v = toWhichPartView(orch({ outcome: 'ANSWER', resolvedModel: 'WAN28281GB', modelRequired: false,
    diagnosis: { summary: 'Not draining' }, parts: [part({ _brandOnly: false })] }), 't');
  check('stage2 needsModel false', v.needsModel === false);
  check('stage2 MODEL_CONFIRMED part', v.parts[0].fitStatus === 'MODEL_CONFIRMED');
}
// 16. STAGE-1 can coexist with a safety-information block (diagnosis + safety + model request)
{
  const v = toWhichPartView(orch({ outcome: 'ANSWER', modelRequired: true, parts: null,
    diagnosis: { summary: 'Not heating (magnetron circuit)' }, safetyInformation: SI }), 't');
  check('stage1 + safetyInfo: needsModel true', v.needsModel === true);
  check('stage1 + safetyInfo: safety block present', v.safetyInformation && v.safetyInformation.text === SI.text);
  check('stage1 + safetyInfo: no parts', v.parts.length === 0);
}

// 18. latestImageOf: the customer's latest photo is forwarded (structural); reading it is the engine's job.
{
  const img = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };
  check('image turn -> latest image captured', latestImageOf([{ role: 'user', content: [{ type: 'text', text: 'wont drain' }, img] }]) === 'data:image/jpeg;base64,AAAA');
  check('earlier photo carried forward', latestImageOf([{ role: 'user', content: [img] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and?' }]) === 'data:image/jpeg;base64,AAAA');
  check('no photo -> null', latestImageOf([{ role: 'user', content: 'x' }]) === null);
}

// 21. INSTRUCTIONAL MEDIA surfaced with safe fields only
{
  const M = [{ type: 'DIAGRAM', title: 'Where the pump filter is', description: 'Behind the bottom flap. Typical — yours may differ.', url: '/media/wm-pump-filter.svg', alt: 'pump filter diagram' }];
  const v = toWhichPartView(orch({ media: M, diagnosis: { summary: 'Not draining' } }), 't');
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
  const v = toWhichPartView(orch({ diagnosis: { summary: 'x' } }), 't');
  check('absent media -> []', Array.isArray(v.media) && v.media.length === 0);
}
// 24. media provenance / internal fields never reach the browser even if orch leaks them
{
  const leaky = [{ type: 'DIAGRAM', title: 't', description: 'd', url: '/media/x.svg', alt: 'a', id: 'wm-pump-filter', relatedCheck: 'clean the filter', applicability: 'GENERIC', provenance: [{ sourceType: 'own-generic-diagram', publisher: 'WhichPart' }] }];
  const v = toWhichPartView(orch({ media: leaky, diagnosis: { summary: 'x' } }), 't');
  const blob = JSON.stringify(v.media);
  check('media keeps a public id handle for later-turn dedupe', v.media[0].id === 'wm-pump-filter');
  check('media strips provenance/relatedCheck/applicability', !/relatedCheck|applicability|own-generic|"provenance"/.test(blob));
}

// 26. diagnosis grain controls catalogue presentation (advice-only cannot leak purchase)
{
  const leak = orch({
    message: 'Clean the condenser and try a hotter cycle.',
    componentMention: 'none',
    suggestedChecks: ['heating element', 'control pcb', 'thermostat'],
    parts: [part({ _brandOnly: false })],
  });
  const v = toWhichPartView(leak, 't');
  check('none grain does not fold Worth checking', !/Worth checking/i.test(v.reply));
  check('none grain does not name retrieved components in the reply', !/heating element|control pcb/i.test(v.reply));
  check('none grain suppresses part cards', v.parts.length === 0);
}
{
  const purchase = orch({
    message: 'Likely the drain pump.',
    componentMention: 'purchase',
    suggestedChecks: ['drain pump'],
    resolvedModel: 'WAN28281GB',
    parts: [part({ _brandOnly: false })],
  });
  const v = toWhichPartView(purchase, 't');
  check('purchase grain does not fold a component dump into the reply', !/Worth checking/i.test(v.reply));
  check('purchase grain keeps MODEL_CONFIRMED when model+model-specific part', v.parts[0].fitStatus === 'MODEL_CONFIRMED');
}
{
  const discuss = orch({
    message: 'Worth checking: fan motor, control pcb, defrost heater.',
    componentMention: 'discuss',
    suggestedChecks: ['fan motor', 'control pcb'],
    parts: [part()],
  });
  const v = toWhichPartView(discuss, 't');
  check('discuss grain strips shopping-list fold from prose', !/Worth checking:/i.test(v.reply));
  check('discuss grain does not offer purchase cards', v.parts.length === 0);
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
