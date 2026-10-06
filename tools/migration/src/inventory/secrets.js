import {
  DescribeSecretCommand,
  GetResourcePolicyCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import { redactedValue, redactDeep } from '../redact.js';
import { collectPages } from '../util/aws-errors.js';

/** Every secret whose name starts with one of the prefixes (metadata only). */
export async function listSecretsByPrefix(secrets, prefixes) {
  const all = [];
  for (const prefix of prefixes) {
    const page = await collectPages(
      (NextToken) => secrets.send(new ListSecretsCommand({ Filters: [{ Key: 'name', Values: [prefix] }], NextToken })),
      (p) => p.SecretList,
      (p) => p.NextToken,
    );
    all.push(...page.filter((s) => s.Name.startsWith(prefix)));
  }
  const seen = new Set();
  return all.filter((s) => (seen.has(s.ARN) ? false : seen.add(s.ARN)));
}

/** Shape of a secret value without the value: digest, length, and JSON key names. */
export function describeSecretValue(value) {
  const out = { ...redactedValue(value), json: null };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') out.json = { keys: Object.keys(parsed).sort(), redacted: redactDeep(parsed) };
  } catch { /* not JSON */ }
  return out;
}

export async function inventorySecret(secrets, arn, { hashValue = false } = {}) {
  const d = await secrets.send(new DescribeSecretCommand({ SecretId: arn }));
  const policy = await secrets.send(new GetResourcePolicyCommand({ SecretId: arn }));
  const record = {
    name: d.Name,
    arn: d.ARN,
    description: d.Description || null,
    kmsKeyId: d.KmsKeyId || null,
    rotationEnabled: Boolean(d.RotationEnabled),
    rotationLambdaArn: d.RotationLambdaARN || null,
    rotationRules: d.RotationRules || null,
    createdDate: d.CreatedDate,
    lastChangedDate: d.LastChangedDate,
    owningService: d.OwningService || null,
    primaryRegion: d.PrimaryRegion || null,
    replicationStatus: d.ReplicationStatus || [],
    tags: d.Tags || [],
    versionStages: d.VersionIdsToStages ? Object.values(d.VersionIdsToStages).flat().sort() : [],
    resourcePolicy: policy.ResourcePolicy ? JSON.parse(policy.ResourcePolicy) : null,
    value: null,
  };
  if (hashValue) {
    const v = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
    record.value = v.SecretString !== undefined ? describeSecretValue(v.SecretString) : { binary: true };
  }
  return record;
}
