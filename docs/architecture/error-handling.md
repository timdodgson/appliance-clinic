# Error handling

Each boundary has its own error contract. The AC site and the admin UI depend on these shapes, so they are documented
and pinned by tests rather than unified. Unifying them is a coordinated change with the clients.

## Diagnosis engine (`applianceclinic-diagnosis-engine`, AC-internal)

| When | Response |
|---|---|
| No valid IAM (SigV4) signature, or a role that may not invoke the URL | 403 from the Function URL; the engine never runs |
| Body too large, invalid JSON, not an object | JSON `{error}` with 413 / 400 / 400 |
| Missing or invalid engine signature (`x-ac-engine-signature`) | 401 `{error, errorCode: "engine_signature_required"}`. Logged (`evt: engine-auth`, `rejected: true`); alarm `-RefusedRequests` |
| No messages array | 400 `{error}` |
| Diagnose call that no canonical journey controls | 409 `{error, errorCode: "canonical_not_controlled"}` |
| Jev, COMPOSE provider or engine failure | 503 `{error, errorCode: "engine_unavailable"}`. Logged with `ok: false` (`jev:<category>` for Jev failures); alarm `-FailedTurns` |
| Success | 200, buffered JSON lines: `{type:'understand', …}` for understand mode; `{type:'delta'}` then `{type:'done'}` for a canonical reply |

**Pinned by.** The engine tests. The request and response types are declared in
[`types/diagnosis-engine.d.ts`](../../types/diagnosis-engine.d.ts).

## whichpart-api customer path (`POST /api`, the customer turn)

| When | Response |
|---|---|
| Invalid request (JSON, messages, test-mode fields) | 400 `{error}` |
| Rate limited | 429 `{error}` with `retry-after` (`RATE_LIMIT_MODE=enforce`) |
| Orchestrator unreachable | 200 with the fallback view: `error: true` and a fixed "Sorry — something went wrong…" reply. The state token is unchanged |
| Required COMPOSE failed (#21) | 200 with `error: true`, `errorCode: "ai_unavailable"`, "AI service unavailable…". The canonical state does not advance |
| Success | 200 with the WhichPart view |

The customer UI renders a view in every case, so failures are 200 with `error: true` rather than 5xx. Each failure is
still logged as failed and persisted in the transcript with its reason (`orchestrator_unavailable`, `compose_failed`).

## whichpart-api admin routes

Every admin route answers an unauthenticated or non-admin caller with 401 `{error: "Unauthorized"}`, or with 405 for an
unsupported method. Pinned by `test/admin-routes.test.mjs` for all 84 routes. The retired knowledge-publish routes return 404 (ADR 0019).

Store errors differ by area:

| Area | Status | Body |
|---|---|---|
| Media | from the error, else 404 for `not_found`, else 400 | `{error, code, extra}` (nested) |
| Recalls | from the error, else 500 | `{error, code (default "error"), ...extra}`. 5xx are logged (message truncated) |
| Error codes | mapped by `error-codes-admin.httpError` from the MCP response | the MCP's `{error, code}` |
| Test area (library) | 409 `{error: "STALE", message, updatedAt}`, 404 `{error: "not found"}`, else 400 `{error, problems}` | |
| Settings | per route: 400 validation, 409 revision conflict or a batch owning live routing, 413 body too large, 503 secret store unavailable, 500 `{error}` on unexpected failure | |

The media shapes are pinned by `test/admin-error-contracts.test.mjs`. Knowledge is read-only and has no write errors.

## Service to service

| Edge | On failure |
|---|---|
| Orchestrator, calling the engine | The orchestrator's typed degraded result. whichpart-api sees a normal orchestrator response |
| whichpart-api, calling the orchestrator | Thrown, then the fallback view above |
| MCP | JSON-RPC errors; the orchestrator treats a failed tool call as no error-code evidence |

## Known gaps

**Fallbacks that look normal.** Logged, but a caller cannot tell:
- The transcript and recall stores fall back to in-memory stores if their client cannot be created. In practice this
  cannot happen, because creating the client does no I/O.
- Cognito errors during a session check are treated as signed out.

**The engine accepts no unauthenticated request.** Its Function URL is `AWS_IAM`, and every POST must carry a valid
HMAC signature ([ADR 0017](../adr/0017-authenticate-orchestrator-only-engine-fields.md),
[ADR 0019](../adr/0019-dedicated-canonical-diagnosis-engine.md)). A missing, stale or invalid signature is an explicit
401, never a silently reduced request.
