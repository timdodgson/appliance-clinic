# GOLD v2 remediation: production releases

Each release is code only, through `AcRuntimeStack` with the reviewed change process (`infra/production/steps/change.sh`).

| Change | Function(s) | CodeSha256 after | Checks after | CloudTrail |
|---|---|---|---|---|
| 8.4-gold-v2-1 | whichpart-api | `Ankxkep7EnwjJ8QAyk2nIDaB2p+Jhv6ko6kd7iJiikQ=` | S4R health 3×200, `/part-finder` contract, ingress, smoke, AC endpoints 8, AC auth 13 equal to before; drift IN_SYNC; no-op | ok, no failures |
| 8.5-progression | spares4repairs-part-finder, whichpart-api | `DJcWEwQyaUQQ+MiPHgRoLL9OJzzIUMoFAPurLHMIq0M=`, `j5Th3HTJ+9jMOiksexkSwiYp8a8mq3pTz64hrFZAg2c=` | S4R health 3×200, contract, ingress, smoke, AC endpoints 8, AC auth 13, diagnosis role 9; drift IN_SYNC; no-op | ok, no failures |
| 8.6-diagnostics | spares4repairs-part-finder | `H7lM+cNdnkh0JN69naOWqBGDVptfrQP479G66lSHI0k=` | S4R health 3×200, contract, ingress, smoke, AC endpoints 8, AC auth 13, diagnosis role 9 (first attempt's contract call returned no output client-side, no Lambda error logged; reruns 9/9); drift IN_SYNC; no-op | ok, no failures |
| 8.7-throttle-retry | whichpart-api | `WZ25sMt5NfH5GTflfp8e1568fAHQAwuHJ4dhT2Xv56s=` | S4R health 3×200, contract, ingress, smoke, AC endpoints 8, AC auth 13; drift IN_SYNC; no-op | ok, no failures |
