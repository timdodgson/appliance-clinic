# Phase 1: admin allowlist hotfix

**Classification:** SAFE AC CHANGE on `whichpart-api` only. Nothing changes in the S4R Cognito pool,
and the diagnosis Lambda is not touched.

## What it fixes

The deployed `whichpart-api` treats any signed-in user with no Cognito groups as an Appliance Clinic
admin. The pool belongs to Spares4Repairs and has no groups, so every shop user is an AC admin, and
the admin now controls provider keys, AI routing and paid batch runs.

The hotfix replaces one function, `isAdminFromAccessToken`. Admin then requires the token's Cognito
`sub` to be listed in `AC_ADMIN_SUBS`, an environment variable on `whichpart-api`. An empty or
missing list means no admins: default-deny. Every admin check in the API goes through this function.

## Prerequisites

- **Phase 0 inventory** run with `--download-code` (#3). The deployed zip is under
  `.migration-output/inventory-<ts>/artifacts/whichpart-api.zip`, and its CodeSha256 is in
  `lambda-functions.json`.
- **Function URL target.** In `lambda-functions.json`, `whichpart-api`'s `functionUrl` has no
  `Qualifier`, so it serves `$LATEST`. Rollback restores `$LATEST`.
- **Freeze** in place (#2).
- **AWS profile `ac-hotfix`** with only these permissions:
  - `lambda:GetFunctionConfiguration`, `lambda:PublishVersion`, `lambda:UpdateFunctionConfiguration`
    and `lambda:UpdateFunctionCode` on `whichpart-api`
  - `sts:GetCallerIdentity`

## 1. Find the admin `sub` values (READ-ONLY)

Use whichever route suits you. The first needs no AWS access at all.

- **From your own admin session (no AWS calls).** Sign in to the AC admin. In the browser's developer
  tools, open *Application → Cookies* and copy the value of `wp_session`, your access token. Then:

  ```bash
  cd tools/migration
  npm run token:sub      # paste the token, then Ctrl-D
  ```

  It prints only `sub`, `username` and `tokenUse`, and stores nothing. Do not paste the token anywhere else.
- **From Cognito (READ-ONLY on the S4R pool).**

  ```bash
  aws cognito-idp admin-get-user --user-pool-id <s4r-pool-id> --username <email> \
    --query "UserAttributes[?Name=='sub'].Value" --output text
  ```

Record the subs, and whose they are, on the Phase 1 issue.

## 2. Build and check the patched zip (no AWS)

```bash
mkdir -p ../../.migration-output/phase-1
npm run hotfix:patch -- --in ../../.migration-output/inventory-<ts>/artifacts/whichpart-api.zip \
  --out ../../.migration-output/phase-1/whichpart-api.patched.zip
npm run compare:build -- ../../.migration-output/inventory-<ts>/artifacts/whichpart-api.zip \
  ../../.migration-output/phase-1/whichpart-api.patched.zip --allow-diff index.js
```

**Expected:**
- the patch finds the original admin check exactly once
- the comparison reports `equivalent: true`, with `index.js` as the only difference

If the patch refuses, the deployed code differs from `13b7a50`. Stop and review by hand.

## 3. Pre-checks (READ-ONLY)

```bash
npm run baseline -- s4r-health --live
curl -s -o /dev/null -w '%{http_code}\n' https://applianceclinic.ai/api/admin/ai-config   # expect 401
```

## 4. Review the plan (no changes)

```bash
AWS_PROFILE=ac-hotfix npm run hotfix:admin -- apply \
  --original ../../.migration-output/inventory-<ts>/artifacts/whichpart-api.zip \
  --patched ../../.migration-output/phase-1/whichpart-api.patched.zip \
  --expect-code-sha256 <CodeSha256 from lambda-functions.json> \
  --subs <sub>[,<sub>]
```

The tool refuses if:
- the live code has changed since the inventory
- the original zip does not match the recorded CodeSha256
- the patched zip differs in anything but `index.js`
- a sub is not a Cognito UUID, or the list is empty

## 5. Apply

Add `--execute --confirm-account <account-id>` to the command in step 4. It runs, in order:

| Step | Effect |
|---|---|
| `PublishVersion` | Snapshot of the current code and configuration, for reference |
| `UpdateFunctionConfiguration` | Adds `AC_ADMIN_SUBS`. Every other variable is preserved, in memory only. The old code ignores the new variable |
| `UpdateFunctionCode` | Deploys the patched zip |
| Verify | Live CodeSha256 equals the patched zip |

## 6. Verify

- [ ] An allowlisted admin can sign in and use the admin.
- [ ] Another S4R pool account that is not allowlisted gets no admin UI, and the API returns 401 on `/admin/*`.
- [ ] `npm run baseline -- smoke --live --compare <baseline>` passes: customer behaviour is unchanged.
- [ ] `npm run baseline -- s4r-health --live` passes.
- [ ] Re-run the inventory, then `npm run compare:config -- <before> <after>`. The only differences
      should be `whichpart-api`'s code, its `AC_ADMIN_SUBS` variable and the new version. The
      variable's value is shown only as a digest.

The new inventory becomes the baseline for later phases.

## Rollback

Restores the exact original artefact to `$LATEST`:

```bash
AWS_PROFILE=ac-hotfix npm run hotfix:admin -- rollback \
  --original ../../.migration-output/inventory-<ts>/artifacts/whichpart-api.zip \
  --expect-code-sha256 <original CodeSha256> --execute --confirm-account <account-id>
```

`AC_ADMIN_SUBS` stays in the environment. The original code ignores it.

## Afterwards

- **The deployed code now includes the patch.** Phase 2 extracts it, so this repository matches production.
- **Adding or removing an admin** means changing `AC_ADMIN_SUBS`. Until `whichpart-api` is imported
  into CDK in Phase 5, that is an `update-function-configuration` that must preserve every other
  variable. Use the same tool pattern, not a hand-written command, because the environment holds
  plaintext tokens until Phase 7.
