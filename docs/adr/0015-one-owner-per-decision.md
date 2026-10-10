# 0015. One owner per decision

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The audit found these decisions made in several places:
- "ask for the model": five places;
- safety copy: five implementations;
- identity: Jev, mc/1, orchestrator regex, engine regex and catalogue lookups;
- customer prose: written by the canonical COMPOSE, the legacy COMPOSE and post-COMPOSE rewrites, the orchestrator's own flows and the BFF.

The worst real failures came from the seams. In R30, the orchestrator committed a weak Jev model guess, routed to its own clarify, and asked the same fixed question twice ([findings](../evaluation/phase-10-transcript-findings.md)).

## Decision

| Decision | Owner |
|---|---|
| What the message means | Jev, via mc/1 questions. A choice below its commit threshold is not a fact; the consequence is a disambiguating question |
| State | cs/1 merge ([ADR 0014](0014-cs1-is-the-only-conversation-state.md)) |
| Next action on a journey turn | The canonical policy |
| Error-code facts | The MCP. The target is to bridge the MCP's typed system into the matching canonical journey |
| Customer wording | COMPOSE for the decided action, or fixed copy for stops, declines and templates. The orchestrator writes prose only on legacy turns, and only from typed state (the slots it needs, what it already asked) |
| Safety copy | One source per runtime now; one shared source as a target |

## Consequences

- New behaviour is added in one place, with one test.
- The legacy engine pipeline keeps its own decisions because S4R depends on it ([ADR 0012](0012-legacy-diagnosis-pipeline-retained.md)). AC reaches it only on turns no canonical journey owns.

## Alternatives considered

- **Moving all routing into the engine now.** This would merge two runtimes in one step, with S4R in the same handler. Too large to release safely in one go.
