/**
 * Approval point A (#34): the IAM controls, budget and CDK toolkit for the Phase 4 sandbox.
 *
 * Everything here is pure and makes no AWS calls. The documents are rendered into
 * docs/migration/sandbox/approval-a/ and checked by tests against the sandbox allowlist and both
 * denylists, so what is approved is exactly what is committed.
 *
 * Model:
 *   - ac-operator-policy-sbx   allows only sandbox ARN patterns (and a few account-level reads)
 *   - ac-cfn-execution-sbx     the same scope for the acsbx CloudFormation execution role; it is also the
 *                              permissions boundary every sandbox-created role must carry
 *   - ac-deny-production-sbx   explicit Deny on production AC and S4R resources, on services the
 *                              sandbox never uses, outside eu-west-1, and on the controls themselves.
 *                              Attached to the operator, the execution role and every toolkit role.
 */
import { SANDBOX_ACCOUNT as A, SANDBOX_REGION as R } from './guard.js';

export const TAG = { Key: 'ac:sandbox', Value: 'phase-4' };
export const OPERATOR_ROLE = 'ac-operator-sbx';
export const QUALIFIER = 'acsbx';
export const TOOLKIT_STACK = 'ApplianceClinicSandboxToolkit';
export const BUDGET_NAME = 'ac-budget-sbx';
export const policyArn = (name) => `arn:aws:iam::${A}:policy/${name}`;
export const POLICY = {
  operator: 'ac-operator-policy-sbx',
  execution: 'ac-cfn-execution-sbx',
  deny: 'ac-deny-production-sbx',
};
const BOUNDARY_ARN = policyArn(POLICY.execution);
const DENY_ARN = policyArn(POLICY.deny);
const BASIC_EXECUTION = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

// Sandbox resource patterns. Each contains a sandbox marker (-sbx, acsbx, applianceclinic-sbx/), so no
// production AC or S4R name can match; tests check this against both denylists.
const S = {
  functions: [`arn:aws:lambda:${R}:${A}:function:*-sbx`, `arn:aws:lambda:${R}:${A}:function:*-sbx:*`],
  logs: [`arn:aws:logs:${R}:${A}:log-group:/aws/lambda/*-sbx`, `arn:aws:logs:${R}:${A}:log-group:/aws/lambda/*-sbx:*`],
  tables: [`arn:aws:dynamodb:${R}:${A}:table/whichpart-*-sbx*`],
  buckets: [`arn:aws:s3:::*-sbx-${A}`, `arn:aws:s3:::*-sbx-${A}/*`, `arn:aws:s3:::cdk-${QUALIFIER}-assets-${A}-${R}`, `arn:aws:s3:::cdk-${QUALIFIER}-assets-${A}-${R}/*`],
  repositories: [`arn:aws:ecr:${R}:${A}:repository/*-sbx`, `arn:aws:ecr:${R}:${A}:repository/cdk-${QUALIFIER}-*`],
  secrets: [`arn:aws:secretsmanager:${R}:${A}:secret:applianceclinic-sbx/*`],
  rules: [`arn:aws:events:${R}:${A}:rule/*-sbx`],
  parameters: [`arn:aws:ssm:${R}:${A}:parameter/cdk-bootstrap/${QUALIFIER}/*`],
  stacks: [`arn:aws:cloudformation:${R}:${A}:stack/*-sbx/*`, `arn:aws:cloudformation:${R}:${A}:stack/${TOOLKIT_STACK}/*`],
  roles: [`arn:aws:iam::${A}:role/*-sbx`, `arn:aws:iam::${A}:role/SparesSite-sbx-*`],
  toolkitRoles: [`arn:aws:iam::${A}:role/cdk-${QUALIFIER}-*`],
  apis: `arn:aws:apigateway:${R}::/apis`,
  budget: `arn:aws:budgets::${A}:budget/${BUDGET_NAME}`,
};

const tagged = { StringEquals: { [`aws:ResourceTag/${TAG.Key}`]: TAG.Value } };
const requestTagged = { StringEquals: { [`aws:RequestTag/${TAG.Key}`]: TAG.Value } };

/** Reads that IAM authorises only on "*". None of them changes anything. */
const ACCOUNT_READS = [
  'sts:GetCallerIdentity', 'ecr:GetAuthorizationToken', 'cloudformation:ValidateTemplate', 'cloudformation:ListStacks',
  'cloudformation:DescribeStacks', 'cloudformation:GetTemplateSummary', 'lambda:ListFunctions', 'lambda:GetAccountSettings',
  'dynamodb:ListTables', 'dynamodb:ListBackups', 's3:ListAllMyBuckets', 'logs:DescribeLogGroups', 'secretsmanager:ListSecrets',
  'events:ListRules', 'ssm:DescribeParameters', 'iam:ListRoles', 'iam:ListPolicies', 'cognito-idp:ListUserPools', 'tag:GetResources',
];

/** Statements shared by the operator and the execution role: sandbox resources only. */
function sandboxResourceStatements() {
  return [
    { Sid: 'AccountReads', Effect: 'Allow', Action: ACCOUNT_READS, Resource: '*' },
    { Sid: 'SandboxLambda', Effect: 'Allow', Action: 'lambda:*', Resource: S.functions },
    { Sid: 'SandboxLogs', Effect: 'Allow', Action: 'logs:*', Resource: S.logs },
    { Sid: 'SandboxData', Effect: 'Allow', Action: ['dynamodb:*', 's3:*', 'ecr:*', 'secretsmanager:*', 'events:*', 'ssm:*'], Resource: [...S.tables, ...S.buckets, ...S.repositories, ...S.secrets, ...S.rules, ...S.parameters] },
    { Sid: 'SandboxStacks', Effect: 'Allow', Action: 'cloudformation:*', Resource: S.stacks },
    {
      Sid: 'SandboxRolesWithBoundary', Effect: 'Allow',
      Action: ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:PutRolePermissionsBoundary'],
      Resource: S.roles, Condition: { StringEquals: { 'iam:PermissionsBoundary': BOUNDARY_ARN } },
    },
    {
      // The only managed policy a sandbox role may carry is AWSLambdaBasicExecutionRole (as production does; T7).
      Sid: 'SandboxRolesAttachBasicOnly', Effect: 'Allow', Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], Resource: S.roles,
      Condition: { StringEquals: { 'iam:PermissionsBoundary': BOUNDARY_ARN, 'iam:PolicyARN': BASIC_EXECUTION } },
    },
    {
      Sid: 'SandboxRolesOther', Effect: 'Allow',
      Action: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:ListRoleTags', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateRole', 'iam:UpdateRoleDescription', 'iam:UpdateAssumeRolePolicy', 'iam:DeleteRole'],
      Resource: S.roles,
    },
    {
      Sid: 'PassSandboxRoles', Effect: 'Allow', Action: 'iam:PassRole', Resource: [...S.roles, `arn:aws:iam::${A}:role/cdk-${QUALIFIER}-cfn-exec-role-${A}-${R}`],
      Condition: { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'cloudformation.amazonaws.com'] } },
    },
    { Sid: 'StandInApiCreate', Effect: 'Allow', Action: 'apigateway:POST', Resource: S.apis, Condition: requestTagged },
    { Sid: 'StandInApiList', Effect: 'Allow', Action: 'apigateway:GET', Resource: S.apis },
    { Sid: 'StandInApi', Effect: 'Allow', Action: 'apigateway:*', Resource: `${S.apis}/*`, Condition: tagged },
    { Sid: 'StandInPoolCreate', Effect: 'Allow', Action: ['cognito-idp:CreateUserPool', 'cognito-idp:TagResource'], Resource: '*', Condition: requestTagged },
    { Sid: 'StandInPool', Effect: 'Allow', Action: 'cognito-idp:*', Resource: `arn:aws:cognito-idp:${R}:${A}:userpool/*`, Condition: tagged },
  ];
}

const doc = (Statement) => ({ Version: '2012-10-17', Statement });

/** ac-operator-policy-sbx: the operator's only allow policy. */
export function operatorPolicy() {
  return doc([
    ...sandboxResourceStatements(),
    {
      // The toolkit roles carry no boundary (the bootstrap template is fixed and reviewed), so they may be
      // written only through CloudFormation, i.e. by the ApplianceClinicSandboxToolkit stack.
      Sid: 'ToolkitRolesViaCloudFormation', Effect: 'Allow',
      Action: ['iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole', 'iam:TagRole', 'iam:UntagRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:GetRolePolicy', 'iam:UpdateAssumeRolePolicy'],
      Resource: S.toolkitRoles, Condition: { 'ForAnyValue:StringEquals': { 'aws:CalledVia': ['cloudformation.amazonaws.com'] } },
    },
    {
      // Only the managed policies the reviewed bootstrap template attaches.
      Sid: 'ToolkitRolesAttachReviewedOnly', Effect: 'Allow', Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], Resource: S.toolkitRoles,
      Condition: {
        'ForAnyValue:StringEquals': { 'aws:CalledVia': ['cloudformation.amazonaws.com'] },
        StringEquals: { 'iam:PolicyARN': ['arn:aws:iam::aws:policy/ReadOnlyAccess', 'arn:aws:iam::aws:policy/AWSCloudFormationReadOnlyAccess', BOUNDARY_ARN, DENY_ARN] },
      },
    },
    { Sid: 'AssumeToolkitRoles', Effect: 'Allow', Action: 'sts:AssumeRole', Resource: S.toolkitRoles },
    { Sid: 'ViewBudget', Effect: 'Allow', Action: 'budgets:ViewBudget', Resource: S.budget },
  ]);
}

/** ac-cfn-execution-sbx: the acsbx execution role's allow policy, and the boundary of every sandbox role. */
export function executionPolicy() {
  return doc(sandboxResourceStatements());
}

/** Production and S4R ARNs denied outright. Patterns never end in a bare wildcard after a production name. */
export function deniedResources() {
  const fn = (n) => [`arn:aws:lambda:*:${A}:function:${n}`, `arn:aws:lambda:*:${A}:function:${n}:*`];
  const lg = (n) => [`arn:aws:logs:*:${A}:log-group:${n}`, `arn:aws:logs:*:${A}:log-group:${n}:*`];
  const table = (n) => [`arn:aws:dynamodb:*:${A}:table/${n}`, `arn:aws:dynamodb:*:${A}:table/${n}/*`];
  const bucket = (n) => [`arn:aws:s3:::${n}`, `arn:aws:s3:::${n}/*`];
  const stack = (n) => `arn:aws:cloudformation:*:${A}:stack/${n}/*`;
  const acFunctions = ['spares4repairs-part-finder', 'whichpart-api', 'spares4repairs-diag-orchestrator', 'spares4repairs-error-code-mcp'];
  return [
    ...[...acFunctions, 'spares4repairs-server-dev'].flatMap(fn),
    `arn:aws:lambda:*:${A}:function:SparesSite-dev-*`,
    ...[...acFunctions, 'spares4repairs-server-dev'].map((n) => `/aws/lambda/${n}`).flatMap(lg),
    `arn:aws:logs:*:${A}:log-group:/spares4repairs/*`,
    ...['whichpart-api-role', 'diag-orchestrator-role', 'error-code-mcp-role'].map((n) => `arn:aws:iam::${A}:role/${n}`),
    ...['SparesSite-dev-*', 'spares4repairs-*', 'cdk-hnb659fds-*', 'cdk-acclinic-*'].map((n) => `arn:aws:iam::${A}:role/${n}`),
    ...['whichpart-recalls', 'whichpart-transcripts'].flatMap(table),
    `arn:aws:dynamodb:*:${A}:table/spares4repairs-*`,
    ...[`whichpart-web-${A}`, `whichpart-learning-${A}`, `applianceclinic-migration-backup-${A}`].flatMap(bucket),
    'arn:aws:s3:::spares4repairs-*', 'arn:aws:s3:::cdk-hnb659fds-*', 'arn:aws:s3:::cdk-acclinic-*',
    `arn:aws:secretsmanager:*:${A}:secret:spares4repairs/*`,
    ...['spares4repairs-diag-orchestrator', 'spares4repairs-error-code-mcp', 'spares4repairs-generator'].map((n) => `arn:aws:ecr:*:${A}:repository/${n}`),
    `arn:aws:ecr:*:${A}:repository/cdk-hnb659fds-*`, `arn:aws:ecr:*:${A}:repository/cdk-acclinic-*`,
    ...['whichpart-recall-ingest-daily', 'whichpart-transcript-review'].map((n) => `arn:aws:events:*:${A}:rule/${n}`),
    ...['CDKToolkit', 'SparesSite-dev', 'ApplianceClinicToolkit', 'AcDataStack', 'AcRuntimeStack', 'AcAuthStack'].map(stack),
    ...['/cdk-bootstrap/hnb659fds/*', '/cdk-bootstrap/acclinic/*', '/spares4repairs/*'].map((p) => `arn:aws:ssm:*:${A}:parameter${p}`),
    `arn:aws:cognito-idp:*:${A}:userpool/eu-west-1_mUWucohuX`,
    'arn:aws:apigateway:*::/apis/65vnizdmk4', 'arn:aws:apigateway:*::/apis/65vnizdmk4/*',
  ];
}

/** ac-deny-production-sbx: explicit denies, attached to the operator, the execution role and every toolkit role. */
export function denyPolicy() {
  return doc([
    { Sid: 'DenyProductionAndS4R', Effect: 'Deny', Action: '*', Resource: deniedResources() },
    // CloudFront, ACM, DNS, networking, databases and messaging hold production AC or S4R resources, and the
    // sandbox uses none of them. KMS use is not denied: Lambda and S3 encrypt with AWS-managed keys on the
    // caller's behalf, and an explicit deny would break them. Only key administration is denied.
    { Sid: 'DenyUnusedServices', Effect: 'Deny', Action: ['cloudfront:*', 'acm:*', 'route53:*', 'route53domains:*', 'ec2:*', 'rds:*', 'ecs:*', 'ses:*', 'sns:*', 'organizations:*', 'account:*'], Resource: '*' },
    { Sid: 'DenyKeyAdministration', Effect: 'Deny', Action: ['kms:CreateKey', 'kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy', 'kms:CreateAlias', 'kms:UpdateAlias', 'kms:DeleteAlias', 'kms:RetireGrant', 'kms:RevokeGrant'], Resource: '*' },
    { Sid: 'DenyOtherRegions', Effect: 'Deny', NotAction: ['iam:*', 'sts:*', 'budgets:*', 'ce:*', 'tag:*'], Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': R } } },
    {
      // The controls cannot be changed or removed by anything they control.
      Sid: 'ProtectControls', Effect: 'Deny', NotAction: ['iam:Get*', 'iam:List*', 'budgets:ViewBudget'],
      Resource: [`arn:aws:iam::${A}:role/${OPERATOR_ROLE}`, ...Object.values(POLICY).map(policyArn), S.budget],
    },
    { Sid: 'DenyManagedPolicyWrites', Effect: 'Deny', Action: ['iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'], Resource: '*' },
    { Sid: 'KeepBoundaries', Effect: 'Deny', Action: 'iam:DeleteRolePermissionsBoundary', Resource: '*' },
    { Sid: 'NoUsersOrKeys', Effect: 'Deny', Action: ['iam:CreateUser', 'iam:CreateAccessKey', 'iam:CreateLoginProfile', 'iam:AttachUserPolicy', 'iam:PutUserPolicy', 'iam:AddUserToGroup'], Resource: '*' },
  ]);
}

/**
 * Trust policy of ac-operator-sbx: only the IAM user that runs approval point A may assume it. The user's
 * unique ID (AIDA…) is substituted at execution from sts:GetCallerIdentity; it is not committed.
 */
export function operatorTrustPolicy(operatorUserId = '${OPERATOR_USER_ID}') {
  return doc([{
    Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${A}:root` }, Action: 'sts:AssumeRole',
    Condition: { StringEquals: { 'aws:userid': operatorUserId } },
  }]);
}

/**
 * ac-budget-sbx. A budget can only be scoped to the sandbox by a cost allocation tag, and activating one is an
 * account-level billing change outside Phase 4. So this is an account-wide DAILY cost budget: production runs
 * at about $7.60 a day (October 2026), and a day above $15 means something new is spending.
 */
export function budget() {
  return {
    BudgetName: BUDGET_NAME, BudgetType: 'COST', TimeUnit: 'DAILY', BudgetLimit: { Amount: '15', Unit: 'USD' },
    CostTypes: { IncludeTax: true, IncludeSubscription: true, UseBlended: false, IncludeRefund: false, IncludeCredit: false, IncludeUpfront: true, IncludeRecurring: true, IncludeOtherSubscription: true, IncludeSupport: true, IncludeDiscount: true, UseAmortized: false },
  };
}

/** Notifications for the budget. The address is supplied at execution and never committed. */
export function budgetNotifications(email = '${OWNER_EMAIL}') {
  const sub = [{ SubscriptionType: 'EMAIL', Address: email }];
  return [
    { Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80, ThresholdType: 'PERCENTAGE' }, Subscribers: sub },
    { Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' }, Subscribers: sub },
  ];
}

/**
 * The acsbx bootstrap template: the stock CDK v2 template with the changes below and nothing else.
 *   1. Parameter defaults fixed for the sandbox: qualifier acsbx, the two sandbox execution policies, the
 *      AWS-managed S3 key (no customer KMS key is created), no trusted accounts, no example boundary.
 *   2. The deploy role's CloudFormation permissions are limited to sandbox stacks; its cross-account
 *      pipeline statements and stack-refactor permissions are removed.
 *   3. ac-deny-production-sbx is attached to the deploy, file-publishing, image-publishing and lookup roles
 *      (the execution role gets it through CloudFormationExecutionPolicies).
 *   4. DeletionPolicy and UpdateReplacePolicy Retain on every resource, as the change-set checker requires.
 */
export function patchBootstrapTemplate(stock) {
  const t = JSON.parse(JSON.stringify(stock));
  const p = t.Parameters;
  p.Qualifier.Default = QUALIFIER;
  p.Qualifier.AllowedValues = [QUALIFIER];
  p.CloudFormationExecutionPolicies.Default = [BOUNDARY_ARN, DENY_ARN].join(',');
  p.FileAssetsBucketKmsKeyId.Default = 'AWS_MANAGED_KEY';
  p.FileAssetsBucketKmsKeyId.AllowedValues = ['AWS_MANAGED_KEY'];
  p.TrustedAccounts.Default = '';
  p.TrustedAccountsForLookup.Default = '';
  p.UseExamplePermissionsBoundary.Default = 'false';
  p.UseExamplePermissionsBoundary.AllowedValues = ['false'];

  const deploy = t.Resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument;
  const sandboxStacks = [
    { 'Fn::Sub': 'arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/*-sbx/*' },
    { 'Fn::Sub': `arn:\${AWS::Partition}:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/${TOOLKIT_STACK}/*` },
  ];
  const out = [];
  for (const s of deploy.Statement) {
    if (['PipelineCrossAccountArtifactsBucket', 'PipelineCrossAccountArtifactsKey', 'Refactor'].includes(s.Sid)) continue;
    if (s.Sid === 'DeployPermissions') { out.push({ ...s, Resource: sandboxStacks }); continue; }
    if (s.Sid === 'CliPermissions') {
      out.push({ ...s, Action: s.Action.filter((a) => a !== 'sts:GetCallerIdentity'), Resource: sandboxStacks });
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
  // The change-set checker requires Retain on every resource. Cleanup then deletes each one explicitly by
  // its allowlisted name. The KMS key and example boundary resources are never created (their conditions are
  // fixed false by AllowedValues above) but carry the policy too, so the template passes as a whole.
  for (const r of Object.values(t.Resources)) { r.DeletionPolicy = 'Retain'; r.UpdateReplacePolicy = 'Retain'; }
  t.Description = `${t.Description || 'CDK bootstrap'} (Appliance Clinic Phase 4 sandbox, qualifier ${QUALIFIER}; see docs/migration/sandbox/approval-a)`;
  return t;
}

/** IAM wildcard match: `*` matches any run of characters (including `/`), `?` matches one. */
export function iamGlobMatch(pattern, value) {
  const re = new RegExp(`^${pattern.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
  return re.test(value);
}

/** Policy size as IAM counts it for managed policies: characters excluding whitespace. */
export const policySize = (policy) => JSON.stringify(policy).replace(/\s/g, '').length;
export const MANAGED_POLICY_MAX = 6144;
