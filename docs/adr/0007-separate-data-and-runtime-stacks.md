# 0007. Separate data and runtime stacks

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

AC infrastructure mixes long-lived state (customer transcripts, recalls, knowledge and media in S3,
secrets, container repositories) with runtime resources that change often (Lambda code and
configuration, IAM, schedules).

## Decision

Use separate stacks by lifecycle:

| Stack | Contents | Protection |
|---|---|---|
| `AcDataStack` | DynamoDB tables, S3 buckets and their policies, secrets, ECR repositories | Stack policy denies every replacement and deletion |
| `AcRuntimeStack` | IAM roles and inline policies, Lambda functions, Function URLs, permissions, EventBridge rules | Stack policy denies replacement and deletion of URLs, permissions and the diagnosis Lambda |
| `AcAuthStack` (Phase 7) | The new AC Cognito pool | Created, never imported |
| Web stack (only if CloudFront is imported later) | CloudFront distribution and function | See [0008](0008-cloudfront-initially-unmanaged.md) |

- **No CloudFormation exports between stacks.** Physical names are fixed, so stacks reference each
  other's resources by name from shared configuration.
- **Termination protection on.** Every stack has termination protection.
- **No metadata resource.** Analytics reporting is off, so no `CDK::Metadata` resource blocks an
  import-only change set.

## Consequences

- Runtime deployments cannot touch stateful resources at all, and the data stack can carry the
  strictest possible stack policy.
- Imports naturally fall into small groups, one stack at a time.
- Each stack is created with one inert placeholder resource (`AWS::CloudFormation::WaitConditionHandle`),
  because a stack cannot be created empty before resources are imported into it.

## Alternatives considered

- **One stack.** Simpler, but every runtime deploy would carry the stateful resources' risk.
- **Many fine-grained stacks.** Rejected as unnecessary complexity for the size of the system.
- **Cross-stack exports.** Rejected: exports lock both stacks against changes and make later moves
  painful.
