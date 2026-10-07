'use strict';
const cdk = require('aws-cdk-lib');

const A = '800960611664';
const R = 'eu-west-1';
const TAGS = [{ key: 'ac:sandbox', value: 'phase-4' }];
/** A distribution ID that does not exist, for the OAC-shaped web bucket policy. Allowlisted as a placeholder. */
const PLACEHOLDER_DISTRIBUTION = 'ESBXPLACEHOLDER';
const BOUNDARY = `arn:aws:iam::${A}:policy/ac-cfn-execution-sbx`;

/** Every imported resource: Retain on delete and on replacement (PLAN.md, CDK rules for imported resources). */
function retain(resource) {
  resource.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
  resource.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
  return resource;
}

/**
 * An import cannot create a stack with a service role or tags (Phase 4 finding), so every stack is first created
 * as a shell holding only this handle, which creates nothing outside CloudFormation. Resources are then imported.
 */
function shellHandle(stack) {
  return new cdk.CfnWaitConditionHandle(stack, 'StackShell');
}

module.exports = { A, R, TAGS, PLACEHOLDER_DISTRIBUTION, BOUNDARY, retain, shellHandle };
