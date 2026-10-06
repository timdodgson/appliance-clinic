import {
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  GetLifecyclePolicyCommand,
  GetRepositoryPolicyCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-ecr';
import { collectPages, optional } from '../util/aws-errors.js';

export async function inventoryRepository(ecr, repositoryName) {
  const res = await optional(ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] })));
  const repo = res && res.repositories && res.repositories[0];
  if (!repo) return { repositoryName, exists: false };
  const images = await collectPages(
    (nextToken) => ecr.send(new DescribeImagesCommand({ repositoryName, nextToken })),
    (p) => p.imageDetails,
    (p) => p.nextToken,
  );
  const lifecycle = await optional(ecr.send(new GetLifecyclePolicyCommand({ repositoryName })));
  const policy = await optional(ecr.send(new GetRepositoryPolicyCommand({ repositoryName })));
  const tags = await ecr.send(new ListTagsForResourceCommand({ resourceArn: repo.repositoryArn }));
  return {
    repositoryName,
    exists: true,
    arn: repo.repositoryArn,
    uri: repo.repositoryUri,
    createdAt: repo.createdAt,
    imageTagMutability: repo.imageTagMutability,
    imageScanningConfiguration: repo.imageScanningConfiguration,
    encryptionConfiguration: repo.encryptionConfiguration,
    lifecyclePolicy: lifecycle && lifecycle.lifecyclePolicyText ? JSON.parse(lifecycle.lifecyclePolicyText) : null,
    repositoryPolicy: policy && policy.policyText ? JSON.parse(policy.policyText) : null,
    tags: tags.tags || [],
    images: images
      .map((i) => ({ digest: i.imageDigest, tags: i.imageTags || [], pushedAt: i.imagePushedAt, sizeBytes: i.imageSizeInBytes }))
      .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt))),
  };
}

/** Digest a Lambda image URI resolves to, e.g. "repo@sha256:..." -> "sha256:...". */
export function digestFromImageUri(uri) {
  const m = String(uri || '').match(/@(sha256:[0-9a-f]{64})$/);
  return m ? m[1] : null;
}
