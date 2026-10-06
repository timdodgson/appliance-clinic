/**
 * Phase 1 admin hotfix: make Appliance Clinic admin default-deny.
 *
 * In the deployed whichpart-api, `isAdminFromAccessToken` treats any signed-in user with no Cognito
 * groups as an admin. The user pool belongs to Spares4Repairs and has no groups, so every shop user
 * is an AC admin. The fix replaces that one function: admin requires the token's Cognito `sub` to be
 * on an allowlist held in AC's own configuration (AC_ADMIN_SUBS). Nothing in the S4R pool changes.
 *
 * Every caller passes a token that came from AdminInitiateAuth or was verified by Cognito GetUser,
 * so reading `sub` from it is as trustworthy as the original reading of `cognito:groups`.
 */

// Exact text in spares4repairs@13b7a50 services/whichpart-api/index.js:59-67. The patch refuses to
// apply unless this appears exactly once, so a deployed variant is never patched blindly.
export const ORIGINAL = `// Admin authorization: mirror the existing pool model (no groups configured -> any authenticated
// pool user is staff/admin). Forward-compatible: if an 'admin' Cognito group is ever added, require
// membership. Never trust this claim for anything without a Cognito-verified access token.
function isAdminFromAccessToken(accessToken) {
  const parts = String(accessToken || '').split('.');
  if (parts.length < 2) return false;
  const groups = b64urlJson(parts[1])['cognito:groups'] || [];
  return Array.isArray(groups) && groups.length ? groups.indexOf('admin') !== -1 : true;
}`;

export const REPLACEMENT = `// Admin authorization: default-deny. Admin requires the token's Cognito \`sub\` to be on the
// Appliance Clinic allowlist (AC_ADMIN_SUBS, comma-separated). Callers only pass tokens issued by
// AdminInitiateAuth or verified by Cognito GetUser. No allowlist means no admins.
function isAdminFromAccessToken(accessToken) {
  const parts = String(accessToken || '').split('.');
  if (parts.length < 2) return false;
  const sub = b64urlJson(parts[1]).sub;
  const allow = String(process.env.AC_ADMIN_SUBS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return typeof sub === 'string' && sub.length > 0 && allow.indexOf(sub) !== -1;
}`;

export const PATCH_MARKER = 'AC_ADMIN_SUBS';
export const ALLOWLIST_ENV = 'AC_ADMIN_SUBS';
const COGNITO_SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class HotfixRefused extends Error {
  constructor(message) { super(message); this.name = 'HotfixRefused'; }
}

/** Apply the patch to the source text of index.js. Line endings are preserved. */
export function patchSource(source) {
  const crlf = source.includes('\r\n');
  const text = crlf ? source.replace(/\r\n/g, '\n') : source;
  const count = text.split(ORIGINAL).length - 1;
  if (text.includes(REPLACEMENT)) throw new HotfixRefused('index.js is already patched.');
  if (count !== 1) throw new HotfixRefused(`Expected the original admin check exactly once in index.js, found ${count}. The deployed code differs from 13b7a50: review it by hand.`);
  const patched = text.replace(ORIGINAL, REPLACEMENT);
  return crlf ? patched.replace(/\n/g, '\r\n') : patched;
}

export function parseSubs(value) {
  const subs = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (subs.length === 0) throw new HotfixRefused('At least one admin sub is required; an empty allowlist locks every admin out.');
  for (const s of subs) if (!COGNITO_SUB.test(s)) throw new HotfixRefused(`"${s}" is not a Cognito sub (a lower-case UUID).`);
  return [...new Set(subs)];
}

/** Add the allowlist to the function's environment without dropping or changing any other variable. */
export function mergeEnvironment(currentVariables, subs) {
  return { ...(currentVariables || {}), [ALLOWLIST_ENV]: subs.join(',') };
}

/**
 * Decide whether the hotfix may run, from facts gathered before any change. Pure.
 * Returns the ordered steps, or throws HotfixRefused with the reason.
 */
export function planHotfix({ functionName, liveCodeSha256, expectedCodeSha256, originalZipCodeSha256, comparison, patchedHasMarker, subs }) {
  if (functionName !== 'whichpart-api') throw new HotfixRefused('The admin hotfix only applies to whichpart-api.');
  if (originalZipCodeSha256 !== expectedCodeSha256) throw new HotfixRefused('The original zip does not match the CodeSha256 recorded in the Phase 0 inventory.');
  if (liveCodeSha256 !== expectedCodeSha256) throw new HotfixRefused('The live function has changed since the Phase 0 inventory. Re-run the inventory before patching.');
  if (!comparison.equivalent || comparison.differing.join() !== 'index.js') throw new HotfixRefused('The patched zip must differ from the original in index.js only.');
  if (!patchedHasMarker) throw new HotfixRefused('The patched index.js does not contain the allowlist check.');
  if (!subs.length) throw new HotfixRefused('No admin subs given.');
  return [
    { step: 'PublishVersion', why: 'Snapshot of the current code and configuration, for reference.' },
    { step: 'UpdateFunctionConfiguration', why: `Add ${ALLOWLIST_ENV} (${subs.length} sub(s)); every other variable unchanged. The old code ignores it.` },
    { step: 'UpdateFunctionCode', why: 'Deploy the patched zip. Admin is now default-deny.' },
    { step: 'Verify', why: 'Live CodeSha256 equals the patched zip.' },
  ];
}
