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

Classes below are based on the Phase 0 inventory of 2026-10-07 (account `800960611664`, eu-west-1),
recorded in [`phase-0-findings.md`](phase-0-findings.md). "Script" evidence refers to the deploy scripts in
`spares4repairs@13b7a50`. "CloudTrail" means a matching creation event in event history. "No stack" means
the resource is not managed by any CloudFormation stack in eu-west-1 or us-east-1.

### Lambda functions

| Resource | Class | Evidence | Consumers | Notes |
|---|---|---|---|---|
| `spares4repairs-part-finder` (diagnosis) | **AC (S4R-consumed)** | CloudTrail: created from the console on 2026-08-20; no stack | AC API, AC orchestrator, **S4R `/part-finder` page (browser)**, possibly the S4R catalogue API (see permissions) | Runs under the **S4R** server role ([ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md)). Zip, nodejs20.x, x86_64, `$LATEST` |
| `whichpart-api` | AC | Script `services/whichpart-api/deploy.sh:7,269`; CloudTrail; no stack | AC site (CloudFront `/api*` origin), EventBridge | Zip, nodejs20.x, `$LATEST` |
| `spares4repairs-diag-orchestrator` | AC | Script `orchestration/deploy/deploy.sh:11,75`; CloudTrail; no stack | AC API | Image, arm64 |
| `spares4repairs-error-code-mcp` | AC | Script `error-codes/mcp/deploy/deploy.sh:16,117`; CloudTrail; no stack | AC API, AC orchestrator | Image, arm64 |

### Function URLs and resource policies

| Resource | Class | Evidence | Notes |
|---|---|---|---|
| Diagnosis Lambda URL (ingress 1) | **AC (S4R-consumed)** | CloudTrail (2026-08-20, console) | Used by the S4R `/part-finder` page. Auth NONE, `RESPONSE_STREAM`, unqualified (`$LATEST`), CORS `*` / POST / `content-type` / max-age 86400. Host, auth and CORS must not change |
| Diagnosis Lambda permissions `FnUrlPublic`, `PublicInvoke` | AC (S4R-consumed) | Created with the URL | Public invoke for the URL. Never modified |
| Diagnosis Lambda permission `apigateway-invoke` (API `65vnizdmk4`, ingress 2) | **S4R-sensitive** | CloudTrail: `AddPermission` by the account owner on 2026-08-20 (statement ID not recorded; inferred from timing) | **Live:** route `POST /ai/chat` on the S4R HTTP API `spares4repairs-dev` invokes the diagnosis Lambda, unauthenticated. No known client. Treated as a live dependency: not imported, changed or removed. POTENTIALLY IMPACTS S4R ([findings](phase-0-findings.md#2-the-diagnosis-lambda-has-two-public-ingress-paths)) |
| `whichpart-api` URL and permissions `FunctionURLAllowPublicAccess`, `PublicInvoke`, `RecallIngestDaily`, `TranscriptReviewPeriodic` | AC | Script `services/whichpart-api/deploy.sh:155-306`; CloudTrail | Auth NONE, `BUFFERED`, unqualified, no CORS |
| Orchestrator URL and permissions | AC | Script `orchestration/deploy/deploy.sh:82-86`; CloudTrail | Auth NONE, `BUFFERED`; bearer token checked in code |
| Error-code MCP URL and permissions | AC | Script `error-codes/mcp/deploy/deploy.sh:126-132`; CloudTrail | Auth NONE, `BUFFERED` |

### IAM

| Resource | Class | Evidence | Used by | Notes |
|---|---|---|---|---|
| `whichpart-api-role` | AC | Script `services/whichpart-api/deploy.sh:59`; CloudTrail `CreateRole` 2026-08-23 by the account owner; no stack; used only by `whichpart-api` | `whichpart-api` | 8 inline policies (below) + `AWSLambdaBasicExecutionRole` |
| `diag-orchestrator-role` | AC | Script `orchestration/deploy/deploy.sh:59`; CloudTrail `CreateRole` 2026-08-30 by the account owner; no stack | Orchestrator | No inline policies + `AWSLambdaBasicExecutionRole` |
| `error-code-mcp-role` | AC | Script `error-codes/mcp/deploy/deploy.sh:97`; CloudTrail `CreateRole` 2026-08-30 by the account owner; no stack | Error-code MCP | `error-code-admin-overlay-s3` + `AWSLambdaBasicExecutionRole` |
| `SparesSite-dev-ServerFunctionRole…` | **S4R** | Managed by the `SparesSite-dev` stack (CloudTrail `CreateRole` by AWS CloudFormation, 2026-07-20); also used by `spares4repairs-server-dev`. Every inline policy on it, S4R and AC, was added by hand by the account owner | S4R server Lambda **and** the diagnosis Lambda | Never imported, modified or managed by AC ([ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md)) |
| Inline policies on `whichpart-api-role`: `whichpart-acq-benchmark-s3`, `whichpart-ai-config-secrets`, `whichpart-cognito-auth`, `whichpart-knowledge-admin-s3`, `whichpart-media-admin-s3`, `whichpart-recalls-dynamodb`, `whichpart-recalls-s3`, `whichpart-transcripts-dynamodb` | AC | Script `services/whichpart-api/deploy.sh:71-146` | `whichpart-api` | `whichpart-cognito-auth` targets the S4R pool: AC's policy, S4R's pool |
| Inline policy `error-code-admin-overlay-s3` on `error-code-mcp-role` | AC | Script `error-codes/mcp/deploy/deploy.sh:103` | Error-code MCP | |
| **AC permissions on the S4R role:** `WhichpartLearningPut`, `whichpart-knowledge-overlay-s3`, `whichpart-media-overlay-s3` | **S4R (location)** | Added by hand outside the S4R stack; the overlay policies by `services/part-finder/deploy.sh:52-57` | Diagnosis Lambda (and, by sharing, the S4R server Lambda) | Recorded only. Not imported, changed or removed by this work |

### Data

| Resource | Class | Evidence | Consumers | Notes |
|---|---|---|---|---|
| DynamoDB `whichpart-transcripts` | AC | Script `services/whichpart-api/deploy.sh:104-119`; CloudTrail; no stack | AC API | Key `pk`; GSI `gsi_activity` (gsiPk / lastActivityAt, ALL); TTL `expiresAt` on; PITR **off**; on-demand; ~29,500 items. Holds customer conversations |
| DynamoDB `whichpart-recalls` | AC | Script `services/whichpart-api/deploy.sh:128-140`; CloudTrail; no stack | AC API | Key `pk`; GSI `gsi_activity` (gsiPk / gsiSk, ALL); TTL off; PITR **off**; on-demand; ~1,050 items |
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
| CloudFront distribution `E1QD02IAJZPJLM` | AC (unmanaged) | Console-created; no stack; not used by S4R | Aliases `applianceclinic.ai`, `www.applianceclinic.ai`, **`whichpart.co.uk`, `www.whichpart.co.uk`**. Left unmanaged ([ADR 0008](../adr/0008-cloudfront-initially-unmanaged.md)); aliases, certificate and DNS are not changed |
| CloudFront function `whichpart-www-redirect` | AC (unmanaged) | Console-created; attached only to `E1QD02IAJZPJLM` | `cloudfront-js-2.0`; development and live code identical |
| ACM certificate and DNS for the distribution's aliases | Unproven | Not inventoried | Referenced only, never imported or changed |

## Known S4R resources AC depends on

These are `S4R` by definition. AC may read from them or call them as a client, and nothing else.

| Resource | AC dependency |
|---|---|
| S4R Cognito user pool and app client (`SparesSite-dev`) | AC admin sign-in (`AdminInitiateAuth`, `GetUser`) until Phase 7 |
| S4R HTTP API `spares4repairs-dev` (`65vnizdmk4`) | Diagnosis Lambda and error-code tools call `/api/search` and `/api/parts-for-model`. Its route `POST /ai/chat` invokes the diagnosis Lambda, unauthenticated (S4R-sensitive). Created by hand on 2026-07-20, not in any CloudFormation stack, so it is on the denylist through the manual entries in `tools/migration/config/s4r-known.json` |
| `SparesSite-dev-ServerFunctionRole…` | Execution role of the diagnosis Lambda ([ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md)) |
| S4R CloudFront (shop domain) | Buy links point to it |
| `SparesSite-dev` stack and everything in it | None beyond the above |
| Default `CDKToolkit` bootstrap stack | None. AC uses its own toolkit |
