# 0016. Degraded turns are errors, not normal replies

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

Several failures produced replies that looked normal:
- an understand failure became a generic clarify;
- SERVICE_UNAVAILABLE text reached the browser without `error:true`;
- a canonical turn whose diagnose call failed told the customer "I can't run the diagnosis" while its cs/1 state, including the question it never asked, was persisted.

In R21 and R22 every turn of two sessions was an outage, and the transcript judge never reviewed them.

## Decision

- A turn that could not run its decision path is flagged `error: true` and `degraded: <reason>` in the view, the transcript and the benchmark status.
- A canonical state change is persisted only when the NextAction it records was delivered.
- A COMPOSE failure records its error class in the telemetry. `checkReply` template replacements stay valid replies (the template is reviewed copy), and their violations are recorded.

## Consequences

- Outages become visible in the transcript record and to GOLD.
- The browser can show its retry affordance on more turns. The copy is unchanged.

## Alternatives considered

- **Retrying silently in the orchestrator.** This hides the cause and stacks on the existing timeouts.
