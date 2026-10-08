'use strict';

/**
 * Which Part API — anti-corruption / boundary layer.
 *
 * The Which Part UI depends solely on the retailer-neutral contract produced here
 * (Diagnosis / CandidateComponent / CanonicalPart / Offer[]). This boundary now calls the
 * Customer Diagnostic Orchestrator (ONE diagnostic API) instead of the RAG engine directly.
 * The orchestrator internally fans out to the Error-Code MCP and the Diagnostic RAG; the browser
 * never chooses between them and never sees downstream credentials.
 *
 *   Browser -> /api (this Lambda) -> Orchestrator /diagnose (bearer) -> MCP / RAG
 *
 * FIT INVARIANT preserved: a part is MODEL_CONFIRMED only when the customer's model was actually
 * resolved AND the part is model-specific (not brand-only) — otherwise VERIFY_FIT.
 * Downstream bearer tokens come from env only (never committed/logged/returned to the client).
 */

const ORCHESTRATOR_URL =
  process.env.ORCHESTRATOR_URL ||
  'https://ajpz33wv4yezh6g2ayv5ite3zu0ruviq.lambda-url.eu-west-1.on.aws/';
const ORCHESTRATOR_TOKEN = process.env.ORCHESTRATOR_TOKEN || '';
// The RAG engine is still used ONLY for the feedback side-channel (S3 writer). Not for diagnosis.
const ENGINE_URL =
  process.env.ENGINE_URL ||
  'https://3asx4cw2qs5ajsjkytdwffhhvy0ptnoz.lambda-url.eu-west-1.on.aws/';
const S4R_PRODUCT_BASE_URL =
  process.env.S4R_PRODUCT_BASE_URL || 'https://d1hrb3pgx61xww.cloudfront.net';
const CLIENT_ID = 'whichpart';
const ORCH_TIMEOUT_MS = Number(process.env.ORCH_TIMEOUT_MS) || 120000;
const MAX_MESSAGES = 12;

// ---- Cognito auth (Appliance Clinic's own user pool, AcAuthStack; ADR 0006) ---
// The customer UI header + admin console sign in against AC's Cognito pool (server-side
// ADMIN_USER_PASSWORD_AUTH, no client secret). The access token is set as an httpOnly cookie and
// NEVER exposed to browser JS. Only tokens issued by the AC pool for the AC client count as a
// session (ac-auth.js); admin authority is membership of the pool's admin group. This is the
// customer-boundary BFF, not a diagnostic backend: diagnosis behaviour below is untouched.
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';
const AUTH_REGION = process.env.AWS_REGION || 'eu-west-1';
const acAuth = require('./ac-auth');
const AC_AUTH = { region: AUTH_REGION, poolId: COGNITO_USER_POOL_ID, clientId: COGNITO_CLIENT_ID, adminGroup: process.env.AC_ADMIN_GROUP || 'admin' };
const SESSION_COOKIE = 'wp_session';       // httpOnly — holds the Cognito access token
const LOGGED_IN_COOKIE = 'wp_logged_in';   // non-httpOnly indicator (never a token)
const MCP_HEALTH_URL = process.env.MCP_HEALTH_URL || '';
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || '';
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

// ---- ApplianceClinic AI provider configuration (admin control plane) --------
// Persists routing/model config + the write-only OpenAI credential to Secrets
// Manager (the SAME ids the part-finder RAG engine reads at runtime). The key
// is never returned to the browser. All handlers are admin-guarded.
const crypto = require('crypto');
const aiConfig = require('./ai-config.js');
const settingsAdmin = require('./settings-admin.js');

// ---- ACQ-100 quality benchmark (admin control plane) ------------------------
// whichpart-api is the CONTROL PLANE: it enqueues runs, lists/reads them, sets
// cancel, and reports worker heartbeat — all from S3 (the learning bucket). The
// local worker daemon is the EXECUTION PLANE (it runs journeys against this same
// customer path). No API keys are ever stored in run records or returned.
const acqScoring = require('./benchmark/acq-scoring.js');
const acqCorpus = require('./benchmark/acq-corpus.js');
const acqGrade = require('./benchmark/acq-grade.js');
const acqJudge = require('./benchmark/acq-judge.js');
const { createStore: createAcqStore } = require('./benchmark/acq-store.js');
// GOLD v2 is the ACTIVE, recommended quality benchmark (semantic-first, judges
// the whole conversation with a critical-failure override, Jev as the fixed
// judge). ACQ-100 above remains as NON-AUTHORITATIVE legacy. The config endpoint
// labels both so no score is ever shown unlabelled.
const goldV2Version = require('./benchmark/gold-v2/version.js');

const LEARNING_BUCKET = process.env.LEARNING_BUCKET || 'whichpart-learning-800960611664';
const ACQ_JUDGE_MODEL = process.env.ACQ_JUDGE_MODEL || 'gpt-5.6-terra';

// Production transcript observability (anonymous, TTL-limited). Never on the
// customer-critical path: persist failures are logged and swallowed.
const transcripts = require('./transcripts');
const conversationState = require('./conversation-state');
const liveTest = require('./live-test.js');
const benchmarkAuth = require('./benchmark-auth.js');
// ---- rate limiting (Phase 7; rate-limit.js). RATE_LIMIT_MODE off|observe|enforce, counters in RATE_LIMIT_TABLE.
const rateLimit = require('./rate-limit.js');
let _rateStore = null;
function rateStore() {
  if (!_rateStore) _rateStore = rateLimit.dynamoStore(require('./ddb.js').dynamodb, process.env.RATE_LIMIT_TABLE || 'applianceclinic-rate-limits');
  return _rateStore;
}
function setRateLimitStoreForTests(store) { _rateStore = store; }
/** Count one request; returns a 429 response to send, or null to carry on. Logs counts and hashes only. */
async function rateLimited(kind, event, extra) {
  if (rateLimit.mode() === 'off') return null;
  const net = rateLimit.clientIp(event);
  const r = await rateLimit.check(kind, { ip: net.ip, source: net.source, ...(extra || {}) }, { store: rateStore() });
  // Observe mode logs every counted request (counts and header shape only); enforce mode only what is over or failing.
  if (r.mode === 'observe' || r.overLimit || r.error) {
    log({ evt: 'rate-limit', kind, mode: r.mode, limited: r.limited, overLimit: Boolean(r.overLimit), xffDepth: net.xffDepth,
      lastIsSource: net.lastIsSource, counts: r.counts, ...(r.error ? { error: r.error } : {}) });
  }
  if (!r.limited) return null;
  return { statusCode: 429, headers: { ...CORS, 'retry-after': String(r.retryAfter || 60), 'cache-control': 'no-store' },
    body: JSON.stringify({ error: 'Too many requests. Please wait a moment and try again.', code: 'rate_limited' }) };
}
let _benchmarkSecretsLoader = () => benchmarkAuth.loadSecrets();
function setBenchmarkDepsForTests({ secretsLoader } = {}) { _benchmarkSecretsLoader = secretsLoader || (() => benchmarkAuth.loadSecrets()); }
const canonicalAudit = require('./canonical-audit');
const stateTokenMod = require('./state-token');
const transcriptReview = require('./transcript-review');
let _transcriptStore = null;
let _transcriptReviewJudge = null;
function transcriptStore() {
  if (_transcriptStore) return _transcriptStore;
  try {
    _transcriptStore = transcripts.createDynamoStore();
  } catch (e) {
    log({ evt: 'transcript-store-init-failed', error: String(e && e.message || e) });
    _transcriptStore = transcripts.createMemoryStore();
  }
  return _transcriptStore;
}
function setTranscriptStore(store) { _transcriptStore = store; }
function setTranscriptReviewJudge(fn) { _transcriptReviewJudge = fn; }

async function runTranscriptReviewBatch(now) {
  return transcriptReview.runBatch({
    store: transcriptStore(),
    now: now || new Date(),
    log: log,
    callJudge: _transcriptReviewJudge || undefined,
  });
}

const recallStoreMod = require('./recalls/store');
const recallHttp = require('./recalls/http');
const recallIngest = require('./recalls/ingest');
let _recallStore = null;
function recallStore() {
  if (_recallStore) return _recallStore;
  try {
    _recallStore = recallStoreMod.createDynamoStore();
  } catch (e) {
    log({ evt: 'recall-store-init-failed', error: String(e && e.message || e) });
    _recallStore = recallStoreMod.createMemoryStore();
  }
  return _recallStore;
}
function setRecallStore(store) { _recallStore = store; }
const recallHandlers = recallHttp.createHandlers(recallStore, (opts) => recallIngest.run(Object.assign({ store: recallStore() }, opts)));
const recallAdminMod = require('./recalls/admin');
const recallAdmin = recallAdminMod.createAdmin(() => recallStore(), { publishSite: (store, nowIso, put, unlisted) => recallIngest.publishSite(store, nowIso, put, unlisted) });
// Recall notice decisions (Safety area): auth FIRST, actor from the session, expectedRevision required.
function recallAdminError(e) {
  const status = (e && e.status) || 500;
  const body = { error: (e && e.message) || 'Recall notice update failed', code: (e && e.code) || 'error' };
  if (e && e.extra) Object.assign(body, e.extra);
  if (status >= 500) log({ evt: 'recall-admin-failed', code: body.code, error: String(e && e.message || e).slice(0, 180) });
  return respond(status, body);
}
async function recallAdminRoute(event, method, allowed, run) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  if (allowed.indexOf(method) === -1) return respond(405, { error: allowed.join(' or ') + ' only' });
  let body = {};
  if (method !== 'GET' && event.body) {
    try { body = JSON.parse(event.body); } catch { return respond(400, { error: 'invalid JSON', code: 'json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(400, { error: 'invalid JSON', code: 'json' });
  }
  delete body.actor;
  body.actor = session.email || session.username || null;
  try { return respond(200, await run(body, queryParam(event, 'id'))); }
  catch (e) { return recallAdminError(e); }
}

async function persistTranscriptTurn(obs, messages, view, orch, rid, canonical) {
  if (!obs) return;
  await transcripts.persistSafely(transcriptStore(), () =>
    transcripts.persistTurn(transcriptStore(), obs, { messages, view, orch, requestId: rid, canonical: canonical || null }), log);
}
/** Idempotent duplicate answered from the cached view: mark the original transcript turn (nothing else changes). */
async function persistTranscriptReplay(obs) {
  if (!obs || !obs.clientTurnId) return;
  await transcripts.persistSafely(transcriptStore(), () => transcripts.persistReplay(transcriptStore(), obs), log);
}
/** canonical-audit/1 for the transcript (structured inputs only; never throws into the customer path). */
function canonicalTranscriptAudit(ctx, out, result, trace, error) {
  try { return canonicalAudit.buildCanonicalTranscriptAudit({ ctx, out, result, trace, error }); } catch (e) {
    log({ evt: 'canonical-audit-failed', error: String((e && e.message) || e).slice(0, 160) });
    return null;
  }
}
async function persistTranscriptEnd(obs) {
  if (!obs) return;
  await transcripts.persistSafely(transcriptStore(), () =>
    transcripts.persistEnd(transcriptStore(), obs), log);
}
let _s3 = null;
function s3client() {
  if (_s3) return _s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3 = new S3Client({ region: AUTH_REGION });
  return _s3;
}
async function _streamToString(stream) {
  if (!stream) return null;
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}
// Test hook: route the Test-area S3 document store (runs, library, reviews) to a fake.
let _acqS3Override = null;
function setAcqS3ForTests(fake) { _acqS3Override = fake || null; }
const acqS3 = {
  async getObject(key) {
    if (_acqS3Override) return _acqS3Override.getObject(key);
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try { const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key })); return await _streamToString(r.Body); }
    catch (e) { if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null; throw e; }
  },
  async putObject(key, body) { if (_acqS3Override) return _acqS3Override.putObject(key, body); const { PutObjectCommand } = require('@aws-sdk/client-s3'); await s3client().send(new PutObjectCommand({ Bucket: LEARNING_BUCKET, Key: key, Body: body, ContentType: 'application/json' })); },
  async list(prefix) {
    if (_acqS3Override) return _acqS3Override.list(prefix);
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const out = []; let token;
    do { const r = await s3client().send(new ListObjectsV2Command({ Bucket: LEARNING_BUCKET, Prefix: prefix, ContinuationToken: token })); for (const o of (r.Contents || [])) out.push(o.Key); token = r.IsTruncated ? r.NextContinuationToken : undefined; } while (token);
    return out;
  },
  // ETag read + conditional write (S3 If-Match / If-None-Match): the routing-override lease.
  async getWithEtag(key) {
    if (_acqS3Override) {
      if (_acqS3Override.getWithEtag) return _acqS3Override.getWithEtag(key);
      const body = await _acqS3Override.getObject(key);
      return body == null ? null : { body, etag: '"' + crypto.createHash('md5').update(String(body)).digest('hex') + '"' };
    }
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try { const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key })); return { body: await _streamToString(r.Body), etag: r.ETag || null }; }
    catch (e) { if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null; throw e; }
  },
  async putConditional(key, body, opts) {
    const pre = () => { const pe = new Error('precondition failed'); pe.code = 'precondition'; return pe; };
    if (_acqS3Override) {
      if (_acqS3Override.putConditional) return _acqS3Override.putConditional(key, body, opts);
      const cur = await acqS3.getWithEtag(key);
      if (opts && opts.ifNoneMatch && cur) throw pre();
      if (opts && opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) throw pre();
      return _acqS3Override.putObject(key, body);
    }
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const params = { Bucket: LEARNING_BUCKET, Key: key, Body: body, ContentType: 'application/json' };
    if (opts && opts.ifMatch) params.IfMatch = opts.ifMatch;
    if (opts && opts.ifNoneMatch) params.IfNoneMatch = opts.ifNoneMatch;
    try { await s3client().send(new PutObjectCommand(params)); }
    catch (e) {
      const st = e && e.$metadata && e.$metadata.httpStatusCode;
      if (st === 412 || st === 409 || (e && (e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict'))) throw pre();
      throw e;
    }
  },
};
const acqStore = createAcqStore({ s3: acqS3 });
// Batch routing override (benchmark/routing-override.js): the API reads its status, blocks Settings
// inference writes while a batch owns live routing, recovers orphans on its 15-minute schedule and
// applies admin conflict resolutions. The worker on the Private AI machine is the normal owner.
const { createRoutingOverride } = require('./benchmark/routing-override.js');
const routingOverride = createRoutingOverride({
  lockStore: { get: (k) => acqS3.getWithEtag(k), put: (k, body, opts) => acqS3.putConditional(k, body, opts) },
  loadDoc: () => aiConfig.loadConfigDocument(),
  saveDoc: (doc) => aiConfig.saveConfigDocument(doc),
  revisionOf: (doc) => settingsAdmin.configRevision(doc),
  log: (o) => log(o),
});
async function routingOverrideStatusSafe() {
  try { return await routingOverride.status(); } catch (e) { return { state: 'unknown', active: false, blocked: false, error: 'Routing override status could not be read.' }; }
}
async function recoverRoutingOverride(actor) {
  return routingOverride.recover({ getRun: (id) => acqStore.getRun(id), markRunLost: (id, note, ok) => acqStore.markRunLost(id, note, ok), actor });
}
const acqLibrary = require('./benchmark/acq-library.js');
const knowledgeInspect = require('./knowledge-inspect');
const mediaInspect = require('./media-inspect');
const mediaAdmin = require('./media-admin');
const knowledgeAdmin = require('./knowledge-admin');
const diagnosticsInspect = require('./diagnostics-inspect');
const errorCodesAdmin = require('./error-codes-admin');
const MCP_URL = process.env.MCP_URL || errorCodesAdmin.mcpBaseFromHealth(MCP_HEALTH_URL);
let _errorCodesClient = null;
let _errorCodesTestMode = false;
function errorCodeClient() {
  if (_errorCodesClient) return _errorCodesClient;
  _errorCodesClient = errorCodesAdmin.createClient({
    mcpUrl: MCP_URL,
    token: MCP_BEARER_TOKEN,
  });
  return _errorCodesClient;
}
function setErrorCodesClientForTests(client) {
  _errorCodesClient = client;
  _errorCodesTestMode = client != null;
}
function errorCodesHttpError(e) {
  const mapped = errorCodesAdmin.httpError(e);
  return respond(mapped.status, mapped.body);
}
let _mediaAdminStore = null;
let _overlayCache = { at: 0, state: null };
let _diagnosticsTestDeps = null;
function setDiagnosticsDepsForTests(deps) { _diagnosticsTestDeps = deps; }
let _settingsTestDeps = null;
function setSettingsDepsForTests(deps) { _settingsTestDeps = deps; }
function mediaAdminS3() {
  const isPrecondition = (e) => {
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    const name = e && (e.name || e.Code || e.code);
    return status === 412 || status === 409 || name === 'PreconditionFailed' || name === 'ConditionalRequestConflict';
  };
  return {
    getObject: (key) => acqS3.getObject(key),
    // state.json with its ETag, and ETag-conditional writes (optimistic concurrency on the whole document).
    async getState(key) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      try {
        const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key }));
        return { body: await _streamToString(r.Body), etag: r.ETag || null };
      } catch (e) {
        if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null;
        throw e;
      }
    },
    async putState(key, body, opts) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const params = { Bucket: LEARNING_BUCKET, Key: key, Body: body, ContentType: 'application/json' };
      if (opts && opts.ifMatch) params.IfMatch = opts.ifMatch;
      if (opts && opts.ifNoneMatch) params.IfNoneMatch = opts.ifNoneMatch;
      try {
        await s3client().send(new PutObjectCommand(params));
      } catch (e) {
        if (isPrecondition(e)) { const pe = new Error('precondition failed'); pe.code = 'precondition'; throw pe; }
        throw e;
      }
    },
    async putObject(key, body) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3client().send(new PutObjectCommand({
        Bucket: LEARNING_BUCKET, Key: key, Body: body,
        ContentType: Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      }));
    },
    async putBinary(key, buf, contentType) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await s3client().send(new PutObjectCommand({
        Bucket: LEARNING_BUCKET, Key: key, Body: buf,
        ContentType: contentType || 'application/octet-stream',
      }));
    },
  };
}
function webMediaPut() {
  const bucket = process.env.WHICHPART_WEB_BUCKET || 'whichpart-web-800960611664';
  return {
    async putPublicMedia(fileName, buf, contentType) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const name = String(fileName || '').replace(/^\/+/, '');
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('unsafe-filename');
      await s3client().send(new PutObjectCommand({
        Bucket: bucket, Key: 'media/' + name, Body: buf,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: 'max-age=300, must-revalidate',
      }));
    },
  };
}
function mediaStore() {
  if (_mediaAdminStore) return _mediaAdminStore;
  _mediaAdminStore = mediaAdmin.createStore({ s3: mediaAdminS3(), web: webMediaPut() });
  return _mediaAdminStore;
}
function setMediaAdminStore(store) {
  _mediaAdminStore = store;
  _overlayCache = { at: 0, state: null };
}
async function loadOverlayCached() {
  const now = Date.now();
  const ttl = 10000;
  if (_overlayCache.state && (now - _overlayCache.at) < ttl) return _overlayCache.state;
  try {
    const state = await mediaStore().loadState();
    _overlayCache = { at: now, state, failed: false };
    return state;
  } catch (e) {
    log({ evt: 'media-overlay-load-failed', error: String(e && e.message || e) });
    if (_overlayCache.state) {
      _overlayCache.at = now;
      _overlayCache.failed = true;
      return _overlayCache.state;
    }
    return mediaAdmin.emptyState();
  }
}
function mediaAdminError(e) {
  const status = (e && e.status) || (e && e.code === 'not_found' ? 404 : 400);
  const body = { error: (e && e.message) || 'Media management failed', code: e && e.code };
  if (e && e.extra) body.extra = e.extra;
  return respond(status, body);
}
// ---- Knowledge management (drafts / publish / versions / rollback / archive) ----------------
// Store: LEARNING_BUCKET knowledge-admin/ (see knowledge-admin.js). Every S3 write is conditional.
function knowledgeAdminS3() {
  const isPrecondition = (e) => {
    const status = e && e.$metadata && e.$metadata.httpStatusCode;
    const name = e && (e.name || e.Code || e.code);
    return status === 412 || status === 409 || name === 'PreconditionFailed' || name === 'ConditionalRequestConflict';
  };
  return {
    async get(key) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      try {
        const r = await s3client().send(new GetObjectCommand({ Bucket: LEARNING_BUCKET, Key: key }));
        return { body: await _streamToString(r.Body), etag: r.ETag || null };
      } catch (e) {
        if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) return null;
        throw e;
      }
    },
    async put(key, body, opts) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const params = { Bucket: LEARNING_BUCKET, Key: key, Body: body, ContentType: 'application/json' };
      if (opts && opts.ifMatch) params.IfMatch = opts.ifMatch;
      if (opts && opts.ifNoneMatch) params.IfNoneMatch = opts.ifNoneMatch;
      try {
        const r = await s3client().send(new PutObjectCommand(params));
        return { etag: r.ETag || null };
      } catch (e) {
        if (isPrecondition(e)) { const pe = new Error('precondition failed'); pe.code = 'precondition'; throw pe; }
        throw e;
      }
    },
    async del(key) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3client().send(new DeleteObjectCommand({ Bucket: LEARNING_BUCKET, Key: key }));
    },
  };
}
// Same embedding endpoint + model family part-finder uses for queries and the offline index build.
async function knowledgeEmbed(text, model) {
  const base = String(process.env.EMBED_URL || process.env.LM_STUDIO_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('embedding endpoint not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(base + '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('embed ' + r.status);
    const data = await r.json();
    return data && data.data && data.data[0] && data.data[0].embedding;
  } finally { clearTimeout(timer); }
}
async function knowledgeEngineHealth() {
  const h = await fetchHealth(ENGINE_URL.replace(/\/$/, '') + '/health', 5000);
  return h && h.json;
}
let _knowledgeAdminStore = null;
function knowledgeStore() {
  if (_knowledgeAdminStore) return _knowledgeAdminStore;
  _knowledgeAdminStore = knowledgeAdmin.createStore({
    s3: knowledgeAdminS3(), embed: knowledgeEmbed, engineHealth: knowledgeEngineHealth, log,
  });
  return _knowledgeAdminStore;
}
function setKnowledgeAdminStore(store) { _knowledgeAdminStore = store; }
// Refresh the overlay/draft view knowledge-inspect merges into list/detail (and Media's picker).
async function refreshKnowledgeView() {
  await refreshKnowledgeMediaView();
  try {
    knowledgeInspect.setAdminView(await knowledgeStore().inspectView());
    return { ok: true, mediaUnavailable: _knowledgeMediaUnavailable || undefined };
  } catch (e) {
    log({ evt: 'knowledge-view-refresh-failed', error: String(e && e.message || e) });
    return { ok: false, mediaUnavailable: _knowledgeMediaUnavailable || undefined };
  }
}
// Knowledge Admin shows EFFECTIVE Media (shipped join + Media overlay, merged exactly as live diagnosis
// merges it). Read through the same 10 s overlay cache the customer boundary uses. Outside Lambda the
// overlay is only read from an injected store (tests / harness) or with MEDIA_OVERLAY_LIVE=1, so unit
// tests never touch production S3.
let _knowledgeMediaUnavailable = false;
async function refreshKnowledgeMediaView() {
  const live = _mediaAdminStore || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.MEDIA_OVERLAY_LIVE === '1';
  if (!live) { knowledgeInspect.setMediaView(null); _knowledgeMediaUnavailable = false; return; }
  const overlay = await loadOverlayCached();
  _knowledgeMediaUnavailable = Boolean(_overlayCache.failed || !_overlayCache.state);
  knowledgeInspect.setMediaView(mediaInspect.knowledgeMediaView(overlay));
}
function knowledgeAdminError(e) {
  const status = (e && e.status) || 500;
  const body = { error: (e && e.message) || 'Knowledge management failed', code: (e && e.code) || 'error' };
  if (e && e.extra) Object.assign(body, e.extra);
  if (status >= 500) log({ evt: 'knowledge-admin-failed', code: body.code, error: body.error });
  return respond(status, body);
}

async function parseJsonBody(event) {
  try { return JSON.parse(event.body || '{}'); }
  catch { const e = mediaAdmin.err('json', 'invalid JSON'); throw e; }
}

const acqLib = acqLibrary.createLibrary({ s3: acqS3 });
// Engineer transcript reviews — human annotation stored under acq/reviews/ (same
// bucket/prefix/IAM as runs). Deliberately separate from run scores + scenario gold.
const { createReviewStore } = require('./benchmark/acq-reviews.js');
const acqReviews = createReviewStore({ s3: acqS3 });

/** "Private AI → Private AI" / "Frontier → Private AI" from a run's candidate config. */
function providerPairLabel(config) {
  const lbl = (p) => (p && p.provider === 'openai') ? 'Frontier' : 'Private AI';
  return `${lbl(config && config.understand)} \u2192 ${lbl(config && config.compose)}`;
}
/** MACHINE verdict for a single journey result (mirrors the run-level classifyRun). */
function verdictForResult(r) {
  if (!r) return 'UNKNOWN';
  if ((r.hardViolations || []).length) return 'FAILED';
  if (!r.reachedOutcome) return 'NEEDS REVIEW';
  return 'GOOD';
}
/** Human-readable EXPECTED summary from the pinned scenario gold — only present fields. */
function summariseExpected(gold) {
  if (!gold) return null;
  const out = {};
  if (gold.expectedOutcome) out.outcome = gold.expectedOutcome;
  const comps = (gold.expectedComponents && gold.expectedComponents.length ? gold.expectedComponents : gold.goldSuspects) || [];
  if (comps.length) out.components = comps;
  if (gold.followUpTargetFact) out.shouldAsk = gold.followUpTargetFact;
  if (gold.mustSafetyStop) out.safety = 'Must trigger a safety stop';
  if (gold.mustNotPart) out.mustNotPart = true;
  if (gold.forbiddenOutcomes && gold.forbiddenOutcomes.length) out.mustNotDo = gold.forbiddenOutcomes;
  if (gold.idealTurns || gold.maxTurns) out.turns = { ideal: gold.idealTurns || null, max: gold.maxTurns || null };
  if (gold.expectMedia) out.expectMedia = true;
  return out;
}
/** Human-readable ACTUAL summary from the persisted per-journey result. */
function summariseActual(r) {
  if (!r) return null;
  const hv = r.hardViolations || [];
  const last = (r.transcript || [])[(r.transcript || []).length - 1] || {};
  const out = {
    reachedOutcome: !!r.reachedOutcome,
    turns: r.assistantTurns != null ? r.assistantTurns : (r.transcript || []).length,
    hardViolations: hv,
    safety: (hv.indexOf('FAILED_SAFETY_STOP') >= 0 || hv.indexOf('UNSAFE_ADVICE') >= 0) ? 'Safety issue' : 'No safety issue',
  };
  if (last.suggestedChecks && last.suggestedChecks.length) out.suggestedChecks = last.suggestedChecks;
  return out;
}

/** Ensure the library is seeded from the ACQ-100 corpus (idempotent). */
async function ensureLibrary() {
  const raw = acqCorpus.loadCorpus();
  return acqLib.ensureSeeded(raw.journeys);
}
/** Set of journeyIds that have ever participated in a persisted run (for safe-delete + detail). */
async function journeyRunUsage() {
  // Every persisted run counts as history (listRuns reads all run objects anyway; the cap only
  // trimmed the result). A scenario used by an older run must never be hard-deleted.
  const runs = await acqStore.listRuns(Number.MAX_SAFE_INTEGER);
  const used = new Set(); const recent = {};
  for (const r of runs) {
    const ids = (r.manifest && r.manifest.journeys) ? r.manifest.journeys.map((m) => m.journeyId) : [];
    for (const id of ids) { used.add(id); (recent[id] = recent[id] || []).push({ runId: r.runId, label: r.label, status: r.status, at: r.startedAt }); }
  }
  return { used, recent };
}
function acqBody(event) { try { return JSON.parse(event.body || '{}'); } catch { return null; } }

// ---- Test-area route gate + input hygiene ----
// Run ids are minted by acq-store (`acq-<iso>-<rand>`); scenario ids are short slugs (WM-001, VC-014).
// Both are used inside S3 object keys, so anything else is rejected before a store call.
const RUN_ID_RE = /^acq-[A-Za-z0-9-]{1,80}$/;
const JOURNEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEST_ADMIN_MAX_BODY = 64 * 1024;
const MAX_MANUAL_IDS = 200;
function isRunId(v) { return typeof v === 'string' && RUN_ID_RE.test(v); }
// 'new' is reserved for the Admin "#test/scenario/new" route.
function isJourneyId(v) { return typeof v === 'string' && JOURNEY_ID_RE.test(v) && v.toLowerCase() !== 'new'; }
function invalidId(what) { return respond(400, { error: 'invalid ' + what }); }
/**
 * Method check → admin auth → body cap → handler. Unsupported methods get 405 before any session
 * lookup; non-admin / missing sessions get 401 before any store access. Sets the admin-api log's
 * auth category (via requireAdmin) so these routes no longer log as "not-checked".
 */
async function testAdminRoute(event, method, handlers) {
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
  if (!handler) return respond(405, { error: Object.keys(handlers).join(' or ') + ' only' });
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  if (method !== 'GET' && String((event && event.body) || '').length > TEST_ADMIN_MAX_BODY) return respond(413, { error: 'request body too large' });
  try {
    return await handler(event);
  } catch (e) {
    // A store/network failure is a clean JSON 500 (never an unhandled Lambda error or a stack trace).
    log({ evt: 'test-admin-error', path: String(authPath(event) || '').split('?')[0].slice(0, 120), error: String((e && e.message) || e).slice(0, 160) });
    return respond(500, { error: 'The test service could not complete this request. Try again.' });
  }
}
/** Library writes carry an optional optimistic-concurrency precondition (the record's updatedAt). */
function libraryWriteError(e) {
  if (e && e.code === 'STALE') return respond(409, { error: 'STALE', message: 'This scenario changed since you opened it. Reload it, then make your change again.', updatedAt: e.updatedAt || null });
  if (e && e.code === 'NOT_FOUND') return respond(404, { error: 'not found' });
  return respond(400, { error: e.message, problems: (e && e.problems) || null });
}

/** While a routing-override CONFLICT is unresolved no new batch may be queued (they would wait forever). */
async function routingConflictResponse() {
  const ro = await routingOverrideStatusSafe();
  if (ro && ro.blocked) {
    return respond(409, { error: 'ROUTING_OVERRIDE_CONFLICT', message: 'Batch run ' + ro.runId + ' could not safely restore live AI routing. Resolve it in Test → Batch before starting another run.', routingOverride: ro });
  }
  return null;
}
/** POST /admin/benchmark/routing-override/resolve { runId, decision, note, expectedRevision } */
async function routingOverrideResolve(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = acqBody(event);
  if (!b || !isRunId(b.runId)) return invalidId('run id');
  if (b.decision !== 'keep-current' && b.decision !== 'restore-pre-run') return respond(400, { error: 'decision must be keep-current or restore-pre-run' });
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length < 5 || note.length > 300) return respond(400, { error: 'A reason of 5–300 characters is required.', details: ['note'] });
  if (b.expectedRevision != null && (typeof b.expectedRevision !== 'string' || !/^[0-9a-f]{16}$/.test(b.expectedRevision))) return respond(400, { error: 'expectedRevision is malformed' });
  const r = await routingOverride.resolve({ runId: b.runId, decision: b.decision, note, by: s.email || s.username || 'admin', expectedRevision: b.expectedRevision || null });
  if (!r.ok) {
    const st = r.code === 'not_found' ? 404 : (r.code === 'stale' ? 409 : 400);
    return respond(st, { error: r.code, message: r.code === 'stale' ? 'Live configuration changed since you reviewed it. Reload and review again.' : 'Could not resolve the routing override (' + r.code + ').', currentRevision: r.currentRevision || null });
  }
  log({ evt: 'settings-change', kind: 'batch-routing-resolution', by: s.email || s.username || 'admin', fields: ['routing-override'], runId: b.runId, decision: b.decision });
  return respond(200, { routingOverride: r.lock });
}
/** POST /admin/benchmark/routing-override/recover — run orphan recovery now (same rules as the schedule). */
async function routingOverrideRecover(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const r = await recoverRoutingOverride('admin:' + (s.email || s.username || 'admin'));
  return respond(200, { action: r.action, why: r.why || null, routingOverride: await routingOverrideStatusSafe() });
}

async function libraryImport(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  return respond(200, await ensureLibrary());
}

// ---- Question Library endpoints (admin) ----
async function libraryList(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  await ensureLibrary();
  const L = await acqLib.loadLibrary();
  const qs = (event && event.queryStringParameters) || {};
  const filters = { q: qs.q, family: qs.family, difficulty: qs.difficulty, category: qs.category, source: qs.source, reviewStatus: qs.reviewStatus,
    multiTurn: qs.multiTurn === 'true' ? true : qs.multiTurn === 'false' ? false : undefined,
    enabled: qs.enabled === 'true' ? true : qs.enabled === 'false' ? false : undefined,
    includeArchived: qs.includeArchived === 'true' };
  return respond(200, { metrics: acqLib.metrics(L), journeys: acqLib.listJourneys(L, filters), categories: acqLibrary.CATEGORIES, families: acqLibrary.FAMILIES, sourceTypes: acqLibrary.SOURCE_TYPES, reviewStates: acqLibrary.REVIEW_STATES });
}
async function libraryJourneyGet(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id'); if (!id) return respond(400, { error: 'id required' });
  if (!isJourneyId(id)) return invalidId('id');
  const j = await acqLib.getJourney(id); if (!j) return respond(404, { error: 'not found' });
  const { recent } = await journeyRunUsage();
  return respond(200, { journey: j, recentResults: recent[id] || [] });
}
async function libraryCreate(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = acqBody(event); if (!b || typeof b !== 'object' || Array.isArray(b)) return respond(400, { error: 'invalid JSON' });
  if (b.journeyId != null && !isJourneyId(b.journeyId)) return invalidId('journeyId');
  try { const rec = await acqLib.createJourney(b, s.email || s.username); return respond(200, rec); }
  catch (e) { return libraryWriteError(e); }
}
// Library writes take the client's last-seen `expectedUpdatedAt` (optional for older clients):
// a mismatch is a 409 so a stale editor never silently overwrites someone else's change.
function libraryWriteBody(event) {
  const b = acqBody(event);
  if (!b || typeof b !== 'object' || Array.isArray(b) || !b.id) return { error: respond(400, { error: 'id required' }) };
  if (!isJourneyId(b.id)) return { error: invalidId('id') };
  if (b.changes != null && (typeof b.changes !== 'object' || Array.isArray(b.changes))) return { error: respond(400, { error: 'changes must be an object' }) };
  if (b.expectedUpdatedAt != null && typeof b.expectedUpdatedAt !== 'string') return { error: respond(400, { error: 'expectedUpdatedAt must be a string' }) };
  return { body: b, opts: { expectedUpdatedAt: b.expectedUpdatedAt || null } };
}
async function libraryEdit(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const w = libraryWriteBody(event); if (w.error) return w.error;
  try { const rec = await acqLib.editJourney(w.body.id, w.body.changes || {}, s.email || s.username, w.opts); return respond(200, rec); }
  catch (e) { return libraryWriteError(e); }
}
async function libraryDuplicate(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = acqBody(event); if (!b || !b.id) return respond(400, { error: 'id required' });
  if (!isJourneyId(b.id)) return invalidId('id');
  if (b.overrides != null && (typeof b.overrides !== 'object' || Array.isArray(b.overrides))) return respond(400, { error: 'overrides must be an object' });
  if (b.overrides && b.overrides.journeyId != null && !isJourneyId(b.overrides.journeyId)) return invalidId('journeyId');
  try { const rec = await acqLib.duplicateJourney(b.id, b.overrides || {}, s.email || s.username); return respond(200, rec); }
  catch (e) { return libraryWriteError(e); }
}
async function libraryFlags(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const w = libraryWriteBody(event); if (w.error) return w.error;
  try { const rec = await acqLib.setFlags(w.body.id, w.body.changes || {}, s.email || s.username, w.opts); return respond(200, rec); }
  catch (e) { return libraryWriteError(e); }
}
async function libraryDelete(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const w = libraryWriteBody(event); if (w.error) return w.error;
  const { used } = await journeyRunUsage();
  try { const r = await acqLib.safeDelete(w.body.id, used.has(w.body.id), s.email || s.username, w.opts); return respond(200, r); }
  catch (e) { return libraryWriteError(e); }
}

// ---- Run Builder: build + enqueue (LOCAL default; FRONTIER gated) ----
function usesFrontier(u, c) { return (u && u.provider === 'openai') || (c && c.provider === 'openai'); }
async function benchmarkBuildRun(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = acqBody(event); if (!b || typeof b !== 'object' || Array.isArray(b)) return respond(400, { error: 'invalid JSON' });
  if (b.manualIds != null) {
    if (!Array.isArray(b.manualIds) || b.manualIds.length > MAX_MANUAL_IDS || !b.manualIds.every(isJourneyId)) return respond(400, { error: 'manualIds must be up to ' + MAX_MANUAL_IDS + ' scenario ids' });
  }
  await ensureLibrary();
  const [L, cfg, keyConfigured] = await Promise.all([acqLib.loadLibrary(), aiConfig.loadConfig(), aiConfig.isKeyConfigured()]);
  const understand = b.understand || { provider: 'lmstudio', model: '' };
  const compose = b.compose || { provider: 'lmstudio', model: '' };
  const judgeMode = b.judgeMode === 'DETERMINISTIC_ONLY' ? 'DETERMINISTIC_ONLY' : 'FULL';
  // FRONTIER gating (non-negotiable): experiment definition + explicit confirm.
  if (usesFrontier(understand, compose)) {
    if (!keyConfigured) return respond(400, { error: 'Frontier requires a saved OpenAI API key.' });
    if (!b.experiment || !b.experiment.name || !b.experiment.hypothesis) return respond(400, { error: 'FRONTIER_EXPERIMENT_REQUIRED', message: 'A frontier experiment needs a name and a hypothesis.' });
    if (b.confirmFrontier !== true) return respond(400, { error: 'FRONTIER_CONFIRMATION_REQUIRED', message: 'Explicit confirmation required to make paid frontier API calls.' });
  }
  const seed = (b.mode === 'RANDOM' || b.mode === 'BALANCED') ? (b.seed != null ? b.seed : (Date.now() % 1000000)) : null;
  const manifest = acqLibrary.buildManifest({ lib: L, mode: b.mode || 'BALANCED', n: b.n, filters: b.filters || {}, seed, manualIds: b.manualIds }, acqLib);
  if (!manifest.journeyCount) return respond(400, { error: 'No journeys selected (check filters/approved pool).' });
  const raw = acqCorpus.loadCorpus();
  const snapshot = {
    benchmarkVersion: acqScoring.ACQ_BENCHMARK_VERSION, scorerVersion: acqScoring.ACQ_SCORER_VERSION, pricingVersion: acqScoring.PRICING_VERSION,
    judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, promptHash: acqJudge.judgePromptHash(raw.journeys[0]), mode: judgeMode },
    understand, compose, manifest, experiment: b.experiment || null, judgeMode, journeyCount: manifest.journeyCount,
  };
  const blockedBy = await routingConflictResponse(); if (blockedBy) return blockedBy;
  const rec = await acqStore.enqueueRun(snapshot, { email: s.email || s.username, label: b.label });
  return respond(200, { runId: rec.runId, status: rec.status, label: rec.label, runMode: rec.runMode, journeyCount: manifest.journeyCount, seed });
}

async function benchmarkRerun(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = acqBody(event); if (!b || !b.id) return respond(400, { error: 'id required' });
  if (!isRunId(b.id)) return invalidId('run id');
  const src = await acqStore.getRun(b.id); if (!src) return respond(404, { error: 'source run not found' });
  const manifest = src.manifest || (src.journeyCount ? null : null);
  if (!manifest) return respond(400, { error: 'source run has no frozen manifest (legacy run) — cannot rerun exact set' });
  const understand = b.understand || src.config.understand;
  const compose = b.compose || src.config.compose;
  const judgeMode = b.judgeMode || src.judgeMode || 'FULL';
  const keyConfigured = await aiConfig.isKeyConfigured();
  if (usesFrontier(understand, compose)) {
    if (!keyConfigured) return respond(400, { error: 'Frontier requires a saved OpenAI API key.' });
    if (!b.experiment || !b.experiment.name || !b.experiment.hypothesis) return respond(400, { error: 'FRONTIER_EXPERIMENT_REQUIRED' });
    if (b.confirmFrontier !== true) return respond(400, { error: 'FRONTIER_CONFIRMATION_REQUIRED' });
  }
  const raw = acqCorpus.loadCorpus();
  const snapshot = {
    benchmarkVersion: src.benchmarkVersion, scorerVersion: acqScoring.ACQ_SCORER_VERSION, pricingVersion: acqScoring.PRICING_VERSION,
    judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, promptHash: acqJudge.judgePromptHash(raw.journeys[0]), mode: judgeMode },
    understand, compose, manifest, experiment: b.experiment || null, judgeMode, journeyCount: manifest.journeyCount,
  };
  const blockedBy = await routingConflictResponse(); if (blockedBy) return blockedBy;
  const rec = await acqStore.enqueueRun(snapshot, { email: s.email || s.username, label: b.label || (src.label + ' (rerun)') });
  return respond(200, { runId: rec.runId, status: rec.status, label: rec.label, journeyCount: manifest.journeyCount, sameQuestionsAs: src.runId });
}

async function benchmarkEstimate(event) {
  const s = await requireSession(event); if (!s || !s.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = acqBody(event) || {};
  await ensureLibrary();
  const L = await acqLib.loadLibrary();
  const seed = (b.mode === 'RANDOM' || b.mode === 'BALANCED') ? (b.seed != null ? b.seed : 0) : null;
  const manifest = acqLibrary.buildManifest({ lib: L, mode: b.mode || 'BALANCED', n: b.n, filters: b.filters || {}, seed, manualIds: b.manualIds }, acqLib);
  const resolved = acqLibrary.resolveManifest(L, manifest);
  const maxTurns = resolved.reduce((a, r) => a + ((r.gold && r.gold.maxTurns) || 4), 0);
  const understand = b.understand || { provider: 'lmstudio' }; const compose = b.compose || { provider: 'lmstudio' };
  const frontierStages = [understand.provider === 'openai' ? 'UNDERSTAND' : null, compose.provider === 'openai' ? 'COMPOSE' : null].filter(Boolean);
  return respond(200, {
    journeyCount: manifest.journeyCount, expectedMaxTurns: maxTurns, candidateFrontierStages: frontierStages,
    frontierExperiment: frontierStages.length > 0, judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, mode: b.judgeMode || 'FULL' },
    candidateApiCost: 'NOT AVAILABLE — TOKEN USAGE NOT EXPOSED AT CUSTOMER BOUNDARY',
    judgeApiNote: (b.judgeMode === 'DETERMINISTIC_ONLY') ? 'No judge calls (deterministic-only): subjective dimensions NOT JUDGED.' : 'Judge makes paid API calls per journey even for LOCAL/LOCAL runs.',
    seed,
  });
}

/** Map the saved ai-config into a candidate {understand,compose} provider/model pair. */
function acqCandidateFromConfig(cfg) {
  const local = { provider: 'lmstudio', model: cfg.local.model || '(loaded model)' };
  const frontier = { provider: 'openai', model: cfg.frontier.model || null };
  return {
    understand: cfg.routing.understand === 'frontier' ? frontier : local,
    compose: cfg.routing.compose === 'frontier' ? frontier : local,
  };
}

async function acqBenchmarkConfig(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const [cfg, keyConfigured, jevLoaded, worker] = await Promise.all([
    aiConfig.loadConfig(),
    aiConfig.isKeyConfigured(),
    aiConfig.loadJevWithStatus(),
    acqStore.workerStatus(),
  ]);
  const raw = acqCorpus.loadCorpus();
  const dist = acqCorpus.distribution(raw);
  return respond(200, {
    benchmarkVersion: acqScoring.ACQ_BENCHMARK_VERSION,
    // Authoritative labelling of which quality benchmark governs. GOLD v2 is the
    // active/recommended suite; ACQ-100 is retained only as legacy and must never
    // be presented as the current quality score.
    qualityBenchmark: {
      active: {
        id: goldV2Version.BENCHMARK,
        label: 'GOLD v2',
        status: 'active',
        recommended: true,
        judgeModel: goldV2Version.JUDGE_MODEL,
        judgePromptVersion: goldV2Version.JUDGE_PROMPT_VERSION,
        scenarioCount: 50,
        concurrency: goldV2Version.CONCURRENCY,
        passPolicy: `mean \u2265 ${goldV2Version.PASS_MIN}/4, safety \u2265 ${goldV2Version.SAFETY_MIN}/4, no critical failure`,
        run: 'node services/whichpart-api/benchmark/gold-v2/run-baseline.mjs',
        note: 'Semantic-first: judges the whole conversation on ten 0\u20134 dimensions with a critical-failure override.',
      },
      legacy: {
        id: acqScoring.ACQ_BENCHMARK_VERSION,
        label: 'ACQ-100',
        status: 'legacy',
        recommended: false,
        authoritative: false,
        note: 'Retained for history only. Not the current quality score.',
      },
    },
    journeyCount: dist.total,
    distribution: { byFamily: dist.byFamily, multiTurn: dist.multiTurn, singleTurn: dist.singleTurn },
    weights: acqScoring.WEIGHTS,
    candidate: acqCandidateFromConfig(cfg),
    judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, configured: keyConfigured, promptHash: acqJudge.judgePromptHash(raw.journeys[0]) },
    // Correctness-first, human labels for the THREE distinct AI identities (guards
    // against the quality reviewer/judge model masquerading as the local model).
    setup: aiConfig.describeSetup({
      cfg, judgeModel: ACQ_JUDGE_MODEL, keyConfigured,
      jevConfigured: Boolean(jevLoaded.public && jevLoaded.public.credentialConfigured),
    }),
    worker,
    // Who (if anyone) currently owns live AI routing, and the restore state. Secret-free.
    routingOverride: await routingOverrideStatusSafe(),
    concurrency: 1,
    tokenUsage: 'NOT AVAILABLE AT CUSTOMER BOUNDARY',
    apiCost: 'NOT AVAILABLE / NOT CONFIGURED',
  });
}

async function acqBenchmarkRun(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event) || {};
  const [cfg, keyConfigured] = await Promise.all([aiConfig.loadConfig(), aiConfig.isKeyConfigured()]);
  // Explicit config (for the 4-combo comparison) or the persisted admin config.
  const candidate = (body.understand && body.compose) ? { understand: body.understand, compose: body.compose } : acqCandidateFromConfig(cfg);
  // Refuse to enqueue a frontier candidate with no key (no silent fallback).
  const usesFrontier = candidate.understand.provider === 'openai' || candidate.compose.provider === 'openai';
  if (usesFrontier && !keyConfigured) return respond(400, { error: 'Frontier candidate requires a saved OpenAI API key.' });
  const raw = acqCorpus.loadCorpus();
  const snapshot = {
    benchmarkVersion: acqScoring.ACQ_BENCHMARK_VERSION,
    scorerVersion: acqScoring.ACQ_SCORER_VERSION,
    pricingVersion: acqScoring.PRICING_VERSION,
    judge: { provider: 'openai', model: ACQ_JUDGE_MODEL, promptHash: acqJudge.judgePromptHash(raw.journeys[0]) },
    understand: candidate.understand,
    compose: candidate.compose,
    journeyCount: raw.journeys.length,
  };
  const blockedBy = await routingConflictResponse(); if (blockedBy) return blockedBy;
  const rec = await acqStore.enqueueRun(snapshot, { email: session.email || session.username, label: body.label });
  return respond(200, { runId: rec.runId, status: rec.status, label: rec.label });
}

async function acqBenchmarkRuns(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const runs = await acqStore.listRuns(100);
  const worker = await acqStore.workerStatus();
  return respond(200, { runs, worker });
}

async function acqBenchmarkRunGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  if (!isRunId(id)) return invalidId('run id');
  const rec = await acqStore.getRun(id);
  if (!rec) return respond(404, { error: 'run not found' });
  return respond(200, rec);
}

async function acqBenchmarkCancel(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event) || {};
  if (!body.id) return respond(400, { error: 'id required' });
  if (!isRunId(body.id)) return invalidId('run id');
  const existing = await acqStore.getRun(body.id);
  if (!existing) return respond(404, { error: 'run not found' });
  const rec = await acqStore.requestCancel(body.id);
  return respond(200, { runId: rec.runId, status: rec.status, cancelRequested: rec.cancelRequested });
}

/**
 * GET /admin/benchmark/transcript?run=<runId>&journey=<journeyId>
 * Compose a human-readable conversation-review payload from EXISTING persisted
 * data: the run's per-journey result (transcript + scores) + the scenario gold
 * resolved at the VERSION the run pinned (never the current library version) +
 * the engineer review. Read-only; mutates nothing.
 */
async function acqTranscriptGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const runId = queryParam(event, 'run');
  const journeyId = queryParam(event, 'journey');
  if (!runId || !journeyId) return respond(400, { error: 'run and journey required' });
  if (!isRunId(runId) || !isJourneyId(journeyId)) return invalidId('run or journey');
  const rec = await acqStore.getRun(runId);
  if (!rec) return respond(404, { error: 'run not found' });
  const result = (rec.results || []).find((r) => r.journeyId === journeyId);
  if (!result) return respond(404, { error: 'no conversation for that scenario in this run' });
  // Authoritative pinned version: the run's frozen manifest. Fall back to the
  // version stamped on the result. NEVER silently use the current library version.
  const manEntry = ((rec.manifest && rec.manifest.journeys) || []).find((m) => m.journeyId === journeyId);
  const pinnedVersion = manEntry ? manEntry.version : (result.journeyVersion != null ? result.journeyVersion : null);
  let expected = null; let scenarioTitle = journeyId;
  await ensureLibrary();
  const journey = await acqLib.getJourney(journeyId);
  if (journey) {
    scenarioTitle = journey.title || journeyId;
    const resolveTo = pinnedVersion == null ? journey.currentVersion : pinnedVersion;
    const resolved = acqLibrary.resolveVersion(journey, resolveTo);
    if (resolved && resolved.gold) expected = summariseExpected(resolved.gold);
  }
  const review = (await acqReviews.getReview(runId, journeyId)) || { runId, journeyId, state: 'not_reviewed', note: '', reviewer: null, reviewedAt: null };
  return respond(200, {
    runId, journeyId,
    provenance: {
      scenarioId: journeyId,
      scenarioTitle,
      journeyVersion: pinnedVersion,
      family: result.family || (journey && journey.family) || null,
      runLabel: rec.label || null,
      runDate: rec.completedAt || rec.startedAt || null,
      providerPair: providerPairLabel(rec.config),
      config: rec.config || null,
      judgeMode: rec.judgeMode || 'FULL',
      turns: result.assistantTurns != null ? result.assistantTurns : (result.transcript || []).length,
      totalElapsedMs: result.totalElapsedMs != null ? result.totalElapsedMs : null,
      runMode: rec.runMode || null,
    },
    transcript: result.transcript || [],
    expected,
    actual: summariseActual(result),
    result: {
      verdict: verdictForResult(result),
      quality: result.quality != null ? result.quality : null,
      judged: !!result.judged,
      dimensions: result.dimensions || {},
      notJudged: result.notJudged || [],
      hardViolations: result.hardViolations || [],
      reachedOutcome: !!result.reachedOutcome,
      turnsToOutcome: result.turnsToOutcome != null ? result.turnsToOutcome : null,
      latencyMs: result.totalElapsedMs != null ? result.totalElapsedMs : null,
      perTurnLatencyMs: result.perTurnLatencyMs || [],
    },
    review,
  });
}

/**
 * GET /admin/benchmark/scenario-conversations?journey=<journeyId>
 * All past conversations for one scenario across completed runs — each labelled
 * with the scenario VERSION that run pinned, the candidate config, the machine
 * verdict/quality and the engineer review state. Powers "Past conversations".
 */
async function acqScenarioConversations(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const journeyId = queryParam(event, 'journey');
  if (!journeyId) return respond(400, { error: 'journey required' });
  if (!isJourneyId(journeyId)) return invalidId('journey');
  const summaries = await acqStore.listRuns(200);
  const relevant = summaries.filter((r) => r.status === 'COMPLETED' && r.manifest && (r.manifest.journeys || []).some((m) => m.journeyId === journeyId));
  const conversations = [];
  for (const sm of relevant) {
    const rec = await acqStore.getRun(sm.runId);
    if (!rec) continue;
    const result = (rec.results || []).find((x) => x.journeyId === journeyId);
    if (!result) continue;
    const manEntry = (rec.manifest.journeys || []).find((m) => m.journeyId === journeyId);
    const review = await acqReviews.getReview(sm.runId, journeyId);
    conversations.push({
      runId: sm.runId,
      runLabel: rec.label || null,
      date: rec.completedAt || rec.startedAt || null,
      providerPair: providerPairLabel(rec.config),
      journeyVersion: manEntry ? manEntry.version : (result.journeyVersion != null ? result.journeyVersion : null),
      quality: result.quality != null ? result.quality : null,
      verdict: verdictForResult(result),
      reviewState: review ? review.state : 'not_reviewed',
    });
  }
  conversations.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return respond(200, { journeyId, conversations });
}

/** GET /admin/benchmark/reviews?run=<runId> — map of journeyId -> review for a run (badges + filter). */
async function acqReviewsForRun(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const runId = queryParam(event, 'run');
  if (!runId) return respond(400, { error: 'run required' });
  if (!isRunId(runId)) return invalidId('run');
  const reviews = await acqReviews.reviewsForRun(runId);
  return respond(200, { runId, reviews });
}

/** GET /admin/benchmark/review?run=&journey= — the engineer review (default not_reviewed). */
async function acqReviewGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const runId = queryParam(event, 'run');
  const journeyId = queryParam(event, 'journey');
  if (!runId || !journeyId) return respond(400, { error: 'run and journey required' });
  if (!isRunId(runId) || !isJourneyId(journeyId)) return invalidId('run or journey');
  const review = await acqReviews.getReview(runId, journeyId);
  return respond(200, review || { runId, journeyId, state: 'not_reviewed', note: '', reviewer: null, reviewedAt: null });
}

/**
 * POST /admin/benchmark/review { run, journey, state, note }
 * Persist a HUMAN review. Validates state. Writes ONLY to acq/reviews/ — never
 * to the run record (score) or the library (gold). Enriches with scenario
 * version + family (read from the run) for future-RAG provenance.
 */
async function acqReviewSave(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const b = acqBody(event);
  if (!b || !b.run || !b.journey) return respond(400, { error: 'run and journey required' });
  if (!isRunId(b.run) || !isJourneyId(b.journey)) return invalidId('run or journey');
  if (b.note != null && (typeof b.note !== 'string' || b.note.length > 4000)) return respond(400, { error: 'note must be text up to 4000 characters' });
  if (!acqReviews.isValidState(b.state)) return respond(400, { error: 'invalid review state', allowed: acqReviews.REVIEW_STATES });
  let journeyVersion = null; let family = null;
  const rec = await acqStore.getRun(b.run);
  if (rec) {
    const manEntry = ((rec.manifest && rec.manifest.journeys) || []).find((m) => m.journeyId === b.journey);
    const result = (rec.results || []).find((x) => x.journeyId === b.journey);
    journeyVersion = manEntry ? manEntry.version : (result && result.journeyVersion != null ? result.journeyVersion : null);
    family = result ? result.family : null;
  }
  try {
    const saved = await acqReviews.putReview({
      runId: b.run, journeyId: b.journey, scenarioId: b.journey, journeyVersion, family,
      state: b.state, note: b.note, reviewer: session.email || session.username,
    });
    return respond(200, saved);
  } catch (e) { return respond(400, { error: e.message }); }
}

async function acqBenchmarkCompare(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const a = queryParam(event, 'a'); const b = queryParam(event, 'b');
  if (!a || !b) return respond(400, { error: 'a and b run ids required' });
  if (!isRunId(a) || !isRunId(b)) return invalidId('run id');
  const [ra, rb] = await Promise.all([acqStore.getRun(a), acqStore.getRun(b)]);
  if (!ra || !rb || !ra.aggregate || !rb.aggregate) return respond(404, { error: 'both runs must exist and be complete' });
  const comparison = acqGrade.compareRuns(ra.aggregate, rb.aggregate);
  // Per-journey diff: quality + turns + questions per journeyId across both runs.
  const byId = (rec) => { const m = {}; for (const r of (rec.results || [])) m[r.journeyId] = r; return m; };
  const ma = byId(ra); const mb = byId(rb);
  const perJourney = [];
  for (const id of Object.keys(ma)) {
    const x = ma[id]; const y = mb[id]; if (!y) continue;
    perJourney.push({
      journeyId: id, family: x.family,
      a: { quality: x.quality, turns: x.assistantTurns, asked: x.clarifications, reached: x.reachedOutcome, hard: (x.hardViolations || []).length },
      b: { quality: y.quality, turns: y.assistantTurns, asked: y.clarifications, reached: y.reachedOutcome, hard: (y.hardViolations || []).length },
      qualityDelta: Math.round(((y.quality || 0) - (x.quality || 0)) * 10) / 10,
      note: diffNote(x, y),
    });
  }
  perJourney.sort((p, q) => Math.abs(q.qualityDelta) - Math.abs(p.qualityDelta));
  // Like-for-like safeguard: compare the frozen manifests. If the question sets
  // (or versions) differ, warn and compute a common-journey comparison using
  // only identical journeyId@version pairs.
  let manifestSafety = { identical: true, warning: null, commonCount: null, versionMismatches: [] };
  if (ra.manifest && rb.manifest) {
    const diff = acqLibrary.manifestDiff(ra.manifest, rb.manifest);
    manifestSafety = {
      identical: diff.identical, commonCount: diff.commonCount, aCount: diff.aCount, bCount: diff.bCount,
      versionMismatches: diff.versionMismatches,
      warning: diff.identical ? null : 'QUESTION SETS DIFFER — overall scores are not a clean A/B comparison. Use the common-journey comparison.',
    };
    if (!diff.identical) {
      const commonIds = new Set(diff.commonKeys.map((k) => k.split('@')[0]));
      const commonPerJourney = perJourney.filter((p) => commonIds.has(p.journeyId));
      manifestSafety.commonPerJourney = commonPerJourney;
      manifestSafety.commonMeanQualityDelta = commonPerJourney.length ? Math.round((commonPerJourney.reduce((a, p) => a + p.qualityDelta, 0) / commonPerJourney.length) * 10) / 10 : null;
    }
  } else {
    manifestSafety = { identical: false, warning: 'One or both runs are legacy (no frozen manifest) — not a version-pinned comparison.', commonCount: null, versionMismatches: [] };
  }
  return respond(200, { a: { runId: ra.runId, label: ra.label, config: ra.config, aggregate: ra.aggregate, judgeMode: ra.judgeMode, runMode: ra.runMode }, b: { runId: rb.runId, label: rb.label, config: rb.config, aggregate: rb.aggregate, judgeMode: rb.judgeMode, runMode: rb.runMode }, comparison, perJourney, manifestSafety });
}
function diffNote(x, y) {
  if (x.reachedOutcome && !y.reachedOutcome) return 'A correct, B wrong';
  if (!x.reachedOutcome && y.reachedOutcome) return 'B correct, A wrong';
  if ((y.clarifications || 0) > (x.clarifications || 0)) return 'B asked more questions';
  if ((y.clarifications || 0) < (x.clarifications || 0)) return 'B asked fewer questions';
  return '';
}
function queryParam(event, name) {
  const qs = (event && event.queryStringParameters) || {};
  if (qs[name] != null) return qs[name];
  const raw = (event && event.rawQueryString) || '';
  const m = new RegExp('(?:^|&)' + name + '=([^&]*)').exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

function readJson(event) {
  try { return JSON.parse(event.body || '{}'); } catch { return null; }
}

const SETTINGS_MAX_BODY = 16 * 1024;
async function settingsAdminRoute(event, method, handlers) {
  const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
  if (!handler) return respond(405, { error: Object.keys(handlers).join(' or ') + ' only' });
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  if (method !== 'GET' && String((event && event.body) || '').length > SETTINGS_MAX_BODY) return respond(413, { error: 'request body too large' });
  try {
    return await handler(event);
  } catch (e) {
    // Never echo the error: secrets-store errors can quote the request.
    log({ evt: 'settings-admin-error', path: String(authPath(event) || '').split('?')[0].slice(0, 120), error: String((e && e.name) || 'Error').slice(0, 60) });
    return respond(500, { error: 'The settings service could not complete this request. Reload to confirm the current values.' });
  }
}
/** One concise audit line per applied Settings change: actor, fields, revision. No secret values. */
function settingsChangeLog(kind, session, apply) {
  try {
    log({ evt: 'settings-change', kind, by: (session && (session.email || session.username)) || 'admin',
      fields: kind === 'jev' ? ['jev.credential'] : ((apply && apply.changed) || []).map((c) => c.field), version: apply && apply.version, revision: apply && apply.revision,
      verified: apply ? apply.verified : undefined });
  } catch { /* logging never affects the response */ }
}
async function aiConfigGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const [cfg, keyConfigured, jevLoaded] = await Promise.all([
    aiConfig.loadConfig(),
    aiConfig.isKeyConfigured(),
    aiConfig.loadJevWithStatus(),
  ]);
  // Settings consumes the SAME anti-masquerade `setup` the Test ApplianceClinic
  // page uses, so the "What's running right now" panel can never surface the
  // judge/frontier model as the Private AI model. UNDERSTAND is TypeSafe Jev.
  return respond(200, Object.assign({}, aiConfig.toClientView(cfg, keyConfigured), {
    setup: aiConfig.describeSetup({
      cfg,
      judgeModel: ACQ_JUDGE_MODEL,
      keyConfigured,
      jevConfigured: Boolean(jevLoaded.public && jevLoaded.public.credentialConfigured),
    }),
  }));
}

async function aiConfigSaveKey(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event);
  if (body === null) return respond(400, { error: 'invalid JSON' });
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  // A blank value must NOT delete the existing secret — deletion is a separate,
  // deliberate action. Reject and keep whatever is stored.
  if (!apiKey) {
    return respond(400, { error: 'No API key provided. Leave blank to keep the existing key, or enter a new key to replace it.' });
  }
  if (apiKey.length > 400 || /\s/.test(apiKey)) return respond(400, { error: 'That does not look like an API key (no spaces, up to 400 characters).' });
  const saved = await aiConfig.saveKey(apiKey, session.email || session.username || 'admin');
  log({ evt: 'settings-change', kind: 'openai-credential', by: session.email || session.username || 'admin', fields: ['openai.credential'] });
  return respond(200, { configured: true, updatedAt: saved.at }); // never echo the key
}

async function aiConfigTestLocal(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const cfg = await aiConfig.loadConfig();
  // Same resolution order the runtime uses: saved override -> the deployed default (LM_STUDIO_URL).
  // The request body is ignored: a connection check never targets a caller-supplied address.
  const endpoint = String(cfg.local.endpoint || process.env.LM_STUDIO_URL || '').trim();
  const model = String(cfg.local.model || '').trim();
  if (!endpoint) {
    return respond(200, { status: 'CONFIG_ERROR', detail: 'No private AI address is configured.', latencyMs: null });
  }
  const url = endpoint.replace(/\/$/, '') + '/v1/chat/completions';
  const result = await aiConfig.probeChat({ url, model: model || undefined, timeoutMs: 12000 });
  return respond(200, result);
}

async function aiConfigTestFrontier(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const [cfg, apiKey] = await Promise.all([aiConfig.loadConfig(), aiConfig.getKey()]);
  const model = String(cfg.frontier.model || '').trim();
  if (!apiKey) return respond(200, { status: 'CONFIG_ERROR', detail: 'No API key configured', latencyMs: null });
  if (!model) return respond(200, { status: 'MODEL_ERROR', detail: 'No model configured', latencyMs: null });
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const result = await aiConfig.probeChat({
    url: base + '/chat/completions',
    headers: { Authorization: 'Bearer ' + apiKey },
    model,
    timeoutMs: 20000,
    openai: true,
  });
  // Read-only check. It used to write `lastFrontierTest` back into the live config (a stale
  // read-modify-write that could undo a concurrent routing change); nothing ever read that field.
  return respond(200, result);
}

async function aiConfigLocalModels(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const cfg = await aiConfig.loadConfig();
  const endpoint = String(cfg.local.endpoint || process.env.LM_STUDIO_URL || '').trim();
  return respond(200, await aiConfig.listLocalModels(endpoint));
}

async function aiConfigFrontierModels(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const key = await aiConfig.getKey();
  return respond(200, await aiConfig.listFrontierModels(key));
}

async function adminSettingsGet(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const testDeps = _settingsTestDeps || {};
  const view = await settingsAdmin.buildView({
    fetch: testDeps.fetch,
    partFinderHealthUrl: testDeps.partFinderHealthUrl !== undefined ? testDeps.partFinderHealthUrl : ENGINE_URL,
    timeoutMs: testDeps.timeoutMs || 5000,
    judgeModel: ACQ_JUDGE_MODEL,
    loadConfigWithStatus: testDeps.loadConfigWithStatus,
    isKeyConfigured: testDeps.isKeyConfigured,
    loadJevWithStatus: testDeps.loadJevWithStatus,
    runningModels: testDeps.runningModels,
    env: testDeps.env,
    transcriptPolicy: testDeps.transcriptPolicy,
    loadKeyMeta: testDeps.loadKeyMeta,
    canonical: diagnosticsCanonicalMode(),
    batchOverride: await routingOverrideStatusSafe(),
    getBatchOverride: routingOverrideStatusSafe,
  });
  return respond(200, view);
}

async function adminSettingsInferencePatch(event) {
  const SETTINGS_KIND = 'diagnostic-inference';
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event);
  if (body === null) return respond(400, { error: 'invalid JSON' });
  const testDeps = _settingsTestDeps || {};
  const result = await settingsAdmin.saveInferencePatch({
    body,
    byEmail: session.email || session.username || 'admin',
    fetch: testDeps.fetch,
    partFinderHealthUrl: testDeps.partFinderHealthUrl !== undefined ? testDeps.partFinderHealthUrl : ENGINE_URL,
    timeoutMs: testDeps.timeoutMs || 5000,
    judgeModel: ACQ_JUDGE_MODEL,
    loadConfigWithStatus: testDeps.loadConfigWithStatus,
    isKeyConfigured: testDeps.isKeyConfigured,
    loadJevWithStatus: testDeps.loadJevWithStatus,
    saveConfig: testDeps.saveConfig,
    runningModels: testDeps.runningModels,
    env: testDeps.env,
    transcriptPolicy: testDeps.transcriptPolicy,
    loadKeyMeta: testDeps.loadKeyMeta,
    canonical: diagnosticsCanonicalMode(),
    batchOverride: await routingOverrideStatusSafe(),
    getBatchOverride: routingOverrideStatusSafe,
  });
  if (!result.ok) {
    return respond(result.status || 400, {
      error: result.error,
      code: result.code || undefined,
      details: result.details || undefined,
      currentVersion: result.currentVersion,
      currentRevision: result.currentRevision,
    });
  }
  if (result.apply && result.apply.written) settingsChangeLog(SETTINGS_KIND, session, result.apply);
  return respond(200, Object.assign({}, result.view, { apply: result.apply || null }));
}

async function adminSettingsJevPatch(event) {
  const SETTINGS_KIND = 'jev';
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const body = readJson(event);
  if (body === null) return respond(400, { error: 'invalid JSON' });
  const testDeps = _settingsTestDeps || {};
  const result = await settingsAdmin.saveJevPatch({
    body,
    byEmail: session.email || session.username || 'admin',
    fetch: testDeps.fetch,
    partFinderHealthUrl: testDeps.partFinderHealthUrl !== undefined ? testDeps.partFinderHealthUrl : ENGINE_URL,
    timeoutMs: testDeps.timeoutMs || 5000,
    judgeModel: ACQ_JUDGE_MODEL,
    loadConfigWithStatus: testDeps.loadConfigWithStatus,
    isKeyConfigured: testDeps.isKeyConfigured,
    loadJevWithStatus: testDeps.loadJevWithStatus,
    saveJevStored: testDeps.saveJevStored,
    runningModels: testDeps.runningModels,
    env: testDeps.env,
    transcriptPolicy: testDeps.transcriptPolicy,
    loadKeyMeta: testDeps.loadKeyMeta,
    canonical: diagnosticsCanonicalMode(),
    batchOverride: await routingOverrideStatusSafe(),
    getBatchOverride: routingOverrideStatusSafe,
  });
  if (!result.ok) {
    return respond(result.status || 400, {
      error: result.error,
      code: result.code || undefined,
      details: result.details || undefined,
      currentVersion: result.currentVersion,
      currentRevision: result.currentRevision,
    });
  }
  if (result.apply && result.apply.written) settingsChangeLog(SETTINGS_KIND, session, result.apply);
  return respond(200, Object.assign({}, result.view, { apply: result.apply || null }));
}

async function adminSettingsJevTest(event) {
  const session = await requireSession(event);
  if (!session || !session.isAdmin) return respond(401, { error: 'Unauthorized' });
  const testDeps = _settingsTestDeps || {};
  const result = await settingsAdmin.testJevConnection({
    getJevCredentials: testDeps.getJevCredentials,
    probeJev: testDeps.probeJev,
    fetch: testDeps.fetch,
    timeoutMs: testDeps.jevTimeoutMs || 12000,
  });
  return respond(200, result);
}

async function fetchHealth(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { ok: r.ok, status: r.status, json };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { clearTimeout(timer); }
}

async function gatherHealthServices() {
  const orchUrl = ORCHESTRATOR_URL.replace(/\/$/, '') + '/health';
  const results = { whichpartApi: { ok: true, service: 'whichpart-api' } };
  const [orch, mcp] = await Promise.all([
    fetchHealth(orchUrl, 5000),
    MCP_HEALTH_URL ? fetchHealth(MCP_HEALTH_URL, 5000) : Promise.resolve(null),
  ]);
  results.orchestrator = orch.json ? { ok: orch.ok, ...orch.json } : { ok: false, error: orch.error || ('http ' + orch.status) };
  if (mcp) results.mcp = mcp.json ? { ok: mcp.ok, ...mcp.json } : { ok: false, error: mcp.error || ('http ' + mcp.status) };
  results.rag = { ok: !!(orch.json && orch.json.diagnosticRag), reportedBy: 'orchestrator',
    state: (orch.json && orch.json.diagnosticRag) || 'unknown' };
  return results;
}

// Admin dashboard health — SERVER-SIDE guarded (401 without a valid Cognito session). Aggregates
// only status/version data ALREADY exposed by the services; invents nothing.
async function adminHealth(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const results = await gatherHealthServices();
  // Best-effort activity overlay. A transcript-store failure must not fail health.
  try {
    results.activity = await transcriptStore().stats(new Date());
  } catch (e) {
    results.activity = { unavailable: true, error: 'transcript-store' };
    log({ evt: 'transcript-stats-failed', error: String(e && e.message || e) });
  }
  return respond(200, { ok: true, generatedAt: new Date().toISOString(), services: results,
    transcriptPolicy: transcripts.policy() });
}

async function adminDashboard(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const period = queryParam(event, 'period') || '7d';
  let services;
  try {
    services = await gatherHealthServices();
  } catch (e) {
    services = { whichpartApi: { ok: true, service: 'whichpart-api' }, orchestrator: { ok: false, error: String(e && e.message || e) }, rag: { ok: false, state: 'unknown' } };
  }
  let production;
  try {
    production = await transcriptReview.dashboardFromStore(transcriptStore(), { period: period, now: new Date() });
  } catch (e) {
    log({ evt: 'dashboard-summary-failed', error: String(e && e.message || e) });
    production = { unavailable: true, error: 'transcript-store' };
  }
  return respond(200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    health: transcriptReview.compactHealth(services),
    production: production,
    state: await dashboardState(services),
  });
}

/**
 * Dashboard "Production state": read-only facts from sources the BFF already reads elsewhere —
 * canonical mode (this Lambda's env), the stored AI routing (Settings' document), the batch routing
 * override lease, the Error Code MCP health already fetched above, the media overlay (cached loader the
 * customer path uses) and the recall site counts recorded by the last publish. Each part fails on its
 * own as { unavailable: true }; nothing here writes, and no secret or id is returned.
 */
async function dashboardState(services) {
  const part = async (fn) => { try { return await fn(); } catch (e) { return { unavailable: true }; } };
  const [routing, override, media, recalls] = await Promise.all([
    part(async () => {
      const cfg = await aiConfig.loadConfig();
      const frontier = cfg.routing && cfg.routing.compose === 'frontier';
      return { understand: 'TypeSafe Jev', compose: frontier ? 'OpenAI' : 'Private AI', composeModel: (frontier ? cfg.frontier && cfg.frontier.model : cfg.local && cfg.local.model) || null, version: cfg.version || 1 };
    }),
    part(async () => {
      const s = await routingOverrideStatusSafe();
      if (s && s.error) return { unavailable: true };
      return { active: Boolean(s && s.active), blocked: Boolean(s && s.blocked), state: (s && s.state) || 'none', runId: (s && (s.active || s.blocked) && s.runId) || null };
    }),
    part(async () => {
      const st = await loadOverlayCached();
      const n = st && st.identities ? Object.keys(st.identities).length : 0;
      return { overlay: n || (st && st.updatedAt) ? 'present' : 'absent', records: n, updatedAt: (st && st.updatedAt) || null };
    }),
    part(async () => {
      const m = await recallStore().getMeta();
      const site = (m && m.site) || {};
      return { listed: Number.isFinite(site.records) ? site.records : null, lastSuccessAt: (m && m.lastSuccessAt) || null };
    }),
  ]);
  const cm = conversationState.resolveMode();
  const mcp = services && services.mcp;
  return {
    canonical: { mode: cm.mode, journeys: (cm.journeys || []).length, demoted: Boolean(cm.demoted) },
    routing, override, media, recalls,
    errorCodes: mcp ? { ok: Boolean(mcp.ok), active: Number.isFinite(mcp.effectiveActiveCount) ? mcp.effectiveActiveCount : null, overlay: (mcp.overlay && mcp.overlay.state) || null } : { unavailable: true },
  };
}

function requireAdmin(event) {
  return requireSession(event).then((s) => {
    // Auth outcome for the admin request log (category only — never the session, token or cookie).
    if (event && typeof event === 'object') event._authCategory = !s ? 'unauthenticated' : (s.isAdmin ? 'admin' : 'forbidden');
    return (s && s.isAdmin) ? s : null;
  });
}

async function adminTranscriptList(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const qs = (event && event.queryStringParameters) || {};
  try {
    const page = await transcriptStore().list(qs, new Date());
    return respond(200, page);
  } catch (e) {
    log({ evt: 'transcript-list-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Transcript store unavailable' });
  }
}

async function adminTranscriptGet(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!transcripts.isValidSessionId(id || '')) return respond(400, { error: 'id required' });
  try {
    const rec = await transcriptStore().get(id);
    if (!rec) return respond(404, { error: 'not found' });
    return respond(200, transcripts.drillDown(rec, new Date()));
  } catch (e) {
    log({ evt: 'transcript-get-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Transcript store unavailable' });
  }
}

async function adminTranscriptStats(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  try {
    const stats = await transcriptStore().stats(new Date());
    return respond(200, { ...stats, policy: transcripts.policy() });
  } catch (e) {
    log({ evt: 'transcript-stats-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Transcript store unavailable' });
  }
}

async function adminTranscriptPolicy(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  return respond(200, transcripts.policy());
}

async function adminTranscriptReview(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod || 'GET';
  if (method !== 'POST') return respond(405, { error: 'POST only' });
  const id = queryParam(event, 'id');
  if (!transcripts.isValidSessionId(id || '')) return respond(400, { error: 'id required' });
  try {
    const result = await transcriptReview.reviewSession({
      store: transcriptStore(),
      sessionId: id,
      now: new Date(),
      manual: true,
      log: log,
      callJudge: _transcriptReviewJudge || undefined,
    });
    if (result.http) return respond(result.http, { error: result.reason, ok: false });
    const rec = await transcriptStore().get(id);
    if (!rec) return respond(404, { error: 'not found' });
    return respond(200, Object.assign(transcripts.drillDown(rec, new Date()), { reviewResult: result }));
  } catch (e) {
    log({ evt: 'transcript-review-manual-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Semantic review unavailable' });
  }
}

async function adminTranscriptQuality(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  try {
    const quality = await transcriptReview.qualityFromStore(transcriptStore(), new Date());
    return respond(200, quality);
  } catch (e) {
    log({ evt: 'transcript-quality-failed', error: String(e && e.message || e) });
    return respond(503, { error: 'Transcript store unavailable' });
  }
}

async function adminKnowledge(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const qs = (event && event.queryStringParameters) || {};
  const view = await refreshKnowledgeView();
  const list = knowledgeInspect.listKnowledge({ q: qs.q, family: qs.family });
  if (!view.ok) list.overlayUnavailable = true;
  if (view.mediaUnavailable) list.mediaOverlayUnavailable = true;
  const orchUrl = ORCHESTRATOR_URL.replace(/\/$/, '') + '/health';
  let rag = { state: 'unknown' };
  try {
    const orch = await fetchHealth(orchUrl, 5000);
    rag = { ok: !!(orch.json && orch.json.diagnosticRag),
      state: (orch.json && orch.json.diagnosticRag) || 'unknown',
      reportedBy: 'orchestrator',
      orchestratorVersion: (orch.json && orch.json.version) || null };
  } catch { /* keep unknown */ }
  return respond(200, Object.assign({}, list, {
    rag,
    helpHubs: transcripts.HELP_HUBS,
  }));
}

async function adminKnowledgeRecord(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  const view = await refreshKnowledgeView();
  const rec = knowledgeInspect.getKnowledge(id);
  if (!rec) return respond(404, { error: 'not found' });
  let admin = null;
  try { admin = await knowledgeStore().getView(id); } catch (e) { if (!e || e.status !== 404) admin = { unavailable: true }; }
  return respond(200, Object.assign({}, rec, { admin, overlayUnavailable: !view.ok || undefined, mediaOverlayUnavailable: view.mediaUnavailable }));
}
// Every Knowledge mutation: admin session required, JSON body, expectedRevision echoed back.
async function knowledgeMutation(event, fn) {
  const actor = await requireAdmin(event);
  if (!actor) return respond(401, { error: 'Unauthorized' });
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch { return respond(400, { error: 'invalid JSON', code: 'json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(400, { error: 'invalid JSON', code: 'json' });
  }
  const id = queryParam(event, 'id') || body.id || null;
  try {
    const out = await fn({ actor, body, id });
    await refreshKnowledgeView();
    return respond(200, out);
  } catch (e) { return knowledgeAdminError(e); }
}
function needId(id) { if (!id) throw knowledgeAdmin.err('validation', 'id required', 400); return id; }
async function adminKnowledgeDraft(event, method) {
  if (method === 'POST') {
    // POST without id = create a new record as a draft; POST ?id= = start a draft from the live content.
    return knowledgeMutation(event, ({ actor, body, id }) => id
      ? knowledgeStore().startDraft(id, body.expectedRevision, actor)
      : knowledgeStore().createDraft(body.content || body, actor, { createdFrom: body.createdFrom || null }));
  }
  if (method === 'PUT') {
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().saveDraft(needId(id), body.expectedRevision, body.content, actor));
  }
  if (method === 'DELETE') {
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().deleteDraft(needId(id),
      body.expectedRevision != null ? body.expectedRevision : queryParam(event, 'expectedRevision'), actor));
  }
  return respond(405, { error: 'POST, PUT or DELETE' });
}
async function adminKnowledgeVersions(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  const v = queryParam(event, 'v');
  try {
    if (v != null && v !== '') return respond(200, await knowledgeStore().getVersion(id, v));
    return respond(200, await knowledgeStore().listVersions(id));
  } catch (e) { return knowledgeAdminError(e); }
}

async function adminMedia(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const qs = (event && event.queryStringParameters) || {};
  try {
    const list = await mediaStore().inspectList({
      q: qs.q, family: qs.family, type: qs.type, usage: qs.usage,
    });
    return respond(200, Object.assign({}, list, { managed: true }));
  } catch (e) {
    log({ evt: 'media-list-overlay-failed', error: String(e && e.message || e) });
    return respond(200, Object.assign({}, mediaInspect.listMedia({
      q: qs.q, family: qs.family, type: qs.type, usage: qs.usage,
    }), { overlayUnavailable: true, managed: true }));
  }
}

async function adminMediaRecord(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  try {
    const rec = await mediaStore().inspectOne(id);
    if (!rec) return respond(404, { error: 'not found' });
    return respond(200, rec);
  } catch (e) {
    const rec = mediaInspect.getMedia(id);
    if (!rec) return mediaAdminError(e);
    return respond(200, Object.assign({}, rec, { overlayUnavailable: true }));
  }
}

// Media mutations: admin-only; the actor is stamped from the session (any client-supplied actor is dropped);
// every change to an existing item must carry the item revision it was made from (stale edits → 409).
function mediaActorBody(body, session) {
  const b = Object.assign({}, (body && typeof body === 'object' && !Array.isArray(body)) ? body : {});
  delete b.actor;
  b.actor = (session && (session.email || session.username)) || null;
  return b;
}
function mediaRevisionMissing(body) {
  return body.expectedRevision === undefined || body.expectedRevision === null || body.expectedRevision === '';
}
const MEDIA_REVISION_REQUIRED = { error: 'expectedRevision is required. Reload this media item and try again.', code: 'revision_required' };
async function mediaMutation(event, needsRevision, run) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (needsRevision && !id) return respond(400, { error: 'id required' });
  try {
    const body = mediaActorBody(await parseJsonBody(event), session);
    if (needsRevision && mediaRevisionMissing(body)) return respond(400, MEDIA_REVISION_REQUIRED);
    const rec = await run(mediaStore(), id, body);
    _overlayCache = { at: 0, state: null };
    return respond(200, rec);
  } catch (e) { return mediaAdminError(e); }
}

function adminMediaCreate(event) {
  return mediaMutation(event, false, (store, _id, body) => store.create(body));
}

function adminMediaPatch(event) {
  return mediaMutation(event, true, (store, id, body) => store.saveDraft(id, body,
    body.dataBase64 || body.fileName ? { fileName: body.fileName, dataBase64: body.dataBase64 } : null));
}

function adminMediaReplace(event) {
  return mediaMutation(event, true, (store, id, body) => store.replaceFile(id, body));
}

function adminMediaAction(event, action) {
  return mediaMutation(event, true, (store, id, body) => store[action](id, body));
}

async function adminMediaVersion(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  try {
    return respond(200, { version: await mediaStore().version(id, queryParam(event, 'v')) });
  } catch (e) { return mediaAdminError(e); }
}

function adminMediaMap(event, method) {
  return mediaMutation(event, true, (store, id, body) => {
    if (method === 'POST') return store.attachMapping(id, body);
    if (method === 'PATCH') return store.updateMapping(id, body.knowledgeId, body);
    return store.detachMapping(id, body.knowledgeId || queryParam(event, 'knowledgeId'), body);
  });
}

function adminMediaComponent(event, method) {
  return mediaMutation(event, true, (store, id, body) => (method === 'POST'
    ? store.attachComponent(id, body)
    : store.detachComponent(id, body.componentKey || queryParam(event, 'componentKey'), body)));
}

function adminMediaRetire(event) {
  return mediaMutation(event, true, (store, id, body) => store.retire(id, body));
}

function adminMediaRestore(event) {
  return mediaMutation(event, true, (store, id, body) => store.restore(id, body));
}

function adminMediaDelete(event) {
  return mediaMutation(event, true, (store, id, body) => store.hardDelete(id, body));
}

async function adminMediaPreview(event, method) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  try {
    if (method === 'POST') {
      const body = await parseJsonBody(event);
      const preview = await mediaStore().previewCreate(body);
      return respond(200, preview);
    }
    const id = queryParam(event, 'id');
    if (!id) return respond(400, { error: 'id required' });
    const rec = await mediaStore().inspectOne(id);
    if (!rec) return respond(404, { error: 'not found' });
    return respond(200, mediaStore().customerPreview(rec));
  } catch (e) { return mediaAdminError(e); }
}

async function adminMediaKnowledge(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  await refreshKnowledgeView();
  const qs = (event && event.queryStringParameters) || {};
  return respond(200, { records: mediaStore().knowledgePicker(qs.q || '') });
}

function diagnosticsCanonicalMode() {
  try {
    const r = conversationState.resolveMode();
    return {
      mode: r.mode,
      controlJourneyCount: Array.isArray(r.journeys) ? r.journeys.length : 0,
      demoted: !!r.demoted,
      invalid: !!r.invalid,
      unknownKeyCount: Array.isArray(r.unknown) ? r.unknown.length : 0,
    };
  } catch (e) {
    return { mode: 'unknown', controlJourneyCount: null, demoted: false, invalid: false, unknownKeyCount: null };
  }
}
async function adminDiagnostics(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const runtime = {
    maxConversationTurns: MAX_MESSAGES,
    orchestratorTimeoutMs: ORCH_TIMEOUT_MS,
    families: knowledgeInspect.FAMILIES,
    s4rProductBaseHost: diagnosticsInspect.hostOf(S4R_PRODUCT_BASE_URL),
    orchestratorHost: diagnosticsInspect.hostOf(ORCHESTRATOR_URL),
    mcpHealthHost: diagnosticsInspect.hostOf(MCP_HEALTH_URL),
    engineHost: diagnosticsInspect.hostOf(ENGINE_URL),
    // Read-only canonical conversation mode as THIS runtime resolves it (env-driven; no writes).
    canonical: diagnosticsCanonicalMode(),
  };
  const testDeps = _diagnosticsTestDeps || {};
  try {
    const snapshot = await diagnosticsInspect.collect({
      fetch: testDeps.fetch || fetch,
      timeoutMs: testDeps.timeoutMs || 5000,
      orchestratorHealthUrl: testDeps.orchestratorHealthUrl !== undefined
        ? testDeps.orchestratorHealthUrl
        : (ORCHESTRATOR_URL.replace(/\/$/, '') + '/health'),
      mcpHealthUrl: testDeps.mcpHealthUrl !== undefined ? testDeps.mcpHealthUrl : (MCP_HEALTH_URL || ''),
      partFinderHealthUrl: testDeps.partFinderHealthUrl !== undefined
        ? testDeps.partFinderHealthUrl
        : (ENGINE_URL.replace(/\/$/, '') + '/health'),
      knowledgeInspect,
      mediaInspect,
      emptyOverlay: mediaAdmin.emptyState(),
      loadOverlay: testDeps.loadOverlay || (async () => mediaStore().loadState()),
      loadModels: testDeps.loadModels || (async () => {
        const cfg = await aiConfig.loadConfig();
        const keyConfigured = await aiConfig.isKeyConfigured();
        const jevLoaded = await aiConfig.loadJevWithStatus();
        return aiConfig.describeSetup({
          cfg, judgeModel: ACQ_JUDGE_MODEL, keyConfigured,
          jevConfigured: Boolean(jevLoaded.public && jevLoaded.public.credentialConfigured),
        });
      }),
      runtime,
      now: testDeps.now || new Date(),
    });
    return respond(200, snapshot);
  } catch (e) {
    log({ evt: 'admin-diagnostics-failed', error: String(e && e.message || e) });
    return respond(200, diagnosticsInspect.failureSnapshot(e, runtime));
  }
}

async function adminErrorCodes(event) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod || 'GET';
  try {
    if (method === 'GET') {
      const cat = await errorCodeClient().list();
      const health = (!_errorCodesTestMode && MCP_HEALTH_URL) ? await fetchHealth(MCP_HEALTH_URL, 5000) : null;
      const h = (health && health.json) || {};
      return respond(200, Object.assign({}, cat, {
        datasetV1Hash: h.datasetV1Hash || null,
        enrichmentV1Hash: h.enrichmentV1Hash || null,
        service: h.service || cat.service || 'error-code-mcp',
        version: h.version || null,
        datasetVersion: h.datasetVersion || '1',
        mappingCount: h.mappingCount != null ? h.mappingCount : cat.sourceCodeRecordCount,
        note: (cat.terminology && cat.terminology.sourceCodeRecords) || '',
      }));
    }
    if (method === 'POST') {
      const body = await parseJsonBody(event);
      // Creates a DRAFT. Nothing is live until it is explicitly published.
      const rec = await errorCodeClient().create(errorCodesAdmin.withActor(body, session));
      return respond(201, rec);
    }
    return respond(405, { error: 'GET or POST' });
  } catch (e) { return errorCodesHttpError(e); }
}

async function adminErrorCodeRecord(event) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod || 'GET';
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  try {
    if (method === 'GET') {
      const preview = queryParam(event, 'preview');
      const rec = await errorCodeClient().item(id, preview === '1' || preview === 'true');
      return respond(200, rec);
    }
    if (method === 'PATCH') {
      // Saves a DRAFT (live diagnosis unchanged). expectedRevision is required.
      const body = await parseJsonBody(event);
      const rec = await errorCodeClient().patch(id, errorCodesAdmin.withActor(body, session));
      return respond(200, rec);
    }
    if (method === 'DELETE') {
      const body = event.body ? await parseJsonBody(event) : {};
      if (body.expectedRevision == null && queryParam(event, 'expectedRevision') != null) body.expectedRevision = queryParam(event, 'expectedRevision');
      const rec = await errorCodeClient().delete(id, errorCodesAdmin.withActor(body, session));
      return respond(200, rec);
    }
    return respond(405, { error: 'GET, PATCH or DELETE' });
  } catch (e) { return errorCodesHttpError(e); }
}

// Every Error Code mutation: Admin session required; the actor comes from that session.
async function adminErrorCodeAction(event, action) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  try {
    const body = event.body ? await parseJsonBody(event) : {};
    return respond(200, await errorCodeClient()[action](id, errorCodesAdmin.withActor(body, session)));
  } catch (e) { return errorCodesHttpError(e); }
}
function adminErrorCodeRetire(event) { return adminErrorCodeAction(event, 'retire'); }
function adminErrorCodeRestore(event) { return adminErrorCodeAction(event, 'restore'); }
async function adminErrorCodeVersion(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  const v = queryParam(event, 'v');
  if (!id || v == null || v === '') return respond(400, { error: 'id and v required' });
  try {
    return respond(200, await errorCodeClient().version(id, v));
  } catch (e) { return errorCodesHttpError(e); }
}

async function adminErrorCodePreview(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  try {
    const body = await parseJsonBody(event);
    return respond(200, await errorCodeClient().preview(body));
  } catch (e) { return errorCodesHttpError(e); }
}

function authPath(event) {
  return event.rawPath ||
    (event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    event.path || '/';
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

// ---- conversation transport (Story 3: STRUCTURAL only; Jev in the orchestrator owns meaning) --
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
  }
  return '';
}
function hasImage(content) {
  return Array.isArray(content) && content.some((p) => p && p.type === 'image_url');
}
function imageOf(content) {
  if (!Array.isArray(content)) return null;
  const p = content.find((x) => x && x.type === 'image_url' && x.image_url && x.image_url.url);
  return p ? p.image_url.url : null;
}
function deriveContext(messages) {
  // Story 3: STRUCTURAL transport only. The BFF assembles the conversation and forwards it; it does
  // NOT interpret customer meaning. Appliance family, symptom presence, model-vs-error-code and
  // answer/confirmation semantics are the orchestrator's single Jev UNDERSTAND (run before routing).
  const userTexts = messages.filter((m) => m && m.role === 'user').map((m) => textOf(m.content));
  const assistantTexts = messages.filter((m) => m && m.role === 'assistant').map((m) => textOf(m.content));
  // current-turn message = latest user text (or empty if only a photo was sent)
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  const message = lastUser ? textOf(lastUser.content) : '';
  const photoOnly = Boolean(lastUser && hasImage(lastUser.content) && !message.trim());
  // Latest-turn rating-plate image; carried forward (structural) if this turn has none, so the
  // RAG vision can still read a plate the customer sent on an earlier turn.
  let latestImage = lastUser ? imageOf(lastUser.content) : null;
  if (!latestImage) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user' && hasImage(m.content)) { latestImage = imageOf(m.content); break; }
    }
  }
  // STABLE per-conversation session key. The orchestrator holds deterministic ConversationState
  // keyed by this id and must be able to find it again on the NEXT turn, so the key has to be
  // stable across a conversation's turns (established facts persist) yet distinct per conversation
  // (state never bleeds between customers). The volatile per-request id used before (Date.now +
  // random, plus a hash of ALL user turns that itself changed as the thread grew) guaranteed a
  // store miss every turn, so the whole persistence/reconciliation layer never engaged. The caller
  // threads in the client's stable per-conversation id (observability.sessionId) when present; this
  // fallback — a deterministic fingerprint of the OPENING customer turn — covers clients that send
  // none (it is the only signal present from turn 1 and unchanged as the thread grows). Fallback
  // collisions are limited to warm-container lifetime AND an identical opening message with no
  // client session id; the production client always carries one, so this is an edge case.
  const openerKey = (userTexts.find((t) => (t || '').trim()) || '').trim();
  const sessionId = 'wp-' + hashStr(openerKey);
  // CLIENT-CARRIED CONTEXT: send the WHOLE accumulated conversation each turn so the single Jev
  // UNDERSTAND sees the full thread (retention/correction) with a stateless-per-request session.
  let conversationText = userTexts.map((t) => (t || '').trim()).filter(Boolean).join('. ');
  // When assistant turns are present, send a labelled transcript so a later "I don't know" is bound
  // to the question that was asked (structural transcript formatting; routing.customer_speech
  // strips advisor lines so they never become customer facts).
  if (assistantTexts.length) {
    const labelled = [];
    for (const m of messages) {
      if (!m) continue;
      const t = (textOf(m.content) || '').trim();
      if (!t) continue;
      if (m.role === 'user') labelled.push('Customer: ' + t.slice(0, 1200));
      else if (m.role === 'assistant') labelled.push('Advisor asked: ' + t.slice(0, 500));
    }
    if (labelled.length >= 2) conversationText = labelled.join('\n');
  }
  const turnIndex = Math.max(0, userTexts.length - 1);
  const latestMessage = message || '';
  return { message, conversationText, sessionId, photoOnly, latestImage, turnIndex, latestMessage };
}

function conversationWindow(list, cap) {
  const limit = cap || MAX_MESSAGES;
  const hist = Array.isArray(list) ? list : [];
  if (!hist.length) return [];
  let firstUser = -1;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] && hist[i].role === 'user') { firstUser = i; break; }
  }
  if (firstUser < 0) return [];
  let start = Math.max(0, hist.length - limit);
  if (start < firstUser) start = firstUser;
  if (hist[start] && hist[start].role !== 'user') {
    const opening = hist[firstUser];
    const tail = hist.slice(-(limit - 1)).filter((m) => m !== opening);
    return [opening, ...tail];
  }
  return hist.slice(start);
}

function sanitiseConversation(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const t = (textOf(m.content) || '').trim();
    if (!t) continue;
    const rec = {
      role: m.role,
      content: t.slice(0, m.role === 'assistant' ? 900 : 2000),
    };
    if (m.role === 'assistant' && Array.isArray(m.media) && m.media.length) {
      rec.media = m.media.slice(0, 4).map((item) => ({
        id: item && item.id ? String(item.id).slice(0, 80) : null,
        type: item && item.type ? String(item.type).slice(0, 20) : null,
        title: item && item.title ? String(item.title).slice(0, 160) : '',
        url: item && item.url ? String(item.url).slice(0, 400) : null,
        videoId: item && item.videoId ? String(item.videoId).slice(0, 40) : null,
      }));
    }
    if (m.role === 'assistant' && m.safetyInformation) {
      const shown = m.safetyInformation;
      const text = typeof shown === 'string' ? shown : shown.text;
      if (text) rec.safetyInformation = { text: String(text).slice(0, 900) };
    }
    out.push(rec);
  }
  return conversationWindow(out, MAX_MESSAGES);
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

// ---- handler -----------------------------------------------------------------
// Admin API request log: one concise line per /admin/* request — method, path (no query string),
// auth category (admin | unauthenticated | forbidden | not-checked), status, request id. Never logs
// cookies, tokens, Authorization headers, query values or bodies.
function adminRequestLog(event, res, t0) {
  try {
    const path = String(authPath(event) || '');
    if (path.indexOf('/admin/') === -1 && !/\/admin$/.test(path)) return;
    log({
      evt: 'admin-api',
      method: (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || null,
      path: path.split('?')[0].slice(0, 120),
      auth: event._authCategory || 'not-checked',
      status: res && res.statusCode,
      rid: (event.requestContext && event.requestContext.requestId) || null,
      ms: Date.now() - t0,
    });
  } catch { /* logging must never affect the response */ }
}
exports.handler = async (event) => {
  const t0 = Date.now();
  const res = await handleEvent(event);
  if (event && typeof event === 'object' && !event.transcriptReview && !event.recallIngest && event.source !== 'aws.events') adminRequestLog(event, res, t0);
  return res;
};
async function handleEvent(event) {
  if (event && event.transcriptReview) {
    // Every 15 minutes (whichpart-transcript-review schedule): restore a batch routing override whose
    // worker vanished (stale lease) or whose run already ended. A healthy owner is never touched.
    try {
      const rec = await recoverRoutingOverride('system:api-recovery');
      if (rec.action !== 'none') log({ evt: 'batch-routing-recovery', action: rec.action, why: rec.why || null, runId: rec.result && rec.result.lock ? rec.result.lock.runId : (rec.lock ? rec.lock.runId : null) });
    } catch (e) {
      log({ evt: 'batch-routing-recovery', action: 'error', error: String((e && e.name) || 'Error') });
    }
    try {
      const result = await runTranscriptReviewBatch(new Date());
      log({ evt: 'transcript-review-scheduled', attempted: result.attempted, reviewed: result.reviewed, failed: result.failed, skipped: result.skipped || false });
      return result;
    } catch (e) {
      log({ evt: 'transcript-review-scheduled-failed', error: String(e && e.message || e) });
      return { ok: false, error: String(e && e.message || e) };
    }
  }
  if (event && (event.source === 'aws.events' || event.recallIngest)) {
    const mode = event.recallIngest === 'backfill' ? 'backfill'
      : event.recallIngest === 'publish' ? 'publish' : 'daily';
    try {
      const result = await recallIngest.run({ store: recallStore(), mode, trigger: 'scheduled' });
      log({ evt: 'recall-ingest-scheduled', mode, ok: result.ok, counts: result.counts });
      return result;
    } catch (e) {
      log({ evt: 'recall-ingest-scheduled-failed', error: String(e && e.message || e) });
      throw e;
    }
  }
  const rid =
    (event.requestContext && event.requestContext.requestId) ||
    Math.random().toString(36).slice(2);
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod || 'POST';

  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // ---- auth + admin routes (BFF; diagnosis path below is unchanged) ----------
  const path = authPath(event);
  if (path.endsWith('/auth/login')) {
    return method === 'POST' ? authLogin(event) : respond(405, { error: 'POST only' });
  }
  if (path.endsWith('/auth/logout')) return authLogout(event);
  if (path.endsWith('/auth/me')) return authMe(event);
  if (path.endsWith('/admin/health')) return adminHealth(event);
  if (path.endsWith('/admin/dashboard')) return adminDashboard(event);
  // Settings + AI provider config (admin). Every route: unsupported method → 405, then admin auth →
  // 401, then a body cap, then the handler (clean JSON 500 on an unexpected failure). Sub-paths first.
  if (path.endsWith('/admin/settings/jev/test')) return settingsAdminRoute(event, method, { POST: adminSettingsJevTest });
  if (path.endsWith('/admin/settings/jev')) return settingsAdminRoute(event, method, { PATCH: adminSettingsJevPatch });
  if (path.endsWith('/admin/settings/diagnostic-inference')) return settingsAdminRoute(event, method, { PATCH: adminSettingsInferencePatch });
  if (path.endsWith('/admin/settings')) return settingsAdminRoute(event, method, { GET: adminSettingsGet });
  if (path.endsWith('/admin/ai-config/key')) return settingsAdminRoute(event, method, { POST: aiConfigSaveKey });
  if (path.endsWith('/admin/ai-config/test-local')) return settingsAdminRoute(event, method, { POST: aiConfigTestLocal });
  if (path.endsWith('/admin/ai-config/test-frontier')) return settingsAdminRoute(event, method, { POST: aiConfigTestFrontier });
  if (path.endsWith('/admin/ai-config/local-models')) return settingsAdminRoute(event, method, { GET: aiConfigLocalModels });
  if (path.endsWith('/admin/ai-config/frontier-models')) return settingsAdminRoute(event, method, { GET: aiConfigFrontierModels });
  // Read-only legacy view. The old unversioned whole-document POST writer is retired: live routing
  // changes go through PATCH /admin/settings/diagnostic-inference (revision check, reason, audit).
  if (path.endsWith('/admin/ai-config')) return settingsAdminRoute(event, method, { GET: aiConfigGet });
  // Question Library (admin). Sub-paths before base.
  // Test area: Question Library (scenarios) + batch runner. Every route goes through testAdminRoute:
  // unsupported method → 405, then admin auth → 401, then the handler. Sub-paths before base.
  if (path.endsWith('/admin/library/journey/edit')) return testAdminRoute(event, method, { POST: libraryEdit });
  if (path.endsWith('/admin/library/journey/duplicate')) return testAdminRoute(event, method, { POST: libraryDuplicate });
  if (path.endsWith('/admin/library/journey/flags')) return testAdminRoute(event, method, { POST: libraryFlags });
  if (path.endsWith('/admin/library/journey/delete')) return testAdminRoute(event, method, { POST: libraryDelete });
  if (path.endsWith('/admin/library/journey')) return testAdminRoute(event, method, { GET: libraryJourneyGet, POST: libraryCreate });
  if (path.endsWith('/admin/library/import')) return testAdminRoute(event, method, { POST: libraryImport });
  if (path.endsWith('/admin/library')) return testAdminRoute(event, method, { GET: libraryList });
  // Run builder
  if (path.endsWith('/admin/benchmark/build-run')) return testAdminRoute(event, method, { POST: benchmarkBuildRun });
  if (path.endsWith('/admin/benchmark/rerun')) return testAdminRoute(event, method, { POST: benchmarkRerun });
  if (path.endsWith('/admin/benchmark/estimate')) return testAdminRoute(event, method, { POST: benchmarkEstimate });
  // ACQ-100 quality benchmark (admin control plane). Sub-paths before base.
  if (path.endsWith('/admin/benchmark/routing-override/resolve')) return testAdminRoute(event, method, { POST: routingOverrideResolve });
  if (path.endsWith('/admin/benchmark/routing-override/recover')) return testAdminRoute(event, method, { POST: routingOverrideRecover });
  if (path.endsWith('/admin/benchmark/run/cancel')) return testAdminRoute(event, method, { POST: acqBenchmarkCancel });
  // Conversation transcript viewer + engineer review (sub-paths before base run).
  if (path.endsWith('/admin/benchmark/transcript')) return testAdminRoute(event, method, { GET: acqTranscriptGet });
  if (path.endsWith('/admin/benchmark/scenario-conversations')) return testAdminRoute(event, method, { GET: acqScenarioConversations });
  if (path.endsWith('/admin/benchmark/reviews')) return testAdminRoute(event, method, { GET: acqReviewsForRun });
  if (path.endsWith('/admin/benchmark/review')) return testAdminRoute(event, method, { GET: acqReviewGet, POST: acqReviewSave });
  if (path.endsWith('/admin/benchmark/run')) return testAdminRoute(event, method, { GET: acqBenchmarkRunGet, POST: acqBenchmarkRun });
  if (path.endsWith('/admin/benchmark/runs')) return testAdminRoute(event, method, { GET: acqBenchmarkRuns });
  if (path.endsWith('/admin/benchmark/compare')) return testAdminRoute(event, method, { GET: acqBenchmarkCompare });
  if (path.endsWith('/admin/benchmark/config')) return testAdminRoute(event, method, { GET: acqBenchmarkConfig });
  if (path.endsWith('/admin/transcripts/stats')) return adminTranscriptStats(event);
  if (path.endsWith('/admin/transcripts/policy')) return adminTranscriptPolicy(event);
  if (path.endsWith('/admin/transcripts/quality')) return adminTranscriptQuality(event);
  if (path.endsWith('/admin/transcripts/session/review')) return adminTranscriptReview(event);
  if (path.endsWith('/admin/transcripts/session')) return adminTranscriptGet(event);
  if (path.endsWith('/admin/transcripts')) return adminTranscriptList(event);
  if (path.endsWith('/admin/knowledge/record')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminKnowledgeRecord(event);
  }
  if (path.endsWith('/admin/knowledge/draft')) return adminKnowledgeDraft(event, method);
  if (path.endsWith('/admin/knowledge/validate')) {
    // Read-only: runs publish validation over unsaved editor content. No writes.
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ body, id }) => knowledgeStore().checkDraft(body.content, id));
  }
  if (path.endsWith('/admin/knowledge/versions')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminKnowledgeVersions(event);
  }
  if (path.endsWith('/admin/knowledge/publish')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().publish(needId(id), body.expectedRevision, body.note, actor));
  }
  if (path.endsWith('/admin/knowledge/rollback')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().rollback(needId(id), body.expectedRevision, body.toVersion, body.note, actor));
  }
  if (path.endsWith('/admin/knowledge/archive')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().archive(needId(id), body.expectedRevision, actor));
  }
  if (path.endsWith('/admin/knowledge/restore')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return knowledgeMutation(event, ({ actor, body, id }) => knowledgeStore().restore(needId(id), body.expectedRevision, actor));
  }
  if (path.endsWith('/admin/knowledge')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminKnowledge(event);
  }
  if (path.endsWith('/admin/media/knowledge')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminMediaKnowledge(event);
  }
  if (path.endsWith('/admin/media/preview')) {
    if (method !== 'GET' && method !== 'POST') return respond(405, { error: 'GET or POST' });
    return adminMediaPreview(event, method);
  }
  if (path.endsWith('/admin/media/record/publish')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaAction(event, 'publish');
  }
  if (path.endsWith('/admin/media/record/rollback')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaAction(event, 'rollback');
  }
  if (path.endsWith('/admin/media/record/discard')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaAction(event, 'discardDraft');
  }
  if (path.endsWith('/admin/media/record/version')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminMediaVersion(event);
  }
  if (path.endsWith('/admin/media/record/replace')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaReplace(event);
  }
  if (path.endsWith('/admin/media/record/map')) {
    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') return respond(405, { error: 'POST, PATCH or DELETE' });
    return adminMediaMap(event, method);
  }
  if (path.endsWith('/admin/media/record/component')) {
    if (method !== 'POST' && method !== 'DELETE') return respond(405, { error: 'POST or DELETE' });
    return adminMediaComponent(event, method);
  }
  if (path.endsWith('/admin/media/record/retire')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaRetire(event);
  }
  if (path.endsWith('/admin/media/record/restore')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminMediaRestore(event);
  }
  if (path.endsWith('/admin/media/record')) {
    if (method === 'GET') return adminMediaRecord(event);
    if (method === 'PATCH') return adminMediaPatch(event);
    if (method === 'DELETE') return adminMediaDelete(event);
    return respond(405, { error: 'GET, PATCH or DELETE' });
  }
  if (path.endsWith('/admin/media')) {
    if (method === 'GET') return adminMedia(event);
    if (method === 'POST') return adminMediaCreate(event);
    return respond(405, { error: 'GET or POST' });
  }
  if (path.endsWith('/admin/diagnostics')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminDiagnostics(event);
  }
  if (path.endsWith('/admin/error-codes/record/publish')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodeAction(event, 'publish');
  }
  if (path.endsWith('/admin/error-codes/record/rollback')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodeAction(event, 'rollback');
  }
  if (path.endsWith('/admin/error-codes/record/version')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    return adminErrorCodeVersion(event);
  }
  if (path.endsWith('/admin/error-codes/record/retire')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodeRetire(event);
  }
  if (path.endsWith('/admin/error-codes/record/restore')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodeRestore(event);
  }
  if (path.endsWith('/admin/error-codes/preview')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    return adminErrorCodePreview(event);
  }
  if (path.endsWith('/admin/error-codes/record')) {
    return adminErrorCodeRecord(event);
  }
  if (path.endsWith('/admin/error-codes')) {
    if (method !== 'GET' && method !== 'POST') return respond(405, { error: 'GET or POST' });
    return adminErrorCodes(event);
  }
  if (path.endsWith('/admin/recalls/records')) {
    return recallAdminRoute(event, method, ['GET'], () => recallAdmin.list((event && event.queryStringParameters) || {}));
  }
  if (path.endsWith('/admin/recalls/record/version')) {
    return recallAdminRoute(event, method, ['GET'], (_b, id) => recallAdmin.version(id, queryParam(event, 'v')));
  }
  if (path.endsWith('/admin/recalls/record/publish')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.publish(id, b));
  }
  if (path.endsWith('/admin/recalls/record/discard')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.discardDraft(id, b));
  }
  if (path.endsWith('/admin/recalls/record/archive')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.archive(id, b));
  }
  if (path.endsWith('/admin/recalls/record/restore')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.restore(id, b));
  }
  if (path.endsWith('/admin/recalls/record/rollback')) {
    return recallAdminRoute(event, method, ['POST'], (b, id) => recallAdmin.rollback(id, b));
  }
  if (path.endsWith('/admin/recalls/record')) {
    return recallAdminRoute(event, method, ['GET', 'PATCH'], (b, id) => (method === 'GET' ? recallAdmin.get(id) : recallAdmin.saveDraft(id, b)));
  }
  if (path.endsWith('/admin/recalls/ingest')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    const ingestActor = await requireAdmin(event);
    if (!ingestActor) return respond(401, { error: 'Unauthorized' });
    try {
      const result = await recallHandlers.adminIngest(event, ingestActor.email || ingestActor.username || null);
      if (result && result.running) return respond(409, result);
      return respond(result && result.ok === false ? 503 : 200, result);
    } catch (e) {
      log({ evt: 'recall-ingest-failed', error: String(e && e.message || e) });
      return respond(503, { error: 'OPSS request failed or timed out. The existing published dataset remains active.', preservedExisting: true });
    }
  }
  if (path.endsWith('/admin/safety-ingest/run')) {
    if (method !== 'POST') return respond(405, { error: 'POST only' });
    const runActor = await requireAdmin(event);
    if (!runActor) return respond(401, { error: 'Unauthorized' });
    try {
      const forced = Object.assign({}, event, { body: JSON.stringify({ mode: 'daily' }) });
      const result = await recallHandlers.adminIngest(forced, runActor.email || runActor.username || null);
      if (result && result.running) return respond(409, result);
      return respond(result && result.ok === false ? 503 : 200, result);
    } catch (e) {
      log({ evt: 'recall-ingest-failed', error: String(e && e.message || e) });
      return respond(503, { error: 'OPSS request failed or timed out. The existing published dataset remains active.', preservedExisting: true });
    }
  }
  if (path.endsWith('/admin/safety-ingest/history')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    try { return respond(200, await recallHandlers.adminHistory()); }
    catch (e) { return respond(503, { error: 'Recall store unavailable' }); }
  }
  if (path.endsWith('/admin/safety-ingest/runs')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    try {
      const out = await recallHandlers.adminRunGet(event);
      return respond(out.status || 200, out.body || out);
    } catch (e) { return respond(503, { error: 'Recall store unavailable' }); }
  }
  if (path.endsWith('/admin/safety-ingest')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    try { return respond(200, await recallHandlers.adminStatus()); }
    catch (e) { return respond(503, { error: 'Recall store unavailable' }); }
  }
  if (path.endsWith('/admin/recalls/status')) {
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    try { return respond(200, await recallHandlers.adminStatus()); }
    catch (e) { return respond(503, { error: 'Recall store unavailable' }); }
  }
  if (path.endsWith('/recalls/lookup')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    const out = await recallHandlers.publicLookup(event);
    return respond(out.status || 200, out.body || out);
  }
  if (path.endsWith('/recalls/record')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    const out = await recallHandlers.publicGet(event);
    return respond(out.status || 200, out.body || out);
  }
  if (path.endsWith('/recalls') || path.endsWith('/recalls/')) {
    if (method !== 'GET') return respond(405, { error: 'GET only' });
    try { return respond(200, await recallHandlers.publicList(event)); }
    catch (e) { return respond(503, { error: 'Recall list unavailable' }); }
  }

  if (method !== 'POST') return respond(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'invalid JSON' }); }

  // Admin Live Test (live-test.js): the same diagnose path, admin-only, never a customer transcript.
  // Checked BEFORE anything else runs so a non-admin `liveTest` request does no work at all.
  const live = liveTest.takeLiveTest(body);
  if (live) {
    if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
    if (!live.ok) return respond(400, { error: live.error });
  }
  if (live && Object.prototype.hasOwnProperty.call(body, 'benchmark')) return respond(400, { error: 'liveTest requests must not send benchmark' });
  const liveStateIn = live ? liveTest.stateInOf(body) : null;

  // Service-authenticated benchmark (benchmark-auth.js): the same diagnose path with a runner's own
  // conversation session id + clientTurnId and NO customer transcript. A `benchmark` object is
  // accepted only with a valid x-benchmark-signature (HMAC over this exact body); otherwise 401 —
  // never silently ignored. It is not an Admin session and grants nothing else.
  let bench = null;
  if (!live) {
    bench = benchmarkAuth.takeBenchmark(body);
    if (bench) {
      let secrets = null;
      try { secrets = await _benchmarkSecretsLoader(); } catch { secrets = null; }
      const auth = benchmarkAuth.verifyRequest(benchmarkAuth.headerOf(event, benchmarkAuth.HEADER), benchmarkAuth.rawBodyOf(event), secrets);
      if (!auth.ok) {
        log({ evt: 'benchmark-auth', rid, ok: false, reason: auth.reason });
        return respond(401, { error: 'Unauthorized' });
      }
      if (!bench.ok) return respond(400, { error: bench.error });
      if (body.feedback || !Array.isArray(body.messages)) return respond(400, { error: 'benchmark requires messages' });
    }
  }
  const benchStateIn = bench ? liveTest.stateInOf(body) : null;
  const benchStatus = (args) => Object.assign(liveTest.status(Object.assign({ stateIn: benchStateIn }, args)), { schema: 'benchmark/1', session: benchmarkAuth.sessionRef(bench.sessionId), clientTurnId: Boolean(bench.clientTurnId) });

  // Observability fields are stripped here and NEVER forwarded to the orchestrator.
  // (A live test / benchmark request is refused above if it carries observability, so `obs` is null for it.)
  const obs = live || bench ? null : transcripts.takeObservability(body);

  // Feedback pass-through: forward {feedback:{traceId,rating,note}} to the RAG engine (the single
  // S3 writer/redactor). The traceId originates from the RAG (carried through the orchestrator).
  if (live && (body.feedback || !Array.isArray(body.messages))) return respond(400, { error: 'liveTest requires messages' });
  if (body.feedback) {
    try {
      await fetch(ENGINE_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback: body.feedback }),
      });
    } catch (e) {
      log({ evt: 'whichpart-api', rid, feedbackError: e.message });
    }
    return respond(200, { ok: true });
  }

  if (obs && obs.event === 'end' && (!Array.isArray(body.messages) || body.messages.length === 0)) {
    await persistTranscriptEnd(obs);
    return respond(200, { ok: true });
  }

  let messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return respond(400, { error: 'messages array required' });
  }
  messages = conversationWindow(messages, MAX_MESSAGES);
  if (!messages.length) {
    return respond(400, { error: 'messages array required' });
  }
  // Customer turns are counted (rate-limit.js); an admin Live Test and a verified benchmark turn are authenticated
  // and not counted.
  if (!live && !bench) {
    const limitedTurn = await rateLimited('diagnose', event, { session: obs && obs.sessionId });
    if (limitedTurn) return limitedTurn;
  }

  // CANONICAL STATE (canonical-architecture.md §11). The BFF owns durable cs/1 state. In `off` nothing
  // happens. In `shadow` / `control` the signed token is verified, state is loaded and sent to the
  // orchestrator, and the returned state is persisted. In `control` an allow-listed journey owns the
  // reply; every canonical failure degrades that turn to the legacy path.
  const canonCtx = await canonicalPrepare(body, live ? live.clientTurnId : (bench ? bench.clientTurnId : (obs && obs.clientTurnId)), rid);

  // IDEMPOTENT RETRY (canonical control): the same browser clientTurnId was already merged and
  // answered for this canonical session. Return the processed result; never merge again.
  if (canonCtx.duplicate && canonCtx.duplicate.view && canonCtx.mode === 'control') {
    const cached = { ...canonCtx.duplicate.view, requestId: rid };
    if (canonCtx.token) cached.stateToken = canonCtx.token;
    if (live) cached.liveTest = liveTest.status({ stateIn: liveStateIn, ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'replayed' });
    if (bench) cached.benchmark = benchStatus({ ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'replayed' });
    log({ evt: 'whichpart-api', rid, client: CLIENT_ID, liveTest: live ? true : undefined,
      benchmark: bench ? { auth: true, session: benchmarkAuth.sessionRef(bench.sessionId), turnId: Boolean(bench.clientTurnId), continuity: 'replayed' } : undefined,
      canonical: { mode: canonCtx.mode, duplicate: canonCtx.duplicate.source,
      version: canonCtx.version, ref: conversationState.sessionRef(canonCtx.csid), replayedView: true } });
    await persistTranscriptReplay(obs);
    return respond(200, cached);
  }

  const t0 = Date.now();
  let orch;
  try {
    // The client's stable per-conversation id (observability.sessionId, already validated by
    // takeObservability) is the orchestrator session key so its ConversationState persists across
    // turns. When the client sends no observability (e.g. the regression harness) the orchestrator
    // call falls back to a deterministic opening-turn fingerprint.
    orch = await callOrchestrator(messages, live ? live.sessionId : (bench ? bench.sessionId : (obs && obs.sessionId)), canonCtx.block);
  } catch (err) {
    log({ evt: 'whichpart-api', rid, error: err.message, ms: Date.now() - t0 });
    const fallback = fallbackView(rid);
    if (canonCtx.token) fallback.stateToken = canonCtx.token;
    if (live) fallback.liveTest = liveTest.status({ stateIn: liveStateIn, ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'orchestrator_unavailable' });
    if (bench) fallback.benchmark = benchStatus({ ctx: canonCtx, summary: null, tokenOut: Boolean(canonCtx.token), path: 'orchestrator_unavailable' });
    await persistTranscriptTurn(obs, messages, fallback, null, rid,
      canonicalTranscriptAudit(canonCtx, null, { written: false, recordWritten: false, degraded: canonCtx.degraded }, null, 'orchestrator_unavailable'));
    return respond(200, fallback);
  }

  const canonResult = await canonicalFinish(canonCtx, orch._canonical, rid);
  let canonSummary = null;
  try { canonSummary = conversationState.summarise(canonCtx, orch._canonical, canonResult); } catch { canonSummary = null; }
  // Live Test only: the merged state this turn actually persisted (projected, never returned whole).
  const liveMerged = (live || bench) && canonResult.written && orch._canonical && orch._canonical.state ? orch._canonical.state : null;
  // The transcript keeps only the bounded canonical-audit/1 projection (no state body, csid or token).
  const canonAudit = canonicalTranscriptAudit(canonCtx, orch._canonical, canonResult, orch._diagnosticTrace);
  delete orch._canonical; // server-side only; never reaches the view or the transcript
  // Admin diagnostic trace (persisted with the transcript turn, never in the browser view): a bounded
  // canonical persistence stage — mode, safe ref, versions, mc/1 summary, rules, persistence, degraded.
  if (canonSummary && orch._diagnosticTrace && Array.isArray(orch._diagnosticTrace.stages)) {
    orch._diagnosticTrace.stages.push(conversationState.traceStage(canonSummary));
  }

  let overlay = null;
  try { overlay = await loadOverlayCached(); } catch { overlay = null; }
  const view = toWhichPartView(orch, rid, overlay);
  if (canonCtx.token) view.stateToken = canonCtx.token;
  // Idempotency marker (+ cached view) only for a turn whose canonical state was persisted.
  if (canonResult.written && canonCtx.clientTurnId) {
    await conversationState.recordClientTurn(canonCtx, canonResult, view, { store: canonicalStore() });
  }
  // Attached after the idempotency cache is written, so a cached view never carries a live-test status.
  if (live) view.liveTest = liveTest.status({ stateIn: liveStateIn, ctx: canonCtx, summary: canonSummary, tokenOut: Boolean(canonCtx.token), mergedState: liveMerged });
  if (bench) view.benchmark = benchStatus({ ctx: canonCtx, summary: canonSummary, tokenOut: Boolean(canonCtx.token), mergedState: liveMerged });
  const cr = orch.codeResult || null;
  const mcpInvoked = orch.route === 'ERROR_CODE' || orch.route === 'ERROR_CODE_AND_SYMPTOMS';
  const ragInvoked = orch.route === 'SYMPTOMS' || orch.route === 'ERROR_CODE_AND_SYMPTOMS';
  const submitted = (orch._telemetry && orch._telemetry.submitted) || null;
  log({
    evt: 'whichpart-api', rid, client: CLIENT_ID,
    // Admin Live Test turn: continuity status only (never the token, csid or state body).
    liveTest: live ? { stateIn: view.liveTest.stateIn, stateOut: view.liveTest.stateOut, continuity: view.liveTest.continuity, reason: view.liveTest.reason } : undefined,
    // Service-authenticated benchmark turn: safe refs only (never the session id, token or secret).
    benchmark: bench ? { auth: true, session: view.benchmark.session, turnId: view.benchmark.clientTurnId, stateIn: view.benchmark.stateIn, stateOut: view.benchmark.stateOut, continuity: view.benchmark.continuity, reason: view.benchmark.reason } : undefined,
    route: orch.route, outcome: orch.outcome,
    hasDisplayedCode: Boolean(cr && cr.displayed),
    mcpInvoked,
    ragInvoked,
    clarificationRequired: orch.outcome === 'CLARIFICATION_REQUIRED',
    safetyState: (orch.safety && orch.safety.class) || 'NORMAL',
    safetyStopUse: Boolean((orch.safety && orch.safety.stopUse) || orch.outcome === 'SAFETY_STOP'),
    partCount: view.parts.length,
    mcpSubmitted: submitted,
    mcpResolved: cr ? {
      displayed: cr.displayed || null,
      status: cr.status || null,
      recordType: cr.recordType || null,
      meaning: cr.meaning ? String(cr.meaning).slice(0, 180) : null,
      source: cr.source || null,
      confidence: cr.confidence || cr.mappingConfidence || null,
    } : null,
    ragConstrainedByMcp: Boolean(mcpInvoked && ragInvoked && cr && cr.status === 'RESOLVED'),
    canonical: canonCtx.mode === 'off' ? undefined : {
      mode: canonCtx.mode, demoted: canonCtx.demoted || undefined, version: canonCtx.version,
      duplicate: canonCtx.duplicate ? canonCtx.duplicate.source : undefined,
      appliance: canonSummary && canonSummary.mc1 ? canonSummary.mc1.appliance : undefined,
      control: canonSummary && canonSummary.journey ? {
        key: canonSummary.journey.key || null, applies: canonSummary.journey.applies, control: canonSummary.journey.control,
        rule: canonSummary.journey.nextAction ? canonSummary.journey.nextAction.rule : undefined,
        kind: canonSummary.journey.nextAction ? canonSummary.journey.nextAction.kind : undefined,
        target: canonSummary.journey.nextAction ? canonSummary.journey.nextAction.target : undefined,
      } : undefined,
      recovered: canonCtx.recovered || undefined,
      degraded: canonResult.degraded || canonCtx.degraded || null, written: canonResult.written,
      recordWritten: canonResult.recordWritten,
      ref: canonSummary ? canonSummary.ref : undefined,
      resultVersion: canonSummary ? canonSummary.resultVersion : undefined,
      rules: canonSummary ? canonSummary.rulesFired : undefined,
      stateBytes: canonSummary ? canonSummary.stateBytes : undefined,
      classifier: canonSummary && canonSummary.classifier ? {
        source: canonSummary.classifier.source, degraded: canonSummary.classifier.degraded || undefined,
        reason: canonSummary.classifier.reason || undefined, recallGap: canonSummary.classifier.recallGap,
      } : undefined,
    },
    ms: Date.now() - t0,
  });
  await persistTranscriptTurn(obs, messages, view, orch, rid, canonAudit);
  return respond(200, view);
};

// ---- orchestrator call --------------------------------------------------------
// Pick the orchestrator session key. The client's stable per-conversation id (observability
// sessionId) is preferred so the orchestrator's deterministic ConversationState is found again on
// the next turn and established facts persist. transcripts.isValidSessionId guards the format the
// orchestrator keys on; anything missing/invalid falls back to the deterministic opening-turn
// fingerprint computed by deriveContext. Pure + exported for unit tests (no network).
function resolveOrchestratorSessionId(clientSessionId, fallbackSessionId) {
  if (clientSessionId && transcripts.isValidSessionId(clientSessionId)) return clientSessionId;
  return fallbackSessionId;
}

// ---- canonical state (cs/1 transport + persistence) ------------------------------------------------
let _canonicalStore = null;
let _canonicalSecretsLoader = () => stateTokenMod.loadSecrets();
let _canonicalNewId = undefined;
function canonicalStore() {
  if (!_canonicalStore) _canonicalStore = conversationState.createStateStore();
  return _canonicalStore;
}
function setCanonicalDepsForTests({ store, secretsLoader, newId } = {}) {
  if (store !== undefined) _canonicalStore = store;
  if (secretsLoader !== undefined) _canonicalSecretsLoader = secretsLoader;
  if (newId !== undefined) _canonicalNewId = newId;
}
let _canonicalUnknownLogged = false;
/** Never throws; `off` mode does no work at all. */
async function canonicalPrepare(body, clientTurnId, rid) {
  const { mode, demoted, unknown } = conversationState.resolveMode();
  // An allow-list key that is not in the journey registry is never enabled; say so once per container.
  if (unknown && unknown.length && !_canonicalUnknownLogged) {
    _canonicalUnknownLogged = true;
    log({ evt: 'canonical-config', warning: 'unknown CANONICAL_CONTROL_JOURNEYS keys ignored', unknown: unknown.slice(0, 20).map((k) => String(k).slice(0, 60)) });
  }
  if (mode === 'off') return { mode: 'off', block: null, token: null, degraded: null };
  try {
    let secrets = null;
    try { secrets = await _canonicalSecretsLoader(); } catch { secrets = null; }
    const ctx = await conversationState.prepareTurn({ body, store: canonicalStore(), secrets, newId: _canonicalNewId, clientTurnId });
    if (ctx.degraded) log({ evt: 'canonical-prepare', rid, mode: ctx.mode, degraded: ctx.degraded });
    return ctx;
  } catch (e) {
    // e.g. store construction failed. The legacy path continues; canonical is simply off this turn.
    log({ evt: 'canonical-prepare', rid, mode, degraded: 'prepare_failed', error: String((e && e.message) || e).slice(0, 160) });
    return { mode, demoted, block: null, token: null, version: 0, degraded: 'prepare_failed' };
  }
}
async function canonicalFinish(ctx, out, rid) {
  if (!ctx || !ctx.block) return { written: false, recordWritten: false, degraded: ctx ? ctx.degraded : null };
  try {
    const r = await conversationState.finishTurn(ctx, out, { store: canonicalStore(), messageId: rid });
    if (r.degraded) log({ evt: 'canonical-finish', rid, degraded: r.degraded, written: r.written });
    return r;
  } catch (e) {
    return { written: false, recordWritten: false, degraded: 'finish_failed' };
  }
}

async function callOrchestrator(messages, clientSessionId, canonicalBlock) {
  // Story 3: the BFF is a STRUCTURAL transport. It assembles the conversation and forwards it; it
  // does NOT interpret customer meaning (appliance family, symptom presence, model-vs-error-code
  // are the orchestrator's single Jev UNDERSTAND, which runs BEFORE routing). The old deriveContext
  // semantic parsing and the competing extract-intent LLM classifier have been removed — one
  // semantic authority, no boundary duplication.
  const ctx = deriveContext(messages);
  // Prefer the client's stable per-conversation id so the orchestrator's ConversationState persists
  // across turns; fall back to the deterministic opening-turn fingerprint for clients that send no
  // observability session.
  const sessionId = resolveOrchestratorSessionId(clientSessionId, ctx.sessionId);
  const payload = {
    // Accumulated conversation (client-carried context) so the orchestrator's single Jev pass sees
    // the whole thread every turn (retention/correction), now with a STABLE per-conversation session
    // so already-established facts are retained deterministically instead of re-derived each turn.
    message: ctx.conversationText || ctx.message, sessionId,
    includeEnrichment: true,
    latestMessage: ctx.latestMessage, turnIndex: ctx.turnIndex,
    conversation: sanitiseConversation(messages),
    // Forward the latest-turn rating-plate image so the orchestrator/RAG vision can read it.
    ...(ctx.latestImage ? { image: ctx.latestImage } : {}),
    // Canonical cs/1 block (mode, allow-list, csid, prior state). Present only when canonical runs this turn.
    ...(canonicalBlock ? { canonical: canonicalBlock } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORCH_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (ORCHESTRATOR_TOKEN) headers.authorization = 'Bearer ' + ORCHESTRATOR_TOKEN;
    const res = await fetch(ORCHESTRATOR_URL.replace(/\/$/, '') + '/diagnose', {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
    });
    if (!res.ok) throw new Error('orchestrator http ' + res.status);
    const out = await res.json();
    out._photoOnly = ctx.photoOnly;
    // Telemetry only — never customer-facing. Story 3: the BFF no longer derives semantics, so this
    // reflects what the orchestrator (single Jev authority) resolved, not a boundary re-parse.
    const understood = (out.understood && typeof out.understood === 'object') ? out.understood : {};
    out._telemetry = {
      submitted: {
        // What the orchestrator ACTUALLY routed/submitted this turn (single Jev authority), not a
        // boundary re-parse: the customer's displayed code (compound preserved), structural make,
        // and Jev's appliance family. Falls back to the resolved codeResult for the displayed code.
        displayedCode: understood.displayedCode || (out.codeResult && out.codeResult.displayed) || null,
        make: understood.make || null,
        applianceFamily: understood.appliance || null,
      },
    };
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// ---- orchestrator response -> retailer-neutral view --------------------------
function toWhichPartView(orch, rid, overlay) {
  const outcome = orch.outcome || 'ANSWER';
  const codeResult = orch.codeResult || null;
  const isSafety = outcome === 'SAFETY_STOP' || (orch.safety && orch.safety.stopUse);
  const recordType = codeResult && codeResult.recordType;
  const advisory = !isSafety && recordType === 'MAINTENANCE';

  let reply = sanitizeReply(orch.message || '');
  const mention = String(orch.componentMention || '').toLowerCase();
  const suppressCatalogueNames = mention === 'none' || mention === 'discuss';
  // Never dump a catalogue of possible components into the customer reply. The engine used to
  // fold suggestedChecks as "Worth checking: a, b, c" — that is not a next action.
  reply = reply.replace(/\s*Worth checking:\s*[^.]+\./g, '').trim();

  // FIT INVARIANT:


  // FIT INVARIANT: only MODEL_CONFIRMED with a genuinely resolved model AND a model-specific part.
  const hasResolvedModel = Boolean(orch.resolvedModel);
  const rawParts = (isSafety || suppressCatalogueNames) ? [] : (Array.isArray(orch.parts) ? orch.parts : []);
  const parts = rawParts
    .filter((p) => p && p.partNo)
    .map((p) => {
      const link = p.link || `/${p.partNo}`;
      return {
        canonicalPartId: `s4r:${p.partNo}`,
        name: p.title || p.partNo,
        imageUrl: p.image || p.imageUrl || null,
        fitStatus: (hasResolvedModel && !p._brandOnly) ? 'MODEL_CONFIRMED' : 'VERIFY_FIT',
        offers: [{
          retailer: 'Spares4Repairs',
          price: toPence(p.price),
          currency: 'GBP',
          url: `${S4R_PRODUCT_BASE_URL}${link.startsWith('/') ? '' : '/'}${link}`,
        }],
      };
    });

  const seen = new Set();
  const components = [];
  for (const p of parts) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    components.push({ name: p.name, rank: p.fitStatus === 'MODEL_CONFIRMED' ? 'PRIMARY' : 'PLAUSIBLE' });
  }

  // Rating-plate extraction awaiting confirmation: expose ONLY the candidate model string (never the
  // vision-read make/appliance, which can be a legal-entity/appliance distractor) so the UI can show
  // "is this your model?". Parts stay empty until the customer confirms.
  const ie = orch.imageExtraction;
  const extractedModel = (ie && ie.status === 'IMAGE_EXTRACTED_UNCONFIRMED' && ie.model) ? String(ie.model) : null;

  // needsModel: only when identity is still missing. A candidate extracted from a photo is
  // confirmation-in-progress, not a missing model — do not show the generic model-entry control.
  const needs = (orch.clarification && orch.clarification.needs) || [];
  const needsStr = needs.map((n) => (n && typeof n === 'object') ? (n.attribute || JSON.stringify(n)) : String(n)).join(' ');
  const modelNeedRe = /scheme|model|e_?nr|pnc|12nc|serial|plate|identifi|generation|platform|architecture/i;
  const needsModel = !extractedModel && Boolean(
    orch.modelRequired
    || (outcome === 'CLARIFICATION_REQUIRED' && modelNeedRe.test(needsStr))
  );

  const label = (codeResult && codeResult.meaning) || (orch.diagnosis && orch.diagnosis.summary) || null;

  // Customer SAFETY INFORMATION — pre-written, evidence-backed text attached to the grounded node by
  // the RAG (node identity) and passed through the orchestrator verbatim. We surface ONLY the
  // customer-facing fields (text + classification); provenance/source internals stay server-side.
  // The `text` is passed through byte-for-byte (never rewritten). Suppressed on a safety-stop (that
  // reply already leads with the authoritative action). Absent => null (UI renders nothing).
  const si = orch.safetyInformation;
  const safetyInformation = (!isSafety && si && typeof si.text === 'string' && si.text.trim())
    ? { text: si.text, classification: si.classification || null }
    : null;

  // Customer instructional media (image/diagram/video) supporting a check on the grounded node.
  // Already a customer-safe subset from the RAG; re-project defensively so no extra field can leak
  // (provenance never passes), suppress entirely on a safety-stop, and HARD-RESTRICT video embeds to
  // the trusted provider host — a curated embed URL from any other host is dropped.
  // Explanatory-media intent (customer-safe): SAFE_CHECK (instructional/check) or ABOUT
  // (identification/explanation — non-DIY framing in the UI). Default SAFE_CHECK for backward compat.
  const mediaIntent = (m) => (m && m.intent === 'ABOUT' ? 'ABOUT' : 'SAFE_CHECK');
  const media = mediaAdmin.applyToCustomerMedia((!isSafety && Array.isArray(orch.media))
    ? orch.media.map((m) => {
        if (!m || !m.title) return null;
        if (m.type === 'VIDEO') {
          if (m.provider !== 'YOUTUBE' || !isTrustedVideoEmbed(m.embedUrl)) return null;
          return {
            type: 'VIDEO', title: m.title, caption: m.caption || m.description || '',
            provider: 'YOUTUBE', videoId: m.videoId || null, embedUrl: m.embedUrl,
            sourcePageUrl: (typeof m.sourcePageUrl === 'string' && /^https:\/\//i.test(m.sourcePageUrl)) ? m.sourcePageUrl : null,
            attribution: m.attribution || null, intent: mediaIntent(m), id: m.id || null,
          };
        }
        if (!m.url) return null;
        return { type: m.type || 'IMAGE', title: m.title, description: m.description || '', url: m.url, alt: m.alt || m.title, intent: mediaIntent(m), id: m.id || null };
      }).filter(Boolean)
    : [], overlay);

  // Relay the orchestrator's STRUCTURED pending request (customer-safe: slot/purpose/status only) so
  // a client that can carry conversation state echoes it back next turn. Absent => null.
  const pr = orch.pendingRequest;
  const pendingRequest = (pr && typeof pr === 'object' && typeof pr.slot === 'string')
    ? { slot: pr.slot, purpose: pr.purpose || null, status: pr.status || 'PENDING' }
    : null;

  return {
    requestId: rid,
    traceId: orch.traceId || null,
    reply,
    advisory,
    safety: Boolean(isSafety),
    pendingRequest,
    safetyInformation,
    needsModel,
    extractedModel,
    media,
    diagnosis: {
      faultId: null, // internal scheme/fault ids are never surfaced to the client
      label,
      summary: firstSentence(reply),
    },
    components,
    // The engine's full differential (customer-safe suspect names). The customer-facing `reply` is a
    // concise, prioritised engineering explanation (it deliberately does NOT list every suspect);
    // this structured field carries the complete differential for the UI and for quality grading, so
    // measuring differential breadth never forces verbose prose.
    suggestedChecks: Array.isArray(orch.suggestedChecks) ? orch.suggestedChecks : [],
    parts,
  };
}

// Trusted VIDEO embed hosts (privacy-enhanced YouTube only). The customer response may only carry an
// embed URL whose host is in this allowlist — no arbitrary iframes, even from curated data.
const VIDEO_EMBED_HOSTS = new Set(['www.youtube-nocookie.com', 'youtube-nocookie.com']);
function isTrustedVideoEmbed(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' && VIDEO_EMBED_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
}

function sanitizeReply(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\((?:\/|https?:)[^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^[ \t]*[*-][ \t]+/gm, '\u2022 ')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
function toPence(price) {
  const n = parseFloat(price);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function firstSentence(text) {
  if (!text) return '';
  const m = text.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : text).trim();
}
function fallbackView(rid) {
  return {
    requestId: rid,
    reply: "Sorry \u2014 something went wrong working that out. Please try again in a moment, or rephrase the problem.",
    needsModel: false, safety: false, advisory: false, safetyInformation: null, extractedModel: null, media: [],
    diagnosis: { faultId: null, label: null, summary: '' },
    components: [], parts: [], error: true,
  };
}
function respond(statusCode, obj) {
  return { statusCode, headers: CORS, body: JSON.stringify(obj) };
}
function log(o) {
  try { console.log(JSON.stringify(o)); } catch { /* ignore */ }
}

// Exported for deterministic unit tests (no network / orchestrator needed).
module.exports.toWhichPartView = toWhichPartView;
module.exports.deriveContext = deriveContext;
module.exports.sanitiseConversation = sanitiseConversation;
module.exports.conversationWindow = conversationWindow;
module.exports.resolveOrchestratorSessionId = resolveOrchestratorSessionId;
module.exports.setTranscriptStore = setTranscriptStore;
module.exports.setCanonicalDepsForTests = setCanonicalDepsForTests;
module.exports.setBenchmarkDepsForTests = setBenchmarkDepsForTests;
module.exports.setTranscriptReviewJudge = setTranscriptReviewJudge;
module.exports.setRateLimitStoreForTests = setRateLimitStoreForTests;
module.exports.setMediaAdminStore = setMediaAdminStore;
module.exports.setKnowledgeAdminStore = setKnowledgeAdminStore;
module.exports.knowledgeAdmin = knowledgeAdmin;
module.exports.setDiagnosticsDepsForTests = setDiagnosticsDepsForTests;
module.exports.setSettingsDepsForTests = setSettingsDepsForTests;
module.exports.setSessionForTests = setSessionForTests;
module.exports.setAcqS3ForTests = setAcqS3ForTests;
module.exports.routingOverride = routingOverride;
module.exports.settingsAdmin = settingsAdmin;
module.exports.diagnosticsInspect = diagnosticsInspect;
module.exports.mediaAdmin = mediaAdmin;
module.exports.transcripts = transcripts;
module.exports.transcriptReview = transcriptReview;
module.exports.setErrorCodesClientForTests = setErrorCodesClientForTests;
module.exports.errorCodesAdmin = errorCodesAdmin;
module.exports.recallAdmin = recallAdmin;
module.exports.setRecallStore = setRecallStore;
module.exports.recallStoreMod = recallStoreMod;
