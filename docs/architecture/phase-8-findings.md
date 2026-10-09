# Phase 8 architecture findings (2026-10-09)

A review of `main` at `d266240`, before any Phase 8 change. It drives the Phase 8 cleanup (issue #61). The
current-state description lives in [overview.md](overview.md); this file records what was found and what was decided.

## 1. Runtime components

| Component | Code | Deployed as | Role |
|---|---|---|---|
| **BFF** | `services/whichpart-api` (index.js 3,117 lines + ~40 modules) | Lambda zip `whichpart-api`, Function URL behind the AC CloudFront `/api*` | Customer chat turns, AC sign-in, admin (settings, knowledge, media, error codes, recalls, transcripts, test area), scheduled jobs (recall ingest, transcript review), canonical session state |
| **Orchestrator** | `orchestration/` (Python; orchestrator.py 2,198 lines) | Lambda image `spares4repairs-diag-orchestrator` | Deterministic turn control: scope, routing, canonical control, legacy flows, safety, identity. No LLM |
| **Error-code MCP** | `error-codes/mcp` (Python) | Lambda image `spares4repairs-error-code-mcp` | Error-code resolution tools (MCP over HTTP) and the error-code admin catalogue |
| **Diagnosis engine** | `services/part-finder` (part-finder-lambda.js 8,037 lines + canonical/ ~70 files) | Lambda zip `spares4repairs-part-finder`, public Function URL (`RESPONSE_STREAM`) | UNDERSTAND (Jev), retrieval, the deterministic decision pipeline, COMPOSE, NDJSON stream. **Also serves the S4R `/part-finder` page** |

**A customer turn on the AC site:**
- browser → CloudFront `/api` → `whichpart-api`
- `whichpart-api` → orchestrator (bearer). The canonical cs/1 block travels with the request.
- the orchestrator calls part-finder twice through its Function URL: first `mode: understand` (Jev), then diagnose with
  the typed understanding injected
- the orchestrator calls the MCP (bearer) on error-code routes
- `whichpart-api` maps the result to the WhichPart view, persists the transcript and canonical state, and returns

**An S4R `/part-finder` turn:** the S4R page calls the part-finder Function URL directly with `{messages}`. Part-finder
runs Jev UNDERSTAND in process and the full legacy pipeline, and streams NDJSON.

## 2. Responsibilities and duplication

**Duplicated responsibilities:**
- **Evidence scoring.** `scoreNodeEvidence` and `factConflict` exist twice: in part-finder-lambda.js and as an
  explicit, equivalence-tested copy in `canonical/evidence-engine.js`.
- **Two Jev question sets per orchestrated turn** when canonical is on: the legacy `jev-understand.js` and the
  canonical `mc1-questions.js`.
- **`USER_INTENTS`** is defined identically in part-finder-lambda.js and jev-understand.js.
- **Identity locking** overlaps between the lambda (`resolveEstablishedFamily`, `lockApplianceType`) and identity.js.
- **In whichpart-api:**
  - three hand-written S3 adapters (acq, media, knowledge)
  - two identical JSON body readers (`readJson`, `acqBody`)
  - `MCP_*`, `LM_STUDIO_URL`, `OPENAI_BASE_URL` and `AWS_REGION` read in several modules
  - `ACQ_JUDGE_MODEL` defaults that conflict (`gpt-5.6-terra` vs `''`)
- **`fit-evidence.js`** exists in both services. The part-finder copy is used only by a test; the whichpart-api copy
  is shipped but never required.

## 3. Legacy versus canonical

| Path | Reached by | Status |
|---|---|---|
| **Part-finder legacy pipeline** (lambda handler 2299-3569: decision chain, COMPOSE, post-processing) | **Every S4R `/part-finder` request** (body `{messages}`), and orchestrated turns not under canonical control | **Still required.** It *is* the S4R contract's implementation |
| Part-finder canonical control (`canonical-runtime.respond`, `canonical/*`) | Only orchestrated turns whose cs/1 block grants control (BFF `CANONICAL_MODE=control`, an allow-listed journey) | Live for AC, unreachable from S4R |
| Orchestrator legacy flows (`_flow_error_code`, `_flow_symptoms`, `_flow_combined`, `_flow_clarify`) | AC turns not under canonical control | Still required for AC |
| Part-finder in-process generative UNDERSTAND (`UNDERSTAND_SYSTEM`, `INTENT_SCHEMA`, LM-Studio UNDERSTAND settings) | Nothing: Jev replaced it | **Dead** |

**Decision: the legacy diagnosis pipeline is not retired in Phase 8.**
- S4R uses it for every request, and the canonical engine covers only allow-listed journeys and is never reached by
  S4R.
- Retiring it would change `/part-finder` behaviour, which is POTENTIALLY IMPACTS S4R and cannot be proven safe.
- It is packaged as a decision ([ADR 0012](../adr/0012-legacy-diagnosis-pipeline-retained.md)).
- Proven-dead code inside it is removed.

## 4. Large modules and hidden coupling

- **`part-finder-lambda.js` (8,037 lines)** has eleven cohesive regions:
  - conversation progression
  - codes
  - config and providers
  - handler
  - UNDERSTAND
  - safety and normal behaviour
  - presentation
  - COMPOSE prompt building
  - catalogue
  - evidence
  - parts client
  - learning trace

  Cycles run progression ↔ evidence ↔ catalogue and progression ↔ safety/presentation, through a few shared text and
  catalogue helpers. 78 test files reach into `exports._internal` (about 190 names). Leaf modules come out first, so
  no new cycle appears.
- **`whichpart-api/index.js` (3,117 lines):**
  - The router is a 520-line `endsWith` chain.
  - About 640 lines of test-area (benchmark/library) logic live in index.js.
  - Error codes, recalls and transcripts are thin wrappers that could move out.
  - The media and knowledge handlers share an overlay cache with the customer path.
- **`orchestrator.py` (2,198 lines)** splits naturally into taxonomy, state loading, canonical, flows, safety and
  composers. Fake services (about 320 lines) sit in the production `services.py`.

**Hidden coupling:**
- The orchestrator reads `services/part-finder/canonical/journeys.json`.
- `whichpart-api/conversation-state.js` loads part-finder's `canonical/merge.js`.
- The BFF's `CANONICAL_MODE` decides canonical behaviour inside part-finder, through the cs/1 block.
- `benchmark/gold-v2/judge.js` requires `../../../part-finder/jev-client.js`, so it cannot run inside the Lambda.

## 5. Brittle interfaces and risks

- **Unverified fields on the public part-finder URL.** It accepts `body.understand`, `body.canonical` and `body.seed`
  from any caller.
  - A forged `understand` bypasses Jev's typing. `reviveInjectedIntent` copies `_`-prefixed keys verbatim.
  - A forged `canonical` result is shape-checked only.
  - The fix is to accept those fields only from an authenticated orchestrator (a shared secret header). That needs an
    orchestrator image release and a contract decision. It is **packaged, not done** (§9).
- **Normal-looking fallbacks in whichpart-api:**
  - in-memory transcript and recall stores if store initialisation fails
  - empty overlays, and 200 with a failure snapshot in diagnostics
  - Cognito errors treated as "signed out"
  - The customer-facing ones were fixed by #21. The admin ones are listed in §8.
- **Inconsistent error shapes:** `{error}`, `{error, code}`, `{error, message}`, `{ok:false, error:<code>}`, and a
  nested `extra`.
- **Defaults that point at production:**
  - orchestrator and engine URLs, S4R CloudFront, bucket names
  - `STAGE` defaults to `dev`, so the benchmark-service secret is still read under its S4R name
    `spares4repairs/dev/applianceclinic-benchmark-service`
- **Missing document.** `canonical-architecture.md` is cited by five modules but is not in the repository.

## 6. Dead code (proven)

**part-finder-lambda.js:**
- `UNDERSTAND_SYSTEM` (88 lines), plus `FAULT_TAXONOMY` and `buildFaultTaxonomy`, used only by it
- `formatKnowledge`, `parseJsonObject`, `stripImages`, `respond`
- `USE_JSON_SCHEMA`, `LM_UNDERSTAND_TEMPERATURE`, `LM_UNDERSTAND_MAX_TOKENS`

Each has one reference, its own definition, or is used only by other dead code. `INTENT_SCHEMA` and `FAULT_IDS` are
used only by tests.

**whichpart-api:**
- `fit-evidence.js` (shipped, never required)
- `recalls/write-static.cjs` (zero references)
- `benchmark/acq-simulator.js` (shipped, test-only)

Excluded test suites and retired suites stay excluded.

## 7. Missing tests

- **Part-finder:**
  - diagnose mode at handler level, and the S4R `{messages}`-only NDJSON framing
  - 413/400/503 handling, scope refusal, the feedback endpoint
  - `redactPII`, `logLearningTrace`, the parts client
  - the full legacy chain end to end
- **whichpart-api:**
  - `/auth/logout`, `/admin/transcripts/stats`, `/admin/transcripts/policy`
  - the live-test and HMAC benchmark branches of the customer path
  - the diagnose rate limit
- **Orchestration:** `test_clarification_intent.py` still expects a removed `PENDING_SLOTS`. It is a known failure.

## 8. Where TypeScript adds value

None exists. Neither Lambda zip has a build step, and CI requires each zip to equal the deployed artefact. Adopting
`.ts` sources would add a compile step to two production artefacts for little gain.

**Phase 8 instead adds:**
- **Declaration files** (`types/`) for the contracts that cross boundaries:
  - the `/part-finder` NDJSON frames
  - the cs/1 canonical transport and `NextAction`
  - the WhichPart customer view
  - the prompt registry entry
  - the configuration objects
- **`tsc --noEmit` with `checkJs`** in CI, over a chosen set of modules annotated with JSDoc.

It is type checking without changing what ships.

## 9. What not to change in Phase 8

- **The legacy diagnosis pipeline's behaviour**, and anything else that alters `/part-finder` output (ADR 0012).
- **Authentication of the part-finder Function URL's private fields (§5).**
  - It needs an orchestrator release and a decision on the S4R caller. It is packaged for later.
  - The orchestrator and MCP images also have a heavier release path (QEMU arm64 builds, ECR, reference digests), so
    their internal splits (§4) are documented, not done.
- **Prompt content.** Prompts are moved and versioned unchanged. A content change is a separate, evaluated change.
- **Production values.** Configuration modules preserve them.
- **The S4R role, Cognito, API `65vnizdmk4`, CloudFront, Route 53, ACM, `SparesSite-dev`, `CDKToolkit`.**
- **Migration history.** The phase records stay. Phase 9 retires migration-only detail.
