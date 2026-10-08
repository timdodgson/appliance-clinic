'use strict';
/**
 * AcDataStack (Phase 5 steps 5.1 to 5.4). L1 resources only, Retain everywhere. Every property is the LIVE production
 * value, read on 2026-10-07 (docs/migration/phase-5-results.md); nothing is added, normalised or improved. A property
 * that is not declared here is left as it is live and is not managed:
 *   - the ECR repository policies, written by Lambda when the image functions were created (as rehearsed in Phase 4)
 *   - secret values, which never appear in a template
 */
const cdk = require('aws-cdk-lib');
const { aws_ecr: ecr, aws_secretsmanager: sm, aws_dynamodb: ddb, aws_s3: s3 } = cdk;
const { A, upTo, retain, shellHandle, logical, namer } = require('./common');

const REPOSITORIES = { 'spares4repairs-error-code-mcp': '5.1', 'spares4repairs-diag-orchestrator': '5.2' };

/** Name and the live description, where one is set. No tags, default KMS key, no rotation, no resource policy. */
const SECRETS = {
  'spares4repairs/dev/applianceclinic-ai-config': null,
  'spares4repairs/dev/applianceclinic-openai': null,
  'spares4repairs/dev/applianceclinic-jev': null,
  'spares4repairs/dev/applianceclinic-canonical-state-token': 'ApplianceClinic Stage C canonical state token HMAC signing secret {current, previous}',
  'spares4repairs/dev/applianceclinic-benchmark-service': 'ApplianceClinic benchmark/test runner service auth (HMAC key for x-benchmark-signature). Read by whichpart-api and the local batch runners.',
  'spares4repairs/diag-orchestrator/bearer-token': null,
  'spares4repairs/error-code-mcp/bearer-token': null,
};

/** Both live table shapes: on-demand, key pk, GSI gsi_activity (ALL), PITR on, no streams, no tags. */
const TABLES = {
  'whichpart-recalls': { step: '5.3a', sortKey: 'gsiSk', ttl: null },
  'whichpart-transcripts': { step: '5.3b', sortKey: 'lastActivityAt', ttl: { attributeName: 'expiresAt', enabled: true } },
};

const BUCKETS = [`whichpart-web-${A}`, `whichpart-learning-${A}`];

/**
 * The repository policy Lambda writes when an image function is created: identical on both live repositories. The
 * sandbox profile narrows the condition to sandbox functions (the probe's guard refuses an account-wide pattern); the
 * statement's shape, principal and actions are the same.
 */
const lambdaEcrPolicy = (functions) => ({
  Version: '2008-10-17',
  Statement: [{
    Sid: 'LambdaECRImageRetrievalPolicy',
    Effect: 'Allow',
    Principal: { Service: 'lambda.amazonaws.com' },
    Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:SetRepositoryPolicy', 'ecr:DeleteRepositoryPolicy', 'ecr:GetRepositoryPolicy'],
    Condition: { StringLike: { 'aws:sourceArn': `arn:aws:lambda:eu-west-1:${A}:function:${functions}` } },
  }],
});
const LAMBDA_ECR_POLICY = lambdaEcrPolicy('*');

class DataStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const has = upTo(props.step);
    const N = namer(props.profile || 'production');
    // Choices that the import-semantics probe settles (docs/migration/phase-5-import-writes.json).
    const declare = props.declare || {};
    shellHandle(this);

    for (const [name, step] of Object.entries(REPOSITORIES)) {
      if (!has(step)) continue;
      retain(new ecr.CfnRepository(this, logical(name), {
        repositoryName: N(name),
        imageTagMutability: 'MUTABLE',
        imageScanningConfiguration: { scanOnPush: true },
        encryptionConfiguration: { encryptionType: 'AES256' },
        ...(declare.ecrRepositoryPolicy ? { repositoryPolicyText: lambdaEcrPolicy(props.profile === 'sandbox' ? '*-sbx' : '*') } : {}),
      }));
    }

    if (has('5.2')) {
      for (const [name, description] of Object.entries(SECRETS)) {
        // A description names production resources; the sandbox profile maps them like every other name.
        const text = description && props.profile === 'sandbox' ? description.replace(/\bwhichpart-api\b(?!-)/g, N('whichpart-api')) : description;
        retain(new sm.CfnSecret(this, logical(name), { name: N(name), ...(text ? { description: text } : {}) }));
      }
    }

    for (const [name, t] of Object.entries(TABLES)) {
      if (!has(t.step)) continue;
      retain(new ddb.CfnTable(this, logical(name), {
        tableName: N(name),
        billingMode: 'PAY_PER_REQUEST',
        keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
        attributeDefinitions: [
          { attributeName: 'gsiPk', attributeType: 'S' },
          { attributeName: t.sortKey, attributeType: 'S' },
          { attributeName: 'pk', attributeType: 'S' },
        ],
        globalSecondaryIndexes: [{
          indexName: 'gsi_activity',
          keySchema: [{ attributeName: 'gsiPk', keyType: 'HASH' }, { attributeName: t.sortKey, keyType: 'RANGE' }],
          projection: { projectionType: 'ALL' },
        }],
        ...(t.ttl ? { timeToLiveSpecification: t.ttl } : {}),
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtectionEnabled: false,
      }));
    }

    if (has('5.4')) {
      for (const name of BUCKETS) {
        retain(new s3.CfnBucket(this, logical(name), {
          bucketName: N(name),
          ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
          publicAccessBlockConfiguration: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
          bucketEncryption: { serverSideEncryptionConfiguration: [{ serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' }, bucketKeyEnabled: false }] },
        }));
      }
      // The web bucket's only statement, exactly as live. The learning bucket has no policy.
      retain(new s3.CfnBucketPolicy(this, 'WebBucketPolicy', {
        bucket: N(BUCKETS[0]),
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Sid: 'AllowCloudFrontOAC',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${N(BUCKETS[0])}/*`,
            Condition: { StringEquals: { 'AWS:SourceArn': `arn:aws:cloudfront::${A}:distribution/${N('E1QD02IAJZPJLM')}` } },
          }],
        },
      }));
    }
    this.templateOptions.description = `${id}: Appliance Clinic data resources, imported (Phase 5). Retain on every resource.`;
  }
}

module.exports = { DataStack, REPOSITORIES, SECRETS, TABLES, BUCKETS, LAMBDA_ECR_POLICY };
