import { describe, expect, it } from 'vitest';
import { inventoryStacks } from '../src/inventory/cloudformation.js';
import { creationEvents } from '../src/inventory/cloudtrail.js';
import { functionUrlRecord } from '../src/inventory/lambda.js';
import { isSecretName, redactDeep } from '../src/redact.js';
import config from '../config/resources.json' with { type: 'json' };

// A fake SDK client: answers each command by its class name.
const fakeClient = (handlers) => ({
  send: async (command) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw Object.assign(new Error(`unexpected ${command.constructor.name}`), { name: 'Unexpected' });
    return handler(command.input);
  },
});

describe('Function URL configuration is recorded unredacted', () => {
  const url = { $metadata: {}, FunctionUrl: 'https://abc.lambda-url.eu-west-1.on.aws/', AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM', Cors: { AllowOrigins: ['*'] } };

  it('keeps AuthType, InvokeMode and CORS exactly as returned', () => {
    expect(functionUrlRecord(url)).toEqual({ FunctionUrl: url.FunctionUrl, AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM', Cors: { AllowOrigins: ['*'] } });
  });

  it('no longer treats AuthType-style names as secrets, but still catches auth tokens', () => {
    expect(isSecretName('AuthType')).toBe(false);
    expect(redactDeep({ AuthType: 'AWS_IAM' })).toEqual({ AuthType: 'AWS_IAM' });
    expect(isSecretName('AUTH_TOKEN')).toBe(true);
    expect(isSecretName('AUTHORIZATION')).toBe(true);
  });
});

describe('CloudFormation stack status', () => {
  it('captures each stack status from ListStacks', async () => {
    const cfn = fakeClient({
      ListStacksCommand: () => ({ StackSummaries: [{ StackName: 'SparesSite-dev', StackId: 'id-1', StackStatus: 'UPDATE_COMPLETE' }, { StackName: 'CDKToolkit', StackId: 'id-2', StackStatus: 'CREATE_COMPLETE' }] }),
      ListStackResourcesCommand: () => ({ StackResourceSummaries: [] }),
    });
    const stacks = await inventoryStacks(cfn, 'eu-west-1');
    expect(stacks.map((s) => [s.stackName, s.status])).toEqual([['SparesSite-dev', 'UPDATE_COMPLETE'], ['CDKToolkit', 'CREATE_COMPLETE']]);
  });
});

describe('CloudTrail ownership lookup', () => {
  it('is configured to search us-east-1, where IAM and CloudFront record events', () => {
    expect(config.cloudtrailRegions).toEqual(expect.arrayContaining(['eu-west-1', 'us-east-1']));
    expect(config.cloudtrailEventNames).toEqual(expect.arrayContaining(['CreateRole', 'PutRolePolicy', 'CreateDistribution']));
  });

  it('searches every region, follows pages and reports truncation', async () => {
    const event = (name, n) => ({ EventName: name, EventTime: `t${n}`, Username: 'u', Resources: [{ ResourceType: 'AWS::IAM::Role', ResourceName: `r${n}` }] });
    const eu = fakeClient({ LookupEventsCommand: (input) => ({ Events: input.LookupAttributes[0].AttributeValue === 'CreateTable' ? [event('CreateTable', 1)] : [] }) });
    let page = 0;
    const us = fakeClient({ LookupEventsCommand: (input) => {
      if (input.LookupAttributes[0].AttributeValue !== 'CreateRole') return { Events: [] };
      page += 1;
      return { Events: [event('CreateRole', page)], NextToken: 'more' };
    } });
    const { events, coverage } = await creationEvents({ 'eu-west-1': eu, 'us-east-1': us }, ['CreateTable', 'CreateRole'], { maxPerEvent: 3 });
    expect(events.filter((e) => e.region === 'us-east-1' && e.eventName === 'CreateRole')).toHaveLength(3);
    expect(events.find((e) => e.region === 'eu-west-1').eventName).toBe('CreateTable');
    expect(coverage.find((c) => c.region === 'us-east-1' && c.eventName === 'CreateRole')).toMatchObject({ events: 3, truncated: true });
    expect(coverage.find((c) => c.region === 'eu-west-1' && c.eventName === 'CreateTable')).toMatchObject({ events: 1, truncated: false });
  });
});
