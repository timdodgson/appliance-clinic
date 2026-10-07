import { apiGatewayStatements } from './apigateway.js';
import { stacksManaging } from './cloudformation.js';

/**
 * Automatic ownership red flags. These do not prove ownership; they find reasons a candidate
 * must be treated as S4R. Anything flagged here stays S4R until a person resolves it.
 */
export function ownershipChecks({ stacks, functions, roleUsage, candidateFunctionNames, roles, tables, buckets, secrets, repositories, rules, cloudfrontSharing }) {
  const flags = [];
  const managed = (kind, id) => {
    const owners = stacksManaging(stacks, id);
    if (owners.length) flags.push({ severity: 'stop', kind, id, reason: `Managed by CloudFormation stack(s) ${owners.join(', ')}: treat as S4R.` });
  };

  for (const f of functions) {
    if (!f.exists) { flags.push({ severity: 'info', kind: 'lambda', id: f.name, reason: 'Candidate function does not exist.' }); continue; }
    managed('lambda', f.name);
    for (const st of apiGatewayStatements(f.resourcePolicy)) {
      const apis = st.apiIds.length ? st.apiIds.join(', ') : 'any API';
      flags.push({ severity: 'stop', kind: 'lambda-permission', id: `${f.name}:${st.sid}`, reason: `API Gateway (${apis}) may invoke this function: a possible S4R consumer. S4R-sensitive until apigateway-permissions shows otherwise.` });
    }
  }
  for (const r of roles) {
    if (!r.exists) { flags.push({ severity: 'info', kind: 'iam-role', id: r.roleName, reason: 'Candidate role does not exist.' }); continue; }
    managed('iam-role', r.roleName);
    const users = roleUsage[r.roleName] || [];
    const others = users.filter((name) => !candidateFunctionNames.includes(name));
    if (others.length) flags.push({ severity: 'stop', kind: 'iam-role', id: r.roleName, reason: `Also used by non-candidate function(s) ${others.join(', ')}: shared role, treat as S4R.` });
  }
  for (const t of tables) if (t.exists) managed('dynamodb-table', t.tableName);
  for (const b of buckets) if (b.exists) managed('s3-bucket', b.bucket);
  for (const s of secrets) managed('secret', s.arn);
  for (const r of repositories) if (r.exists) managed('ecr-repository', r.repositoryName);
  for (const r of rules) if (r.exists) managed('events-rule', r.name);
  for (const hit of cloudfrontSharing.otherDistributions) {
    flags.push({ severity: 'stop', kind: 'cloudfront-function', id: hit.functionName, reason: `Also attached to distribution ${hit.distributionId} (${hit.aliases.join(', ') || 'no aliases'}): shared, treat as S4R.` });
  }
  return flags;
}

/** Outbound hosts the deployed functions are configured to call (from non-secret env values). */
export function externalDependencies(functions) {
  const deps = [];
  for (const f of functions) {
    const vars = (f.configuration && f.configuration.Environment && f.configuration.Environment.Variables) || {};
    for (const [name, value] of Object.entries(vars)) {
      if (typeof value !== 'string') continue;
      const m = value.match(/^https?:\/\/([^/]+)/i);
      if (m) deps.push({ function: f.name, variable: name, host: m[1].toLowerCase() });
    }
  }
  return deps;
}
