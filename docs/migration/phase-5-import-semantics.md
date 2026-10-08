# Phase 5 import semantics

What CloudFormation writes when it imports an existing resource, for every Phase 5 resource type, rehearsed in the sandbox
before any further production import (#46, #47). Expected writes per type, in machine form:
[`phase-5-import-writes.json`](phase-5-import-writes.json).

## Why

Production step 5.1 (#47) stopped. The change set held one Import and passed the checker. Then, after `IMPORT_COMPLETE`,
CloudFormation ran the repository's **update handler** ("Apply stack-level tags to imported resource if applicable") and
tried `ecr:DeleteRepositoryPolicy`. The template left the Lambda-written repository policy undeclared, so the handler set
the repository to "no policy". The read-only execution role refused it, and the import rolled back with nothing changed.

Phase 4 had concluded "import actions only, then drift `IN_SYNC`" was enough. It was not. Its execution role could
write, so every post-import update succeeded unseen, and its repositories had no policy yet when they were imported.
**The statement on #47 that the policy "stays undeclared and unmanaged, as rehearsed in Phase 4" is disproven.**

## Method

[`infra/sandbox/probe/`](../../infra/sandbox/probe/), as `ac-operator-sbx`:

1. Create the sandbox copy of the step's resources outside CloudFormation, **shaped as production is live**:
   - untagged
   - ECR repositories carrying the Lambda repository policy
   - secret descriptions as live, with dummy values
   - production's table, bucket, role, policy, function, URL, permission and rule shapes, from a capture of production
     ([`capture-runtime.sh`](../../infra/production/capture-runtime.sh), name-mapped by
     [`plan-runtime.mjs`](../../infra/sandbox/probe/plan-runtime.mjs))
2. Import with the **production template shape** (the same CDK app, profile `sandbox`) into a stack with **no stack tags**,
   as production has. The execution role is the probe role `ac-import-probe-sbx`: read-only on sandbox resources, plus
   exactly the write actions under test, within the `ac-cfn-execution-sbx` boundary.
3. Record the outcome and every failure event. Take a snapshot of the resources' full configuration before and after,
   and run drift detection.
4. Read every write the probe role made, or tried to make, from CloudTrail
   ([`cloudtrail.sh`](../../infra/sandbox/probe/cloudtrail.sh), as the IAM user).
5. Discover with a candidate write set, then **confirm with only the writes observed**, in production order.

## Results

All runs on 2026-10-07/08, in account `800960611664`, eu-west-1. "Writes" are every non-read call the probe role made,
read from CloudTrail. "Unchanged" means the full before and after snapshots are equal apart from the
`aws:cloudformation:*` tags. Raw records are in `.migration-output/probe/`.

| Step | Type | Read-only, template as Phase 4 | Writes with the template matching live | Confirmed with only those writes | Unchanged | Drift |
|---|---|---|---|---|---|---|
| 5.1 | ECR repository (Lambda-written policy) | **Fails**: `DeleteRepositoryPolicy` refused, rolled back (the production 5.1 result) | `SetRepositoryPolicy`, `PutImageTagMutability`, `PutImageScanningConfiguration`, `TagResource` | Yes | Yes; policy text byte-identical | `IN_SYNC` |
| 5.2 | ECR repository, 7 secrets | — | ECR as 5.1; per secret: `UpdateSecret` (`secretId`, `clientRequestToken`, `description`; never a value) and `TagResource` | Yes | Yes; secret version counts unchanged | `IN_SYNC` |
| 5.3a, 5.3b | DynamoDB tables (both shapes) | Imports, but drift `MODIFIED`: `TableClass` declared, none live | **None** | Yes, read-only | Yes; no tags added | `IN_SYNC` once `TableClass` is omitted |
| 5.4 | S3 buckets, bucket policy | — | `s3:TagResource` per bucket (authorised by `s3:PutBucketTagging`); none for the bucket policy | Yes | Yes | `IN_SYNC` |
| 5.5 | IAM roles (3) | — | **None** (no tags either) | Yes, read-only | Yes | `IN_SYNC` |
| 5.6 | Inline policies (9, `AWS::IAM::RolePolicy`) | — | **None** | Yes, read-only | Yes | `IN_SYNC` |
| 5.7a, 5.7b | Image functions | — | `lambda:TagResource` | Yes | Yes; image digest, `ImageUri` and configuration unchanged | `IN_SYNC` |
| 5.7c | Zip function (with NoEcho token parameters) | — | `lambda:TagResource` | Yes | Yes; CodeSha256, environment and configuration unchanged | `IN_SYNC` |
| 5.8 | Function URLs (3), permissions (8) | — | **None** | Yes, read-only | Yes; URL hosts, auth type, invoke mode and CORS unchanged | `IN_SYNC` |
| 5.9 | Rules (2) | — | `events:TagResource` per rule | Yes | Yes; schedule, state, targets and input unchanged | `IN_SYNC` |
| 5.10 | Diagnosis copy under the stand-in S4R role: function, RESPONSE_STREAM URL, `FnUrlPublic`, `PublicInvoke` | — | `lambda:TagResource` on the function only | Yes | Yes; role, URL host, auth, RESPONSE_STREAM, CORS and CodeSha256 unchanged. `apigateway-invoke` untouched and outside the stack. The stand-in role's policies and the stand-in API's routes unchanged | `IN_SYNC` |
| 5.4 again | Into a stack that already has the stack policy (deny `Update:Replace` and `Update:Delete`) | — | `s3:TagResource` | Yes | Yes | `IN_SYNC` |

Every confirmation run's CloudTrail writes pass `import-writes.mjs check-writes` against the manifest. Real events are kept as
test fixtures ([`import-writes.cloudtrail.json`](../../tools/migration/test/fixtures/sandbox/import-writes.cloudtrail.json)).


## Findings

1. **An import runs the update handler.** CloudFormation imports a resource, then updates it with the execution role.
   Whatever the template leaves undeclared, the handler may reset (ECR: the repository policy is deleted).
2. **A write made before a later failure is not rolled back.** With only `ecr:DeleteRepositoryPolicy` granted, the import
   deleted the sandbox repository's policy, then failed on `ecr:PutImageTagMutability` and rolled back. The policy stayed
   deleted. **Grant a type's complete write set, or none.**
3. **Declaring the live value makes the write identical.** With the policy declared exactly, ECR received
   `SetRepositoryPolicy` with the same document. The repository was semantically unchanged, and drift was `IN_SYNC`.
4. **Most types write nothing, or only tags.**
   - DynamoDB tables, IAM roles and inline policies, Function URLs, permissions and bucket policies: no write at all.
   - Lambda functions (zip and image), rules, buckets and secrets: only the `aws:cloudformation:*` tags. Secrets also get
     an `UpdateSecret` carrying the description, never a value.
5. **Lambda tagging bumps `LastModified` and `RevisionId`.** The configuration, CodeSha256, image digest and state are
   unchanged, but the revision changes.
6. **`TableClass` must be omitted** when live has none: declared as `STANDARD`, drift reports `REMOVE`. Production's
   tables have none.
7. **Imported resources gain `aws:cloudformation:*` tags**, and a later capture must not declare them. Otherwise the next
   import sees the earlier resource as modified, and an import change set cannot modify anything. The runtime template
   ignores `aws:` tags.
8. **Physical IDs:**
   - `AWS::IAM::RolePolicy`: `policy|role`
   - `AWS::Lambda::Permission`: the statement ID
   - `AWS::Lambda::Url`: the function ARN
   - `AWS::Events::Rule`: the rule ARN
9. **S3 tagging uses the S3 `TagResource` API**, authorised by `s3:PutBucketTagging`.
10. **A stack policy does not block a later import.** With deny `Update:Replace` and `Update:Delete` in place, the 5.4 import
    still completed. So production can set the stack policy after each step, before the next step's import.
11. **Probe runs must never overlap.** A first confirmation run kept going after a failure and overlapped a second run. Both
    overwrote the shared probe role policy and the token parameters. Their results were discarded and the confirmation was
    run again. The probe now takes a lock, and the confirmation stops at the first failure.
12. **Bearer tokens** in Lambda environments become NoEcho template parameters, filled from the live value at change-set
    time. A Secrets Manager reference could resolve to a different value, and proving otherwise would mean comparing
    secret values.

## What changes for production

- The template carries every live property the update handler would otherwise reset. For ECR that is the repository
  policy.
- **Per step**, `ac-cfn-execution` gets a version with the read-only base plus exactly the manifest's writes on exactly
  that step's resources. Afterwards it goes back to the read-only version.
- After each import, CloudTrail must show only the manifest's writes. Any other action, a forbidden request parameter,
  or a refused call is a STOP. The before and after snapshots may differ only by the `aws:cloudformation:*` tags (and,
  for Lambda, `LastModified` and `RevisionId`).
- **5.10 (diagnosis Lambda):** the only write is `lambda:TagResource` on the function. Granted only with the step's
  sign-off; production 5.10 made exactly that write ([phase-5-results.md](phase-5-results.md#step-510-diagnosis-lambda-2026-10-08-signed-off-on-46)).
