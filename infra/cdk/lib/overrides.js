'use strict';
/**
 * Phase 7 onwards: the reviewed changes (infra/cdk/config/runtime-overrides.json), applied to the live capture. Only
 * production names are overridden; the sandbox profile has no overrides.
 *   functions.<name>.env.set / env.unset   environment variables (a value may be a {{resolve:secretsmanager:...}} reference)
 *   functions.<name>.code                  {s3Bucket, s3Key} of a zip built from this repository
 *   functions.<name>.url.cors              the Function URL CORS: null removes it, an object replaces it (live shape)
 *   functions.<name>.permissions.<sid>     {invokedViaFunctionUrl: true}: a resource-policy statement is limited to
 *                                          invocations through the function's URL. <sid> is the imported statement id
 *                                          (CloudFormation renames the statement when it replaces it)
 *   rolePolicies["<role>/<policy>"]        the inline policy document
 *   roleManagedPolicies["<role>"]          the role's managed policy ARNs, exactly (T7: always declared in full)
 */
function applyOverrides(live, overrides) {
  const out = JSON.parse(JSON.stringify(live));
  for (const [name, o] of Object.entries(overrides.functions || {})) {
    const f = out.functions[name];
    if (!f) throw new Error(`override for unknown function ${name}`);
    const vars = { ...(f.configuration.Environment?.Variables || {}) };
    // Overrides describe the desired state, so they hold once deployed: unsetting an absent variable is a no-op.
    for (const k of o.env?.unset || []) delete vars[k];
    Object.assign(vars, o.env?.set || {});
    f.configuration.Environment = { Variables: vars };
    if (o.code) f.codeOverride = o.code;
    if (o.url && Object.prototype.hasOwnProperty.call(o.url, 'cors')) {
      if (!f.url) throw new Error(`url override for ${name}, which has no Function URL`);
      f.url.Cors = o.url.cors;
    }
    if (o.permissions) f.permissionOverrides = o.permissions;
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
