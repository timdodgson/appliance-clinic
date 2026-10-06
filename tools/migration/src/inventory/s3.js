import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetBucketWebsiteCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { redactDeep } from '../redact.js';
import { collectPages, optional } from '../util/aws-errors.js';
import { ensureDir } from '../util/files.js';

const strip = (r) => {
  if (!r) return null;
  const { $metadata, ...rest } = r; // eslint-disable-line no-unused-vars
  return rest;
};

/**
 * Pull the WebMCP origin-trial token out of deployed HTML. The token only exists in the
 * deployed index.html, so it has to be captured before anything replaces that file.
 */
export function extractOriginTrialTokens(html) {
  const tokens = [];
  const re = /<meta[^>]+http-equiv=["']origin-trial["'][^>]*>/gi;
  for (const tag of String(html).match(re) || []) {
    const m = tag.match(/content=["']([^"']+)["']/i);
    if (m) tokens.push(m[1]);
  }
  return tokens;
}

export async function inventoryBucket(s3, bucket, { manifest = false, captureObjects = [], captureTo } = {}) {
  const location = await optional(s3.send(new GetBucketLocationCommand({ Bucket: bucket })));
  if (!location) return { bucket, exists: false };
  const policy = await optional(s3.send(new GetBucketPolicyCommand({ Bucket: bucket })));
  const record = {
    bucket,
    exists: true,
    region: location.LocationConstraint || 'us-east-1',
    policy: policy && policy.Policy ? JSON.parse(policy.Policy) : null,
    versioning: strip(await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))),
    lifecycle: strip(await optional(s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })))),
    notifications: strip(await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket }))),
    cors: strip(await optional(s3.send(new GetBucketCorsCommand({ Bucket: bucket })))),
    encryption: strip(await optional(s3.send(new GetBucketEncryptionCommand({ Bucket: bucket })))),
    ownershipControls: strip(await optional(s3.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket })))),
    publicAccessBlock: strip(await optional(s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket })))),
    website: strip(await optional(s3.send(new GetBucketWebsiteCommand({ Bucket: bucket })))),
    logging: strip(await s3.send(new GetBucketLoggingCommand({ Bucket: bucket }))),
    tags: (strip(await optional(s3.send(new GetBucketTaggingCommand({ Bucket: bucket })))) || {}).TagSet || [],
    manifest: null,
    capturedObjects: {},
  };

  if (manifest) {
    const objects = await collectPages(
      (ContinuationToken) => s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken })),
      (p) => p.Contents,
      (p) => (p.IsTruncated ? p.NextContinuationToken : undefined),
    );
    record.manifest = {
      objectCount: objects.length,
      totalBytes: objects.reduce((n, o) => n + (o.Size || 0), 0),
      objects: objects.map((o) => ({ key: o.Key, size: o.Size, etag: o.ETag, lastModified: o.LastModified })),
    };
  }

  for (const key of captureObjects) {
    const obj = await optional(s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
    if (!obj) { record.capturedObjects[key] = null; continue; }
    const body = await obj.Body.transformToString();
    const entry = { contentType: obj.ContentType || null, etag: obj.ETag, bytes: Buffer.byteLength(body) };
    if (key.endsWith('.html')) entry.originTrialTokens = extractOriginTrialTokens(body);
    if (key.endsWith('.json')) {
      try { entry.json = redactDeep(JSON.parse(body)); } catch { entry.json = null; }
    }
    if (captureTo) {
      const dir = ensureDir(join(captureTo, bucket));
      const file = join(dir, key.replace(/[\\/]/g, '__'));
      // JSON objects are stored redacted; HTML is stored as deployed.
      writeFileSync(file, key.endsWith('.json') && entry.json ? JSON.stringify(entry.json, null, 2) : body);
      entry.savedAs = file;
    }
    record.capturedObjects[key] = entry;
  }
  return record;
}
