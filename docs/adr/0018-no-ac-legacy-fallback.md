# 0018. No Appliance Clinic turn falls back to the legacy pipeline

- **Status:** Implemented (Phase 13, releases 13.3, 13.4, 13.4b, 13.5, 13.5b, 13.5c and 13.6; [results](../evaluation/phase-13-results.md))
- **Date:** 2026-10-11
- **Supersedes:** the current-use parts of [0012](0012-legacy-diagnosis-pipeline-retained.md): legacy as the "AC fallback"
  and "AC turns that no canonical journey owns, or whose canonical path degrades, also use the legacy pipeline". 0012
  still records why the pipeline was retained for S4R.

## Context

[0012](0012-legacy-diagnosis-pipeline-retained.md) kept the legacy pipeline for two jobs: the S4R `/part-finder` contract
and the AC fallback. The Phase 13 audit traced the fallback:

- **Silent fallback on every canonical degradation.** Each of these sent an AC turn to the legacy diagnosis, and the
  customer saw a normal-looking answer:
  - a missing cs/1 block;
  - `understand_unavailable`, `understand_no_canonical` or `session_mismatch`;
  - a classifier failure or timeout;
  - invalid prior state or a merge failure;
  - a degraded Jev pass;
  - an orchestrator/engine gate mismatch.
- **A dropped signature on diagnose** produced a legacy answer that was presented as the canonical journey's.
- **Only three cases were errors:** a failed diagnose transport, `respond()` throwing and a COMPOSE provider failure.
- **Coverage:** about 50 of about 347 control-era AC turns still ran legacy. The classes were hazard-only messages,
  vague openers, off-topic requests, code-or-model questions, code turns and code+symptom turns.
- **Tests and features kept the fallback alive.** Failing tests (for example oven B3/B4) were proposed to be fixed by
  extending legacy, which would have grown the AC fallback further.

## Decision

1. **The legacy pipeline is retained only for the frozen S4R contract:** the plain, unsigned `{messages}` request to the
   engine's public Function URL.
2. **An AC turn never falls back from canonical to legacy.** It is one of:
   - canonical (a journey controls it);
   - an explicit non-diagnostic outcome: the safety stop for a cs/1 hazard, the fixed decline for an unsafe request,
     the error-code MCP for a displayed code, `UNSUPPORTED` for a typed problem no journey owns, or intake for anything
     not yet typed;
   - an explicit error.
3. **A canonical degradation or failure is an explicit error** ([0016](0016-degraded-turns-are-errors.md)):
   - The orchestrator returns `SERVICE_UNAVAILABLE` and marks the canonical result degraded, so nothing persists.
   - The BFF sets `error: true` with the reason.
   - A controlled reply must carry the engine's `canonicalControl` proof, or it is an error.
   - The orchestrator never accepts a looser canonical result than the engine's `controls()` gate.
4. **AC canonical coverage is explicit:** the journey registry. No new AC feature is added to legacy.
5. **Legacy is not reachable from AC:**
   - Internal engine fields without a valid signature are refused (`401 engine_signature_required`). They are no
     longer stripped into a plain request.
   - A signed AC diagnose call that no journey controls is refused (`409 canonical_not_controlled`).
6. **Legacy may still be fixed for real S4R safety or quality defects**, each with the S4R contract, ingress, smoke,
   health, drift and CloudTrail gates.

## Consequences

- AC outages and gaps are visible: an error, or a plain "I can't diagnose that problem here yet", never a guess from
  another path.
- `CANONICAL_MODE=shadow` or `off` is no longer a rollback to legacy:
  - In shadow, no journey controls a turn, so AC turns get hazard, unsafe, code, unsupported or intake outcomes.
  - In off, there is no cs/1 block, so every AC turn is an explicit error.
  - Rollback is the previous release's code or image.
- An appliance outside the typed families gets the repeated appliance clarify. The repeat guard stops it looping.
  This is a known limit.
- About 840 lines of legacy orchestration and the tests that only preserved the fallback are deleted.
- The runtime suite has no accepted-failure list: any failure fails the build.

## Alternatives considered

- **Keep the fallback and label it in telemetry.** Rejected: the customer still gets an unowned answer that looks normal.
- **Extend legacy to cover the remaining AC classes (oven B3/B4 and others).** Rejected: it grows a second decision
  path for AC.
- **Implement every unowned catalogue node canonically now.** Rejected: 94 nodes. Coverage is prioritised by real
  transcript use and safety, and the rest is explicit `UNSUPPORTED`.
