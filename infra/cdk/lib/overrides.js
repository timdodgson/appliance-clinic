'use strict';
/**
 * Phase 7 onwards: the reviewed changes (infra/cdk/config/runtime-overrides.json), applied to the live capture. Only
 * production names are overridden; the sandbox profile has no overrides.
 *   functions.<name>.env.set / env.unset   environment variables (a value may be a {{resolve:secretsmanager:...}} reference)
 *   functions.<name>.code                  {s3Bucket, s3Key} of a zip built from this repository
 *   rolePolicies["<role>/<policy>"]        the inline policy document
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
  }
  for (const [key, doc] of Object.entries(overrides.rolePolicies || {})) {
    const [role, policy] = key.split('/');
    if (!out.roles[role]) throw new Error(`override for unknown role ${role}`);
    out.roles[role].inline[policy] = doc;
  }
  return out;
}

module.exports = { applyOverrides };
