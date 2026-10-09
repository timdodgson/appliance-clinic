# Error handling

Each boundary has its own error contract. The S4R page, the AC site and the admin UI all depend on these shapes, so
they are documented and pinned by tests rather than unified. Unifying them is a coordinated change with the clients.

## Diagnosis engine (`/part-finder`, the S4R contract)

| When | Response |
|---|---|
| Before the stream starts: body too large, invalid JSON, no messages array | JSON `{error}` with 413 / 400 / 400 |
| Before the stream starts: model provider or Jev failure | JSON `{error}` with 503: "AI service unavailable…", or "The AI took too long…" on a timeout |
| After the stream started | One NDJSON frame `{"type":"error","error":"…"}`, then the stream ends. The status is already 200 |
| Out-of-scope request | A normal stream: the fixed refusal as a `delta`, then `done` with `onTopic: false`. Not an error |

**Logging.** The turn is logged with `ok: false` and the error category (`jev:<category>` for Jev failures).

**Pinned by.** The `/part-finder` contract check (`tools/migration` `baseline contract verify`) and the engine tests.
The frame types are declared in [`types/part-finder.d.ts`](../../types/part-finder.d.ts).

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
unsupported method. Pinned by `test/admin-routes.test.mjs` for all 91 routes.

Store errors differ by area:

| Area | Status | Body |
|---|---|---|
| Knowledge | from the error, else 500 | `{error, code (default "error"), ...extra}` (merged). 5xx are logged |
| Media | from the error, else 404 for `not_found`, else 400 | `{error, code, extra}` (nested) |
| Recalls | from the error, else 500 | `{error, code (default "error"), ...extra}`. 5xx are logged (message truncated) |
| Error codes | mapped by `error-codes-admin.httpError` from the MCP response | the MCP's `{error, code}` |
| Test area (library) | 409 `{error: "STALE", message, updatedAt}`, 404 `{error: "not found"}`, else 400 `{error, problems}` | |
| Settings | per route: 400 validation, 409 revision conflict or a batch owning live routing, 413 body too large, 503 secret store unavailable, 500 `{error}` on unexpected failure | |

The knowledge and media shapes are pinned by `test/admin-error-contracts.test.mjs`.

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

**The engine's public URL** accepts orchestrator-only fields without authentication
([findings §5](phase-8-findings.md#5-brittle-interfaces-and-risks)). That is a security item, not an error-shape item.
