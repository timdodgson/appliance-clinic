# Phase 5 results

What the production import (PLAN.md, Phase 5; [runbook](runbooks/phase-5-import.md)) did, step by step. Every step
ran as the IAM user in account `800960611664`, eu-west-1; every resource operation went through CloudFormation with the
read-only `acclinic` execution role. Raw outputs stay in `.migration-output/phase5/`.

## Pre-flight (2026-10-07)

| Gate | Result |
|---|---|
| Pre-Phase-5 inventory | Taken; `compare:config` against the inventory before the Phase 4 sandbox: 0 differences |
| S4R denylist regenerated | 79 entries, identical to the committed denylist |
| Freeze (#2) | Open; routing override lease `released` |
| Backups | PITR continuous on both tables (latest restorable point minutes old); Phase 0 on-demand backups from 01:42Z |
| S4R and AC checks | S4R health 3 × 200; `/part-finder` contract captured (preflight and POST 200, CORS for `https://spares4repairs.co.uk`, NDJSON); `/ai/chat` 500 as in the Phase 0 baseline; smoke: 4 scenarios 200, safety decisions as expected |
