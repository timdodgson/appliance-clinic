import { describe, expect, it } from 'vitest';
import { backupPlan } from '../src/backup/plan.js';

const inventory = {
  tables: [{ tableName: 'whichpart-recalls', exists: true, pointInTimeRecovery: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' } } }],
  buckets: [{ bucket: 'whichpart-web-000000000000', exists: true, manifest: { objectCount: 1, totalBytes: 10, objects: [{ key: 'index.html' }] } }],
};
const candidates = { tables: ['whichpart-recalls'], buckets: ['whichpart-web-000000000000'] };
const denylist = [{ kind: 'physicalId', value: 'spares4repairs-orders-dev', reason: 'S4R', source: 'manual' }];

describe('backup plan', () => {
  it('plans backups, optional PITR and object copies into the backup bucket', () => {
    const plan = backupPlan({ inventory, candidates, denylist, backupBucket: 'applianceclinic-migration-backup-test', enablePitr: true, stamp: '20261007T0000' });
    expect(plan.map((a) => a.action)).toEqual(['CreateBackup', 'EnablePointInTimeRecovery', 'EnsureBackupBucket', 'CopyObjects']);
    expect(plan[3].prefix).toBe('whichpart-web-000000000000/20261007T0000/');
  });

  it('refuses a backup bucket outside the dedicated naming', () => {
    expect(() => backupPlan({ inventory, candidates, denylist, backupBucket: 'whichpart-web-000000000000', stamp: 's' })).toThrow(/must be named/);
  });

  it('refuses targets that are not AC candidates or are denylisted', () => {
    const s4r = { tables: [{ tableName: 'spares4repairs-orders-dev', exists: true }], buckets: [] };
    expect(() => backupPlan({ inventory: s4r, candidates, denylist, backupBucket: 'applianceclinic-migration-backup-test', stamp: 's' })).toThrow(/not an AC candidate/);
    expect(() => backupPlan({ inventory: s4r, candidates: { tables: ['spares4repairs-orders-dev'], buckets: [] }, denylist, backupBucket: 'applianceclinic-migration-backup-test', stamp: 's' })).toThrow(/denylist/);
  });
});
