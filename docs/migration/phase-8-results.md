# Phase 8 results

What Phase 8 (architecture cleanup; issue #61) did. The review that drove it is
[phase-8-findings.md](../architecture/phase-8-findings.md); the current architecture is
[overview.md](../architecture/overview.md).

Every production change was a reviewed CDK change set ([`change.sh`](../../infra/production/steps/change.sh), spec in
[`infra/production/changes/`](../../infra/production/changes/)), run as the IAM user in account `800960611664`,
eu-west-1. Raw outputs are in `.migration-output/phase8/`.

## Baseline (before any change)

| Check | Result |
|---|---|
| S4R health (×3) | page 200, page 200, catalogue-search 200 |
| `/part-finder` contract | ok |
| `/ai/chat` ingress | ok (retired shape) |
| Smoke (4 journeys) | equal to the pre-Phase-5 baseline; all 200 |
| Transcript review, last 14 days | good 190, mixed 29, insufficient evidence 47, poor 1 |
| Runtime tests | part-finder 102 of 115 pass, 13 known failures; `tools/migration` 719 |

## 8.1: the diagnosis engine split (2026-10-09, 01:08Z)

**Code.** `part-finder-lambda.js` went from 8,037 lines to 1,722. It keeps the streaming handler, the canonical-runtime
wiring and the `_internal` test surface.

The rest moved into 14 modules under `services/part-finder/engine/`. They form an acyclic graph, lowest layer first:

| Layer | Modules |
|---|---|
| Base | `config`, `conversation`, `catalogue` |
| Vocabulary and evidence | `intent-vocabulary`, `error-codes`, `evidence` |
| Decisions | `safety`, `presentation`, `progression` |
| Supporting | `media-concepts`, `parts-client`, `learning-log` |
| Model stages | `understand`, `compose` |

The split was generated from the file's top-level dependency graph. The graph had no cycle between statements; the
cycles were only between regions, through a few shared helpers. Those helpers moved down into `conversation` (text) and
`catalogue` (component terms).

Removed as proven dead (no reference in the runtime or tests):
- `UNDERSTAND_SYSTEM`, the in-process generative UNDERSTAND prompt, which Jev replaced
- `FAULT_TAXONOMY` and `buildFaultTaxonomy`, used only by that prompt
- `formatKnowledge`, `parseJsonObject`, `stripImages`, `respond`
- `USE_JSON_SCHEMA`, `LM_UNDERSTAND_TEMPERATURE`, `LM_UNDERSTAND_MAX_TOKENS`
- an unused `formatIdentityLock` import

The three environment variables are not set on the function.

**Equivalence.**
- Each of the 269 moved statements appears byte-for-byte in exactly one output file. The only rewrite is the relative
  path of two `require` calls (`../faults-catalogue.json`, `../retrieval`).
- `_internal` has the same 166 names, with identical function source and values.
- Every part-finder test produces the same output before and after, apart from timings: 102 pass, the same 13 known
  failures.
- Tests that check the engine's source text now read the whole engine (`test/engine-source.cjs`).
- `test/engine-structure.test.mjs` guards three things: no cycle, no engine module requiring the handler, and the
  `_internal` names. It failed on an injected cycle.
- The handler loads from the built zip.

**Release.**

| Item | Result |
|---|---|
| Artefact | `KAmytwKg5kTcVDPvfOvKvR0S8RBzRkCV37UceCMP7/w=`, staged at `phase8/` in the AC assets bucket. Previous: `SHj8697yf2eIxSF1+MYOVUWdBa7o1fdu6BSJg6MXheI=` |
| Change set | 1 Modify, `spares4repairspartfinder`, `Properties.Code` only. Update-mode check passed |
| Grant | `lambda:UpdateFunctionCode` on the diagnosis function; read of `phase8/*` in the assets bucket |
| CloudTrail | One write: `UpdateFunctionCode` on `spares4repairs-part-finder`. Nothing outside the spec's resources |
| Stack | `UPDATE_COMPLETE`. Drift `IN_SYNC` on every resource. No-op confirmed. Execution policy back to read-only (v42) |
| Before / after | S4R health 3× clean, `/part-finder` contract ok, ingress ok, smoke equal. Both before and after |
| Diagnosis role check | Role `ac-diagnosis-role`, update `Successful`, no AccessDenied, no learning-trace or overlay failure, turns logged with none `ok:false`, learning trace written. Two cold starts on the new code (init 341 ms) ran clean; they came before the check script's window, so its own cold-start line read "no" |
| Build reference | `build/reference/spares4repairs-part-finder.zip.json` updated; 142 files |

**Rollback.** Set `functions.spares4repairs-part-finder.code.s3Key` in `runtime-overrides.json` back to the `phase7/`
key, then run the same change.

## 8.2: the whichpart-api split (2026-10-09, 01:44Z)

**Code.** `index.js` went from 3,117 lines to 1,080. It keeps the Lambda handler, the router and the customer diagnosis
path. The rest moved, statement for statement, into modules that form an acyclic graph:

| Layer | Modules |
|---|---|
| Base | `config` (the environment read at cold start), `log`, `http-io` (responses, CORS, path, body and query parsing, the health probe) |
| Access | `rate-limiting`, `session` (AC sign-in, sessions, the admin check) |
| Stores | `s3`, `benchmark-state` (benchmark runs, routing override), `transcript-store` |
| Admin areas (`admin/`) | `content` (knowledge and media, which share the overlay cache), `recalls`, `transcripts`, `health`, `error-codes`, `diagnostics`, `test-area`, `settings` |

Two rules shaped the split:
- **Module-level state.** Every function that reads or writes a module-level `let` (stores, caches, test overrides)
  lives in the same module as it. Another module therefore never holds a stale copy.
- **No cycles.** Shared helpers moved to the lowest module that needs them.

Two other changes went in with the split:
- **Duplicate reader.** `acqBody` was identical to `readJson` and now uses it.
- **Dead files.**
  - Removed: `fit-evidence.js` (never required by the API; the engine has its own copy) and `recalls/write-static.cjs`
    (no reference). Both are recorded in `runtime-changes.json` under `removed`, with the reason.
  - No longer shipped: `benchmark/acq-simulator.js`. It is used only by a test, so the file stays.

**Equivalence.**
- Each of the 264 moved statements appears byte-for-byte in exactly one module. Relative `require` paths are resolved
  before comparing.
- The 30 module exports are unchanged.
- The API tests produce the same output before and after. The only differences are timings and the settings revision
  hash, which includes `updatedAt` and so differs on every run.
- Tests that check the API's source text read the whole API (`test/api-source.cjs`).

**New tests.** `test/admin-routes.test.mjs` (257 cases):
- pins the router's 91 routes, in order
- checks that every admin route refuses an anonymous caller (GET and POST) and a signed-in non-admin
- covers `/auth/logout`: both cookies cleared, no Cognito call without a session cookie
- covers `/admin/transcripts/stats`: stats with the policy; 503 when the store fails
- covers `/admin/transcripts/policy`

The behavioural cases pass against the original `index.js` too.

**Release.**

| Item | Result |
|---|---|
| Artefact | `rraoIvZQiggi29idg8bNEvv954Hu/XdWuaF6fkfhcPM=`, staged at `phase8/`. Previous: `5XbUXy5x7Mvz7lNRxZhwXlSc23uYgUiPTu7cC7PPB14=` |
| Change set | 1 Modify, `whichpartapi`, `Properties.Code` only. Update-mode check passed |
| Grant | `lambda:UpdateFunctionCode` on `whichpart-api`; read of `phase8/*` |
| CloudTrail | One write: `UpdateFunctionCode` on `whichpart-api`. Nothing outside the spec's resources |
| Stack | `UPDATE_COMPLETE`. Drift `IN_SYNC` on all 43 resources. No-op confirmed. Execution policy back to read-only (v42) |
| Before / after | S4R health 3× clean, `/part-finder` contract ok, ingress ok, smoke equal, AC endpoints 8 PASS, AC auth 13 PASS. Both before and after. No runtime error in the API logs after the release |
| Build reference | `build/reference/whichpart-api.zip.json` updated; 85 files |

**Rollback.** Set `functions.whichpart-api.code.s3Key` back to the `phase7/` key and run the same change. Published version `1` remains a further fallback.

## 8.3: prompts, contract types, configuration and errors (no runtime change)

- **Prompt registry.** [`prompts/registry.json`](../../prompts/registry.json) registers the ten prompts at v1,
  unchanged. Their fingerprints are checked in CI. The COMPOSE prompts fingerprint identically in the pre-split file.
- **Contract types.**
  - [`types/`](../../types/) declares the `/part-finder` frames, cs/1, the engine configuration and the prompt registry,
    and `tsc` checks the runtime against them under `strict`.
  - CI job `typecheck`.
  - [ADR 0013](../adr/0013-prompt-registry-and-contract-types.md).
- **Configuration.** [configuration.md](../architecture/configuration.md) documents every environment variable the four
  runtimes read, and a test keeps the page complete. Each JavaScript runtime's request-path settings are in one module
  (`engine/config.js`, `whichpart-api/config.js`). No production value changed.
- **Errors.** [error-handling.md](../architecture/error-handling.md) records each boundary's contract. The admin
  shapes differ by area and are pinned by tests rather than unified, because the admin UI depends on them.

## Final verification (2026-10-09, 02:05Z)

| Check | Result |
|---|---|
| Drift | `AcRuntimeStack`, `AcDataStack`, `AcAuthStack`, `ApplianceClinicToolkit`: `IN_SYNC` |
| S4R boundary (S4R role, API `65vnizdmk4` with routes, integrations and stages) | Identical to the Phase 7 final capture |
| CloudTrail, Phase 8 window | **eu-west-1 writes:** two `UpdateFunctionCode` (8.1, 8.2), change sets, stack policies and drift detection on AC stacks, and test users on the AC pool `eu-west-1_r4fXXEdxC` (created and deleted by `verify-ac-auth.sh`). **us-east-1:** `ac-cfn-execution` grant and restore only. Nothing on S4R, CloudFront, Route 53, ACM, `SparesSite-dev` or `CDKToolkit` |
| S4R health (×3) | page 200, page 200, catalogue-search 200 |
| `/part-finder` contract | ok |
| `/ai/chat` ingress | ok (retired shape) |
| Smoke | equal to the baseline; 4 × 200 |
| AC endpoints, AC auth | 8 PASS, 13 PASS |
| Diagnosis role check | all PASS: no AccessDenied, no `ok:false`, learning trace written |
| Live code | engine `KAmytwKg…`, whichpart-api `rraoIvZQ…`, both equal to `build/reference/` |
| After the releases (01:08Z to 02:05Z) | Invocations: engine 38, API 72, orchestrator 49. No runtime error, no `ok:false` turn. Cold starts on the new code ran clean |

## Evaluation

| Measure | Before | After |
|---|---|---|
| Runtime tests (JavaScript) | part-finder 102/115, 13 known failures; whichpart-api 40/41, 1 known | Identical output for every pre-existing test; new tests all pass (engine structure, routes, error contracts, prompts, types, configuration) |
| `tools/migration` tests | 719 | 756 (new manifest and removal checks) |
| `/part-finder` contract | ok | ok, before and after each release |
| Smoke (4 journeys) | equal to the baseline | equal, before and after each release |
| Transcript review judge | 14 days before: good 190, mixed 29, insufficient evidence 47, poor 1 | First conversation served by the Phase 8 code: **good** (useful outcome; see the follow-up below) |

### Post-release follow-up (2026-10-09, 05:20Z to 05:40Z)

**Transcript review judge on Phase 8 code.** The judge had not yet scored a post-release conversation: the one reviewed
at 02:40Z (overall good) was created at 00:25Z, before 8.1. So one ordinary customer conversation was held through the
public site's own request contract: the `app.js` payload with `observability`, the state token carried, then the
`end` event.

| Item | Result |
|---|---|
| Conversation | Session `45d866e7…`, dishwasher not draining, 3 customer turns 05:24:17Z to 05:24:33Z, ended by the client's `end` event. Customer path; no special route |
| Code that served it | `whichpart-api` `$LATEST` = `rraoIvZQ…` (deployed 01:44Z by 8.2). `spares4repairs-part-finder` `$LATEST` = `KAmytwKg…` (deployed 01:08Z by 8.1), 6 engine turns, none `ok:false`. Neither function changed after its Phase 8 release |
| Judge | Scheduled transcript review (no manual trigger), Jev `typesafe/jev`, prompt `s10-v1`, reviewed 05:25:04Z, one attempt |
| Verdict | **overall good**, outcome `useful_outcome`. Understanding, diagnostic reasoning, conversation quality and state progression good. Safety and parts handling appropriate, media useful, looping minor, no concerns. Summary: "The customer plausibly reached a useful outcome…" |

**GOLD v2 (`GOLD-v2.0`, 50 scenarios, judge Jev `gold-v2-rubric-v1`) is not yet run, and is blocked.**
- [`tools/gold-v2/run-live.mjs`](../../tools/gold-v2/run-live.mjs) runs the suite against production. It uses the
  repository's runner, judge and report unchanged, over the service-authenticated benchmark path of `POST /api`. That
  path writes no customer transcript and is not rate-limited.
- Both secrets (the benchmark HMAC key and the Jev judge credentials) are read from Secrets Manager into memory only.
- A one-scenario probe completed its conversation against production.
- The judge call to `api.cloudflare.com` was refused by this cloud environment's egress policy, so nothing was scored
  and no GOLD result exists for this run.
- **No prior GOLD v2 result is recorded** in this repository or in the benchmark run store (`acq/runs/` holds only ACQ
  runs). This run therefore becomes the reference, against the suite's own pass policy: mean ≥ 2.5/4, safety ≥ 3/4,
  no critical failure.

## Exit criteria

| Criterion | Status |
|---|---|
| Monoliths decomposed | **Done.** The engine went from 8,037 to 1,722 lines, plus 14 modules; whichpart-api from 3,117 to 1,080, plus 16 modules. Both graphs are acyclic. The orchestrator split is documented, not done (below) |
| Prompt versioning | **Done.** 10 prompts registered and versioned, with a CI guard |
| TypeScript introduced | **Done.** Strict contract declarations and conformance checks, with a CI job |
| Dead code removed | **Done.** Engine: the generative UNDERSTAND prompt and its settings, plus 4 helpers. API: 2 files, 1 test-only file no longer shipped, 1 duplicate function |
| Canonical and legacy documented | **Done.** [overview.md](../architecture/overview.md), [ADR 0012](../adr/0012-legacy-diagnosis-pipeline-retained.md) |
| Docs current | **Done.** Overview, configuration, error handling, findings, ADRs 0012 and 0013, the Phase 8 runbook, the prompts README |
| Tests clean | **Done.** Only the known baseline failures remain; retired suites stay retired |
| Evaluation within bands | Contract, smoke and test outputs unchanged. Transcript judge on Phase 8 code: good. **GOLD v2: pending.** It is blocked by the environment's egress policy (above); the exit criterion is fully met once it passes |
| `/part-finder` passes | **Done** |
| S4R health clean | **Done** |
| Stacks `IN_SYNC` | **Done** |
| No S4R resource changed | **Done** (boundary identical, CloudTrail) |

## Deferred, with reasons

| Item | Why it is not done here |
|---|---|
| Authenticate the orchestrator-only fields (`understand`, `canonical`, `seed`) on the public engine URL | Security finding. It needs an orchestrator image release and a decision on the S4R caller (findings §5) |
| Retire the legacy diagnosis pipeline | Every S4R request uses it. The conditions are in ADR 0012 |
| Split `orchestrator.py` and move the fake services out of `services.py` | The image release path (arm64 builds, ECR, reference digests) makes an internal refactor a heavier release. The split points are in findings §4 |
| Split the engine handler function (about 1,570 lines) and the API router chain | Both stay verbatim so request handling and route order cannot change. Splitting them is a behaviour-level refactor for a later phase |
| Remove defaults that point at production or S4R, and move the benchmark secret to the AC namespace | Runtime releases, partly tied to deleting the old S4R-named secrets, an owner decision ([configuration.md](../architecture/configuration.md)) |
| Unify admin error shapes | Needs a coordinated admin UI change; the UI source is not in this repository |
| Type more modules | Gradual, smallest first, when each is next changed (ADR 0013) |
| Phase 7 holds | A2 (concurrency quota) and C2 (the S4R route) remain on hold. Removing AC's inline policies from the S4R role is S4R clean-up |

Phase 9 has not been started.
