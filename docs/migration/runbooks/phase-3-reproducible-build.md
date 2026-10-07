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
| Python test runner | `pytest`, exact version | `build/python/requirements-test.txt` |
| Python packages in the images | Every installed distribution, at its production version | `build/python/*.constraints.txt`, generated from the `dist-info` metadata of the deployed images |
| Orchestrator base | `public.ecr.aws/lambda/python:3.12.2026.10.03.13-arm64` at `sha256:7c61e7c7…904be` | Its 6 layers equal the first 6 production layers |
| MCP base | `python:3.12-slim` (2026-10-01), pinned by its 4 layer digests | The production manifest. The image is no longer tagged anywhere, so it is assembled from those layers by digest |

The Dockerfiles in `build/images/` are copies of the imported Dockerfiles with two build-only
changes, and no change to any file in the image:
- the base image is referenced by digest
- `pip install` runs with the constraints file, bind-mounted for that step only

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
| Diagnosis Lambda zip | `build/scripts/package-diagnosis-lambda.mjs` | `build/reference/spares4repairs-part-finder.zip.json`: 128 entries, CodeSha256 `Z6lIeG9r…` |
| `whichpart-api` zip | `build/scripts/package-whichpart-api.mjs`, which also generates `index-meta.json` | `build/reference/whichpart-api.zip.json`: 68 entries, the live Phase 1 artefact `Vkox0eYV…` |
| Orchestrator image | `docker buildx build --platform linux/arm64 -f build/images/orchestrator.Dockerfile .` | `build/reference/diag-orchestrator.image.json` |
| Error-code MCP image | Same, with `build/images/error-code-mcp.Dockerfile` | `build/reference/error-code-mcp.image.json` |

**Zips** are compared entry by entry: the same paths, the same bytes. Archive metadata (timestamps,
entry order, compression) is reported separately, because it changes the CodeSha256 but not what runs.

**Images** are compared in three parts:
- **Base layers:** the digests must match.
- **Application files:** every file must match.
- **Installed Python packages:** the same distributions and versions, and the same file contents.

Layer and config metadata (creation times, history text) is reported separately.

## 4. CI

`.github/workflows/build-and-test.yml` runs the runtime tests against the baseline, rebuilds both
zips and compares them, and rebuilds both images (arm64, under QEMU) and compares them. It has no AWS
credentials and never deploys.

## Network note

Pulling base-image layers needs the registries' CDN hosts. In the Claude cloud environment
`d2glxqk2uabbnd.cloudfront.net` (public ECR) is blocked. Image rebuilds there use the production base
layers already downloaded in #4, which are identical by digest. GitHub Actions pulls them from the
registries.

## Exit criteria (PLAN.md)

- **CI:** green against the known-failure baseline.
- **Artefacts:** every rebuilt artefact matches its deployed artefact file for file.
- **Behaviour:** no runtime behaviour has changed.
