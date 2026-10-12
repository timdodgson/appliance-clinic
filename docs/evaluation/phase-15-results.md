# Phase 15 results: a dedicated canonical diagnosis engine

Phase 15 implemented [ADR 0019](../adr/0019-dedicated-canonical-diagnosis-engine.md):
- Appliance Clinic (AC) has its own canonical diagnosis engine, `applianceclinic-diagnosis-engine`.
- The legacy diagnosis code is deleted from AC.
- The old shared engine, `spares4repairs-part-finder`, is not modified and receives no AC traffic.

Pull request: #121.

## New engine resource

| Item | Value |
|---|---|
| Lambda | `applianceclinic-diagnosis-engine`, handler `handler.handler`, nodejs22.x |
| Source | `services/diagnosis-engine/` (moved from `services/part-finder/`; git history keeps the old code) |
| Created by | `AcRuntimeStack`, through `infra/production/steps/change.sh`; overrides under `functions.applianceclinic-diagnosis-engine.create` |
| Function URL | `AWS_IAM`, `BUFFERED`, no CORS |
| Execution role | `ac-diagnosis-engine-role`: own log group; `GetSecretValue` on `applianceclinic/production/{ai-config,openai,jev}`; `PutObject` on `learning/feedback/*`; read `media-admin/*` |
| Callers | `diag-orchestrator-role` (`DIAGNOSIS_ENGINE_URL`), `whichpart-api-role` (`ENGINE_URL`), via inline policy `ac-invoke-diagnosis-engine` |
| Log group | `/aws/lambda/applianceclinic-diagnosis-engine`, 90-day retention |
| Alarms | `-FailedTurns` (5 or more in 5 minutes), `-RefusedRequests` (1 or more), `-Errors`, `-Throttles`. No notification target yet |
| Code SHA-256 | `alagHdzdHKAG8tVNg+dDvDbCa94JLsEABrrAHGpAuKw=` (reference `build/reference/applianceclinic-diagnosis-engine.zip.json`) |
| Change specs | 15.1a (role, caller policies), 15.1b (log group, metric filters), 15.1c (alarms), 15.1d (function, URL) |

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

| Area | Before (`8fce213`) | After |
|---|---|---|
| Diagnosis engine runtime JavaScript | 24,836 | 15,923 |
| Diagnosis engine tests | 21,714 | 12,435 |
| whichpart-api runtime JavaScript | 20,048 | 18,806 |
| Migration tooling (`tools/migration`) | 6,591 | 6,030 |
| Whole repository, code and config (docs excluded) | | 414 files changed: +3,295, −24,403 |

## Tests

| | Before | After |
|---|---|---|
| Runtime test files (all) | 204, all pass at `main` `8fce213` | **163, ALL PASS** |
| Diagnosis engine test files | 137 | 90: 41 legacy-only files removed; `engine-adr0018-enforcement` replaced by `engine-signed-boundary`; `media-neutrality` rewritten on the canonical path; `health`, `engine-structure` and the canonical harness tests rewritten for the signed, buffered handler |
| whichpart-api test files | 46 | 46: `knowledge-admin.test.mjs` removed with the workflow; `engine-signature.test.mjs` added (SigV4 vectors cross-checked against botocore) |
| Orchestration | | `test_engine_request_signing.py` added (HMAC + SigV4) |
| Typecheck, tooling, lint | Clean, 742, clean | Clean, **724/724** (18 tests went with the deleted S4R gate commands), clean |

No test is skipped or marked as an expected failure.

## Cutover

1. 15.1a to 15.1d created the engine; its health reported 63 journeys, Jev and LM Studio configured, the media baseline loaded. An unsigned request got 401.
2. 15.2 switched the orchestrator (`DIAGNOSIS_ENGINE_URL`, image with SigV4 signing) and whichpart-api (`ENGINE_URL`, SigV4 on feedback and health probes) at 07:02 UTC. The first attempt failed before any function changed (the grant lacked `iam:PassRole`, which a configuration update needs) and its rollback failed for the same reason; the owner approved `continue-update-rollback` skipping the two unchanged functions, drift was IN_SYNC, and the corrected change applied.
3. 15.4 shipped the orchestrator without the dead legacy code.

Every change: template equal to the deployed one except the named resources, change set exactly the spec's, drift IN_SYNC, deployed configuration equal to `runtime-overrides.json`, the same template a no-op, CloudTrail writes only on the spec's resources.

## Signed AC traffic to the old engine

| Window | Signed AC requests to `spares4repairs-part-finder` |
|---|---|
| 7 days before the cutover | 8,604 |
| 24 hours before the cutover | 5,413 |
| After the cutover (07:02 UTC onwards, AC logs) | **0** (no AC request of any kind) |

The new engine's log group shows the same AC traffic, signed and served (understand and diagnose, all ok).

## The old engine was not modified

A fingerprint of the old engine was taken before and after release 15.3: its configuration, code SHA-256 (`ddicbVOIrPHVuo6V94c2SZ6/mpHIenObwKl5KK3KelY=`), Function URL configuration, resource policy, reserved concurrency, `ac-diagnosis-role` and its five inline policies. The two were identical. CloudTrail for 15.3 shows no write at all. No change in this phase targeted the old engine: each spec lists it as a forbidden resource.

## CDK ownership

**Relinquished with zero physical change** (change 15.3). The change set held exactly ten `Remove` actions (the function, its URL, its two resource-policy statements, `ac-diagnosis-role` and its five inline policies), each with `PolicyAction: Retain`, and no Delete, Replace or Modify. AcRuntimeStack no longer declares, captures or reads them; the read-only execution policy no longer covers them.

## Remaining S4R references

| Reference | Why it stays |
|---|---|
| `PARTS_FOR_MODEL_API` (S4R Parts Catalogue) and `S4R_PRODUCT_BASE_URL` (S4R Shop links) | The one permitted relationship: outbound, to an external service |
| `ac-deny-s4r`, the S4R denylist, `s4r-boundary.sh`, the S4R pool rejection in `verify-ac-auth.sh` | Guards that AC never writes to S4R resources; they test nothing of S4R's behaviour |
| AC resources named `spares4repairs-*` (`spares4repairs-diag-orchestrator`, `spares4repairs-error-code-mcp`, their ECR repositories, the `spares4repairs/dev/applianceclinic-*` secrets) | Historical physical names; renaming replaces the resource |
| Historical change specs, phase results, runbooks and ADRs | Records; not rewritten |
| Phase 4 sandbox tooling and fixtures in `tools/migration` | Historical tooling; it gates nothing in production |

## Residual coupling

The old engine still runs in AC's AWS account with `ac-diagnosis-role`, AC's secrets and AC's Jev credit, for its external consumer. Changing any of that would modify resources the old engine depends on, which this phase deliberately did not do.

## GOLD

Exactly two runs, 20 minutes apart, on the exact deployed build (`main` at `10ab5ff`, overrides equal to production). No other GOLD run was made in this phase.

| Run | Build | Window (UTC) | Result |
|---|---|---|---|
| 1 | `10ab5ff` | 07:59 to 08:03 | **56/56**, no critical failure, no error or judge error |
| 2 | `10ab5ff` | 08:23 to 08:27 | **56/56**, no critical failure, no error or judge error |

**The gate is met.**

## Production checks

After both GOLD runs: the new engine had served 585 signed AC requests since the cutover (304 understand, 281 diagnose), every one ok; the old engine had received **0** signed requests. Alarms: FailedTurns, RefusedRequests and Errors OK. Throttles went to ALARM for one throttled invocation at 08:20, as GOLD run 2 started: the account's Lambda concurrency limit is 10 (a known constraint since Phase 7). The orchestrator's single 429 retry absorbed it and no turn failed. AC bearer checks 5/5 (old orchestrator and MCP bearers refused, current accepted); AcRuntimeStack UPDATE_COMPLETE; live AC journeys (gas stop, intake, washing-machine drain journey, code meaning, unsafe decline); engine health; stack drift IN_SYNC; overrides equal to `runtime-overrides.json`; build equivalence of the engine zip, the whichpart-api zip and the orchestrator image with the deployed builds.

## Releases

| Change | Unit | What |
|---|---|---|
| 15.1a | IAM | `ac-diagnosis-engine-role`; caller invoke policies |
| 15.1b | Logs | Engine log group and metric filters |
| 15.1c | CloudWatch | Engine alarms |
| 15.1d | applianceclinic-diagnosis-engine | Function and IAM Function URL |
| 15.2 | orchestrator, whichpart-api | Cutover |
| 15.3 | AcRuntimeStack | Shared engine released (Retain, no physical change) |
| 15.4 | orchestrator | Dead legacy code removed |

Pull request #121, merged as `10ab5ff`.
