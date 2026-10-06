# Architecture decision records

Significant decisions are recorded here as short, numbered records, so the reasoning survives
alongside the code. A record is never rewritten after it is accepted; a later record supersedes it.

## Process

1. Copy [`template.md`](template.md) to `NNNN-short-title.md`, using the next number.
2. Open a pull request with the record in **Proposed** status.
3. On merge the status becomes **Accepted**. If a later decision replaces it, set it to
   **Superseded by NNNN** and link both ways.

## Index

| Number | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-separate-appliance-clinic-from-spares4repairs.md) | Separate Appliance Clinic from Spares4Repairs | Accepted |
| [0003](0003-s4r-compatibility-boundary.md) | Spares4Repairs compatibility boundary | Accepted |
| [0004](0004-import-existing-resources-into-cdk.md) | Import existing AWS resources into CDK | Accepted |
| [0005](0005-dedicated-cdk-bootstrap.md) | Dedicated CDK bootstrap for Appliance Clinic | Accepted |
| [0006](0006-dedicated-cognito-for-appliance-clinic.md) | Dedicated Cognito for Appliance Clinic | Accepted |
| [0007](0007-separate-data-and-runtime-stacks.md) | Separate data and runtime stacks | Accepted |
| [0008](0008-cloudfront-initially-unmanaged.md) | CloudFront initially unmanaged | Accepted |
| [0009](0009-evaluation-strategy.md) | Evaluation strategy | Accepted |
| [0010](0010-deterministic-policy-around-llm.md) | Deterministic policy around the language model | Accepted |
