# 0014. cs/1 is the only conversation state

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The Phase 10 audit ([as-built](../architecture/as-built.md)) found seven conversation-state representations alive on one AC turn. The one that matters most here is the orchestrator's `InMemoryStateStore`:
- it is per container, lost on a cold start, and never cleared;
- it holds latches that change replies: the safety high-water mark, `unsafeIntent`, the model-unavailable latch and the established family.

So two containers can answer the same conversation differently. Separately, `pendingRequest` is emitted to the browser but never sent back, so the orchestrator branch that reads it never runs in production.

## Decision

cs/1, stored by the BFF and merged by the engine, is the only conversation state.
- Anything a later turn depends on is a typed cs/1 fact: identity, evidence, requests and their outcomes, sticky hazards, declines.
- The orchestrator keeps no state between turns.
- Its remaining latches move into cs/1, or are derived from it, before `InMemoryStateStore` is deleted.
- A turn whose NextAction was not delivered does not persist its cs/1 change ([ADR 0016](0016-degraded-turns-are-errors.md)).

## Consequences

- Replies no longer depend on which container serves a turn.
- Legacy (non-canonical) turns lose the orchestrator's memory unless the fact they need is in cs/1. Each latch is moved with a test before the store is removed.
- `pendingRequest` relaying to the browser stays for the UI; the orchestrator stops reading it.

## Alternatives considered

- **A DynamoDB-backed orchestrator store.** This would make the second state durable instead of removing it. It keeps two owners of the same facts.
- **Forward `pendingRequest` from the browser.** It is client-controlled and duplicates cs/1 requests.
