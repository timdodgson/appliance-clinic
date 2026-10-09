# Architecture overview

This describes the system as it runs in production. Decisions behind it are in [`docs/adr/`](../adr/README.md); the
Phase 8 review that produced this page is [phase-8-findings.md](phase-8-findings.md).

## Components

| Component | Code | Runs as | Owns |
|---|---|---|---|
| **AC site** | `apps/whichpart` | Static files in S3 `whichpart-web-<account>`, CloudFront `E1QD02IAJZPJLM` | Customer chat UI, admin UI |
| **BFF** (`whichpart-api`) | `services/whichpart-api` | Lambda zip, Function URL, CloudFront `/api*` origin | Customer turns, AC sign-in, admin, scheduled jobs, canonical session state, transcripts |
| **Orchestrator** | `orchestration/` (Python) | Lambda image `spares4repairs-diag-orchestrator` (arm64) | Turn control: scope, routing, canonical control, legacy flows, safety, identity. No language model |
| **Error-code MCP** | `error-codes/mcp` (Python) | Lambda image `spares4repairs-error-code-mcp` (arm64) | Error-code tools (MCP over HTTP), error-code admin catalogue |
| **Diagnosis engine** (`part-finder`) | `services/part-finder` | Lambda zip `spares4repairs-part-finder`, public Function URL (response streaming) | UNDERSTAND (Jev), retrieval, decisions, COMPOSE, the NDJSON stream. **Also the S4R `/part-finder` backend** |

Data: DynamoDB `whichpart-transcripts`, `whichpart-recalls`, `applianceclinic-rate-limits`; S3
`whichpart-learning-<account>` (learning traces, knowledge and media overlays, test-area data).

## Request flows

**AC customer turn**

1. Browser → CloudFront `/api/...` → `whichpart-api`. The browser holds only an opaque signed session token.
2. `whichpart-api` loads the conversation state, applies the rate limit, and calls the orchestrator with its bearer,
   attaching the canonical cs/1 block.
3. The orchestrator calls the diagnosis engine's Function URL twice:
   - `mode: understand`: Jev classifies the latest message
   - diagnose: the typed understanding is injected
   On error-code routes it also calls the MCP with its bearer.
4. `whichpart-api` maps the result to the WhichPart view, persists the transcript and the new state (conditional
   write), and returns.

**S4R `/part-finder` turn**

1. The S4R page calls the diagnosis engine's Function URL directly, with `{messages}` only.
2. The engine runs Jev UNDERSTAND in process, then the legacy pipeline, and streams NDJSON.

The contract is pinned by `tools/migration` (`baseline contract verify`) and must not change.

**Admin request:** browser → `/api/admin/...` → `whichpart-api`, which checks an AC Cognito session in the `admin` group
before any admin handler runs.

**Scheduled jobs (EventBridge → `whichpart-api`):** recall ingest and transcript review.

## Canonical and legacy

| Path | Status | Reached by |
|---|---|---|
| Canonical control (`services/part-finder/canonical/*`, orchestrator canonical branch) | **Canonical** | AC turns on allow-listed journeys. `whichpart-api` runs `CANONICAL_MODE=control` with `CANONICAL_CONTROL_JOURNEYS` listing them |
| Legacy pipeline (part-finder handler decision chain and COMPOSE) | **Legacy, retained** ([ADR 0012](../adr/0012-legacy-diagnosis-pipeline-retained.md)) | Every S4R request; AC turns no canonical journey owns; AC fallback when canonical degrades |
| Orchestrator legacy flows (`_flow_error_code`, `_flow_symptoms`, `_flow_combined`, `_flow_clarify`) | **Legacy, retained** | AC turns not under canonical control |
| In-process generative UNDERSTAND | **Removed** in Phase 8 | Nothing; Jev replaced it |
| `POST /ai/chat` on the S4R HTTP API | **Retired** in Phase 7 (C1) | Nothing reaches the engine through it |

Rollback of canonical control is configuration only: `CANONICAL_MODE=shadow` or `off` on `whichpart-api`.

## Authentication

| Boundary | Mechanism |
|---|---|
| Customer browser → `whichpart-api` | Signed opaque session token (HMAC, `applianceclinic/production/canonical-state-token`), rate limit by hashed key |
| Admin browser → `whichpart-api` | AC Cognito user pool (`AcAuthStack`), group `admin`; the BFF checks it per request |
| `whichpart-api` → orchestrator | Bearer `applianceclinic/production/orchestrator-bearer` |
| `whichpart-api`, orchestrator → MCP | Bearer `applianceclinic/production/mcp-bearer` |
| Anyone → diagnosis engine URL | **Unauthenticated (public).** S4R's browser calls it. The fields `understand`, `canonical` and `seed` are meant for the orchestrator only but are not yet authenticated ([findings §5](phase-8-findings.md#5-brittle-interfaces-and-risks)) |
| Engine → Jev, OpenAI | Provider credentials from `applianceclinic/production/{jev,openai}` |

## Secrets and configuration

- **Secrets** live in Secrets Manager under `applianceclinic/production/*` (`AcDataStack`).
  - Lambdas receive secret **ids** in environment variables, never values.
  - Bearers are resolved through CloudFormation dynamic references.
  - The old `spares4repairs/dev/applianceclinic-*` secrets remain unread. They are not deleted.
- **Configuration** is environment variables on each Lambda, owned by `AcRuntimeStack` (`infra/cdk/config/runtime-overrides.json`).
  - Each JavaScript runtime reads its environment in one module (`config.js`), which lists required and optional
    variables and their defaults.
  - Changing a value is a CDK change, not a console edit.
- **Admin-editable AI settings** (models, prompts toggles) are stored in the `ai-config` secret and written by the
  Settings page.

## Infrastructure ownership (CDK)

| Stack | Holds |
|---|---|
| `AcAuthStack` | AC Cognito user pool, app client, `admin` group |
| `AcDataStack` | DynamoDB tables, S3 learning and web buckets, `applianceclinic/production/*` secrets, ECR repositories |
| `AcRuntimeStack` | The four Lambda functions, their Function URLs and permissions, execution roles and policies, EventBridge schedules |
| AC CDK toolkit | Bootstrap for the above ([ADR 0005](../adr/0005-dedicated-cdk-bootstrap.md)) |

Not owned: CloudFront `E1QD02IAJZPJLM` ([ADR 0008](../adr/0008-cloudfront-initially-unmanaged.md)), and everything S4R
owns ([ADR 0003](../adr/0003-s4r-compatibility-boundary.md); [ownership.md](../migration/ownership.md)).

Every production change goes through `infra/production/steps/change.sh`:

1. synthesise
2. template equality check
3. change set with the checker
4. temporary least-privilege execution policy and stack policy
5. execute
6. drift and no-op check
7. restore

## Runbook and rollback

- **Health:**
  - `infra/production/verify-ac-endpoints.sh`
  - `verify-ac-auth.sh`
  - `s4r-boundary.sh`
  - `tools/migration` `baseline contract verify` (`/part-finder`) and the smoke compare
- **Runtime code release:**
  - build the zip with `build/scripts/package_zips.py`
  - deploy through a `change.sh` spec that sets `functions.<name>.code`
  - update `build/reference/*.zip.json` in the same pull request (CI requires the built zip to equal it)
- **Rollback:** revert the pull request and run the same change with the previous artefact. Each release spec records
  the previous code SHA-256. The published Lambda version `1` of `whichpart-api` is a further fallback.
- Phase runbooks: [`docs/migration/runbooks/`](../migration/runbooks/README.md).
