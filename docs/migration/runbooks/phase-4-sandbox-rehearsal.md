# Phase 4: sandbox rehearsal

**Classification:** sandbox only. Every change is made in a separate sandbox AWS account. Production
account `800960611664` is not changed. No S4R resource is touched, the freeze (#2) stays in place,
and the imported `deploy.sh` scripts are never run. Issue: #34.

**Goal:** before anything is imported in production (Phase 5), prove in a disposable account that:
- every Phase 5 resource type can be imported into AC CDK without being changed or replaced
- the shared S4R role is never managed by AC
- rollback and recovery work as documented

Runtime behaviour is not changed or improved in this phase.

## 1. Sandbox account boundary

| Rule | Detail |
|---|---|
| **Separate account** | A dedicated AWS account, used for nothing else. Its ID is recorded on #34 before the first change. It is never `800960611664` |
| **How it is created** | The owner creates it with a standalone sign-up, or from an AWS Organization whose management account is **not** production. Creating an Organization in `800960611664` changes the production account and is DO NOT DO under this phase |
| **No link to production** | No cross-account roles, trust, VPC peering, replication, backup copy, shared KMS keys or resource policies naming either account |
| **No production data or secrets** | Tables and buckets hold synthetic test data only. Production backups (#6) hold customer conversations and are never restored or copied here. Secrets hold dummy values |
| **Credentials** | A named profile `ac-sandbox` with sandbox-only credentials. The production keys in the environment are never used for sandbox work |
| **Account guard** | Every sandbox command runs through a guard that calls `sts:GetCallerIdentity` and refuses to continue unless the account equals the recorded sandbox ID. The guard refuses `800960611664` unconditionally, in code and in tests |
| **Region** | eu-west-1, the production region. us-east-1 is not used, because CloudFront stays unmanaged (ADR 0008) |
| **Cost** | An AWS Budgets alarm in the sandbox account. Resources are destroyed at the end of each rehearsal batch |
| **No S4R traffic** | Sandbox functions are never pointed at S4R endpoints. Configuration that names the S4R API or Cognito pool is replaced with sandbox stand-ins |

## 2. What is rehearsed

Every row is a Phase 5 resource type. In the sandbox, each one is first created outside CloudFormation, the way
production was created, and then imported with an import-only change set.

The source of each resource's configuration is [`ownership.md`](../ownership.md) and the Phase 0 inventory.
Physical names mirror production so that name-based behaviour (Function URL hosts, S3 naming, ARNs) is
exercised. Globally unique names get a `-sbx` suffix.

| Phase 5 step | Resource type | Sandbox stand-in for | Rehearsal | Production owner |
|---|---|---|---|---|
| 5.1, 5.2 | `AWS::ECR::Repository` | `spares4repairs-diag-orchestrator`, `spares4repairs-error-code-mcp` | Import; repository policy and lifecycle unchanged; the image digest is preserved | AC |
| 5.2 | `AWS::SecretsManager::Secret` | The 7 AC secrets (dummy values) | Import; no secret value in any template or `cdk.out`. Each secret keeps its production consumption pattern: the secrets the code reads at runtime through Secrets Manager stay that way, and only the plaintext bearer-token environment variables PLAN.md names are expressed as `{{resolve:secretsmanager:…}}` dynamic references | AC |
| 5.3 | `AWS::DynamoDB::Table` | `whichpart-recalls`, `whichpart-transcripts` | Import with the key, GSI `gsi_activity`, TTL, on-demand billing and **PITR enabled** declared exactly; then an update in which none of them changes | AC |
| 5.4 | `AWS::S3::Bucket`, `AWS::S3::BucketPolicy` | `whichpart-web-<sbx>`, `whichpart-learning-<sbx>` | Import the bucket and its existing policy (OAC statement shape); objects and policy unchanged | AC |
| 5.5 | `AWS::IAM::Role` | `whichpart-api-role`, `diag-orchestrator-role`, `error-code-mcp-role` | Import without inline policies; inline policies survive (T3) | AC |
| 5.6 | `AWS::IAM::RolePolicy` | 8 + 1 inline policies | Import as separate `CfnRolePolicy` (T4); removal with Retain (T5) | AC |
| 5.7 | `AWS::Lambda::Function` (zip) | `whichpart-api` | Import using the Phase 3 rebuilt zip; CodeSha256, configuration and switches unchanged | AC |
| 5.7 | `AWS::Lambda::Function` (image) | Orchestrator, error-code MCP | Import by the ECR image digest pushed to the sandbox; the digest is unchanged | AC |
| 5.8 | `AWS::Lambda::Url`, `AWS::Lambda::Permission` | The URLs and permissions of the three functions | Import; the URL host is unchanged; remove the URL from the template with Retain and import it again, with the same host | AC |
| 5.9 | `AWS::Events::Rule` | `whichpart-recall-ingest-daily`, `whichpart-transcript-review` | Import the rule with its target, schedule and input unchanged | AC |
| 5.10 | Function, URL and permissions of the diagnosis Lambda | `spares4repairs-part-finder` running under the **stand-in S4R role** | Import the function **without** its role, referencing the stand-in S4R role ARN; URL with RESPONSE_STREAM and CORS unchanged; the `apigateway-invoke` permission stays unmanaged | AC (S4R-consumed); the role is S4R |

### Stand-in S4R

The shared-role boundary can only be proven if something plays the S4R side. The sandbox has a stand-in
`SparesSite-sbx` stack, deployed with the sandbox's **default** `CDKToolkit`, as S4R deploys in production.

It contains:
- a role `SparesSite-sbx-ServerFunctionRole`, carrying a stand-in S4R inline policy
- a stand-in HTTP API with a `POST /ai/chat` route

The three AC inline policies are then added by hand, exactly as in production. This stand-in is the only "S4R"
in the sandbox. The deny-S4R statements of the AC toolkit name it.

### IAM experiments T1 to T7

PLAN.md refers to these experiments as defined in the original review, which is not in this repository. They are
restated here from PLAN.md's summary ("unmanaged policy survival, `Role.Policies` behaviour, `CfnRolePolicy`
import, removal with RETAIN"), so they can be reviewed in this PR.

CloudFormation currently documents resource-import support for `AWS::IAM::RolePolicy`, `AWS::Lambda::Url`,
`AWS::Lambda::Permission`, `AWS::Events::Rule` and `AWS::ECR::Repository` (checked during review of this PR). The
rehearsal confirms each one in practice.

| Test | Question | Pass condition |
|---|---|---|
| **T1** (mandatory) | Does an unrelated update of the stack that manages a role remove inline policies the stack does not manage? | The hand-added policies are unchanged after the update. This is PLAN.md's pass condition, unchanged |
| T1b (extra probe) | The same, when the update changes the role itself (a tag or description) | Records the behaviour. The result becomes a CDK rule, not a T1 failure. It is a Phase 5 STOP only if the production plan would make such an update to a role that carries unmanaged policies |
| T2 | What does declaring `Policies` on `AWS::IAM::Role` (`Role.Policies`) do to inline policies that are not declared? | Records the behaviour. If undeclared policies are removed, that confirms the rule "never use `Role.Policies`" |
| T3 | Importing a role with no `Policies` property, then updating it | Its existing inline and managed policies are unchanged |
| T4 | Importing an existing inline policy as `AWS::IAM::RolePolicy` | The import succeeds with an `Import` action only; the policy document is unchanged; drift detection is clean |
| T5 | Removing an imported `RolePolicy` from the template with `DeletionPolicy: Retain` | The policy stays on the role |
| T6 | Removing an imported role from the template with Retain | The role and all its policies stay |
| T7 | The managed policy attachment (`AWSLambdaBasicExecutionRole`) on an imported role, declared and then not declared in `ManagedPolicyArns` | Records whether an update detaches it. The finding becomes a CDK rule |

### Controls

| Control | Rehearsal |
|---|---|
| **Rollback with Retain** | Fail an update on purpose. The stack rolls back and no resource is deleted or replaced |
| **Stack policy** | Deny `Update:Replace` and `Update:Delete` on data resources, Function URLs, permissions and the diagnosis Lambda. A change set that replaces one is refused |
| **Termination protection** | On for every AC stack; deleting the stack is refused |
| **Change-set checker** | `npm run check:changeset` runs on every real change set, in import and update modes. Its rules are finalised on these change sets (the README marks it a skeleton). Each failure it should catch is shown failing |
| **Deny-S4R execution role** | The `acclinic` toolkit's CloudFormation execution role has explicit deny statements on the stand-in `SparesSite-sbx*` resources. A template that tries to change the stand-in S4R role fails with AccessDenied |
| **No `CDK::Metadata`** | Analytics reporting is off, so import-only change sets contain no Add action |

### Build and deploy path

The Phase 3 artefacts are deployed to the sandbox:
- both zips from `package_zips.py`
- both images built from `build/images/` and pushed to the sandbox ECR

Checks:
- **Configuration:** compared with the Phase 0 baseline field by field. Expected differences are only account IDs, ARNs, sandbox stand-in endpoints and dummy secret values.
- **Permissions:** compared statement by statement.
- **Endpoints:** checked only where no LLM, production data or S4R call is needed: routing status codes, auth rejections, and response shapes on error paths. LLM-dependent answers are not exercised, because the sandbox has no model credentials.

### Recovery rehearsal

The rehearsal uses synthetic data only. Tables are created with the production schema and seeded with generated
items; buckets with generated objects.

| Step | Procedure | Recorded |
|---|---|---|
| DynamoDB on-demand backup | `CreateBackup`, then `RestoreTableFromBackup` into a new table | Time to `AVAILABLE` and to `ACTIVE`; item count and key set equal; GSI, TTL and PITR settings on the restored table (restores do not carry TTL or PITR) |
| DynamoDB PITR | Enable PITR, change items, `RestoreTableToPointInTime` into a new table | The restored table matches the chosen point |
| S3 from a backup copy | Copy objects with the Phase 0 layout (`<backup-bucket>/<source-bucket>/<timestamp>/`), overwrite and delete some originals, then restore from the copy | Object count and SHA-256 of every object equal; time taken |
| Switch back | How a restored table or bucket would be put into service | Recorded as a procedure only. No production restore is rehearsed |

The output is a recovery runbook, `phase-4-recovery.md`, merged before Phase 4 exits.

### Destroy and recreate

At the end, every sandbox stack and resource is destroyed. Imported resources that are retained are deleted
explicitly. The whole rehearsal is then recreated from the repository and passes again.

Production is checked unchanged with a READ-ONLY `compare:config` against the Phase 0 baseline. This is the
only production access in this phase, and it is optional.

## 3. Not in scope

- Any production change, including creating an AWS Organization in `800960611664`.
- Phase 5 imports. This phase produces the CDK code and the evidence they need.
- CloudFront, its function, certificates and DNS (unmanaged under ADR 0008).
- Runtime improvements, #21 and Phase 7 changes, such as moving the diagnosis Lambda off the S4R role.

## 4. STOP conditions

Stop, change nothing more, and report on #34 if any of these happens:

1. `sts get-caller-identity` returns `800960611664`, or anything other than the recorded sandbox ID.
2. Any credential or profile in use resolves to production.
3. A template, change set or command names account `800960611664`, a production ARN, or an entry of
   [`s4r-denylist.json`](../s4r-denylist.json). The sandbox stand-ins are the only exception.
4. A step would need production data, production secret values, or a call to an S4R or production endpoint.
5. A step would run an imported `deploy.sh`, or anything from `spares4repairs`.
6. A fact can only be found in `spares4repairs`. Ask first.
7. An import-mode change set contains anything other than `Import` actions, or an update-mode change set
   shows an unexpected `Replace` or `Remove`.
8. A rehearsal fails its pass condition. For example, T1 finds an inline policy removed after an unrelated
   update, or a Function URL host changes on re-import. This is a Phase 5 blocker, recorded and turned into a rule before continuing.
9. The sandbox budget alarm fires.

## 5. Approval points

| Point | Before | Approval |
|---|---|---|
| A | The first sandbox mutation (bootstrap) | Written on #34, after the sandbox account ID and the not-production proof are posted |
| B | Each rehearsal batch (IAM, data, Lambda, controls, recovery, destroy) | Not required by PLAN.md for sandbox work. Each batch's plan and results are posted on #34 |

## 6. Delivery

| PR | Contents |
|---|---|
| This PR | This runbook |
| Next | The sandbox account guard (`tools/migration`), with tests |
| Next | The CDK app (`infra/`): `AcDataStack` and `AcRuntimeStack` as L1 resources with Retain, plus the sandbox stand-in stack. No production deploy configuration |
| Per batch | Results, checker rules and runbook steps |
| Last | `phase-4-recovery.md` |
