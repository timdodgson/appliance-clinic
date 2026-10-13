'use strict';
/**
 * Phase 7 onwards: the reviewed changes (infra/cdk/config/runtime-overrides.json), applied to the live capture. Only
 * production names are overridden; the sandbox profile has no overrides.
 *   functions.<name>.env.set / env.unset   environment variables (a value may be a {{resolve:secretsmanager:...}} reference)
 *   functions.<name>.code                  {s3Bucket, s3Key} of a zip built from this repository, or {imageUri} (by digest)
 *                                          of an image built from this repository for an image function
 *   functions.<name>.url.cors              the Function URL CORS: null removes it, an object replaces it (live shape)
 *   functions.<name>.permissions.<sid>     {invokedViaFunctionUrl: true}: a resource-policy statement is limited to
 *                                          invocations through the function's URL. <sid> is the imported statement id
 *                                          (CloudFormation renames the statement when it replaces it)
 *   rolePolicies["<role>/<policy>"]        the inline policy document
 *   roleManagedPolicies["<role>"]          the role's managed policy ARNs, exactly (T7: always declared in full)
 *   roles["<role>"]                        a role this stack creates (absent from the capture until it exists):
 *                                          {trust, managed, inline: {name: document}, description}; the desired state
 *   functions.<name>.role                  the function's execution role ARN
 *   functions.<name>.create                a function this stack creates (ADR 0019), absent from the capture until it
 *                                          exists: {role, runtime, handler, architectures, memorySize, timeout,
 *                                          url: {authType, invokeMode}, logRetentionDays, alarms, tags, carryFrom,
 *                                          layers, statements}. Its configuration is always the declared one;
 *                                          env.digests values are carried from its own live environment, or from
 *                                          `carryFrom` until it exists (the value never appears in git, only its SHA-256)
 *                                          layers: layer version ARNs (ADR 0022: the Lambda Web Adapter)
 *                                          statements: its resource-policy statements, in the captured (get-policy)
 *                                          shape {Sid, Action, Principal, Condition}; none when absent
 */
const { createHash } = require('node:crypto');
const sha256 = (v) => `sha256:${createHash('sha256').update(String(v)).digest('hex')}`;

function createdFunction(name, c, existing, out) {
  for (const k of ['role', 'runtime', 'handler', 'architectures', 'memorySize', 'timeout', 'url']) {
    if (c[k] == null) throw new Error(`created function ${name} needs ${k}`);
  }
  if (c.layers != null && (!Array.isArray(c.layers) || c.layers.some((l) => !/^arn:aws:lambda:[a-z0-9-]+:\d{12}:layer:[A-Za-z0-9_-]+:\d+$/.test(l)))) {
    throw new Error(`created function ${name}: layers must be layer version ARNs`);
  }
  for (const s of c.statements || []) {
    if (!s.Sid || !s.Action || !s.Principal) throw new Error(`created function ${name}: a statement needs Sid, Action and Principal`);
  }
  return {
    configuration: {
      Role: c.role, PackageType: 'Zip', Runtime: c.runtime, Handler: c.handler, Architectures: c.architectures.slice(),
      MemorySize: c.memorySize, Timeout: c.timeout, Description: c.description || '',
      Environment: { Variables: { ...((existing && existing.configuration.Environment && existing.configuration.Environment.Variables) || {}) } },
      ...(c.layers && c.layers.length ? { Layers: c.layers.map((Arn) => ({ Arn })) } : {}),
    },
    code: {},
    tags: Object.fromEntries((c.tags || []).map((t) => [t.Key, t.Value])),
    url: { AuthType: c.url.authType, InvokeMode: c.url.invokeMode, Cors: null },
    statements: JSON.parse(JSON.stringify(c.statements || [])),
    reservedConcurrency: c.reservedConcurrency != null ? c.reservedConcurrency : null,
    create: c,
    carrySource: existing ? null : (c.carryFrom ? out.functions[c.carryFrom] : null),
  };
}

function applyOverrides(live, overrides) {
  const out = JSON.parse(JSON.stringify(live));
  for (const [name, o] of Object.entries(overrides.functions || {})) {
    if (o.create) out.functions[name] = createdFunction(name, o.create, out.functions[name], out);
    const f = out.functions[name];
    if (!f) throw new Error(`override for unknown function ${name}`);
    const vars = { ...(f.configuration.Environment?.Variables || {}) };
    // Overrides describe the desired state, so they hold once deployed: unsetting an absent variable is a no-op.
    for (const k of o.env?.unset || []) delete vars[k];
    Object.assign(vars, o.env?.set || {});
    if (o.create) {
      // Only declared variables exist on a created function; a digest-declared value is carried, never written here.
      const declared = new Set([...Object.keys(o.env?.set || {}), ...Object.keys(o.env?.digests || {})]);
      for (const k of Object.keys(vars)) if (!declared.has(k)) delete vars[k];
      for (const [k, h] of Object.entries(o.env?.digests || {})) {
        if (!(k in vars)) {
          const src = f.carrySource && f.carrySource.configuration.Environment?.Variables;
          if (!src || !(k in src)) throw new Error(`${name} ${k}: no live value to carry`);
          vars[k] = src[k];
        }
        if (sha256(vars[k]) !== h) throw new Error(`${name} ${k}: the carried value does not match its declared digest`);
      }
      delete f.carrySource;
    }
    f.configuration.Environment = { Variables: vars };
    if (o.code) f.codeOverride = o.code;
    if (o.url && Object.prototype.hasOwnProperty.call(o.url, 'cors')) {
      if (!f.url) throw new Error(`url override for ${name}, which has no Function URL`);
      f.url.Cors = o.url.cors;
    }
    if (o.permissions) f.permissionOverrides = o.permissions;
    if (o.role) f.configuration.Role = o.role;
  }
  // Roles this stack creates come first, so rolePolicies and roleManagedPolicies may refer to them.
  for (const [role, r] of Object.entries(overrides.roles || {})) {
    if (!r.trust || !Array.isArray(r.managed) || !r.inline) throw new Error(`role ${role} needs trust, managed and inline`);
    out.roles[role] = { trust: r.trust, path: '/', maxSessionDuration: 3600, description: r.description || null, boundary: null, tags: r.tags || [], managed: r.managed.slice(), inline: JSON.parse(JSON.stringify(r.inline)), stackCreated: true };
  }
  for (const [key, doc] of Object.entries(overrides.rolePolicies || {})) {
    const [role, policy] = key.split('/');
    if (!out.roles[role]) throw new Error(`override for unknown role ${role}`);
    out.roles[role].inline[policy] = doc;
  }
  for (const [role, arns] of Object.entries(overrides.roleManagedPolicies || {})) {
    if (!out.roles[role]) throw new Error(`override for unknown role ${role}`);
    if (!Array.isArray(arns)) throw new Error(`managed policies of ${role} must be a list`);
    out.roles[role].managed = arns.slice();
  }
  return out;
}

/**
 * The imported statement id of a captured statement. A statement CloudFormation created (after a replacement) is named
 * <stack>-<logicalId>-<suffix>; its logical ID is the function's prefix plus the imported id, which keeps logical IDs
 * stable across a replacement.
 */
function importedSid(sid, stackName, fid) {
  const m = new RegExp(`^${stackName}-${fid}([A-Za-z0-9]+)-[A-Za-z0-9]+$`).exec(sid);
  return m ? m[1] : sid;
}

module.exports = { applyOverrides, importedSid };
