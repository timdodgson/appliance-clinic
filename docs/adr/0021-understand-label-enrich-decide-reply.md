# 0021. One turn: Qwen understands, Jev labels, tools enrich, code decides, Qwen replies

- **Status:** Superseded by [0023](0023-one-advisor-model-with-tools-inside-the-guardrail-kernel.md) on 2026-10-16.
  Was implemented (changes 21.2–21.9, 2026-10-13); the journey controller is removed. **Amended by change
  21.11:** the reasoning step and the claim verifier of 0020 are restored inside this pipeline (see below)
- **Date:** 2026-10-13
- **Amends:** [0020](0020-llm-led-diagnosis-with-deterministic-guardrails.md): replaces its single reasoning pass and
  mandatory claim verifier

## Context

ADR 0020's engine gave one Qwen call the whole turn (understanding, differential, next question, part, reply) in a
structured form, under a long rulebook, then cut sentences out of the reply with a claim verifier. It beat the journey
architecture 83–17 but was well behind a general assistant on everything the model owned. The owner and the team agreed a
simpler design: small jobs for each model, a record with a fixed shape, and code deciding what each reply must do.

## Decision

**Goal of every chat:** get the customer to the right outcome (a fix they can do, the right part for their model, a clear
reason to call an engineer, or reassurance that it is normal), safely and in as few messages as possible.

Each customer message (`services/diagnosis-engine/ac2/turn.js`):

1. **Receive.** The BFF loads the chat's record (`ac3/1`, DynamoDB) and sends the signed turn.
2. **Understand (Qwen).** One small call reads the latest message and pulls out appliance, brand, model, codes,
   symptom, the customer's question, their answer, checks they did. Hints only.
3. **Label (Jev).** One call labels the message from the customer's own words, with a confidence per label: scope,
   appliance, make/model/code among candidate tokens, symptom area, hazard, unsafe request, answer to the last question,
   check outcome, model label reachable, and (once checks are done) whether the fault is narrowed to one component.
   Below threshold is "not stated", never a guess.
4. **Enrich (tools).** RAG over the fault notes, the old journeys as knowledge and normal-behaviour notes; error-code
   meanings from the error-code service (MCP); recalls; model info; the parts catalogue in stage 2 only. Kept apart from
   customer facts.
5. **Record.** Saved by the BFF; this turn's labels are the transcript tags, so real chats show where to improve.
6. **Safety.** Jev's hazard label plus the word-list backstop. Gas or an active fire: the fixed emergency wording before
   any model is called. Anything else: fixed wording once, only checks safe with the appliance off.
7. **Decide (code; Jev for fuzzy questions).** Stage 1: broad answer and safe checks, no model number asked. Stage 2
   (the owner's checks did not fix it): get the model if missing and reachable, then the part. Never ask for anything
   already in the record, or a question the customer could not answer. Build on what earlier replies already told them
   (the record keeps each reply's action, the check it gave and the question it asked); keep to the symptom they
   reported; after a hazard that needs an engineer, say so plainly.
8. **Reply (Qwen).** The conversation as a normal chat plus a briefing (what we know, knowledge); the plan for this
   reply is attached to the latest customer message as a marked note, so it is the last thing Qwen reads. A reply that
   copies an earlier one is written again once, told why; it is never replaced by fixed text.
9. **Final check.** Prohibited advice, unverified part numbers or prices, and (after such a hazard) any suggestion that
   it is safe to use or may not need an engineer, are removed; certainty no check has proved ("confirms",
   "definitely") is softened; a part card only when the catalogue confirms it for the customer's model.
10. **Media and tags (Jev).** Jev picks the picture or video for the reply's check, labels what the reply did and which
    check it gave (recorded for the next turn), and these labels become the transcript tags.
11. **Send.** If Qwen or Jev cannot run: "temporarily unavailable", no fallback answer.

## Consequences

- About 4–8 s per turn (two small Qwen calls, two Jev calls) against 10–20 s for ADR 0020's engine.
- Jev is a runtime dependency again (credit and availability need monitoring).
- No claim verifier: Qwen writes from the record and the briefing. Fidelity comes from the record instead: the facts
  the customer stated and the checks they reported (each confirmed by Jev in their words) are given as true, and the
  checks still awaiting a result are named so a reply never assumes one. The final check covers safety, certainty and
  identifiers.
- The journey controller and the orchestrator hop are removed from the request path; rollback is git.

## Live verification

Smoke chats on the live site after each release (2026-10-13), multi-turn through the public API:
- vacuum pulsing, washing machine full of water (filter, hose, model, pump hum), a Bosch error code, gas, burning smell;
- found and fixed in the plan and record, not with hard-coded replies: reassurance after a burning smell (21.4), an
  invented symptom (21.4), a reply that repeated the previous one (21.5);
- the independent-100 evaluation of 21.5 (overall 2.32, below ADR 0020's engine at 2.73) traced its losses to the plan
  and record, not the models: replies assumed checks the customer had not reported, contradicted facts they had given,
  stated guesses as certain and guessed what an unresolved code meant; the word list also matched a hazard word inside
  a question ("look for scorch marks"). Fixed in 21.6 (facts and check results in the record, confirmed by Jev; stage 2
  only on a reported check; plan wording; question-aware word list) and 21.7 (no guessed code meanings; certainty
  softened in the final check);
- the evaluation of 21.7 (2.48) showed the next class: blocking loops (14), mostly a reply copied word for word from an
  earlier one, or a model number asked for again after it was given. The record was right in each case; Qwen followed
  the chat history and copied our own earlier question, which the plan quoted back to it. Fixed in 21.8 (plan attached
  to the latest message; make, model and codes named as never to be asked again; safety steps not counted as checks)
  and 21.9 (earlier questions no longer quoted; a copied reply is written again once);
- turn time 4–8 s (Qwen understand about 1 s, Jev labels about 0.3 s, reply 2–3 s).

The full evaluation is in the [evaluation index](../evaluation/README.md).

## Amendment: change 21.11 (2026-10-13)

The evaluation of 21.9 ([ac3 pipeline results](../evaluation/ac3-pipeline-results.md): overall 2.37 against 0020's
2.73; invented customer evidence 11% against 4%) showed the pipeline's reply model crediting customers with checks they
never reported, which 0020's claim verifier existed to stop. Change 21.11 keeps steps 1–7 and 9–11 and replaces step 8:

8. **Reason and reply (Qwen, 0020's reasoner).** One structured pass over the record (as its ledger, with fact ids),
   the tools, the knowledge, the safety constraints and this reply's plan, which it must follow: candidate causes, next
   question or check, part, escalation and the reply. **Claim check (0020's verifier):** customer-specific claims the
   record does not support are objections; one regeneration with them when removing them would damage the reply (or it
   copies an earlier one), then any sentence still carrying one is removed. If the reasoner or the claim extractor
   cannot run, the turn fails explicitly.

Changes 21.14–21.17 tune that step and the final check from the judged failures of the 21.11 and 21.15 evaluations
(regeneration only within a 26 s budget; water-near-plug isolation at the consumer unit; no part purchase or
replacement before the fault is narrowed; no "no recall" claims; no dismantling advice; wider certainty softening) and
let whichpart-api wait up to 45 s for the engine. Results: [ac3 pipeline results](../evaluation/ac3-pipeline-results.md).
