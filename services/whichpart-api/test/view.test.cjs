'use strict';

/**
 * Deterministic unit tests for the boundary — NO orchestrator/network.
 * Locks the FIT INVARIANT (never claim MODEL_CONFIRMED without a resolved model + model-specific
 * part), safety part-suppression, and the conversation->context derivation used for multi-turn.
 *
 *   node services/whichpart-api/test/view.test.cjs
 */
const { toWhichPartView, deriveContext, sanitiseConversation, conversationWindow,
  resolveOrchestratorSessionId } = require('../index.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

const orch = (extra = {}) => ({
  outcome: 'ANSWER', route: 'SYMPTOMS', message: 'Likely a drain fault.',
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
// 7. needsModel only for identity clarifications (not symptom-detail asks)
{
  const id = toWhichPartView({ outcome: 'CLARIFICATION_REQUIRED', message: 'What model?', clarification: { needs: [{ attribute: 'scheme' }] }, parts: [] }, 't');
  check('identity clarification -> needsModel true', id.needsModel === true);
  const sym = toWhichPartView({ outcome: 'CLARIFICATION_REQUIRED', message: 'Tell me more', clarification: { needs: ['symptom-detail'] }, parts: [] }, 't');
  check('symptom clarification -> needsModel false', sym.needsModel === false);
}
// 8. no internal ids leak into the view
{
  const v = toWhichPartView(orch({ codeResult: { displayed: 'F06', meaning: 'NTC sensor', recordType: 'FAULT' } }), 't');
  const blob = JSON.stringify(v).toLowerCase();
  check('no scheme/faultId leak', !blob.includes('scheme') && v.diagnosis.faultId === null && !blob.includes('bsh_'));
}

// 9. deriveContext (Story 3: STRUCTURAL transport only — semantics are the orchestrator's Jev).
// The BFF no longer derives make/appliance/code/observed; it forwards the conversation. These
// assertions lock the structural transport it still produces.
{
  const ctx = deriveContext([
    { role: 'user', content: 'My Bosch washing machine says F06' },
    { role: 'user', content: 'the rating plate says WGG244FCGB/01' },
  ]);
  check('current message = latest turn', /WGG244FCGB/.test(ctx.message), ctx.message);
  check('conversationText carries the whole thread', /F06/.test(ctx.conversationText) && /WGG244FCGB/.test(ctx.conversationText), ctx.conversationText);
  check('deriveContext no longer emits semantic fields', ctx.make === undefined && ctx.appliance === undefined && ctx.displayedCode === undefined && ctx.observed === undefined, JSON.stringify(Object.keys(ctx)));
  check('sessionId present (structural)', typeof ctx.sessionId === 'string' && ctx.sessionId.startsWith('wp-'), ctx.sessionId);
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
    clarification: { question: 'What is the make and model number?', needs: [{ attribute: 'model' }] },
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

// 17. RATING-PLATE extraction -> confirmation, ZERO parts, no MODEL_CONFIRMED, make not leaked
{
  const v = toWhichPartView(orch({ outcome: 'ANSWER', message: 'Not draining. I\u2019ve read the model as WMB71442W from the photo \u2014 is that correct?',
    diagnosis: { summary: 'Not draining' }, modelRequired: true, parts: null,
    imageExtraction: { make: 'Beko', model: 'WMB71442W', source: 'IMAGE', status: 'IMAGE_EXTRACTED_UNCONFIRMED' } }), 't');
  check('extraction: extractedModel surfaced', v.extractedModel === 'WMB71442W');
  check('extraction: ZERO parts before confirmation', v.parts.length === 0);
  check('extraction: needsModel false (candidate in confirmation, not missing)', v.needsModel === false);
  check('extraction: no MODEL_CONFIRMED', !v.parts.some((p) => p.fitStatus === 'MODEL_CONFIRMED'));
  check('extraction: vision-read make not leaked', !JSON.stringify(v).includes('Beko'));
}
// 18. deriveContext: an image turn captures the latest image (structural). Rating-plate model
// EXTRACTION + confirmation is now the RAG/Jev's job, not a BFF prose parse.
{
  const c = deriveContext([{ role: 'user', content: [{ type: 'text', text: 'wont drain' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }]);
  check('image turn -> latestImage captured', !!c.latestImage);
}
// 20. safety information + image-extraction can coexist (safety survives the media turn)
{
  const v = toWhichPartView(orch({ outcome: 'ANSWER', message: 'Not heating. I\u2019ve read the model as X from the photo \u2014 correct?',
    diagnosis: { summary: 'Not heating' }, modelRequired: true, parts: null,
    imageExtraction: { make: 'Panasonic', model: 'NN-1234', source: 'IMAGE', status: 'IMAGE_EXTRACTED_UNCONFIRMED' },
    safetyInformation: SI }), 't');
  check('safety survives media turn', v.safetyInformation && v.safetyInformation.text === SI.text);
  check('safety+extraction: still zero parts', v.parts.length === 0);
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

// 25. multi-turn: assistant question survives into conversationText so a decline is bound to it
{
  const ctx = deriveContext([
    { role: 'user', content: 'The dishwasher finishes but glasses are wet and streaky' },
    { role: 'assistant', content: 'At the end of the cycle, is everything warm or hot to the touch but still wet, or does it come out stone cold?' },
    { role: 'user', content: "I don't know" },
  ]);
  check('decline follow-up keeps the advisor question in conversationText', /Advisor asked:/.test(ctx.conversationText) && /stone cold/.test(ctx.conversationText));
  check('decline follow-up keeps both customer turns', /glasses are wet/.test(ctx.conversationText) && /I don'?t know/.test(ctx.conversationText));
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
  const conv = sanitiseConversation([
    { role: 'user', content: 'it will not empty' },
    { role: 'assistant', content: 'Check the accessible trap.', media: [{ id: 'diagram-1', type: 'DIAGRAM', title: 'Where it is', url: '/media/x.png' }] },
  ]);
  check('assistant media fingerprints survive sanitise', conv[1].media && conv[1].media[0].id === 'diagram-1');
}
{
  const conv = sanitiseConversation([
    { role: 'user', content: 'it will not empty' },
    { role: 'assistant', content: 'Check the accessible trap.', safetyInformation: { text: 'Stop using it until checked.', classification: 'STOP_USE' } },
  ]);
  check('assistant safety fingerprints survive sanitise', conv[1].safetyInformation && conv[1].safetyInformation.text === 'Stop using it until checked.');
}

{
  const leading = sanitiseConversation([
    { role: 'assistant', content: 'Please describe the fault.' },
    { role: 'user', content: 'it leaks underneath on rinse' },
    { role: 'assistant', content: 'Check the filter cap.' },
    { role: 'user', content: 'yes the model is correct' },
  ]);
  check('sanitise drops a leading assistant turn', leading[0] && leading[0].role === 'user');
  check('sanitise keeps the opening customer report', leading[0].content.includes('leaks underneath'));
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

// ---- STABLE per-conversation session identity (conversation-state persistence) --------------
// The orchestrator holds deterministic ConversationState keyed on the sessionId the BFF sends. For
// established facts to persist across turns, that id MUST be stable across a conversation's turns
// yet distinct per conversation. The old id mixed in Date.now()+random (and hashed the whole
// growing user thread), so the store missed every turn and the persistence/reconciliation layer
// never engaged. These lock the stabilised behaviour.
{
  const t1 = deriveContext([
    { role: 'user', content: 'my washing machine will not spin and water is left in the drum' },
  ]);
  const t2 = deriveContext([
    { role: 'user', content: 'my washing machine will not spin and water is left in the drum' },
    { role: 'assistant', content: 'Have you checked the pump filter at the bottom front?' },
    { role: 'user', content: "I'm not sure" },
  ]);
  const t3 = deriveContext([
    { role: 'user', content: 'my washing machine will not spin and water is left in the drum' },
    { role: 'assistant', content: 'Have you checked the pump filter at the bottom front?' },
    { role: 'user', content: "I'm not sure" },
    { role: 'assistant', content: 'Please open it with towels ready and tell me what you find.' },
    { role: 'user', content: 'the filter is clear' },
  ]);
  check('session id is stable across the turns of one conversation',
    t1.sessionId === t2.sessionId && t2.sessionId === t3.sessionId,
    `${t1.sessionId} / ${t2.sessionId} / ${t3.sessionId}`);
  check('session id is deterministic (no Date/random volatility)',
    deriveContext([{ role: 'user', content: 'my washing machine will not spin and water is left in the drum' }]).sessionId === t1.sessionId,
    t1.sessionId);
}
{
  const a = deriveContext([{ role: 'user', content: 'my dishwasher is not drying the dishes' }]);
  const b = deriveContext([{ role: 'user', content: 'my oven is not heating up at all' }]);
  check('different conversations get different session ids (no state bleed)', a.sessionId !== b.sessionId,
    `${a.sessionId} vs ${b.sessionId}`);
}
{
  // The client's stable per-conversation id (observability.sessionId) is preferred as the
  // orchestrator session key; an invalid/absent one falls back to the deterministic fingerprint.
  const fallback = 'wp-abc123';
  check('valid client session id is used as the orchestrator key',
    resolveOrchestratorSessionId('b3f1c2d4e5a60718', fallback) === 'b3f1c2d4e5a60718');
  check('absent client session id falls back to the derived fingerprint',
    resolveOrchestratorSessionId(null, fallback) === fallback);
  check('too-short/invalid client session id falls back to the derived fingerprint',
    resolveOrchestratorSessionId('short', fallback) === fallback);
}

// (Story 3) Appliance-family / model-vs-error-code / compound-code interpretation used to be
// asserted here against the BFF's deriveContext. Those semantics have moved to the orchestrator's
// single Jev UNDERSTAND (validated by orchestration/tests/test_jev_authoritative_routing.py, the
// deployed acceptance run and GOLD). The BFF no longer interprets customer meaning, so there is
// nothing structural left to assert for those cases here.

console.log(`\nview tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
