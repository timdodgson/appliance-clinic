# 0004. Import existing AWS resources into CDK

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

AC production runs on resources created by hand-written AWS CLI scripts and the console. They include
two DynamoDB tables holding live data, S3 buckets with content that exists nowhere else, secrets,
four Lambda functions, and Function URLs whose hosts are embedded in clients. One of those clients is
the S4R `/part-finder` page.

## Decision

Bring the existing resources under CDK with **CloudFormation resource import**. Nothing is recreated.

- **L1 `Cfn*` resources** are used for every imported resource, so the template says exactly what
  exists. L2 constructs that silently create IAM policies, Lambda permissions, bucket policies, log
  retention resources, lifecycle rules, generated secrets or URL permissions are not used.
- **Retain everywhere.** Every imported resource has `DeletionPolicy` and `UpdateReplacePolicy` set
  to `Retain`. Physical names stay exactly as they are.
- **No-op import.** The first import describes each resource as it is:
  - zip Lambdas use the downloaded production artefact, so CodeSha256 does not change
  - container Lambdas use the deployed image digest
  - plaintext tokens in Lambda environments become Secrets Manager dynamic references, never literals
- **IAM.** Each existing inline policy is its own `CfnRolePolicy`. `Role.Policies` and `grant*()` are
  never used on imported roles.
- **Small groups.** Imports go in small change sets, in a fixed order: data, then IAM, then Lambdas,
  then URLs and permissions, then EventBridge. The S4R-consumed diagnosis Lambda goes last.
- **Rehearsal first.** Every resource type is rehearsed in a separate sandbox account before any
  production import.
- **Gated.** Every change set passes the change-set checker (imports only, allowlisted physical IDs,
  no S4R identifiers, Retain present, no literal secrets) and a written sign-off. After each import,
  live configuration is compared with the Phase 0 baseline; drift detection alone is not relied on.

## Consequences

- **Rollback is safe.** Removing a resource from the template leaves it running, because of Retain.
- **Configuration changes go through CDK from then on.** That includes the operational switches
  that are Lambda environment variables today: `CANONICAL_MODE`, `CANONICAL_CONTROL_JOURNEYS` and
  the per-journey kill switches. A change made in the console becomes drift, and the next CDK deploy
  silently reverts it. The rollback procedure for those switches therefore becomes a reviewed CDK
  change, or the switches move to a runtime configuration store in a later phase. Switches on the
  diagnosis Lambda remain POTENTIALLY IMPACTS S4R.
- **The old scripts can never run again.** The monorepo's deploy scripts would overwrite
  CDK-managed resources.

## Alternatives considered

- **Recreate resources under new names and cut traffic over.** Rejected: it changes Function URL
  hosts (breaking the S4R page), and needs data migration for the tables and buckets.
- **Generate CDK from the IaC generator and import that.** Rejected as the source of truth: the
  output is hard to review and uses constructs we cannot fully control. It is used as a cross-check
  for property values.
- **Leave the infrastructure unmanaged.** Rejected: there is no reviewable record of production, and
  changes stay manual.
