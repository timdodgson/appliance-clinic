# 0021. One turn: Qwen understands, Jev labels, tools enrich, code decides, Qwen replies

- **Status:** Implemented (changes 21.2 and 21.3, 2026-10-13); the journey controller is removed
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
   already in the record, or a question the customer could not answer.
8. **Reply (Qwen).** The conversation as a normal chat plus a briefing (what we know, knowledge, plan).
9. **Final check.** Prohibited advice and unverified part numbers or prices removed; a part card only when the catalogue
   confirms it for the customer's model.
10. **Media and tags (Jev).** Jev picks the picture or video for the reply's check and tags what the reply did.
11. **Send.** If Qwen or Jev cannot run: "temporarily unavailable", no fallback answer.

## Consequences

- About 4–8 s per turn (two small Qwen calls, two Jev calls) against 10–20 s for ADR 0020's engine.
- Jev is a runtime dependency again (credit and availability need monitoring).
- No claim verifier: Qwen writes from the record and the briefing; the final check covers safety and identifiers only.
- The journey controller and the orchestrator hop are removed from the request path; rollback is git.
