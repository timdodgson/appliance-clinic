'use strict';
/**
 * AcRuntimeStack (Phase 5 steps 5.5 to 5.10). L1 resources only, Retain everywhere.
 *
 * The template is generated from a capture of the live configuration (infra/production/capture-runtime.sh), so it
 * carries live values by construction. A property is declared when it is set live to a non-default value; defaults are
 * left undeclared. Which writes CloudFormation then makes after the import is the subject of the import-semantics probe
 * (docs/migration/phase-5-import-semantics.md).
 *
 *   - Roles: no `Policies` (T2); `ManagedPolicyArns` exactly (T7). Inline policies are separate AWS::IAM::RolePolicy.
 *   - Bearer tokens in Lambda environments: a NoEcho parameter each, whose value the step takes from the live function
 *     at change-set time. A Secrets Manager reference could resolve to a different value, and proving it equal would
 *     mean comparing secret values, so the token is carried over as it is. It never appears in a template or in git.
 *   - A function the stack creates (runtime-overrides.json `create`, ADR 0019: applianceclinic-diagnosis-engine) also
 *     gets its log group (retention), metric filters on its failed and refused requests, and alarms. Its Function URL
 *     is AWS_IAM; callers are allowed by their own role policies, so it has no resource-policy statement.
 *   - A created function may declare layers and resource-policy statements (ADR 0022: applianceclinic-error-code-mcp,
 *     a Zip function run by the Lambda Web Adapter layer behind a bearer-gated public Function URL, with the two
 *     statements a public URL needs). Its statements depend on it.
 */
const fs = require('node:fs');
const cdk = require('aws-cdk-lib');
const { aws_iam: iam, aws_lambda: lambda, aws_events: events, aws_logs: logs, aws_cloudwatch: cloudwatch } = cdk;
const { upTo, retain, shellHandle, logical, SANDBOX_NAMES } = require('./common');
const { applyOverrides, importedSid } = require('./overrides');

/** Import groups by production name. */
// spares4repairs-error-code-mcp (5.7a) was released from the stack in change 22.3 (ADR 0022).
const FUNCTION_STEP = {
  'spares4repairs-diag-orchestrator': '5.7b', 'whichpart-api': '5.7c',
  'applianceclinic-diagnosis-engine': '5.10', 'applianceclinic-error-code-mcp': '5.10',
};
const URL_STEP = { ...Object.fromEntries(Object.keys(FUNCTION_STEP).map((f) => [f, '5.8'])), 'applianceclinic-diagnosis-engine': '5.10',
  'applianceclinic-error-code-mcp': '5.10' };
/** Log metrics of a created function (ApplianceClinic namespace): the text each counted log line contains. */
const CREATED_METRICS = {
  FailedTurns: '"\\"evt\\":\\"diagnosis-engine\\"" "\\"ok\\":false"',
  RefusedRequests: '"\\"evt\\":\\"engine-auth\\"" "\\"rejected\\":true"',
};
/** Permissions owned by AC. `apigateway-invoke` on the diagnosis Lambda is S4R-sensitive and never imported. */
const NEVER_MANAGED_SIDS = new Set(['apigateway-invoke']);
const isToken = (key) => /TOKEN$/.test(key);
/** CloudFormation's own aws:cloudformation:* tags appear on a resource once it is imported; they are never declared. */
const userTags = (tags) => (tags || []).filter((t) => !t.Key.startsWith('aws:'));

class RuntimeStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const has = upTo(props.step);
    const live = applyOverrides(JSON.parse(fs.readFileSync(props.live, 'utf8')), props.overrides || {});
    const reverse = Object.fromEntries(Object.entries(SANDBOX_NAMES).map(([p, s]) => [s, p]));
    // Logical IDs always come from the production name, so both profiles share them.
    const prod = (n) => (props.profile === 'sandbox' ? (reverse[n] || n.replace(/-sbx$/, '')) : n);
    shellHandle(this);

    for (const [name, r] of Object.entries(live.roles)) {
      let roleResource = null;
      if (has('5.5')) {
        roleResource = retain(new iam.CfnRole(this, logical(prod(name)), {
          roleName: name,
          assumeRolePolicyDocument: r.trust,
          managedPolicyArns: r.managed,
          ...(r.maxSessionDuration !== 3600 ? { maxSessionDuration: r.maxSessionDuration } : {}),
          ...(r.path !== '/' ? { path: r.path } : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(r.boundary ? { permissionsBoundary: r.boundary } : {}),
          ...(userTags(r.tags).length ? { tags: userTags(r.tags).map((t) => ({ key: t.Key, value: t.Value })) } : {}),
        }));
      }
      if (has('5.6')) {
        for (const [policyName, policyDocument] of Object.entries(r.inline)) {
          const policy = retain(new iam.CfnRolePolicy(this, logical(`${prod(name)}-${prod(policyName)}`), { roleName: name, policyName, policyDocument }));
          // A role this stack creates (Phase 7): its policies name it by a literal, so they need an explicit order.
          // Imported roles already exist and keep their template unchanged.
          if (r.stackCreated && roleResource) policy.addDependency(roleResource);
        }
      }
    }

    for (const [name, f] of Object.entries(live.functions)) {
      const p = prod(name);
      const c = f.configuration;
      const fid = logical(p);
      // A created function is introduced in reviewed stages (create.resources): its log group, metrics and alarms can
      // exist before the function itself.
      const parts = f.create ? new Set(f.create.resources || ['logs', 'metrics', 'alarms', 'function']) : null;
      if (parts) this.createdExtras(name, fid, f.create, parts);
      if (parts && !parts.has('function')) continue;
      if (has(FUNCTION_STEP[p])) {
        const variables = {};
        for (const [k, v] of Object.entries(c.Environment?.Variables || {})) {
          if (!isToken(k) || String(v).startsWith('{{resolve:')) { variables[k] = v; continue; }
          const param = new cdk.CfnParameter(this, `Env${fid}${k.replace(/_/g, '')}`, {
            type: 'String', noEcho: true, description: `${name} ${k}: the live value, carried over at change-set time`,
          });
          variables[k] = param.valueAsString;
        }
        const zip = c.PackageType === 'Zip';
        // An image function keeps its live image unless a reviewed override names another one (by digest).
        const imageUri = f.codeOverride && f.codeOverride.imageUri ? f.codeOverride.imageUri : f.code.imageUri;
        if (!zip && f.codeOverride && !/@sha256:[0-9a-f]{64}$/.test(imageUri)) throw new Error(`${name}: an image override must name a digest`);
        const code = zip ? (f.codeOverride || props.codeLocations?.[name]) : { imageUri };
        if (!code) throw new Error(`no code location for ${name}`);
        const fn = retain(new lambda.CfnFunction(this, fid, {
          functionName: name,
          role: c.Role,
          packageType: c.PackageType,
          code,
          ...(zip ? { runtime: c.Runtime, handler: c.Handler } : {}),
          architectures: c.Architectures,
          memorySize: c.MemorySize,
          timeout: c.Timeout,
          ...(Object.keys(variables).length ? { environment: { variables } } : {}),
          ...(c.TracingConfig?.Mode && c.TracingConfig.Mode !== 'PassThrough' ? { tracingConfig: { mode: c.TracingConfig.Mode } } : {}),
          ...(c.EphemeralStorage?.Size && c.EphemeralStorage.Size !== 512 ? { ephemeralStorage: { size: c.EphemeralStorage.Size } } : {}),
          ...(c.Description ? { description: c.Description } : {}),
          // Layers are declared only for a function this stack creates (ADR 0022); imported functions keep their template.
          ...(f.create && c.Layers && c.Layers.length ? { layers: c.Layers.map((l) => l.Arn) } : {}),
          ...(userTags(Object.entries(f.tags || {}).map(([Key, Value]) => ({ Key, Value }))).length
            ? { tags: userTags(Object.entries(f.tags).map(([Key, Value]) => ({ Key, Value }))).map((t) => ({ key: t.Key, value: t.Value })) } : {}),
          ...(f.reservedConcurrency != null ? { reservedConcurrentExecutions: f.reservedConcurrency } : {}),
        }));
        if (f.create) this.createdDependencies(fn, fid, f.create, prod);
      }
      if (has(URL_STEP[p]) && f.url) {
        const cors = f.url.Cors && {
          ...(f.url.Cors.AllowCredentials != null ? { allowCredentials: f.url.Cors.AllowCredentials } : {}),
          ...(f.url.Cors.AllowHeaders ? { allowHeaders: f.url.Cors.AllowHeaders } : {}),
          ...(f.url.Cors.AllowMethods ? { allowMethods: f.url.Cors.AllowMethods } : {}),
          ...(f.url.Cors.AllowOrigins ? { allowOrigins: f.url.Cors.AllowOrigins } : {}),
          ...(f.url.Cors.ExposeHeaders ? { exposeHeaders: f.url.Cors.ExposeHeaders } : {}),
          ...(f.url.Cors.MaxAge != null ? { maxAge: f.url.Cors.MaxAge } : {}),
        };
        const url = retain(new lambda.CfnUrl(this, `${fid}Url`, {
          targetFunctionArn: c.FunctionArn || `arn:aws:lambda:${this.region}:${this.account}:function:${name}`,
          authType: f.url.AuthType,
          invokeMode: f.url.InvokeMode,
          ...(cors ? { cors } : {}),
        }));
        // A created function's URL names it by a literal ARN.
        if (f.create) url.node.addDependency(this.node.findChild(fid));
      }
      if (has(URL_STEP[p])) {
        const overridden = f.permissionOverrides || {};
        const seen = new Set();
        for (const s of f.statements) {
          if (NEVER_MANAGED_SIDS.has(s.Sid)) continue;
          const sid = importedSid(s.Sid, this.stackName, fid);
          seen.add(sid);
          // A null override releases the statement from the stack (Retain: nothing physical changes).
          if (overridden[sid] === null) continue;
          const principal = s.Principal === '*' ? '*' : (s.Principal.Service || s.Principal.AWS);
          const authType = s.Condition?.StringEquals?.['lambda:FunctionUrlAuthType'];
          const sourceArn = s.Condition?.ArnLike?.['AWS:SourceArn'];
          const viaUrl = s.Condition?.Bool?.['lambda:InvokedViaFunctionUrl'];
          const known = new Set(['StringEquals', 'ArnLike', 'Bool']);
          for (const k of Object.keys(s.Condition || {})) if (!known.has(k)) throw new Error(`${name} ${s.Sid}: condition ${k} not representable`);
          const o = overridden[sid] || {};
          const invokedViaFunctionUrl = o.invokedViaFunctionUrl === true || viaUrl === 'true' || viaUrl === true;
          const perm = retain(new lambda.CfnPermission(this, `${fid}${logical(sid)}`, {
            functionName: name, action: s.Action, principal,
            ...(authType ? { functionUrlAuthType: authType } : {}),
            ...(sourceArn ? { sourceArn } : {}),
            ...(invokedViaFunctionUrl ? { invokedViaFunctionUrl: true } : {}),
          }));
          // A created function's statements name it by a literal, so they wait for it.
          if (f.create) perm.node.addDependency(this.node.findChild(fid));
          // A Permission is replaced to change it. The statement it replaces must go, so it is not retained on update.
          if (overridden[sid]) {
            perm.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.DELETE;
            perm.addMetadata('ac:updateReplacePolicyReason', 'Changing a permission replaces its statement; the replaced statement must not remain (Phase 7)');
          }
        }
        // A null override of a statement that no longer exists is a no-op (the overrides are the desired state).
        for (const sid of Object.keys(overridden)) if (!seen.has(sid) && overridden[sid] !== null) throw new Error(`permission override for unknown statement ${name} ${sid}`);
      }
    }

    if (has('5.9')) {
      for (const [name, r] of Object.entries(live.rules)) {
        retain(new events.CfnRule(this, logical(prod(name)), {
          name,
          scheduleExpression: r.scheduleExpression,
          state: r.state,
          ...(r.description ? { description: r.description } : {}),
          ...(r.eventBusName && r.eventBusName !== 'default' ? { eventBusName: r.eventBusName } : {}),
          targets: r.targets.map((t) => ({ id: t.Id, arn: t.Arn, ...(t.Input ? { input: t.Input } : {}) })),
          ...(userTags(r.tags).length ? { tags: userTags(r.tags).map((t) => ({ key: t.Key, value: t.Value })) } : {}),
        }));
      }
    }
    this.templateOptions.description = `${id}: Appliance Clinic runtime resources, imported (Phase 5). Retain on every resource.`;
  }

  /** A created function waits for its role, the role's policies and its log group (named by literals, not references). */
  createdDependencies(fn, fid, c, prod) {
    const roleName = c.role.split('/').pop();
    const role = this.node.tryFindChild(logical(prod(roleName)));
    if (role) fn.node.addDependency(role);
    for (const child of this.node.children) {
      if (child instanceof iam.CfnRolePolicy && child.roleName === roleName) fn.node.addDependency(child);
    }
    const lg = this.node.tryFindChild(`${fid}Logs`);
    if (lg) fn.node.addDependency(lg);
  }

  /** A created function's log group (retention), log metrics and alarms. */
  createdExtras(name, fid, c, parts) {
    const logGroupName = `/aws/lambda/${name}`;
    if (!parts.has('logs')) return;
    const lg = retain(new logs.CfnLogGroup(this, `${fid}Logs`, { logGroupName, retentionInDays: c.logRetentionDays || 90 }));
    const alarm = (aid, props) => retain(new cloudwatch.CfnAlarm(this, `${fid}${aid}Alarm`, {
      alarmName: `${name}-${aid}`, comparisonOperator: 'GreaterThanOrEqualToThreshold', evaluationPeriods: 1, period: 300,
      treatMissingData: 'notBreaching', ...props,
    }));
    // The log metrics (and their alarms) are the diagnosis engine's own; a function staged without `metrics` (ADR 0022:
    // the error-code MCP) gets only the Lambda Errors and Throttles alarms.
    const metrics = parts.has('metrics');
    if (metrics) {
      for (const [metric, filterPattern] of Object.entries(CREATED_METRICS)) {
        const mf = retain(new logs.CfnMetricFilter(this, `${fid}${metric}`, {
          logGroupName, filterPattern, filterName: `${name}-${metric}`,
          metricTransformations: [{ metricNamespace: 'ApplianceClinic', metricName: `DiagnosisEngine${metric}`, metricValue: '1', defaultValue: 0 }],
        }));
        mf.node.addDependency(lg);
      }
    }
    if (!parts.has('alarms') || !c.alarms) return;
    if (metrics) {
      alarm('FailedTurns', { alarmDescription: 'Diagnosis engine turns that failed (503 engine_unavailable): Jev or COMPOSE provider down, or an engine error.',
        namespace: 'ApplianceClinic', metricName: 'DiagnosisEngineFailedTurns', statistic: 'Sum', threshold: 5 });
      alarm('RefusedRequests', { alarmDescription: 'Requests refused for a missing or invalid engine signature. AC callers always sign: any refusal is a caller or key fault.',
        namespace: 'ApplianceClinic', metricName: 'DiagnosisEngineRefusedRequests', statistic: 'Sum', threshold: 1 });
    }
    for (const m of ['Errors', 'Throttles']) {
      alarm(m, { alarmDescription: `Lambda ${m} on ${name}.`, namespace: 'AWS/Lambda', metricName: m, statistic: 'Sum', threshold: 1,
        dimensions: [{ name: 'FunctionName', value: name }] });
    }
  }
}

module.exports = { RuntimeStack, FUNCTION_STEP, NEVER_MANAGED_SIDS, applyOverrides, importedSid };
