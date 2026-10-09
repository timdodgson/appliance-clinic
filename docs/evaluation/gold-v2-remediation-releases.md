# GOLD v2 remediation: production releases

Each release is code only, through `AcRuntimeStack` with the reviewed change process (`infra/production/steps/change.sh`).

| Change | Function(s) | CodeSha256 after | Checks after | CloudTrail |
|---|---|---|---|---|
| 8.4-gold-v2-1 | whichpart-api | `Ankxkep7EnwjJ8QAyk2nIDaB2p+Jhv6ko6kd7iJiikQ=` | S4R health 3×200, `/part-finder` contract, ingress, smoke, AC endpoints 8, AC auth 13 equal to before; drift IN_SYNC; no-op | ok, no failures |
