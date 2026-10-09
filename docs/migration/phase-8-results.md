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
