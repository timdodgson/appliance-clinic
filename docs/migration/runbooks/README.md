# Migration runbooks

Step-by-step procedures for the migration plan in [`../PLAN.md`](../PLAN.md). A person runs every
production AWS command; CI never does.

## Conventions

Every runbook states:

- **Classification** of each step: READ-ONLY, SAFE AC CHANGE, POTENTIALLY IMPACTS S4R or DO NOT DO.
- **Prerequisites**, including which AWS profile to use.
- **Steps** with exact commands.
- **Expected results** and how to verify them.
- **Rollback**, where the step changes anything.

Record every production run as a comment on the step's GitHub issue: the date, the operator, the
command, and the result. Production steps are closed only after written sign-off on the issue.

## AWS profiles

Use separate named profiles so a read-only step cannot change anything even by mistake.

| Profile | Permissions | Used by |
|---|---|---|
| `ac-readonly` | AWS managed `ReadOnlyAccess` | Inventory, denylist, comparisons |
| `ac-readonly-secrets` | `ReadOnlyAccess` plus `secretsmanager:GetSecretValue` on the AC secret ARNs only | Inventory with `--hash-secret-values` |
| `ac-hotfix` | `lambda:GetFunctionConfiguration`, `lambda:PublishVersion`, `lambda:UpdateFunctionConfiguration`, `lambda:UpdateFunctionCode` on `whichpart-api` only; `sts:GetCallerIdentity` | Phase 1 admin hotfix |
| `ac-backup` | `dynamodb:CreateBackup`, `dynamodb:UpdateContinuousBackups` on the two AC tables; `s3:CreateBucket`, `s3:PutBucketPublicAccessBlock` on the backup bucket; `s3:GetObject`/`s3:ListBucket` on the AC buckets; `s3:PutObject` on the backup bucket | Backups |

The tooling also enforces this in code: inventory clients refuse any non-read command, and the
backup tool only allows its named commands.

## Where output goes

Tooling writes to `.migration-output/` at the repository root, which is gitignored. It holds
account identifiers, downloaded Lambda code and configuration, so it is never committed. Curated
results (ownership evidence, the denylist) are copied into `docs/migration/` by hand and reviewed
in a pull request.

## Rules that apply to every runbook

- Never run anything from the `spares4repairs` repository, and never use it as a deployment source.
- Never touch an S4R resource. If a command would, stop.
- If ownership of a resource is unclear, stop and treat it as S4R.

## Index

| Runbook | Phase | Classification |
|---|---|---|
| [Freeze](phase-0-freeze.md) | 0 | Process only |
| [Inventory and ownership proof](phase-0-inventory.md) | 0 | READ-ONLY |
| [Backups](phase-0-backups.md) | 0 | SAFE AC CHANGE |
| [Behavioural baseline and S4R contract](phase-0-baseline.md) | 0 | SAFE AC CHANGE (customer-equivalent traffic) and READ-ONLY (S4R checks) |
| [Admin allowlist hotfix](phase-1-admin-hotfix.md) | 1 | SAFE AC CHANGE (`whichpart-api` only) |
| [Runtime-identical extraction](phase-2-extraction.md) | 2 | Repository only (`spares4repairs` read with `git archive`) |
| [Reproducible builds and tests](phase-3-reproducible-build.md) | 3 | Repository only |
| [Sandbox rehearsal](phase-4-sandbox-rehearsal.md) | 4 | Sandbox-namespaced (`-sbx`) resources only; no production AC or S4R change |
| [Recovery](phase-4-recovery.md) | 4 (used from 5) | SAFE AC CHANGE (restore into new resources); POTENTIALLY IMPACTS S4R (switch-back) |
| [Production CDK import](phase-5-import.md) | 5 | SAFE AC CHANGE (5.1 to 5.9); POTENTIALLY IMPACTS S4R (5.10) |
| [Prove CDK ownership](phase-6-ownership-proof.md) | 6 | SAFE AC CHANGE (one inert tag, added and removed) |
| [Security hardening](phase-7-security.md) | 7 | SAFE AC CHANGE; the POTENTIALLY IMPACTS S4R packages were prepared, each signed off separately |
| [Architecture cleanup](phase-8-architecture.md) | 8 | SAFE AC CHANGE (`whichpart-api`); POTENTIALLY IMPACTS S4R (diagnosis engine releases, contract checked before and after) |
