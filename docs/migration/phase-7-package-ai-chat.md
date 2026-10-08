# Phase 7 package: `POST /ai/chat` on the S4R HTTP API

**Classification: POTENTIALLY IMPACTS S4R.** Read-only analysis. Nothing in this package has been executed; every
option needs the owner's approval as an S4R change.

Evidence was gathered read-only on 2026-10-08 (account `800960611664`, eu-west-1): `apigatewayv2 get-*`,
`lambda get-policy` and `get-function-url-config`, CloudWatch metrics, and Logs Insights counts over the diagnosis Lambda's
log group. No log text, customer content or address is reproduced here. Earlier findings:
[phase-0-findings.md §2](phase-0-findings.md#2-the-diagnosis-lambda-has-two-public-ingress-paths).

## Summary

- **The route is configured and live, but unused and broken.** It has no authoriser, no throttling and no logging.
- **Every API Gateway-originated invocation in the log group's whole history is a migration probe.** There are 14 since
  2026-10-07, and none before. On 2026-08-20 to 2026-10-06 there were 0, out of 90,851 chat requests.
- **It does not work.** Every probe gets HTTP 500 `{"message": …}` from API Gateway, even when the Lambda logs a
  successful turn. The streamed response does not survive the buffered HTTP API proxy integration.
- **Recommendation: retire it by removing the Lambda permission `apigateway-invoke`.** That leaves the S4R API itself
  untouched, and callers see the same 500 they get today. Deleting the route is the cleaner end state, but it is an
  edit to the S4R API, and it changes where `POST /ai/chat` lands.

## 1. API configuration (`65vnizdmk4`, `spares4repairs-dev`)

| Item | Value |
|---|---|
| API | HTTP, created 2026-07-20, not in a CloudFormation stack. Default execute-api endpoint enabled. **No CORS configuration**. No tags |
| Routes | `$default` (`hpiku2m`, API Gateway-managed) → integration `a6vdcjc` → `spares4repairs-server-dev` (S4R)<br>`POST /ai/chat` (`ncdglq1`) → integration `nk77gue` → `spares4repairs-part-finder` |
| Route `ncdglq1` | `AuthorizationType: NONE`, `ApiKeyRequired: false`, no authoriser, no request parameters |
| Integration `nk77gue` | `AWS_PROXY`, `POST`, payload format 2.0, **timeout 30 s** (the Lambda's timeout is 300 s) |
| Authorizers | None on the API |
| Stage | `$default` only. Auto-deploy on, deployment `gbo1y0`, last updated 2026-08-20 |
| Throttling | None set: `DefaultRouteSettings` holds only `DetailedMetricsEnabled: false`, and `RouteSettings` is empty. The account and region defaults apply |
| Access logging | **Off** (no `AccessLogSettings`) |
| Per-route metrics | **Off** (`DetailedMetricsEnabled: false`). CloudWatch holds only `ApiId` and `ApiId`+`Stage` dimensions, with no `Route` dimension |
| Lambda permission | Statement `apigateway-invoke`: `lambda:InvokeFunction` for `apigateway.amazonaws.com`, `ArnLike AWS:SourceArn arn:aws:execute-api:eu-west-1:800960611664:65vnizdmk4/*`. Not managed by `AcRuntimeStack` (`NEVER_MANAGED_SIDS`) |
| WAF | **Not available.** AWS WAF associates with REST APIs, not HTTP APIs |

The diagnosis Lambda also carries `FnUrlPublic` (the Function URL) and `PublicInvoke` (`lambda:InvokeFunction` for `*`,
no condition). `PublicInvoke` is a separate Phase 7 item. It is not in this package.

## 2. Volume and last use

### API Gateway metrics: the API total only

Per-route counts do not exist, because detailed metrics are off, so `/ai/chat` cannot be separated in metrics. These
totals include the S4R catalogue and site traffic on `$default`.

| Period (UTC) | Count | 4xx | 5xx |
|---|---:|---:|---:|
| 2026-07-20 to 31 | 30,182 | 1,802 | 390 |
| 2026-08 | 128,109 | 2,021 | 1,161 |
| 2026-09 | 118,891 | 277 | 2,758 |
| 2026-10-01 to 08 | 40,203 | 827 | 347 |
| **90 days** | **317,385** | **4,927** | **4,656** |

API-wide 5xx are mostly the S4R server. They cannot be attributed to `/ai/chat` from metrics.

### Diagnosis Lambda logs: the source is distinguishable

The handler logs one structured line per chat turn (`evt: "part-finder"`). Its `requestId` comes from
`event.requestContext.requestId`:
- a **Function URL** request carries a UUID
- an **HTTP API** request carries a short ID ending in `=`

The handler does not log `routeKey` or `apiId`, and neither string appears anywhere in the log group. The log group
dates from 2026-08-20 and never expires, so it covers the whole life of the permission.

| Source | Chat turns | First | Last |
|---|---:|---|---|
| Function URL (UUID) | 90,837 | 2026-08-20 20:15Z | 2026-10-08 17:30Z |
| HTTP API `/ai/chat` (`…=`) | **14** | 2026-10-07 01:21Z | **2026-10-08 17:30Z** |

**Daily `/ai/chat` turns:**

| Day | Turns |
|---|---|
| through 2026-10-06 | 0 every day |
| 2026-10-07 | 2 |
| 2026-10-08 | 12 |

**All 14 are this migration's own ingress probe** (`npm run baseline -- ingress capture|verify`):
- each carries the fixed one-message probe (`msgCount` 1, `turnIndex` 0)
- their times match the Phase 0 rerun, the Phase 5 baseline capture (2026-10-07 21:41Z) and the Phase 7 before and
  after checks

**Lambda-side outcome of the 14:**

| Lambda outcome | Turns |
|---|---|
| `ok: true` | 11 |
| `ok: false`: external tunnel error on 2026-10-07 01:21Z | 1 |
| `ok: false`: `jev:HTTP`, during the Jev outage on 2026-10-08 17:13 to 17:21Z, about 32 s each | 2 |

**HTTP status seen by the caller:** 500, from API Gateway, for every recorded probe. The Lambda's own success does not
reach the caller (see §3). The two Jev-outage turns ran past the 30 s integration timeout. API Gateway would have answered
before the Lambda finished.

**Residual uncertainty.** Requests that fail before the metric line are not logged that way: bad JSON, an empty
`messages`, oversize bodies, feedback posts and health checks. Across the log group's whole life:
- there are 90,972 `REPORT` lines and 90,851 chat lines
- so at most **121** invocations, from any source, are unattributed

That bounds any hidden `/ai/chat` use to almost nothing. It is not absolute proof, because access logging is off.

## 3. Dependencies and how it differs from the Function URL

**Who calls it.**
- **This repository:** only the migration tooling (`tools/migration/config/baseline.json` `diagnosisAiChatRoute`,
  `src/baseline/ingress.js`, the `npm run traffic` defaults) and the docs.
- **The S4R `/part-finder` page** calls the Function URL. Its contract recording shows `application/x-ndjson`
  streaming from the Function URL host.
- **Phase 0** found no `/ai/chat` caller in the S4R monorepo or its history. That repository was not re-read for this
  package.
- **The logs** show no non-probe use, as above.

| Aspect | Function URL (`/part-finder`, ingress 1) | `POST /ai/chat` (ingress 2) |
|---|---|---|
| Event | Function URL event (payload 2.0 shape), `requestId` UUID | HTTP API payload 2.0, `requestId` `…=` |
| Invocation | `InvokeWithResponseStream` (`RESPONSE_STREAM`) | Buffered `Invoke` via the `AWS_PROXY` integration |
| Response | 200 `application/x-ndjson`, `delta`… then `done` | **500** `application/json` `{"message": …}` from API Gateway (baseline `.migration-output/phase5/baseline/ai-chat-ingress.json`) |
| Why | The handler is `awslambda.streamifyResponse` and writes an `HttpResponseStream` prelude | The buffered proxy cannot map the streamed prelude and body to a 2.0 response. This is inferred and consistent with every probe |
| Timeout | Lambda 300 s | 30 s integration timeout |
| CORS | Function URL CORS: origin `*` (echoed), `POST`, `content-type`, max-age 86400 | None on the API. A browser preflight `OPTIONS /ai/chat` matches `$default` and goes to the **S4R server Lambda**, not the diagnosis Lambda |
| Authentication | None | None |
| Throttling | Lambda concurrency only (account limit 10, shared with S4R) | None at the API, then the same shared Lambda concurrency |

**Why it matters although nobody uses it.** It is an unauthenticated second path into the diagnosis Lambda:
- Each successful-looking call still runs Jev, and OpenAI when routed, at the account's cost.
- Each call takes a slot of the account's 10 concurrent executions, which the S4R server shares.
- Removing the path removes that exposure and returns nothing useful to anyone today.

## 4. Options

All of these are POTENTIALLY IMPACTS S4R and need owner approval. None is executed.

| Option | What changes | S4R impact | Steps | Rollback | Risk |
|---|---|---|---|---|---|
| **A. Retain** (status quo) | Nothing | None | None. Keep the ingress check in every diagnosis-Lambda step | n/a | An unauthenticated, broken path stays open: cost and shared concurrency exposure, and confusion for anyone who finds it |
| **B. Protect: IAM auth** | Route `ncdglq1` `AuthorizationType` → `AWS_IAM` (`UpdateRoute`; auto-deploy publishes it) | Edits the S4R API. Unsigned callers get 403 instead of 500. No other route changes | `apigatewayv2 update-route --api-id 65vnizdmk4 --route-id ncdglq1 --authorization-type AWS_IAM`, then ingress verify (expect 403) | `update-route … --authorization-type NONE` | Low. The 403 makes the route look intentionally kept, though it still does not work |
| **B2. Protect: JWT authoriser** | New authoriser (S4R or AC Cognito pool) and route `AuthorizationType: JWT` | Edits the S4R API, plus a new authoriser | Create the authoriser, update the route, verify | Revert the route to `NONE` and delete the authoriser | Medium. More moving parts for a route that returns 500 anyway |
| **B3. Protect: throttling** | Stage `RouteSettings["POST /ai/chat"]` rate and burst, e.g. 1/1 | Edits the S4R stage. With auto-deploy it is live at once. A wrong key could hit `$default` | `update-stage --route-settings` for that key only | Remove the route setting | Low. Limits abuse but leaves the path open |
| **C1. Retire: remove the Lambda permission** (recommended) | `lambda remove-permission --function-name spares4repairs-part-finder --statement-id apigateway-invoke` | **None on the S4R API.** The route stays. API Gateway answers 500 `{"message":"Internal Server Error"}`, the status, type and key set callers get today | Owner approval; ingress verify before; remove; ingress verify after (expect it to still match the 500 baseline); confirm the probe no longer produces a `…=` line in the logs | `lambda add-permission` with the same Sid, principal `apigateway.amazonaws.com`, action `lambda:InvokeFunction` and `source-arn arn:aws:execute-api:eu-west-1:800960611664:65vnizdmk4/*` (seconds) | Very low. The only observable change is that the Lambda no longer runs. `AcRuntimeStack` never declares this Sid, so no CDK or drift change |
| **C2. Retire: delete the route** | `delete-route` `ncdglq1` (auto-deploy), optionally `delete-integration nk77gue` | Edits the S4R API. `POST /ai/chat` then falls to `$default`, the **S4R server Lambda**, whose answer (probably 404) is new traffic on S4R code | Owner approval, delete the route, verify the S4R catalogue and `/part-finder` | Recreate the route and integration (new IDs) | Low to medium. The cleanest end state, but it touches S4R-owned configuration and S4R server behaviour |

**Recommendation.**
1. **C1 now:** remove `apigateway-invoke`, with owner sign-off. It closes the path without touching the S4R API and is
   indistinguishable to any caller from today's 500.
2. **Afterwards:** propose **C2** to the S4R owner as an S4R-side cleanup (route and integration `nk77gue`).
3. **Then:** drop the `/ai/chat` ingress check from the migration tooling.

**Out-of-hours timing,** if wanted: 02:00 to 05:00 UTC. That window has the least diagnosis Lambda and S4R API traffic;
see the [diagnosis-role package](phase-7-package-diagnosis-role.md#8-tests-timing-risks).
