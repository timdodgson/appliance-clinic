# 0005. Dedicated CDK bootstrap for Appliance Clinic

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

AC and S4R share an AWS account. S4R deploys with CDK through the default bootstrap stack,
`CDKToolkit`, with the default qualifier. Running `cdk bootstrap` with defaults from this repository
would update that stack, and S4R deployments depend on it.

## Decision

AC uses its own bootstrap:

```bash
cdk bootstrap --qualifier acclinic --toolkit-stack-name ApplianceClinicToolkit
```

The CloudFormation execution role of that toolkit carries **explicit deny statements** on S4R
resources: the `SparesSite-*` stacks, the S4R Cognito pool, and the resources on the generated S4R
denylist. Every AC stack uses a synthesizer configured for the `acclinic` qualifier. The default
`CDKToolkit` is never used or modified by this repository.

## Consequences

- An AC deployment cannot modify S4R resources even if a template is wrong. Isolation is enforced by
  IAM, not only by review.
- AC has its own asset bucket and roles, which cost a little and must be maintained alongside AC.
- The deny list in the execution policy has to be refreshed if S4R adds resources AC could plausibly
  touch. The generated denylist is the source.

## Alternatives considered

- **Reuse the default bootstrap.** Rejected: shared deployment infrastructure couples AC changes to
  S4R, and a re-bootstrap risks S4R deploys.
- **A separate AWS account for AC.** Cleaner, but it would mean moving live resources between
  accounts, which this migration avoids. It can be revisited later.
