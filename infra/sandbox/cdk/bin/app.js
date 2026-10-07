#!/usr/bin/env node
'use strict';
/**
 * Phase 4 sandbox CDK app (#34). Synthesizes AcDataStack-sbx and AcRuntimeStack-sbx for the acsbx toolkit.
 * Synthesis is offline (no lookups). Templates are deployed and imported by infra/sandbox/steps/*.sh through
 * checked change sets, never with `cdk deploy` against anything but these -sbx stacks.
 */
const cdk = require('aws-cdk-lib');
const { A, R } = require('../lib/common');
const { DataStack } = require('../lib/data-stack');

const app = new cdk.App({ analyticsReporting: false });
const synthesizer = () => new cdk.DefaultStackSynthesizer({ qualifier: 'acsbx' });
const env = { account: A, region: R };

new DataStack(app, 'AcDataStack-sbx', { env, synthesizer: synthesizer(), terminationProtection: true });

const runtime = app.node.tryGetContext('runtime');
if (runtime) {
  const { RuntimeStack } = require('../lib/runtime-stack');
  new RuntimeStack(app, 'AcRuntimeStack-sbx', { env, synthesizer: synthesizer(), terminationProtection: true, stage: runtime });
}
