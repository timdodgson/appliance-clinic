# Lambda concurrency: findings and the recommended account quota (Phase 11, F)

Read-only analysis on 2026-10-10. Raw data: [concurrency-evidence.json](phase-11/concurrency-evidence.json) (CloudWatch `AWS/Lambda`).

## Findings

| Item | Value |
|---|---|
| Account quota, concurrent executions (`L-B99A9384`) | **10** (adjustable; the AWS default for an account is 1,000). No increase has ever been requested |
| Unreserved | 10: no function has reserved or provisioned concurrency |
| Functions sharing the pool | AC: `whichpart-api`, `spares4repairs-diag-orchestrator`, `spares4repairs-part-finder`, `spares4repairs-error-code-mcp`. S4R: `spares4repairs-server-dev` (and a CDK custom resource) |
| Account concurrency, 14 days, 1-minute maximum | median 3; **at the full 10 in 383 minutes**; p95 of active minutes = 10 |
| S4R `spares4repairs-server-dev` | pinned at 10 in 314 minutes (14 days); **2,017 throttles in 30 days**; its true peak is censored by the limit |
| AC per-function peaks (1-minute max) | whichpart-api 7, orchestrator 4, part-finder 4, MCP 3 |
| AC chain (sum per minute) | max 12, p99 8, p95 6. One AC turn holds three functions at once (BFF → orchestrator → engine), for up to ~52 s at p99 |
| AC throttles, 30 days | 59 (whichpart-api 19, orchestrator 27, part-finder 13) |
| Retry behaviour | BFF → orchestrator: one retry on 429. Orchestrator → engine: one 0.6 s retry on 429 (10.7). S4R → engine: none known. Throttling is visible to customers on both sites |

The pool is saturated: S4R alone fills it, and every AC turn needs three concurrent slots, so AC and S4R throttle each other.

## Recommendation

**Request an account quota of 100 concurrent executions** (from 10).

- Demand today: S4R at least 10 (censored, with sustained throttling), allow 3× → about 30. AC chain peak 12, allow 1.5× for batch evaluation runs → about 18. Combined about 50.
- 100 gives about 2× headroom over that estimate, and room to later reserve concurrency so neither site can starve the other (for example S4R 30, AC 30) while keeping the AWS minimum of 10 unreserved.
- It is far below the AWS default of 1,000, so it bounds cost and blast radius.

Reserved concurrency is **not** configured now: with a limit of 10 any reservation would only move the throttling. Revisit reservations once the quota is raised and a week of unthrottled peaks has been observed.

## Owner action (the only one left from Phase 11)

The request is an account-level Service Quotas change made by the account owner:

```
aws service-quotas request-service-quota-increase \
  --service-code lambda --quota-code L-B99A9384 --desired-value 100 --region eu-west-1
```

Or the console: Service Quotas → AWS services → AWS Lambda → Concurrent executions → Request increase at account level → 100.
