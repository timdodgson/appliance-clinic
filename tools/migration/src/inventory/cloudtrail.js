import { LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { collectPages } from '../util/aws-errors.js';

/**
 * Creation events for ownership evidence. CloudTrail event history only covers 90 days,
 * so an empty result is not evidence either way.
 */
export async function creationEvents(cloudtrail, eventNames, { maxPerEvent = 200 } = {}) {
  const results = [];
  for (const name of eventNames) {
    let fetched = 0;
    const events = await collectPages(
      (NextToken) => cloudtrail.send(new LookupEventsCommand({ LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: name }], NextToken, MaxResults: 50 })),
      (p) => p.Events,
      (p) => { fetched += 50; return fetched < maxPerEvent ? p.NextToken : undefined; },
    );
    for (const e of events) {
      results.push({
        eventName: e.EventName,
        eventTime: e.EventTime,
        username: e.Username || null,
        resources: (e.Resources || []).map((r) => ({ type: r.ResourceType, name: r.ResourceName })),
      });
    }
  }
  return results;
}
