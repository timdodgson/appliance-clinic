'use strict';
const cdk = require('aws-cdk-lib');

const A = '800960611664';
const R = 'eu-west-1';

/**
 * The Phase 5 import groups, in PLAN.md order. A stack synthesized for step S holds every resource of S and of the
 * steps before it in the same stack, so each import change set adds exactly that step's resources and leaves the
 * imported ones as they are.
 */
const STEPS = ['shell', '5.1', '5.2', '5.3a', '5.3b', '5.4', '5.5', '5.6', '5.7a', '5.7b', '5.7c', '5.8', '5.9', '5.10'];
const upTo = (current) => (step) => {
  const i = STEPS.indexOf(current);
  if (i < 0) throw new Error(`unknown step ${current}`);
  return STEPS.indexOf(step) <= i;
};

/** Every imported resource: Retain on delete and on replacement (PLAN.md, CDK rules for imported resources). */
function retain(resource) {
  resource.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
  resource.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
  return resource;
}

/** An import cannot create a stack with a service role, so each stack starts as a shell holding only this handle. */
function shellHandle(stack) {
  return new cdk.CfnWaitConditionHandle(stack, 'StackShell');
}

const logical = (name) => name.replace(/[^A-Za-z0-9]/g, '');

/**
 * Naming profiles. `production` is the AC production account as it is. `sandbox` maps every production name to its
 * Phase 4 sandbox copy, so the import-semantics probe (infra/sandbox/probe) imports exactly the template shapes that
 * production will use. Logical IDs are always derived from the production name, so both profiles share them.
 */
const SANDBOX_NAMES = require('./sandbox-names.json');

function namer(profile) {
  if (profile === 'production') return (n) => n;
  if (profile !== 'sandbox') throw new Error(`unknown profile ${profile}`);
  return (n) => {
    if (!(n in SANDBOX_NAMES)) throw new Error(`no sandbox name for ${n}`);
    return SANDBOX_NAMES[n];
  };
}

module.exports = { A, R, STEPS, upTo, retain, shellHandle, logical, namer, SANDBOX_NAMES };
