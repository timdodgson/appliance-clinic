import {
  GetRoleCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import { collectPages, optional } from '../util/aws-errors.js';

function decodePolicy(document) {
  if (!document) return null;
  const text = typeof document === 'string' ? decodeURIComponent(document) : document;
  return typeof text === 'string' ? JSON.parse(text) : text;
}

/** Full IAM snapshot of one role: trust policy, every inline policy document, attached policies. */
export async function inventoryRole(iam, roleName) {
  const res = await optional(iam.send(new GetRoleCommand({ RoleName: roleName })));
  if (!res) return { roleName, exists: false };
  const role = res.Role;
  const inlineNames = await collectPages(
    (Marker) => iam.send(new ListRolePoliciesCommand({ RoleName: roleName, Marker })),
    (p) => p.PolicyNames,
    (p) => (p.IsTruncated ? p.Marker : undefined),
  );
  const inlinePolicies = {};
  for (const policyName of inlineNames.sort()) {
    const p = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
    inlinePolicies[policyName] = decodePolicy(p.PolicyDocument);
  }
  const attached = await collectPages(
    (Marker) => iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker })),
    (p) => p.AttachedPolicies,
    (p) => (p.IsTruncated ? p.Marker : undefined),
  );
  return {
    roleName,
    exists: true,
    arn: role.Arn,
    path: role.Path,
    roleId: role.RoleId,
    createDate: role.CreateDate,
    description: role.Description || null,
    maxSessionDuration: role.MaxSessionDuration,
    permissionsBoundary: role.PermissionsBoundary || null,
    assumeRolePolicyDocument: decodePolicy(role.AssumeRolePolicyDocument),
    tags: role.Tags || [],
    roleLastUsed: role.RoleLastUsed || null,
    inlinePolicies,
    attachedPolicies: attached.map((a) => a.PolicyArn).sort(),
  };
}
