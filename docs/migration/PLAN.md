# Appliance Clinic migration plan

This is the authoritative plan for moving Appliance Clinic (AC) out of the `spares4repairs`
monorepo and into this repository, and for bringing AC's existing AWS resources under
dedicated CDK management. Change it only through a reviewed pull request.

## Objective

1. **Extract the code** into this repository.
2. **Transfer infrastructure ownership** of AC-owned AWS resources into CDK, with no change in behaviour.
3. **Improve** the system: security hardening, refactoring, documentation.

These three concerns stay separate. A phase that does one of them does not do the others,
unless there is a clear technical reason recorded in the phase's PR.

## Boundaries

- **`spares4repairs` is read-only.** It is a source for inspection and copying only. Nothing
  is committed, branched, deleted, rewritten or reconfigured there. Its deployment scripts are
  never run and it is never used as a deployment source.
- **Spares4Repairs (S4R) production must not be affected.** Nothing owned by, shared with or
  required by S4R is modified, imported, replaced, renamed or deleted. That includes the S4R
  Cognito pool and app client, the `SparesSite-dev` stack, S4R CloudFront, API Gateway,
  DynamoDB tables, secrets and IAM roles, and the default `CDKToolkit` bootstrap stack.
- **Ambiguous ownership means S4R.** If ownership of a resource is not proven, stop and treat it
  as S4R-owned.
- **AC-owned does not mean safe to change.** The S4R `/part-finder` page runs in the shopper's
  browser and POSTs directly to the AC diagnosis Lambda's Function URL. Any change to that
  Lambda, its URL, permissions, CORS, authentication, concurrency, request or response shape,
  streaming behaviour or pipeline is **POTENTIALLY IMPACTS S4R**.
- **No AC production resource is destroyed or replaced.** Physical names, Function URLs, Lambda
  identities, data, S3 contents, secrets, IAM behaviour and request/response contracts survive.
- **The running AWS deployment is the source of truth**, not `13b7a50`. Code was deployed by
  hand from feature branches.
- **Production AWS commands are run by a person**, never by CI. No production AWS credentials
  are stored in GitHub, and there are no automatic production deployment workflows.

## Action classifications

Every action in this plan, its runbooks and its issues carries one of these labels.

| Classification | Meaning |
|---|---|
| **READ-ONLY** | Describe, list, get or export only. No state changes anywhere. |
| **SAFE AC CHANGE** | Changes only resources proven to be AC-owned, with no S4R consumer affected. |
| **POTENTIALLY IMPACTS S4R** | Touches something S4R owns, shares, consumes or calls. Requires isolation, rehearsal, the `/part-finder` contract test before and after, and explicit written sign-off. |
| **DO NOT DO** | Out of scope for this migration. |

## Phases

| Phase | Concern | Summary |
|---|---|---|
| 0 | Preparation | Freeze, inventory, ownership proof, backups, behavioural baseline |
| 1 | Hotfix | AC-side admin allowlist on the deployed artefact |
| 2 | Extract | Runtime-identical import into this public repository, after a secret and PII scan |
| 3 | Extract | Reproducible builds, CI, known-failure baseline, build equivalence |
| 4 | Ownership | Rehearsal in a separate sandbox AWS account |
| 5 | Ownership | Production CDK import in small groups |
| 6 | Ownership | Prove ownership with one harmless change |
| 7 | Improve | Security hardening through CDK |
| 8 | Improve | Architecture cleanup |
| 9 | Improve | Clean squashed public portfolio repository |

### Phase 0: Freeze, inventory, ownership proof, backups, baseline

**Entry criteria**
- This plan is merged.
- The Phase 0 tooling in `tools/migration/` is merged and its tests pass.

**Actions**

| Action | Classification |
|---|---|
| Freeze batch runs, Settings Apply, admin publishing and old-repo deployment scripts ([runbook](runbooks/phase-0-freeze.md)) | Process only |
| Inventory every AC resource: Lambda configuration, code SHA-256, image digests, Function URLs, resource policies, IAM roles and inline policies, DynamoDB configuration (TTL, GSIs, PITR), S3 configuration and bucket policies, secret metadata, ECR, EventBridge rules and targets, CloudFront configuration ([runbook](runbooks/phase-0-inventory.md)) | READ-ONLY |
| Generate the S4R denylist from every existing CloudFormation stack plus known S4R resources | READ-ONLY |
| Download deployed Lambda artefacts and compare them with an export of `spares4repairs@13b7a50` | READ-ONLY |
| Capture the WebMCP origin-trial token from the deployed `index.html` | READ-ONLY |
| Capture routing override and AI config state (secret values hashed, never written) | READ-ONLY |
| Record external runtime dependencies | READ-ONLY |
| Prove ownership of every resource and record the evidence in [`ownership.md`](ownership.md) | READ-ONLY |
| Investigate every API Gateway invoke permission on AC functions: does the API's current or deployed configuration integrate the function, or is the permission stale? (`apigateway-permissions` in the inventory) | READ-ONLY (reads S4R API configuration only) |
| Measure whether the diagnosis Lambda's second ingress, `POST /ai/chat` on the S4R HTTP API, is used (`npm run traffic`, CloudWatch metrics) | READ-ONLY |
| Capture the `/ai/chat` ingress baseline, separately from the `/part-finder` contract (`npm run baseline -- ingress capture`) | SAFE AC CHANGE (one LLM call) |
| Record the inventory findings and production baseline in [`phase-0-findings.md`](phase-0-findings.md) | Repository only |
| DynamoDB on-demand backups, enable PITR on AC tables, copy AC buckets to a backup bucket ([runbook](runbooks/phase-0-backups.md)) | SAFE AC CHANGE |
| Capture the `/part-finder` contract and record the behavioural baseline without `observability` ([runbook](runbooks/phase-0-baseline.md)) | SAFE AC CHANGE (LLM spend, possible canonical-state items) |
| Run the batch benchmark runner for the baseline (it rewrites production routing) | DO NOT DO |

**Exit criteria**
- Every AC resource is listed in `ownership.md` with evidence, and every unproven resource is marked S4R.
- The shared execution role boundary is documented: the diagnosis Lambda runs under the S4R-owned
  `SparesSite-dev` server role ([ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md)).
- Every API Gateway invoke permission on an AC function is explained, or explicitly left unresolved
  and classified S4R-sensitive.
- The inventory tooling fixes are merged and green.

Step #4 (deployed-vs-source comparison) does not start until the three criteria above are met.
- `s4r-denylist.json` has been generated and reviewed.
- The deployed-vs-source comparison is recorded, and every unmatched file is explained.
- Backups are complete: DynamoDB on-demand backups are `AVAILABLE`, PITR is enabled on both AC tables,
  and the S3 backup copies match the inventory object counts. No production restore is performed;
  recovery is rehearsed in the sandbox (Phase 4).
- The `/part-finder` contract and the behavioural baseline are recorded.

### Phase 1: Critical admin hotfix

Fix only the live admin authorisation issue: today any user in the S4R pool with no Cognito
groups is treated as an AC admin.

**Entry criteria**
- Phase 0 has captured the exact deployed `whichpart-api` zip, its configuration JSON and CodeSha256.
- The rollback command is written and reviewed.
- The AC admin identities are confirmed, as Cognito `sub` values where practical.

**Actions**

| Action | Classification |
|---|---|
| Patch the downloaded deployed `whichpart-api` artefact so admin requires membership of an AC-side allowlist (`sub` preferred) | No AWS action |
| Prove with the build-equivalence tool that the patched zip differs only in the intended file | No AWS action |
| Upload the patched zip with `update-function-code` and add the allowlist configuration | SAFE AC CHANGE |
| Roll back if needed by restoring the exact original `$LATEST` artefact and configuration | SAFE AC CHANGE |
| Add groups or any other setting to the S4R Cognito pool | DO NOT DO |
| Use the old repo's `deploy.sh` or an unproven build from this repository | DO NOT DO |

**Exit criteria**
- Allowlisted admins can use every `/admin/*` route, and other pool users get 401/403 on every one.
- The customer `/api` is unchanged.
- The S4R health checks and the `/part-finder` contract test pass.

### Phase 2: Extract into this repository

**Entry criteria**
- The Phase 0 deployed-vs-source comparison says which commit, or which downloaded artefacts, represent production.

**Actions**
- `git archive` the AC paths from the production-equivalent source into a staging directory. This reads `spares4repairs` without writing to it.
- Keep the runtime layout exactly as it is: no reorganisation, image conversion, path changes, refactoring, identifier parameterisation or behaviour changes.
- Exclude only shop and legacy code, unlicensed imagery, generated result dumps, coverage data, internal CONTINUE and handover notes, `.cursor/`, tools that read S4R internal data, and anything containing secrets or PII.
- Run secret and PII scanning before pushing, and review every finding by hand.

**Exit criteria**
- Every runtime file in the import matches the production-equivalent source byte for byte.
- The secret and PII scan is clean.
- Public-exposure gate. This repository is public, so the scan passes before anything is pushed:
  - Absolute blockers: secrets, credentials, private keys, customer data and PII.
  - Not blockers by themselves: AWS account IDs, resource IDs, public Function URLs and other
    non-secret infrastructure identifiers. Runtime code is not changed to hide them.

### Phase 3: Reproducible and testable

**Entry criteria**
- Phase 2 is merged.

**Actions**
- Add the workspace structure, a lockfile, dependencies pinned to the deployed versions, Python requirements, ESLint and CI.
- Fix tests that are only stale. Record the remaining failures as a known-failure baseline that CI tracks.
- Build every Lambda artefact from this repository and compare it with the deployed artefact.

**Exit criteria**
- CI is green against the known-failure baseline.
- Every rebuilt artefact matches its deployed artefact file for file.
- No runtime behaviour has changed.

### Phase 4: Sandbox rehearsal

**Entry criteria**
- A separate AWS account exists, bootstrapped with its own AC CDK toolkit (`--qualifier acclinic`).

**Actions (all in the sandbox account)**
- IAM: the inline-policy experiments T1 to T7 from the review (unmanaged policy survival, `Role.Policies` behaviour, `CfnRolePolicy` import, removal with RETAIN).
- Lambda: Function URL import, permission import, removing a URL and importing it again (the URL host must not change), and importing a container Lambda by digest.
- S3: import a bucket and its bucket policy.
- Rollback with RETAIN, stack policy behaviour, the change-set checker, and the deny-S4R execution role.
- Recovery, with sandbox test data: restore a DynamoDB on-demand backup and a PITR point into new tables, restore S3 objects
  from a backup-bucket copy, and record the steps and timings in a recovery runbook.

T1 (an unmanaged inline policy surviving an unrelated stack update) stays mandatory. In production, the
hand-added policies on the S4R server role have survived S4R deployments, which lowers the concern but
does not replace the test.

**Exit criteria**
- Every resource type planned for Phase 5 has a recorded, passing rehearsal.
- The recovery rehearsal has passed and its runbook is merged.
- Every surprise has been turned into a rule, a checker test or a runbook step.

### Phase 5: Production CDK import

**Entry criteria**
- Phase 4 has passed for every resource type in the group being imported.
- A dedicated toolkit exists: `cdk bootstrap --qualifier acclinic --toolkit-stack-name ApplianceClinicToolkit`, with explicit deny rules on S4R resources in its CloudFormation execution role. The default `CDKToolkit` is not reused or modified.

**Import order.** Each group is a separate change set and a separate issue.

| Step | Resources | Classification |
|---|---|---|
| 5.1 | ECR canary: the error-code MCP repository | SAFE AC CHANGE |
| 5.2 | Remaining ECR repository and AC secrets | SAFE AC CHANGE |
| 5.3 | DynamoDB: `whichpart-recalls`, then `whichpart-transcripts` | SAFE AC CHANGE |
| 5.4 | S3 buckets and their existing bucket policies | SAFE AC CHANGE |
| 5.5 | IAM roles, without inline policies | SAFE AC CHANGE |
| 5.6 | Inline policies as separate `CfnRolePolicy` resources | SAFE AC CHANGE |
| 5.7 | Lambda functions, least critical first: error-code MCP, orchestrator, `whichpart-api` | SAFE AC CHANGE |
| 5.8 | Their Function URLs and permissions, only where the sandbox proved it | SAFE AC CHANGE |
| 5.9 | EventBridge rules | SAFE AC CHANGE |
| 5.10 | Diagnosis Lambda function, URL and its AC-created permissions, **last**, with explicit sign-off. Its execution role is **not** imported (see below) | POTENTIALLY IMPACTS S4R |
| — | CloudFront distribution and function: left unmanaged for now | Not imported |

**The diagnosis Lambda and the shared S4R role (step 5.10)**

The Phase 0 inventory found that `spares4repairs-part-finder` runs under
`SparesSite-dev-ServerFunctionRole…`, the execution role of the S4R server Lambda, managed by the
`SparesSite-dev` stack ([findings](phase-0-findings.md), [ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md)).

- The role is S4R-owned. It is never imported into, modified by or managed by AC CDK.
- The imported function references the existing role ARN unchanged, as an acknowledged S4R reference
  in the change-set checker's step file.
- The three AC permissions added by hand to that role (`WhichpartLearningPut`,
  `whichpart-knowledge-overlay-s3`, `whichpart-media-overlay-s3`) are recorded but not imported,
  changed or removed.
- The `apigateway-invoke` permission is **live**. It lets the S4R HTTP API `spares4repairs-dev` route
  `POST /ai/chat` to the diagnosis Lambda, unauthenticated. That makes it a second public ingress
  besides the Function URL. The route, the API and the permission are treated as live dependencies:
  not imported, changed or removed, and S4R-sensitive.
- Moving the diagnosis Lambda to a dedicated AC execution role is a separate Phase 7 change,
  classified POTENTIALLY IMPACTS S4R.

**CDK rules for imported resources**
- Use L1 `Cfn*` resources. Avoid L2 constructs that silently create IAM policies, Lambda permissions, bucket policies, log retention resources, lifecycle rules, generated secrets or Function URL permissions.
- Every imported resource has `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`.
- Never use `grant*()` on imported roles and never use `Role.Policies`. Each existing inline policy is its own `CfnRolePolicy`.
- Container Lambdas reference the currently deployed ECR image digest. Zip Lambdas use the downloaded production artefact, so CodeSha256 does not change.
- The plaintext bearer tokens in three Lambdas' environment variables are expressed as Secrets Manager dynamic references. Literal values never appear in source, CDK code, templates, `cdk.out` or git.
- No CloudFormation exports between stacks. Stacks: `AcDataStack` and `AcRuntimeStack` now, `AcAuthStack` in Phase 7, and a web stack only if CloudFront is imported later.
- Stack termination protection is on, and analytics reporting is off so no `CDK::Metadata` resource blocks an import-only change set.

**Operational switches after import**

The canonical engine's rollback switches are Lambda environment variables: `CANONICAL_MODE` and
`CANONICAL_CONTROL_JOURNEYS` on `whichpart-api`, and the per-journey kill switches on the diagnosis
Lambda. Once a function is imported, changing them in the console is drift, and the next CDK deploy
silently reverts it.

- Before each function's import, record its switch values in the baseline, and declare exactly those values in CDK.
- After import, every switch change is a reviewed CDK change. An emergency rollback is a one-line CDK
  change, checked in update mode and deployed by a person. Document it in the function's runbook
  before the import.
- If an emergency console change is ever unavoidable, port it to CDK before the next deploy. The
  config comparison against the baseline will show it.
- Switches on the diagnosis Lambda are POTENTIALLY IMPACTS S4R.
- Moving the switches to a runtime configuration store is a Phase 7 or 8 decision, not part of the import.

See [ADR 0004](../adr/0004-import-existing-resources-into-cdk.md).

**Exit criteria**
- Every group has passed its import gate and its post-import checks (see [Safety gates](#safety-gates)).

### Phase 6: Prove CDK ownership

**Entry criteria**
- Every Phase 5 group is imported, and the config comparison against the Phase 0 baseline is clean.

**Actions**
1. Config comparison, drift detection where supported, smoke tests, S4R health checks, and the behavioural baseline comparison.
2. One harmless, reversible change: an inert SSM parameter, or one tag on one low-risk resource. Never a stack-wide tag.
3. Inspect the change set: no replacements, no removals, no unrelated changes.
4. Deploy, then repeat step 1.

**Exit criteria**
- The proof change deployed exactly as reviewed, and every check before and after is clean.

### Phase 7: Security hardening

**Entry criteria**
- CDK ownership is proven (Phase 6).

**Actions**

| Action | Classification |
|---|---|
| New AC Cognito pool, app client and `admin` group in `AcAuthStack`; recreate AC admins; cut `whichpart-api` over; then point AC's `whichpart-cognito-auth` policy at the AC pool | SAFE AC CHANGE |
| AC secrets namespace with rotated OpenAI, Jev, HMAC and bearer values; the old secrets are left in place | SAFE AC CHANGE |
| Login and per-IP/per-session rate limiting on `whichpart-api` | SAFE AC CHANGE |
| Authentication on AC-only endpoints (orchestrator, error-code MCP) | SAFE AC CHANGE |
| Reserved concurrency where safe, tighter CORS, CSP | SAFE AC CHANGE |
| Benchmarks routed to staging only; production tools default to staging; least-privilege IAM | SAFE AC CHANGE |
| Any change to the diagnosis Lambda's AuthType, CORS, permissions, concurrency or request/response shape | POTENTIALLY IMPACTS S4R |
| Move the diagnosis Lambda from the shared S4R server role to a dedicated AC execution role (needs the `/part-finder` contract test before and after, and explicit sign-off) | POTENTIALLY IMPACTS S4R |
| Protect or remove the unauthenticated `POST /ai/chat` route, or remove the `apigateway-invoke` permission. Only when the traffic check shows the route's actual use and S4R signs off; the route lives on the S4R API | POTENTIALLY IMPACTS S4R |
| Remove the AC permissions from the S4R server role | DO NOT DO in this work: it changes an S4R resource. Proposed separately as an S4R change once the role move is proven |
| Any change to the S4R Cognito pool, or narrowing the S4R server role's secret grant | DO NOT DO |

**Exit criteria**
- AC authentication is independent of S4R.
- No S4R resource has changed.
- The `/part-finder` contract still passes.

### Phase 8: Architecture cleanup

**Entry criteria**
- Migration and security are stable.

**Actions**
- Retire the legacy diagnosis pipeline only when the canonical engine preserves the `/part-finder` contract (POTENTIALLY IMPACTS S4R).
- Split the large engine file and `admin.js`, version the prompts, and introduce TypeScript gradually.
- Add architecture documentation, ADRs, evaluation reports, and contributor and security documentation.

**Exit criteria**
- The full evaluation is within agreed bands, and the `/part-finder` contract passes.

### Phase 9: Public portfolio publication

**Actions**
- Create a clean, squashed public repository from the finished private repository. The private migration history is not exposed.
- Before publishing, remove unnecessary AWS identifiers, migration-only detail and temporary notes, and verify there are no secrets, customer data or unlicensed media.
- Check the README, architecture documentation, CI, licence, `SECURITY.md` and `CONTRIBUTING.md`.
- Apply the `main` ruleset ([`.github/rulesets/protect-main.json`](../../.github/rulesets/protect-main.json)) to the public repository, so the rules that are process-enforced in this private repository become GitHub-enforced. See [repository governance](../repository/governance.md).

## Safety gates

### Before any production AWS action
1. Every target resource is marked proven AC in `ownership.md`.
2. The S4R denylist was regenerated the same day.
3. The freeze is confirmed: no batch runs, routing override lease idle, no Settings Apply, no admin publishing, no old-repo scripts.
4. Backups are less than 24 hours old.
5. S4R health checks have passed in the last hour: shop homepage, catalogue API, and the `/part-finder` contract including the CORS preflight from `https://spares4repairs.co.uk`.

### Before each production import
1. This exact resource type has been rehearsed in the sandbox.
2. The change set has been created but not executed, and `tools/migration` change-set checking (import mode) passes:
   every action is `Import`; there are no Add, Modify or Remove actions; every physical ID is on the step's
   allowlist; no S4R ID or ARN is present; Retain is set; no literal secrets appear in the template.
3. Written sign-off is recorded on the step's issue.

### After each production import
1. Live configuration compared with the Phase 0 baseline.
2. Drift detection where supported.
3. Smoke tests.
4. S4R homepage, catalogue API and `/part-finder` contract checks. When the diagnosis Lambda was
   touched, also the `/ai/chat` ingress check.

### Before each CDK update after import
1. The change-set checker (update mode) passes: no replacement, no removal unless approved and Retain-protected, no denylisted IDs, IAM changes listed and justified.
2. Stack policies deny `Update:Replace` and `Update:Delete` on data resources, Function URLs, Lambda permissions and the diagnosis Lambda.
3. Deployment uses the `acclinic` toolkit execution role.
4. Anything touching the diagnosis Lambda is POTENTIALLY IMPACTS S4R. It needs:
   - sign-off
   - the `/part-finder` contract test **and** the `/ai/chat` ingress check, before and after
   - running out of shop hours
   - a prepared rollback

### Behavioural validation
- **Exact checks:** routing, safety decisions, the part gate, error-code lookup, API status codes, response shapes, admin authorisation, and the S4R contract.
- **LLM-dependent checks:** evaluation score bands, never byte-for-byte prose.
- **Per import group:** config diff, drift and smoke tests only.
- **Full evaluation:** after the final import, after the proof deploy, and after code or security changes.

## Related documents

- [`ownership.md`](ownership.md): ownership evidence per resource
- [`s4r-denylist.json`](s4r-denylist.json): resources AC tooling must never touch
- [`runbooks/`](runbooks/README.md): step-by-step procedures
- [`../adr/`](../adr/README.md): architecture decision records, including the decisions behind this
  plan (ADRs 0002–0009)
