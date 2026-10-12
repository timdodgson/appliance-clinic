# Configuration

Every runtime reads its configuration from environment variables at cold start. Production values are set by
`AcRuntimeStack`: the live capture, plus [`runtime-overrides.json`](../../infra/cdk/config/runtime-overrides.json).
Changing a value is a reviewed CDK change, never a console edit. Secrets are never environment values: a variable names
a Secrets Manager secret id, or holds a CloudFormation dynamic reference that resolves at deploy time.

**Where configuration is read.**
- **Diagnosis engine:** the request-path settings are in [`engine/config.js`](../../services/diagnosis-engine/engine/config.js).
- **whichpart-api:** the boundary settings are in [`config.js`](../../services/whichpart-api/config.js).
- **Shared modules** read their own settings next to their code. They are listed below with the module.

[`configuration.test.mjs`](../../build/test/configuration.test.mjs) fails when a runtime reads an environment variable
this page does not list.

**Column meanings.**
- **Required:** the code fails without the variable.
- **Optional:** the code has a default, given in the table.
- **Set:** the variable is set on the production function.

## Diagnosis engine (`applianceclinic-diagnosis-engine`)

Declared in `runtime-overrides.json` under `functions.applianceclinic-diagnosis-engine` (`create` holds the function's
own settings: role, runtime, handler, IAM Function URL, log retention, alarms).

| Variable | Required | Default | Set | Read by |
|---|---|---|---|---|
| `AC_BEARER_VERSIONS` | Not read by code | none | Yes: the pinned engine-signing secret version | A non-secret marker that forces an update on every key rotation |
| `AI_CONFIG_SECRET_ID`, `OPENAI_SECRET_ID`, `JEV_SECRET_ID` | Optional | `spares4repairs/${STAGE}/applianceclinic-{ai-config,openai,jev}` (historical names, see below) | Yes: `applianceclinic/production/*` | `admin-config.js` |
| `ENGINE_SIGNING_TOKEN` | Required: every request must be signed (ADR 0017, ADR 0019) | none: every request is refused with 401 (fails closed) | Yes: a dynamic reference to `applianceclinic/production/engine-signing` | `engine-auth.js` |
| `LEARNING_BUCKET` | Optional | empty (feedback and media overlays off) | Yes | `engine/learning-log.js`, `media.js` |
| `LM_STUDIO_URL` | Optional | `http://localhost:1234` | Yes: a private tunnel URL, declared by SHA-256 digest only | `inference.js` |
| `STAGE` | Optional | `dev` | No | `admin-config.js` (secret-id defaults) |
| `AI_CONFIG_CACHE_TTL_MS` | Optional | 60000 | No | `admin-config.js`, `engine/config.js` |
| `LM_TEMPERATURE`, `LM_TIMEOUT_MS`, `LM_REPEAT_PENALTY` | Optional | 0.3, 240000, 1.1 | No | `engine/config.js` |
| `MAX_MESSAGES`, `MAX_BODY_BYTES` | Optional | 12, 8 MiB | No | `engine/config.js` |
| `PARTS_FOR_MODEL_API` | Optional | the S4R Parts Catalogue API (external service, see below) | No | `engine/config.js` |
| `MEDIA_OVERLAY_TTL_MS` | Optional | 10000 | No | `media-effective.js` |
| `JEV_TIMEOUT_MS` | Optional | 15000 | No | `jev-client.js` |
| `CANONICAL_MC1_QUESTIONS` | Optional | `1` (on) | No | `canonical-runtime.js` |
| `LLM_PROVIDER`, `UNDERSTAND_PROVIDER`, `COMPOSE_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Optional | `lmstudio`; OpenAI base `https://api.openai.com/v1` | No | `inference.js` (environment-only provider selection; production uses the admin AI config) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_GATEWAY_ID`, `JEV_ACCOUNT_ID`, `JEV_API_TOKEN`, `JEV_GATEWAY_ID` | Optional | none (the Jev secret is used) | No | `admin-config.js` (local runs) |
| `AWS_REGION` | Lambda | `eu-west-1` | Lambda sets it | AWS clients |

**Removed in Phase 15** with the legacy code: `LM_MAX_TOKENS` (legacy COMPOSE), `SEARCH_API` (legacy catalogue
search), and `EMBED_URL`, `EMBED_MODEL`, `EMBED_TIMEOUT_MS` (retrieval embeddings, in the engine and whichpart-api).

## whichpart-api

| Variable | Required | Default | Set | Read by |
|---|---|---|---|---|
| `ORCHESTRATOR_URL`, `ORCHESTRATOR_TOKEN` | Optional | the production orchestrator URL (see below); empty token | Yes | `config.js` |
| `ENGINE_URL` | Optional | the production engine URL (see below) | Yes: the `applianceclinic-diagnosis-engine` IAM Function URL | `config.js`; the feedback POST and the admin health probes, SigV4-signed with this function's role (`engine-signature.js`) |
| `MCP_URL`, `MCP_HEALTH_URL`, `MCP_BEARER_TOKEN` | Optional | derived from `MCP_HEALTH_URL`; empty | Yes | `config.js`, `error-codes-admin.js` |
| `S4R_PRODUCT_BASE_URL` | Optional | the S4R CloudFront (see below) | Yes | `config.js` |
| `ORCH_TIMEOUT_MS` | Optional | 120000 | No | `config.js` |
| `ENGINE_SIGNING_TOKEN` | Required for feedback (ADR 0017) | none (feedback is sent unsigned, and the engine refuses it with 401) | Yes: a dynamic reference to `applianceclinic/production/engine-signing` | `engine-signature.js` |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `AC_ADMIN_GROUP` | Required for sign-in (empty refuses every session) | empty, empty, `admin` | Yes | `config.js` |
| `LEARNING_BUCKET` | Optional | `whichpart-learning-800960611664` | Yes | `config.js` |
| `WHICHPART_WEB_BUCKET` | Optional | `whichpart-web-800960611664` | Yes | `admin/content.js`, `recalls/ingest.js` |
| `ACQ_JUDGE_MODEL` | Optional | `gpt-5.6-terra` in `config.js`; empty in `settings-admin.js` | Yes | test area, settings |
| `AI_CONFIG_SECRET_ID`, `OPENAI_SECRET_ID`, `JEV_SECRET_ID`, `STAGE` | Optional | as the engine | Yes (not `STAGE`) | `ai-config.js` |
| `CANONICAL_MODE`, `CANONICAL_CONTROL_JOURNEYS` | Optional | `off`, none | Yes (`control`, the allow list) | `conversation-state.js` |
| `CANONICAL_TOKEN_SECRET_ID`, `CANONICAL_TOKEN_PREVIOUS_SECRET_ID` | Optional | `spares4repairs/${STAGE}/applianceclinic-canonical-state-token` | Yes: `applianceclinic/production/canonical-state-token` | `state-token.js` |
| `CANONICAL_TOKEN_SECRET`, `CANONICAL_TOKEN_SECRET_PREVIOUS` | Optional | none | No (tests and local runs only) | `state-token.js` |
| `RATE_LIMIT_MODE`, `RATE_LIMIT_TABLE` | Optional | `off`, `applianceclinic-rate-limits` | Yes (`enforce`) | `rate-limit.js`, `rate-limiting.js` |
| `TRANSCRIPT_TABLE`, `TRANSCRIPT_GSI`, `TRANSCRIPT_RETENTION_DAYS`, `TRANSCRIPT_INACTIVE_MINUTES` | Optional | `whichpart-transcripts`, `gsi_activity`, 90, 120 | Yes (not the GSI) | `transcripts.js`, `conversation-state.js` |
| `TRANSCRIPT_REVIEW_ENABLED`, `TRANSCRIPT_REVIEW_PROVIDER`, `TRANSCRIPT_REVIEW_MODEL`, `TRANSCRIPT_REVIEW_URL`, `TRANSCRIPT_REVIEW_MAX_PER_RUN`, `TRANSCRIPT_REVIEW_JEV_TIMEOUT_MS` | Optional | on, none, none, none, 3, 20000 | Yes (not the URL and the Jev timeout) | `transcript-review/` |
| `RECALL_TABLE`, `RECALL_GSI`, `RECALL_FETCH_CONCURRENCY`, `RECALL_MAX_UNLIST` | Optional | `whichpart-recalls`, `gsi_activity`, 6, 3 | Yes (`RECALL_TABLE`) | `recalls/` |
| `BENCHMARK_SERVICE_SECRET_ID` | Optional | `spares4repairs/${STAGE}/applianceclinic-benchmark-service` (S4R-named, see below) | No | `benchmark-auth.js` |
| `BENCHMARK_SERVICE_SECRET`, `BENCHMARK_SERVICE_SECRET_PREVIOUS` | Optional | none | No (tests only) | `benchmark-auth.js` |
| `BENCHMARK_STAGING_URL` | Optional | none (staging runs refused) | No | `benchmark/target.js` |
| `LM_STUDIO_URL`, `OPENAI_BASE_URL` | Optional | none; `https://api.openai.com/v1` | `LM_STUDIO_URL` | settings, transcript review |
| `MEDIA_OVERLAY_LIVE` | Optional | off (outside Lambda) | No | `admin/content.js` |
| `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_LAMBDA_FUNCTION_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Lambda | `eu-west-1` | Lambda sets them | SigV4 clients (`ddb.js`, `recalls/s3.js`, `engine-signature.js`) |

## Orchestrator (`spares4repairs-diag-orchestrator`)

| Variable | Required | Default | Set |
|---|---|---|---|
| `DIAGNOSIS_ENGINE_URL` (the `applianceclinic-diagnosis-engine` IAM Function URL; was `RAG_URL`), `MCP_URL`, `MCP_BEARER_TOKEN` | Required (`KeyError` at first use) | none | Yes |
| `ORCH_BEARER_TOKEN` | Required for any request (absent refuses all) | none | Yes |
| `ENGINE_SIGNING_TOKEN` | Required: without it requests are unsigned and the engine refuses every one (401) | none | Yes: a dynamic reference to `applianceclinic/production/engine-signing` |
| `AWS_REGION`, `AWS_DEFAULT_REGION`, role credentials | Lambda: used to SigV4-sign every engine call | `eu-west-1` | Lambda sets them |

## Error-code MCP (`spares4repairs-error-code-mcp`)

| Variable | Required | Default | Set |
|---|---|---|---|
| `MCP_BEARER_TOKEN` | Required for any request | none | Yes |
| `MCP_ALLOWED_HOSTS` | Optional | `*` | No |
| `LEARNING_BUCKET`, `ERROR_CODE_OVERLAY_KEY`, `ERROR_CODE_OVERLAY_TTL_MS`, `ERROR_CODE_LAST_GOOD` | Optional | empty (overlay off), `error-code-admin/state.json`, 10000, `/tmp/error-code-overlay-last-good.json` | `LEARNING_BUCKET` |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | Lambda | `eu-west-1` | Lambda sets them |

## Defaults that point at production or S4R

Production sets each of these explicitly, so its behaviour does not depend on a default. They are listed because a
missing variable would still not fail.

| Default | Where | Risk if the variable is missing | Follow-up |
|---|---|---|---|
| S4R Parts Catalogue API `65vnizdmk4` (`PARTS_FOR_MODEL_API`) | engine | None: it is the intended value; the S4R Parts Catalogue is an external service AC calls as a client | Set explicitly when the catalogue dependency is next changed |
| Production orchestrator and engine URLs, and the S4R Shop URL | whichpart-api | A local or test run calls production | Make them required once local runs set them |
| `spares4repairs/${STAGE}/applianceclinic-*` secret ids, `STAGE=dev` | engine, whichpart-api | Reads the secrets under their historical names, which still exist | Remove the defaults when the old secrets are deleted (owner decision; Phase 7) |
| `spares4repairs/dev/applianceclinic-benchmark-service` | whichpart-api | The benchmark HMAC secret is still read under its S4R name | Move it to `applianceclinic/production/benchmark-service` (owner follow-up) |
| `whichpart-learning-800960611664`, `whichpart-web-800960611664` | whichpart-api | A local run writes production buckets | Make them required once local runs set them |

Changing any of these is a runtime release, so it is not made just for tidiness.

## Historical names that are kept

| Name | Why it is kept |
|---|---|
| Secrets `spares4repairs/dev/applianceclinic-*` (where still present) | Historical physical names from before the separation. The AC runtimes read `applianceclinic/production/*`; the old names are still named by code defaults and by the state token's previous-key slot, and the old shared engine depends on its configuration. Deleting them is an owner decision |
| Lambda functions `spares4repairs-diag-orchestrator`, `spares4repairs-error-code-mcp` | Renaming a Lambda function means replacing it, with a new URL and new permissions. The names carry no access |
| ECR repositories of the same names | They hold those functions' images; renaming means replacing them |
