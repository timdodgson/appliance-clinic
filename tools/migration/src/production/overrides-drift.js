/**
 * Phase 11 (E): drift between the declared runtime state (infra/cdk/config/runtime-overrides.json) and the deployed
 * Lambda configuration. Pure: the caller supplies the live configuration; nothing here reads AWS or prints a value.
 *
 * Declared per function:
 *   env.set          every environment variable the function has, with its value. A {{resolve:secretsmanager:…}}
 *                    reference is a secret: only its presence is checked (its pinned version is in the plain
 *                    AC_BEARER_VERSIONS marker, which is compared by value).
 *   env.unset        must be absent.
 *   env.digests      sensitive non-secret values (a private tunnel URL) declared by SHA-256, never by value.
 *   code             s3Key (zip, checked against build/reference/<fn>.zip.json codeSha256) or imageUri (by digest).
 * Any live variable that is not declared is drift: a behavioural switch must not exist only on the live function.
 */
import { createHash } from 'node:crypto';

const isSecretRef = (v) => typeof v === 'string' && v.startsWith('{{resolve:secretsmanager:');
export const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');

/**
 * @param declared  runtime-overrides.json `functions`
 * @param live      { [fn]: { env: {K: V}, codeSha256, imageDigest } }
 * @param refs      { [fn]: codeSha256 } from build/reference (zip functions)
 * @returns { ok, findings: [{fn, kind, key?}] }  (keys and kinds only, no values)
 */
export function overridesDrift(declared, live, refs = {}) {
  const findings = [];
  for (const [fn, d] of Object.entries(declared || {})) {
    const l = live[fn];
    if (!l) { findings.push({ fn, kind: 'function-missing' }); continue; }
    const env = l.env || {};
    const set = (d.env && d.env.set) || {};
    const digests = (d.env && d.env.digests) || {};
    for (const [k, v] of Object.entries(set)) {
      if (!(k in env)) findings.push({ fn, kind: 'declared-but-absent', key: k });
      else if (!isSecretRef(v) && env[k] !== v) findings.push({ fn, kind: 'value-differs', key: k });
    }
    for (const k of (d.env && d.env.unset) || []) if (k in env) findings.push({ fn, kind: 'unset-but-present', key: k });
    for (const [k, h] of Object.entries(digests)) {
      if (!(k in env)) findings.push({ fn, kind: 'declared-but-absent', key: k });
      else if (`sha256:${sha256(env[k])}` !== h) findings.push({ fn, kind: 'digest-differs', key: k });
    }
    const unset = new Set((d.env && d.env.unset) || []);
    for (const k of Object.keys(env)) if (!(k in set) && !(k in digests) && !unset.has(k)) findings.push({ fn, kind: 'undeclared', key: k });
    const code = d.code || {};
    if (code.imageUri) {
      const want = String(code.imageUri).split('@')[1];
      if (want && l.imageDigest !== want) findings.push({ fn, kind: 'image-differs' });
    } else if (code.s3Key && refs[fn] && l.codeSha256 !== refs[fn]) findings.push({ fn, kind: 'code-differs' });
  }
  return { ok: findings.length === 0, findings };
}

/** A benchmark routing lease (services/whichpart-api/benchmark/routing-override.js): 'active' while unreleased and unexpired. */
export function leaseState(lease, nowMs) {
  if (!lease || typeof lease !== 'object') return 'none';
  if (lease.state === 'released') return 'released';
  const beat = Date.parse(lease.heartbeatAt || lease.acquiredAt || '');
  return Number.isFinite(beat) && beat + Number(lease.leaseMs || 0) > nowMs ? 'active' : 'expired';
}
