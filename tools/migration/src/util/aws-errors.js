/** Return null for "this optional configuration does not exist" errors, rethrow anything else. */
const ABSENT = new Set([
  'ResourceNotFoundException',
  'NoSuchEntity',
  'NoSuchEntityException',
  'NoSuchBucketPolicy',
  'NoSuchLifecycleConfiguration',
  'NoSuchCORSConfiguration',
  'NoSuchTagSet',
  'NoSuchWebsiteConfiguration',
  'ServerSideEncryptionConfigurationNotFoundError',
  'OwnershipControlsNotFoundError',
  'NoSuchPublicAccessBlockConfiguration',
  'LifecyclePolicyNotFoundException',
  'RepositoryPolicyNotFoundException',
  'NoSuchKey',
  'NotFound',
]);

export async function optional(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err && (ABSENT.has(err.name) || ABSENT.has(err.Code))) return null;
    throw err;
  }
}

export async function collectPages(fetchPage, getItems, getToken) {
  const items = [];
  let token;
  do {
    const page = await fetchPage(token);
    items.push(...(getItems(page) || []));
    token = getToken(page);
  } while (token);
  return items;
}
