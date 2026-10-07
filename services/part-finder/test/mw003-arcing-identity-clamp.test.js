/**
 * MW-003b — a microwave ARCING stop-use reply must survive the identity-scope output guard
 * (deterministic, no LLM/network).
 *
 * CUSTOMER-OUTCOME regression. The MW-003 arcing tier is a STOP-USE hazard: when the customer
 * reports sparking inside the cavity, the composed reply MUST lead with "stop using it, switch off
 * and unplug" and the safe owner checks (metal/foil, food debris, waveguide/mica cover). That reply
 * legitimately uses microwave-cavity vocabulary — "dishes with metallic trim", "grill rack",
 * "mica waveguide cover", and (on combi models) "oven/grill" — which the family-scope integrity
 * guard (constrainReplyToIdentity) misreads as a FOREIGN-FAMILY instruction. Under a strict,
 * established microwave identity (as the orchestrator supplies on a safety-significant turn) that
 * guard was REPLACING the whole stop-use reply with a bland "I am treating this as your microwave.
 * Could you describe what it is doing in a bit more detail?" clarification — silently dropping the
 * stop-use. The transcript reviewer correctly flagged this ("Safety handling needs review") for the
 * "sparks where there is burnt food splatter" journey.
 *
 * The fix: the deterministic post-compose identity-scope guard is skipped whenever the reply
 * delivers an active STOP-USE (hard safetyStop OR any diagnose-stop boundary incl. 'arcing'). This
 * test asserts that OUTCOME at the policy layer: (1) the exemption predicate exempts every stop-use
 * form and nothing else, and (2) the exemption is doing real safety work — representative arcing
 * stop-use replies ARE clamped by constrainReplyToIdentity, so without the exemption the customer
 * would lose the stop-use. No prose/regex scoring of the reply; typed state only.
 *
 * Run: node services/part-finder/test/mw003-arcing-identity-clamp.test.js
 */
const assert = require('assert');
globalThis.awslambda = globalThis.awslambda || { streamifyResponse: (fn) => fn, HttpResponseStream: { from: (s) => s } };
const {
  replyDeliversSafetyStop,
  constrainReplyToIdentity,
  allowedFamilyForReply,
  classifySafetyStop,
} = require('../part-finder-lambda.js')._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}

// ---------------------------------------------------------------------------
// A. The stop-use exemption predicate: exempt EVERY active stop-use form, nothing else.
//    This is the single policy choke point that keeps a stop-use reply out of the identity clamp.
// ---------------------------------------------------------------------------
check('A1 microwave arcing (STOP_USE_DIAGNOSE lead) is exempt from the identity clamp',
  replyDeliversSafetyStop(null, 'arcing') === true);
check('A2 hard safety stop (gas/shock/burning) is exempt',
  replyDeliversSafetyStop('burning', null) === true);
check('A3 professional-HV service boundary is exempt',
  replyDeliversSafetyStop(null, 'hv-service') === true);
check('A4 professional-HV heating boundary is exempt',
  replyDeliversSafetyStop(null, 'hv-boundary') === true);
check('A5 an ordinary diagnostic reply (no stop-use) is NOT exempt — it still gets scope integrity',
  replyDeliversSafetyStop(null, null) === false);

// Cross-check the tier wiring: the B scenario phrasing really IS the STOP_USE_DIAGNOSE arcing tier,
// so the exemption above is the one that governs that turn's reply.
const bClass = classifySafetyStop('my microwave sparks right where there is burnt food splatter inside', 'microwave');
check('A6 the "burnt food splatter" sparking turn classifies as arcing / STOP_USE_DIAGNOSE',
  bClass && bClass.category === 'arcing' && bClass.tier === 'STOP_USE_DIAGNOSE', bClass);

// ---------------------------------------------------------------------------
// B. The exemption is doing real safety work: representative arcing STOP-USE replies ARE clamped by
//    the identity-scope guard under a strict established microwave identity. Each of these leads with
//    the mandated stop-use; without the exemption the customer loses (part of) that stop-use.
// ---------------------------------------------------------------------------
const microwaveIdentity = { family: 'microwave', familyState: 'established', familyEstablished: true };
const queryText = 'my microwave sparks right where there is burnt food splatter inside';
const allowed = allowedFamilyForReply(queryText, microwaveIdentity);
check('B0 the established family resolves to microwave', allowed === 'microwave', allowed);

// Arcing stop-use replies of the kind COMPOSE produces from the microwave:sparking-arcing knowledge.
// Each opens with stop-use + safe owner checks; each contains cavity vocabulary the scope heuristic
// treats as foreign-family.
const ARCING_STOP_USE_REPLIES = [
  "Please switch off and unplug the microwave immediately and do not use it again until this is resolved. Remove any metal items or dishes with metallic trim, and clean off the burnt food splatter inside. If the sparking stops after cleaning, you can resume normal use; if it keeps arcing or you see charring on the mica waveguide cover, contact a qualified engineer.",
  "Please stop using the microwave now — switch it off and unplug it. Wipe away the burnt-on food, and check the waveguide cover (the small mica panel) for charring. Do not run the oven while it is sparking. If it still arcs once clean, book a qualified engineer.",
  "Switch off and unplug it straight away. The grill element and the metal rack can cause arcing if left in during microwave-only use, so remove them. Clean the food debris off the cavity walls. If sparking continues, get a qualified engineer.",
];

for (const [i, reply] of ARCING_STOP_USE_REPLIES.entries()) {
  const clamped = constrainReplyToIdentity(reply, microwaveIdentity, { allowedFamily: allowed });
  // Hazard proof: the guard WOULD alter/replace this stop-use reply if it were allowed to run.
  check(`B${i + 1}a identity guard would clamp arcing stop-use reply #${i + 1} (hazard present)`,
    clamped.changed === true, { reason: clamped.reason });

  // Outcome: because the reply carries an active stop-use (diagnoseStop === 'arcing'), the handler
  // SKIPS the guard, so the customer receives the stop-use reply verbatim rather than the clamp.
  const skipClamp = replyDeliversSafetyStop(null, 'arcing');
  const deliveredToCustomer = skipClamp ? reply : clamped.text;
  check(`B${i + 1}b with the stop-use exemption the customer receives the original stop-use reply #${i + 1}`,
    deliveredToCustomer === reply);
  check(`B${i + 1}c delivered reply is NOT the bland identity clarification`,
    !/could you describe what it is doing in a bit more detail/i.test(deliveredToCustomer)
    && !/what kind of appliance is it/i.test(deliveredToCustomer));
}

// ---------------------------------------------------------------------------
// C. Guard rail: the exemption must NOT disable scope integrity for ordinary diagnostic replies.
//    A genuinely cross-family reply with no stop-use is still corrected.
// ---------------------------------------------------------------------------
const crossFamilyReply =
  "It sounds like the dishwasher spray arm is blocked — clear the spray arm jets and run a rinse cycle.";
const ordinaryClamp = constrainReplyToIdentity(crossFamilyReply, microwaveIdentity, { allowedFamily: allowed });
check('C1 an ordinary (non stop-use) cross-family reply is still clamped',
  ordinaryClamp.changed === true, { reason: ordinaryClamp.reason });
check('C2 an ordinary diagnostic reply is NOT granted the stop-use exemption',
  replyDeliversSafetyStop(null, null) === false);

console.log(`\nMW-003b arcing identity-clamp: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
