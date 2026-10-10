# 0017. Authenticate the orchestrator-only engine fields

- **Status:** Accepted (implementation gated)
- **Date:** 2026-10-10

## Context

The diagnosis engine's public Function URL serves the S4R `/part-finder` page (`{messages}`) and the AC orchestrator. It also accepts, without authentication, fields meant only for the orchestrator:
- `mode`
- `understand`, whose `_`-prefixed keys bypass scope refusal and safety classification
- `canonical`, a forged result of which words any NextAction and injects part cards
- `established`
- `seed`
- `feedback`

The effects reach only the caller's own response. But every request is written to the S3 learning trace, and the gap has been open since Phase 8.

## Decision

- The orchestrator signs its engine requests with an HMAC over the body, using a dedicated AC secret.
- The engine honours the orchestrator-only fields only when the signature verifies. Without it they are dropped and the request is treated as a plain `{messages}` request.
- S4R sends only `{messages}`, so its behaviour is unchanged.

**Release gates:**
- the engine logs show that no S4R request carries these fields (checked over the retention window);
- the `/part-finder` contract and smoke checks are run before and after;
- S4R health is checked;
- the drop path ships first in log-only mode.

## Consequences

- A new secret, wired to two Lambdas through the reviewed change process.
- A rollback that is a configuration flag (log-only), not a redeploy.

## Alternatives considered

- **A separate engine entry point for AC.** Cleaner, but a new Function URL and resource policy in a shared account. Deferred until S4R moves off the engine.
- **IAM-authenticated Function URL.** It would break S4R's anonymous browser call.
