# Phase 4: recovery runbook

How to recover AC's data if a Phase 5 import, or any later change, damages it. Each procedure below was rehearsed on
the `-sbx` copies, with synthetic data only ([`steps/70-recovery.sh`](../../../infra/sandbox/steps/70-recovery.sh),
#34). The timings are sandbox timings for 100 items or a few dozen objects; production tables are larger (see
[Scale](#scale)).

**Classification:**
- Restoring into a **new** table or a backup prefix is SAFE AC CHANGE: it creates resources and touches nothing in
  service.
- **Putting a restored copy into service** (the switch-back) is POTENTIALLY IMPACTS S4R when the diagnosis Lambda
  reads the resource, and needs sign-off on the step's issue. No production restore or switch-back was rehearsed.

**Never:** restore over a table in place (DynamoDB cannot), delete the damaged table before its restored copy is
verified, or read, copy or restore production backups anywhere but production. They hold customer conversations.

## What exists to restore from

| Resource | Backup | Source |
|---|---|---|
| `whichpart-transcripts`, `whichpart-recalls` | PITR (35-day window) and the on-demand backups `ac-migration-whichpart-*-20261007T0142` | [Phase 0 backups](phase-0-backups.md) |
| `whichpart-web-<account>`, `whichpart-learning-<account>` | Copies under `applianceclinic-migration-backup-<account>/<source-bucket>/<timestamp>/` | Phase 0 backups |
| Lambda code and images | The Phase 3 zips (CodeSha256 recorded) and the production image digests | [Phase 3](phase-3-reproducible-build.md) |

## Rehearsed timings

Measured on 2026-10-07 in the sandbox (100 synthetic items per table; 6 and 20 objects per bucket), as
`ac-operator-sbx`. Times run from the API call to the restored table and every GSI being `ACTIVE`.

| Procedure | `whichpart-transcripts-sbx` | `whichpart-recalls-sbx` | Result |
|---|---|---|---|
| On-demand backup to `AVAILABLE` | 4 s | 3 s | |
| Restore from backup, to `ACTIVE` with GSI | 188 s | 228 s | All 100 items identical. TTL and PITR off on the restored table |
| Restore to a point in time, to `ACTIVE` with GSI | 267 s | 267 s | All 100 items as at the point; 5 deletes, 5 updates and 5 inserts made after it absent. TTL and PITR off |

| Procedure | `whichpart-web-sbx` (6 objects) | `whichpart-learning-sbx` (20 objects) | Result |
|---|---|---|---|
| Copy into the backup bucket | 2 s | 3 s | SHA-256 of every object equal |
| Restore after 3 overwrites and 3 deletes | 3 s | 4 s | Count and SHA-256 of every object equal |

An earlier run, interrupted by a container restart and then by an expired session, measured 207 to 247 s for the
backup restores and 288 s for one point-in-time restore: allow about five minutes per restore at this size.

## 1. DynamoDB: restore an on-demand backup

```bash
T=whichpart-recalls                 # or whichpart-transcripts
R=$T-restored-$(date -u +%Y%m%d)    # a new name: a restore never overwrites
aws dynamodb list-backups --table-name $T --query 'BackupSummaries[].[BackupName,BackupCreationDateTime,BackupStatus,BackupArn]' --output table
aws dynamodb restore-table-from-backup --target-table-name $R --backup-arn <BackupArn>
aws dynamodb wait table-exists --table-name $R
# GSIs build after the table is ACTIVE: wait until every IndexStatus is ACTIVE.
aws dynamodb describe-table --table-name $R --query '[Table.TableStatus, Table.GlobalSecondaryIndexes[].IndexStatus]'
```

**Verify:** item count, and every key present (`scan --projection-expression pk`, compared with the backup's
`ItemCount` and, where possible, with a scan of the source taken at backup time). In the rehearsal every item was
identical.

**A restored table carries no TTL, no PITR and no tags.** Before putting it into service:
```bash
aws dynamodb update-time-to-live --table-name $R --time-to-live-specification Enabled=true,AttributeName=expiresAt   # transcripts only
aws dynamodb update-continuous-backups --table-name $R --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
aws dynamodb tag-resource --resource-arn <table ARN> --tags <the source table's tags>
```

## 2. DynamoDB: restore to a point in time

Choose the point **before** the damage: the time of the change set's execution from its stack events, minus a
minute.

```bash
aws dynamodb describe-continuous-backups --table-name $T \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.[EarliestRestorableDateTime,LatestRestorableDateTime]'
aws dynamodb restore-table-to-point-in-time --source-table-name $T --target-table-name $R --restore-date-time <point>
```

Then wait, verify and add TTL, PITR and tags exactly as in section 1. In the rehearsal, deletes, updates and inserts
made after the point were all absent from the restored table, and every other item was as it was at the point.
`LatestRestorableDateTime` trails the present by a few minutes: a point newer than it is refused.

## 3. S3: restore from the backup copy

```bash
B=whichpart-learning-<account>      # or whichpart-web-<account>
TS=<timestamp>                       # aws s3 ls s3://applianceclinic-migration-backup-<account>/$B/
aws s3 cp --recursive s3://applianceclinic-migration-backup-<account>/$B/$TS/ s3://$B/
```

Use `cp --recursive`, not `sync`: `sync` skips an object whose damaged copy is the same size and newer, so an
overwrite can survive it. Objects created after the backup are not removed by the copy; list them
(`comm` of the two key lists) and decide each one, since they may be real records written since.

**Verify:** object count and the SHA-256 of every object against the backup copy. In the rehearsal both matched
exactly after three overwrites and three deletes.

## 4. Switch back (procedure only, not rehearsed in production)

DynamoDB cannot rename a table, so a restored table goes into service in one of two ways:

1. **Point the functions at it.** Change `RECALL_TABLE` or `TRANSCRIPT_TABLE` on `whichpart-api` and the table ARNs
   in its inline policies, as a reviewed change set (update mode, IAM changes listed). The damaged table stays,
   untouched, until the restored one has been verified in service. Then import the restored table into the stack
   in place of the old one (Retain on both), as its own reviewed step.
2. **Copy back.** Write the restored items into the original table (for example a scan and batch-write, or an
   export and import). Slower, but nothing else changes. Prefer it for small tables such as `whichpart-recalls`.

For S3 the restore writes into the original bucket, so there is no switch-back.

Afterwards run the post-import checks (PLAN.md, *After each production import*): configuration comparison, drift,
smoke tests and the S4R checks, including `/ai/chat` if the diagnosis Lambda was touched.

## 5. If a recovery is interrupted

A recovery that stops part-way (in the rehearsal, a container restart) leaves restored tables and backups behind
and may leave the source half-changed. Before starting again:
- let any restore in progress finish (`wait table-exists`), then delete the half-made restored table by name;
- compare the source with what it should hold, and put it back first;
- delete any on-demand backup the attempt created (keep the Phase 0 ones).

## Scale

Restore time grows with table size. The sandbox tables held 100 items; production `whichpart-transcripts` holds about
29,500 and `whichpart-recalls` about 1,050 ([Phase 0 findings](../phase-0-findings.md)). Expect the production restore
to take longer than the times above, and plan any switch-back out of shop hours.
