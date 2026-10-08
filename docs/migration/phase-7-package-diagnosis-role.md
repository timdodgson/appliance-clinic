# Phase 7 package: a dedicated execution role for the diagnosis Lambda

**Classification: POTENTIALLY IMPACTS S4R.**
- The diagnosis Lambda `spares4repairs-part-finder` serves the S4R `/part-finder` page.
- This package moves it from the S4R role to an AC role. It follows the later change that
  [ADR 0011](../adr/0011-diagnosis-lambda-keeps-the-s4r-execution-role.md) anticipates.
- Nothing here has been executed. The owner signs off before 7.Db.

Evidence was gathered read-only on 2026-10-08 (account `800960611664`, eu-west-1; IAM and CloudTrail for IAM in
us-east-1):
- the code in `services/part-finder/`
- `lambda get-function-configuration` and `get-policy`; environment key names only
- `iam get-role`, `get-role-policy`, `list-attached-role-policies` and `get-policy-version`
- `secretsmanager describe-secret` and `list-secrets`, names and ARNs only (no value was read)
- `kms list-aliases` and `describe-key`
- `s3api get-bucket-encryption` and `list-objects-v2`, counts only
- CloudTrail `lookup-events`
- Logs Insights counts
- `iam simulate-custom-policy` and `simulate-principal-policy`

## Summary

- **The diagnosis Lambda uses 3 secrets, 3 S3 paths in one AC bucket, and its own log group.** Nothing else.
  - The 3 secrets are `applianceclinic-ai-config`, `applianceclinic-jev` and, when routed to the frontier provider,
    `applianceclinic-openai`.
  - The bucket is `whichpart-learning-800960611664`: `learning/*` written, plus two read-only admin overlays.
- **Its role, `SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib`, grants it far more:** every `spares4repairs/*`
  secret (including write), S4R DynamoDB tables and buckets, SES, SNS, Cognito admin on the S4R pool, ECS RunTask and
  more.
- **Proposed:** a new role `ac-diagnosis-role`, owned by `AcRuntimeStack`, with 5 inline policies. 31 of 31 simulations
  match the expectation.
  - every required action and resource is allowed
  - every S4R resource tested is denied
  - everything the code needs is allowed on the S4R role today, so the move removes no required permission
- **Two change sets.**
  - **7.Da** adds the role. SAFE AC CHANGE: nothing references it yet.
  - **7.Db** changes only the function's `Role`. POTENTIALLY IMPACTS S4R. Lambda updates `Role` in place.
- **The S4R role is not written by either change.** The three AC policies on it stay until a later, separate S4R cleanup.
- **Rollback is a direct `UpdateFunctionConfiguration` by the owner, not CloudFormation.** `ac-deny-s4r` gives the
  CloudFormation execution role an explicit deny on `iam:PassRole` for `role/SparesSite-*`. Rollback takes seconds.

## 1. What the diagnosis Lambda actually uses

### From the code (`services/part-finder/`, the files `deploy.sh` ships)

| AWS API | Resource | Where | When |
|---|---|---|---|
| `secretsmanager:GetSecretValue` | `spares4repairs/dev/applianceclinic-ai-config` | `admin-config.js:18,77` | Every cold start, then at most every 60 s (`AI_CONFIG_CACHE_TTL_MS`) |
| `secretsmanager:GetSecretValue` | `spares4repairs/dev/applianceclinic-jev` | `admin-config.js:20,100` | Same |
| `secretsmanager:GetSecretValue` | `spares4repairs/dev/applianceclinic-openai` | `admin-config.js:19,88` | Only when ai-config routes UNDERSTAND or COMPOSE to `frontier` |
| `s3:PutObject` | `whichpart-learning-800960611664/learning/dt=…/…json` and `learning/feedback/dt=…/…json` | `part-finder-lambda.js:7948,7987` | Each turn (learning trace) and each feedback post |
| `s3:GetObject` | `…/knowledge-admin/published.json` | `retrieval.js:118,191` | Overlay refresh (TTL-cached) |
| `s3:GetObject` | `…/media-admin/state.json` | `media-effective.js:16`, `retrieval.js:304` | Overlay refresh (10 s TTL) |
| `s3:ListBucket` (prefix `knowledge-admin`, `media-admin`) | the bucket | implicit | Lets a missing overlay read as `NoSuchKey` (baseline in use) instead of `AccessDenied` (`deploy.sh` comment) |
| `logs:CreateLogStream` and `logs:PutLogEvents` | `/aws/lambda/spares4repairs-part-finder` | Lambda runtime | Every execution environment |

**Configuration facts:**
- **Environment:** `STAGE` is unset, so it defaults to `dev`, hence the `spares4repairs/dev/…` IDs. `LEARNING_BUCKET` is
  `whichpart-learning-800960611664`. The other keys are `LM_MAX_TOKENS` and `LM_STUDIO_URL`.
- **Not used:** DynamoDB, SSM, SQS, SNS, SES, Cognito, EC2 or ENI (no VPC), X-Ray (`PassThrough`), layers, EFS or a
  DLQ.
- **External calls:** Jev, the embeddings tunnel, OpenAI and the S4R catalogue API `65vnizdmk4` (`/api/search`,
  `/api/parts-for-model`) are public HTTPS. They need no IAM.
- **The secret `applianceclinic-canonical-state-token` is not read by this function.** It belongs to `whichpart-api`.

**KMS:**
- All three secrets use the AWS-managed key `alias/aws/secretsmanager` (`KmsKeyId` unset).
- Environment variables use `alias/aws/lambda` (`KMSKeyArn` unset).
- The bucket uses SSE-S3 (`AES256`).
- **No KMS statement is needed:** AWS-managed key policies allow use through the owning service by any principal in the
  account.

### From runtime evidence

**CloudTrail management events,** username `spares4repairs-part-finder` (the Lambda's role session name), eu-west-1. The
`SparesSite` role is the session issuer of every event:

**Coverage.**
- **Complete for 2026-09-24 to 2026-10-08:** 13,904 events, which includes the 2026-10-04 batch day.
- **For the whole 90 days:** targeted `EventName` lookups.
- **Why not page all 90 days:** busy days carry about 2,500 events for this session alone. `lookup-events` is limited to
  2 requests a second, so paging all 90 days was stopped.

| Event | Resource | Count (09-24 to 10-08) | Last | Errors |
|---|---|---:|---|---|
| `secretsmanager:GetSecretValue` | `spares4repairs/dev/applianceclinic-ai-config` | 3,295 | 2026-10-08 17:30Z | 0 |
| `secretsmanager:GetSecretValue` | `spares4repairs/dev/applianceclinic-jev` | 3,295 | 2026-10-08 17:30Z | 0 |
| `secretsmanager:GetSecretValue` | `spares4repairs/dev/applianceclinic-openai` | 5 | 2026-10-05 21:20Z | 0 |
| `kms:Decrypt` (by Secrets Manager) | `alias/aws/secretsmanager` | 6,595 | 2026-10-08 17:30Z | 0 |
| `logs:CreateLogStream` | `/aws/lambda/spares4repairs-part-finder` | 359 | 2026-10-08 17:08Z | 0 |
| `kms:Decrypt` (environment variables at init) | `alias/aws/lambda` | 355 | 2026-10-08 17:08Z | 0 |

**What the counts show:**
- The OpenAI secret is read only while the ai-config routes a stage to `frontier`, as the code says. This happened on
  2026-10-05.
- No other event name and no error appears in the window.

**90-day `EventName` lookups:** none of these has an event by this session.
- `GetParameter`, `GetParameters`
- `PutSecretValue`, `CreateSecret`, `UpdateSecret`
- `AdminInitiateAuth`, `AdminGetUser`, `ListUsers`
- `RunTask`, `SendEmail`, `SendRawEmail`, `DescribeTable`
- `CreateInvalidation` (us-east-1)

The only other event is `logs:CreateLogGroup`, once, on 2026-08-20 16:54Z, when the function was created.

- **IAM and STS (us-east-1):** no event under that session name.
- **S3 object-level calls** are data events. The account has **no trail**, so they are not recorded.
- **Instead, the learning bucket shows the writes:** 37 objects under `learning/dt=2026-10-08/` on the day of this
  analysis. The last one was written at 17:30:54Z, the same second as the function's last invocation.
- **The overlays:** `knowledge-admin/` holds 4 objects; `media-admin/` is empty today, so reads return `NoSuchKey`.

**Actions × resources actually consumed** (code ∪ runtime):

| Action | Resource |
|---|---|
| `secretsmanager:GetSecretValue` | `…:secret:spares4repairs/dev/applianceclinic-ai-config-s40OwY`, `…-jev-xC5VuF`, `…-openai-ZuCaaY` |
| `kms:Decrypt` (via Secrets Manager and Lambda) | AWS-managed keys only. No IAM grant needed |
| `s3:PutObject` | `arn:aws:s3:::whichpart-learning-800960611664/learning/*` |
| `s3:GetObject` | `…/knowledge-admin/published.json`, `…/media-admin/*` (`state.json` is the only key read) |
| `s3:ListBucket` | the bucket, prefixes `knowledge-admin*` and `media-admin*` |
| `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents` | `/aws/lambda/spares4repairs-part-finder` |

## 2. The S4R role today

`arn:aws:iam::800960611664:role/SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib`
- created 2026-07-20 by the `SparesSite-dev` stack
- description "Spares4Repairs dev server function role"
- last used 2026-10-08

**Trust:** `lambda.amazonaws.com`, `sts:AssumeRole`, **no condition**.

**Users:** the S4R server Lambda `spares4repairs-server-dev`, and the diagnosis Lambda.

| Policy | Type | Grants (summary) | Used by the diagnosis Lambda? |
|---|---|---|---|
| `AWSLambdaBasicExecutionRole` | AWS-managed | `logs:CreateLogGroup`, `CreateLogStream` and `PutLogEvents` on `*` | **Yes:** its own log group |
| `AWSLambdaVPCAccessExecutionRole` | AWS-managed | The same logs actions, plus ENI management (`ec2:*NetworkInterface*`, `DescribeSubnets`, …) on `*` | No (no VPC) |
| `ServerFunctionRoleDefaultPolicy975E5328` | Inline, stack-managed | S3 read on `spares4repairs-assets-dev`; SSM `GetParameter(s)` on `spares4repairs/dev/*`; **`secretsmanager:GetSecretValue` on `secret:spares4repairs/dev/*`**; Cognito admin auth on the S4R pool; DynamoDB on the baskets, orders and audit tables and streams; S3 read and write on `spares4repairs-catalogue-snapshots-dev` | **Only the `spares4repairs/dev/*` GetSecretValue statement** |
| `SecretsManagerWrite` | Inline, by hand | `GetSecretValue`, `PutSecretValue`, `CreateSecret` and `UpdateSecret` on `secret:spares4repairs/*` | Overlaps the above for reads. Write is never used |
| `AnalyticsDynamoDBAccess`, `EnquiriesDynamoDB`, `HolidaysDynamoDBAccess`, `JobsModuleDynamoDBAccess` | Inline, by hand | DynamoDB on S4R analytics, enquiries, holidays, customers, jobs and till tables | No |
| `CloudFrontManage`, `PublishPermissions` | Inline, by hand | Invalidations on `E2I3MGU4AZR2ZW`; S3 on `spares4repairs-publication-dev(-b)` | No |
| `CloudWatchMetrics`, `CostExplorer`, `CostExplorerAccess` | Inline, by hand | `cloudwatch:GetMetricStatistics` and `ListMetrics`; `ce:GetCostAndUsage` and `GetCostForecast` | No |
| `CognitoAdminAuth`, `CognitoUserManagement` | Inline, by hand | Admin and user management on the S4R pool `eu-west-1_mUWucohuX` | No |
| `ECSRunGenerator` | Inline, by hand | `ecs:RunTask` (generator), `iam:PassRole` (generator roles), DynamoDB on site-gen-status | No |
| `ImagesReadAccess` | Inline, by hand | S3 read, write and delete on `spares4repairs-images-dev` | No |
| `JobsModuleSNSAccess`, `SESEmailSend` | Inline, by hand | `sns:Publish` on `*`; `ses:SendEmail` and `SendRawEmail` on `*` | No |
| **`WhichpartLearningPut`** | **Inline, AC, by hand (2026-08-26)** | See below | **Yes** |
| **`whichpart-media-overlay-s3`** | **Inline, AC, `deploy.sh:52`** | See below | **Yes** |
| **`whichpart-knowledge-overlay-s3`** | **Inline, AC, `deploy.sh:57`** | See below | **Yes** |

**The three AC policies, exactly as they are live (all inline; none managed):**

`WhichpartLearningPut`:
```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::whichpart-learning-800960611664/learning/*"}]}
```
`whichpart-media-overlay-s3`:
```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::whichpart-learning-800960611664/media-admin/*"},{"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::whichpart-learning-800960611664","Condition":{"StringLike":{"s3:prefix":["media-admin","media-admin/*"]}}}]}
```
`whichpart-knowledge-overlay-s3`:
```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::whichpart-learning-800960611664/knowledge-admin/published.json"},{"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::whichpart-learning-800960611664","Condition":{"StringLike":{"s3:prefix":["knowledge-admin","knowledge-admin/*"]}}}]}
```

## 3. Proposed role: `ac-diagnosis-role`

**Design choices:**
- **Inline policies** (`AWS::IAM::RolePolicy`), as for every AC role in `AcRuntimeStack`.
- **No managed policies.** The logs grant is a scoped equivalent of `AWSLambdaBasicExecutionRole`.
- **The three S3 policies keep their names and documents byte for byte.** `services/part-finder/deploy.sh:50-57` runs
  `put-role-policy` on **whatever role the function has**. After the move it writes identical documents to the AC role
  (no drift), and **it stops writing to the S4R role**.

**Trust.** `aws:SourceAccount` limits assumption to Lambda acting for this account. `aws:SourceArn` is left out:
Lambda's role assumption is not documented to carry it, and a wrong condition would block the function.
```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"800960611664"}}}]}
```

`ac-diagnosis-logs`. The `:*` form is the scoping the Lambda console generates. It covers the log group and its streams:
```json
{"Version":"2012-10-17","Statement":[{"Sid":"DiagnosisLogs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:eu-west-1:800960611664:log-group:/aws/lambda/spares4repairs-part-finder:*"}]}
```

`ac-diagnosis-secrets`, with full ARNs from `describe-secret`. If a secret is ever deleted and recreated its suffix
changes, and this policy must change with it. That is acceptable for 3 named secrets and is the narrowest grant.
```json
{"Version":"2012-10-17","Statement":[{"Sid":"DiagnosisSecrets","Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":["arn:aws:secretsmanager:eu-west-1:800960611664:secret:spares4repairs/dev/applianceclinic-ai-config-s40OwY","arn:aws:secretsmanager:eu-west-1:800960611664:secret:spares4repairs/dev/applianceclinic-openai-ZuCaaY","arn:aws:secretsmanager:eu-west-1:800960611664:secret:spares4repairs/dev/applianceclinic-jev-xC5VuF"]}]}
```

`WhichpartLearningPut`, `whichpart-media-overlay-s3` and `whichpart-knowledge-overlay-s3`: the three documents in §2,
unchanged.

**Left out on purpose:**
- **KMS:** AWS-managed keys only.
- **VPC/ENI:** no VPC.
- **SSM, DynamoDB, Cognito, SES, SNS:** unused.

**Possible later tightening, as a SAFE AC CHANGE once the move is proven:**
- `media-admin/*` → `media-admin/state.json`
- a namespace move of the three secrets to `applianceclinic/*` (the Phase 7 secrets item, which this move unblocks)

## 4. IAM simulation (2026-10-08)

**How it was run:**
- **New:** `simulate-custom-policy` with the five proposed documents.
- **S4R:** `simulate-principal-policy` on the live S4R role.
- **Context:** `s3:ListBucket` was simulated with an `s3:prefix` context value.
- **Logs resource form:** the log actions use the log-group form (`…:log-group:NAME:*`). The simulator maps these
  actions to the log-group resource type: it reports a stream-form ARN as `implicitDeny` even for `Resource: "*"`
  policies, so that form says nothing.

| Expect | Action | Resource (prefix) | New role | S4R role |
|---|---|---|---|---|
| allow | `logs:CreateLogGroup` | `log-group:/aws/lambda/spares4repairs-part-finder:*` | allowed | allowed |
| allow | `logs:CreateLogStream` | same | allowed | allowed |
| allow | `logs:PutLogEvents` | same | allowed | allowed |
| allow | `secretsmanager:GetSecretValue` | `applianceclinic-ai-config-s40OwY` | allowed | allowed |
| allow | `secretsmanager:GetSecretValue` | `applianceclinic-openai-ZuCaaY` | allowed | allowed |
| allow | `secretsmanager:GetSecretValue` | `applianceclinic-jev-xC5VuF` | allowed | allowed |
| allow | `s3:PutObject` | `learning/dt=…/x.json` | allowed | allowed |
| allow | `s3:PutObject` | `learning/feedback/dt=…/x.json` | allowed | allowed |
| allow | `s3:GetObject` | `knowledge-admin/published.json` | allowed | allowed |
| allow | `s3:GetObject` | `media-admin/state.json` | allowed | allowed |
| allow | `s3:ListBucket` | bucket (`knowledge-admin/published.json`) | allowed | allowed |
| allow | `s3:ListBucket` | bucket (`media-admin/state.json`) | allowed | allowed |
| deny | `secretsmanager:GetSecretValue` | `spares4repairs/dev/db-F6asfI` | implicitDeny | **allowed** |
| deny | `secretsmanager:GetSecretValue` | `spares4repairs/dev/stripe-LvGdUb` | implicitDeny | **allowed** |
| deny | `secretsmanager:GetSecretValue` | `applianceclinic-canonical-state-token-QEtfiF` | implicitDeny | **allowed** |
| deny | `secretsmanager:GetSecretValue` | `applianceclinic-benchmark-service-OAWAo9` | implicitDeny | **allowed** |
| deny | `secretsmanager:PutSecretValue` | `applianceclinic-jev-xC5VuF` | implicitDeny | **allowed** |
| deny | `s3:GetObject` | `learning/dt=…/x.json` | implicitDeny | implicitDeny |
| deny | `s3:PutObject` | `knowledge-admin/published.json` | implicitDeny | implicitDeny |
| deny | `s3:PutObject` | `media-admin/state.json` | implicitDeny | implicitDeny |
| deny | `s3:GetObject` | `knowledge-admin/drafts.json` | implicitDeny | implicitDeny |
| deny | `s3:ListBucket` | bucket (`learning/`) | implicitDeny | implicitDeny |
| deny | `s3:DeleteObject` | `learning/dt=…/x.json` | implicitDeny | implicitDeny |
| deny | `s3:GetObject` | `spares4repairs-images-dev/x.jpg` | implicitDeny | **allowed** |
| deny | `logs:PutLogEvents` | `log-group:/aws/lambda/spares4repairs-server-dev:*` | implicitDeny | **allowed** |
| deny | `logs:CreateLogGroup` | `log-group:/aws/lambda/other-function:*` | implicitDeny | **allowed** |
| deny | `dynamodb:GetItem` | `table/spares4repairs-orders-dev` | implicitDeny | **allowed** |
| deny | `ssm:GetParameter` | `parameter/spares4repairs/dev/x` | implicitDeny | **allowed** |
| deny | `ses:SendEmail` | `*` | implicitDeny | **allowed** |
| deny | `sns:Publish` | `*` | implicitDeny | **allowed** |
| deny | `ec2:CreateNetworkInterface` | `*` | implicitDeny | **allowed** |

**Result: 31 of 31 match the expectation on the new role.**
- Every allow on the new role is also allowed on the S4R role today, so the move removes no permission the code needs.
- The S4R role allows 13 of the 19 "deny" rows. That is the excess the diagnosis Lambda holds today.
- Splitting the policies differently (for example merging the S3 statements) gives identical decisions; this was
  checked.

**The deployment principals (`simulate-principal-policy` on `cdk-acclinic-cfn-exec-role-…`):**
- `iam:PassRole`, `iam:CreateRole` and `iam:PutRolePolicy` on the S4R role: **explicitDeny** (`ac-deny-s4r`).
- The same actions on `role/ac-diagnosis-role`, and `lambda:UpdateFunctionConfiguration` on the function: implicitDeny
  today. Each change's temporary grant supplies them (§5).

## 5. CDK and IAM diff

**Code changes (reviewed edits, as for 7.2 to 7.7):**

| File | Change |
|---|---|
| `infra/cdk/config/runtime-overrides.json` | Add `roles["ac-diagnosis-role"]` (trust, `managed: []`, the five inline documents above, description) and `functions["spares4repairs-part-finder"].role = "ac-diagnosis-role"` (7.Db only) |
| `infra/cdk/lib/overrides.js` | Support `roles.<name>`: add a role absent from the capture, or set its desired state. Support `functions.<name>.role`: set `configuration.Role` |
| `infra/cdk/lib/runtime-stack.js` | Keep the `CfnRole` and `CfnRolePolicy` objects in a map. When a function's role is a role in this stack, use `role.attrArn` (a `GetAtt`, so CloudFormation orders it after the role) and `addDependency` on that role's `CfnRolePolicy` resources, so the function never runs on the role before its policies exist |
| `infra/production/capture-runtime.sh` | Add `ac-diagnosis-role` to `ROLES`. It is skipped until it exists, then captured like the other AC roles |
| `infra/production/changes/7.Da-diagnosis-role.json`, `7.Db-diagnosis-role-switch.json` | Change specs (below) |
| `services/part-finder/deploy.sh` | No change needed (§3). Optional later: drop the `put-role-policy` lines, since CDK owns them |

**Change 7.Da: add the role.** SAFE AC CHANGE: nothing uses the role yet.

| Item | Value |
|---|---|
| Expected changes | Add `acdiagnosisrole` (`AWS::IAM::Role`). Add 5 × `AWS::IAM::RolePolicy`: `acdiagnosisroleacdiagnosislogs`, `acdiagnosisroleacdiagnosissecrets`, `acdiagnosisroleWhichpartLearningPut`, `acdiagnosisrolewhichpartmediaoverlays3`, `acdiagnosisrolewhichpartknowledgeoverlays3`. Nothing else |
| Grant | `iam:CreateRole`, `iam:GetRole`, `iam:PutRolePolicy`, `iam:GetRolePolicy` on `arn:aws:iam::800960611664:role/ac-diagnosis-role` |
| Writes expected | `iam:CreateRole`, `iam:PutRolePolicy` × 5 (us-east-1), on `ac-diagnosis-role` only |
| Forbidden | Any write on `SparesSite-*` or `spares4repairs-part-finder`; `iam:AttachRolePolicy`, `iam:DeleteRolePolicy`, `iam:UpdateAssumeRolePolicy` |
| Check | Drift `IN_SYNC`; no-op confirmed; `get-role` and `get-role-policy` equal to §3; S4R role policy list and documents unchanged (20 inline, 2 attached) |

**Change 7.Db: switch the function's role.** POTENTIALLY IMPACTS S4R.

| Item | Value |
|---|---|
| Expected changes | Modify `spares4repairspartfinder` (`AWS::Lambda::Function`), **Replacement False**, details `Properties.Role` only. `Role` is an update without interruption; the function name, URL host, ARN, permissions and code stay |
| Grant | `lambda:UpdateFunctionConfiguration`, `lambda:GetFunction`, `lambda:GetFunctionConfiguration` on the function; `iam:PassRole` on `role/ac-diagnosis-role` with `iam:PassedToService = lambda.amazonaws.com` |
| Writes expected | `lambda:UpdateFunctionConfiguration` on `spares4repairs-part-finder` only |
| Forbidden | `lambda:AddPermission`, `RemovePermission`, `UpdateFunctionUrlConfig`, `UpdateFunctionCode`, `DeleteFunction`; any IAM write; any write on `SparesSite-*` or `65vnizdmk4` |
| Before and after | `/part-finder` contract, `/ai/chat` ingress, S4R health, smoke (§8); the function's `Role` reads the new ARN; a log line from a new execution environment |

**Why two change sets.**
- **Propagation.** A role that has just been created can be refused by Lambda for a few seconds ("cannot be assumed").
  Creating it in 7.Da and switching in 7.Db, minutes later, removes that race from the S4R-facing step.
- **Rollback.** If 7.Db fails, CloudFormation's own rollback would set `Role` back to the S4R ARN. That needs
  `iam:PassRole` on the S4R role, which `ac-deny-s4r` explicitly denies to the execution role. A failed 7.Db can
  therefore end in `UPDATE_ROLLBACK_FAILED` (recovery in §7).
- **Keeping 7.Db to one resource and one property** keeps that case small and easy to recover.

**IAM diff (whole plan):**
- **New:** role `ac-diagnosis-role` and its 5 inline policies.
- **Changed:** nothing.
- **Removed:** nothing.
- **The three AC policies stay on the S4R role** until the separate S4R cleanup ADR 0011 describes. This package does
  not propose removing them.

## 6. Why the S4R role need not change

- **No write targets it.**
  - 7.Da writes only `role/ac-diagnosis-role`.
  - 7.Db writes only `function:spares4repairs-part-finder`.
  - Neither template declares the S4R role. The function's `Role` property is the only place its ARN appears, and 7.Db
    replaces it.
- **Writes to it are blocked anyway.** `ac-deny-s4r` explicitly denies every action on `role/SparesSite-*` to all CDK
  roles (simulated: explicitDeny).
- **CloudTrail would show any write.** The us-east-1 CloudTrail check (`check-cloudtrail.sh`) lists IAM writes; `SparesSite` is a forbidden
  resource in both specs.
- **The S4R server function keeps using the role unchanged:**
  - `spares4repairs-server-dev` is unaffected.
  - The S4R role keeps every statement, including the three AC ones, which then serve no AC function (ADR 0011
    already records that the S4R server can use them).
- **No S4R stack interaction.**
  - `SparesSite-dev` manages only `ServerFunctionRoleDefaultPolicy975E5328` on that role.
  - An S4R redeploy can no longer break the diagnosis Lambda's permissions once it is on the AC role. This removes the
    ADR 0011 consequence.
- **The S4R role stays usable after the move:** removing it from the diagnosis Lambda leaves its trust and policies
  intact, so rollback (§7) remains a one-call operation.

## 7. Rollback

**Normal case: after a successful 7.Db, if any after-check fails.** The owner's IAM user, which is not subject to
`ac-deny-s4r` (simulated: `iam:PassRole` and `lambda:UpdateFunctionConfiguration` allowed), runs one call:

```bash
aws lambda update-function-configuration --region eu-west-1 --function-name spares4repairs-part-finder \
  --role arn:aws:iam::800960611664:role/SparesSite-dev-ServerFunctionRoleC337EDB9-7aUzUc2qUHib
aws lambda wait function-updated --region eu-west-1 --function-name spares4repairs-part-finder
```

- **Timing:** the update completes in seconds. New execution environments pick up the old role at once; warm ones are
  recycled by the configuration change.
- **Then:** the stack shows `Role` drift. Restore the template to the S4R ARN, reverting `functions.…role` in the
  overrides, and record the drift. A change set cannot re-apply the S4R ARN (PassRole is denied).
- **Leave 7.Da's role in place:** it is unused, and it allows a retry.

**Failed-change case: 7.Db fails and the stack reaches `UPDATE_ROLLBACK_FAILED`.**
1. Run the same direct call if `Role` changed.
2. Run `aws cloudformation continue-update-rollback --stack-name AcRuntimeStack --resources-to-skip spares4repairspartfinder`.
3. Confirm the template, live state and drift.

If 7.Db fails before Lambda accepts the change (PassRole or assume validation), the function is unchanged.

**What to check after rollback:**
- `get-function-configuration` `Role` is the S4R ARN, and `LastUpdateStatus` is `Successful`.
- `/part-finder` contract verify.
- `/ai/chat` ingress verify.
- S4R health 3 × 200.
- A new `evt: "part-finder"` log line with `ok: true`.
- CloudTrail: GetSecretValue by session `spares4repairs-part-finder` with the S4R issuer, and no `AccessDenied`.

## 8. Tests, timing, risks

**Before and after 7.Db** (from `tools/migration`, `--live`):

| Check | Command | Pass |
|---|---|---|
| S4R health | `npm run baseline -- s4r-health --live` | 3 × 200, as baseline |
| `/part-finder` contract | `npm run baseline -- contract verify --live` | Preflight CORS unchanged; POST 200 `application/x-ndjson`; `delta`… `done`; no done, part or understood field lost |
| `/ai/chat` ingress | `npm run baseline -- ingress verify --live` | Still the recorded 500 / JSON / `message` (unchanged by design; see the [`/ai/chat` package](phase-7-package-ai-chat.md)) |
| Customer smoke | `npm run baseline -- smoke --live` | Equal to the pre-Phase-5 baseline (4 scenarios, safety as expected) |
| Role in use | `get-function-configuration --query Role`; CloudTrail eu-west-1 `GetSecretValue` by username `spares4repairs-part-finder` | Session issuer `ac-diagnosis-role`, no `errorCode` |
| Learning write | `list-objects-v2 … --prefix learning/dt=<today>/`, count and newest timestamp | A new object after the contract call |
| Errors | Logs Insights over 15 minutes: `AccessDenied`, `learning-trace write failed`, overlay `failed` | 0 |

**Timing.**
- **Diagnosis Lambda, last 14 days (UTC):** activity is sparse and batch-driven.
  - It was active on only 9 of 14 days.
  - 01:00 and 04:00 to 06:00 were active on one day each; 00:00 and 02:00 on two; 03:00 on three.
  - 16:00 to 17:00 and 20:00 to 21:00 are the busiest.
- **S4R API `65vnizdmk4`:** it averaged 0 to 2 requests an hour from 00:00 to 05:59 UTC, against 240 to 650 an hour
  from 07:00 to 15:59.
- **Window: 7.Db at 02:00 to 05:00 UTC** (03:00 to 06:00 UK time until 25 October), on a day with no batch run
  scheduled. Run 7.Da any time before.

**Risks:**

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| A newly created role is refused by Lambda | Low with 7.Da run first | 7.Db fails before the change; function unchanged | Separate 7.Da; wait at least 5 minutes |
| A missing permission (for example a frontier route needs the OpenAI secret) | Low (simulated; the OpenAI ARN is included) | The diagnosis reply degrades or errors; the `/part-finder` contract fails | Contract and smoke checks; one-call rollback |
| Secret ARN suffix change (a secret recreated) | Very low | Secret reads denied | Recorded in §3; check `describe-secret` before 7.Db |
| Cold start after the configuration change | Certain, brief | The first requests on new environments take about 1 to 2 s longer | Off-hours window |
| CloudFormation rollback blocked by `ac-deny-s4r` | Only if 7.Db fails mid-update | `UPDATE_ROLLBACK_FAILED` | §7 recovery; 7.Db limited to one property |
| `deploy.sh` run during the window | Low | Overlay policies written to whichever role is current | Freeze `deploy.sh` for the window; its documents equal CDK's |
| Account concurrency (10, shared) | Existing | Throttling during checks | Off-hours; checks are a handful of requests |
| Jev outage during checks (as on 2026-10-08) | External | False failure (503) | Check the Jev status lines in the logs before deciding to roll back |

**Classification: POTENTIALLY IMPACTS S4R.**
- 7.Da on its own is a SAFE AC CHANGE.
- 7.Db needs the owner's explicit sign-off, the before and after checks above, and the rollback command ready in a
  terminal.
