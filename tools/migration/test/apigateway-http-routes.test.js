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

function httpApi({ routes, autoDeploy = true }) {
  return fakeClient({
    GetApiCommand: () => ({ Name: 'spares4repairs-dev', ProtocolType: 'HTTP', CreatedDate: 'd' }),
    GetIntegrationsCommand: () => ({ Items: [{ IntegrationId: 'nk77gue', IntegrationType: 'AWS_PROXY', IntegrationUri: target, PayloadFormatVersion: '2.0', TimeoutInMillis: 30000 }, { IntegrationId: 'a6vdcjc', IntegrationUri: 'arn:aws:lambda:eu-west-1:0:function:other' }] }),
    GetRoutesCommand: () => ({ Items: routes }),
    GetStagesCommand: () => ({ Items: [{ StageName: '$default', AutoDeploy: autoDeploy, DeploymentId: 'gbo1y0', LastDeploymentStatusMessage: 'Successfully deployed', LastUpdatedDate: 'u' }] }),
  });
}

const liveRoutes = [
  { RouteId: 'ncdglq1', RouteKey: 'POST /ai/chat', Target: 'integrations/nk77gue', AuthorizationType: 'NONE' },
  { RouteId: 'hpiku2m', RouteKey: '$default', Target: 'integrations/a6vdcjc' },
];

describe('HTTP API route recording', () => {
  it('records the route and authorisation that reach the diagnosis Lambda', async () => {
    const apigatewayv2 = httpApi({ routes: liveRoutes });
    const [r] = await investigateApiPermissions({ apigateway: fakeClient({ GetRestApiCommand: notFound }), apigatewayv2, functionName: 'spares4repairs-part-finder', policy, stacks: [] });
    expect(r).toMatchObject({ type: 'HTTP', name: 'spares4repairs-dev', conclusion: 'invokes', managedBy: [], executeApiEndpointDisabled: false });
    expect(r.current).toEqual([{
      integrationId: 'nk77gue', integrationType: 'AWS_PROXY', payloadFormatVersion: '2.0', timeoutInMillis: 30000,
      routes: [{ routeId: 'ncdglq1', routeKey: 'POST /ai/chat', target: 'integrations/nk77gue', authorizationType: 'NONE', apiKeyRequired: false }],
    }]);
    expect(r.stages).toEqual([{ name: '$default', autoDeploy: true, deploymentId: 'gbo1y0', lastDeploymentStatusMessage: 'Successfully deployed', lastUpdatedDate: 'u', detailedMetrics: false, accessLogs: false }]);
  });

  it('does not claim the route is served when no stage auto-deploys', async () => {
    const apigatewayv2 = httpApi({ routes: liveRoutes, autoDeploy: false });
    const [r] = await investigateApiPermissions({ apigateway: fakeClient({ GetRestApiCommand: notFound }), apigatewayv2, functionName: 'spares4repairs-part-finder', policy, stacks: [] });
    expect(r.conclusion).toBe('routed-deployment-unverified');
  });

  it('treats an integration with no route as configured but unreachable', async () => {
    const apigatewayv2 = httpApi({ routes: [{ RouteKey: '$default', Target: 'integrations/a6vdcjc' }] });
    const [r] = await investigateApiPermissions({ apigateway: fakeClient({ GetRestApiCommand: notFound }), apigatewayv2, functionName: 'spares4repairs-part-finder', policy, stacks: [] });
    expect(r.conclusion).toBe('integration-without-route');
    expect(r.current[0].routes).toEqual([]);
  });
});
