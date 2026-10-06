import { DescribeRuleCommand, ListTagsForResourceCommand, ListTargetsByRuleCommand } from '@aws-sdk/client-eventbridge';
import { redactDeep } from '../redact.js';
import { collectPages, optional } from '../util/aws-errors.js';

export async function inventoryRule(events, name) {
  const rule = await optional(events.send(new DescribeRuleCommand({ Name: name })));
  if (!rule) return { name, exists: false };
  const targets = await collectPages(
    (NextToken) => events.send(new ListTargetsByRuleCommand({ Rule: name, NextToken })),
    (p) => p.Targets,
    (p) => p.NextToken,
  );
  const tags = await events.send(new ListTagsForResourceCommand({ ResourceARN: rule.Arn }));
  return {
    name,
    exists: true,
    arn: rule.Arn,
    state: rule.State,
    scheduleExpression: rule.ScheduleExpression || null,
    eventPattern: rule.EventPattern ? JSON.parse(rule.EventPattern) : null,
    eventBusName: rule.EventBusName,
    description: rule.Description || null,
    managedBy: rule.ManagedBy || null,
    createdBy: rule.CreatedBy || null,
    tags: tags.Tags || [],
    // Target Ids and Input must be reproduced exactly at import time.
    targets: redactDeep(targets.map((t) => ({ id: t.Id, arn: t.Arn, input: t.Input ?? null, inputPath: t.InputPath ?? null, roleArn: t.RoleArn ?? null }))),
  };
}
