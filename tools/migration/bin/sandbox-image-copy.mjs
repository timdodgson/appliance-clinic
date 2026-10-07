#!/usr/bin/env node
/**
 * Phase 4 (#34): copy a deployed Lambda image into its -sbx ECR repository, byte for byte, so the sandbox function
 * runs the same image digest as production. No Docker is needed.
 *
 *   node bin/sandbox-image-copy.mjs pull --repo <production repository> --digest sha256:… --out <dir>
 *        READ-ONLY, as the IAM user: BatchGetImage and GetDownloadUrlForLayer through the read-only client.
 *        Every blob and the manifest are verified against their digests.
 *   node bin/sandbox-image-copy.mjs push --dir <dir> --repo <name>-sbx [--tag v1]
 *        As ac-operator-sbx: the caller and the target repository pass the sandbox guard first. Only the five ECR
 *        upload commands are allowed. The pushed manifest's digest must equal the pulled one.
 *
 * Run with NODE_USE_ENV_PROXY=1 behind an HTTPS proxy (layer downloads use pre-signed S3 URLs).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BatchCheckLayerAvailabilityCommand, BatchGetImageCommand, CompleteLayerUploadCommand, ECRClient, GetDownloadUrlForLayerCommand,
  InitiateLayerUploadCommand, PutImageCommand, UploadLayerPartCommand,
} from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { guardAllowlist } from '../src/aws/allowlisted-client.js';
import { guardReadOnly } from '../src/aws/readonly-client.js';
import { checkCaller, checkTarget, loadSandboxLists, SANDBOX_REGION } from '../src/sandbox/guard.js';
import { parseArgs, requireFlag } from '../src/util/args.js';

const { positional, flags } = parseArgs(process.argv.slice(2));
const region = SANDBOX_REGION;
const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;
const MEDIA_TYPES = [
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
];
const isIndex = (mt) => /index|manifest\.list/.test(mt);

async function pull() {
  const repo = String(requireFlag(flags, 'repo'));
  const out = String(requireFlag(flags, 'out'));
  const ecr = guardReadOnly(new ECRClient({ region }));
  mkdirSync(join(out, 'blobs'), { recursive: true });
  const manifests = [];
  const fetchManifest = async (digest) => {
    const r = await ecr.send(new BatchGetImageCommand({ repositoryName: repo, imageIds: [{ imageDigest: digest }], acceptedMediaTypes: MEDIA_TYPES }));
    const img = r.images?.[0];
    if (!img) throw new Error(`no image ${digest} in ${repo}: ${JSON.stringify(r.failures)}`);
    const body = Buffer.from(img.imageManifest, 'utf8');
    if (sha256(body) !== digest) throw new Error(`manifest digest mismatch for ${digest}`);
    const mediaType = img.imageManifestMediaType || JSON.parse(img.imageManifest).mediaType;
    writeFileSync(join(out, `${digest.replace(':', '-')}.manifest.json`), body);
    manifests.push({ digest, mediaType });
    const m = JSON.parse(img.imageManifest);
    if (isIndex(mediaType)) { for (const child of m.manifests) await fetchManifest(child.digest); return; }
    for (const blob of [m.config, ...m.layers]) {
      const path = join(out, 'blobs', blob.digest.replace(':', '-'));
      if (existsSync(path) && sha256(readFileSync(path)) === blob.digest) continue;
      const { downloadUrl } = await ecr.send(new GetDownloadUrlForLayerCommand({ repositoryName: repo, layerDigest: blob.digest }));
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`download of ${blob.digest} failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== blob.digest) throw new Error(`blob digest mismatch for ${blob.digest}`);
      writeFileSync(path, buf);
    }
  };
  const top = String(requireFlag(flags, 'digest'));
  await fetchManifest(top);
  writeFileSync(join(out, 'image.json'), JSON.stringify({ sourceRepository: repo, digest: top, manifests }, null, 2));
  console.log(JSON.stringify({ pulled: top, manifests: manifests.length }));
}

async function push() {
  const dir = String(requireFlag(flags, 'dir'));
  const repo = String(requireFlag(flags, 'repo'));
  const tag = flags.tag ? String(flags.tag) : 'v1';
  const id = await guardReadOnly(new STSClient({ region })).send(new GetCallerIdentityCommand({}));
  const lists = loadSandboxLists();
  const failures = [...checkCaller({ account: id.Account, region: process.env.AWS_REGION || region, arn: id.Arn }), ...checkTarget(lists, { type: 'AWS::ECR::Repository', id: repo })];
  if (failures.length) { console.error(JSON.stringify(failures)); console.error('STOP: not a sandbox caller or target.'); process.exit(1); }
  const ecr = guardAllowlist(new ECRClient({ region }), ['BatchCheckLayerAvailabilityCommand', 'InitiateLayerUploadCommand', 'UploadLayerPartCommand', 'CompleteLayerUploadCommand', 'PutImageCommand']);
  const image = JSON.parse(readFileSync(join(dir, 'image.json'), 'utf8'));
  // Children first (an index refers to them), the top-level manifest last.
  for (const m of [...image.manifests].reverse()) {
    const body = readFileSync(join(dir, `${m.digest.replace(':', '-')}.manifest.json`));
    if (!isIndex(m.mediaType)) {
      const parsed = JSON.parse(body.toString('utf8'));
      for (const blob of [parsed.config, ...parsed.layers]) {
        const have = await ecr.send(new BatchCheckLayerAvailabilityCommand({ repositoryName: repo, layerDigests: [blob.digest] }));
        if (have.layers?.[0]?.layerAvailability === 'AVAILABLE') continue;
        const data = readFileSync(join(dir, 'blobs', blob.digest.replace(':', '-')));
        const { uploadId, partSize } = await ecr.send(new InitiateLayerUploadCommand({ repositoryName: repo }));
        const size = Number(partSize) || 10 * 1024 * 1024;
        for (let first = 0; first < data.length; first += size) {
          const last = Math.min(first + size, data.length) - 1;
          await ecr.send(new UploadLayerPartCommand({ repositoryName: repo, uploadId, partFirstByte: first, partLastByte: last, layerPartBlob: data.subarray(first, last + 1) }));
        }
        await ecr.send(new CompleteLayerUploadCommand({ repositoryName: repo, uploadId, layerDigests: [blob.digest] }));
      }
    }
    const top = m.digest === image.digest;
    const r = await ecr.send(new PutImageCommand({
      repositoryName: repo, imageManifest: body.toString('utf8'), imageManifestMediaType: m.mediaType, imageDigest: m.digest, ...(top ? { imageTag: tag } : {}),
    }));
    if (r.image.imageId.imageDigest !== m.digest) throw new Error(`pushed digest ${r.image.imageId.imageDigest} differs from ${m.digest}`);
  }
  console.log(JSON.stringify({ pushed: image.digest, repository: repo, tag }));
}

const run = { pull, push }[positional[0]];
if (!run) { console.error('Usage: sandbox-image-copy.mjs pull|push ... (see the header of this file)'); process.exit(2); }
await run();
