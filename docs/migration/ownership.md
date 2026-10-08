# AWS ownership record

This file records, for every AWS resource Appliance Clinic (AC) uses, who owns it and the
evidence for that. Migration tooling and reviewers rely on it: **a resource may only be changed
or imported once it is marked `AC` or `AC (S4R-consumed)` here with evidence.**

## Ownership classes

| Class | Meaning | What AC work may do |
|---|---|---|
| `AC` | Proven to be created and used only by AC | SAFE AC CHANGE, subject to the plan's gates |
| `AC (S4R-consumed)` | Proven AC-created, but Spares4Repairs depends on it | Every change is POTENTIALLY IMPACTS S4R |
| `S4R` | Owned or managed by Spares4Repairs, or shared with it | Read or call as a client only. Never modify or import |
| `Unproven` | Not yet proven | Treated exactly as `S4R` |

## Evidence rules

A resource is `AC` only when **all** of these hold:

1. **Creation evidence.** It was created by an AC deployment script in `spares4repairs@13b7a50`
   (file and line recorded), or CloudTrail shows its creation by AC activity. CloudTrail only
   keeps 90 days of management events, so older resources rely on the script evidence.
2. **Not in a CloudFormation stack.** It is not a resource of any existing stack in the account
   (checked by the denylist generator across every region in use).
3. **No S4R reference.** No S4R code (`apps/web`, `packages/*`, `infra/`), S4R IAM policy or S4R
   configuration names it, apart from broad wildcard grants recorded under *Notes*.
4. **Consumers known.** Every caller or reader of the resource is identified. If any consumer
   is S4R, the class is `AC (S4R-consumed)`.

If any rule cannot be shown, the class stays `Unproven`.

## Resource register

Classes below are based on the Phase 0 inventory of 2026-10-07 (account `800960611664`, eu-west-1) and
its read-only rerun the same day, recorded in [`phase-0-findings.md`](phase-0-findings.md). Where an
approved Phase 0 or Phase 1 change has since altered a resource, its current state is given and marked. "Script" evidence refers to the deploy scripts in
`spares4repairs@13b7a50`. "CloudTrail" means a matching creation event in event history. "No stack" means
the resource is not managed by any CloudFormation stack in eu-west-1 or us-east-1.

### Lambda functions

| Resource | Class | Evidence | Consumers | Notes |
|---|---|---|---|---|
| `spares4repairs-part-finder` (diagnosis) | **AC (S4R-consumed)** | CloudTrail: created from the console on 2026-08-20; no stack | AC API, AC orchestrator, **S4R `/part-finder` page (browser)**, possibly the S4R catalogue API (see permissions) | Runs under the **S4R** server role ([ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md)). Zip, nodejs20.x, x86_64, `$LATEST` |
| `whichpart-api` | AC | Script `services/whichpart-api/deploy.sh:7,269`; CloudTrail; no stack | AC site (CloudFront `/api*` origin), EventBridge | Zip, nodejs20.x, `$LATEST`. **Since the Phase 1 admin hotfix:** code SHA-256 `Vkox0eYVlkwProorZUjOQuwPqWkhb0TCAgNRI/n31dE=`, environment variable `AC_ADMIN_SUBS` added, published version `1` holding the previous artefact (`GomgP4…`) for rollback. No alias |
| `spares4repairs-diag-orchestrator` | AC | Script `orchestration/deploy/deploy.sh:11,75`; CloudTrail; no stack | AC API | Image, arm64 |
| `spares4repairs-error-code-mcp` | AC | Script `error-codes/mcp/deploy/deploy.sh:16,117`; CloudTrail; no stack | AC API, AC orchestrator | Image, arm64 |

### Function URLs and resource policies

| Resource | Class | Evidence | Notes |
|---|---|---|---|
| Diagnosis Lambda URL (ingress 1) | **AC (S4R-consumed)** | CloudTrail (2026-08-20, console) | Used by the S4R `/part-finder` page. Auth NONE (confirmed from the actual value on the rerun), `RESPONSE_STREAM`, unqualified (`$LATEST`), CORS `*` / POST / `content-type` / max-age 86400. Host, auth and CORS must not change |
| Diagnosis Lambda permissions `FnUrlPublic`, `PublicInvoke` | AC (S4R-consumed) | Created with the URL | Public invoke for the URL. Never modified |
| Diagnosis Lambda permission `apigateway-invoke` (API `65vnizdmk4`, ingress 2) | **S4R-sensitive** | CloudTrail: `AddPermission` by the account owner on 2026-08-20 (statement ID not recorded; inferred from timing) | **Confirmed live ingress:** route `POST /ai/chat` (`ncdglq1`, authorisation `NONE`) on the S4R HTTP API `spares4repairs-dev` targets integration `nk77gue` (`AWS_PROXY`, payload 2.0) to the diagnosis Lambda, served by the auto-deploy `$default` stage (deployment `gbo1y0`). No known client. Treated as a live dependency: not imported, changed or removed. POTENTIALLY IMPACTS S4R ([findings](phase-0-findings.md#2-the-diagnosis-lambda-has-two-public-ingress-paths)) |
| `whichpart-api` URL and permissions `FunctionURLAllowPublicAccess`, `PublicInvoke`, `RecallIngestDaily`, `TranscriptReviewPeriodic` | AC | Script `services/whichpart-api/deploy.sh:155-306`; CloudTrail | Auth NONE, `BUFFERED`, unqualified, no CORS |
| Orchestrator URL and permissions `FunctionURLAllowPublicAccess`, `PublicInvoke` | AC | Script `orchestration/deploy/deploy.sh:82-86`; CloudTrail | Auth NONE, `BUFFERED`; CORS `*` / POST, GET / `content-type`, `authorization` / max-age 300; bearer token checked in code |
| Error-code MCP URL and permissions `FunctionURLAllowPublicAccess`, `PublicInvoke` | AC | Script `error-codes/mcp/deploy/deploy.sh:126-132`; CloudTrail | Auth NONE, `BUFFERED`; CORS `*` / POST, GET / `content-type`, `authorization`, `mcp-session-id`, `mcp-protocol-version`, `accept` / max-age 300 |

All four `AuthType` values are confirmed `NONE` from the rerun, which records Function URL configuration
unredacted. CORS is recorded exactly and must be preserved exactly.

### IAM

| Resource | Class | Evidence | Used by | Notes |
|---|---|---|---|---|
| `whichpart-api-role` | AC | Script `services/whichpart-api/deploy.sh:59`; CloudTrail (us-east-1) `CreateRole` 2026-08-23 by the account owner; no stack; used only by `whichpart-api` | `whichpart-api` | 8 inline policies (below) + `AWSLambdaBasicExecutionRole` |
| `diag-orchestrator-role` | AC | Script `orchestration/deploy/deploy.sh:59`; CloudTrail (us-east-1) `CreateRole` 2026-08-30 by the account owner; no stack | Orchestrator | No inline policies + `AWSLambdaBasicExecutionRole` |
| `error-code-mcp-role` | AC | Script `error-codes/mcp/deploy/deploy.sh:97`; CloudTrail (us-east-1) `CreateRole` 2026-08-30 by the account owner; no stack | Error-code MCP | `error-code-admin-overlay-s3` + `AWSLambdaBasicExecutionRole` |
| `SparesSite-dev-ServerFunctionRole…` | **S4R** | Managed by the `SparesSite-dev` stack (CloudTrail `CreateRole` by AWS CloudFormation, 2026-07-20); also used by `spares4repairs-server-dev`. The stack manages `ServerFunctionRoleDefaultPolicy975E5328`; every other inline policy put from 2026-07-23 onwards, S4R and AC, was put by hand by the account owner (earlier puts are outside the CloudTrail window) | S4R server Lambda **and** the diagnosis Lambda | Never imported, modified or managed by AC ([ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md)) |
| Inline policies on `whichpart-api-role`: `whichpart-acq-benchmark-s3`, `whichpart-ai-config-secrets`, `whichpart-cognito-auth`, `whichpart-knowledge-admin-s3`, `whichpart-media-admin-s3`, `whichpart-recalls-dynamodb`, `whichpart-recalls-s3`, `whichpart-transcripts-dynamodb` | AC | Script `services/whichpart-api/deploy.sh:71-146`; CloudTrail (us-east-1) `PutRolePolicy` by the account owner on every deploy from 2026-08-30 to 2026-10-05 | `whichpart-api` | `whichpart-cognito-auth` targets the S4R pool: AC's policy, S4R's pool |
| Inline policy `error-code-admin-overlay-s3` on `error-code-mcp-role` | AC | Script `error-codes/mcp/deploy/deploy.sh:103`; CloudTrail (us-east-1) `PutRolePolicy` 2026-09-20 to 2026-10-05 | Error-code MCP | |
| **AC permissions on the S4R role:** `WhichpartLearningPut`, `whichpart-knowledge-overlay-s3`, `whichpart-media-overlay-s3` | **S4R (location)** | **Out-of-band drift on an S4R-owned role**, not created by the stack. CloudTrail (us-east-1) `PutRolePolicy` by the account owner: `WhichpartLearningPut` 2026-08-26; `whichpart-media-overlay-s3` 2026-09-19 to 2026-10-05; `whichpart-knowledge-overlay-s3` 2026-10-05. The overlay policies are put by `services/part-finder/deploy.sh:52-57` | Diagnosis Lambda (and, by sharing, the S4R server Lambda) | Recorded only. Not imported, changed or removed by this work |

### Data

| Resource | Class | Evidence | Consumers | Notes |
|---|---|---|---|---|
| DynamoDB `whichpart-transcripts` | AC | Script `services/whichpart-api/deploy.sh:104-119`; CloudTrail; no stack | AC API | Key `pk`; GSI `gsi_activity` (gsiPk / lastActivityAt, ALL); TTL `expiresAt` on; PITR **on** since the approved Phase 0 backup step (off at the original inventory; earliest restore point 2026-10-07T01:42:02Z); on-demand backup `AVAILABLE`; on-demand billing; ~29,500 items. Holds customer conversations |
| DynamoDB `whichpart-recalls` | AC | Script `services/whichpart-api/deploy.sh:128-140`; CloudTrail; no stack | AC API | Key `pk`; GSI `gsi_activity` (gsiPk / gsiSk, ALL); TTL off; PITR **on** since the approved Phase 0 backup step (off at the original inventory); on-demand backup `AVAILABLE`; on-demand billing; ~1,050 items |
| S3 `whichpart-web-<account>` | AC | Uploaded by `apps/whichpart/deploy-static.sh:8`; CloudTrail; no stack | AC CloudFront (OAC) | Policy: one OAC statement for `E1QD02IAJZPJLM`; no versioning or lifecycle; 172 objects; holds the WebMCP token in `index.html` |
| S3 `whichpart-learning-<account>` | AC | Used by AC scripts and code; CloudTrail; no stack | AC API, diagnosis Lambda, error-code MCP; S4R server Lambda can write via the shared role | No policy; no versioning or lifecycle; ~36,200 objects; routing override lease `released` |

### Secrets

| Resource | Class | Evidence | Notes |
|---|---|---|---|
| `spares4repairs/dev/applianceclinic-ai-config`, `-openai`, `-jev` | AC | CloudTrail: created at runtime by `whichpart-api` | Under the S4R name prefix, readable by the S4R server role's `spares4repairs/dev/*` grant. That grant is S4R's and is not changed |
| `spares4repairs/dev/applianceclinic-canonical-state-token`, `-benchmark-service` | AC | CloudTrail; referenced only by AC code | Same prefix note |
| `spares4repairs/diag-orchestrator/bearer-token`, `spares4repairs/error-code-mcp/bearer-token` | AC | Scripts `orchestration/deploy/deploy.sh:44`, `error-codes/mcp/deploy/deploy.sh:82` | |

No rotation is configured, and all use the default KMS key. A runtime-created
`applianceclinic-readback-probe-*` secret from 2026-10-05 no longer exists.

### Other

| Resource | Class | Evidence | Notes |
|---|---|---|---|
| ECR `spares4repairs-diag-orchestrator` | AC | Script `orchestration/deploy/deploy.sh:39`; no stack | 106 images; deployed `v1` digest recorded in the inventory; no lifecycle policy |
| ECR `spares4repairs-error-code-mcp` | AC | Script `error-codes/mcp/deploy/deploy.sh:76`; no stack | 9 images; deployed `v1` digest recorded; no lifecycle policy |
| EventBridge `whichpart-recall-ingest-daily` | AC | Script `services/whichpart-api/deploy.sh:152`; CloudTrail | `cron(0 6 * * ? *)`, target id `whichpart-api` |
| EventBridge `whichpart-transcript-review` | AC | Script `services/whichpart-api/deploy.sh:167`; CloudTrail | `rate(15 minutes)`, target id `whichpart-api-review`, input `{"transcriptReview": true}` |
| CloudFront distribution `E1QD02IAJZPJLM` | **Unproven** (AC by inference; left unmanaged) | No stack; not used by S4R; its origins are AC resources. A `CreateDistribution` event by the account owner on 2026-08-23 carries no resource name, so the link rests on timing and the `CallerReference` `whichpart-v0-1-20260823`. Not proof of creation, so under rule 1 the class stays `Unproven` (treated as S4R for any change). Nothing changes in practice: it is never modified or imported ([ADR 0008](../adr/0008-cloudfront-initially-unmanaged.md)) | Aliases `applianceclinic.ai`, `www.applianceclinic.ai`, **`whichpart.co.uk`, `www.whichpart.co.uk`**. Left unmanaged ([ADR 0008](../adr/0008-cloudfront-initially-unmanaged.md)); aliases, certificate and DNS are not changed |
| CloudFront function `whichpart-www-redirect` | **Unproven** (AC by inference; left unmanaged) | Attached only to `E1QD02IAJZPJLM`. A CloudFront `CreateFunction` event by the account owner on 2026-08-23 carries no resource name; the link is by timing only | `cloudfront-js-2.0`; development and live code identical |
| ACM certificate and DNS for the distribution's aliases | Unproven | Not inventoried | Referenced only, never imported or changed |

## Created in Phase 7

| Resource | Class | Evidence | Notes |
|---|---|---|---|
| Stack `AcAuthStack`: Cognito user pool `applianceclinic` (`eu-west-1_r4fXXEdxC`), app client `applianceclinic-web`, group `admin`, prefix domain `applianceclinic-admin` | AC | Created by change `7.1-auth-stack` (phase-7-results.md); Retain, termination protection, stack policy | AC sign-in and admin authority (ADR 0006). `whichpart-api` uses it since change `7.2-ac-auth`; `whichpart-cognito-auth` grants `AdminInitiateAuth` on it only, since change `7.3-ac-auth-policy` |
| DynamoDB table `applianceclinic-rate-limits` (`AcDataStack`, `RateLimitTable`) | AC | Created by change `7.4-rate-limit-table`; Retain, deletion protection | `whichpart-api` rate-limit counters: hashed keys, TTL `expiresAt` |
| Inline policy `whichpart-rate-limits-dynamodb` on `whichpart-api-role` (`AcRuntimeStack`) | AC | Created by change `7.5-rate-limit` | `dynamodb:UpdateItem` on `applianceclinic-rate-limits` only |

## Known S4R resources AC depends on

These are `S4R` by definition. AC may read from them or call them as a client, and nothing else.

| Resource | AC dependency |
|---|---|
| S4R Cognito user pool and app client (`SparesSite-dev`) | None since Phase 7 (2026-10-08): AC signs in against its own pool (`AcAuthStack`), and `whichpart-cognito-auth` grants nothing on the S4R pool. Before that, AC admin sign-in (`AdminInitiateAuth`, `GetUser`) |
| S4R HTTP API `spares4repairs-dev` (`65vnizdmk4`) | Diagnosis Lambda and error-code tools call `/api/search` and `/api/parts-for-model`. Its route `POST /ai/chat` (integration `nk77gue`, auto-deploy `$default` stage) invokes the diagnosis Lambda, unauthenticated (S4R-sensitive, confirmed live ingress). Created by hand on 2026-07-20, not in any CloudFormation stack, so it is on the denylist through the manual entries in `tools/migration/config/s4r-known.json` |
| `SparesSite-dev-ServerFunctionRole…` | Execution role of the diagnosis Lambda ([ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md)) |
| S4R CloudFront (shop domain) | Buy links point to it |
| `SparesSite-dev` stack and everything in it | None beyond the above |
| Default `CDKToolkit` bootstrap stack | None. AC uses its own toolkit |
