import { describe, expect, it } from 'vitest';
import { investigateApiPermissions } from '../src/inventory/apigateway.js';

const fakeClient = (handlers) => ({
  send: async (command) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw Object.assign(new Error(`unexpected ${command.constructor.name}`), { name: 'Unexpected' });
    return handler(command.input);
  },
});
const notFound = () => { throw Object.assign(new Error('not found'), { name: 'NotFoundException' }); };
const target = 'arn:aws:lambda:eu-west-1:0:function:spares4repairs-part-finder';
const policy = { Statement: [{ Sid: 'apigateway-invoke', Principal: { Service: 'apigateway.amazonaws.com' }, Condition: { ArnLike: { 'AWS:SourceArn': 'arn:aws:execute-api:eu-west-1:0:65vnizdmk4/*/*/ai/chat' } } }] };

function httpApi({ routes }) {
  return fakeClient({
    GetApiCommand: () => ({ Name: 'spares4repairs-dev', ProtocolType: 'HTTP', CreatedDate: 'd' }),
    GetIntegrationsCommand: () => ({ Items: [{ IntegrationId: 'nk77gue', IntegrationType: 'AWS_PROXY', IntegrationUri: target }, { IntegrationId: 'a6vdcjc', IntegrationUri: 'arn:aws:lambda:eu-west-1:0:function:other' }] }),
    GetRoutesCommand: () => ({ Items: routes }),
    GetStagesCommand: () => ({ Items: [{ StageName: '$default', AutoDeploy: true }] }),
  });
}

describe('HTTP API route recording', () => {
  it('records the route and authorisation that reach the diagnosis Lambda', async () => {
    const apigatewayv2 = httpApi({ routes: [{ RouteKey: 'POST /ai/chat', Target: 'integrations/nk77gue', AuthorizationType: 'NONE' }, { RouteKey: '$default', Target: 'integrations/a6vdcjc' }] });
    const [r] = await investigateApiPermissions({ apigateway: fakeClient({ GetRestApiCommand: notFound }), apigatewayv2, functionName: 'spares4repairs-part-finder', policy, stacks: [] });
    expect(r).toMatchObject({ type: 'HTTP', name: 'spares4repairs-dev', conclusion: 'invokes', managedBy: [] });
    expect(r.current).toEqual([{ integrationId: 'nk77gue', integrationType: 'AWS_PROXY', routes: [{ routeKey: 'POST /ai/chat', authorizationType: 'NONE' }] }]);
    expect(r.stages).toEqual([{ name: '$default', autoDeploy: true, detailedMetrics: false }]);
  });

  it('treats an integration with no route as configured but unreachable', async () => {
    const apigatewayv2 = httpApi({ routes: [{ RouteKey: '$default', Target: 'integrations/a6vdcjc' }] });
    const [r] = await investigateApiPermissions({ apigateway: fakeClient({ GetRestApiCommand: notFound }), apigatewayv2, functionName: 'spares4repairs-part-finder', policy, stacks: [] });
    expect(r.conclusion).toBe('configured-not-deployed');
  });
});
