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
const synthesizer = () => new cdk.DefaultStackSynthesizer({ qualifier: 'acclinic' });

if (!STEPS.includes(step)) throw new Error(`unknown step ${step}`);
// The data stack's last step is 5.4: later steps synthesize it unchanged.
const dataStep = STEPS.indexOf(step) > STEPS.indexOf('5.4') ? '5.4' : step;
new DataStack(app, 'AcDataStack', { env, synthesizer: synthesizer(), terminationProtection: true, step: dataStep });
