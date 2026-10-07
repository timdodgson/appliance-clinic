import { LookupEventsCommand } from '@aws-sdk/client-cloudtrail';

/**
 * Creation events for ownership evidence, from CloudTrail event history.
 *
 * Event history covers 90 days only, so an empty result is not evidence either way. Global
 * services record their events in us-east-1 (IAM, CloudFront), so every configured region is
 * searched. Each event name is read up to `maxPerEvent` events per region; `truncated` says when
 * that limit was reached, so a capped result is never mistaken for a complete one.
 */
export async function creationEvents(cloudtrailByRegion, eventNames, { maxPerEvent = 1000 } = {}) {
  const events = [];
  const coverage = [];
  for (const [region, cloudtrail] of Object.entries(cloudtrailByRegion)) {
    for (const name of eventNames) {
      let token;
      let fetched = 0;
      do {
        const page = await cloudtrail.send(new LookupEventsCommand({ LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: name }], NextToken: token, MaxResults: 50 }));
        for (const e of page.Events || []) {
          fetched += 1;
          events.push({
            region,
            eventName: e.EventName,
            eventTime: e.EventTime,
            username: e.Username || null,
            resources: (e.Resources || []).map((r) => ({ type: r.ResourceType, name: r.ResourceName })),
          });
        }
        token = page.NextToken;
      } while (token && fetched < maxPerEvent);
      coverage.push({ region, eventName: name, events: fetched, truncated: Boolean(token) });
    }
  }
  return { events, coverage };
}
