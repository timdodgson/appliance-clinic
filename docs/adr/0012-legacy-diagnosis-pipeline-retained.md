# 0012. The legacy diagnosis pipeline is retained

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

The diagnosis engine (`services/part-finder`) has two decision paths:

- **The legacy pipeline:** the handler's decision chain, COMPOSE and post-processing in `part-finder-lambda.js`.
- **Canonical control:** `canonical-runtime.respond` and `canonical/*` ([0010](0010-deterministic-policy-around-llm.md)).

The Phase 8 review ([phase-8-findings.md](../architecture/phase-8-findings.md#3-legacy-versus-canonical)) traced
which callers reach which path:

- **The S4R `/part-finder` page** calls the engine's public Function URL with `{messages}` only. That always runs the
  legacy pipeline, so every S4R request depends on it.
- **Canonical control** runs only when an orchestrated AC turn carries a cs/1 block that grants control. That needs
  `CANONICAL_MODE=control` in `whichpart-api` and an allow-listed journey. S4R never reaches it.
- **AC turns** that no canonical journey owns, or whose canonical path degrades, also use the legacy pipeline.

[0010](0010-deterministic-policy-around-llm.md) named retiring the legacy pipeline as Phase 8 work, bounded by
[0003](0003-s4r-compatibility-boundary.md).

## Decision

**The legacy pipeline is not retired.** It is the implementation of the S4R `/part-finder` contract and the AC
fallback. Removing it, or routing S4R requests through canonical control, changes `/part-finder` behaviour. That is
POTENTIALLY IMPACTS S4R and cannot be proven safe from this repository.

**Phase 8 does three things instead:**
- Removes only code proven dead: the in-process generative UNDERSTAND prompt and its settings, which Jev replaced, and
  unreferenced helpers.
- Moves the pipeline into modules without changing behaviour.
- Records which path is canonical and which is legacy in [overview.md](../architecture/overview.md).

**Retirement becomes possible when three things are true:**
1. Canonical journeys cover what S4R users ask, measured on current transcripts.
2. The S4R owner accepts a `/part-finder` contract change, or S4R moves to its own engine.
3. The public Function URL authenticates the orchestrator-only fields (`understand`, `canonical`, `seed`).

## Consequences

- Two decision paths stay in one engine, and the engine stays large. The module split makes the boundary visible.
- Evidence scoring stays duplicated between the lambda and `canonical/evidence-engine.js`. An equivalence test guards
  the copy.
- Every engine change keeps the `/part-finder` contract check and the S4R health check as release gates.

## Alternatives considered

- **Retire the legacy pipeline and send S4R through canonical control.** Rejected: it changes S4R behaviour, and
  canonical journeys cover only allow-listed AC journeys.
- **Fork the engine, with a frozen copy for S4R.** Rejected for now: it doubles maintenance and needs a new S4R
  endpoint, which is an S4R change.
