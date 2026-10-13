# Project story

Appliance Clinic (AC) was built inside another product's monorepo and AWS account. This is how it was moved into its own repository and infrastructure while it kept serving customers, and how its quality was then measured and fixed — including the point where every test was green and the real conversations were still not good enough. It records decisions, trade-offs and evidence. The full step-by-step record is in [docs/migration/](../migration/PLAN.md).

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
- **Recorded test baseline.** Known test failures were recorded, so CI fails on a *new* failure, not on history. (Phase 13 retired it: every former failure became a product fix, a rewrite or a removal, and any failure now fails CI.)

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

A finding that bounded the scope: the account's Lambda concurrency limit (10) is shared with S4R. AC cannot reserve capacity without affecting S4R, so throttling became a product concern (retry and explicit errors), not an infrastructure fix. Phase 11 measured it: the pool sat at 10 for 383 minutes in 14 days. The recommendation is an account quota of 100, which needs the account owner ([analysis](../evaluation/phase-11-concurrency.md)).

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

During the Phase 8 work (change 8.10) two bearer tokens appeared in an operator session's output, and both were rotated. The rotation exposed a CloudFormation subtlety: pinning a dynamic reference to the new version id changed nothing. CloudFormation re-resolved the old unversioned reference to the same new value, saw no difference and skipped the update. A non-secret version marker in each function's environment now forces the update on every rotation.

### 8. Make it readable (Phase 9)

- The dead legacy secrets were removed through the same reviewed process.
- The documentation and contributor guides were rewritten for an outside reader.
- The public tree and full history were scanned for secrets and PII.

### 9. Green tests, poor conversations (Phases 10 and 11)

This is the part of the project that mattered most.

**The tests were green; the conversations were not.** After Phase 8, GOLD-v2.2 passed 49/49 in four consecutive runs, and the runtime suites matched their baseline. Yet chatting with the service by hand still produced poor conversations. Phase 10 set the pass counts aside and asked two questions: does the system work the way the documents say, and is the customer experience actually good? ([Phase 10 results](../evaluation/phase-10-results.md))

**Real transcripts were the evidence.** A privacy-safe review of production conversations recorded 15 findings ([F1–F15](../evaluation/phase-10-transcript-findings.md)). Three of the worst:
- a model instruction was leaking into customer replies;
- a bare error code was read as a weak model-number guess and committed;
- the service asked the same fixed question twice.

**The architecture audit explained why.** Each finding was traced hop by hop through the code and the live configuration ([as-built](../architecture/as-built.md)). The defects came from the seams:
- One turn carried seven representations of conversation state, including a per-container store in the orchestrator that a cold start lost.
- "Ask for the model" was decided in five places, and safety copy had five implementations.

**The benchmark had blind spots.** An audit asked whether GOLD would have caught the real failures ([GOLD audit](../evaluation/phase-10-gold-audit.md)):
- It had passed the instruction leak in every affected scenario, because the rubric never asked about reply fidelity.
- It had no error-code scenario at all.

**Real failures became regressions, and the product was fixed at the root.**
- GOLD grew from that evidence: error-code and either/or scenarios, plus two rubric-wide fidelity checks. No scenario was removed or weakened. The first v2.3 run fell to 48/55. Twelve root-layer releases later it was 55/55 twice.
- A [target architecture](../architecture/target.md) and four ADRs fixed the seams themselves. Phase 11 delivered the two largest ([results](../evaluation/phase-11-results.md)):
  - **One conversation state.** The orchestrator's store was deleted; every turn is now built from the request and the `cs/1` block. Two instances given the same request decide identically, and a failed turn advances nothing ([ADR 0014](../adr/0014-cs1-is-the-only-conversation-state.md)).
  - **Signed internal fields on a public endpoint.** The engine's Function URL must stay public for S4R, yet it accepted fields meant only for the orchestrator. Signing was rolled out in stages: log-only first, then proof from logs that S4R never sends those fields, then enforcement, then removal of the compatibility code ([ADR 0017](../adr/0017-authenticate-orchestrator-only-engine-fields.md)).
  - **The last instruction leak, on the S4R path.** Fixed live without changing the `/part-finder` contract: 3/3 turns leaked before, 0/6 after.
  - **One owner for an uncertain token.** A token that might be a code or a model number now has one commit rule. A weak reading is held and the customer is asked once.

**The final gate was not re-run until it passed.** On the way to the Phase 11 gate, five runs came back 55/56. Each failure was read, traced to a product defect and fixed with a regression test, and the pair of runs was restarted on the new build ([every run](../evaluation/phase-11-results.md#gold)). The defects:
- a question asked twice in one reply;
- a check the customer had done being dropped and asked again;
- "I can't get to the model" treated as refusing a different question;
- three category labels that claimed more than the customer said.

The final build passed **56/56 twice in a row** on GOLD-v2.4.

**GOLD is not the only judge.** Six live journeys through the public site were ended so that the production transcript judge reviewed them. Both the judge's verdict and the conversation were read, and a three-turn journey the judge rated `insufficient_evidence` was accepted only after reading it. Production transcript review stays a separate check from the benchmark.

### 10. No hidden fallback, no accepted failures (Phase 13)

The Phase 12 suite still carried 15 accepted failures, and fixing some of them meant extending the legacy pipeline that
quietly answered any AC turn the canonical path could not. An audit showed that every canonical degradation fell back to
legacy and looked like a normal answer. [ADR 0018](../adr/0018-no-ac-legacy-fallback.md) closed that: legacy now serves
only S4R, every degradation is an explicit error, and turns no journey owns get an explicit outcome. Every former failure
became a product fix, a rewrite or a removal, and the accepted-failure list was deleted
([results](../evaluation/phase-13-results.md)).

### 11. A dedicated canonical engine (Phase 15)

After Phase 13 no AC turn reached the legacy pipeline, yet AC still shipped it. The canonical runtime lived in the same
Lambda that S4R's page called anonymously, so the URL stayed public, the legacy code went out in every AC release, and
every AC release carried S4R gates. [ADR 0019](../adr/0019-dedicated-canonical-diagnosis-engine.md) gave AC its own
engine instead of changing the shared one:

| | Before | After |
|---|---|---|
| Lambda | `spares4repairs-part-finder`, shared | `applianceclinic-diagnosis-engine`, AC only (`services/diagnosis-engine/`) |
| Function URL | Auth `NONE`, CORS `*`, response streaming | `AWS_IAM`, buffered, no CORS; only the orchestrator and BFF roles may invoke it |
| Request authentication | HMAC for internal fields; plain `{messages}` served unsigned | SigV4 on every request and HMAC on every POST; anything unsigned is a 401 |
| Code | Canonical runtime plus the legacy pipeline, retrieval and legacy COMPOSE | Canonical runtime only; engine test files 137 → 90 |
| Observability | Shared log group | Own role, log group, metric filters and alarms |
| AC release gates | S4R contract, ingress, smoke and health | AC checks only |

The old engine was **not modified**. It keeps serving S4R, which is now an external consumer, and AC sends it no
traffic. AC released it from its CloudFormation stack with zero physical change (change 15.3). The final build passed
GOLD-v2.4 56/56 twice, and all 163 runtime test files pass ([results](../evaluation/phase-15-results.md)).

### 12. Green tests, losing benchmark (Phase 16)

GOLD passed 56/56 on every release. An independent, blind benchmark of 100 sourced cases, run against a general-purpose
assistant with the same simulated customers, found the opposite: **the general assistant won 94–6**
([report](../evaluation/independent-100-case-benchmark.md)). The root-cause analysis put most losses on the architecture
itself: the fixed check order ignored evidence and direct questions, missing journeys looped, the closed vocabulary lost
nuance, and fixed copy asserted things the customer never said. GOLD had been written alongside the journeys, so it
measured the design against itself. GOLD was redefined as deterministic regression; quality is now measured on
independent cases only.

### 13. The first rebuild (Phase 20)

[ADR 0020](../adr/0020-llm-led-diagnosis-with-deterministic-guardrails.md) gave one Qwen call the whole turn inside a heavy
guardrail kernel (evidence ledger, claim verifier, safety, part gate). On the same cases and a held-out set frozen before
tuning it beat the journeys 83–17 but lost 17–83 to the general assistant ([results](../evaluation/llm-led-rebuild.md)).
The lesson: one big call, a long rulebook and a form to fill in before the reply is the worst set-up for a mid-sized
model, and a checker that cuts sentences out makes replies worse.

### 14. Small jobs, a fixed record, code decides (Phase 21)

The design was then worked out with the owner step by step ([ADR 0021](../adr/0021-understand-label-enrich-decide-reply.md)):
Qwen reads each message; Jev labels it with a confidence per label from the customer's own words; tools enrich the record
(RAG, error codes, recalls, parts); code decides what the reply must do (broad help first, then model and part once the
owner's checks fail; never ask for what is known; build on what was already said); Qwen writes the reply; a final check and
Jev's media pick close the turn. The journey controller and the orchestrator hop were deleted in the same release, with
git as the rollback. Live smoke chats found three reply-quality issues (reassurance after a burning smell, an invented
symptom, a repeated reply); each was fixed in the plan and the record, not with hard-coded replies, and re-tested live.
Results on the independent 100, the held-out set and a new real-journey add-on set are in the
[evaluation index](../evaluation/README.md).

## Trade-offs, honestly

| Decision | Bought | Cost |
|---|---|---|
| Import, don't recreate | No downtime, no data migration | Import semantics had to be learned the hard way, in a sandbox and with a read-only role |
| Language models only classify and word ([ADR 0010](../adr/0010-deterministic-policy-around-llm.md), Phases 8–15) | Safety and part logic that could be unit-tested | Lost 94–6 to a general assistant; replaced in Phase 21 |
| Small model jobs with a fixed record ([ADR 0021](../adr/0021-understand-label-enrich-decide-reply.md)) | Qwen reasons and writes freely; Jev's labels give every fact a shape and a confidence; code still owns safety, the plan and parts | Every turn depends on two providers (Qwen and Jev); no fallback by design |
| Keep the legacy pipeline for S4R (Phases 8–13) | The S4R contract never changed | Two diagnosis paths in one engine until Phase 15 |
| A new engine instead of changing the shared one (Phase 15) | AC has one canonical path and a private, IAM-authenticated engine; S4R is untouched | The old engine still runs in AC's account, on AC's role, secrets and Jev credit |
| CloudFront left unmanaged ([ADR 0008](../adr/0008-cloudfront-initially-unmanaged.md)) | No risk to the shared distribution during the migration | One AC resource is still outside CDK |
| No automatic deployment | Every production change is reviewed, scoped and audited | Releases are manual and slower |
| Required approvals set to 0 | A single maintainer can merge through PRs and checks | No second reviewer; the PR record and CI are the review |
| Fix the product, then restart the gate | Every GOLD pass is evidence, not a lucky run | More releases and a slower gate: Phase 11 needed four extra releases and ten runs |
| Sign internal fields instead of moving S4R (Phase 11) | S4R's contract and URL never changed | The signing key is handled like the service bearers, through the Lambda environment |

## Still open

| Item | Evidence or detail |
|---|---|
| **Account Lambda concurrency is 10**, shared with every workload in the account | Fix: an account-level quota increase (100 recommended), which needs the account owner's approval ([analysis](../evaluation/phase-11-concurrency.md)) |
| **Every turn needs Jev; no credit or quota monitoring** | Running out of Jev credit took the service down on 2026-10-11 ([finding](../evaluation/phase-13-results.md#operational-finding-jev-credit-exhaustion-took-production-down)). Needed: alerting on the Jev error rate and remaining credit |
| **The LLM provider is a single point of failure** | Qwen runs on LM Studio over a private tunnel, one request at a time; when the tunnel dropped on 2026-10-12 turns failed explicitly, by design |
| **No alarm notification target** | The engine alarms go to ALARM, but nobody is notified. Fix: an AC-owned SNS topic and subscription |
| **The old shared engine still runs in AC's account** | It serves S4R; moving it is S4R's change ([ADR 0019](../adr/0019-dedicated-canonical-diagnosis-engine.md)) |
| **The orchestrator function still exists** | No traffic since change 21.3; removing it from the stack is a separate reviewed change |
| **Evaluation shares production's providers** | Benchmark runs use the same LM Studio and Jev account as the live service |
