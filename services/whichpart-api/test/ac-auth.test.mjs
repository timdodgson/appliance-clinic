/**
 * Appliance Clinic authentication (Phase 7, ADR 0006): sessions and admin authority come only from access tokens
 * issued by AC's own Cognito pool for the AC app client; admin authority is the pool's `admin` group. A token from
 * any other pool, the S4R pool included, is never a session and never admin, whatever groups it carries.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const POOL = 'eu-west-1_ACPOOL001';
const CLIENT = 'acclient0001';
const S4R_POOL = 'eu-west-1_S4RPOOL01';
process.env.COGNITO_USER_POOL_ID = POOL;
process.env.COGNITO_CLIENT_ID = CLIENT;
process.env.AWS_REGION = 'eu-west-1';

const auth = require('../ac-auth.js');
const sdk = require('@aws-sdk/client-cognito-identity-provider');
const api = require('../index.js');

const CONFIG = { region: 'eu-west-1', poolId: POOL, clientId: CLIENT, adminGroup: 'admin' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'RS256', kid: 'k' })}.${b64(claims)}.sig`;
const access = (over = {}) => jwt({ iss: `https://cognito-idp.eu-west-1.amazonaws.com/${POOL}`, token_use: 'access', client_id: CLIENT, sub: 'sub-1', ...over });

describe('ac-auth claims', () => {
  it('an AC access token for the AC client is an AC session', () => {
    expect(auth.isAcAccessToken(access(), CONFIG)).toBe(true);
  });
  it('a token from another pool, another client, or an ID token is not', () => {
    expect(auth.isAcAccessToken(access({ iss: `https://cognito-idp.eu-west-1.amazonaws.com/${S4R_POOL}` }), CONFIG)).toBe(false);
    expect(auth.isAcAccessToken(access({ client_id: 'other' }), CONFIG)).toBe(false);
    expect(auth.isAcAccessToken(access({ token_use: 'id' }), CONFIG)).toBe(false);
    expect(auth.isAcAccessToken(access({ sub: '' }), CONFIG)).toBe(false);
    expect(auth.isAcAccessToken(access({ iss: `https://cognito-idp.eu-west-2.amazonaws.com/${POOL}` }), CONFIG)).toBe(false);
  });
  it('nothing matches when the pool or client is not configured, or the token is malformed', () => {
    expect(auth.isAcAccessToken(access(), { region: 'eu-west-1', poolId: '', clientId: CLIENT })).toBe(false);
    expect(auth.isAcAccessToken(access(), { region: 'eu-west-1', poolId: POOL, clientId: '' })).toBe(false);
    for (const t of ['', 'x', 'a.b', 'a.b.c.d', 'a.!!!.c', `x.${Buffer.from('[1]').toString('base64url')}.y`]) expect(auth.isAcAccessToken(t, CONFIG)).toBe(false);
  });
  it('admin is the AC admin group, and only on an AC token', () => {
    expect(auth.isAcAdmin(access({ 'cognito:groups': ['admin'] }), CONFIG)).toBe(true);
    expect(auth.isAcAdmin(access({ 'cognito:groups': ['viewer'] }), CONFIG)).toBe(false);
    expect(auth.isAcAdmin(access(), CONFIG)).toBe(false);
    expect(auth.isAcAdmin(access({ 'cognito:groups': 'admin' }), CONFIG)).toBe(false);
    // The S4R pool's tokens never grant AC admin authority, even with an "admin" group.
    expect(auth.isAcAdmin(access({ iss: `https://cognito-idp.eu-west-1.amazonaws.com/${S4R_POOL}`, 'cognito:groups': ['admin'] }), CONFIG)).toBe(false);
  });
});

describe('whichpart-api sign-in and sessions against the AC pool', () => {
  let calls = [];
  let reply = () => { throw new Error('unexpected Cognito call'); };
  const original = sdk.CognitoIdentityProviderClient.prototype.send;
  beforeAll(() => {
    sdk.CognitoIdentityProviderClient.prototype.send = async function send(cmd) { calls.push(cmd.constructor.name); return reply(cmd); };
  });
  afterEach(() => { calls = []; reply = () => { throw new Error('unexpected Cognito call'); }; });
  const ev = (route, method, { cookie, body } = {}) => ({
    rawPath: '/api' + route, requestContext: { http: { method, path: '/api' + route, sourceIp: '192.0.2.1' }, requestId: 'r' },
    headers: {}, cookies: cookie ? [`wp_session=${cookie}`] : [], body: body === undefined ? '{}' : JSON.stringify(body),
  });

  it('signs in against the AC pool and reports admin from the group', async () => {
    reply = (cmd) => {
      expect(cmd.input.UserPoolId).toBe(POOL);
      expect(cmd.input.ClientId).toBe(CLIENT);
      return { AuthenticationResult: { AccessToken: access({ 'cognito:groups': ['admin'] }), IdToken: jwt({ email: 'admin@example.test' }) } };
    };
    const r = await api.handler(ev('/auth/login', 'POST', { body: { email: 'admin@example.test', password: 'x' } }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).user.isAdmin).toBe(true);
    expect(calls).toEqual(['AdminInitiateAuthCommand']);
  });
  it('an invited user who has not set a password is told to, not given a session', async () => {
    reply = () => ({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' });
    const r = await api.handler(ev('/auth/login', 'POST', { body: { email: 'new@example.test', password: 'temporary' } }));
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).code).toBe('password_change_required');
    expect(r.cookies || []).toEqual([]);
  });
  it('a cookie from another pool is signed out without a Cognito call', async () => {
    const s4r = access({ iss: `https://cognito-idp.eu-west-1.amazonaws.com/${S4R_POOL}`, 'cognito:groups': ['admin'] });
    const me = await api.handler(ev('/auth/me', 'GET', { cookie: s4r }));
    expect(JSON.parse(me.body).authenticated).toBe(false);
    expect(me.cookies.join(';')).toMatch(/wp_session=;.*Max-Age=0/);
    const admin = await api.handler(ev('/admin/settings', 'GET', { cookie: s4r }));
    expect(admin.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });
  it('an AC session without the admin group cannot reach admin routes', async () => {
    reply = () => ({ Username: 'u', UserAttributes: [{ Name: 'email', Value: 'user@example.test' }] });
    const r = await api.handler(ev('/admin/settings', 'GET', { cookie: access() }));
    expect(r.statusCode).toBe(401);
    expect(calls).toEqual(['GetUserCommand']);
  });
  it('a token Cognito rejects is no session, even with AC claims and the admin group', async () => {
    reply = () => { const e = new Error('Access Token has been revoked'); e.name = 'NotAuthorizedException'; throw e; };
    const r = await api.handler(ev('/admin/settings', 'GET', { cookie: access({ 'cognito:groups': ['admin'] }) }));
    expect(r.statusCode).toBe(401);
  });
  it('restores the SDK', () => {
    sdk.CognitoIdentityProviderClient.prototype.send = original;
    expect(sdk.CognitoIdentityProviderClient.prototype.send).toBe(original);
  });
});
