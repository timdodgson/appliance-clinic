# Phase 0: behavioural baseline and S4R `/part-finder` contract

**Classification:**
- S4R health checks are READ-ONLY: plain GETs of public pages and the catalogue API.
- The contract capture and smoke runs are SAFE AC CHANGE. They send customer-equivalent requests,
  which cost LLM calls and may write canonical-state items.

**What the baseline never does:**
- send `observability`, so no transcripts are stored
- call admin or benchmark routes
- send live-test or benchmark fields
- exceed the request cap in `tools/migration/config/baseline.json`

Each of these rules is enforced in code.

## Prerequisites

- The [freeze](phase-0-freeze.md) is in place. The batch runner must not be used for the baseline:
  it rewrites production routing.
- No AWS credentials are needed.

## 1. S4R health (READ-ONLY)

```bash
cd tools/migration
npm run baseline -- s4r-health --live --out ../../.migration-output/baseline/s4r-health-<date>.json
```

**Expected:** the S4R pages and the catalogue search return 200.

## 2. Capture the `/part-finder` contract

This posts the same request shape the S4R page sends, from the S4R origin, and records the shape
of the response. It records status, content type, CORS headers, NDJSON framing and the fields the
page reads. It does not record prose.

```bash
npm run baseline -- contract capture --live --out ../../.migration-output/baseline/part-finder-contract.json
```

Review the captured contract and keep the file. It is the reference for every later step that
touches the diagnosis Lambda. In Phase 3 it becomes a permanent compatibility test in this
repository.

Verify against it before and after such a step:

```bash
npm run baseline -- contract verify --live --recorded ../../.migration-output/baseline/part-finder-contract.json
```

## 3. Smoke baseline

```bash
npm run baseline -- smoke --live --out ../../.migration-output/baseline/smoke-<date>.json
```

**Expected:** every scenario returns 200, and the safety scenarios report `safety: true`.

To compare a later run against this baseline:

```bash
npm run baseline -- smoke --live --compare ../../.migration-output/baseline/smoke-<date>.json
```

- **Exact checks:** status, content type, parseability, the safety decision, and response keys not removed.
- **Banded checks:** reply length within a ratio. These are reported, not failed.

## Cost

One run of each command makes at most 12 requests. Run the full set once for the baseline, and the
contract verify before and after each step that touches the diagnosis Lambda.
