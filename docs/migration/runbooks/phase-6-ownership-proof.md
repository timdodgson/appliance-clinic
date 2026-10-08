# Phase 6: prove CDK ownership

**Classification:** SAFE AC CHANGE. The change is one inert tag on one AC-only imported resource, added by a reviewed
CDK update and removed by a second one.

Plan: [PLAN.md, Phase 6](../PLAN.md#phase-6-prove-cdk-ownership). Results: [phase-6-results.md](../phase-6-results.md).

## The proof

[`phase-6-proof-writes.json`](../phase-6-proof-writes.json) names:
- the resource: the ECR repository `spares4repairs-error-code-mcp` in `AcDataStack`
- the tag: `ac:ownership-proof=phase-6`
- the writes the execution role gets during each update

The resource was chosen because:
- it is AC-only and was the Phase 5 canary
- no S4R component consumes it
- a repository resource tag is metadata only: it does not touch images, the repository policy or any function

Never used for the proof:
- the diagnosis Lambda, or anything S4R-consumed or shared
- stack-wide tags
- secrets, table or bucket configuration
- Function URLs, IAM, schedules

## Steps

Run as the IAM user, from the repository root.

1. **Before.** `bash infra/production/phase-6-checks.sh before`. Every line must be clean:
   - inventory and config comparison
   - regenerated denylist
   - drift of both stacks
   - S4R role and API `65vnizdmk4`
   - every AC function, the diagnosis Lambda included
   - `SparesSite-dev` and `CDKToolkit`
   - S4R health, `/part-finder`, `/ai/chat`, smoke

   Also confirm that freeze #2 is open and that backups are less than 24 hours old.
2. **Add.** With the tag in `infra/cdk/lib/data-stack.js`, run
   `EXECUTE=1 bash infra/production/steps/phase-6-proof.sh add`
   ([script](../../../infra/production/steps/phase-6-proof.sh)).

   Before the change set is created, the synthesized template must equal the deployed one except for that one tag.
   The change set must be exactly one Modify of the repository, whose only detail is `Properties.Tags`
   (`RequiresRecreation: Never`), and it must pass the update-mode check.

   During the update only, `ac-cfn-execution` holds the read-only base plus the proof writes on the one repository.

   After it: drift `IN_SYNC`, the same template is a no-op, and the repository is its before snapshot plus exactly the
   tag.
3. **CloudTrail.** `bash infra/production/check-cloudtrail.sh phase6-add`. Its writes must match the manifest's `add`
   variant.
4. **After the add.** `bash infra/production/phase-6-checks.sh after-add`.
5. **Remove.** With the tag removed from CDK, run `EXECUTE=1 bash infra/production/steps/phase-6-proof.sh remove`. The
   same checks apply, and the repository must equal the snapshot taken before the add.
6. **CloudTrail and after.** `check-cloudtrail.sh phase6-remove`, then `phase-6-checks.sh after-remove`. The deployed
   template must equal the pre-Phase-6 template.

## ECR update semantics

An ECR update runs the same handler as the post-import update (Phase 5). It rewrites the declared values unchanged
(`SetRepositoryPolicy`, `PutImageTagMutability`, `PutImageScanningConfiguration`), then applies the tag change
(`TagResource` or `UntagResource`). The snapshot proves that the rewritten values are unchanged.

## Stop conditions

Stop, change nothing more, and report on the Phase 6 issue if:
- the template differs from the deployed one beyond the tag
- the change set holds more than the one Modify, a replacement, or a detail other than Tags
- CloudTrail shows a write outside the variant, a write on another resource, or a refused call
- drift is not `IN_SYNC`
- any check differs from before
- the removal does not return the repository to its exact pre-Phase-6 state
