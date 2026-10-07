'use strict';
/**
 * AcDataStack-sbx (#34): the Phase 5 data resources, rehearsed on -sbx copies. L1 resources only, each with
 * DeletionPolicy and UpdateReplacePolicy Retain. Every property mirrors production (Phase 0 inventory) apart
 * from names, ARNs and the placeholder CloudFront distribution in the web bucket policy.
 */
const cdk = require('aws-cdk-lib');
const { aws_ecr: ecr, aws_secretsmanager: sm, aws_dynamodb: ddb, aws_s3: s3 } = cdk;
const { A, R, TAGS, retain, PLACEHOLDER_DISTRIBUTION, shellHandle } = require('./common');

const REPOSITORIES = ['spares4repairs-diag-orchestrator-sbx', 'spares4repairs-error-code-mcp-sbx'];
const SECRETS = [
  'applianceclinic-sbx/ai-config', 'applianceclinic-sbx/openai', 'applianceclinic-sbx/jev', 'applianceclinic-sbx/canonical-state-token',
  'applianceclinic-sbx/benchmark-service', 'applianceclinic-sbx/diag-orchestrator/bearer-token', 'applianceclinic-sbx/error-code-mcp/bearer-token',
];
const BUCKETS = { web: `whichpart-web-sbx-${A}`, learning: `whichpart-learning-sbx-${A}`, backup: `applianceclinic-migration-backup-sbx-${A}` };

/** Both production table shapes: they differ in the GSI sort key and in TTL. */
const TABLES = {
  'whichpart-transcripts-sbx': { sortKey: 'lastActivityAt', ttl: { attributeName: 'expiresAt', enabled: true } },
  'whichpart-recalls-sbx': { sortKey: 'gsiSk', ttl: null },
};

class DataStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    shellHandle(this);
    const logical = (name) => name.replace(/[^A-Za-z0-9]/g, '');

    for (const name of REPOSITORIES) {
      // The repository policy is written by Lambda when an image function is created, so it is not declared.
      retain(new ecr.CfnRepository(this, logical(name), {
        repositoryName: name,
        imageTagMutability: 'MUTABLE',
        imageScanningConfiguration: { scanOnPush: true },
        encryptionConfiguration: { encryptionType: 'AES256' },
        tags: TAGS,
      }));
    }

    for (const name of SECRETS) {
      // No value: the secret is imported, and a value never appears in a template.
      retain(new sm.CfnSecret(this, logical(name), { name, tags: TAGS }));
    }

    for (const [name, shape] of Object.entries(TABLES)) {
      retain(new ddb.CfnTable(this, logical(name), {
        tableName: name,
        billingMode: 'PAY_PER_REQUEST',
        keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
        attributeDefinitions: [
          { attributeName: 'gsiPk', attributeType: 'S' },
          { attributeName: shape.sortKey, attributeType: 'S' },
          { attributeName: 'pk', attributeType: 'S' },
        ],
        globalSecondaryIndexes: [{
          indexName: 'gsi_activity',
          keySchema: [{ attributeName: 'gsiPk', keyType: 'HASH' }, { attributeName: shape.sortKey, keyType: 'RANGE' }],
          projection: { projectionType: 'ALL' },
        }],
        ...(shape.ttl ? { timeToLiveSpecification: shape.ttl } : {}),
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        tableClass: 'STANDARD',
        deletionProtectionEnabled: false,
        tags: TAGS,
      }));
    }

    const buckets = {};
    for (const [key, name] of Object.entries(BUCKETS)) {
      buckets[key] = retain(new s3.CfnBucket(this, logical(name), {
        bucketName: name,
        ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
        publicAccessBlockConfiguration: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
        bucketEncryption: { serverSideEncryptionConfiguration: [{ serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' }, bucketKeyEnabled: false }] },
        tags: TAGS,
      }));
    }

    // The production web bucket's only statement, with a placeholder distribution: never E1QD02IAJZPJLM.
    retain(new s3.CfnBucketPolicy(this, 'WebBucketPolicy', {
      bucket: BUCKETS.web,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'AllowCloudFrontOAC',
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 's3:GetObject',
          Resource: `arn:aws:s3:::${BUCKETS.web}/*`,
          Condition: { StringEquals: { 'AWS:SourceArn': `arn:aws:cloudfront::${A}:distribution/${PLACEHOLDER_DISTRIBUTION}` } },
        }],
      },
    }));
    this.templateOptions.description = `AcDataStack-sbx: Phase 4 data imports (#34). Sandbox only, region ${R}.`;
  }
}

module.exports = { DataStack, REPOSITORIES, SECRETS, BUCKETS, TABLES };
