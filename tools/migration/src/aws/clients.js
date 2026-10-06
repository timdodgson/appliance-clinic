import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECRClient } from '@aws-sdk/client-ecr';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { IAMClient } from '@aws-sdk/client-iam';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { STSClient } from '@aws-sdk/client-sts';
import { guardReadOnly } from './readonly-client.js';

/**
 * Build guarded, read-only clients. Credentials come from the standard AWS chain
 * (AWS_PROFILE etc.); nothing here stores or logs them.
 */
export function createReadOnlyClients({ region, edgeRegion, stackRegions, allowSecretValues = false }) {
  const ro = (client, opts) => guardReadOnly(client, opts);
  const cloudformation = {};
  for (const r of stackRegions) cloudformation[r] = ro(new CloudFormationClient({ region: r }));
  return {
    region,
    sts: ro(new STSClient({ region })),
    lambda: ro(new LambdaClient({ region })),
    iam: ro(new IAMClient({ region })),
    dynamodb: ro(new DynamoDBClient({ region })),
    s3: ro(new S3Client({ region })),
    secrets: ro(new SecretsManagerClient({ region }), { allowSecretValues }),
    ecr: ro(new ECRClient({ region })),
    events: ro(new EventBridgeClient({ region })),
    cloudtrail: ro(new CloudTrailClient({ region })),
    cloudfront: ro(new CloudFrontClient({ region: edgeRegion })),
    cloudformation,
  };
}
