# 0003. Spares4Repairs compatibility boundary

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

AC and S4R depend on each other at runtime, without any shared code:

- **AC depends on S4R:**
  - the diagnosis Lambda calls the S4R catalogue API
  - buy links point at the shop
  - AC admin sign-in uses the S4R Cognito pool
- **S4R depends on AC:** the shop's `/part-finder` page runs in the shopper's browser and POSTs
  directly to the AC diagnosis Lambda's Function URL, reading its streamed NDJSON response.

The second dependency means an AC-owned resource can still be a Spares4Repairs production dependency.

## Decision

- **S4R resources are external dependencies.** AC may read from them or call them as a client.
  Nothing in this work modifies, imports, replaces, renames or deletes an S4R-owned or shared
  resource.
- **Ambiguous ownership means S4R.** Ownership is proven per resource, with evidence, in
  `docs/migration/ownership.md`. The tooling generates an S4R denylist that every change set is
  checked against.
- **AC-owned but S4R-consumed resources are special.** Any change to the diagnosis Lambda, its
  Function URL, permissions, CORS, authentication, concurrency, request or response shape, streaming
  behaviour or pipeline is classified **POTENTIALLY IMPACTS S4R**. It needs explicit sign-off and the
  `/part-finder` contract test before and after.
- **The `/part-finder` contract is permanent.** It is captured structurally: CORS for the S4R
  origin, NDJSON framing, and the fields the page reads. It becomes a standing compatibility test.

## Consequences

- The diagnosis Function URL cannot change host, authentication or CORS without a coordinated S4R
  change, which is outside this work. It stays public, so it is protected inside the function
  instead (rate limiting, cost guards).
- Retiring the legacy diagnosis pipeline must preserve the contract. The canonical engine has to
  serve the shop page's request shape, or a compatibility adapter has to remain.
- Every production step carries an S4R health check.

## Alternatives considered

- **Treat AC-owned resources as freely changeable.** Rejected: it would break the shop's
  `/part-finder` page.
- **Change the shop to call AC differently.** Rejected for this work: it modifies S4R. It can be
  proposed separately, as an S4R change.
