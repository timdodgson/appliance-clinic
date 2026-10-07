import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GetFunctionCommand,
  GetFunctionConcurrencyCommand,
  GetFunctionUrlConfigCommand,
  GetPolicyCommand,
  ListAliasesCommand,
  ListFunctionsCommand,
  ListVersionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import { redactEnvironment } from '../redact.js';
import { collectPages, optional } from '../util/aws-errors.js';
import { ensureDir } from '../util/files.js';

export function lambdaCodeSha256(buffer) {
  return createHash('sha256').update(buffer).digest('base64');
}

/** Every function in the region, reduced to what ownership checks need. */
export async function listAllFunctions(lambda) {
  const fns = await collectPages(
    (Marker) => lambda.send(new ListFunctionsCommand({ Marker })),
    (p) => p.Functions,
    (p) => p.NextMarker,
  );
  return fns.map((f) => ({ name: f.FunctionName, role: f.Role, packageType: f.PackageType, runtime: f.Runtime || null }));
}

/**
 * Function URL configuration holds no secrets (URL, auth type, CORS, invoke mode), and the
 * import must reproduce it exactly, so it is recorded as returned.
 */
export function functionUrlRecord(url) {
  if (!url) return null;
  const { $metadata, ...rest } = url; // eslint-disable-line no-unused-vars
  return rest;
}

function sanitiseConfiguration(cfg) {
  const out = { ...cfg };
  if (out.Environment && out.Environment.Variables) {
    out.Environment = { ...out.Environment, Variables: redactEnvironment(out.Environment.Variables) };
  }
  return out;
}

/**
 * Inventory one function. With downloadCodeTo set, the deployed zip is fetched from the
 * pre-signed URL that GetFunction returns (an HTTP GET) and its CodeSha256 is verified.
 */
export async function inventoryFunction(lambda, name, { downloadCodeTo } = {}) {
  const fn = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
  const cfg = fn.Configuration;
  const url = await optional(lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: name })));
  const policy = await optional(lambda.send(new GetPolicyCommand({ FunctionName: name })));
  const concurrency = await optional(lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: name })));
  const versions = await collectPages(
    (Marker) => lambda.send(new ListVersionsByFunctionCommand({ FunctionName: name, Marker })),
    (p) => p.Versions,
    (p) => p.NextMarker,
  );
  const aliases = await collectPages(
    (Marker) => lambda.send(new ListAliasesCommand({ FunctionName: name, Marker })),
    (p) => p.Aliases,
    (p) => p.NextMarker,
  );

  const record = {
    name,
    configuration: sanitiseConfiguration(cfg),
    code: {
      repositoryType: fn.Code && fn.Code.RepositoryType,
      imageUri: (fn.Code && fn.Code.ImageUri) || null,
      resolvedImageUri: (fn.Code && fn.Code.ResolvedImageUri) || null,
      codeSha256: cfg.CodeSha256,
      downloaded: null,
    },
    functionUrl: functionUrlRecord(url),
    resourcePolicy: policy && policy.Policy ? JSON.parse(policy.Policy) : null,
    reservedConcurrency: concurrency ? concurrency.ReservedConcurrentExecutions ?? null : null,
    versions: versions.map((v) => ({ version: v.Version, codeSha256: v.CodeSha256, lastModified: v.LastModified })),
    aliases: aliases.map((a) => ({ name: a.Name, functionVersion: a.FunctionVersion, routingConfig: a.RoutingConfig || null })),
    tags: fn.Tags || {},
  };

  if (downloadCodeTo && fn.Code && fn.Code.RepositoryType === 'S3' && fn.Code.Location) {
    const res = await fetch(fn.Code.Location);
    if (!res.ok) throw new Error(`Code download for ${name} failed with HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const file = join(ensureDir(downloadCodeTo), `${name}.zip`);
    writeFileSync(file, buffer);
    const computed = lambdaCodeSha256(buffer);
    record.code.downloaded = { file, bytes: buffer.length, codeSha256: computed, matchesDeployed: computed === cfg.CodeSha256 };
  }
  return record;
}

/** Map each execution role to the functions that use it, to detect shared roles. */
export function roleUsage(allFunctions) {
  const usage = {};
  for (const f of allFunctions) {
    const roleName = String(f.role || '').split('/').pop();
    (usage[roleName] ||= []).push(f.name);
  }
  return usage;
}
