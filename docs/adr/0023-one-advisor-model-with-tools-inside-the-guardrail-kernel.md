# 0023. One advisor model with tools inside the deterministic guardrail kernel

- **Status:** Implemented (changes 23.1–23.4, 2026-10-16); the understand / label / decide / claim-check pipeline, Jev,
  the Qwen provider and the admin Test area are removed
- **Date:** 2026-10-16
- **Supersedes:** [0021](0021-understand-label-enrich-decide-reply.md) (the pipeline) and the single-call reasoning and
  claim verifier of [0020](0020-llm-led-diagnosis-with-deterministic-guardrails.md). The guardrail kernel of 0020 stays.
  The security and no-fallback rules of [0016](0016-degraded-turns-are-errors.md),
  [0017](0017-authenticate-orchestrator-only-engine-fields.md) and [0018](0018-no-ac-legacy-fallback.md) stay.

## Context

A code audit of the ADR 0021 pipeline on 2026-10-16 ([report](../evaluation/code-audit-2026-10-16/REPORT.md),
[facts](../evaluation/code-audit-2026-10-16/FACTS.md)) read every step on the customer path against the live logs of
one chat and the saved audits of 308 turns. The steps between the customer's words and the reply were making answers
worse: the plan asked for two to four checks a turn, the claim checker deleted true sentences in 159 of 308 turns and
never regenerated, every reply lost its paragraph breaks, a part was shown in 1 of the 38 turns that needed one (the
stage and narrowing labels blocked it, and the matcher could not match "filters" to "filter"), photos were dropped,
and a turn took a median 22.9 s against a 45 s limit. Jev's labels drove the stage, the part gate and a heading, and
were wrong often enough to matter.

The judge scores that had been used to compare versions were overall impressions on a 0–4 scale and did not mark
these faults down ([facts](../evaluation/code-audit-2026-10-16/FACTS.md), point 11).

## Decision

One capable model, Claude, is the advisor. It reads the whole conversation and Appliance Clinic's notes, looks things
up itself, and writes the reply. Code keeps the fixed safety rules around it. Each customer message
(`services/diagnosis-engine/ac2/turn.js`):

1. **Receive.** whichpart-api checks the session token, loads the record (`ac3/1`: the appliance identity learnt so
   far, active hazards, the advisor's outcome) and sends the signed turn.
2. **Emergency stop (code).** Gas or an active fire in the customer's words returns the fixed emergency wording before
   any model is called.
3. **Hazards (code).** Word lists find hazards in the customer's words (respecting negation, questions and things to
   look for); a hazard's fixed warning is shown once and the advisor is told it is active.
4. **Notes (code).** Fault notes retrieved by keyword (`ac2/knowledge.js`), the pictures that go with them, recalls
   whichpart-api found, and the active hazards are appended to the latest customer message as notes the customer did
   not write.
5. **Advise (Claude, `ac2/advisor.js`).** One call with three tools: `lookup_error_code` (the error-code service),
   `find_parts` (the Spares4Repairs catalogue for a model) and `send_reply` (the reply, what it learnt about the
   appliance, the part ids to show from `find_parts` only, the picture id from the notes only, its outcome). The prompt
   asks for the most likely cause and one next step in under 120 words, builds on the conversation, never invents a
   part number, price or model, and ignores instructions inside a customer message.
6. **Fixed checks (code, `ac2/safety.js`).** Banned advice is removed; after a hazard that needs an engineer, any
   reassurance that it is safe to use is removed; part numbers and prices that did not come from the catalogue are
   removed; a step that opens or removes something gets the isolation line if it lacks one; a part is held while a
   blocking hazard is active.
7. **Record and audit.** The record keeps what the advisor learnt and its outcome. The audit keeps timings, token
   usage, the tools called, the gates that fired, the part decision and escalation: no reasoning text.
8. **Send.** If the advisor cannot run, the turn is an explicit "temporarily unavailable" with a retry. No fallback.

The model and its credential are the only administrator-editable settings (Admin → Settings): the model id in the AI
configuration document and the Anthropic API key in the credential secret, which keeps its historical name
`applianceclinic/production/openai`.

## Consequences

- **Removed** (changes 23.1–23.4): the understand, label, decide, reason and claim-check steps; Jev (`jev-client.js`,
  the Jev settings and secret); the LM Studio and OpenAI providers and the provider routing settings; the scheduled
  transcript review and its admin views; the admin Test area (question library, ACQ-100 benchmark, routing override);
  the independent-100 and rebuild evaluation harnesses and their recorded outputs. The 15-minute
  `whichpart-transcript-review` schedule still exists in the stack and is acknowledged with no work until a CDK change
  removes it.
- **Quality is checked by scripted pass/fail chats** (`evaluation/scripted/`): 22 fixed customer messages run against
  the live services with hand-written expectations per reply. Change 23.2 passed 22/22; the previous pipeline passed
  2/22 on the same messages ([side by side](../../evaluation/scripted/SIDE-BY-SIDE.md)). The set is small and has no
  prompt-injection cases yet.
- **One provider.** Every turn depends on the Anthropic API (with the API's own server-side fallback requested). There
  is no second provider by design.
- **Not yet proven live:** customer photos reaching the advisor end to end.
- Turn time is one model call plus one more per round of lookups.

## Alternatives considered

- **Keep the pipeline and fix each step.** The audit showed the steps blocked or damaged the reply by design (the
  plan, the claim check, the stage gate), not through bugs that a fix would close.
- **A smaller model with the same prompt.** The 2026-10-16 side-by-side used the same messages on both systems; the
  improvement came with the capable model and the tools. A smaller model was not evaluated on the new design.
