/**
 * Build the Phase 0 backup plan from an inventory. Pure: no AWS calls.
 * Classification of every action: SAFE AC CHANGE.
 */
import { findExactHits } from '../denylist/match.js';

export const BACKUP_BUCKET_PREFIX = 'applianceclinic-migration-backup-';

export function backupPlan({ inventory, candidates, denylist, backupBucket, enablePitr, stamp }) {
  if (!backupBucket || !backupBucket.startsWith(BACKUP_BUCKET_PREFIX)) {
    throw new Error(`Backup bucket must be named ${BACKUP_BUCKET_PREFIX}<suffix>.`);
  }
  const refuse = (kind, name) => {
    if (findExactHits(denylist, name).length) throw new Error(`Refused ${kind} ${name}: it is on the S4R denylist.`);
  };
  const actions = [];

  for (const t of inventory.tables) {
    if (!t.exists) continue;
    if (!candidates.tables.includes(t.tableName)) throw new Error(`Refused table ${t.tableName}: not an AC candidate.`);
    refuse('table', t.tableName);
    actions.push({ service: 'dynamodb', action: 'CreateBackup', table: t.tableName, backupName: `ac-migration-${t.tableName}-${stamp}` });
    const pitr = t.pointInTimeRecovery && t.pointInTimeRecovery.PointInTimeRecoveryDescription;
    const enabled = pitr && pitr.PointInTimeRecoveryStatus === 'ENABLED';
    if (enablePitr && !enabled) actions.push({ service: 'dynamodb', action: 'EnablePointInTimeRecovery', table: t.tableName, note: 'Record this in the CDK definition before import.' });
  }

  refuse('bucket', backupBucket);
  actions.push({ service: 's3', action: 'EnsureBackupBucket', bucket: backupBucket });
  for (const b of inventory.buckets) {
    if (!b.exists) continue;
    if (!candidates.buckets.includes(b.bucket)) throw new Error(`Refused bucket ${b.bucket}: not an AC candidate.`);
    refuse('bucket', b.bucket);
    if (!b.manifest) throw new Error(`Bucket ${b.bucket} has no object manifest in the inventory.`);
    actions.push({ service: 's3', action: 'CopyObjects', source: b.bucket, target: backupBucket, prefix: `${b.bucket}/${stamp}/`, objectCount: b.manifest.objectCount, totalBytes: b.manifest.totalBytes, keys: b.manifest.objects.map((o) => o.key) });
  }
  return actions;
}
