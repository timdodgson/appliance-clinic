# Phase 2: runtime-identical extraction

**Classification:** repository only. No AWS change. `spares4repairs` is read with `git archive` and
`git` read commands. Nothing is written to it: no branch, commit, push, pull request or file edit, and
none of its deploy scripts or CDK is run.

## Production source rule

Production is not simply `spares4repairs@13b7a50`. Phase 1 changed one file:

| Files | Source of truth |
|---|---|
| Every runtime file proven in Phase 0 (#4) | `spares4repairs@13b7a50`, byte for byte |
| `services/whichpart-api/index.js` | The Phase 1 hotfixed file (#10): `index.js` from `whichpart-api.patched.zip`, whose CodeSha256 `Vkox0eYVlkwProorZUjOQuwPqWkhb0TCAgNRI/n31dE=` is the live `$LATEST` |

## What is imported

Only runtime files: the exact source of every file production runs, as proven in #4. The paths are
the same as in `spares4repairs`; nothing is moved or renamed.

| Production unit | Imported source |
|---|---|
| Diagnosis Lambda zip | `services/part-finder/…` for each of its 128 files |
| `whichpart-api` zip | `services/whichpart-api/…` for 58 files. 9 files are copies of `services/part-finder` files, already imported |
| Orchestrator image | `orchestration/{__init__,model,routing,services,orchestrator}.py`, `orchestration/deploy/{lambda_handler.py,requirements.txt}`, and `services/part-finder/canonical/journeys.json` |
| Error-code MCP image | Every `COPY` source in its Dockerfile under `error-codes/` |
| Build definitions | `orchestration/deploy/Dockerfile` and `error-codes/mcp/deploy/Dockerfile`. Each matches the build history recorded in its image |

**Not imported:** `knowledge-inspect/index-meta.json` in the `whichpart-api` zip is generated at
package time by `deploy.sh`. It has no source file. #4 proved it regenerates byte for byte from `13b7a50`.

## What is excluded

**PLAN.md exclusions.** None of the runtime files fall into these categories, and every other path in
`spares4repairs` is outside this import:
- shop and legacy code
- unlicensed imagery
- generated result dumps
- coverage data
- internal CONTINUE and handover notes
- `.cursor/`
- tools that read S4R internal data
- anything containing secrets or PII

**Appliance Clinic material deferred to a follow-up Phase 2 step.** It is not runtime, and needs a
per-directory ownership, PII and exclusion review first:
- the service and orchestrator tests
- `eval/`
- `error-codes` research and tooling
- service docs and analysis notes
- the deploy scripts
- the `whichpart` web frontend, which is not yet compared with the deployed site

Anything whose ownership is ambiguous is treated as S4R and left out.

## 1. Export and stage (no AWS)

```bash
O=.migration-output/phase-2
mkdir -p $O/export $O/staging
git -C <spares4repairs-clone> archive 13b7a50 | tar -x -C $O/export
```

Copy each path in the runtime list from `export/` to `staging/`. Then write `index.js` from the
Phase 1 patched zip to `staging/services/whichpart-api/index.js`.

## 2. Verify byte for byte (no AWS)

Every staged file must equal:
- **Its deployed copy:** the diagnosis Lambda zip from the Phase 0 inventory; the Phase 1 patched
  `whichpart-api` zip (the live artefact); and the application files extracted from each image digest in #4.
- **The `13b7a50` export,** except `services/whichpart-api/index.js`.

Every deployed file must have a staged source, except the generated `index-meta.json`.

## 3. Scan (no AWS)

- **`gitleaks dir`** and **`detect-secrets scan --all-files`** over `staging/`. Review every finding,
  and record why each is not a secret.
- **Live secret values.** Hash every token-like string in `staging/` and compare the hashes with the
  secret digests recorded by the Phase 0 inventory (`--hash-secret-values`). There must be no match to a
  credential.
- **PII.** Search for email addresses and phone numbers. There must be none.

## 4. Import

Copy `staging/` into the repository root. Commit the files with `import-manifest.json`, which records
for each file its path, SHA-256, source (`13b7a50` or the Phase 1 artefact) and the production units it
ships in. `npm test` in `tools/migration` re-checks every imported file against the manifest, so CI
fails if an imported file changes before Phase 3.

## Exit criteria

- **Byte for byte:** every runtime file in the import matches its production-equivalent source.
- **Secrets:** the scan is clean.
- **Visibility:** the repository is still private.
