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

The candidates below come from the AC deployment scripts in `spares4repairs@13b7a50`. **All of
them are `Unproven` until the Phase 0 inventory confirms them.** Physical names that include the
account ID are written with `<account>`.

### Lambda functions

| Resource | Created by | Consumers | Class | Evidence | Notes |
|---|---|---|---|---|---|
| `spares4repairs-part-finder` | Console (script only updates it: `services/part-finder/deploy.sh:12`) | AC API, AC orchestrator, **S4R `/part-finder` page (browser)** | Unproven | | Expected `AC (S4R-consumed)` |
| `whichpart-api` | `services/whichpart-api/deploy.sh:7,269` | AC site (CloudFront origin, to confirm), EventBridge | Unproven | | |
| `spares4repairs-diag-orchestrator` | `orchestration/deploy/deploy.sh:11,75` | AC API | Unproven | | Container image |
| `spares4repairs-error-code-mcp` | `error-codes/mcp/deploy/deploy.sh:16,117` | AC API, AC orchestrator | Unproven | | Container image |

### Function URLs and resource policies

| Resource | Created by | Consumers | Class | Evidence | Notes |
|---|---|---|---|---|---|
| Diagnosis Lambda URL | Console | AC, **S4R `/part-finder` page** | Unproven | | Expected `AC (S4R-consumed)`. Host and CORS must not change |
| `whichpart-api` URL | `services/whichpart-api/deploy.sh:282` | AC site | Unproven | | `--auth-type NONE` |
| Orchestrator URL | `orchestration/deploy/deploy.sh:82` | AC API | Unproven | | `--auth-type NONE`, bearer token checked in code |
| Error-code MCP URL | `error-codes/mcp/deploy/deploy.sh:126` | AC API, AC orchestrator | Unproven | | `--auth-type NONE` |
| Permissions `FunctionURLAllowPublicAccess`, `PublicInvoke`, `RecallIngestDaily`, `TranscriptReviewPeriodic` | AC deploy scripts | Lambda service | Unproven | | Record the full resource policy of each function |

### IAM

| Resource | Created by | Used by | Class | Evidence | Notes |
|---|---|---|---|---|---|
| `whichpart-api-role` | `services/whichpart-api/deploy.sh:59` | `whichpart-api` | Unproven | | |
| `diag-orchestrator-role` | `orchestration/deploy/deploy.sh:59` | Orchestrator | Unproven | | |
| `error-code-mcp-role` | `error-codes/mcp/deploy/deploy.sh:97` | Error-code MCP | Unproven | | |
| Diagnosis Lambda role | Console (name unknown) | Diagnosis Lambda, others? | Unproven | | **If any non-AC function uses it, it is `S4R`** |
| Inline policies (11): `whichpart-cognito-auth`, `whichpart-ai-config-secrets`, `whichpart-acq-benchmark-s3`, `whichpart-media-admin-s3`, `whichpart-knowledge-admin-s3`, `whichpart-transcripts-dynamodb`, `whichpart-recalls-dynamodb`, `whichpart-recalls-s3`, `error-code-admin-overlay-s3`, `whichpart-media-overlay-s3`, `whichpart-knowledge-overlay-s3` | AC deploy scripts | AC roles | Unproven | | `whichpart-cognito-auth` targets the S4R pool. The policy is AC's; the pool is S4R's |

### Data

| Resource | Created by | Consumers | Class | Evidence | Notes |
|---|---|---|---|---|---|
| DynamoDB `whichpart-transcripts` | `services/whichpart-api/deploy.sh:104-119` | AC API | Unproven | | TTL, `gsi_activity`. Holds customer conversations |
| DynamoDB `whichpart-recalls` | `services/whichpart-api/deploy.sh:128-140` | AC API | Unproven | | `gsi_activity` |
| S3 `whichpart-web-<account>` | Console (`apps/whichpart/deploy-static.sh:8` uploads) | AC CloudFront | Unproven | | Holds the WebMCP token in `index.html` |
| S3 `whichpart-learning-<account>` | Console (`services/whichpart-api/deploy.sh:87`) | AC API, diagnosis Lambda, error-code MCP | Unproven | | Knowledge, media, routing override lease |

### Secrets

| Resource | Created by | Consumers | Class | Evidence | Notes |
|---|---|---|---|---|---|
| `spares4repairs/dev/applianceclinic-*` (ai-config, openai, jev, canonical-state-token, benchmark-service, and any created at runtime by `ai-config.js`) | AC scripts, console, or AC runtime | AC API, diagnosis Lambda | Unproven | | The S4R server role's `spares4repairs/dev/*` grant can read these. That grant is S4R's and is not changed |
| `spares4repairs/diag-orchestrator/bearer-token` | `orchestration/deploy/deploy.sh:44` | AC API, orchestrator | Unproven | | |
| `spares4repairs/error-code-mcp/bearer-token` | `error-codes/mcp/deploy/deploy.sh:82` | AC API, orchestrator, error-code MCP | Unproven | | |

### Other

| Resource | Created by | Consumers | Class | Evidence | Notes |
|---|---|---|---|---|---|
| ECR `spares4repairs-diag-orchestrator` | `orchestration/deploy/deploy.sh:39` | Orchestrator | Unproven | | |
| ECR `spares4repairs-error-code-mcp` | `error-codes/mcp/deploy/deploy.sh:76` | Error-code MCP | Unproven | | |
| EventBridge `whichpart-recall-ingest-daily` | `services/whichpart-api/deploy.sh:152` | `whichpart-api` | Unproven | | Target Id `whichpart-api` |
| EventBridge `whichpart-transcript-review` | `services/whichpart-api/deploy.sh:167` | `whichpart-api` | Unproven | | Target with a constant Input; also runs routing override recovery |
| CloudFront distribution for applianceclinic.ai | Console | Public | Unproven | | Left unmanaged in this migration |
| CloudFront function `whichpart-www-redirect` | Console | AC distribution | Unproven | | Left unmanaged. Confirm it is not attached to the S4R distribution |
| ACM certificate and DNS for applianceclinic.ai | Console | AC distribution | Unproven | | Referenced only, never imported |

## Known S4R resources AC depends on

These are `S4R` by definition. AC may read from them or call them as a client, and nothing else.

| Resource | AC dependency |
|---|---|
| S4R Cognito user pool and app client (`SparesSite-dev`) | AC admin sign-in (`AdminInitiateAuth`, `GetUser`) until Phase 7 |
| S4R catalogue API Gateway | Diagnosis Lambda and error-code tools call `/api/search` and `/api/parts-for-model` |
| S4R CloudFront (shop domain) | Buy links point to it |
| `SparesSite-dev` stack and everything in it | None beyond the above |
| Default `CDKToolkit` bootstrap stack | None. AC uses its own toolkit |
