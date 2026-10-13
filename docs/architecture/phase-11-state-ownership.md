# Conversation state ownership, before and after Phase 11 (ADR 0014)

> **Historical.** This describes the journey architecture, which was retired on 2026-10-13 ([ADR 0021](../adr/0021-understand-label-enrich-decide-reply.md)). The current architecture is in [overview.md](overview.md).

**Before:** the orchestrator kept a `ConversationState` per warm container in `InMemoryStateStore` (module level in `lambda_handler.py`, keyed by the client's observability id or an opener hash, never evicted). It was lost on a cold start, not shared across containers, kept advancing on turns whose cs/1 was not persisted, and could disagree with cs/1.

**After (release 11.4):** no store. Each turn builds a fresh `ConversationState` from the request: the BFF's cs/1 block (the state part-finder merged on the previous turn and the BFF persisted) plus this turn's transcript and Jev reading. Nothing survives the invocation.

| Field (orchestrator) | What it was | Classification | Now |
|---|---|---|---|
| `customer.appliance`, `applianceState` | family + established/working, with a cross-turn precedence latch | derive from cs/1 | `identity.appliance` + `applianceEstablishment`; this turn's Jev provenance still applies the precedence |
| `customer.make` | brand from a regex over the transcript, retained | derive from cs/1 | `identity.make` (mc/1, now offered near-miss spellings); the transcript lookup remains; forwarded to the engine intent |
| `customer.displayedCode` | retained code | derive from cs/1 | the last active `identity.displayedCodes` |
| `customer.observed` (models) | append-only identifiers | derive from cs/1 | the confirmed `identity.model`; corrections supersede it |
| (new) unsettled code-or-model token | lived only in our own last question text | **moved into cs/1** | `identity.unconfirmedToken` (token-gate.js, merge M16b) |
| `customer.modelUnavailable`, `modelRequestedBefore` | latch, and a flag set only from a `pendingRequest` the BFF never sent | derive from cs/1 / delete | `identity.modelStatus == 'unavailable'` (merge M9, this turn or prior); the dead flag is removed |
| `customer.symptomsText` | customer speech of the symptom turn, retained | request-local | the customer speech of the transcript, when this turn has a symptom or cs/1 holds a problem |
| `fault`, `reportedSymptoms`, `checksReported`, `facts`, `declinedFacts` | unions across turns (a second answered-question memory) | delete as redundant | this turn's Jev reading (Jev reads the whole windowed conversation); durable typed evidence is cs/1's |
| `resolved.*` (MCP result) | stale across turns | request-local | resolved per turn |
| `safetyState`, `safetyReason` | monotonic high-water mark | derive from cs/1 | `safety.activeLevel` and the latest active hazard; this turn's MCP / RAG classes raise it; a correction lowers it |
| `unsafeIntent` | never cleared | request-local | this turn's RAG detector |
| `_pendingIn`, `_pendingFilled`, `_turnIndex`, `_suppressModelLine`, `clarificationRequested`, `turns`, `region`, `fuel` | dead or debug only | delete / request-local | removed or per turn |
| `InMemoryStateStore` | per-container store | delete | removed (operational state: none) |

Tests: `orchestration/tests/test_one_conversation_state.py` (volunteered facts, "not sure", corrections, code-vs-model, misspelt brand + code, identity progression, a failed turn advancing nothing, two instances deciding identically). Multi-turn orchestrator tests run through a fake BFF (`tests/cs1_bff.py`) that carries cs/1 between turns.

cs/1 schema: `identity.unconfirmedToken` is additive. States written before 11.3 lack it and merge exactly as before (tested); the engine and the BFF replay copy were deployed together (11.3a, 11.3b).
