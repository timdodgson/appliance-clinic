'use strict';

/**
 * whichpart-api configuration read from the environment at cold start: downstream service URLs and bearers, the AC
 * Cognito pool, and the learning bucket. Defaults are the production values (docs/architecture/configuration.md).
 */
const errorCodesAdmin = require('./error-codes-admin');

// The diagnosis engine (applianceclinic-diagnosis-engine): every customer turn (ac2), the feedback side-channel and the
// admin health probes. Its Function URL is AWS_IAM; calls are signed (engine-signature.js).
const ENGINE_URL =
  process.env.ENGINE_URL ||
  'https://3asx4cw2qs5ajsjkytdwffhhvy0ptnoz.lambda-url.eu-west-1.on.aws/';
const S4R_PRODUCT_BASE_URL =
  process.env.S4R_PRODUCT_BASE_URL || 'https://d1hrb3pgx61xww.cloudfront.net';
const CLIENT_ID = 'whichpart';
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

const AC_AUTH = { region: AUTH_REGION, poolId: COGNITO_USER_POOL_ID, clientId: COGNITO_CLIENT_ID, adminGroup: process.env.AC_ADMIN_GROUP || 'admin' };
const SESSION_COOKIE = 'wp_session';       // httpOnly — holds the Cognito access token
const LOGGED_IN_COOKIE = 'wp_logged_in';   // non-httpOnly indicator (never a token)
const MCP_HEALTH_URL = process.env.MCP_HEALTH_URL || '';
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || '';

const LEARNING_BUCKET = process.env.LEARNING_BUCKET || 'whichpart-learning-800960611664';
const ACQ_JUDGE_MODEL = process.env.ACQ_JUDGE_MODEL || 'gpt-5.6-terra';

const MCP_URL = process.env.MCP_URL || errorCodesAdmin.mcpBaseFromHealth(MCP_HEALTH_URL);

module.exports = {
  ENGINE_URL, S4R_PRODUCT_BASE_URL, CLIENT_ID, MAX_MESSAGES, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, AUTH_REGION, AC_AUTH, SESSION_COOKIE, LOGGED_IN_COOKIE,
  MCP_HEALTH_URL, MCP_BEARER_TOKEN, LEARNING_BUCKET, ACQ_JUDGE_MODEL, MCP_URL,
};
