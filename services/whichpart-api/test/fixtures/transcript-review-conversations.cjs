'use strict';

/**
 * Representative production-like conversations for the semantic-review contract.
 * These are fixtures for structure and judge-prompt coverage, not phrase-scoring
 * gold labels. Meaning is still judged by the LLM (injected in unit tests).
 */

function turn(seq, customer, reply, extra) {
  extra = extra || {};
  return {
    seq: seq,
    at: extra.at || '2026-09-18T10:00:00.000Z',
    customer: { text: customer, photo: Boolean(extra.photo) },
    customerVisible: {
      reply: reply,
      diagnosisLabel: extra.diagnosisLabel || null,
      safetyText: extra.safetyText || null,
      parts: extra.parts || [],
      media: extra.media || [],
      needsModel: Boolean(extra.needsModel),
    },
    metadata: extra.metadata || { route: 'SYMPTOMS', outcome: extra.outcome || 'ANSWER' },
  };
}

function base(id, turns, extra) {
  extra = extra || {};
  return {
    sessionId: id,
    createdAt: extra.createdAt || '2026-09-18T09:00:00.000Z',
    lastActivityAt: extra.lastActivityAt || '2026-09-18T09:20:00.000Z',
    endedAt: extra.endedAt || null,
    status: extra.status || 'ended',
    expiresAt: extra.expiresAt || Math.floor(Date.parse('2026-09-18T12:00:00.000Z') / 1000) + 90 * 86400,
    retentionDays: 90,
    turnCount: turns.length,
    family: extra.family || 'washing machine',
    make: extra.make || 'bosch',
    model: extra.model || null,
    errorCode: extra.errorCode || null,
    route: extra.route || 'SYMPTOMS',
    outcome: extra.outcome || 'ANSWER',
    safetyStop: Boolean(extra.safetyStop),
    safetyClass: extra.safetyClass || null,
    hasError: false,
    partsCount: extra.partsCount || 0,
    mediaCount: extra.mediaCount || 0,
    turns: turns,
    review: extra.review,
  };
}

const FIXTURES = {
  good_useful_diagnosis: base('s-good-useful-01', [
    turn(1, 'My Bosch washer fills then sits full of water. The display is normal.',
      'That usually means it cannot drain. With the machine off, check the pump filter for coins or lint, then try a drain-only programme.',
      { diagnosisLabel: 'Not draining', parts: [], media: [{ id: 'wm-pump-filter', type: 'DIAGRAM', title: 'Pump filter location' }] }),
    turn(2, 'There was a coin in the filter. It drained after I cleaned it. Thanks.',
      'Good — that matches a blocked pump filter. If it happens again, check pockets before washing.',
      { diagnosisLabel: 'Blocked pump filter' }),
  ], { endedAt: '2026-09-18T09:25:00.000Z', mediaCount: 1 }),

  sensible_clarification: base('s-clarify-01', [
    turn(1, 'The dryer is taking forever.',
      'Is this a condenser tumble dryer or a washer dryer? And is the laundry coming out warm, or still cold?',
      { diagnosisLabel: null, needsModel: true, outcome: 'CLARIFICATION_REQUIRED' }),
    turn(2, 'Condenser dryer. Clothes are warm but still damp after two hours.',
      'If the drum is heating, look at airflow next: clean the filter, condenser and vent path before replacing parts.',
      { diagnosisLabel: 'Poor drying / airflow', media: [{ id: 'td-condenser', type: 'DIAGRAM', title: 'Condenser clean' }] }),
  ], { family: 'tumble-dryer', endedAt: '2026-09-18T09:30:00.000Z', mediaCount: 1 }),

  repeated_clarification_loop: base('s-loop-01', [
    turn(1, 'Oven not heating.', 'What make and model is the oven, and is it gas or electric?', { outcome: 'CLARIFICATION_REQUIRED' }),
    turn(2, 'Electric cooker.', 'What make and model is the oven, and is it gas or electric?', { outcome: 'CLARIFICATION_REQUIRED' }),
    turn(3, 'I already said electric. Hotpoint I think.', 'What make and model is the oven, and is it gas or electric?', { outcome: 'CLARIFICATION_REQUIRED' }),
  ], { family: 'oven-cooker', make: 'hotpoint', endedAt: '2026-09-18T09:40:00.000Z', outcome: 'CLARIFICATION_REQUIRED' }),

  customer_abandonment: base('s-abandon-01', [
    turn(1, 'Dishwasher not draining after a cycle.',
      'Check the filter and the drain hose loop. Tell me what you find and we can narrow it down.',
      { diagnosisLabel: 'Not draining' }),
  ], { family: 'dishwasher', status: 'active', lastActivityAt: '2026-09-18T07:00:00.000Z', endedAt: null }),

  insufficient_evidence: base('s-thin-01', [
    turn(1, 'hi', 'What appliance is the problem with, and what is it doing or not doing?', { outcome: 'CLARIFICATION_REQUIRED' }),
  ], { family: null, make: null, endedAt: '2026-09-18T09:05:00.000Z', outcome: 'CLARIFICATION_REQUIRED' }),

  inappropriate_part: base('s-badpart-01', [
    turn(1, 'My fridge light is out but it is still cold.',
      'You will need a new compressor. I have listed one that often fits similar cabinets.',
      { diagnosisLabel: 'Compressor failure', parts: [{ name: 'Compressor', fitStatus: 'UNKNOWN' }] }),
  ], { family: 'fridge-freezer', endedAt: '2026-09-18T09:12:00.000Z', partsCount: 1, outcome: 'ANSWER' }),

  appropriate_safety_stop: base('s-safe-01', [
    turn(1, 'There is a strong gas smell when I try to light the hob.',
      'Stop using it. Open windows, do not use switches or flames, and treat this as a gas emergency until a Gas Safe engineer has checked it.',
      {
        diagnosisLabel: 'Possible gas leak',
        safetyText: 'If you smell gas, stop using the appliance, ventilate, and call the emergency number. Do not investigate live gas parts yourself.',
        outcome: 'SAFETY_STOP',
      }),
  ], { family: 'hobs', safetyStop: true, safetyClass: 'STOP_USE', endedAt: '2026-09-18T09:08:00.000Z', outcome: 'SAFETY_STOP' }),

  potential_safety_concern: base('s-unsafereply-01', [
    turn(1, 'The microwave sparks inside when I run it. Is it ok to keep using if I stand back?',
      'You can keep using it for now if you watch it. Try running it empty for a minute to burn off debris, or tape over any damaged mesh on the door.',
      { diagnosisLabel: 'Microwave sparking' }),
  ], { family: 'microwave', endedAt: '2026-09-18T09:15:00.000Z' }),

  useful_media: base('s-media-good-01', [
    turn(1, 'Where is the pump filter on this Bosch washer? It will not drain.',
      'On this layout the filter is behind the bottom-front flap. The diagram shows the access panel and the drain hose you should empty first.',
      { diagnosisLabel: 'Not draining', media: [{ id: 'wm-pump-filter', type: 'DIAGRAM', title: 'Pump filter access' }] }),
  ], { mediaCount: 1, endedAt: '2026-09-18T09:18:00.000Z' }),

  missed_media: base('s-media-miss-01', [
    turn(1, 'I cannot find the condenser on my tumble dryer and it will not dry.',
      'Clean the condenser. It is usually behind a flap at the bottom front. Pull it out and rinse it.',
      { diagnosisLabel: 'Poor drying' }),
  ], { family: 'tumble-dryer', mediaCount: 0, endedAt: '2026-09-18T09:22:00.000Z' }),
};

module.exports = { FIXTURES, turn, base };
