/**
 * Read-only investigation of API Gateway permissions on a Lambda function.
 *
 * A resource-policy statement that lets API Gateway invoke a function does not prove the API
 * still calls it: the permission may be stale. For each API named in the policy, this checks
 * whether any integration targets the function, both in the API's current configuration and in
 * each deployed stage (the deployed definition is read with GetExport).
 */
import { GetExportCommand, GetResourcesCommand, GetRestApiCommand, GetStagesCommand } from '@aws-sdk/client-api-gateway';
import { GetApiCommand, GetIntegrationsCommand, GetStagesCommand as GetStagesV2Command } from '@aws-sdk/client-apigatewayv2';
import { collectPages, optional } from '../util/aws-errors.js';
import { stacksManaging } from './cloudformation.js';

const EXECUTE_API_ARN = /^arn:aws:execute-api:[^:]+:[^:]*:([a-z0-9]+)\//;

/** API Gateway statements in a Lambda resource policy, with the API id when the policy names one. */
export function apiGatewayStatements(policy) {
  const statements = (policy && policy.Statement) || [];
  return statements
    .filter((s) => {
      const p = s.Principal;
      const service = p && (typeof p === 'string' ? p : p.Service);
      return [].concat(service || []).includes('apigateway.amazonaws.com');
    })
    .map((s) => {
      const conditions = s.Condition || {};
      const sourceArns = Object.values(conditions).flatMap((c) => [].concat((c && c['AWS:SourceArn']) || []));
      const apiIds = sourceArns.map((a) => (String(a).match(EXECUTE_API_ARN) || [])[1]).filter(Boolean);
      return { sid: s.Sid || null, sourceArns, apiIds: [...new Set(apiIds)] };
    });
}

/** Paths and methods in an OpenAPI export whose integration targets the function. */
export function integrationsTargeting(openApi, functionName) {
  const hits = [];
  const needle = `:function:${functionName}`;
  for (const [path, methods] of Object.entries((openApi && openApi.paths) || {})) {
    for (const [method, op] of Object.entries(methods || {})) {
      const uri = op && op['x-amazon-apigateway-integration'] && op['x-amazon-apigateway-integration'].uri;
      if (typeof uri === 'string' && uri.includes(needle)) hits.push({ path, method: method.toUpperCase() });
    }
  }
  return hits;
}

async function investigateRestApi(apigateway, apiId, functionName) {
  const api = await optional(apigateway.send(new GetRestApiCommand({ restApiId: apiId })));
  if (!api) return null;
  const needle = `:function:${functionName}`;
  const resources = await collectPages(
    (position) => apigateway.send(new GetResourcesCommand({ restApiId: apiId, embed: ['methods'], position, limit: 500 })),
    (p) => p.items,
    (p) => p.position,
  );
  const current = [];
  for (const r of resources) {
    for (const [method, m] of Object.entries(r.resourceMethods || {})) {
      const uri = m && m.methodIntegration && m.methodIntegration.uri;
      if (typeof uri === 'string' && uri.includes(needle)) current.push({ path: r.path, method });
    }
  }
  const stages = (await apigateway.send(new GetStagesCommand({ restApiId: apiId }))).item || [];
  const deployed = {};
  for (const stage of stages) {
    const exported = await apigateway.send(new GetExportCommand({ restApiId: apiId, stageName: stage.stageName, exportType: 'oas30', parameters: { extensions: 'integrations' }, accepts: 'application/json' }));
    const doc = JSON.parse(Buffer.from(exported.body).toString('utf8'));
    deployed[stage.stageName] = integrationsTargeting(doc, functionName);
  }
  return { type: 'REST', name: api.name, createdDate: api.createdDate, stages: stages.map((s) => s.stageName), current, deployed };
}

async function investigateHttpApi(apigatewayv2, apiId, functionName) {
  const api = await optional(apigatewayv2.send(new GetApiCommand({ ApiId: apiId })));
  if (!api) return null;
  const integrations = await collectPages(
    (NextToken) => apigatewayv2.send(new GetIntegrationsCommand({ ApiId: apiId, NextToken })),
    (p) => p.Items,
    (p) => p.NextToken,
  );
  const needle = `:function:${functionName}`;
  const current = integrations.filter((i) => String(i.IntegrationUri || '').includes(needle)).map((i) => ({ integrationId: i.IntegrationId }));
  const stages = (await apigatewayv2.send(new GetStagesV2Command({ ApiId: apiId }))).Items || [];
  return { type: api.ProtocolType || 'HTTP', name: api.Name, createdDate: api.CreatedDate, stages: stages.map((s) => s.StageName), current, deployed: null };
}

export async function investigateApiPermissions({ apigateway, apigatewayv2, functionName, policy, stacks }) {
  const results = [];
  for (const statement of apiGatewayStatements(policy)) {
    if (statement.apiIds.length === 0) {
      results.push({ functionName, sid: statement.sid, apiId: null, conclusion: 'unscoped', note: 'Any API in the account may invoke this function; the policy names no API.' });
      continue;
    }
    for (const apiId of statement.apiIds) {
      const found = (await investigateRestApi(apigateway, apiId, functionName)) || (await investigateHttpApi(apigatewayv2, apiId, functionName));
      const managedBy = stacksManaging(stacks, apiId);
      if (!found) {
        results.push({ functionName, sid: statement.sid, apiId, managedBy, conclusion: 'api-not-found', note: 'The API no longer exists in this region; the permission is stale.' });
        continue;
      }
      const deployedHits = found.deployed ? Object.values(found.deployed).flat().length : found.current.length;
      const conclusion = deployedHits > 0 ? 'invokes' : found.current.length > 0 ? 'configured-not-deployed' : 'no-integration-found';
      results.push({ functionName, sid: statement.sid, apiId, managedBy, ...found, conclusion });
    }
  }
  return results;
}
