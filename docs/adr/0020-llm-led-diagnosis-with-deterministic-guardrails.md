# 0020. LLM-led diagnosis inside a deterministic guardrail kernel

- **Status:** Accepted; amended by [0021](0021-understand-label-enrich-decide-reply.md), which replaced the single
  reasoning pass and the claim verifier and is the path in use
- **Date:** 2026-10-12
- **Supersedes:** the diagnostic-control parts of [0010](0010-deterministic-policy-around-llm.md) (code decides the
  diagnosis), [0014](0014-cs1-is-the-only-conversation-state.md) (cs/1), [0015](0015-one-owner-per-decision.md) for
  diagnostic decisions, and [0019](0019-dedicated-canonical-diagnosis-engine.md)'s canonical journey controller. The
  security and no-fallback rules of [0016](0016-degraded-turns-are-errors.md), [0017](0017-authenticate-orchestrator-only-engine-fields.md)
  and [0018](0018-no-ac-legacy-fallback.md) stay.

## Context

Appliance Clinic diagnosed with 63 executable journeys: deterministic state machines with a fixed check order, fixed
discriminators, re-offer logic and fixed conclusion copy. Models only typed the customer's words into a closed
vocabulary and reworded fixed copy. The internal regression suite (GOLD, 56 scenarios written alongside the journeys)
passed 56/56 twice.

An independent 100-case benchmark ([report](../evaluation/independent-100-case-benchmark.md)), judged blind against a
general-purpose assistant on the same simulated customers, found:

| | Journey AC | General assistant |
|---|---|---|
| Pairwise wins | 6 | 94 |
| Overall usefulness (0–4) | 1.46 | 3.48 |
| Resolved or usefully escalated | 43% | 91% |
| Conversations with invented customer evidence | 19% | 0% |
| Looping | 38% | 1% |
| Conversations with a confirmed critical failure | 37 | 4 |

The root-cause analysis attributed most losses to the architecture, not to bugs: the fixed step order ignored evidence
and direct questions, missing journeys produced intake loops, the closed vocabulary could not hold nuance, fixed
acknowledgement and copy asserted things the customer never said, and binary terminal safety stops ended useful help.
Half the general assistant's wins came from knowledge any strong model has, which the design kept from the customer.
AC's six wins came from deterministic safety (an unsafe-request refusal, a burning-smell stop, safety copy on steps)
and the part gate. Those are worth keeping; the journey controller is not.

## Decision

**Models reason; deterministic code verifies and constrains.**

1. **The LLM owns diagnosis.** One reasoning pass per turn (the admin-configured provider; production: Qwen 3.6 on LM
   Studio) understands the customer, interprets model numbers and codes, reasons across the evidence, answers direct
   questions, recognises normal behaviour, chooses the next question or check, proposes candidate causes and a part,
   and writes the reply. It reads tools and knowledge; nothing it reads decides control flow.
2. **The deterministic kernel owns what may be claimed or done** (`services/diagnosis-engine/ac2`):
   - **Evidence ledger** (`ac2/1`): every fact with field, value, turn, the customer's exact quote, source (customer,
     tool, observation, inference), status (stated, observed, inferred, uncertain, contradicted). A proposed customer
     fact whose quote is not in the customer's words is recorded as an inference. Contradictions keep both values.
   - **Claim verifier** (mandatory, every turn): customer-specific factual claims ⊆ recorded evidence. A model extracts
     the reply's claims and locates the customer's words; deterministic detectors also flag every attributing or
     state-asserting sentence; deterministic checks (grounded quote, majority content coverage, same polarity) decide.
     Unsupported claims are regenerated away once, then removed.
   - **Safety kernel**: hazards detected in the customer's own words (gas, fire, burning/smoke, electrical + water,
     shock, supply trips, microwave arcing, dangerous batteries, recalls), fixed wording where exact language matters,
     prohibited-advice gate on every reply. Only gas and an active fire end the conversation; otherwise the unsafe action
     is blocked and safe help continues.
   - **Part gate**: a part card only with cited customer/tool evidence, a narrowed assessment, no blocking hazard, the
     customer's model and a matching part in the external parts catalogue. Otherwise "model needed", "no catalogue
     part" or "not justified".
   - **Tools**: error-code catalogue (a lookup, never a router), model-series hints (provisional), knowledge retrieval
     (171 fault nodes, the 63 journeys as knowledge, normal-operation notes), recall store, parts catalogue, media.
   - **Repeated-question guard**, scope (unsupported appliances get a short scope reply), audit trail.
3. **No fallback.** If the provider cannot run, the turn is an explicit "temporarily unavailable" error. There is no
   legacy or template answer.
4. **The journey controller is retired** and its code deleted after cut-over; its content survives as
   `knowledge/journey-knowledge.json`.
5. **The BFF calls the engine directly** (signed, IAM-authenticated). The Python orchestrator only routed between
   journeys and the error-code service; it is removed from the request path.
6. **GOLD is a deterministic guardrail regression suite**, not a quality score. Quality is measured only on independent
   and held-out cases, blind-judged against a strong general assistant.

## Consequences

- Diagnostic quality now depends on the reasoning model; the kernel bounds what that model can say or recommend.
- Latency rises from about 3 s to roughly 8–20 s per turn (one reasoning pass and one claim-extraction pass, a second
  reasoning pass when the kernel rejects the first).
- The provider is a single point of failure by design (no fallback); its availability is monitored.
- Results of the replacement: [rebuild evaluation](../evaluation/llm-led-rebuild.md). It beat the journey architecture
  83–17 but lost to the general assistant 17–83 (held-out: 27–4 and 4–27), missing the cut-over targets.

## Alternatives considered

- **Fix and extend the journeys.** Rejected: about a third of losses were architectural and half the general
  assistant's wins were model knowledge no journey list can hold.
- **Keep the journeys and add LLM capability around them.** Rejected: the fixed order, re-offers and terminal stops
  would still control the conversation.
- **A thin safety filter on a general model.** Rejected: no evidence ledger, so fabricated evidence and part claims could
  not be checked.
