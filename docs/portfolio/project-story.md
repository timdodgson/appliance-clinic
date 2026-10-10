# Project story

Appliance Clinic (AC) was built inside another product's monorepo and AWS account. This is how it was moved into its own repository and infrastructure while it kept serving customers, and how its quality was then measured and fixed. It records decisions, trade-offs and evidence. The full step-by-step record is in [docs/migration/](../migration/PLAN.md).

## Starting point

AC grew up inside the Spares4Repairs (S4R) monorepo and AWS account. By the time it needed a home of its own, it had several entanglements:

| Area | Entanglement |
|---|---|
| Deployment | Four Lambda functions, deployed by hand-written CLI scripts with no stack |
| Data | DynamoDB tables and S3 buckets |
| Auth | Admin sign-in through the *S4R* Cognito pool |
| Secrets | Held under S4R names |
| IAM | The diagnosis Lambda ran with the S4R server role |
| Contract | The same Lambda still served a live S4R page (`/part-finder`), so its contract could not change |

The constraint that shaped every decision: **production behaviour, AC's and S4R's, had to stay stable throughout**. S4R resources were not to be modified at all.

## How it was done

### 1. Prove ownership before touching anything (Phase 0)

- A read-only inventory captured production as it was.
- Each resource was then assigned to AC or S4R, with evidence: creating script, CloudTrail `Create*` events, and consumers ([ownership.md](../migration/ownership.md)).
- Two things came out of it:
  - an **S4R denylist** of 79 identifiers, which every later tool refuses to touch;
  - a **behavioural baseline**: the `/part-finder` contract and four smoke journeys.

Each later change was compared against that baseline.

One security gap was found and closed straight away (Phase 1). The deployed backend treated any signed-in user with no Cognito groups as an AC admin, and the S4R pool has no groups, so every S4R shop user was an AC admin. That admin controls provider keys and paid batch runs. A one-function hotfix made admin a default-deny allowlist ([runbook](../migration/runbooks/phase-1-admin-hotfix.md)).

### 2. Extract the code without changing a byte (Phases 2 and 3)

- **Extraction.** The production code was imported unchanged, with a per-file SHA-256 manifest against the source commit, after a secret and PII scan.
- **Proof of the build.** The build was made reproducible before anything was changed: CI rebuilds both Lambda zips and both container images and compares them file by file with references taken from the deployed artefacts.
- **Recorded test baseline.** Known test failures were recorded, so CI fails on a *new* failure, not on history.

This made "the repository is what runs in production" a checked claim, not an assumption.

### 3. Rehearse the infrastructure takeover (Phase 4)

The plan was to *import* the existing resources into CloudFormation rather than recreate them, which avoids downtime and data copies ([ADR 0004](../adr/0004-import-existing-resources-into-cdk.md)). Import has sharp edges, so every import type was rehearsed first on sandbox copies, under a guard that refused any production or S4R identifier.

The rehearsal produced [27 recorded surprises](../migration/phase-4-results.md#surprises-and-what-they-became), each turned into a tool fix or a rule. Three mattered most:
- **Imports skip drift checks.** An import accepts a template whose properties differ from the live resource and still reports success. Only drift detection shows it, so drift became a gate.
- **Imports can't add a service role or tags.** The fix was to create each stack first as an empty shell.
- **A control that did not hold.** The rehearsal showed the "deny S4R" control did not actually hold for the execution role until a fourth policy revision.

### 4. Import production in small, gated steps (Phases 5 and 6)

- **Small steps.** Ten import steps, each with a checked change set and a read-only CloudFormation execution role. After each: drift detection, then a no-op re-deploy.
- **A stop worked as designed.** The first step **stopped**. After an import, CloudFormation runs the resource's *update* handler, which tried to delete a live ECR policy the template did not declare. The read-only role turned that into a clean rollback.
- **The gap behind it.** The sandbox had missed it because its role could write. A second rehearsal then mapped every resource type's post-import writes before the import continued ([phase-5-import-semantics.md](../migration/phase-5-import-semantics.md)).
- **Ownership proven by doing.** Phase 6 added and removed one harmless resource through CDK.

### 5. Harden security on AC's own terms (Phase 7)

| Area | Change |
|---|---|
| Auth | A dedicated Cognito pool for AC admins ([ADR 0006](../adr/0006-dedicated-cognito-for-appliance-clinic.md)) |
| Secrets | An AC secret namespace; service bearer tokens reach Lambdas through CloudFormation dynamic references, never as plain values |
| Abuse controls | Rate limiting, CORS allowlist and security headers on the public backend |
| IAM | Least-privilege roles; the diagnosis Lambda moved off the S4R role ([ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md), superseded) |
| Retirement | The old `/ai/chat` route was retired |

Every production change since has gone through one reviewed tool, [`change.sh`](../../infra/production/steps/change.sh):
1. synthesise, and check the template equals the deployed one apart from the named resources;
2. check the change set against the spec;
3. grant the execution role exactly the spec's writes, for that execution only;
4. after execution, check drift and confirm a no-op;
5. audit CloudTrail.

A finding that bounded the scope: the account's Lambda concurrency limit (10) is shared with S4R. AC cannot reserve capacity without affecting S4R, so throttling became a product concern (retry and explicit errors), not an infrastructure fix.

### 6. Clean up the architecture (Phase 8)

| Area | Before | After |
|---|---|---|
| Diagnosis engine | 8,037 lines | 1,722 lines plus 14 modules |
| `whichpart-api` backend | 3,117 lines | 1,080 lines plus 16 modules |
| Module graphs | | both acyclic, and request handling unchanged |
| Prompts | | registered and versioned with a CI guard ([ADR 0013](../adr/0013-prompt-registry-and-contract-types.md)) |
| Contract types | | strict TypeScript declarations for the S4R contract and the conversation state |

The legacy diagnosis pipeline was **kept** ([ADR 0012](../adr/0012-legacy-diagnosis-pipeline-retained.md)). Every S4R request depends on it, and retiring it would change S4R behaviour.

### 7. Let evaluation drive product fixes (Phase 8)

The first full run of the GOLD v2 benchmark scored 28/50: 50 whole conversations, judged by a fixed model on a 10-dimension rubric. Before acting on it, a [value audit](../evaluation/gold-v2-value-audit.md) classified each failure:
- **5 were test or judge defects.** Those scenarios were rewritten and one duplicate removed. The safety dimension was tightened to judge the advice actually given. No pass threshold changed.
- **17 were real.** They came from 9 product defects, the biggest being "evidence dropped and the question asked again".

The product was then fixed, not the test, over a series of reviewed releases:
- a noise heard while draining now counts as evidence about the pump;
- a vague customer gets one concrete question instead of a repeat;
- a symptom report is no longer mistaken for a completed check;
- a reply can't present an inferred fact as something the customer said.

Misses that kept repeating in scenarios that still passed narrowly were treated as defects too. The gate was **49/49 in two consecutive full runs** ([final gate](../evaluation/gold-v2-final-gate.md)). The 28/50 run is kept as the diagnostic run that started the work, not as a baseline.

During that work two bearer tokens appeared in an operator session's output, and both were rotated. The rotation exposed a CloudFormation subtlety: pinning a dynamic reference to the new version id changed nothing. CloudFormation re-resolved the old unversioned reference to the same new value, saw no difference and skipped the update. A non-secret version marker in each function's environment now forces the update on every rotation.

### 8. Make it readable (Phase 9)

- The dead legacy secrets were removed through the same reviewed process.
- The documentation and contributor guides were rewritten for an outside reader.
- The public tree and full history were scanned for secrets and PII.

## Trade-offs, honestly

| Decision | Bought | Cost |
|---|---|---|
| Import, don't recreate | No downtime, no data migration | Import semantics had to be learned the hard way, in a sandbox and with a read-only role |
| Language models only classify and word ([ADR 0010](../adr/0010-deterministic-policy-around-llm.md)) | Safety and part logic that can be unit-tested and doesn't change with the model | Each appliance journey is code (diagnostics, policy, copy), which is slower to add than a prompt |
| Keep the legacy pipeline for S4R | The S4R contract never changed | Two diagnosis paths stay in the engine |
| CloudFront left unmanaged ([ADR 0008](../adr/0008-cloudfront-initially-unmanaged.md)) | No risk to the shared distribution during the migration | One AC resource is still outside CDK |
| No automatic deployment | Every production change is reviewed, scoped and audited | Releases are manual and slower |
| Required approvals set to 0 | A single maintainer can merge through PRs and checks | No second reviewer; the PR record and CI are the review |

## Still open

- **Unauthenticated orchestrator-only fields.** The diagnosis engine's public URL still accepts fields meant only for the orchestrator. Closing that needs a coordinated change with the S4R caller ([findings §5](../architecture/phase-8-findings.md#5-brittle-interfaces-and-risks)).
- **The site.** The static site is still published from the original monorepo.
- **The orchestrator.** It is one large Python module; its split is documented but deferred.
