# 0002. Separate Appliance Clinic from Spares4Repairs

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Appliance Clinic (AC) was built inside the `spares4repairs` monorepo alongside the Spares4Repairs
(S4R) shop. By October 2026 AC made up about 71% of that repository's code, had its own deployment
scripts, its own AWS resources and its own release cadence. It still shared the shop's
repository, CI, lint and test configuration, Cognito user pool, secret namespace and AWS account.

That coupling makes both products harder to change safely. AC work runs through the shop's CI, which
has been failing on AC lint for every recent run. AC admin access depends on the shop's user pool. And
AC cannot be presented or evolved as a product in its own right.

## Decision

Extract AC into this repository and move AC-owned AWS resources under dedicated CDK management.
Spares4Repairs is not migrated: its repository and AWS estate are boundaries, not things this work
changes or tidies.

The work is split into three concerns that stay separate, in this order:

1. **Extract the code**, runtime-identical to production.
2. **Transfer infrastructure ownership** into CDK, with no change in behaviour.
3. **Improve** security, architecture and documentation.

## Consequences

- AC gets its own history, CI, review process and infrastructure-as-code.
- The `spares4repairs` repository keeps its copy of the AC code, frozen and never deployed from
  again. Its CI stays as it is.
- AC keeps calling S4R services it needs (the parts catalogue, buy links) as an external client.
  See [0003](0003-s4r-compatibility-boundary.md).
- Keeping the three concerns separate means some known problems, such as the shared Cognito pool,
  stay in place until their phase, apart from the critical admin hotfix.

## Alternatives considered

- **Clean up the monorepo in place.** Rejected: it means changing the S4R repository and estate,
  which puts the shop at risk for the sake of AC.
- **Rewrite AC from scratch in a new repository.** Rejected: it throws away a production system and
  its evaluation history, and gives no way to prove behaviour is preserved.
