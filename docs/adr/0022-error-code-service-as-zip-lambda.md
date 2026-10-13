# 0022. The error-code service runs as a Zip Lambda, applianceclinic-error-code-mcp

- **Status:** Proposed (step 0, repository only: change 22.0; changes 22.1a, 22.1b and 22.2 are drafts)
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
   `arn:aws:lambda:eu-west-1:753240598075:layer:LambdaAdapterLayerArm64:22` (the adapter version the image pins, 0.8.4)
   with `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` and `AWS_LWA_PORT=8080`. `run.sh` runs the image's command from the same
   directory:

   ```bash
   cd "$LAMBDA_TASK_ROOT/error-codes/mcp/deploy"
   PYTHONPATH="$LAMBDA_TASK_ROOT" exec python3 -m uvicorn asgi:app --host 0.0.0.0 --port 8080 --log-level info
   ```

   The image's `PORT`, `PYTHONUNBUFFERED` and `PYTHONDONTWRITEBYTECODE` are set too. The service code is unchanged.
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
  permission stays in `ac-function-logs` until then.

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
