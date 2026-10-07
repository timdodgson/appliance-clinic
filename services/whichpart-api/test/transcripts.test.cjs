'use strict';

/**
 * Production transcript observability — deterministic unit tests.
 * No network, no DynamoDB, no orchestrator.
 *
 *   node services/whichpart-api/test/transcripts.test.cjs
 */
const tx = require('../transcripts');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? '  :: ' + detail : '')); }
}

const now = new Date('2026-09-18T12:00:00.000Z');
const SID = 's-abc123xyz';
const TID = 't-turn-1';

function view(extra) {
  return Object.assign({
    requestId: 'rid-1',
    traceId: 'tr-1',
    reply: 'Likely a blocked pump filter. Clean it with the machine off.',
    safety: false,
    error: false,
    diagnosis: { label: 'Not draining', summary: 'Likely a blocked pump filter.' },
    parts: [{ name: 'Pump filter', fitStatus: 'VERIFY_FIT' }],
    media: [{ id: 'wm-pump-filter', type: 'DIAGRAM', title: 'Where the pump filter is' }],
  }, extra || {});
}
function orch(extra) {
  return Object.assign({
    outcome: 'ANSWER',
    route: 'SYMPTOMS',
    traceId: 'tr-1',
    resolvedModel: null,
    safety: { class: 'NORMAL', stopUse: false },
    _telemetry: { submitted: { displayedCode: null, make: 'bosch', applianceFamily: 'washing machine' } },
  }, extra || {});
}

console.log('OBSERVABILITY EXTRACTION');
{
  const body = { messages: [{ role: 'user', content: 'hi' }], observability: { sessionId: SID, clientTurnId: TID, event: 'turn' } };
  const obs = tx.takeObservability(body);
  check('strips observability from the body', body.observability === undefined);
  check('keeps messages for diagnosis', Array.isArray(body.messages) && body.messages.length === 1);
  check('captures anonymous session id', obs.sessionId === SID && obs.clientTurnId === TID && obs.event === 'turn');
  check('rejects email-like session ids', tx.takeObservability({ observability: { sessionId: 'a@b.com-session' } }) === null);
  check('rejects short ids', tx.isValidSessionId('abc') === false);
  check('accepts uuid-like ids', tx.isValidSessionId('2c4f1a2e-9b0c-4d5e-8f1a-1234567890ab') === true);
}

console.log('TURN ORDER + SESSION CONTINUATION');
{
  const store = tx.createMemoryStore();
  const obs = { sessionId: SID, clientTurnId: TID, event: 'turn' };
  tx.persistTurn(store, obs, {
    now, messages: [{ role: 'user', content: 'Bosch washer will not drain' }],
    view: view(), orch: orch(), requestId: 'rid-1',
  }).then(async () => {
    const obs2 = { sessionId: SID, clientTurnId: 't-turn-2', event: 'turn' };
    await tx.persistTurn(store, obs2, {
      now: new Date('2026-09-18T12:05:00.000Z'),
      messages: [
        { role: 'user', content: 'Bosch washer will not drain' },
        { role: 'assistant', content: 'Likely a blocked pump filter.' },
        { role: 'user', content: 'I cleaned it, still full' },
      ],
      view: view({ reply: 'Then we should look at the drain pump itself.', parts: [] }),
      orch: orch({ outcome: 'ANSWER' }), requestId: 'rid-2',
    });
    const rec = await store.get(SID);
    check('same session id continues', rec.sessionId === SID);
    check('turns ordered 1 then 2', rec.turns[0].seq === 1 && rec.turns[1].seq === 2 && rec.turnCount === 2);
    check('customer text is first turn', rec.turns[0].customer.text === 'Bosch washer will not drain');
    check('second customer text recorded', rec.turns[1].customer.text === 'I cleaned it, still full');
    check('exact assistant text stored', rec.turns[0].customerVisible.reply.indexOf('blocked pump filter') !== -1);
    check('family/make from request path', rec.family === 'washing machine' && rec.make === 'bosch');
    check('parts surfaced on first turn', rec.turns[0].customerVisible.parts[0].name === 'Pump filter');
    check('media surfaced on first turn', rec.turns[0].customerVisible.media[0].id === 'wm-pump-filter');

    console.log('IDEMPOTENCY');
    await tx.persistTurn(store, obs, {
      now, messages: [{ role: 'user', content: 'Bosch washer will not drain' }],
      view: view({ reply: 'Retry reply should replace, not duplicate.' }), orch: orch(), requestId: 'rid-1b',
    });
    const rec2 = await store.get(SID);
    check('retry with same clientTurnId does not duplicate', rec2.turnCount === 2);
    check('retry replaces assistant text', rec2.turns[0].customerVisible.reply.indexOf('Retry reply') !== -1);

    console.log('NEW CHAT / END');
    await tx.persistEnd(store, { sessionId: SID, event: 'end' }, new Date('2026-09-18T12:10:00.000Z'));
    const ended = await store.get(SID);
    check('New Chat marks ended, not completed', ended.status === 'ended' && tx.deriveLifecycle(ended, now) === 'ended');
    check('does not invent success', ended.outcome !== 'SUCCESS' && ended.outcome !== 'completed');

    console.log('INACTIVE vs COMPLETED');
    const stale = tx.emptyRecord('s-stale-session', new Date('2026-09-18T08:00:00.000Z'));
    stale.lastActivityAt = '2026-09-18T08:00:00.000Z';
    stale.status = 'active';
    check('old active session is inactive, not completed',
      tx.deriveLifecycle(stale, now) === 'inactive');

    console.log('ERROR + SAFETY');
    const errStore = tx.createMemoryStore();
    await tx.persistTurn(errStore, { sessionId: 's-error-session', clientTurnId: 't1', event: 'turn' }, {
      now, messages: [{ role: 'user', content: 'hello' }],
      view: { reply: 'Sorry — something went wrong.', error: true, parts: [], media: [], safety: false },
      orch: null, requestId: 'rid-err',
    });
    const errRec = await errStore.get('s-error-session');
    check('API error is recorded honestly', errRec.hasError === true && errRec.outcome === 'ERROR');

    const safStore = tx.createMemoryStore();
    await tx.persistTurn(safStore, { sessionId: 's-safe-session', clientTurnId: 't1', event: 'turn' }, {
      now, messages: [{ role: 'user', content: 'it smells of gas' }],
      view: view({ reply: 'Stop using it and ventilate.', safety: true, parts: [], media: [],
        safetyInformation: { text: 'If you smell gas, stop and ventilate.', classification: 'STOP_USE' } }),
      orch: orch({ outcome: 'SAFETY_STOP', route: 'SYMPTOMS', safety: { class: 'STOP_USE', stopUse: true } }),
      requestId: 'rid-s',
    });
    const saf = await safStore.get('s-safe-session');
    check('safety stop visible on overview', saf.safetyStop === true && saf.outcome === 'SAFETY_STOP');

    console.log('CUSTOMER-VISIBLE vs METADATA + NO COT / PHOTOS');
    const built = tx.buildTurn({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'here is the plate' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/secretphoto' } },
      ] }],
      view: view(), orch: orch({ message: 'hidden chain-of-thought should not be stored as a field' }),
      requestId: 'rid-1', clientTurnId: TID, now,
    });
    const blob = JSON.stringify(built);
    check('photo bytes are not stored', !blob.includes('secretphoto') && !blob.includes('data:image'));
    check('photo flag is stored', built.customer.photo === true);
    check('no chain-of-thought field', !Object.prototype.hasOwnProperty.call(built, 'reasoning')
      && !blob.includes('chain-of-thought'));
    const drill = tx.drillDown({ sessionId: SID, turns: [built], status: 'active', lastActivityAt: now.toISOString(), createdAt: now.toISOString() }, now);
    check('customer-visible block is labelled', drill.customerVisible.label === 'CUSTOMER SAW THIS');
    check('metadata block is labelled', drill.diagnosticMetadata.label === 'INTERNAL DIAGNOSTIC METADATA');
    check('customer-visible has the reply, not route', drill.customerVisible.turns[0].applianceClinic.reply.indexOf('blocked pump filter') !== -1
      && !Object.prototype.hasOwnProperty.call(drill.customerVisible.turns[0], 'route'));
    check('route lives in metadata', drill.diagnosticMetadata.route === 'SYMPTOMS', JSON.stringify(drill.diagnosticMetadata));

    console.log('PAGINATION + FILTERS');
    const pageStore = tx.createMemoryStore();
    for (let i = 0; i < 30; i++) {
      const id = 's-page-' + String(i).padStart(2, '0') + 'abcd';
      await tx.persistTurn(pageStore, { sessionId: id, clientTurnId: 't1', event: 'turn' }, {
        now: new Date(now.getTime() + i * 1000),
        messages: [{ role: 'user', content: i % 2 ? 'Bosch dishwasher leaking' : 'Hotpoint dryer noisy' }],
        view: view({ reply: 'Advice ' + i, error: i === 3, safety: i === 5, parts: i === 7 ? [{ name: 'Belt' }] : [] }),
        orch: orch({
          route: i % 2 ? 'SYMPTOMS' : 'ERROR_CODE',
          outcome: i === 5 ? 'SAFETY_STOP' : 'ANSWER',
          safety: i === 5 ? { class: 'STOP_USE', stopUse: true } : { class: 'NORMAL', stopUse: false },
          _telemetry: { submitted: {
            displayedCode: i === 9 ? 'F06' : null,
            make: i % 2 ? 'bosch' : 'hotpoint',
            applianceFamily: i % 2 ? 'dishwasher' : 'tumble-dryer',
          } },
        }),
        requestId: 'r' + i,
      });
    }
    const p1 = await pageStore.list({ limit: 10 }, now);
    check('page size respected', p1.items.length === 10);
    check('next cursor present', typeof p1.nextCursor === 'string' && p1.nextCursor.length > 4);
    const p2 = await pageStore.list({ limit: 10, cursor: p1.nextCursor }, now);
    check('second page is different sessions', p2.items[0].sessionId !== p1.items[0].sessionId);
    const bosch = await pageStore.list({ limit: 50, make: 'bosch' }, now);
    check('make filter', bosch.items.length === 15 && bosch.items.every((r) => r.make === 'bosch'));
    const dish = await pageStore.list({ limit: 50, family: 'dishwasher' }, now);
    check('family filter', dish.items.length === 15);
    const errs = await pageStore.list({ limit: 50, errors: '1' }, now);
    check('errors filter', errs.items.length >= 1 && errs.items.every((r) => r.hasError));
    const safes = await pageStore.list({ limit: 50, safety: '1' }, now);
    check('safety filter', safes.items.length >= 1 && safes.items.every((r) => r.safetyStop));
    const search = await pageStore.list({ limit: 50, q: 'dishwasher leaking' }, now);
    check('text search over customer text in the queried window', search.items.length >= 1);

    console.log('RETENTION / TTL');
    const recTtl = tx.emptyRecord('s-ttl-session', now);
    check('TTL epoch is ~90 days ahead', recTtl.expiresAt === Math.floor(now.getTime() / 1000) + 90 * 86400
      || Math.abs(recTtl.expiresAt - (Math.floor(now.getTime() / 1000) + 90 * 86400)) < 2);
    check('retention days exposed on policy', tx.policy().retentionDays === 90);
    check('policy lists photo bytes as not stored', tx.policy().notStored.some((x) => /photo bytes/i.test(x)));

    console.log('FAILURE ISOLATION');
    const throwing = {
      async get() { throw new Error('dynamo down'); },
      async put() { throw new Error('dynamo down'); },
    };
    const isolated = await tx.persistSafely(throwing, () => tx.persistTurn(throwing, { sessionId: SID, clientTurnId: 't1', event: 'turn' }, {
      now, messages: [{ role: 'user', content: 'x' }], view: view(), orch: orch(), requestId: 'r',
    }), function () {});
    check('persist failure is swallowed', isolated.ok === false);

    console.log('OPENING PREVIEW + STORED-REVIEW VIEWS');
    const reviewedStore = tx.createMemoryStore();
    await tx.persistTurn(reviewedStore, { sessionId: 's-open-preview01', clientTurnId: 't1', event: 'turn' }, {
      now, messages: [{ role: 'user', content: 'My washing machine isn\'t draining and it smells musty' }],
      view: view(), orch: orch(), requestId: 'rid-op',
    });
    const previewRec = await reviewedStore.get('s-open-preview01');
    previewRec.status = 'ended';
    previewRec.review = {
      status: 'reviewed',
      version: 's9-v1',
      assessment: {
        overallAssessment: 'poor',
        outcome: 'no_useful_outcome',
        reviewPriority: 'worth_reviewing',
        looping: 'significant',
        safetyHandling: 'appropriate',
        suggestedProductAreas: ['conversation_flow'],
      },
    };
    await reviewedStore.put(previewRec);
    const decoy = tx.emptyRecord('s-decoy-keyword1', now);
    decoy.lastActivityAt = now.toISOString();
    decoy.turns = [{ seq: 1, at: now.toISOString(), customer: { text: 'This was a poor looping safety disaster', photo: false }, customerVisible: { reply: 'ok' } }];
    decoy.searchBlob = 'this was a poor looping safety disaster';
    decoy.review = {
      status: 'reviewed',
      version: 's9-v1',
      assessment: {
        overallAssessment: 'good',
        outcome: 'useful_outcome',
        reviewPriority: 'normal',
        looping: 'none',
        safetyHandling: 'appropriate',
        suggestedProductAreas: [],
      },
    };
    await reviewedStore.put(decoy);
    const ov = tx.overviewRow(previewRec, now);
    check('opening preview is first customer turn', ov.openingPreview.indexOf('isn\'t draining') !== -1);
    check('opening preview is truncated display text, not an LLM summary', ov.openingPreview.length <= 160);
    check('needsAttention uses stored Story 9 reasons', ov.needsAttention === true);
    check('reviewLooping comes from stored assessment', ov.reviewLooping === 'significant');
    const listed = await reviewedStore.list({ limit: 50 }, now);
    check('list rows include openingPreview', listed.items.some((r) => r.sessionId === 's-open-preview01' && /draining/.test(r.openingPreview)));
    check('newest-first chronology on list', listed.items[0].lastActivityAt >= listed.items[listed.items.length - 1].lastActivityAt);
    check('viewCounts.all includes retained conversations', listed.viewCounts.all >= 2);
    check('viewCounts.attention uses needsAttention helper', listed.viewCounts.attention >= 1);
    check('viewCounts.poor uses overallAssessment', listed.viewCounts.poor >= 1);
    check('viewCounts.loops uses looping===significant', listed.viewCounts.loops >= 1);
    check('keyword-only decoy is not poor/attention/loops', listed.items.some((r) => r.sessionId === 's-decoy-keyword1' && r.reviewOverall === 'good' && r.needsAttention === false && r.reviewLooping === 'none'));
    const poor = await reviewedStore.list({ limit: 50, overall: 'poor' }, now);
    check('poor filter is stored overallAssessment', poor.items.length === 1 && poor.items[0].sessionId === 's-open-preview01');
    const attn = await reviewedStore.list({ limit: 50, attention: '1' }, now);
    check('attention filter uses stored needsAttention', attn.items.every((r) => r.needsAttention) && attn.items.some((r) => r.sessionId === 's-open-preview01'));
    const loops = await reviewedStore.list({ limit: 50, looping: 'significant' }, now);
    check('loops filter uses stored looping', loops.items.length === 1 && loops.items[0].reviewLooping === 'significant');
    const safety = await reviewedStore.list({ limit: 50, safetyHandling: 'concern' }, now);
    check('safety view uses stored safetyHandling, not transcript words', safety.items.length === 0);
    check('matchesFilters does not regex-score customer text', tx.matchesFilters(decoy, { attention: true }, now) === false);

    console.log('SKIP WITHOUT SESSION (GOLD / TAC)');
    const skip = await tx.persistTurn(store, null, { messages: [{ role: 'user', content: 'x' }], view: view(), orch: orch() });
    check('no observability -> no persist', skip.skipped === true);

    console.log('\ntranscripts tests: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
