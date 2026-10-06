#!/usr/bin/env node
/**
 * Phase 0 backups. MUTATING (SAFE AC CHANGE). Prints the plan and does nothing unless
 * --execute and --confirm-account <id> are both given. Only these commands can run:
 * DynamoDB CreateBackup and UpdateContinuousBackups; S3 CreateBucket, PutPublicAccessBlock
 * and CopyObject (into the backup bucket only).
 *
 *   node bin/backup.mjs --inventory <dir> --backup-bucket applianceclinic-migration-backup-<suffix>
 *                       [--enable-pitr] [--execute --confirm-account <id>]
 */
import { join } from 'node:path';
import { CreateBackupCommand, DynamoDBClient, UpdateContinuousBackupsCommand } from '@aws-sdk/client-dynamodb';
import { CopyObjectCommand, CreateBucketCommand, HeadBucketCommand, PutPublicAccessBlockCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { guardAllowlist } from '../src/aws/allowlisted-client.js';
import { guardReadOnly } from '../src/aws/readonly-client.js';
import { backupPlan } from '../src/backup/plan.js';
import { loadResourceConfig, withAccount } from '../src/config.js';
import { parseArgs, requireFlag } from '../src/util/args.js';
import { readJson, writeJson, REPO_ROOT } from '../src/util/files.js';

const { flags } = parseArgs(process.argv.slice(2));
const dir = String(requireFlag(flags, 'inventory'));
const config = loadResourceConfig();
const meta = readJson(join(dir, 'meta.json'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const plan = backupPlan({
  inventory: { tables: readJson(join(dir, 'dynamodb-tables.json')), buckets: readJson(join(dir, 's3-buckets.json')) },
  candidates: { tables: config.tables, buckets: config.buckets.map((b) => withAccount(b.name, meta.accountId)) },
  denylist: readJson(join(REPO_ROOT, 'docs', 'migration', 's4r-denylist.json')).entries,
  backupBucket: String(requireFlag(flags, 'backup-bucket')),
  enablePitr: Boolean(flags['enable-pitr']),
  stamp,
});

console.log('Backup plan (SAFE AC CHANGE):');
for (const a of plan) console.log(`  ${a.service} ${a.action} ${a.table || a.bucket || `${a.source} -> ${a.target}/${a.prefix} (${a.objectCount} objects, ${a.totalBytes} bytes)`}`);
if (!flags.execute) { console.log('\nDry run. Nothing was changed. Add --execute --confirm-account <id> to run it.'); process.exit(0); }

const sts = guardReadOnly(new STSClient({ region: config.region }));
const account = (await sts.send(new GetCallerIdentityCommand({}))).Account;
if (String(flags['confirm-account'] || '') !== account || account !== meta.accountId) {
  console.error(`Refusing to run: --confirm-account must equal the caller account (${account}) and the inventory account (${meta.accountId}).`);
  process.exit(2);
}
const ddb = guardAllowlist(new DynamoDBClient({ region: config.region }), ['CreateBackupCommand', 'UpdateContinuousBackupsCommand']);
const s3 = guardAllowlist(new S3Client({ region: config.region }), ['CreateBucketCommand', 'PutPublicAccessBlockCommand', 'CopyObjectCommand']);
const log = [];
for (const a of plan) {
  if (a.action === 'CreateBackup') {
    const r = await ddb.send(new CreateBackupCommand({ TableName: a.table, BackupName: a.backupName }));
    log.push({ ...a, backupArn: r.BackupDetails.BackupArn });
  } else if (a.action === 'EnablePointInTimeRecovery') {
    await ddb.send(new UpdateContinuousBackupsCommand({ TableName: a.table, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }));
    log.push(a);
  } else if (a.action === 'EnsureBackupBucket') {
    let exists = true;
    try { await s3.send(new HeadBucketCommand({ Bucket: a.bucket })); } catch { exists = false; }
    if (!exists) {
      await s3.send(new CreateBucketCommand({ Bucket: a.bucket, CreateBucketConfiguration: { LocationConstraint: config.region } }));
      await s3.send(new PutPublicAccessBlockCommand({ Bucket: a.bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }));
    }
    log.push({ ...a, created: !exists });
  } else if (a.action === 'CopyObjects') {
    let copied = 0;
    for (const key of a.keys) {
      await s3.send(new CopyObjectCommand({ Bucket: a.target, Key: `${a.prefix}${key}`, CopySource: `${a.source}/${encodeURIComponent(key).replace(/%2F/g, '/')}` }));
      copied += 1;
    }
    log.push({ service: a.service, action: a.action, source: a.source, target: a.target, prefix: a.prefix, copied });
  }
  console.log(`  done: ${a.action} ${a.table || a.bucket || a.source}`);
}
writeJson(join(dir, `backup-log-${stamp}.json`), log);
console.log(`\nBackups complete. Log written to ${join(dir, `backup-log-${stamp}.json`)}`);
