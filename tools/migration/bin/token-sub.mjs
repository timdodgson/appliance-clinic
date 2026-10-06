#!/usr/bin/env node
/**
 * Print the Cognito `sub` and username from an access token read on stdin. No network calls; the
 * token is not stored. Used to find your own sub for the Phase 1 allowlist from your admin session.
 *
 *   node bin/token-sub.mjs < token.txt     (or paste the token, then Ctrl-D)
 */
import { readFileSync } from 'node:fs';

const token = readFileSync(0, 'utf8').trim();
const parts = token.split('.');
if (parts.length !== 3) { console.error('That does not look like a JWT.'); process.exit(2); }
const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
console.log(JSON.stringify({ sub: claims.sub || null, username: claims.username || claims['cognito:username'] || null, tokenUse: claims.token_use || null }, null, 2));
