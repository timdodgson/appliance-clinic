# Phase 5 results

What the production import (PLAN.md, Phase 5; [runbook](runbooks/phase-5-import.md)) did, step by step. Every step
ran as the IAM user in account `800960611664`, eu-west-1; every resource operation went through CloudFormation with the
read-only `acclinic` execution role. Raw outputs stay in `.migration-output/phase5/`.

## Pre-flight (2026-10-07)

| Gate | Result |
|---|---|
| Pre-Phase-5 inventory | Taken; `compare:config` against the inventory before the Phase 4 sandbox: 0 differences |
| S4R denylist regenerated | 79 entries, identical to the committed denylist |
| Freeze (#2) | Open; routing override lease `released` |
| Backups | PITR continuous on both tables (latest restorable point minutes old); Phase 0 on-demand backups from 01:42Z |
| S4R and AC checks | S4R health 3 × 200; `/part-finder` contract captured (preflight and POST 200, CORS for `https://spares4repairs.co.uk`, NDJSON); `/ai/chat` 500 as in the Phase 0 baseline; smoke: 4 scenarios 200, safety decisions as expected |

## Toolkit: `ApplianceClinicToolkit` (2026-10-07)

Created from [`phase-5/toolkit/`](phase-5/toolkit/) by [`00-toolkit.sh`](../../infra/production/steps/00-toolkit.sh): 11 Add
actions, termination protection on, qualifier `acclinic`. The execution role `cdk-acclinic-cfn-exec-role-…` carries exactly
`ac-cfn-execution` and `ac-deny-s4r`. IAM simulator: `iam:PutRolePolicy` and `iam:PassRole` on the S4R role, `UpdateStack` on
`SparesSite-dev` and `PATCH` on API `65vnizdmk4` are explicitly denied; writes to AC functions and tables, S3 object reads and
`GetSecretValue` are implicitly denied; AC reads are allowed.

| Version | `ac-cfn-execution` change |
|---|---|
| v1 | As reviewed in #45 |
| v2 | `ssm:GetParameter(s)` on `/cdk-bootstrap/acclinic/version`: every CDK template's `BootstrapVersion` parameter resolves it with the execution role |

## Step 5.1: STOPPED

The import of `spares4repairs-error-code-mcp` into `AcDataStack` (one Import action; import-mode check passed; changes exactly
as expected) **rolled back** (`IMPORT_ROLLBACK_COMPLETE`):

1. `IMPORT_COMPLETE` for the repository, then
2. `UPDATE_IN_PROGRESS` "Apply stack-level tags to imported resource if applicable": after every import, CloudFormation runs
   the resource's **update handler**, then
3. `UPDATE_FAILED`: the execution role "is not authorized to perform: `ecr:DeleteRepositoryPolicy`".

The ECR update handler reconciles the whole resource with the template. The template leaves `RepositoryPolicyText`
undeclared (as Phase 4 did), so the handler tried to **delete the live repository policy** that Lambda wrote
(`LambdaECRImageRetrievalPolicy`, which lets Lambda pull the orchestrator and error-code MCP images). The read-only execution
role refused it. Afterwards the repository is unchanged (policy, tag mutability, scan on push, encryption, no tags), and the
stack holds only its `StackShell`.

**Why Phase 4 did not show it.** The sandbox execution role could write, so each post-import update succeeded silently; and
the sandbox repositories had no policy yet when they were imported (Lambda wrote it later). The rehearsal therefore never
exercised a post-import write against a property the template does not declare.

**What it means for Phase 5.** An import is not read-only: every imported resource also goes through its update handler,
with the execution role's permissions. With write access, an import would reset or delete any live property the template does
not declare, for every resource type, including the diagnosis Lambda in 5.10. The read-only execution role turns that into a
safe rollback, but then no import whose update handler writes can complete.

**Resolved.** The sandbox rehearsal ([phase-5-import-semantics.md](phase-5-import-semantics.md), #49) established every
type's post-import writes. 5.1 was then run again with the repository policy declared and the step's writes granted (below).

## Steps 5.1 to 5.9 (2026-10-08)

Each step ran [`import.sh`](../../infra/production/steps/import.sh) `<step>` as in the [runbook](runbooks/phase-5-import.md):
- a fresh live capture
- a snapshot
- a step version of `ac-cfn-execution` (the read-only base plus exactly the manifest's writes on exactly the step's
  resources), back to the read-only version straight after the import
- an Import-only change set, checked in import mode and equal to the step file's expected changes
- drift, a no-op change set and the stack policy
- the before/after compare, and CloudTrail after delivery

Backups were refreshed before 5.3a: on-demand backups of both tables and fresh copies of both buckets
(`whichpart-learning`: 36,179 objects, the same count and bytes as the source).

| Step | Imported | Execution-policy version (writes added) | CloudTrail writes by the execution role | Drift | Before/after |
|---|---|---|---|---|---|
| 5.1 | ECR `spares4repairs-error-code-mcp` (policy declared) | v4: `ecr:SetRepositoryPolicy`, `PutImageTagMutability`, `PutImageScanningConfiguration`, `TagResource` | Exactly those four, on the repository | `IN_SYNC` | Identical; policy text unchanged |
| 5.2 | ECR `spares4repairs-diag-orchestrator`; 7 secrets | v5: ECR as 5.1; `secretsmanager:UpdateSecret`, `TagResource` | ECR as 5.1; per secret `TagResource` and `UpdateSecret` (description only, no value or KMS key) | `IN_SYNC` | Identical; secret versions unchanged |
| 5.3a | Table `whichpart-recalls` | v3 (none) | None | `IN_SYNC` | Identical |
| 5.3b | Table `whichpart-transcripts` | v3 (none) | None | `IN_SYNC` | Identical |
| 5.4 | Buckets `whichpart-web-…`, `whichpart-learning-…`; `whichpart-web` bucket policy | v9: `s3:PutBucketTagging` | `s3:TagResource` on each bucket (authorised by `s3:PutBucketTagging`); none for the bucket policy | `IN_SYNC` (no drift result is reported for the bucket policy; its text is identical in the snapshots) | Identical |
| 5.5 | Roles `diag-orchestrator-role`, `error-code-mcp-role`, `whichpart-api-role` | v3 (none) | None | `IN_SYNC` | Identical |
| 5.6 | 9 inline policies | v3 (none) | None | `IN_SYNC` | Identical |
| 5.7a | Function `spares4repairs-error-code-mcp` | v6: `lambda:TagResource` | `lambda:TagResource` on the function | `IN_SYNC` | Identical; image digest unchanged |
| 5.7b | Function `spares4repairs-diag-orchestrator` | v7: `lambda:TagResource` | `lambda:TagResource` on the function | `IN_SYNC` | Identical; image digest unchanged |
| 5.7c | Function `whichpart-api` (token parameters NoEcho) | v8: `lambda:TagResource` | `lambda:TagResource` on the function | `IN_SYNC` | Identical; CodeSha256 and environment unchanged |
| 5.8 | 3 Function URLs, 8 permissions | v3 (none) | None | `IN_SYNC` | Identical; URL hosts, auth type, invoke mode and CORS unchanged |
| 5.9 | Rules `whichpart-recall-ingest-daily`, `whichpart-transcript-review` | v10: `events:TagResource` | `events:TagResource` on each rule | `IN_SYNC` | Identical; schedule, state and targets unchanged |

"Identical" means the full snapshots are equal apart from the `aws:cloudformation:*` tags. For runtime steps the snapshot
is the whole runtime capture (all roles, functions and rules), so a change anywhere would show. Every CloudTrail check
passed `import-writes.mjs check-writes`:
- no unexpected write
- no forbidden parameter
- no refused call

After every step the default `ac-cfn-execution` version was v3, the read-only base.

**Checker fixes found on the way. Each stopped a step safely; none changed a resource.**
- **Compare: untagged resources.** The secrets (5.2) and buckets (5.4) had no tags before the import: `Tags` absent, or
  S3's `NoSuchTagSet`. Afterwards they hold only CloudFormation's tags. The first comparison read that as a change.
  [`compare.sh`](../../infra/production/compare.sh) now treats "no tags" and "only `aws:cloudformation:*` tags" as equal.
  Negative tests confirm that any other tag or property change still fails, and all ten comparisons were re-run.
- **Change-set check: carried-forward S4R references.** The runtime template is cumulative, so from 5.7a on it still
  holds the 5.6 `whichpart-cognito-auth` policy and its S4R pool ARN. 5.7c added whichpart-api's environment
  references to the S4R app client (`COGNITO_CLIENT_ID`) and the S4R shop CloudFront (`S4R_PRODUCT_BASE_URL`). Both are
  documented in ownership.md. The check refused each before execution and deleted the change set. Step files now carry
  every earlier step's acknowledged references, each with its reason
  ([`make-runtime-steps.mjs`](../../infra/production/make-runtime-steps.mjs)).

### After 5.9

| Check | Result |
|---|---|
| `AcDataStack` | `IMPORT_COMPLETE`, termination protection on, no stack tags, stack policy denies `Update:Replace` and `Update:Delete`. Drift `IN_SYNC`: 13 resources plus `StackShell` and the bucket policy, neither of which reports drift |
| `AcRuntimeStack` | The same; drift `IN_SYNC`, 28 resources plus `StackShell` |
| `ac-cfn-execution` | Default v3, byte-for-byte the committed read-only base |
| Inventory vs pre-Phase-5 (`compare:config`) | 52 differences, all expected: the AC and sandbox stacks (the sandbox probe postdates the pre-Phase-5 inventory), the sandbox functions, `aws:cloudformation:*` tags on the three AC functions, the inventory's ownership flags now naming the AC stacks, and 3 new `whichpart-learning` objects from normal traffic. No configuration difference |
| S4R health | 3 × 200 after every step |
| `/part-finder` contract | `contract verify`: ok |
| `/ai/chat` ingress | `ingress verify`: ok (as recorded) |
| Smoke | 4 scenarios 200; safety decisions and state tokens as before Phase 5 |
| `SparesSite-dev`, `CDKToolkit` | Last updated 2026-07-21 and 2026-07-20 (unchanged) |

## Step 5.10: diagnosis Lambda (2026-10-08, signed off on #46)

**Scope.** `spares4repairs-part-finder`, its Function URL and the AC-created permissions `FnUrlPublic` and `PublicInvoke`
were imported into `AcRuntimeStack`. Not imported, and not changed:
- the S4R role `SparesSite-dev-ServerFunctionRole…` and its policies
- `apigateway-invoke`
- API `65vnizdmk4`

The function still runs under the S4R role.

[`import.sh`](../../infra/production/steps/import.sh) runs 5.10 only with `APPROVE_5_10=spares4repairs-part-finder`, and
only when the step policy's writes equal the approved statement exactly:

```json
{"Sid": "Step510Writes1", "Effect": "Allow", "Action": ["lambda:TagResource"],
 "Resource": ["arn:aws:lambda:eu-west-1:800960611664:function:spares4repairs-part-finder"]}
```

### Gate before execution (all passed)

| Check | Result |
|---|---|
| Template against a fresh capture | Runtime `nodejs20.x`, handler, `x86_64`, 256 MB, 300 s, environment (3 keys), role, layers (none), tracing `PassThrough`, ephemeral storage 512 MB, reserved concurrency (none): all equal live |
| Code | Staged artefact SHA-256 equals live CodeSha256 `Z6lIeG9rND+tecNh3/gCTMQ9mpDGeICYe6vxcGyvLXo=` |
| Function URL | Host `3asx4cw2qs5ajsjkytdwffhhvy0ptnoz.lambda-url.eu-west-1.on.aws`; `AuthType` `NONE`; `InvokeMode` `RESPONSE_STREAM`; CORS (origins `*`, `POST`, `content-type`, 86400) equal live |
| `apigateway-invoke` | Present live; not in the template |
| API `65vnizdmk4` | `POST /ai/chat` → integration `nk77gue` (`AWS_PROXY`) → `spares4repairs-part-finder` |
| S4R role | Trust, 20 inline policies (names and documents) and 2 AWS-managed policies equal to the pre-Phase-5 inventory |
| Template references | S4R role ARN and name acknowledged. `SparesSite-dev` (the S4R stack name, a prefix of the role name) is acknowledged only there: `import.sh` stops 5.10 if it occurs anywhere else in the template |
| Step policy | Read-only base plus exactly the approved statement |
| IAM simulator (with `ac-deny-s4r`, region eu-west-1) | Allowed: `lambda:TagResource` on the function. Implicitly denied: every other function write (`UntagResource`, `Update*`, `*FunctionUrlConfig`, `Add`/`RemovePermission`, `DeleteFunction`, `PutFunctionConcurrency`, `PublishVersion`) and `TagResource` on `whichpart-api`. Explicitly denied: `spares4repairs-server-dev`, every IAM write and `PassRole` on the S4R role, API `65vnizdmk4`, the S4R pool and client, `SparesSite-dev`, CloudFront, Route 53, ACM |
| S4R health, `/part-finder` contract, `/ai/chat` ingress | 3 × 200; ok; ok |

The first dry run's change-set check refused the template on the `SparesSite-dev` substring in the role ARN. That is
the narrow acknowledgement and guard above; nothing was executed.

### Import

| Item | Result |
|---|---|
| Change set | 4 Import actions (function, URL, `FnUrlPublic`, `PublicInvoke`), no replacement; import-mode check passed; equal to the step file |
| Execution policy | v11 (read-only + the approved statement) during the import; back to v3 straight after |
| Stack | `IMPORT_COMPLETE`; drift `IN_SYNC` for all four; the same template is a no-op; stack policy set |
| CloudTrail | Exactly one write: `lambda:TagResource` on `spares4repairs-part-finder` (09:04:06Z), no error. `check-writes` ok |
| Before/after (whole runtime capture) | Identical apart from `aws:cloudformation:*` tags. `LastModified` and `RevisionId` moved with the tagging and are not compared |
| Function | CodeSha256, role ARN, configuration and environment unchanged |
| Function URL | Host, `NONE`, `RESPONSE_STREAM` and CORS unchanged |
| Permissions | All three statements unchanged, `apigateway-invoke` included. It stays outside the stack |
| S4R boundary ([`s4r-boundary.sh`](../../infra/production/s4r-boundary.sh)) | S4R role (trust, inline and managed policy documents) and API `65vnizdmk4` (API, routes, integrations, stages) identical before and after; `POST /ai/chat` still → `nk77gue` → part-finder |
| After | S4R health 3 × 200; contract ok; ingress ok; smoke equal to the pre-Phase-5 baseline; `ac-cfn-execution` default v3, equal to the committed base |

## Sandbox probe cleanup (2026-10-08)

The import-semantics sandbox (#49) was removed with the guarded scripts, allowlisted `-sbx` names only:
- [`80-destroy.sh`](../../infra/sandbox/steps/80-destroy.sh) as `ac-operator-sbx` removed:
  - the stacks `AcDataStack-sbx`, `AcRuntimeStack-sbx` and `SparesSite-sbx`
  - 5 functions, 2 rules, 5 roles (including `ac-import-probe-sbx`)
  - 2 tables, 2 buckets, 2 repositories, 7 dummy secrets
  - the stand-in API and user pool
- [`85-teardown-controls.sh`](../../infra/sandbox/steps/85-teardown-controls.sh) as the IAM user removed `ac-operator-sbx`
  and the policies `ac-operator-policy-sbx`, `ac-cfn-execution-sbx` and `ac-deny-production-sbx`.

Afterwards:
- [`90-absence.sh`](../../infra/sandbox/steps/90-absence.sh): all 96 allowlisted names absent.
- A sweep of stacks, functions, roles, policies, log groups, buckets, repositories, secrets, tables and rules found no
  `sbx` or probe name.
- The production inventory before and after the cleanup differs only by the `-sbx` stacks and functions.

## Final verification (2026-10-08)

| Check | Result |
|---|---|
| `AcDataStack` | `IMPORT_COMPLETE`, termination protection, stack policy; drift `IN_SYNC`, 0 not in sync |
| `AcRuntimeStack` | The same; drift `IN_SYNC`, 0 not in sync |
| Ownership | 46 imported resources across the two stacks plus 2 `StackShell` handles. Exactly the union of the step files' expected imports. No S4R-type resource (API Gateway, Cognito, CloudFront, Route 53, ACM). No physical ID on the S4R denylist (79 entries). Neither the S4R role nor `apigateway-invoke` is in a stack |
| Unmanaged as intended | CloudFront `E1QD02IAJZPJLM`, its function, ACM and DNS (Unproven) are in no stack |
| Final inventory vs pre-Phase-5 (`compare:config`) | 59 differences, all expected: the stacks `AcDataStack`, `AcRuntimeStack`, `ApplianceClinicToolkit` (3); `aws:cloudformation:*` tags on the four functions (12); the inventory's ownership flags now naming the AC stacks (31); `whichpart-learning` objects written by live traffic (13). No configuration difference |
| `ac-cfn-execution` | Default v3, equal to the committed read-only base. The execution role carries exactly `ac-cfn-execution` and `ac-deny-s4r` |
| `SparesSite-dev`, `CDKToolkit` | Last updated 2026-07-21 and 2026-07-20: unchanged |
| S4R health | 3 × 200 |
| `/part-finder` contract | ok |
| `/ai/chat` ingress | ok |
| Smoke | 4 scenarios equal to the pre-Phase-5 baseline (status, safety, parts, state token) |

Production CloudTrail records for every step are test fixtures
([`fixtures/production/import-writes.cloudtrail.json`](../../tools/migration/test/fixtures/production/import-writes.cloudtrail.json)).
Each passes `check-writes` for its types.

## Phase 5 sign-off

Every exit criterion of PLAN.md Phase 5 is met. Every group passed its import gate and its post-import checks: 5.1 to
5.10, Import actions only, no replacement, drift `IN_SYNC`, zero effective configuration change, and the execution
role's writes exactly the sandbox-proven manifest. The freeze (#2) stays in place until Phase 6 exit
([phase-0-freeze.md](runbooks/phase-0-freeze.md#lifting-the-freeze)). Phase 6 has not started.
