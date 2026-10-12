# 0019. Appliance Clinic uses a dedicated canonical diagnosis engine

- **Status:** Implemented (Phase 15, changes 15.1a–15.4, pull request #121 merged as `10ab5ff`; [results](../evaluation/phase-15-results.md))
- **Date:** 2026-10-12
- **Supersedes:** [0012](0012-legacy-diagnosis-pipeline-retained.md) (the legacy pipeline is retained).
- **Amends:** [0017](0017-authenticate-orchestrator-only-engine-fields.md) and [0018](0018-no-ac-legacy-fallback.md):
  the engine signature is now required on every request, and there is no unsigned path.

## Context

After [0018](0018-no-ac-legacy-fallback.md), no Appliance Clinic (AC) turn reached the legacy pipeline. It still lived in
the same Lambda as the canonical runtime (`spares4repairs-part-finder`), because S4R's `/part-finder` page called that
Lambda's public Function URL with a plain, unsigned `{messages}` request.

That sharing cost AC on every release:

| Cost | Detail |
|---|---|
| A public, anonymous URL | Function URL auth `NONE` with CORS `*`, so the internal fields had to be protected inside the function ([0017](0017-authenticate-orchestrator-only-engine-fields.md)) |
| Dead weight in the artefact | The legacy pipeline, legacy COMPOSE, retrieval and the knowledge index shipped in every AC release |
| S4R gates on AC releases | Every engine change needed the `/part-finder` contract, ingress, smoke and S4R health checks |
| Two decision paths | One engine with canonical and legacy, and an equivalence test guarding duplicated evidence scoring |

S4R is now an external consumer of the old engine. AC has no reason to keep serving it from AC's own runtime.

## Decision

1. **AC gets its own engine.** `applianceclinic-diagnosis-engine` (source `services/diagnosis-engine/`, handler
   `handler.handler`, nodejs22.x) is created by `AcRuntimeStack` through the reviewed `change.sh` process. It has its own
   execution role (`ac-diagnosis-engine-role`), log group, metric filters and alarms.
2. **It is canonical only.** It holds the canonical runtime and the modules it needs: Jev understanding and mc/1,
   identity, the token gate, the cs/1 merge, deterministic diagnostics, safety, policy, the part gate, canonical COMPOSE
   with its checks, media selection and the output tripwire. The legacy pipeline is deleted from AC.
3. **Every request is authenticated twice.**
   - The Function URL uses `AWS_IAM` auth, with no CORS. Only the orchestrator and whichpart-api roles may invoke it
     (inline policy `ac-invoke-diagnosis-engine`), and they SigV4-sign every call.
   - Every POST also carries the HMAC engine signature (`x-ac-engine-signature`, [0017](0017-authenticate-orchestrator-only-engine-fields.md)).
     An unsigned or wrongly signed request is refused (`401 engine_signature_required`). Fields are no longer "dropped":
     there is no plain `{messages}` path.
4. **Responses are buffered JSON lines, internal to AC.** No streaming, and no compatibility with the S4R frames.
5. **The old shared engine is not modified.** `spares4repairs-part-finder` stays exactly as it is and keeps serving
   S4R. AC sends it no traffic after the cutover. Its CDK ownership is relinquished with `Retain` and zero physical
   change, or the step is reported blocked if a zero-mutation change set cannot be proven (see the
   [Phase 15 results](../evaluation/phase-15-results.md)).

## Consequences

- One canonical implementation for AC, and one decision path per turn.
- AC releases no longer run S4R contract, ingress, smoke or health gates. Those gates are retired from the AC change
  process.
- AC's engine is not reachable from a browser or by an anonymous caller.
- The admin knowledge-publish workflow is removed, because it only fed the legacy retrieval index. Read-only knowledge
  inspection stays.
- New alarms (`FailedTurns`, `RefusedRequests`, `Errors`, `Throttles`) exist, with no notification target yet.
- **Residual coupling, stated honestly.** The old engine still runs in AC's AWS account, on `ac-diagnosis-role`, with AC
  secrets and AC's Jev credit. Changing that would modify resources the old engine depends on, which this decision
  deliberately does not do. Moving it is S4R's change to make.

## Alternatives considered

- **Fork the code: a frozen copy for S4R, a canonical copy for AC, both in this repository.** Rejected: there must be one
  canonical implementation. The old engine already exists as the S4R copy; AC does not maintain it.
- **Keep sharing the Lambda, with a flag that turns off the legacy path for AC.** Rejected: the URL stays public and
  anonymous, the legacy code still ships, and S4R gates still apply to every AC release.
- **Modify the old engine in place (remove legacy, add IAM auth).** Rejected: it is now an external consumer's runtime.
  Changing it changes S4R.
