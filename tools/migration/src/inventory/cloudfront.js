import {
  DescribeFunctionCommand,
  GetCachePolicyCommand,
  GetDistributionConfigCommand,
  GetFunctionCommand,
  GetOriginAccessControlCommand,
  GetOriginRequestPolicyCommand,
  GetResponseHeadersPolicyCommand,
  ListDistributionsCommand,
} from '@aws-sdk/client-cloudfront';
import { collectPages, optional } from '../util/aws-errors.js';

export async function listDistributions(cloudfront) {
  return collectPages(
    (Marker) => cloudfront.send(new ListDistributionsCommand({ Marker })),
    (p) => (p.DistributionList && p.DistributionList.Items) || [],
    (p) => (p.DistributionList && p.DistributionList.IsTruncated ? p.DistributionList.NextMarker : undefined),
  );
}

function functionArnsOf(config) {
  const behaviours = [config.DefaultCacheBehavior, ...((config.CacheBehaviors && config.CacheBehaviors.Items) || [])];
  const arns = new Set();
  for (const b of behaviours) {
    for (const a of (b.FunctionAssociations && b.FunctionAssociations.Items) || []) arns.add(a.FunctionARN);
  }
  return [...arns];
}

/** Every distribution that uses any of the named CloudFront functions (shared-use detection). */
export function distributionsUsingFunctions(distributions, functionNames) {
  const hits = [];
  for (const d of distributions) {
    const behaviours = [d.DefaultCacheBehavior, ...((d.CacheBehaviors && d.CacheBehaviors.Items) || [])];
    for (const b of behaviours) {
      for (const a of (b.FunctionAssociations && b.FunctionAssociations.Items) || []) {
        const name = String(a.FunctionARN).split('/').pop();
        if (functionNames.includes(name)) hits.push({ distributionId: d.Id, aliases: (d.Aliases && d.Aliases.Items) || [], functionName: name });
      }
    }
  }
  return hits;
}

export async function inventoryDistribution(cloudfront, distributionId) {
  const res = await cloudfront.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const config = res.DistributionConfig;
  const behaviours = [config.DefaultCacheBehavior, ...((config.CacheBehaviors && config.CacheBehaviors.Items) || [])];
  const ids = (key) => [...new Set(behaviours.map((b) => b[key]).filter(Boolean))];
  const related = { originAccessControls: {}, cachePolicies: {}, originRequestPolicies: {}, responseHeadersPolicies: {} };
  for (const o of (config.Origins && config.Origins.Items) || []) {
    if (o.OriginAccessControlId) {
      const oac = await optional(cloudfront.send(new GetOriginAccessControlCommand({ Id: o.OriginAccessControlId })));
      related.originAccessControls[o.OriginAccessControlId] = oac ? oac.OriginAccessControl : null;
    }
  }
  for (const id of ids('CachePolicyId')) {
    const p = await optional(cloudfront.send(new GetCachePolicyCommand({ Id: id })));
    related.cachePolicies[id] = p ? p.CachePolicy : null;
  }
  for (const id of ids('OriginRequestPolicyId')) {
    const p = await optional(cloudfront.send(new GetOriginRequestPolicyCommand({ Id: id })));
    related.originRequestPolicies[id] = p ? p.OriginRequestPolicy : null;
  }
  for (const id of ids('ResponseHeadersPolicyId')) {
    const p = await optional(cloudfront.send(new GetResponseHeadersPolicyCommand({ Id: id })));
    related.responseHeadersPolicies[id] = p ? p.ResponseHeadersPolicy : null;
  }
  return { distributionId, etag: res.ETag, config, functionArns: functionArnsOf(config), related };
}

export async function inventoryCloudFrontFunction(cloudfront, name) {
  const live = await optional(cloudfront.send(new DescribeFunctionCommand({ Name: name, Stage: 'LIVE' })));
  if (!live) return { name, exists: false };
  const dev = await optional(cloudfront.send(new DescribeFunctionCommand({ Name: name, Stage: 'DEVELOPMENT' })));
  const code = await cloudfront.send(new GetFunctionCommand({ Name: name, Stage: 'LIVE' }));
  const liveCode = Buffer.from(code.FunctionCode).toString('utf8');
  const devCode = dev ? Buffer.from((await cloudfront.send(new GetFunctionCommand({ Name: name, Stage: 'DEVELOPMENT' }))).FunctionCode).toString('utf8') : null;
  return {
    name,
    exists: true,
    arn: live.FunctionSummary.FunctionMetadata.FunctionARN,
    config: live.FunctionSummary.FunctionConfig,
    liveCode,
    developmentMatchesLive: devCode === null ? null : devCode === liveCode,
  };
}
