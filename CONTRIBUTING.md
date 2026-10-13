# Contributing

This repository holds a live production service. Most rules below exist so that a change can't reach production by accident. How `main` is protected and how work is organised is in [docs/repository/governance.md](docs/repository/governance.md).

## Repository layout

| Path | What it is | Ships to production? |
|---|---|---|
| `apps/web/` | Web front end: customer chat, admin, help pages, recall search (plain HTML/CSS/JS, no bundler; has its own `package.json`). See [apps/web/README.md](apps/web/README.md) | Yes, as static files in the AC web bucket (`apps/web/scripts/deploy.mjs`) |
| `services/diagnosis-engine/` | Diagnosis engine (Node, nodejs22.x). `ac2/` holds the turn pipeline of [ADR 0021](docs/adr/0021-understand-label-enrich-decide-reply.md) (understand, label, enrich, safety, decide, reply, final check); `engine/` the shared helpers (configuration, the S4R Parts Catalogue client); `knowledge/` the fault notes, the retired journeys as knowledge, normal-behaviour notes and media mappings | Yes, as the Lambda zip `applianceclinic-diagnosis-engine` |
| `services/whichpart-api/` | Backend for the browser (Node 20): sessions, the conversation record, transcripts with per-turn tags, recalls, admin | Yes, as a Lambda zip |
| `error-codes/` | Error-code MCP service (Python 3.12) and its generated data | Yes, as a container image |
| `prompts/` | Prompt registry and its guard | Indirectly: the prompts live in the runtime code |
| `types/` | Strict TypeScript contract declarations | No |
| `infra/cdk/` | CDK stacks (`AcAuthStack`, `AcDataStack`, `AcRuntimeStack`) | Through reviewed change sets only |
| `infra/production/` | Production change and verification scripts | Owner tooling, credentialed |
| `infra/sandbox/` | The Phase 4 sandbox rehearsal, kept as a record | No |
| `build/` | Reproducible builds, reference digests and the test runner | No |
| `tools/migration/` | Migration and production tooling: inventory, change-set checker, overrides drift check, guards (has its own `package.json`) | No |
| `evaluation/` | Frozen case sets (independent-100, heldout-25, real-journeys-13) and the benchmark harness | Owner tooling for live runs |
| `docs/` | Architecture, ADRs, evaluation, migration record, portfolio | No |

## Setup and everyday checks

You need Node 20 (`>=20 <23`), Python 3.12 and, for images only, Docker with arm64 emulation (QEMU).

```bash
npm ci && npm --prefix tools/migration ci
npm run setup:python      # the error-code service test environment, with production package versions
npm run test:runtime      # every runtime test; any failure fails
npm run typecheck         # strict TypeScript over types/ and the runtime conformance checks
npm run lint              # ESLint (migration tooling)
npm run test:tooling      # migration tooling tests
npm run build:zips        # build the applianceclinic-diagnosis-engine and whichpart-api zips and compare them with build/reference/
(cd apps/web && npm ci && npm run check)   # web front end: lint, typecheck, tests, reproducible build
```

- **No credentials needed.** None of these commands needs AWS or model credentials. The runtime runner replaces AWS variables with fake values and strips proxy variables, so a test cannot reach production.
- **Error-code service.** Build its zip as CI does (`.github/workflows/build-images.yml`: `fetch_error_code_mcp_site.sh`, then `package_zips.py --mcp-site`). It must equal `build/reference/applianceclinic-error-code-mcp.zip.json`.
- **Every runtime test passes.** There is no accepted-failure list, xfail or skip. A failing test is fixed in the product, rewritten to the current contract, or removed (recorded under `removed` in `docs/migration/runtime-changes.json` with its reason) in the same change.
- **One decision path** ([ADR 0021](docs/adr/0021-understand-label-enrich-decide-reply.md), [ADR 0018](docs/adr/0018-no-ac-legacy-fallback.md)). Every turn goes through the one pipeline or is an explicit error. Do not add a second diagnosis path, an unsigned engine request, a hard-coded reply or a silent fallback.
- **Retired suites stay retired.** Do not re-enable tests the runner excludes. Do not use the legacy ACQ-100 benchmark for evaluation; it is labelled non-authoritative.

## Branches and pull requests

- **Branches.** Branch from `main`. Name branches by purpose (`docs/…`, `infra/…`, `chore/…`, or `phaseN/…` for migration work).
- **Every change is a pull request.** Merge with a merge commit; never force-push or rewrite `main`.
- **The template.** Fill in every section of the [PR template](.github/pull_request_template.md): why, scope, architecture impact, tests performed, AWS impact, rollback and known limitations.
- **Evidence for a runtime change.** Include the results of the [AC checks](#ac-checks-for-a-runtime-change) below.
- **CI must be green.** The checks are runtime-tests, typecheck, lambda-zips, images and migration-tooling. The CI jobs hold no production credentials and cannot deploy.
- **Decisions.** Record a significant decision as an [ADR](docs/adr/README.md). Never rewrite an accepted one; supersede it.

## Changing runtime code

A runtime change is not finished until the build record matches it:

1. **Register the change.** Record every added, changed or removed runtime file in `docs/migration/runtime-changes.json`.
   - **Entries.** Give each its path, role (`runtime` or `test`), units and the change id. A new test is run only once it is registered with role `test`.
   - **Hashes.** `node tools/migration/bin/runtime-changes.mjs` lists stale hashes; add `--write` to refresh them.
2. **Update the build reference.** After a production release, update the matching `build/reference/*.zip.json` or `*.image.json` in the same pull request. CI requires the built artefact to equal it.
3. **Record the release.** Production releases are recorded per change (`infra/production/changes/<id>.json`, plus the results docs).

## AC checks for a runtime change

| Check | When | Pass |
|---|---|---|
| `npm run test:runtime` | Every pull request (CI) | Every test passes |
| `npm run typecheck` | Every pull request (CI) | Clean |
| `npm run test:tooling`, `npm run lint` | Every pull request (CI) | Every test passes; no lint errors |
| Build equivalence (`npm run build:zips`, image builds) | Every pull request (CI) | The `applianceclinic-diagnosis-engine` and `whichpart-api` zips, and each image, equal their `build/reference/` record |
| Live AC journeys | Before and after a production release (owner) | Hazard stop, intake, error code, code then symptom, a resolved journey and a declined unsafe request behave as documented |
| GOLD-v2.4 pair | After the final release of a phase (owner) | Exactly two runs, 20 minutes apart, on the deployed build. No exploratory GOLD: runs share production's Jev credit |

S4R contract, smoke, ingress and S4R health checks are retired from the AC change process ([ADR 0019](docs/adr/0019-dedicated-canonical-diagnosis-engine.md)).

## Prompts

Every prompt the runtime sends to a model or to Jev is registered in [`prompts/registry.json`](prompts/registry.json), and a test fails when a prompt's source changes without a new version. To change one, follow [prompts/README.md](prompts/README.md):
1. edit the prompt in its source file;
2. run `node prompts/fingerprint.mjs`;
3. bump the version and add a changelog entry;
4. evaluate the change before release.


## Evaluation expectations

- **Behaviour is judged semantically**, by the GOLD v2 suite and the transcript-review judge, never by regular expressions over model prose ([ADR 0009](docs/adr/0009-evaluation-strategy.md)).
- **A failing evaluation is fixed in the product, not by weakening the test.** A scenario may change only when an audit shows the test itself is wrong, and that change is recorded ([example](docs/evaluation/gold-v2-1-changes.md)).
- **Change the deterministic layer.** Changes to diagnosis behaviour go in the deterministic layer (merge, diagnostics, policy, compose checks), with unit tests, not in prompts alone ([ADR 0010](docs/adr/0010-deterministic-policy-around-llm.md)).

## Secret and PII scanning

Everything pushed here is public. Before you push:
- **Run gitleaks** over your changes. A known false positive is allowlisted in [`.gitleaks.toml`](.gitleaks.toml) only with a reason:
  ```bash
  gitleaks git --log-opts="origin/main..HEAD" --redact .   # your commits
  gitleaks dir --redact .                                   # the working tree
  ```
- **Check by hand for personal data:** customer names, emails, phone numbers, addresses, conversation transcripts.
- **Never commit what the tools capture.** The output of `tools/migration`, `infra/production` and GOLD runs (`.migration-output/`) is already ignored, and holds captured production data.

Account IDs, resource names and public Function URLs are not secrets on their own. Credentials, tokens, signed URLs, private keys and personal data always are. See [SECURITY.md](SECURITY.md).

## Production changes

- **Manual and reviewed only.** Production is never deployed by CI or by a casual command. Every change is a spec in `infra/production/changes/`, run by the owner through [`infra/production/steps/change.sh`](infra/production/steps/change.sh):
  - template equality;
  - a checked change set;
  - a temporary least-privilege execution grant;
  - drift and no-op checks;
  - a CloudTrail audit.
- **Never touch S4R.** Spares4Repairs is an external service. Do not modify its resources: its role, API, Cognito pool, distribution or stacks, or the old shared engine `spares4repairs-part-finder` that it still uses. The tools refuse every identifier on [`docs/migration/s4r-denylist.json`](docs/migration/s4r-denylist.json).

Do not run any of the following unless you are the owner, deliberately, with the runbook open:

| Command | Why |
|---|---|
| `infra/production/steps/*.sh`, `infra/production/*.sh` | Act on production AWS, or read it with owner credentials |
| `evaluation/rebuild/run.mjs`, `judge.mjs` | Hold conversations with the live service through the benchmark envelope and call the judges (needs Secrets Manager access) |
| `tools/migration` commands `backup`, `hotfix:admin`, `inventory`, and `bin/sandbox-image-copy.mjs` | Mutate or read production; each prints a plan and needs explicit flags |
| `infra/sandbox/steps/*.sh` | The Phase 4 rehearsal; it creates and destroys AWS resources |
| `error-codes/mcp/deploy/deploy.sh` | The last retired pre-CDK deploy script. It refuses to run; production is CloudFormation-managed. The others were deleted in Phase 15 |
