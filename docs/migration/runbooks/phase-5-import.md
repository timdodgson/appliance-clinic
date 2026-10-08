# Phase 5: production CDK import

**Classification:** steps 5.1 to 5.9 are SAFE AC CHANGE; step 5.10 (the diagnosis Lambda) is POTENTIALLY IMPACTS S4R.
Every import transfers CloudFormation ownership only: no resource is created, changed, replaced or deleted.

Plan: [PLAN.md, Phase 5](../PLAN.md#phase-5-production-cdk-import). Rehearsal: [Phase 4 results](../phase-4-results.md).
Ownership: [ownership.md](../ownership.md). Results: [phase-5-results.md](../phase-5-results.md).

## Prerequisites

- The pre-production gates of PLAN.md (*Before any production AWS action*), checked the same day:
  - the S4R denylist regenerated (`npm run denylist`), unchanged or reviewed
  - the freeze (#2) in place, the routing override lease `released`
  - backups less than 24 hours old: PITR on both tables (continuous) and the Phase 0 on-demand backups and S3 copies
  - S4R health, the `/part-finder` contract (with the CORS preflight from `https://spares4repairs.co.uk`), the
    `/ai/chat` ingress and the smoke baseline captured within the last hour (`npm run baseline -- …`, see
    [phase-0-baseline.md](phase-0-baseline.md))
- A pre-Phase-5 inventory (`npm run inventory`), kept as the comparison point for every step.
- Run as the IAM user, with credentials from the environment. Every resource operation goes through CloudFormation
  with the `acclinic` execution role.

## The toolkit (Phase 5 entry)

[`infra/production/steps/00-toolkit.sh`](../../../infra/production/steps/00-toolkit.sh) creates
`ApplianceClinicToolkit` (qualifier `acclinic`) from the documents in [`phase-5/toolkit/`](../phase-5/toolkit/):

| Document | What it is |
|---|---|
| `ac-cfn-execution.json` | The execution role's read-only base, on the AC production resources of the import set. No `GetSecretValue`, and no S3 object reads. During a step only, a version adds exactly that step's expected writes (*Import semantics* below); between steps the default version is this read-only one |
| `ac-deny-s4r.json` | Explicit denies: every S4R identifier on the generated denylist (exact names, never a prefix an AC resource shares: AC secrets and functions also start with `spares4repairs`), the `SparesSite-*` stacks, `CDKToolkit`, API `65vnizdmk4`, the S4R pool and role, services AC never uses, other regions. Attached to the execution role and every toolkit role |
| `bootstrap-acclinic.json` | The stock CDK v32 bootstrap template, patched as in Phase 4: qualifier fixed, the two policies as the execution policies, the deploy role's CloudFormation rights limited to `AcDataStack`, `AcRuntimeStack` and the toolkit, Retain everywhere. Not `cdk bootstrap`, whose stock deploy role may change any stack |

The script checks the documents are current, creates the policies (or confirms the live ones match), creates the stack as
a change set of Add actions only, turns on termination protection, and asks the IAM simulator that the execution role is
denied S4R writes and AC writes and allowed AC reads.

## Import semantics

An import is **not** read-only. After `IMPORT_COMPLETE`, CloudFormation runs each imported resource's update handler
("Apply stack-level tags to imported resource if applicable") with the execution role. Production 5.1 stopped on this
(#47). The sandbox probe then established, for every Phase 5 type, which writes that update makes when the template
carries the live configuration exactly ([evidence](../phase-5-import-semantics.md); machine form
[`phase-5-import-writes.json`](../phase-5-import-writes.json)):

| Type | Writes after import |
|---|---|
| ECR repository | `SetRepositoryPolicy`, `PutImageTagMutability`, `PutImageScanningConfiguration` (the declared values, unchanged), `TagResource`. **The repository policy must be declared**: left out, it is deleted |
| Secret | `UpdateSecret` (description only, never a value), `TagResource` |
| DynamoDB table, IAM role, inline policy, Function URL, permission, bucket policy | None |
| S3 bucket | Tagging only (`s3:PutBucketTagging`) |
| Lambda function | `TagResource` only (`LastModified` and `RevisionId` change; configuration, code and state do not) |
| EventBridge rule | `TagResource` only |

A write made before a later denial is **not** rolled back, so a step is granted its type's complete write set or none.

## Each import step

[`infra/production/lib.sh`](../../../infra/production/lib.sh) and
[`infra/production/steps/import.sh`](../../../infra/production/steps/import.sh) `<step>`; one step file per step under
[`infra/production/steps/`](../../../infra/production/steps/).

1. **Read live.**
   - Data templates carry the live values (`infra/cdk/lib/data-stack.js`).
   - Runtime templates are generated from a fresh capture of live (`capture-runtime.sh`).
   - Bearer tokens become NoEcho parameters filled from the live value. They are never in a template, `cdk.out` or git.
   - Zip functions use the deployed artefact, checked against its CodeSha256.
2. **Prove ownership.** Every resource is `AC` or `AC (S4R-consumed)` in ownership.md, on no S4R denylist entry, and in
   no stack. S4R identifiers a resource refers to are acknowledged in the step file, each with its reason. A stack's
   template is cumulative, so a step file also carries the acknowledgements of every earlier step into the same stack
   ([`make-runtime-steps.mjs`](../../../infra/production/make-runtime-steps.mjs)).
3. **Shell.** If the stack does not exist, create it holding only `StackShell`, with the execution role and termination
   protection, and no stack tags.
4. **Snapshot** the step's resources ([`snapshot.sh`](../../../infra/production/snapshot.sh)).
5. **The step's writes.** `ac-cfn-execution` gets a version holding the read-only base plus exactly the manifest's
   writes on exactly this step's resources (`import-writes.mjs step-policy`). It goes back to the read-only version
   straight after the import, whatever happens.
6. **Change set.** An IMPORT change set, checked in import mode, then compared with the step file's `expectedChanges`
   exactly. Executed only if both pass.
7. **Drift** straight after: every resource `IN_SYNC`. **No-op:** the same template reports no changes. **Stack
   policy:** deny `Update:Replace` and `Update:Delete`.
8. **Compare.** The after snapshot may differ from the before snapshot only by `aws:cloudformation:*` tags
   ([`compare.sh`](../../../infra/production/compare.sh)). An untagged resource (no `Tags`, or S3's `NoSuchTagSet`) that
   gains only those tags is unchanged.
9. **CloudTrail.** After delivery, every write by the execution role must be one the manifest expects for the step's
   types, with no forbidden parameter and no refused call
   ([`check-cloudtrail.sh`](../../../infra/production/check-cloudtrail.sh)).
10. **Health and record.**
    - S4R health and the smoke tests.
    - The evidence on the step's issue and in phase-5-results.md.
    - The PR.

Step 5.10 (the diagnosis Lambda) runs only with its sign-off, `APPROVE_5_10=spares4repairs-part-finder`:
- **Step policy.** Its writes must equal the approved statement exactly (`lambda:TagResource` on the function).
- **Template references.** `SparesSite-dev` may occur only inside the S4R role ARN of the function's `Role`.
- **S4R boundary.** The S4R role (trust, inline and managed policies) and API `65vnizdmk4` (routes, integrations, stages)
  are snapshotted before and after ([`s4r-boundary.sh`](../../../infra/production/s4r-boundary.sh)). Any difference stops the step.

## Stop conditions

Stop the step, change nothing more, and report on its issue if:
- a change set holds anything but Import actions, a replacement, or a physical ID that is not the planned one
- drift is not `IN_SYNC` straight after an import, or CloudFormation proposes changing a live property
- a resource turns out to be S4R-owned or shared, or a stack name conflicts with S4R or the default toolkit
- a Function URL host, a CodeSha256 or image digest, the diagnosis role or its policies, or API `65vnizdmk4` would change
- production or S4R health changes
- a secret value would have to be read or exposed
- CloudTrail shows a write the manifest does not expect for the step, a forbidden parameter, or a refused call
- the after snapshot differs from the before snapshot beyond `aws:cloudformation:*` tags
- a step needs a write the sandbox probe did not establish
