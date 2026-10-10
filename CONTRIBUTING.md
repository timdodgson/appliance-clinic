# Contributing

This repository holds a live production service. Most rules below exist so that a change can't reach production, or S4R, by accident. How `main` is protected and how work is organised is in [docs/repository/governance.md](docs/repository/governance.md).

## Repository layout

| Path | What it is | Ships to production? |
|---|---|---|
| `services/part-finder/` | Diagnosis engine (Node 20). `canonical/` is the deterministic journey engine; `engine/` the legacy pipeline modules | Yes, as a Lambda zip |
| `services/whichpart-api/` | Backend for the browser (Node 20): sessions, admin, transcripts, benchmarks | Yes, as a Lambda zip |
| `orchestration/` | Orchestrator (Python 3.12) | Yes, as a container image |
| `error-codes/` | Error-code MCP service (Python 3.12) and its generated data | Yes, as a container image |
| `prompts/` | Prompt registry and its guard | Indirectly: the prompts live in the runtime code |
| `types/` | Strict TypeScript contract declarations | No |
| `infra/cdk/` | CDK stacks (`AcAuthStack`, `AcDataStack`, `AcRuntimeStack`) | Through reviewed change sets only |
| `infra/production/` | Production change and verification scripts | Owner tooling, credentialed |
| `infra/sandbox/` | The Phase 4 sandbox rehearsal, kept as a record | No |
| `build/` | Reproducible builds, reference digests, the test runner and known-failure baseline | No |
| `tools/migration/` | Migration tooling: inventory, change-set checker, guards, baselines (has its own `package.json`) | No |
| `tools/gold-v2/` | Live GOLD v2 runner | Owner tooling, credentialed |
| `docs/` | Architecture, ADRs, evaluation, migration record, portfolio | No |

## Setup and everyday checks

You need Node 20 (`>=20 <23`), Python 3.12 and, for images only, Docker with arm64 emulation (QEMU).

```bash
npm ci && npm --prefix tools/migration ci
npm run setup:python      # .venv-orchestrator and .venv-error-code-mcp, with production package versions
npm run test:runtime      # every runtime test, compared with build/test/known-failures.json
npm run typecheck         # strict TypeScript over types/ and the runtime conformance checks
npm run lint              # ESLint (migration tooling)
npm run test:tooling      # migration tooling tests
npm run build:zips        # build both Lambda zips and compare them with build/reference/
```

- **No credentials needed.** None of these commands needs AWS or model credentials. The runtime runner replaces AWS variables with fake values and strips proxy variables, so a test cannot reach production.
- **Images.** Build them as CI does (`.github/workflows/build-images.yml`). Each rebuild must equal its `build/reference/*.image.json`.
- **The known-failure baseline is a contract.** A new failure fails CI. A baseline test that starts passing also fails CI until you remove it from `known-failures.json` in the same change.
- **Retired suites stay retired.** Do not re-enable tests the runner excludes. Do not use the legacy ACQ-100 benchmark for evaluation; it is labelled non-authoritative.

## Branches and pull requests

- **Branches.** Branch from `main`. Name branches by purpose (`docs/…`, `infra/…`, `chore/…`, or `phaseN/…` for migration work).
- **Every change is a pull request.** Merge with a merge commit; never force-push or rewrite `main`.
- **The template.** Fill in every section of the [PR template](.github/pull_request_template.md): why, scope, architecture impact, tests performed, AWS impact, S4R impact, rollback and known limitations.
- **S4R evidence.** A change touching the diagnosis engine's behaviour, URL, permissions or role must include the `/part-finder` contract result before and after.
- **CI must be green.** The checks are runtime-tests, typecheck, lambda-zips, images and migration-tooling. The CI jobs hold no production credentials and cannot deploy.
- **Decisions.** Record a significant decision as an [ADR](docs/adr/README.md). Never rewrite an accepted one; supersede it.

## Changing runtime code

A runtime change is not finished until the build record matches it:

1. **Register the change.** Record every added, changed or removed runtime file in `docs/migration/runtime-changes.json`.
   - **Entries.** Give each its path, role (`runtime` or `test`), units and the change id. A new test is run only once it is registered with role `test`.
   - **Hashes.** `node tools/migration/bin/runtime-changes.mjs` lists stale hashes; add `--write` to refresh them.
2. **Update the build reference.** After a production release, update the matching `build/reference/*.zip.json` or `*.image.json` in the same pull request. CI requires the built artefact to equal it.
3. **Record the release.** Production releases are recorded per change (`infra/production/changes/<id>.json`, plus the results docs).

## Prompts

Every prompt the runtime sends to a model or to Jev is registered in [`prompts/registry.json`](prompts/registry.json), and a test fails when a prompt's source changes without a new version. To change one, follow [prompts/README.md](prompts/README.md):
1. edit the prompt in its source file;
2. run `node prompts/fingerprint.mjs`;
3. bump the version and add a changelog entry;
4. evaluate the change before release.

Prompts used by S4R requests are S4R-facing: changing them changes `/part-finder` replies.

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
- **Never touch S4R.** Do not modify Spares4Repairs resources: its role, API, Cognito pool, distribution or stacks. The tools refuse every identifier on [`docs/migration/s4r-denylist.json`](docs/migration/s4r-denylist.json).

Do not run any of the following unless you are the owner, deliberately, with the runbook open:

| Command | Why |
|---|---|
| `infra/production/steps/*.sh`, `infra/production/*.sh` | Act on production AWS, or read it with owner credentials |
| `tools/gold-v2/run-live.mjs` | Holds real conversations with production and calls the Jev judge (needs Secrets Manager access) |
| `tools/migration` commands `backup`, `hotfix:admin`, `baseline --live`, `inventory`, `traffic`, `sandbox-image-copy` | Mutate or read production; each prints a plan and needs explicit flags |
| `infra/sandbox/steps/*.sh` | The Phase 4 rehearsal; it creates and destroys AWS resources |
| `**/deploy.sh` | The four retired pre-CDK deploy scripts. They now refuse to run; production is CloudFormation-managed |
