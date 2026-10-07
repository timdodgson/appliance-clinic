import { describe, expect, it } from 'vitest';
import { apiGatewayStatements, integrationsTargeting, investigateApiPermissions } from '../src/inventory/apigateway.js';
import { ownershipChecks } from '../src/inventory/ownership-checks.js';

const fakeClient = (handlers) => ({
  send: async (command) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw Object.assign(new Error(`unexpected ${command.constructor.name}`), { name: 'Unexpected' });
    return handler(command.input);
  },
});
const notFound = () => { throw Object.assign(new Error('not found'), { name: 'NotFoundException' }); };

const policy = {
  Statement: [
    { Sid: 'FnUrlPublic', Principal: '*', Action: 'lambda:InvokeFunctionUrl' },
    { Sid: 'apigateway-invoke', Principal: { Service: 'apigateway.amazonaws.com' }, Action: 'lambda:InvokeFunction', Condition: { ArnLike: { 'AWS:SourceArn': 'arn:aws:execute-api:eu-west-1:000000000000:65vnizdmk4/*/POST/part-finder' } } },
  ],
};

describe('API Gateway permission investigation', () => {
  it('finds API Gateway statements and the API they name', () => {
    expect(apiGatewayStatements(policy)).toEqual([{ sid: 'apigateway-invoke', sourceArns: ['arn:aws:execute-api:eu-west-1:000000000000:65vnizdmk4/*/POST/part-finder'], apiIds: ['65vnizdmk4'] }]);
    expect(apiGatewayStatements({ Statement: [{ Sid: 'x', Principal: { Service: 'apigateway.amazonaws.com' } }] })[0].apiIds).toEqual([]);
  });

  it('finds integrations targeting the function in an exported definition', () => {
    const doc = { paths: {
      '/part-finder': { post: { 'x-amazon-apigateway-integration': { uri: 'arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:0:function:spares4repairs-part-finder/invocations' } } },
      '/search': { get: { 'x-amazon-apigateway-integration': { uri: 'arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:0:function:spares4repairs-server-dev/invocations' } } },
    } };
    expect(integrationsTargeting(doc, 'spares4repairs-part-finder')).toEqual([{ path: '/part-finder', method: 'POST' }]);
  });

  const restApi = (deployedDoc, currentUri) => fakeClient({
    GetRestApiCommand: () => ({ name: 'spares-api', createdDate: 'd' }),
    GetResourcesCommand: () => ({ items: [{ path: '/part-finder', resourceMethods: { POST: { methodIntegration: { uri: currentUri } } } }] }),
    GetStagesCommand: () => ({ item: [{ stageName: 'api' }] }),
    GetExportCommand: () => ({ body: Buffer.from(JSON.stringify(deployedDoc)) }),
  });
  const target = 'arn:aws:lambda:eu-west-1:0:function:spares4repairs-part-finder';
  const deployedDoc = { paths: { '/part-finder': { post: { 'x-amazon-apigateway-integration': { uri: `x/${target}/invocations` } } } } };
  const stacks = [{ region: 'eu-west-1', stackName: 'SparesSite-dev', resources: [{ physicalId: '65vnizdmk4' }] }];

  it('concludes the API invokes the function when a deployed stage integrates it', async () => {
    const [r] = await investigateApiPermissions({ apigateway: restApi(deployedDoc, `x/${target}/invocations`), apigatewayv2: fakeClient({}), functionName: 'spares4repairs-part-finder', policy, stacks });
    expect(r).toMatchObject({ apiId: '65vnizdmk4', type: 'REST', conclusion: 'invokes', managedBy: ['eu-west-1:SparesSite-dev'] });
    expect(r.deployed.api).toEqual([{ path: '/part-finder', method: 'POST' }]);
  });

  it('concludes no integration when nothing targets the function, so the permission is likely stale', async () => {
    const [r] = await investigateApiPermissions({ apigateway: restApi({ paths: {} }, 'x/other/invocations'), apigatewayv2: fakeClient({}), functionName: 'spares4repairs-part-finder', policy, stacks: [] });
    expect(r.conclusion).toBe('no-integration-found');
  });

  it('distinguishes configured-but-not-deployed integrations', async () => {
    const [r] = await investigateApiPermissions({ apigateway: restApi({ paths: {} }, `x/${target}/invocations`), apigatewayv2: fakeClient({}), functionName: 'spares4repairs-part-finder', policy, stacks: [] });
    expect(r.conclusion).toBe('configured-not-deployed');
  });

  it('reports an API that no longer exists as stale', async () => {
    const [r] = await investigateApiPermissions({ apigateway: fakeClient({ GetRestApiCommand: notFound }), apigatewayv2: fakeClient({ GetApiCommand: notFound }), functionName: 'spares4repairs-part-finder', policy, stacks: [] });
    expect(r.conclusion).toBe('api-not-found');
  });

  it('raises an ownership STOP flag for any API Gateway invoke permission', () => {
    const flags = ownershipChecks({ stacks: [], functions: [{ name: 'spares4repairs-part-finder', exists: true, resourcePolicy: policy }], roleUsage: {}, candidateFunctionNames: [], roles: [], tables: [], buckets: [], secrets: [], repositories: [], rules: [], cloudfrontSharing: { otherDistributions: [] } });
    expect(flags).toEqual([expect.objectContaining({ severity: 'stop', kind: 'lambda-permission', id: 'spares4repairs-part-finder:apigateway-invoke' })]);
  });
});
