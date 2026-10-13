# 0022. The error-code service runs as a Zip Lambda, applianceclinic-error-code-mcp

- **Status:** Accepted; implemented (22.0 build; 22.1a, 22.1b, 22.2 and 22.3 executed 2026-10-13; the image function deleted the same day)
- **Date:** 2026-10-13

## Context

The error-code MCP service runs as `spares4repairs-error-code-mcp`, a Lambda container image (arm64,
`sha256:dc715181…`) built from `build/images/error-code-mcp.Dockerfile`: python:3.12-slim, the Lambda Web Adapter (LWA)
extension, the pinned Python dependencies, and the files under `/app/error-codes`. Uvicorn serves `asgi.py` on port
8080 and the adapter turns Function URL requests into HTTP.

Change 18.1 repaired the error-code dataset (16 files: the runtime model, enrichment and the MCP modules that read them)
and the integrity anchors in `integrity.py`. Releasing it to the image function means building and pushing a new image
to ECR. A Zip function takes its code from the same staged S3 artefacts as the other AC functions, through the reviewed
`change.sh` process, with no image build or registry push.

Two facts constrain how:

- **`PackageType` cannot change in place.** CloudFormation replaces an `AWS::Lambda::Function` to go from `Image` to
  `Zip`. The imported function has a fixed `FunctionName` and `Retain`, so a replacement under the same name cannot be
  created while the old one exists.
- **Function URL ids are random.** Any new function gets a new URL, so consumers change their `MCP_URL` whatever the
  function is called.

## Decision

1. **A new function, `applianceclinic-error-code-mcp`,** created by `AcRuntimeStack` (`runtime-overrides.json`
   `create`): python3.12, arm64, handler `run.sh`, code `build/out/applianceclinic-error-code-mcp.zip`. Since the URL
   changes anyway, the new name costs nothing, and the old function stays deployed and untouched as the rollback until a
   later release change.
2. **The zip mirrors the image.** `build/scripts/package_zips.py --mcp-site <dir>` takes exactly the files the Dockerfile
   copies (`app/error-codes/...` at `error-codes/...`), without the `.dockerignore`d `__pycache__`, `.venv` and `tests`.
   It adds the dependencies at the zip root and `run.sh` (0755). The dependencies are the production versions
   (`build/python/error-code-mcp.constraints.txt`), pinned with hashes in `build/python/error-code-mcp.lambda-arm64.lock`
   and installed as wheels only for cp312, manylinux2014 / manylinux_2_17 aarch64, without bytecode, by
   `build/scripts/fetch_error_code_mcp_site.sh`. Entries are sorted and use a fixed timestamp, so a rebuild is
   byte-identical. `build/scripts/compare_zip_to_image.py` compares the zip with the deployed image file by file.
3. **The Lambda Web Adapter runs it, as a layer.** The function uses layer
   `arn:aws:lambda:eu-west-1:753240598075:layer:LambdaAdapterLayerArm64:23` (LWA 0.8.4, the adapter version the image pins: its `extensions/lambda-adapter` is byte-identical to the image's
   `opt/extensions/lambda-adapter`, sha256 `82b8edfc96ccd9959472bf2b6233811cf79f0af6537d3f5fd5ab67dbc8d2e6be`, 3,040,328
   bytes; layer CodeSha256 `9DGT6q7SqBO8+T+RDFjviWO2+ejppQUgvUtBid5/NYk=`, also recorded in
   `build/reference/applianceclinic-error-code-mcp.zip.json`. Version :22 is LWA 0.8.3
   and differs)
   with `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` and `AWS_LWA_PORT=8080`. `run.sh` runs the image's command from the same
   directory:

   ```bash
   cd "$LAMBDA_TASK_ROOT/error-codes/mcp/deploy"
   PYTHONPATH="$LAMBDA_TASK_ROOT" exec python3 -m uvicorn asgi:app --host 0.0.0.0 --port 8080 --log-level info
   ```

   The image's `PYTHONUNBUFFERED` and `PYTHONDONTWRITEBYTECODE` are set too (its `PORT=8080` only repeated
   `AWS_LWA_PORT` for the adapter and is not set). The service code is unchanged.
4. **It reuses `error-code-mcp-role`.** The role already has what the service needs (the overlay read of the learning
   bucket). Only its `ac-function-logs` inline policy gains the new log group. No new role, no new trust.
5. **The URL is public and bearer-gated, as today.** Auth `NONE`, BUFFERED, no CORS. `asgi.py` enforces the bearer
   (`applianceclinic/production/mcp-bearer`, unchanged). There are two resource-policy statements, as a public Function
   URL needs: `lambda:InvokeFunctionUrl` with `FunctionUrlAuthType NONE`, and `lambda:InvokeFunction` with
   `InvokedViaFunctionUrl`.
6. **In three reviewed changes.** 22.1a adds the log group and the role's log permission. 22.1b adds the function, its
   URL and its two statements. 22.2 moves `MCP_URL` (and `MCP_HEALTH_URL`) of whichpart-api, the diagnosis engine and
   the orchestrator to the new URL. To support this, `createdFunction` declares `layers` and `statements`, and the
   statements of a created function depend on it. Every existing template synthesizes byte-identically.

## Status of the release (2026-10-13)

- 22.1a: log group `/aws/lambda/applianceclinic-error-code-mcp`, the Errors and Throttles alarms, and the log group added
  to `error-code-mcp-role/ac-function-logs`. Drift IN_SYNC; the template is a no-op.
- 22.1b: `applianceclinic-error-code-mcp`, CodeSha256 `Wm1i7OG6nSeugc/Cw/AQf6x7VPbGnG2sjd0Ig041sIM=` (equal to
  `build/reference/applianceclinic-error-code-mcp.zip.json`), Function URL
  `https://44ydoowtcn66qqwv6tqsi2psee0uflvi.lambda-url.eu-west-1.on.aws/`. Drift IN_SYNC; the deployed configuration
  equals `runtime-overrides.json`.
- Verified on arm64 (Function-URL-shaped `lambda invoke`; the operator network's egress proxy refuses Function URL
  hosts): `/health` 200 with mappingCount 847, datasetV1Hash `835496f2dc8d` and enrichmentV1Hash `28c0cc32df74` (the
  image still serves `0a2a8e0cbc16` and `6301265a2a80`); `/mcp` without a bearer and with a wrong bearer 401; with the
  bearer, `resolve-error-code` Beko hob `U` and Bosch dishwasher `E15` both RESOLVED. Cold start: init 3.56 s, no
  errors in the log.
- 22.2 moves the consumers' `MCP_URL` (and whichpart-api's `MCP_HEALTH_URL`) to the new URL. Executed 18:14 UTC: drift
  IN_SYNC, no-op, the deployed configuration equals `runtime-overrides.json`.
- 22.3 releases `spares4repairs-error-code-mcp`, its URL and its two statements (`FunctionURLAllowPublicAccess`,
  `PublicInvoke`) from `AcRuntimeStack`. The change set held exactly four `Remove` actions, each `PolicyAction: Retain`,
  with an empty grant. A fingerprint of the function (configuration, image digest `sha256:dc715181…`, URL configuration,
  resource policy, tags), `error-code-mcp-role` and its two inline policies was identical before and after. Drift
  IN_SYNC; the template is a no-op.
- Then, outside CloudFormation (which no longer owned it), the IAM user deleted its Function URL and the function, after
  its log group showed no invocation since 22.2 (the last, a `/health` GET at 18:01 UTC) and its `Invocations` metric
  was empty. Kept: the log group `/aws/lambda/spares4repairs-error-code-mcp`, the ECR repository
  `spares4repairs-error-code-mcp` (`AcDataStack`), `error-code-mcp-role` (the Zip Lambda's role; its `ac-function-logs`
  still names the old log group) and `build/reference/spares4repairs-error-code-mcp.image.json` as the record.

## Consequences

- Error-code releases become zip releases. Data and code changes ship through `change.sh` like the other AC functions,
  with no ECR push. The image pipeline (`build-images.yml`) is no longer needed for this service once 22.2 holds.
- **Equivalence with the live image** (`compare_zip_to_image.py`; `.pyc`, `RECORD`, `INSTALLER` and `REQUESTED`
  ignored): 3,043 of 3,066 compared files are identical. The differences:
  - the 16 repaired files of change 18.1 and `integrity.py` (new anchors);
  - four files of `cryptography` 50.0.1. The image installed the `cp311-abi3-manylinux_2_34_aarch64` wheel (pip on
    Debian trixie chose the newest glibc tag), and the lock pins the `manylinux2014` / `manylinux_2_17` build of the same
    version. Pinning `manylinux_2_34` instead would make them identical, because the Lambda python3.12 runtime (Amazon
    Linux 2023) has glibc 2.34;
  - `run.sh`, which the zip adds.

  The zip leaves out the adapter extension (now a layer), the console scripts in `/usr/local/bin` and
  `/app/requirements.txt` (pip's input).
- Python compiles bytecode on import into memory; the read-only task root receives no `__pycache__`. Cold start may be
  slightly slower than the image, which shipped `.pyc`.
- The arm64 runtime smoke happens in 22.1b, before 22.2. Locally the zip was run on x86 with x86 builds of the four
  binary packages (`pydantic_core`, `rpds-py`, `cryptography`, `cffi`) put in place of the arm64 ones.
- `spares4repairs-error-code-mcp`, its URL, its image and its ECR repository stay until a release change. Its log
  permission stays in `ac-function-logs` until then. (Change 22.3 released the function and its URL, which were then
  deleted; the ECR repository and the log permission stay.)

## Alternatives considered

- **Keep the image and push a new one.** This needs the image build and an ECR push for every data release, which is
  what this decision removes.
- **Convert the existing function in place.** `PackageType` forces a replacement, which cannot reuse the retained name.
  Deleting the old function first would mean an outage and no rollback.
- **Mangum instead of the LWA layer.** Mangum runs the ASGI lifespan on each invocation. `asgi.py` forwards lifespan to
  the MCP Streamable HTTP app, whose session manager can run only once per process, so the second invocation would fail.
  Fixing that would mean changing the service. With LWA, uvicorn runs once per execution environment, exactly as in the
  image, and the code is unchanged.
- **A new role.** It would duplicate `error-code-mcp-role` with no gain in isolation, since the old function is retired
  after cut-over.
