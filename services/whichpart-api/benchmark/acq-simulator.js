'use strict';
/**
 * ACQ-100 deterministic multi-turn customer simulator.
 *
 * Given a journey's gold script, it drives a realistic customer conversation:
 *   - turn 0 is the customer's opening line(s) from the journey,
 *   - after each assistant reply, if the assistant asked a discriminating
 *     question, the simulator recognises the QUESTION INTENT semantically and
 *     returns the pre-scripted customer answer that supplies the intended fact,
 *   - it also supplies a model number on a later turn when the journey is
 *     "model supplied later", or a correction when scripted.
 *
 * It never requires exact assistant wording — intent is matched by keyword
 * families. The conversation STOPS when:
 *   - the correct grounded outcome is reached (outcomeReached),
 *   - a correct normal/no-fault outcome is reached,
 *   - a correct safety stop is reached,
 *   - the assistant gives up / expresses inability appropriately,
 *   - or the max-turn budget is hit (no endless loops).
 *
 * PURE + deterministic: the caller injects `callTurn(messages) -> view`, so the
 * simulator is fully unit-testable with a fake transport (no network).
 */

const { termPresent, viewHaystack, safetyTriggered, askedQuestion } = require('./acq-scoring.js');

function conversationWindow(hist, cap = 12) {
  if (!hist.length) return [];
  const firstUser = hist.findIndex((m) => m && m.role === 'user');
  if (firstUser < 0) return [];
  let start = Math.max(0, hist.length - cap);
  if (start < firstUser) start = firstUser;
  if (hist[start] && hist[start].role !== 'user') {
    const opening = hist[firstUser];
    return [opening, ...hist.slice(-(cap - 1)).filter((m) => m !== opening)];
  }
  return hist.slice(start);
}

// Semantic question-intent families. Each maps a set of keyword cues (that an
// assistant question might contain) to the gold "fact key" the customer can
// answer. Journeys declare `simulatedAnswers: { <factKey>: "<customer reply>" }`.
const INTENT_CUES = Object.freeze({
  model: ['model number', 'model no', 'model', 'e-nr', 'enr', 'pnc', 'serial', 'rating plate', 'sticker', 'what model', 'which model'],
  drum_turns: ['drum turn', 'drum rotate', 'turn by hand', 'spin by hand', 'does the drum', 'motor', 'hum', 'rotate freely'],
  drains: ['drain', 'water left', 'empty', 'pump out', 'water go'],
  fills: ['fill', 'water coming in', 'take water', 'water in'],
  error_code: ['error code', 'error', 'code on', 'display show', 'showing', 'fault code', 'what code'],
  noise_stage: ['when does', 'which part of the cycle', 'during', 'on spin', 'on drain', 'washing or', 'stage'],
  heat: ['hot', 'heating', 'cold water', 'warm', 'temperature'],
  leak_location: ['where', 'front or', 'underneath', 'from the', 'which side', 'location of the leak'],
  age_use: ['how old', 'how long', 'recently', 'new', 'just installed', 'always'],
  already_tried: ['already', 'replaced', 'changed', 'checked', 'tried'],
  power: ['power', 'switch on', 'turn on', 'lights', 'dead', 'display come'],
  smell_burning: ['smell', 'burning', 'smoke'],
  spins_slowly: ['slow', 'slowly', 'speed', 'attempt to spin'],
});

/** Recognise the assistant question's intent -> the fact key(s) it targets. */
function recogniseQuestionIntent(view) {
  const q = String((view && view.reply) || '').toLowerCase();
  if (view && view.needsModel) return 'model';
  const hits = [];
  for (const [factKey, cues] of Object.entries(INTENT_CUES)) {
    if (cues.some((c) => q.includes(c))) hits.push(factKey);
  }
  // Prefer the most specific single intent: return the first that the journey can answer.
  return hits;
}

/**
 * Decide whether the correct grounded outcome has been reached on a given view.
 * Uses the same customer-facing surface as scoring (no internal ids).
 */
function outcomeReached(view, gold) {
  if (!view) return false;
  const outcome = (gold && gold.expectedOutcome) || 'DIAGNOSIS';
  if (outcome === 'SAFETY_STOP') return safetyTriggered(view);
  const hay = viewHaystack(view);
  if (outcome === 'NORMAL') {
    return /normal|working (as )?(normal|expected|correctly)|nothing wrong|no fault|as designed|not a fault|expected behaviour/i.test(String(view.reply || '').toLowerCase());
  }
  if (outcome === 'NO_PART' || outcome === 'EXTERNAL') {
    const suspects = (gold && (gold.goldSuspects || gold.expectedSuspects)) || [];
    return suspects.length ? suspects.some((s) => termPresent(s, hay)) : true;
  }
  // DIAGNOSIS: reached when the must-include criticals (or, if none, a majority
  // of gold suspects) appear AND the assistant is not merely asking a question.
  const mustInclude = (gold && gold.mustInclude) || [];
  if (mustInclude.length) return mustInclude.every((m) => termPresent(m, hay));
  const suspects = (gold && (gold.goldSuspects || gold.expectedSuspects)) || [];
  if (!suspects.length) return !askedQuestion(view);
  const covered = suspects.filter((s) => termPresent(s, hay)).length;
  return covered >= Math.ceil(suspects.length / 2);
}

/**
 * Produce the next simulated customer message given the assistant's latest view,
 * or null if there's nothing sensible left to say (assistant asked something we
 * can't answer / repeated a question we've already answered).
 * `answered` is a Set of fact keys already supplied.
 */
function nextCustomerReply(view, gold, answered) {
  const answers = (gold && gold.simulatedAnswers) || {};
  const intents = recogniseQuestionIntent(view);
  for (const factKey of intents) {
    if (answered.has(factKey)) continue; // don't re-answer the same thing (also flags repetition upstream)
    if (answers[factKey]) { answered.add(factKey); return answers[factKey]; }
  }
  // Model-supplied-later: if the assistant needs the model and we have a scripted
  // late model, supply it even if not explicitly in simulatedAnswers.
  if ((view && view.needsModel) && gold && gold.lateModel && !answered.has('model')) {
    answered.add('model');
    return `It's model ${gold.lateModel}.`;
  }
  // Scripted proactive follow-up turns (e.g. a correction) that aren't question-driven.
  const scripted = (gold && gold.scriptedFollowups) || [];
  const idx = answered.size; // rough progression
  if (scripted[idx]) return scripted[idx];
  return null;
}

/**
 * Run one journey to completion.
 * @param {object} journey  ACQ journey with .turns (opening) and .gold
 * @param {(messages:Array)=>Promise<{view:object, latencyMs:number}>} callTurn
 * @param {object} [opts] { now }
 * @returns {Promise<object>} transcript + stop reason + outcome index + timings
 */
async function runJourney(journey, callTurn, opts = {}) {
  const gold = journey.gold || journey;
  const maxTurns = Number(gold.maxTurns) || 4;
  const now = opts.now || (() => Date.now());

  const messages = [];
  const transcript = []; // { userText, view, latencyMs }
  const answered = new Set();
  // Pre-seed already-known facts so the simulator won't "re-answer" them and so
  // question-quality can detect the assistant asking for something already given.
  for (const k of (gold.alreadyKnownFacts || [])) answered.add(k);

  // Opening customer turn(s): journey.turns[0] is the first line; any additional
  // opening lines in turns[] beyond index 0 are only used if the model doesn't
  // drive the conversation (kept for parity with the 775 corpus shape).
  const opening = (journey.turns && journey.turns[0]) || gold.opening || '';
  let pending = opening;

  const startedAll = now();
  let outcomeTurnIndex = -1;
  let stopReason = 'MAX_TURNS';

  for (let turn = 0; turn < maxTurns; turn++) {
    messages.push({ role: 'user', content: pending });
    const t0 = now();
    let view = null;
    try {
      const r = await callTurn(conversationWindow(messages, 12));
      view = r && r.view ? r.view : r;
    } catch (e) {
      view = {
        reply: '', _transportError: true, _error: String(e && e.message || e),
        // Diagnostic only (never scored): the typed transport failure, when the transport provides one.
        _transport: {
          kind: (e && e.kind) || null, httpStatus: (e && e.httpStatus) || null, category: (e && e.category) || null,
          message: String((e && e.message) || e).slice(0, 240),
        },
      };
    }
    const latencyMs = now() - t0;
    transcript.push({ userText: pending, view, latencyMs });
    if (view && view.reply) messages.push({ role: 'assistant', content: view.reply });

    if (view && view._transportError) { stopReason = 'TRANSPORT_ERROR'; break; }

    if (outcomeReached(view, gold)) {
      if (outcomeTurnIndex < 0) outcomeTurnIndex = turn;
      stopReason = 'OUTCOME_REACHED';
      break;
    }
    // Appropriate inability/uncertainty: assistant asks for the model or says it
    // needs more info AND the journey has nothing left to offer -> stop cleanly.
    const reply = nextCustomerReply(view, gold, answered);
    if (reply == null) {
      stopReason = askedQuestion(view) ? 'NO_MORE_CUSTOMER_INFO' : 'ASSISTANT_STOPPED';
      break;
    }
    pending = reply;
  }

  const totalElapsedMs = now() - startedAll;
  const perTurnLatencyMs = transcript.map((t) => t.latencyMs);
  return {
    journeyId: journey.journeyId,
    family: journey.family,
    transcript,
    outcomeTurnIndex,
    stopReason,
    perTurnLatencyMs,
    firstResponseMs: perTurnLatencyMs[0] != null ? perTurnLatencyMs[0] : null,
    totalElapsedMs,
  };
}

module.exports = {
  INTENT_CUES, recogniseQuestionIntent, outcomeReached, nextCustomerReply, runJourney,
};
