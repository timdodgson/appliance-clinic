import {
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListBackupsCommand,
  ListTagsOfResourceCommand,
} from '@aws-sdk/client-dynamodb';
import { collectPages, optional } from '../util/aws-errors.js';

/** Table configuration only. Items are never read: the transcripts table holds customer data. */
export async function inventoryTable(dynamodb, tableName) {
  const desc = await optional(dynamodb.send(new DescribeTableCommand({ TableName: tableName })));
  if (!desc) return { tableName, exists: false };
  const t = desc.Table;
  const ttl = await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
  const backups = await dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: tableName }));
  const tags = await collectPages(
    (NextToken) => dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: t.TableArn, NextToken })),
    (p) => p.Tags,
    (p) => p.NextToken,
  );
  const onDemandBackups = await dynamodb.send(new ListBackupsCommand({ TableName: tableName }));
  return {
    tableName,
    exists: true,
    arn: t.TableArn,
    creationDateTime: t.CreationDateTime,
    keySchema: t.KeySchema,
    attributeDefinitions: t.AttributeDefinitions,
    billingMode: (t.BillingModeSummary && t.BillingModeSummary.BillingMode) || 'PROVISIONED',
    provisionedThroughput: t.ProvisionedThroughput,
    globalSecondaryIndexes: (t.GlobalSecondaryIndexes || []).map((g) => ({
      indexName: g.IndexName,
      keySchema: g.KeySchema,
      projection: g.Projection,
      provisionedThroughput: g.ProvisionedThroughput,
    })),
    localSecondaryIndexes: t.LocalSecondaryIndexes || [],
    streamSpecification: t.StreamSpecification || null,
    sseDescription: t.SSEDescription || null,
    tableClass: (t.TableClassSummary && t.TableClassSummary.TableClass) || 'STANDARD',
    deletionProtectionEnabled: Boolean(t.DeletionProtectionEnabled),
    timeToLive: ttl.TimeToLiveDescription,
    pointInTimeRecovery: backups.ContinuousBackupsDescription,
    onDemandBackups: (onDemandBackups.BackupSummaries || []).map((b) => ({ name: b.BackupName, arn: b.BackupArn, created: b.BackupCreationDateTime, status: b.BackupStatus })),
    tags,
    itemCount: t.ItemCount,
    tableSizeBytes: t.TableSizeBytes,
  };
}
