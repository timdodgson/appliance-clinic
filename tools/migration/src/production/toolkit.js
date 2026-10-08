/**
 * Phase 5 entry: the dedicated production CDK toolkit (ADR 0005) and its two managed policies.
 *
 * Pure: no AWS calls. Rendered into docs/migration/phase-5/toolkit/ by bin/production-toolkit.mjs and tested
 * against both denylists, so what is created is exactly what is committed.
 *
 *   ac-cfn-execution   the acclinic CloudFormation execution role's only allow: READ-ONLY, on the AC production
 *                      resources Phase 5 imports. An import and drift detection only read, so no CloudFormation
 *                      operation in Phase 5 can change a production resource; anything that tried would fail and
 *                      roll back. Write access is a separate, reviewed change before Phase 6.
 *   ac-deny-s4r        explicit Deny on every S4R identifier (exact names, never a prefix that could reach an AC
 *                      resource: AC secrets and functions also start with "spares4repairs"), the S4R and default
 *                      CDK stacks, and services AC never uses. Attached to the execution role and every toolkit role.
 *
 * The bootstrap template is the reviewed Phase 4 pattern (stock CDK v32, patched), not `cdk bootstrap`: the stock
 * deploy role may change any stack in the account.
 */
const A = '800960611664';
const R = 'eu-west-1';

export const QUALIFIER = 'acclinic';
export const TOOLKIT_STACK = 'ApplianceClinicToolkit';
export const AC_STACKS = ['AcDataStack', 'AcRuntimeStack'];
export const POLICY = { execution: 'ac-cfn-execution', deny: 'ac-deny-s4r' };
export const policyArn = (name) => `arn:aws:iam::${A}:policy/${name}`;

/** The AC production resources of Phase 5 (ownership.md), by type. */
export const AC = {
  functions: ['whichpart-api', 'spares4repairs-diag-orchestrator', 'spares4repairs-error-code-mcp', 'spares4repairs-part-finder'],
  roles: ['whichpart-api-role', 'diag-orchestrator-role', 'error-code-mcp-role'],
  tables: ['whichpart-transcripts', 'whichpart-recalls'],
  buckets: [`whichpart-web-${A}`, `whichpart-learning-${A}`],
  secrets: [
    'spares4repairs/dev/applianceclinic-ai-config', 'spares4repairs/dev/applianceclinic-openai', 'spares4repairs/dev/applianceclinic-jev',
    'spares4repairs/dev/applianceclinic-canonical-state-token', 'spares4repairs/dev/applianceclinic-benchmark-service',
    'spares4repairs/diag-orchestrator/bearer-token', 'spares4repairs/error-code-mcp/bearer-token',
  ],
  repositories: ['spares4repairs-diag-orchestrator', 'spares4repairs-error-code-mcp'],
  rules: ['whichpart-recall-ingest-daily', 'whichpart-transcript-review'],
};

const fnArns = AC.functions.flatMap((n) => [`arn:aws:lambda:${R}:${A}:function:${n}`, `arn:aws:lambda:${R}:${A}:function:${n}:*`]);
const tableArns = AC.tables.flatMap((n) => [`arn:aws:dynamodb:${R}:${A}:table/${n}`, `arn:aws:dynamodb:${R}:${A}:table/${n}/*`]);
// A secret's ARN ends in "-" and six random characters.
const secretArns = AC.secrets.map((n) => `arn:aws:secretsmanager:${R}:${A}:secret:${n}-??????`);

/** Reads with no resource-level authorisation. None changes anything. */
const ACCOUNT_READS = [
  'lambda:ListFunctions', 'lambda:GetAccountSettings', 'dynamodb:ListTables', 's3:ListAllMyBuckets', 'secretsmanager:ListSecrets',
  'ecr:DescribeRegistry', 'events:ListRules', 'iam:ListRoles', 'tag:GetResources',
];

const doc = (Statement) => ({ Version: '2012-10-17', Statement });

/**
 * ac-cfn-execution: read-only on the AC production resources, plus `stepWrites` (stepWriteStatements in
 * import-writes.js): the writes CloudFormation makes after importing the current step's resources, on exactly those
 * resources. Between steps the default version is the read-only one.
 */
export function executionPolicy(stepWrites = []) {
  return doc([
    { Sid: 'AccountReads', Effect: 'Allow', Action: ACCOUNT_READS, Resource: '*' },
    { Sid: 'ReadAcFunctions', Effect: 'Allow', Action: ['lambda:Get*', 'lambda:List*'], Resource: fnArns },
    { Sid: 'ReadAcRoles', Effect: 'Allow', Action: ['iam:Get*', 'iam:List*'], Resource: AC.roles.map((n) => `arn:aws:iam::${A}:role/${n}`) },
    { Sid: 'ReadAcTables', Effect: 'Allow', Action: ['dynamodb:Describe*', 'dynamodb:List*', 'dynamodb:GetResourcePolicy'], Resource: tableArns },
    // Bucket ARNs only: object reads (customer data) are not granted.
    { Sid: 'ReadAcBuckets', Effect: 'Allow', Action: ['s3:GetBucket*', 's3:GetEncryptionConfiguration', 's3:GetLifecycleConfiguration', 's3:GetReplicationConfiguration', 's3:GetAccelerateConfiguration', 's3:GetAnalyticsConfiguration', 's3:GetIntelligentTieringConfiguration', 's3:GetInventoryConfiguration', 's3:GetMetricsConfiguration'], Resource: AC.buckets.map((n) => `arn:aws:s3:::${n}`) },
    // Never GetSecretValue: imports read secret metadata only.
    { Sid: 'ReadAcSecretMetadata', Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetResourcePolicy', 'secretsmanager:ListSecretVersionIds'], Resource: secretArns },
    { Sid: 'ReadAcRepositories', Effect: 'Allow', Action: ['ecr:DescribeRepositories', 'ecr:DescribeImages', 'ecr:GetLifecyclePolicy', 'ecr:GetRepositoryPolicy', 'ecr:ListTagsForResource', 'ecr:DescribeImageScanFindings', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'], Resource: AC.repositories.map((n) => `arn:aws:ecr:${R}:${A}:repository/${n}`) },
    // Every CDK template's BootstrapVersion parameter resolves this toolkit parameter (Phase 5 finding).
    { Sid: 'ReadToolkitVersion', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'], Resource: `arn:aws:ssm:${R}:${A}:parameter/cdk-bootstrap/${QUALIFIER}/version` },
    { Sid: 'ReadAcRules', Effect: 'Allow', Action: ['events:DescribeRule', 'events:ListTargetsByRule', 'events:ListTagsForResource'], Resource: AC.rules.map((n) => `arn:aws:events:${R}:${A}:rule/${n}`) },
    ...stepWrites,
  ]);
}

/** S4R identifiers as IAM resource patterns. Each names S4R exactly, or by a prefix no AC resource has. */
export function s4rResources() {
  const s4rSecrets = ['business-config-PEw4gn', 'db-F6asfI', 'getaddress-4DiT2D', 'google-maps-SRTR0N', 'paypal-TjoQuN', 'royal-mail-muRtw1', 'stripe-LvGdUb', 'twilio-OGgUXL']
    .map((s) => `arn:aws:secretsmanager:*:${A}:secret:spares4repairs/dev/${s}`);
  return [
    `arn:aws:cloudformation:*:${A}:stack/SparesSite-*/*`, `arn:aws:cloudformation:*:${A}:stack/CDKToolkit/*`,
    `arn:aws:lambda:*:${A}:function:spares4repairs-server-dev`, `arn:aws:lambda:*:${A}:function:spares4repairs-server-dev:*`,
    `arn:aws:lambda:*:${A}:function:SparesSite-*`,
    `arn:aws:logs:*:${A}:log-group:/aws/lambda/spares4repairs-server-dev*`, `arn:aws:logs:*:${A}:log-group:/aws/lambda/SparesSite-*`,
    `arn:aws:iam::${A}:role/SparesSite-*`, `arn:aws:iam::${A}:role/cdk-hnb659fds-*`,
    'arn:aws:s3:::spares4repairs-*-dev', 'arn:aws:s3:::spares4repairs-*-dev/*', 'arn:aws:s3:::cdk-hnb659fds-*',
    `arn:aws:ecr:*:${A}:repository/cdk-hnb659fds-*`,
    ...s4rSecrets,
    `arn:aws:ssm:*:${A}:parameter/spares4repairs/*`, `arn:aws:ssm:*:${A}:parameter/cdk-bootstrap/hnb659fds/*`,
    `arn:aws:cognito-idp:*:${A}:userpool/eu-west-1_mUWucohuX`,
    'arn:aws:apigateway:*::/apis/65vnizdmk4', 'arn:aws:apigateway:*::/apis/65vnizdmk4/*', 'arn:aws:apigateway:*::/tags/*65vnizdmk4*',
  ];
}

/** ac-deny-s4r: explicit denies, attached to the execution role and every toolkit role. */
export function denyPolicy() {
  return doc([
    { Sid: 'DenyS4R', Effect: 'Deny', Action: '*', Resource: s4rResources() },
    // CloudFront, ACM, DNS and networking hold S4R resources (and AC's unmanaged distribution, ADR 0008); AC CDK uses none.
    { Sid: 'DenyUnusedServices', Effect: 'Deny', Action: ['cloudfront:*', 'acm:*', 'route53:*', 'route53domains:*', 'ec2:*', 'rds:*', 'ecs:*', 'ses:*', 'sns:*', 'organizations:*', 'account:*'], Resource: '*' },
    { Sid: 'DenyOtherRegions', Effect: 'Deny', NotAction: ['iam:*', 'sts:*', 'tag:*'], Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': R } } },
    { Sid: 'DenyUsersAndKeys', Effect: 'Deny', Action: ['iam:CreateUser', 'iam:CreateAccessKey', 'iam:CreateLoginProfile', 'iam:AttachUserPolicy', 'iam:PutUserPolicy', 'iam:AddUserToGroup', 'iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion'], Resource: '*' },
  ]);
}

/** The stock CDK v32 bootstrap template, patched exactly as the Phase 4 sandbox toolkit was (approval-a.js). */
export function patchBootstrapTemplate(stock) {
  const t = JSON.parse(JSON.stringify(stock));
  const p = t.Parameters;
  p.Qualifier.Default = QUALIFIER;
  p.Qualifier.AllowedValues = [QUALIFIER];
  p.CloudFormationExecutionPolicies.Default = [policyArn(POLICY.execution), policyArn(POLICY.deny)].join(',');
  p.FileAssetsBucketKmsKeyId.Default = 'AWS_MANAGED_KEY';
  p.FileAssetsBucketKmsKeyId.AllowedValues = ['AWS_MANAGED_KEY'];
  p.TrustedAccounts.Default = '';
  p.TrustedAccountsForLookup.Default = '';
  p.UseExamplePermissionsBoundary.Default = 'false';
  p.UseExamplePermissionsBoundary.AllowedValues = ['false'];

  const deploy = t.Resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument;
  const acStacks = [...AC_STACKS, TOOLKIT_STACK].map((s) => ({ 'Fn::Sub': `arn:\${AWS::Partition}:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/${s}/*` }));
  const out = [];
  for (const s of deploy.Statement) {
    if (['PipelineCrossAccountArtifactsBucket', 'PipelineCrossAccountArtifactsKey', 'Refactor'].includes(s.Sid)) continue;
    if (s.Sid === 'DeployPermissions') { out.push({ ...s, Resource: acStacks }); continue; }
    if (s.Sid === 'CliPermissions') {
      out.push({ ...s, Action: s.Action.filter((a) => a !== 'sts:GetCallerIdentity'), Resource: acStacks });
      out.push({ Sid: 'CliIdentity', Effect: 'Allow', Action: 'sts:GetCallerIdentity', Resource: '*' });
      continue;
    }
    out.push(s);
  }
  deploy.Statement = out;
  for (const name of ['DeploymentActionRole', 'FilePublishingRole', 'ImagePublishingRole', 'LookupRole']) {
    const props = t.Resources[name].Properties;
    props.ManagedPolicyArns = [...(props.ManagedPolicyArns || []), { 'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:policy/${POLICY.deny}` }];
  }
  for (const r of Object.values(t.Resources)) { r.DeletionPolicy = 'Retain'; r.UpdateReplacePolicy = 'Retain'; }
  t.Description = `${t.Description || 'CDK bootstrap'} (Appliance Clinic production, qualifier ${QUALIFIER}; see docs/migration/phase-5/toolkit)`;
  return t;
}
