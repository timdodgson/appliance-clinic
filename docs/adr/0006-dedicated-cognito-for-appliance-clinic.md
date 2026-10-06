# 0006. Dedicated Cognito for Appliance Clinic

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

AC admin sign-in uses the S4R Cognito user pool and app client. AC treated any signed-in user with no
Cognito groups as an admin. Because the pool belongs to the shop, every shop user could reach the AC
admin, which now controls provider keys, AI routing and paid batch runs. Failed AC sign-ins also count
against shop users, because AC authenticates against the shop pool.

The S4R pool belongs to S4R ([0003](0003-s4r-compatibility-boundary.md)), so nothing in this work may
add groups, clients, triggers or settings to it.

## Decision

1. **Immediate hotfix (Phase 1).** AC grants admin only to an allowlist of Cognito `sub` values held
   in AC's own configuration. Nothing changes in the S4R pool. The fix patches the deployed artefact
   directly. It does not use the monorepo's deploy scripts or an unproven build.
2. **Dedicated pool (Phase 7).** AC gets its own user pool, app client and `admin` group in its own
   CDK stack. The few AC admins are recreated there. There is no migration trigger, because one would
   have to authenticate against the S4R pool. AC is then cut over and default-deny is enforced through
   group membership.
3. **Last step.** After cutover, AC's sign-in policy is pointed at the AC pool, ending AC's
   permissions on the S4R pool.

## Consequences

- Admin access stops depending on shop accounts, and AC login attempts stop touching shop users.
- AC admins sign in again after cutover. Existing sessions end.
- Until Phase 7, AC keeps reading the S4R pool as an external dependency. That reference is
  read-only and transitional.

## Alternatives considered

- **Add an `admin` group to the S4R pool.** Rejected: it modifies S4R.
- **A user-migration trigger.** Rejected: it would authenticate against the S4R pool, and may need
  auth flows enabled on the S4R client.
