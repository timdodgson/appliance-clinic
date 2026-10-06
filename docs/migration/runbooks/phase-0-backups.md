# Phase 0: backups

**Classification:** SAFE AC CHANGE. This is the only Phase 0 runbook that changes AWS.

Nothing here touches an S4R resource. The tool refuses any table or bucket that is not an AC
candidate or that appears on the S4R denylist.

## Prerequisites

- An inventory from [phase-0-inventory.md](phase-0-inventory.md), and the denylist generated from it.
- AWS profile `ac-backup` (see [conventions](README.md#aws-profiles)).
- A backup bucket name of the form `applianceclinic-migration-backup-<suffix>`.

## 1. Review the plan (no changes)

```bash
cd tools/migration
AWS_PROFILE=ac-backup npm run backup -- --inventory ../../.migration-output/inventory-<ts> \
  --backup-bucket applianceclinic-migration-backup-<suffix> --enable-pitr
```

The tool prints every action and changes nothing.

## 2. Execute

```bash
AWS_PROFILE=ac-backup npm run backup -- --inventory ../../.migration-output/inventory-<ts> \
  --backup-bucket applianceclinic-migration-backup-<suffix> --enable-pitr \
  --execute --confirm-account <account-id>
```

| Action | Effect |
|---|---|
| DynamoDB `CreateBackup` for each AC table | On-demand backup, kept until deleted |
| DynamoDB `UpdateContinuousBackups` (with `--enable-pitr`, only where disabled) | Enables point-in-time recovery |
| S3 `CreateBucket` and `PutPublicAccessBlock` | Creates the private backup bucket if it does not exist |
| S3 `CopyObject` for every object in each AC bucket | Copies into `<backup-bucket>/<source-bucket>/<timestamp>/` |

**Verify:** the tool writes `backup-log-<stamp>.json` into the inventory directory. Check that each
backup ARN shows `AVAILABLE` in the DynamoDB console, and that the copied object counts match the
inventory manifests.

## Notes

- **PITR is a configuration change.** Re-run the inventory afterwards so the baseline records
  PITR as enabled. The Phase 5 CDK definitions must declare it enabled, or the first CDK update
  would turn it off.
- **The transcripts table holds customer conversations** with a 90-day TTL. Its backup stays in the
  same account and region, and is deleted once Phase 6 exits.

## Rollback

- Disable PITR with `aws dynamodb update-continuous-backups --point-in-time-recovery-specification PointInTimeRecoveryEnabled=false`,
  if it was disabled before. The inventory records the earlier state.
- Delete the backups and the backup bucket once they are no longer needed.
