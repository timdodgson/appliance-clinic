# Architecture decision records

Significant decisions are recorded here as short, numbered records, so the reasoning survives
alongside the code. A record is never rewritten after it is accepted; a later record supersedes it.

## Process

1. Copy [`template.md`](template.md) to `NNNN-short-title.md`, using the next number.
2. Open a pull request with the record in **Proposed** status.
3. On merge the status becomes **Accepted**. If a later decision replaces it, set it to
   **Superseded by NNNN** and link both ways.
4. When the decision is delivered, the status records it (**Implemented**, with the phase and the evidence). The
   decision text itself is not rewritten.

## Index

| Number | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-separate-appliance-clinic-from-spares4repairs.md) | Separate Appliance Clinic from Spares4Repairs | Accepted |
| [0003](0003-s4r-compatibility-boundary.md) | Spares4Repairs compatibility boundary | Accepted; `/part-finder` contract parts superseded by [0019](0019-dedicated-canonical-diagnosis-engine.md) |
| [0004](0004-import-existing-resources-into-cdk.md) | Import existing AWS resources into CDK | Accepted |
| [0005](0005-dedicated-cdk-bootstrap.md) | Dedicated CDK bootstrap for Appliance Clinic | Accepted |
| [0006](0006-dedicated-cognito-for-appliance-clinic.md) | Dedicated Cognito for Appliance Clinic | Accepted |
| [0007](0007-separate-data-and-runtime-stacks.md) | Separate data and runtime stacks | Accepted |
| [0008](0008-cloudfront-initially-unmanaged.md) | CloudFront initially unmanaged | Accepted |
| [0009](0009-evaluation-strategy.md) | Evaluation strategy | Accepted |
| [0010](0010-deterministic-policy-around-llm.md) | Deterministic policy around the language model | Accepted |
| [0011](0011-diagnosis-lambda-keeps-the-s4r-execution-role.md) | The diagnosis Lambda keeps the S4R execution role during the migration | Superseded (Phase 7 change 7.15b) |
| [0012](0012-legacy-diagnosis-pipeline-retained.md) | The legacy diagnosis pipeline is retained | Superseded by [0019](0019-dedicated-canonical-diagnosis-engine.md) |
| [0013](0013-prompt-registry-and-contract-types.md) | Prompt registry and contract types | Accepted; amended by [0019](0019-dedicated-canonical-diagnosis-engine.md) |
| [0014](0014-cs1-is-the-only-conversation-state.md) | cs/1 is the only conversation state | Implemented (Phase 11) |
| [0015](0015-one-owner-per-decision.md) | One owner per decision | Accepted; partly implemented (state and token commit Phase 11; cause label and token decision single-owned Phase 12) |
| [0016](0016-degraded-turns-are-errors.md) | Degraded turns are errors, not normal replies | Implemented (Phase 10) |
| [0017](0017-authenticate-orchestrator-only-engine-fields.md) | Authenticate the orchestrator-only engine fields | Implemented (Phase 11); amended by [0019](0019-dedicated-canonical-diagnosis-engine.md) |
| [0018](0018-no-ac-legacy-fallback.md) | No Appliance Clinic turn falls back to the legacy pipeline | Implemented (Phase 13); amended by [0019](0019-dedicated-canonical-diagnosis-engine.md) |
| [0019](0019-dedicated-canonical-diagnosis-engine.md) | Appliance Clinic uses a dedicated canonical diagnosis engine | Implemented (Phase 15) |
| [0020](0020-llm-led-diagnosis-with-deterministic-guardrails.md) | LLM-led diagnosis inside a deterministic guardrail kernel | Accepted; amended by [0021](0021-understand-label-enrich-decide-reply.md) ([evaluation](../evaluation/llm-led-rebuild.md)) |
| [0021](0021-understand-label-enrich-decide-reply.md) | One turn: Qwen understands, Jev labels, tools enrich, code decides, Qwen replies | Implemented (changes 21.2, 21.3) |
