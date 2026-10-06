/**
 * Build the S4R denylist from a Phase 0 inventory.
 *
 * Rule: every resource of every existing CloudFormation stack is S4R, except Appliance Clinic's
 * own stacks. All AC resources are unmanaged before Phase 5, so "already in a stack" means
 * "not ours". Secrets under the shared prefix that are not AC candidates are S4R too.
 */
export const AC_STACK_NAMES = ['ApplianceClinicToolkit', 'AcDataStack', 'AcRuntimeStack', 'AcAuthStack', 'AcWebStack'];

function entryKey(e) {
  return `${e.kind}|${e.value}|${e.region || ''}`;
}

export function generateDenylist({ meta, stacks, sharedPrefixSecrets, acSecretPrefixes, knownEntries, acStackNames = AC_STACK_NAMES, now = new Date() }) {
  const entries = [];
  for (const e of knownEntries) entries.push({ ...e });

  for (const s of stacks) {
    if (acStackNames.includes(s.stackName)) continue;
    entries.push({ kind: 'stack', value: s.stackName, region: s.region, reason: 'Existing CloudFormation stack not owned by Appliance Clinic.', source: `cloudformation:${s.stackName}` });
    for (const r of s.resources) {
      if (!r.physicalId) continue;
      entries.push({ kind: 'physicalId', value: r.physicalId, resourceType: r.type, region: s.region, reason: `Resource ${r.logicalId} of stack ${s.stackName}.`, source: `cloudformation:${s.stackName}` });
    }
  }

  for (const sec of sharedPrefixSecrets) {
    if (acSecretPrefixes.some((p) => sec.name.startsWith(p))) continue;
    entries.push({ kind: 'arn', value: sec.arn, resourceType: 'AWS::SecretsManager::Secret', reason: `Secret ${sec.name} is under the shared prefix and is not an Appliance Clinic candidate.`, source: 'secrets:shared-prefix' });
  }

  const seen = new Set();
  const unique = entries.filter((e) => (seen.has(entryKey(e)) ? false : seen.add(entryKey(e))));
  unique.sort((a, b) => entryKey(a).localeCompare(entryKey(b)));

  return {
    $schema: '../../tools/migration/schema/s4r-denylist.schema.json',
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    generatedBy: 'tools/migration/bin/denylist.mjs',
    accountId: meta.accountId,
    regions: [...new Set(stacks.map((s) => s.region))].sort(),
    notes: 'Generated from a READ-ONLY Phase 0 inventory. Regenerate before every production step.',
    entries: unique,
  };
}
