'use strict';

/**
 * AC sign-in and sessions: Cognito login, logout and me, the session cookie, and the admin check every admin route uses.
 */
const acAuth = require('./ac-auth');
const {
  COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, AUTH_REGION, AC_AUTH, SESSION_COOKIE, LOGGED_IN_COOKIE,
} = require('./config.js');
const { log } = require('./log.js');
const { CORS, respond } = require('./http-io.js');
const { rateLimited } = require('./rate-limiting.js');

let _cognito = null;
function cognito() {
  if (!_cognito) {
    const { CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');
    _cognito = new CognitoIdentityProviderClient({ region: AUTH_REGION });
  }
  return _cognito;
}
function b64urlJson(seg) {
  try {
    const s = seg.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch { return {}; }
}
// Admin authorization: default-deny. Admin requires an access token issued by the AC pool for the
// AC client, carrying the AC admin group (ac-auth.js). Callers only pass tokens issued by
// AdminInitiateAuth or verified by Cognito GetUser. Tokens from any other pool never grant admin.
function isAdminFromAccessToken(accessToken) {
  return acAuth.isAcAdmin(accessToken, AC_AUTH);
}
function parseCookies(event) {
  const out = {};
  const arr = Array.isArray(event.cookies) ? event.cookies : [];
  const hdr = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const all = arr.concat(hdr ? hdr.split(/;\s*/) : []);
  for (const c of all) {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  }
  return out;
}
function setCookie(name, value, opts) {
  const o = opts || {};
  let s = name + '=' + value + '; Path=/; SameSite=Lax';
  if (o.httpOnly) s += '; HttpOnly';
  s += '; Secure';
  s += '; Max-Age=' + (o.maxAge != null ? o.maxAge : 28800); // 8h default
  return s;
}
function respondCookies(statusCode, obj, cookieList) {
  return { statusCode, headers: { ...CORS, 'cache-control': 'no-store' },
    cookies: cookieList || [], body: JSON.stringify(obj) };
}

async function authLogin(event) {
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) return respond(503, { error: 'Auth not configured' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'invalid JSON' }); }
  const email = (body.email || '').trim();
  const password = body.password || '';
  if (!email || !password) return respond(400, { error: 'Email and password are required' });
  const limitedLogin = await rateLimited('login', event, { email });
  if (limitedLogin) return limitedLogin;
  try {
    const { AdminInitiateAuthCommand } = require('@aws-sdk/client-cognito-identity-provider');
    const res = await cognito().send(new AdminInitiateAuthCommand({
      UserPoolId: COGNITO_USER_POOL_ID, ClientId: COGNITO_CLIENT_ID,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
    const auth = res.AuthenticationResult;
    // An invited user signs in for the first time on the AC sign-in page, where they set their own password.
    if (!auth && res.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      return respond(403, { error: 'Set your password on the Appliance Clinic sign-in page first', code: 'password_change_required' });
    }
    if (!auth || !auth.AccessToken || !acAuth.isAcAccessToken(auth.AccessToken, AC_AUTH)) return respond(401, { error: 'Invalid email or password' });
    const idClaims = auth.IdToken ? b64urlJson(String(auth.IdToken).split('.')[1] || '') : {};
    const user = { name: idClaims.name || idClaims.email || email, email: idClaims.email || email,
      isAdmin: isAdminFromAccessToken(auth.AccessToken) };
    const cookies = [
      setCookie(SESSION_COOKIE, auth.AccessToken, { httpOnly: true, maxAge: 28800 }),
      setCookie(LOGGED_IN_COOKIE, '1', { httpOnly: false, maxAge: 28800 }),
    ];
    return respondCookies(200, { user }, cookies);
  } catch (e) {
    // NotAuthorizedException / UserNotFoundException / etc -> generic 401 (never leak which).
    const name = e && e.name ? e.name : '';
    if (/NotAuthorized|UserNotFound|InvalidParameter|UserNotConfirmed|PasswordResetRequired/i.test(name)) {
      return respond(401, { error: 'Invalid email or password' });
    }
    log({ evt: 'whichpart-api', authError: name || String(e) });
    return respond(500, { error: 'Sign-in failed' });
  }
}

async function authMe(event) {
  const token = parseCookies(event)[SESSION_COOKIE];
  if (!token) return respond(200, { authenticated: false });
  // A cookie from before the AC pool (or from any other pool) is not a session: sign it out.
  if (!acAuth.isAcAccessToken(token, AC_AUTH)) {
    return respondCookies(200, { authenticated: false }, [
      setCookie(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }),
      setCookie(LOGGED_IN_COOKIE, '', { httpOnly: false, maxAge: 0 }),
    ]);
  }
  try {
    const { GetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
    const u = await cognito().send(new GetUserCommand({ AccessToken: token }));
    const attrs = {};
    for (const a of (u.UserAttributes || [])) attrs[a.Name] = a.Value;
    const user = { name: attrs.name || attrs.email || u.Username, email: attrs.email || '',
      isAdmin: isAdminFromAccessToken(token) };
    return respond(200, { authenticated: true, user });
  } catch {
    // expired/invalid token -> clear the indicator, report signed-out
    return respondCookies(200, { authenticated: false }, [setCookie(LOGGED_IN_COOKIE, '', { httpOnly: false, maxAge: 0 })]);
  }
}

async function authLogout(event) {
  const token = parseCookies(event)[SESSION_COOKIE];
  if (token) {
    try {
      const { GlobalSignOutCommand } = require('@aws-sdk/client-cognito-identity-provider');
      await cognito().send(new GlobalSignOutCommand({ AccessToken: token }));
    } catch { /* non-fatal; cookie clear below still signs the browser out */ }
  }
  return respondCookies(200, { ok: true }, [
    setCookie(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }),
    setCookie(LOGGED_IN_COOKIE, '', { httpOnly: false, maxAge: 0 }),
  ]);
}

// Verify the caller has a valid Cognito session. Returns the user or null (server-side gate).
let _sessionOverride = null;
function setSessionForTests(fn) { _sessionOverride = fn; }
async function requireSession(event) {
  if (_sessionOverride) return _sessionOverride(event);
  // One Cognito lookup per request: the Test-area route gate resolves the session before the
  // handler (which re-checks it), so reuse the result already resolved for this same event.
  if (event && typeof event === 'object' && event._sessionResolved) return event._session;
  const s = await resolveSession(event);
  if (event && typeof event === 'object') {
    // Non-enumerable so the session can never end up in a serialised event or log line.
    Object.defineProperty(event, '_session', { value: s, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(event, '_sessionResolved', { value: true, enumerable: false, configurable: true, writable: true });
  }
  return s;
}
async function resolveSession(event) {
  const token = parseCookies(event)[SESSION_COOKIE];
  if (!token || !acAuth.isAcAccessToken(token, AC_AUTH)) return null;
  try {
    const { GetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
    const u = await cognito().send(new GetUserCommand({ AccessToken: token }));
    const attrs = {};
    for (const a of (u.UserAttributes || [])) attrs[a.Name] = a.Value;
    return { username: u.Username, email: attrs.email || u.Username, isAdmin: isAdminFromAccessToken(token) };
  } catch { return null; }
}

function requireAdmin(event) {
  return requireSession(event).then((s) => {
    // Auth outcome for the admin request log (category only — never the session, token or cookie).
    if (event && typeof event === 'object') event._authCategory = !s ? 'unauthenticated' : (s.isAdmin ? 'admin' : 'forbidden');
    return (s && s.isAdmin) ? s : null;
  });
}

module.exports = { authLogin, authMe, authLogout, setSessionForTests, requireSession, requireAdmin };
