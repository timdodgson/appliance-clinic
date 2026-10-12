# Phase 15 results: a dedicated canonical diagnosis engine

Phase 15 implemented [ADR 0019](../adr/0019-dedicated-canonical-diagnosis-engine.md):
- Appliance Clinic (AC) has its own canonical diagnosis engine, `applianceclinic-diagnosis-engine`.
- The legacy diagnosis code is deleted from AC.
- The old shared engine, `spares4repairs-part-finder`, is not modified and receives no AC traffic.

Tracking issue: <!-- P15: issue number -->

## New engine resource

| Item | Value |
|---|---|
| Lambda | `applianceclinic-diagnosis-engine`, handler `handler.handler`, nodejs22.x |
| Source | `services/diagnosis-engine/` (moved from `services/part-finder/`; git history keeps the old code) |
| Created by | `AcRuntimeStack`, through `infra/production/steps/change.sh`; overrides under `functions.applianceclinic-diagnosis-engine.create` |
| Function URL | `AWS_IAM`, `BUFFERED`, no CORS. <!-- P15: URL host --> |
| Execution role | `ac-diagnosis-engine-role`: own log group; `GetSecretValue` on `applianceclinic/production/{ai-config,openai,jev}`; `PutObject` on `learning/feedback/*`; read `media-admin/*` |
| Callers | `diag-orchestrator-role` (`DIAGNOSIS_ENGINE_URL`), `whichpart-api-role` (`ENGINE_URL`), via inline policy `ac-invoke-diagnosis-engine` |
| Log group | `/aws/lambda/applianceclinic-diagnosis-engine`, 90-day retention |
| Alarms | `-FailedTurns` (5 or more in 5 minutes), `-RefusedRequests` (1 or more), `-Errors`, `-Throttles`. No notification target yet |
| Code SHA-256 | <!-- P15: code SHA-256 --> |
| Change spec | <!-- P15: change id(s) --> |

## Canonical modules retained, legacy deleted

| Retained | Deleted |
|---|---|
| `canonical-runtime.js`, `canonical/*` | Legacy handler and pipeline (`part-finder-lambda.js`) |
| `jev-understand.js`, `jev-client.js`, `jev-mc1.js`, `identity.js`, token gate | Legacy COMPOSE (`engine/compose.js`) and its three prompts (`diagnosis.compose.system`, `intent-hints`, `turn`) |
| Media selection and the admin media overlay | Retrieval (`retrieval.js`) and runtime knowledge-index embeddings |
| `security.js` (output tripwire), `engine-auth.js`, `admin-config.js`, `inference.js` | Legacy evidence, progression, presentation, safety and intent modules; fit-evidence; normal-behaviour |
| Fault catalogue and error codes (`faults-catalogue.json`) | The unsigned `{messages}` contract, streaming and S4R CORS |
| S4R Parts Catalogue client (external service); model and part fit lookups; product images; shop links | The `/part-finder` contract type and its field-coverage gate |
| Read-only knowledge inspection (whichpart-api) | The knowledge-publish admin workflow (`knowledge-admin.js`; routes now 404) |
| | Retired deploy scripts (`orchestration/deploy/deploy.sh`, `services/whichpart-api/deploy.sh`, `services/part-finder/deploy.sh`) |

## Line reduction

| Area | Before | After |
|---|---|---|
| Diagnosis engine runtime | <!-- P15: lines before --> | <!-- P15: lines after --> |
| whichpart-api runtime | <!-- P15: lines before --> | <!-- P15: lines after --> |
| Tests | <!-- P15: lines before --> | <!-- P15: lines after --> |

## Tests removed and retained

| Suite | Before | After |
|---|---|---|
| Runtime test files (all) | 204, all pass at `main` `8fce213` | <!-- P15: after total and result --> |
| Diagnosis engine test files | 137 | 90 (41 legacy-only removed; <!-- P15: others merged or rewritten -->) |
| whichpart-api test files | 46 | 45 + 1 new (<!-- P15: names -->) |
| Typecheck, tooling, lint | Clean, 796/796, clean | <!-- P15: results --> |

Removed files are recorded under `removed` in `docs/migration/runtime-changes.json` with their reasons.

## Cutover evidence

<!-- P15: cutover sequence: engine created, orchestrator switched to DIAGNOSIS_ENGINE_URL, whichpart-api switched to the
IAM ENGINE_URL; times, change ids and first signed calls -->

## Signed AC traffic to the old engine

| Window | Signed AC calls to `spares4repairs-part-finder` |
|---|---|
| 7 days before the cutover | 8,604 |
| After the cutover | <!-- P15: after count and window --> |

## Proof the old engine was not modified

<!-- P15: configuration, code SHA-256, URL auth and CORS, role and policy before and after; CloudTrail shows no write
to the function, its URL, permissions or role -->

## CDK ownership outcome

<!-- P15: ownership outcome (relinquished from AcRuntimeStack with Retain and zero physical change, with the change-set
proof; or blocked, with the reason) -->

## Remaining S4R references, and why

| Reference | Why it stays |
|---|---|
| S4R Parts Catalogue client, `PARTS_FOR_MODEL_API` | External service AC calls as a client |
| `S4R_PRODUCT_BASE_URL` | External shop links |
| `spares4repairs-diag-orchestrator`, `spares4repairs-error-code-mcp`, their ECR repositories | Renaming means replacing the function |
| `spares4repairs/dev/applianceclinic-*` secret names | Historical physical names, where still present |
| `docs/migration/s4r-denylist.json` and the denylist guards | AC tooling must never touch S4R resources |
| Historical phase results and runbooks | Kept as written |
| S4R gates in `tools/` and `infra/` scripts | Retired; removal in a follow-up step <!-- P15: follow-up --> |
| `.github/pull_request_template.md` "/part-finder contract test result" | <!-- P15: follow-up --> |
| <!-- P15: others --> | |

## GOLD

Exactly two runs, 20 minutes apart, on the deployed build. No exploratory GOLD.

| Run | Build | Score | Critical failures |
|---|---|---|---|
| 1 | <!-- P15: SHA --> | <!-- P15: score --> | <!-- P15 --> |
| 2 | <!-- P15: SHA --> | <!-- P15: score --> | <!-- P15 --> |

## Production checks

<!-- P15: AC endpoints, auth, bearer, live AC journeys, engine /health, alarms state, stack drift, overrides equal to
runtime-overrides.json, CloudTrail -->

## Pull requests and commits

| PR | Merge SHA | What |
|---|---|---|
| <!-- P15: PR --> | <!-- P15: SHA --> | <!-- P15 --> |

## Releases

| Release | Unit | What |
|---|---|---|
| <!-- P15: release id --> | <!-- P15: unit --> | <!-- P15 --> |
