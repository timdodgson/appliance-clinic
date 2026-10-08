#!/usr/bin/env node
'use strict';
/**
 * Appliance Clinic production CDK app (Phase 5). Synthesis is offline (no lookups). The context value `step` selects
 * the import group: the template holds that step's resources and every earlier step's. Templates are applied only by
 * infra/production/steps/*.sh as checked import change sets; `cdk deploy` is never run against production.
 */
const cdk = require('aws-cdk-lib');
const { A, R, STEPS } = require('../lib/common');
const { DataStack } = require('../lib/data-stack');

const app = new cdk.App({ analyticsReporting: false });
const step = app.node.tryGetContext('step') || 'shell';
const env = { account: A, region: R };
// profile=sandbox synthesizes the same stacks with sandbox names for the import-semantics probe; it has no toolkit, so
// no bootstrap parameter. Production always uses the acclinic toolkit.
const profile = app.node.tryGetContext('profile') || 'production';
const suffix = profile === 'sandbox' ? '-sbx' : '';
const synthesizer = () => (profile === 'sandbox' ? new cdk.BootstraplessSynthesizer() : new cdk.DefaultStackSynthesizer({ qualifier: 'acclinic' }));
const declare = JSON.parse(app.node.tryGetContext('declare') || '{}');

if (!STEPS.includes(step)) throw new Error(`unknown step ${step}`);
// The data stack's last step is 5.4: later steps synthesize it unchanged.
const dataStep = STEPS.indexOf(step) > STEPS.indexOf('5.4') ? '5.4' : step;
new DataStack(app, `AcDataStack${suffix}`, { env, synthesizer: synthesizer(), terminationProtection: true, step: dataStep, profile, declare });

// Phase 7 (ADR 0006): AC's own Cognito pool. Created new, never imported; production only.
if (profile === 'production') {
  const { AuthStack } = require('../lib/auth-stack');
  new AuthStack(app, 'AcAuthStack', { env, synthesizer: synthesizer(), terminationProtection: true });
}

// The runtime stack needs the captured live configuration (infra/production/capture-runtime.sh): context `live` is
// its path, and `code` the path of {function: {s3Bucket, s3Key}} for the zip functions' deployed artefacts.
const live = app.node.tryGetContext('live');
if (live) {
  const fs = require('node:fs');
  const { RuntimeStack } = require('../lib/runtime-stack');
  const code = app.node.tryGetContext('code');
  const runtimeStep = STEPS.indexOf(step) < STEPS.indexOf('5.5') ? 'shell' : step;
  new RuntimeStack(app, `AcRuntimeStack${suffix}`, {
    env, synthesizer: synthesizer(), terminationProtection: true, step: runtimeStep, profile, live,
    codeLocations: code ? JSON.parse(fs.readFileSync(code, 'utf8')) : {},
    // Phase 7 onwards: reviewed changes to the runtime (production only).
    overrides: profile === 'production' ? JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'config', 'runtime-overrides.json'), 'utf8')) : {},
  });
}
