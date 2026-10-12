// Deploy the site to the Appliance Clinic web bucket (served by the applianceclinic.ai CloudFront distribution).
//
//   node scripts/deploy.mjs                 dry run: build, then print what would change
//   EXECUTE=1 node scripts/deploy.mjs       back up, upload, verify
//   node scripts/deploy.mjs --rollback <id> put back the objects a deploy replaced (id printed by that deploy)
//
// Needs the aws CLI with AC account credentials (account 800960611664, eu-west-1). Rules (ADR 0008):
//   - uploads only files that differ from the bucket (by MD5 / ETag); never deletes, never prunes. The bucket also
//     holds content the API writes at run time (media/, recalls/*/index.html, sitemap-recalls.xml); a deploy never
//     touches a key it does not build.
//   - never changes CloudFront. Files carry the Cache-Control the site has always used (60 s for HTML, 5 min for
//     scripts and styles, which are also content-versioned by the build), so no invalidation is needed.
//   - before uploading, copies every object it will overwrite to the AC backup bucket under site-deploys/<id>/;
//     --rollback copies them back (with their original metadata).
//   - the WebMCP origin-trial token (public, but not committed) is WEBMCP_ORIGIN_TRIAL_TOKEN, else the one in the
//     live index.html.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './build.mjs';

const ACCOUNT = '800960611664';
const REGION = 'eu-west-1';
const BUCKET = `whichpart-web-${ACCOUNT}`;
const BACKUP = `applianceclinic-migration-backup-${ACCOUNT}`;
const DIST = new URL('../dist/', import.meta.url).pathname;
const env = { ...process.env, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION };
const aws = (...args) => execFileSync('aws', args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const awsJson = (...args) => JSON.parse(aws(...args, '--output', 'json') || 'null');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function requireCaller() {
  const id = awsJson('sts', 'get-caller-identity');
  if (id.Account !== ACCOUNT) throw new Error(`refusing: caller account ${id.Account} is not the Appliance Clinic account ${ACCOUNT}`);
  log(`caller ${id.Arn.split('/').pop()} in ${ACCOUNT}/${REGION}`);
}

function bucketEtags() {
  const out = new Map(); let token;
  do {
    const page = awsJson('s3api', 'list-objects-v2', '--bucket', BUCKET, ...(token ? ['--continuation-token', token] : []));
    for (const o of page.Contents || []) out.set(o.Key, o.ETag.replace(/"/g, ''));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function liveToken() {
  if (process.env.WEBMCP_ORIGIN_TRIAL_TOKEN) return process.env.WEBMCP_ORIGIN_TRIAL_TOKEN;
  const html = aws('s3', 'cp', `s3://${BUCKET}/index.html`, '-');
  const m = html.match(/<meta http-equiv="origin-trial" content="([A-Za-z0-9+/=]+)"/);
  return m ? m[1] : '';
}

function deploy() {
  requireCaller();
  const token = liveToken();
  log(token ? 'WebMCP origin-trial token: carried over' : 'WebMCP origin-trial token: none (tag omitted)');
  const manifest = build({ token });
  const etags = bucketEtags();
  const md5 = (key) => createHash('md5').update(readFileSync(join(DIST, key))).digest('hex');
  const changed = manifest.filter((f) => etags.get(f.key) !== md5(f.key));
  const replaced = changed.filter((f) => etags.has(f.key));
  log(`${manifest.length} files built; ${changed.length} differ from the bucket (${replaced.length} replaced, ${changed.length - replaced.length} new)`);
  for (const f of changed) console.log(`  ${etags.has(f.key) ? 'replace' : 'add    '} ${f.key}`);
  if (!changed.length) { log('nothing to deploy'); return; }
  if (process.env.EXECUTE !== '1') { log('dry run: set EXECUTE=1 to deploy'); return; }

  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const prefix = `site-deploys/${id}/`;
  for (const f of replaced) aws('s3', 'cp', `s3://${BUCKET}/${f.key}`, `s3://${BACKUP}/${prefix}objects/${f.key}`, '--only-show-errors');
  const record = { id, bucket: BUCKET, replaced: replaced.map((f) => f.key), added: changed.filter((f) => !etags.has(f.key)).map((f) => f.key) };
  const recFile = join(mkdtempSync(join(tmpdir(), 'acsite-')), 'deploy.json');
  writeFileSync(recFile, JSON.stringify(record, null, 1));
  aws('s3', 'cp', recFile, `s3://${BACKUP}/${prefix}deploy.json`, '--only-show-errors');
  log(`backed up ${replaced.length} objects to s3://${BACKUP}/${prefix}`);

  // pages last, so a page never points at a script version that is not there yet
  const order = [...changed].sort((a, b) => Number(a.key.endsWith('.html')) - Number(b.key.endsWith('.html')));
  for (const f of order) {
    aws('s3', 'cp', join(DIST, f.key), `s3://${BUCKET}/${f.key}`, '--content-type', f.contentType, '--cache-control', f.cacheControl, '--sse', 'AES256', '--only-show-errors');
  }
  const bad = [];
  for (const f of order) {
    const h = awsJson('s3api', 'head-object', '--bucket', BUCKET, '--key', f.key);
    if (h.ETag.replace(/"/g, '') !== md5(f.key) || h.ContentType !== f.contentType || h.CacheControl !== f.cacheControl) bad.push(f.key);
  }
  if (bad.length) throw new Error(`verification failed for: ${bad.join(', ')} (roll back with --rollback ${id})`);
  log(`deployed ${order.length} files, verified. Roll back with: node scripts/deploy.mjs --rollback ${id}`);
}

function rollback(id) {
  requireCaller();
  const prefix = `site-deploys/${id}/`;
  const record = JSON.parse(aws('s3', 'cp', `s3://${BACKUP}/${prefix}deploy.json`, '-'));
  for (const key of record.replaced) aws('s3', 'cp', `s3://${BACKUP}/${prefix}objects/${key}`, `s3://${BUCKET}/${key}`, '--metadata-directive', 'COPY', '--only-show-errors');
  log(`restored ${record.replaced.length} objects from deploy ${id}.${record.added.length ? ` ${record.added.length} files it added are left in place (unreferenced by the restored pages): ${record.added.join(', ')}` : ''}`);
}

const i = process.argv.indexOf('--rollback');
if (i > -1) rollback(process.argv[i + 1]); else deploy();
