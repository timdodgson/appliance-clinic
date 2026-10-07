# Phase 3: reproducible builds and tests

**Classification:** repository only. No AWS change and no deployment; the freeze (#2) stays in place.
`spares4repairs` is not accessed. Issue: #29.

**Goal:** build and test the runtime from this repository and prove that the rebuilt artefacts are the
ones running in production, with no runtime behaviour change.

## Rules

- **The imported files are not edited.** That covers the runtime (#25) and the tests and build inputs
  (#28). Both import manifests stay intact, and CI re-checks them.
- **New build material lives in `build/`**, apart from the root `package.json` and lockfile, which the
  imported tests need to resolve their packages.
- **No production access.** CI has no AWS credentials. Production artefacts are represented by
  reference files committed under `build/reference/`, holding per-file SHA-256s and layer digests from
  the artefacts proven in #4 and #10. They contain no secrets.
- **Never run the imported `deploy.sh` scripts.** The packaging scripts in `build/` reproduce their
  packaging steps only.
- **Known failures are classified, not fixed.** A test is changed only if it is proven stale, or its
  failure is caused only by the environment or tooling.

## 1. Dependencies

| What | Pin | Source of the pin |
|---|---|---|
| Node test runner | `vitest` 3.2.7 | The monorepo lockfile at `13b7a50` |
| AWS SDK for the tests | `@aws-sdk/client-*` 3.1091.0 | The monorepo lockfile at `13b7a50` |
| Python test runner | `pytest` 9.1.1 and its 4 dependencies, exact versions | `build/python/requirements-test.txt` |
| Python packages in the images | Every installed distribution, at its production version | `build/python/*.constraints.txt`, generated from the `dist-info` metadata of the deployed images |
| Orchestrator base | `public.ecr.aws/lambda/python:3.12.2026.10.03.13-arm64` at `sha256:7c61e7c7…904be` | Its 6 layers equal the first 6 production layers |
| MCP base | `python:3.12-slim` (2026-10-01), pinned by its 4 layer digests | The production manifest. The image is no longer tagged anywhere, so `build/scripts/assemble_base.py` assembles it from those layers, verifying each digest and diff_id |
| Lambda Web Adapter | 0.8.4 at `sha256:e2653f74…69007` | Its `/lambda-adapter` equals the file in the production MCP image |

The Dockerfiles in `build/images/` are copies of the imported Dockerfiles with three build-only
changes, and no change to any file in the image:
- the base image and the adapter are referenced by digest
- `pip install` runs with the constraints file, bind-mounted for that step only
- an optional CA certificate can be passed as a build secret (`--secret id=ca,...` with
  `--build-arg PIP_CERT=/run/secrets/ca`) for networks with a TLS-intercepting proxy. It is not
  written to the image, and CI does not use it

## 2. Tests

```bash
npm ci                       # repository root
npm run test:runtime         # every imported test, one process per test file
```

`build/test/run-tests.mjs` runs each imported test with its own runner: Node scripts, `node --test`,
vitest, or Python (pytest or plain scripts). It runs them with fake AWS credentials and no proxy, then
compares the outcome with `build/test/known-failures.json`. The check fails if:
- a test outside the baseline fails
- a baseline test starts passing; remove it from the baseline in the same change

## 3. Artefacts

| Unit | Rebuild | Compared with |
|---|---|---|
| Diagnosis Lambda zip | `build/scripts/package_zips.py` | `build/reference/spares4repairs-part-finder.zip.json`: 128 entries, CodeSha256 `Z6lIeG9r…` |
| `whichpart-api` zip | `build/scripts/package_zips.py`, which also generates `index-meta.json` | `build/reference/whichpart-api.zip.json`: 68 entries, the live Phase 1 artefact `Vkox0eYV…` |
| Orchestrator image | `docker buildx build --platform linux/arm64 -f build/images/orchestrator.Dockerfile .` | `build/reference/spares4repairs-diag-orchestrator.image.json` |
| Error-code MCP image | `assemble_base.py`, then `docker buildx build --platform linux/arm64 --build-context constraints=build/python -f build/images/error-code-mcp.Dockerfile error-codes` | `build/reference/spares4repairs-error-code-mcp.image.json` |

**Zips** are compared entry by entry (`build/scripts/compare_zip.py`): the same paths, the same bytes. Archive metadata (timestamps,
entry order, compression) is reported separately, because it changes the CodeSha256 but not what runs.

**Images** are compared in three parts (`build/scripts/compare_image.py`):
- **Base layers:** the diff_ids must match.
- **Added files:** every file the Dockerfile adds (application files and installed packages) must
  match in content and mode, with none missing and none extra. Python bytecode (`.pyc`) is compared on
  its code body: pip compiles it at install time, and the 16-byte header records the source mtime.
- **Runtime config:** Entrypoint, Cmd, Env, WorkingDir, ExposedPorts and User must match.

`.pyc` header-only differences, image digests, creation times and history text are reported
separately as non-semantic.

## 4. CI

- `.github/workflows/build-and-test.yml` (`runtime-tests`): runs the runtime tests against the baseline.
- `.github/workflows/build-artefacts.yml` (`lambda-zips`): rebuilds both zips and compares them.
- `.github/workflows/build-images.yml` (`images`): rebuilds both images (arm64, under QEMU) and
  compares them.

None has AWS credentials, pushes an image or deploys.

## Network note

Pulling base-image layers needs the registries' CDN hosts. In the Claude cloud environment
`d2glxqk2uabbnd.cloudfront.net` (public ECR) is blocked. Image rebuilds there use the production base
layers already downloaded in #4, which are identical by digest (`assemble_base.py --blobs-dir`), and
a local stand-in for the adapter image built from the identical production `/lambda-adapter` file. GitHub Actions pulls them from the
registries.

## Exit criteria (PLAN.md)

- **CI:** green against the known-failure baseline.
- **Artefacts:** every rebuilt artefact matches its deployed artefact file for file.
- **Behaviour:** no runtime behaviour has changed.
