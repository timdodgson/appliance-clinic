# Phase 4 results

What the sandbox rehearsal (#34, [runbook](runbooks/phase-4-sandbox-rehearsal.md)) found, step by step.
Every rehearsal ran on `-sbx` resources in account `800960611664`, eu-west-1, as `ac-operator-sbx` or the
`acsbx` execution role. Every mutation passed `sandbox:guard`, and every change set passed
`check:changeset --mode sandbox` before it was executed. The scripts that ran are in
[`infra/sandbox/`](../../infra/sandbox/); raw outputs stay in `.migration-output/sandbox/`.

## Approval point A (2026-10-07)

Created exactly the 17 approved resources ([plan](sandbox/approval-a/README.md)). Production AC and
S4R were unchanged: `SparesSite-dev` and `CDKToolkit` were identical before and after, and
`compare:config` showed only the new sandbox stack. S4R health was 3 × 200 before and after.

## S4R stand-in: `SparesSite-sbx`

Deployed directly with CloudFormation, as the operator, with no AC toolkit. It contains:
- the role `SparesSite-sbx-ServerFunctionRole`, with its stack-managed `SparesSite-sbx-ServerPolicy`
  (`AWS::IAM::Policy`, as S4R's CDK writes it)
- a stub catalogue Lambda
- the HTTP API `spares4repairs-sbx`, with routes `GET /api/search` and `GET /api/parts-for-model` and an
  auto-deploy `$default` stage
- the pool `SparesSite-sbx-UserPool` and its client

Four inline policies were then added to the role by hand, outside the stack, as on the production S4R role:
`WhichpartLearningPut-sbx`, `whichpart-knowledge-overlay-s3-sbx`, `whichpart-media-overlay-s3-sbx` and
`t1-unmanaged-sbx`.

## IAM experiments

| Test | Question | Result |
|---|---|---|
| **T1** (mandatory) | Does an unrelated update of `SparesSite-sbx` remove the inline policies the stack does not manage? | **PASS.** The update modified only the stub function and its integration. All five inline policies (four hand-added, one stack-managed) and the managed attachment were unchanged, compared by name and document SHA-256 |
| T1b | The same, when the update changes the role itself (its description) | **PASS.** Unchanged |
| T2 | What does `Role.Policies` do to an inline policy it does not declare? | The undeclared policy **survived** an update that changed a declared policy. **But drift detection then reports the role as `MODIFIED`**, listing the undeclared policy as an addition. Rule kept: never use `Role.Policies` |
| T3 | Import a role without `Policies`, then update it | **PASS.** Its two inline policies and its managed policy were unchanged |
| T4 | Import an inline policy as `AWS::IAM::RolePolicy` | **PASS.** Import actions only (7), and every imported role and policy `IN_SYNC` |
| T5 | Remove an imported `RolePolicy` with Retain | **PASS.** The policy stays on the role |
| T6 | Remove an imported role with Retain | **PASS.** The role and both its inline policies stay |
| T7 | Leave `ManagedPolicyArns` out of an imported role's template | Removing the property **detached** `AWSLambdaBasicExecutionRole`. Rule: always declare a role's managed policies exactly |

## Data imports: `AcDataStack-sbx` (Phase 5 steps 5.1 to 5.4)

Each resource was created outside CloudFormation with the production configuration and synthetic data only
([`steps/40-data.sh`](../../infra/sandbox/steps/40-data.sh)). All were then imported with one change set,
synthesized by the sandbox CDK app ([`cdk/lib/data-stack.js`](../../infra/sandbox/cdk/lib/data-stack.js), L1
resources only, Retain everywhere, no `CDK::Metadata`).

| Type | Resources | Result |
|---|---|---|
| ECR | `spares4repairs-diag-orchestrator-sbx`, `spares4repairs-error-code-mcp-sbx` (mutable tags, scan on push, AES256) | Imported. The repository policy is not declared: Lambda writes it when an image function is created |
| Secrets | 7 under `applianceclinic-sbx/`, dummy values | Imported by ARN. No value in any template. No `spares4repairs/sbx/*` secret exists |
| DynamoDB | `whichpart-transcripts-sbx` (GSI on `lastActivityAt`, TTL `expiresAt`) and `whichpart-recalls-sbx` (GSI on `gsiSk`, no TTL), both on-demand with PITR | Imported with key, GSI, TTL and PITR declared exactly. 100 synthetic items each |
| S3 | web, learning and backup buckets (owner-enforced, public access blocked, AES256) and the web bucket's OAC-shaped policy (placeholder distribution) | Imported |

**Result:** 15 Import actions and nothing else. An unchanged template is a no-op, and drift detection shows
every resource `IN_SYNC`.

## Surprises, and what they became

| # | Found | Became |
|---|---|---|
| 1 | The first real change set failed the checker on its own `changeSet/<name>/<uuid>` ARN | The checker ignores the change set's own IDs (#39); real output kept as a fixture |
| 2 | S4R health returned 403 without `NODE_USE_ENV_PROXY=1` | Approval A commands set it (#39) |
| 3 | CloudFormation gives `AWS::IAM::Policy` a generated physical ID (`Appli-FileP-…`) | The checker identifies it by its declared `PolicyName` |
| 4 | `compare:config` compared arrays by position, so one new stack showed as 162 differences | Records are matched by identity (stack, function, role, table, bucket names) |
| 5 | `compare:config` hid any difference mentioning a stack ARN: its CloudFormation-tag filter matched `arn:aws:cloudformation:` | The filter matches only the three `aws:cloudformation:*` tag keys; tested |
| 6 | PITR's restore window shows as drift on every run | `LatestRestorableDateTime` and `EarliestRestorableDateTime` are volatile |
| 7 | Routes, integrations, stages, Lambda permissions and URLs have no name of their own | The checker identifies them by the parent the template names, and still refuses a denylisted physical ID |
| 8 | CloudFormation's API Gateway handler tags a new API with a separate `POST /tags/<arn>` call, which the policies did not allow. A naive `/tags/*` allow conditioned on request tags could have tagged the production API into scope | `StandInApiTags` allows tagging only resources already tagged `ac:sandbox=phase-4`. `ac-deny-production-sbx` also denies `/tags/*65vnizdmk4*`; the IAM simulator confirms an explicit deny (policies v2) |
| 9 | With Retain on every resource, a failed create leaves its resources behind (`DELETE_SKIPPED`): one user pool was orphaned | Cleanup by allowlisted name after any failed create. The orphan was recorded as a generated child and deleted |
| 10 | A CREATE change set that is deleted leaves the stack in `REVIEW_IN_PROGRESS` | The step library treats that state as "not yet created" |
| 11 | `DescribeStackDriftDetectionStatus` has no resource-level authorisation, so the operator could not read drift results | Added to the account-level reads (policies v3); the drift helper fails fast |
| 12 | A removed `AWS::IAM::RolePolicy` is identified as `policy\|role` | The checker normalises it to the allowlist's `role/policy` |
| 13 | T2 and T7 | The checker fails a role that declares `Policies` or leaves out `ManagedPolicyArns` in import and update modes (warns in the sandbox) |
| 14 | **An import cannot create a stack with a service role or tags** ("you cannot modify or add [RoleArn, Tags]"). The IAM import only worked because that stack already existed | **Phase 5 rule:** create each stack first as a shell holding only a `StackShell` wait-condition handle, with its execution role, tags and termination protection, then import into it. The CDK stacks declare the handle, and the checker accepts it (it creates nothing outside CloudFormation) |
| 15 | Production's secrets policy grants a wildcard (`secret:…/applianceclinic-*`), which the guard refused as a non-sandbox ARN | The guard accepts a wildcard only when its literal prefix carries a sandbox marker and it matches no production AC or S4R identifier |

## Controls changed during Phase 4

The three managed policies are generated by `tools/migration/src/sandbox/approval-a.js`, and each
version applied is the committed document:

| Version | Change |
|---|---|
| v1 | Approval point A as approved |
| v2 | API Gateway tagging allowed only on resources already tagged for the sandbox; the S4R API's `/tags` form explicitly denied |
| v3 | `cloudformation:DescribeStackDriftDetectionStatus` added to the account-level reads |
