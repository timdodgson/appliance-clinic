# Phase 6 results

What the CDK ownership proof (PLAN.md, Phase 6; [runbook](runbooks/phase-6-ownership-proof.md)) did. Every step ran as
the IAM user in account `800960611664`, eu-west-1, through CloudFormation with the `acclinic` execution role. Raw
outputs stay in `.migration-output/phase6/`. Issue: #52.

## Entry (2026-10-08)

- Every Phase 5 group is imported and signed off (#46, [phase-5-results.md](phase-5-results.md)).
- The configuration comparison is clean. Against the Phase 5 final inventory, the only differences were 3 new
  `whichpart-learning` objects from live traffic.
- Freeze #2 was open and in force.
- Backups were current: on-demand table backups and S3 copies from 01:41Z the same day, and PITR continuous on both
  tables.

## Proof resource

| | |
|---|---|
| Resource | ECR repository `spares4repairs-error-code-mcp`: `AcDataStack`, logical ID `spares4repairserrorcodemcp` |
| Change | One inert tag, `ac:ownership-proof=phase-6`: added by one reviewed CDK update, removed by a second ([`phase-6-proof-writes.json`](phase-6-proof-writes.json)) |
| Why this resource | It is AC-only, it was the Phase 5 canary, and no S4R component consumes it. A repository resource tag is metadata only: images, the repository policy and every function are untouched |
| Not used | The diagnosis Lambda, anything S4R-consumed or shared, stack-wide tags, secrets, table or bucket configuration, Function URLs, IAM, schedules |

**Before state** (unchanged since its Phase 5 import):
- tag mutability `MUTABLE`, scan on push, `AES256`
- no lifecycle policy
- the Lambda repository policy `LambdaECRImageRetrievalPolicy`
- tags: only `aws:cloudformation:*`

## Checks before, after the add, after the remove

[`phase-6-checks.sh`](../../infra/production/phase-6-checks.sh) ran three times. All three runs were identical on every line:

| Check | before | after-add | after-remove |
|---|---|---|---|
| S4R denylist regenerated | 79, identical to committed | identical | identical |
| `AcDataStack` drift | `IN_SYNC` (0 not in sync) | `IN_SYNC` | `IN_SYNC` |
| `AcRuntimeStack` drift | `IN_SYNC` | `IN_SYNC` | `IN_SYNC` |
| S4R role and API `65vnizdmk4` | identical to Phase 5 final | identical | identical |
| All AC functions, the diagnosis Lambda included (full runtime capture) | identical to Phase 5 final | identical | identical |
| `SparesSite-dev` | last updated 2026-07-21 | unchanged | unchanged |
| `CDKToolkit` | last updated 2026-07-20 | unchanged | unchanged |
| S4R health (homepage, `/part-finder` page, catalogue API) | 3 × 200 | 3 × 200 | 3 × 200 |
| `/part-finder` contract | ok | ok | ok |
| `/ai/chat` ingress | ok | ok | ok |
| Smoke (behavioural baseline) | 4 × 200, equal to the pre-Phase-5 baseline | equal | equal |

## The add (13:11Z)

[`phase-6-proof.sh add`](../../infra/production/steps/phase-6-proof.sh):

| Item | Result |
|---|---|
| Template | Equal to the deployed `AcDataStack` template except the repository's `Tags`: none → `[ac:ownership-proof=phase-6]` |
| Change set `phase6-add` | One action: Modify `spares4repairserrorcodemcp` (`spares4repairs-error-code-mcp`), Replacement `False`, scope Properties. Its only detail is `Properties.Tags` (`RequiresRecreation: Never`, static, direct modification). No Add, no Remove, no IAM, Lambda, URL or permission change. The update-mode check passed with no warnings |
| Execution policy | v12: the read-only base plus `ecr:TagResource`, `UntagResource`, `SetRepositoryPolicy`, `PutImageTagMutability`, `PutImageScanningConfiguration` on the one repository ARN. Back to v3 (the committed read-only base) straight after |
| Stack events | `spares4repairserrorcodemcp` `UPDATE_IN_PROGRESS` → `UPDATE_COMPLETE`; `AcDataStack` `UPDATE_COMPLETE`. No other resource |
| CloudTrail | `ecr:PutImageScanningConfiguration`, `ecr:PutImageTagMutability` and `ecr:SetRepositoryPolicy` on the repository: the handler rewrites the declared values unchanged. `ecr:TagResource` on the repository ARN. All at 13:11:48Z, no error. Matches the `add` variant |
| Drift, no-op | `IN_SYNC`; the same template has no changes |
| Resource | The before snapshot plus exactly `ac:ownership-proof=phase-6`: policy text, mutability, scanning, encryption and lifecycle unchanged |
| Inventory | Against the pre-Phase-6 inventory: the stack status (`IMPORT_COMPLETE` → `UPDATE_COMPLETE`), the new tag on the repository, and new `whichpart-learning` objects from traffic. Nothing else |

## The removal (13:29Z)

[`phase-6-proof.sh remove`](../../infra/production/steps/phase-6-proof.sh), from the commit that removes the tag again.
`infra/cdk/lib/data-stack.js` is identical to its pre-Phase-6 version:

| Item | Result |
|---|---|
| Template | Equal to the deployed template except the repository's `Tags`: `[ac:ownership-proof=phase-6]` → none |
| Change set `phase6-remove` | One action: Modify `spares4repairserrorcodemcp`, Replacement `False`, only detail `Properties.Tags` (`Never`). The update-mode check passed |
| Execution policy | v12 during the update, v3 straight after |
| CloudTrail | The same three unchanged rewrites, and `ecr:UntagResource` (`tagKeys`) on the repository ARN, no error. Matches the `remove` variant |
| Drift, no-op | `IN_SYNC`; no changes |
| Resource | Identical to the snapshot taken before the add |
| Deployed template | Byte-for-byte the pre-Phase-6 `AcDataStack` template |
| Inventory | Against the pre-Phase-6 inventory: only the stack status `UPDATE_COMPLETE` and new `whichpart-learning` objects from traffic |

The CloudTrail records of both updates are test fixtures
([`phase-6-proof.cloudtrail.json`](../../tools/migration/test/fixtures/production/phase-6-proof.cloudtrail.json)).

## Finding

An ECR update runs the same handler as the post-import update in Phase 5. It rewrites every declared value unchanged
(`SetRepositoryPolicy`, `PutImageTagMutability`, `PutImageScanningConfiguration`), then applies the tag change. A tag
update therefore needs those writes too. With them, and with the repository policy declared, the only effective change
is the tag.

## Phase 6 sign-off

Both exit criteria of PLAN.md Phase 6 are met:
- The proof change deployed exactly as reviewed: one Modify, Tags only, no replacement. Its only effective change was
  the tag, and the second reviewed update reversed it exactly.
- Every check before and after is clean: drift `IN_SYNC` on both stacks, zero unintended configuration differences,
  S4R 3 × 200, `/part-finder`, `/ai/chat` and smoke as baseline. `SparesSite-dev`, `CDKToolkit`, API `65vnizdmk4` and
  the diagnosis Lambda are unchanged.

CloudFormation owns the AC production resources, and changes made through it are reviewable and reversible.

**The production freeze (#2) is lifted after this Phase 6 success**
([phase-0-freeze.md](runbooks/phase-0-freeze.md#lifting-the-freeze)). Phase 7 and #21 have not started.
