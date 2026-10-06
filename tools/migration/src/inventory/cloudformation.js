import { ListStackResourcesCommand, ListStacksCommand } from '@aws-sdk/client-cloudformation';
import { collectPages } from '../util/aws-errors.js';

const LIVE_STATUSES = [
  'CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_FAILED', 'ROLLBACK_COMPLETE',
  'DELETE_IN_PROGRESS', 'DELETE_FAILED', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
  'UPDATE_COMPLETE', 'UPDATE_FAILED', 'UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED',
  'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE', 'REVIEW_IN_PROGRESS',
  'IMPORT_IN_PROGRESS', 'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_IN_PROGRESS', 'IMPORT_ROLLBACK_FAILED',
  'IMPORT_ROLLBACK_COMPLETE',
];

/** Every non-deleted stack in a region, with every resource it manages. */
export async function inventoryStacks(cloudformation, region) {
  const stacks = await collectPages(
    (NextToken) => cloudformation.send(new ListStacksCommand({ StackStatusFilter: LIVE_STATUSES, NextToken })),
    (p) => p.StackSummaries,
    (p) => p.NextToken,
  );
  const out = [];
  for (const s of stacks) {
    const resources = await collectPages(
      (NextToken) => cloudformation.send(new ListStackResourcesCommand({ StackName: s.StackId, NextToken })),
      (p) => p.StackResourceSummaries,
      (p) => p.NextToken,
    );
    out.push({
      region,
      stackName: s.StackName,
      stackId: s.StackId,
      status: s.StackStatus,
      parentId: s.ParentId || null,
      rootId: s.RootId || null,
      resources: resources.map((r) => ({ logicalId: r.LogicalResourceId, physicalId: r.PhysicalResourceId || null, type: r.ResourceType, status: r.ResourceStatus })),
    });
  }
  return out;
}

/** Stacks that manage a resource with this physical ID or name. */
export function stacksManaging(stacks, physicalId) {
  return stacks
    .filter((s) => s.resources.some((r) => r.physicalId === physicalId || (r.physicalId && r.physicalId.endsWith(`/${physicalId}`)) || (r.physicalId && r.physicalId.endsWith(`:${physicalId}`))))
    .map((s) => `${s.region}:${s.stackName}`);
}
