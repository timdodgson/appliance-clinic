# Phase 5 results

What the production import (PLAN.md, Phase 5; [runbook](runbooks/phase-5-import.md)) did, step by step. Every step
ran as the IAM user in account `800960611664`, eu-west-1; every resource operation went through CloudFormation with the
read-only `acclinic` execution role. Raw outputs stay in `.migration-output/phase5/`.

## Pre-flight (2026-10-07)

| Gate | Result |
|---|---|
| Pre-Phase-5 inventory | Taken; `compare:config` against the inventory before the Phase 4 sandbox: 0 differences |
| S4R denylist regenerated | 79 entries, identical to the committed denylist |
| Freeze (#2) | Open; routing override lease `released` |
| Backups | PITR continuous on both tables (latest restorable point minutes old); Phase 0 on-demand backups from 01:42Z |
| S4R and AC checks | S4R health 3 × 200; `/part-finder` contract captured (preflight and POST 200, CORS for `https://spares4repairs.co.uk`, NDJSON); `/ai/chat` 500 as in the Phase 0 baseline; smoke: 4 scenarios 200, safety decisions as expected |

## Toolkit: `ApplianceClinicToolkit` (2026-10-07)

Created from [`phase-5/toolkit/`](phase-5/toolkit/) by [`00-toolkit.sh`](../../infra/production/steps/00-toolkit.sh): 11 Add
actions, termination protection on, qualifier `acclinic`. The execution role `cdk-acclinic-cfn-exec-role-…` carries exactly
`ac-cfn-execution` and `ac-deny-s4r`. IAM simulator: `iam:PutRolePolicy` and `iam:PassRole` on the S4R role, `UpdateStack` on
`SparesSite-dev` and `PATCH` on API `65vnizdmk4` are explicitly denied; writes to AC functions and tables, S3 object reads and
`GetSecretValue` are implicitly denied; AC reads are allowed.

| Version | `ac-cfn-execution` change |
|---|---|
| v1 | As reviewed in #45 |
| v2 | `ssm:GetParameter(s)` on `/cdk-bootstrap/acclinic/version`: every CDK template's `BootstrapVersion` parameter resolves it with the execution role |

## Step 5.1: STOPPED

The import of `spares4repairs-error-code-mcp` into `AcDataStack` (one Import action; import-mode check passed; changes exactly
as expected) **rolled back** (`IMPORT_ROLLBACK_COMPLETE`):

1. `IMPORT_COMPLETE` for the repository, then
2. `UPDATE_IN_PROGRESS` "Apply stack-level tags to imported resource if applicable": after every import, CloudFormation runs
   the resource's **update handler**, then
3. `UPDATE_FAILED`: the execution role "is not authorized to perform: `ecr:DeleteRepositoryPolicy`".

The ECR update handler reconciles the whole resource with the template. The template leaves `RepositoryPolicyText`
undeclared (as Phase 4 did), so the handler tried to **delete the live repository policy** that Lambda wrote
(`LambdaECRImageRetrievalPolicy`, which lets Lambda pull the orchestrator and error-code MCP images). The read-only execution
role refused it. Afterwards the repository is unchanged (policy, tag mutability, scan on push, encryption, no tags), and the
stack holds only its `StackShell`.

**Why Phase 4 did not show it.** The sandbox execution role could write, so each post-import update succeeded silently; and
the sandbox repositories had no policy yet when they were imported (Lambda wrote it later). The rehearsal therefore never
exercised a post-import write against a property the template does not declare.

**What it means for Phase 5.** An import is not read-only: every imported resource also goes through its update handler,
with the execution role's permissions. With write access, an import would reset or delete any live property the template does
not declare, for every resource type, including the diagnosis Lambda in 5.10. The read-only execution role turns that into a
safe rollback, but then no import whose update handler writes can complete.
