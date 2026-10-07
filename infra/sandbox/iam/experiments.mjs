#!/usr/bin/env node
/**
 * Phase 4 (#34) IAM experiments T2 to T7: the AcIamExperiments-sbx templates, one per stage.
 * Pure: writes infra/sandbox/iam/stage-*.json and import-3.json. No AWS calls.
 *
 *   stage-1  CREATE: iam-t2-role-sbx declaring Policies [iam-t2-policy-sbx]
 *   stage-2  UPDATE: iam-t2-policy-sbx's document changes (T2: what happens to an undeclared inline policy?)
 *   stage-3  IMPORT: iam-t3..t7 roles (created outside CloudFormation), iam-t4/t5 inline policies as RolePolicy
 *   stage-4  UPDATE: T3 role description changes; T5 RolePolicy removed (Retain); T6 role removed (Retain);
 *                    T7 ManagedPolicyArns removed
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const A = '800960611664';
const BOUNDARY = `arn:aws:iam::${A}:policy/ac-cfn-execution-sbx`;
const BASIC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const TAGS = [{ Key: 'ac:sandbox', Value: 'phase-4' }];
const TRUST = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
const retain = (r) => ({ ...r, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });

/** A harmless sandbox-only document, distinct per policy and version. */
export const doc = (name, version = 1) => ({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::whichpart-learning-sbx-${A}/iam-experiments/${name}/v${version}/*` }],
});

/** Properties of a role exactly as created outside CloudFormation by 30-iam-t2-t7.sh (so import is exact). */
export const roleProps = (n, { description = `Phase 4 IAM experiment T${n}`, managed = false } = {}) => ({
  RoleName: `iam-t${n}-role-sbx`,
  Description: description,
  AssumeRolePolicyDocument: TRUST,
  PermissionsBoundary: BOUNDARY,
  Tags: TAGS,
  ...(managed ? { ManagedPolicyArns: [BASIC] } : {}),
});

const rolePolicy = (n) => retain({ Type: 'AWS::IAM::RolePolicy', Properties: { RoleName: `iam-t${n}-role-sbx`, PolicyName: `iam-t${n}-policy-sbx`, PolicyDocument: doc(`t${n}`) } });
const t2 = (version) => retain({
  Type: 'AWS::IAM::Role',
  Properties: { ...roleProps(2), Policies: [{ PolicyName: 'iam-t2-policy-sbx', PolicyDocument: doc('t2', version) }] },
});

const template = (resources) => ({
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'AcIamExperiments-sbx: Phase 4 IAM experiments T2 to T7 (#34). Sandbox only.',
  Resources: resources,
});

export function stages() {
  const imported = {
    T3Role: retain({ Type: 'AWS::IAM::Role', Properties: roleProps(3, { managed: true }) }),
    T4Role: retain({ Type: 'AWS::IAM::Role', Properties: roleProps(4) }),
    T4Policy: rolePolicy(4),
    T5Role: retain({ Type: 'AWS::IAM::Role', Properties: roleProps(5) }),
    T5Policy: rolePolicy(5),
    T6Role: retain({ Type: 'AWS::IAM::Role', Properties: roleProps(6) }),
    T7Role: retain({ Type: 'AWS::IAM::Role', Properties: roleProps(7, { managed: true }) }),
  };
  const stage4 = { T2Role: t2(2), ...imported };
  stage4.T3Role = retain({ Type: 'AWS::IAM::Role', Properties: roleProps(3, { managed: true, description: 'Phase 4 IAM experiment T3, updated after import' }) });
  delete stage4.T5Policy;
  delete stage4.T6Role;
  stage4.T7Role = retain({ Type: 'AWS::IAM::Role', Properties: roleProps(7) });
  return {
    'stage-1.json': template({ T2Role: t2(1) }),
    'stage-2.json': template({ T2Role: t2(2) }),
    'stage-3.json': template({ T2Role: t2(2), ...imported }),
    'stage-4.json': template(stage4),
    'import-3.json': [
      ['T3Role', 'AWS::IAM::Role', { RoleName: 'iam-t3-role-sbx' }],
      ['T4Role', 'AWS::IAM::Role', { RoleName: 'iam-t4-role-sbx' }],
      ['T4Policy', 'AWS::IAM::RolePolicy', { PolicyName: 'iam-t4-policy-sbx', RoleName: 'iam-t4-role-sbx' }],
      ['T5Role', 'AWS::IAM::Role', { RoleName: 'iam-t5-role-sbx' }],
      ['T5Policy', 'AWS::IAM::RolePolicy', { PolicyName: 'iam-t5-policy-sbx', RoleName: 'iam-t5-role-sbx' }],
      ['T6Role', 'AWS::IAM::Role', { RoleName: 'iam-t6-role-sbx' }],
      ['T7Role', 'AWS::IAM::Role', { RoleName: 'iam-t7-role-sbx' }],
    ].map(([LogicalResourceId, ResourceType, ResourceIdentifier]) => ({ ResourceType, LogicalResourceId, ResourceIdentifier })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, value] of Object.entries(stages())) writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log('Rendered AcIamExperiments-sbx stages');
}
