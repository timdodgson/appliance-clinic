# Phase 8: architecture cleanup

**Classification:**
- SAFE AC CHANGE for whichpart-api.
- POTENTIALLY IMPACTS S4R for the diagnosis engine: it is the S4R `/part-finder` backend. Every engine release is
  behaviour-preserving, and the `/part-finder` contract and S4R health are checked before and after it.

Results: [phase-8-results.md](../phase-8-results.md). Review: [phase-8-findings.md](../../architecture/phase-8-findings.md).

## A behaviour-preserving runtime release

Use this for a refactor of `services/part-finder` or `services/whichpart-api` that must not change behaviour.

1. **Before the change:**
   - Capture the full output of the service's tests (`node build/test/run-tests.mjs --only services/<service>`).
   - Copy the original file.
2. **Move code without editing it:**
   - Keep each moved top-level statement byte-identical. The only exception is relative `require` paths.
   - Keep module-level state (`let`) in the same module as every function that reads or writes it.
   - Keep the module graph acyclic. `test/engine-structure.test.mjs` guards the engine's.
3. **Prove equivalence:**
   - Every original statement appears exactly once in the output.
   - The entry file's exports are unchanged: names, and the function source.
   - The tests' output is identical apart from timings and other per-run values.
4. **Register and build:**
   - Register every added, changed or removed file in `docs/migration/runtime-changes.json`, with the change id
     (`node tools/migration/bin/runtime-changes.mjs --write` refreshes the hashes).
   - Build with `python3 build/scripts/package_zips.py`.
   - Compare with `build/scripts/compare_zip.py`: only the intended files may differ.
   - Load the handler from the unzipped artefact.
5. **Stage and specify:**
   - Stage the zip at `phase8/<function>-<CodeSha256>.zip` in the AC assets bucket.
   - Set `functions.<name>.code` in `infra/cdk/config/runtime-overrides.json`.
   - Write the spec in `infra/production/changes/`. It names a single `Properties.Code` Modify, the grant is
     `UpdateFunctionCode` plus a read of `phase8/*`, and no PassRole.
6. **Dry run.** Run `bash infra/production/steps/change.sh <spec>`.
7. **Before the release:**
   - S4R health 3×, the `/part-finder` contract, the `/ai/chat` ingress and the smoke baseline.
   - For whichpart-api, also `verify-ac-endpoints.sh` and `verify-ac-auth.sh`.
8. **Execute.** Run `EXECUTE=1 bash infra/production/steps/change.sh <spec>`. Then:
   - Check the live `CodeSha256`, drift `IN_SYNC` and the no-op.
   - Repeat the checks from step 7.
   - For the engine, also run `verify-diagnosis-role.sh` and check the logs for cold starts on the new code.
   - For whichpart-api, check the logs for runtime errors.
9. **CloudTrail.** Run `bash infra/production/check-cloudtrail.sh change:<id>` 15 minutes later. It must show only the
   expected `UpdateFunctionCode`.
10. **Record and merge:**
    - Update `build/reference/<function>.zip.json` to the deployed artefact.
    - Record the release in `phase-8-results.md`.
    - Merge on green CI at the exact head.

**Rollback.** Point `functions.<name>.code.s3Key` back to the previous key, recorded in the spec's description, and run
the same change. Then revert the pull request.

## Changing a prompt

See [`prompts/README.md`](../../../prompts/README.md). A prompt change is never part of a refactor release.
