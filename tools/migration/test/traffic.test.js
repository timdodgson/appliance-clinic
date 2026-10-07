import { describe, expect, it } from 'vitest';
import { routeDimensionSets, routeTraffic } from '../src/inventory/traffic.js';

const fakeClient = (handlers) => ({
  send: async (command) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw Object.assign(new Error(`unexpected ${command.constructor.name}`), { name: 'Unexpected' });
    return handler(command.input);
  },
});

describe('route traffic check', () => {
  const now = new Date('2026-10-07T00:00:00Z');
  const cloudwatch = (metrics, valuesFor) => fakeClient({
    ListMetricsCommand: () => ({ Metrics: metrics }),
    GetMetricDataCommand: (input) => {
      const q = input.MetricDataQueries[0].MetricStat.Metric;
      return { MetricDataResults: [{ Timestamps: ['2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'], Values: valuesFor(q) }] };
    },
  });
  const stage = (detailed) => fakeClient({ GetStageCommand: () => ({ DefaultRouteSettings: { DetailedMetricsEnabled: detailed } }) });

  it('finds route dimension sets by route key or path', () => {
    const metrics = [
      { MetricName: 'Count', Dimensions: [{ Name: 'ApiId', Value: 'a' }] },
      { MetricName: 'Count', Dimensions: [{ Name: 'ApiId', Value: 'a' }, { Name: 'Stage', Value: '$default' }, { Name: 'Route', Value: 'POST /ai/chat' }] },
      { MetricName: 'Latency', Dimensions: [{ Name: 'Route', Value: 'POST /ai/chat' }] },
    ];
    expect(routeDimensionSets(metrics, 'POST /ai/chat')).toHaveLength(1);
  });

  it('says route metrics are unavailable when detailed metrics are off, and still reports totals', async () => {
    const r = await routeTraffic({ cloudwatch: cloudwatch([{ MetricName: 'Count', Dimensions: [{ Name: 'ApiId', Value: '65vnizdmk4' }] }], () => [10, 5]), apigatewayv2: stage(false), apiId: '65vnizdmk4', routeKey: 'POST /ai/chat', functionName: 'spares4repairs-part-finder', now });
    expect(r.conclusion).toBe('route-metrics-unavailable');
    expect(r.detailedMetricsEnabled).toBe(false);
    expect(r.apiTotal.total).toBe(15);
    expect(r.functionInvocations.total).toBe(15);
    expect(r.note).toMatch(/not done by this tooling/);
  });

  it('reports observed traffic or none when route metrics exist', async () => {
    const routeMetric = [{ MetricName: 'Count', Dimensions: [{ Name: 'ApiId', Value: '65vnizdmk4' }, { Name: 'Stage', Value: '$default' }, { Name: 'Route', Value: 'POST /ai/chat' }] }];
    const busy = await routeTraffic({ cloudwatch: cloudwatch(routeMetric, () => [3, 4]), apigatewayv2: stage(true), apiId: '65vnizdmk4', routeKey: 'POST /ai/chat', now });
    expect(busy).toMatchObject({ conclusion: 'route-traffic-observed', detailedMetricsEnabled: true });
    expect(busy.route.total).toBe(7);
    const idle = await routeTraffic({ cloudwatch: cloudwatch(routeMetric, (q) => (q.Dimensions.length > 1 ? [0, 0] : [9, 9])), apigatewayv2: stage(true), apiId: '65vnizdmk4', routeKey: 'POST /ai/chat', now });
    expect(idle.conclusion).toBe('no-route-traffic');
  });
});
