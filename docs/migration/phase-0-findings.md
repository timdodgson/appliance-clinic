# Phase 0 findings and production baseline

What the read-only Phase 0 inventory (#3) found in production, and how it changes the plan. The raw
inventory stays local in `.migration-output/` and is never committed. This page records the
conclusions.

- **Inventory run:** 2026-10-07, account `800960611664`, eu-west-1 (CloudFormation also checked in
  us-east-1). No area errors.
- **Verification:**
  - Both zip functions' downloaded code matches their deployed CodeSha256.
  - The WebMCP token was captured.
  - Both container functions' deployed image digests were recorded.

## Production baseline

| Area | Baseline |
|---|---|
| Lambda functions | Four: `spares4repairs-part-finder` (diagnosis), `whichpart-api`, `spares4repairs-diag-orchestrator`, `spares4repairs-error-code-mcp`. All serve `$LATEST`, with no aliases, no published versions, no VPC and no reserved concurrency |
| Function URLs | All auth `NONE`, unqualified. The diagnosis URL uses `RESPONSE_STREAM` (CORS `*`, POST, `content-type`, max-age 86400); the others use `BUFFERED` |
| Canonical engine | Live in **control** mode on `whichpart-api` (`CANONICAL_MODE=control`), with **64 journeys** in `CANONICAL_CONTROL_JOURNEYS` across washing machines, dishwashers, fridge-freezers, tumble dryers, ovens, cookers, hobs, microwaves, vacuums and washer-dryers |
| DynamoDB | `whichpart-transcripts` about 29,500 items (TTL on); `whichpart-recalls` about 1,050 items. **PITR off on both**, no on-demand backups, on-demand billing |
| S3 | Web bucket: 172 objects, OAC-only policy. Learning bucket: about 36,200 objects, no policy. Neither has versioning or lifecycle rules |
| Routing override | **Inactive**: lease `released`, last restore verified 2026-10-05 |
| WebMCP token | **Captured** from the deployed `index.html` (for `https://applianceclinic.ai:443`, subdomains, expires 2027-03-30) |
| ECR | Both repositories have mutable tags, scan on push and no lifecycle policy. The deployed `v1` digests are recorded |
| EventBridge | Daily recall ingest and 15-minute transcript review, both enabled, both targeting `whichpart-api` |
| CloudFront | `E1QD02IAJZPJLM` serves `applianceclinic.ai`, `www.applianceclinic.ai`, `whichpart.co.uk` and `www.whichpart.co.uk`. Origins: the web bucket (OAC) and `whichpart-api` for `/api*`. Redirect function `whichpart-www-redirect`, used by no other distribution |
| CloudFormation | `SparesSite-dev` (UPDATE_COMPLETE, 55 resources) and the default `CDKToolkit` (CREATE_COMPLETE). No AC candidate resource is in either |

## Differences from the plan

### 1. The diagnosis Lambda runs under the S4R server role

**Finding.** `spares4repairs-part-finder` runs under `SparesSite-dev-ServerFunctionRole…`. That role:
- is managed by the `SparesSite-dev` stack
- is shared with the S4R server Lambda `spares4repairs-server-dev`
- carries three AC permissions added by hand: `WhichpartLearningPut`, `whichpart-knowledge-overlay-s3`
  and `whichpart-media-overlay-s3`

The plan assumed a separate, console-created role.

**Effect.**
- The role is S4R-owned and is never imported or changed.
- The diagnosis function is imported referencing it unchanged.
- Moving to a dedicated AC role is a Phase 7, POTENTIALLY IMPACTS S4R change.

See [ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md) and `PLAN.md`, step 5.10.

### 2. The diagnosis Lambda has two public ingress paths

**Finding (resolved by the rerun of 2026-10-07, #15).** The `apigateway-invoke` statement is live, not
stale. The diagnosis Lambda can be reached two ways, and neither requires authentication:

| # | Ingress | Used by | Authentication |
|---|---|---|---|
| 1 | Its Function URL (`RESPONSE_STREAM`) | The S4R `/part-finder` page, from the shopper's browser | None |
| 2 | API Gateway `65vnizdmk4`, HTTP API `spares4repairs-dev`, route **`POST /ai/chat`**, AWS_PROXY integration `nk77gue` (payload 2.0) | No observed use (see *Measured use* below). No code in the `spares4repairs` repository or its history calls `/ai/chat` | None |

About the API:
- **It is S4R's.** It also serves the shop's catalogue search, so the diagnosis Lambda and the error-code
  tools depend on it.
- **It was created by hand on 2026-07-20 and is not in any CloudFormation stack.** The stack-based
  denylist rule therefore does not cover it. It is on the S4R denylist through the manual entries in
  `tools/migration/config/s4r-known.json`.
- **The route is live.** The `$default` stage auto-deploys and was last updated on 2026-08-20. Its
  `$default` route goes to a different integration.
- **Origin of the permission.** CloudTrail shows four `AddPermission` calls on the diagnosis Lambda by
  the account owner on 2026-08-20, around the creation of the Function URL and an update to the API
  stage. The events do not record statement IDs, so which call added `apigateway-invoke` is inferred
  from timing.

**Controls until the route's use is known:**
- **Classification.** The route, the API and the Lambda permission are S4R-sensitive, and any change to
  them is POTENTIALLY IMPACTS S4R. They are treated as live dependencies: not imported, changed or
  removed.
- **Ingress check.** The route has its own check (`npm run baseline -- ingress capture|verify`),
  separate from the `/part-finder` contract. Both run before and after any step that touches the
  diagnosis Lambda.
- **Traffic check.** A read-only CloudWatch check (`npm run traffic`) establishes whether the route is
  used. HTTP APIs publish per-route counts only when detailed metrics are on. If they are off, the check
  reports that the route's traffic cannot be separated from the API's total. Turning them on would
  change the S4R API, so it is not done here.

**Measured use (2026-10-07, #17).**
- **Metrics:** `route-metrics-unavailable`. Detailed metrics are off on `$default`, so the route cannot
  be separated from the API total (113,026 requests in 30 days, including the S4R catalogue search).
- **Logs:** the diagnosis Lambda logs one `evt: "part-finder"` line per chat request, with `requestId`
  taken from `event.requestContext.requestId`. Function URL requests carry UUIDs; HTTP API requests
  carry short IDs ending in `=`. The log group was created on 2026-08-20 and never expires, so it covers
  the whole period since the API permission was added. Across that history, 90,671 chat requests all
  had UUIDs. None had API Gateway-style IDs, and neither `ai/chat` nor `routeKey` appears in the logs.
- **Ingress baseline:** a single test request to `/ai/chat` returned **HTTP 500** with an API
  Gateway-style JSON body (`{"message": …}`), not the NDJSON stream the Function URL returns. The likely
  cause, not verified, is that the HTTP API's buffered proxy integration cannot relay the function's
  `RESPONSE_STREAM` response. The recorded baseline (kept locally in `.migration-output/`) is that 500, so the check detects any
  change to it.

**Conclusion.** No evidence of `/ai/chat` handling real chat traffic was found, and the route does not
currently return a working response. This is strong evidence it is unused, but not absolute proof: 78
invocations have no matching chat log line (health checks and rejected or failed requests are not
logged that way), and API Gateway access logging is disabled. The route, the API and the permission
therefore stay S4R-sensitive and live. Any removal, protection or permission change is a Phase 7
decision that needs S4R sign-off.

### 3. The CloudFront distribution also serves `whichpart.co.uk`

**Finding.** Besides `applianceclinic.ai` and `www.applianceclinic.ai`, the distribution has the
aliases `whichpart.co.uk` and `www.whichpart.co.uk`.

**Effect.** None for now. CloudFront stays unmanaged in the initial migration
([ADR 0008](../adr/0008-cloudfront-initially-unmanaged.md)), and its aliases, certificate and DNS are
not changed. The replacement site deployment uploads to the bucket only, so it does not affect them.

### 4. Policy placement differs from `ownership.md`

**Finding.**
- Two of the eleven inline policies the plan expected on AC roles, `whichpart-knowledge-overlay-s3`
  and `whichpart-media-overlay-s3`, are on the S4R role. A third, `WhichpartLearningPut`, is there too.
- `whichpart-api-role` carries 8 inline policies and `error-code-mcp-role` carries 1.

**Effect.** Recorded in `ownership.md`. Step 5.6 imports only the policies on AC roles.

### Matches the plan

- **Lambdas:** no VPC, no aliases, everything on `$LATEST`.
- **Function URLs:** all auth `NONE`, as the scripts create them.
- **Tables and buckets:**
  - PITR is off on both tables. Phase 0 backups enable it, and CDK must then declare it.
  - Neither bucket has lifecycle rules or versioning.
  - The web bucket policy is OAC-only.
- **Rules and functions:** the EventBridge targets match the scripts, and the CloudFront function is
  not shared.

### 5. An AI provider outage was masked by template replies

**Finding (2026-10-07, #7).** The first baseline attempt found production diagnosis failing. The
diagnosis Lambda's LLM calls go to LM Studio through an ngrok tunnel, and the tunnel's account was
suspended (`ERR_NGROK_6008`). Every request that needed the LLM returned "AI service unavailable".
The live AI config had also drifted to the wrong model (`gpt-5.6-terra`). The owner restored the
tunnel and corrected the model to `qwen3.6-35b-a3b-mtp`. This work made no production change.

During the outage, some canonical-control journeys still looked healthy. In the canonical runtime, a
failed COMPOSE call is replaced by the journey's deterministic template
(`services/part-finder/canonical-runtime.js`, `word()`, at `13b7a50`). The reply looks normal and the
request is logged `ok: true`. The only trace is `compose.source: "template"` with
`violations: ["compose_failed"]`.

**Effect.**
- **Defect recorded in #21.** A required provider failure must not silently look healthy. It is
  fixed after runtime extraction, as a POTENTIALLY IMPACTS S4R change, because S4R `/part-finder`
  uses the same runtime.
- **Baseline acceptance.** The baseline is accepted only when COMPOSE is confirmed healthy from the
  diagnosis Lambda's metric lines: every request `ok`, and every canonical journey
  `canonicalControl.source: "compose"`.
- **Intentional fixed copy is separate.** Safety stops and declined unsafe requests return fixed copy
  by design (`source: "template"`, no violations). They are not part of this defect.

## CloudTrail ownership evidence

From the rerun of 2026-10-07. Events were searched in eu-west-1 and us-east-1. Only us-east-1
`PutRolePolicy` reached the 1,000-event limit, so events before 2026-07-23 are not visible.

| Resource | Created | By |
|---|---|---|
| `whichpart-api-role` | 2026-08-23 | Account owner (by hand) |
| `error-code-mcp-role` | 2026-08-30 | Account owner (by hand) |
| `diag-orchestrator-role` | 2026-08-30 | Account owner (by hand) |
| `SparesSite-dev-ServerFunctionRole…` (current) | 2026-07-20 | AWS CloudFormation (the `SparesSite-dev` stack) |
| CloudFront distribution and function (inferred from timing; the events carry no resource names) | 2026-08-23 | Account owner (by hand) |

**Inline policies.**
- **On the S4R server role:** every inline policy was added by hand by the account owner. CloudFormation
  added none. That covers the S4R policies from July onwards and the three AC policies:
  - `WhichpartLearningPut`, first put 2026-08-26
  - `whichpart-media-overlay-s3`, from 2026-09-19 to 2026-10-05
  - `whichpart-knowledge-overlay-s3`, 2026-10-05
- **On the AC roles:** inline policies were put by the account owner from 2026-08-30 onwards, matching
  the AC deploy scripts.

## Known risks recorded

- **S4R deployments and the diagnosis Lambda.** A deployment of `SparesSite-dev` updates the shared
  role. If CloudFormation removed inline policies it does not manage, the diagnosis Lambda would lose
  access to the learning bucket, affecting Appliance Clinic and the S4R `/part-finder` page.
  - *Lowers concern:* the evidence above shows hand-added inline policies on that role, S4R and AC
    alike, surviving S4R deployments since July.
  - *Does not replace the test:* sandbox experiment T1 stays mandatory.
- **Shared write access.** Because the role is shared, the S4R server Lambda also holds the three AC
  permissions, including writing to the AC learning bucket.
- **Unauthenticated `/ai/chat`.** The route invokes the diagnosis Lambda, and its LLM calls, with no
  authentication and no known client. No real use was observed and it currently returns HTTP 500;
  whether such a request still invokes the function was not checked. It is not changed in this work,
  but it is an open cost and abuse surface. Any protection is a Phase 7 decision, classified POTENTIALLY IMPACTS S4R.

## Inventory tooling corrections

The first run surfaced three reporting issues. All are resolved and confirmed by the rerun:
- **Function URL `AuthType` was redacted.** Fixed: Function URL configuration is recorded as returned.
  The rerun shows `NONE` for all four functions.
- **CloudTrail covered eu-west-1 only.** Fixed: eu-west-1 and us-east-1 are searched, with a truncation
  flag. The rerun returned the role creation and `PutRolePolicy` events above.
- **Stack status appeared as `null`.** This was a misread of the output, not a tooling fault, and a test
  now pins it. The rerun shows `SparesSite-dev` UPDATE_COMPLETE and `CDKToolkit` CREATE_COMPLETE.

**Added after the rerun:**
- HTTP API investigations record the routes and authorisation types that reach the function.
- A read-only route traffic check.
- A separate `/ai/chat` ingress check.
