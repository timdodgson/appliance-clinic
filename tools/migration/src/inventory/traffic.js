/**
 * Read-only check of whether an HTTP API route is actually used, from CloudWatch metrics.
 *
 * HTTP APIs publish per-route request counts only when detailed metrics are enabled on the stage.
 * When they are not, a route's traffic cannot be separated from the rest of the API's traffic
 * (for the S4R catalogue API, mostly shop search). The check then says so rather than guessing.
 * Enabling detailed metrics would change the S4R API, so it is never done here.
 */
import { GetStageCommand } from '@aws-sdk/client-apigatewayv2';
import { GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { collectPages } from '../util/aws-errors.js';

const DAY = 86400;

/** Find metric dimension sets for this API whose values name the route. */
export function routeDimensionSets(metrics, routeKey) {
  const [, path] = String(routeKey).split(' ');
  return metrics
    .filter((m) => m.MetricName === 'Count')
    .map((m) => m.Dimensions || [])
    .filter((dims) => dims.some((d) => d.Value === routeKey || (path && String(d.Value).includes(path))));
}

export function sumSeries(result) {
  return (result && result.Values ? result.Values : []).reduce((n, v) => n + v, 0);
}

async function dailySum(cloudwatch, { namespace, metricName, dimensions, start, end }) {
  const res = await cloudwatch.send(new GetMetricDataCommand({
    StartTime: start,
    EndTime: end,
    MetricDataQueries: [{ Id: 'm', MetricStat: { Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions }, Period: DAY, Stat: 'Sum' }, ReturnData: true }],
  }));
  const series = (res.MetricDataResults || [])[0] || { Timestamps: [], Values: [] };
  return { total: sumSeries(series), days: (series.Timestamps || []).map((t, i) => ({ day: new Date(t).toISOString().slice(0, 10), count: series.Values[i] })) };
}

/**
 * @returns {Promise<object>} conclusion: 'route-traffic-observed' | 'no-route-traffic' | 'route-metrics-unavailable'
 */
export async function routeTraffic({ cloudwatch, apigatewayv2, apiId, stageName = '$default', routeKey, functionName, days = 30, now = new Date() }) {
  const end = now;
  const start = new Date(now.getTime() - days * DAY * 1000);
  const stage = await apigatewayv2.send(new GetStageCommand({ ApiId: apiId, StageName: stageName }));
  const detailedMetrics = Boolean(stage.DefaultRouteSettings && stage.DefaultRouteSettings.DetailedMetricsEnabled)
    || Boolean(stage.RouteSettings && stage.RouteSettings[routeKey] && stage.RouteSettings[routeKey].DetailedMetricsEnabled);

  const metrics = await collectPages(
    (NextToken) => cloudwatch.send(new ListMetricsCommand({ Namespace: 'AWS/ApiGateway', Dimensions: [{ Name: 'ApiId', Value: apiId }], NextToken })),
    (p) => p.Metrics,
    (p) => p.NextToken,
  );

  const apiTotal = await dailySum(cloudwatch, { namespace: 'AWS/ApiGateway', metricName: 'Count', dimensions: [{ Name: 'ApiId', Value: apiId }], start, end });
  const functionInvocations = functionName
    ? await dailySum(cloudwatch, { namespace: 'AWS/Lambda', metricName: 'Invocations', dimensions: [{ Name: 'FunctionName', Value: functionName }], start, end })
    : null;

  const routeSets = routeDimensionSets(metrics, routeKey);
  let route = null;
  if (routeSets.length) {
    route = { dimensionSets: routeSets.length, total: 0, days: [] };
    for (const dims of routeSets) {
      const r = await dailySum(cloudwatch, { namespace: 'AWS/ApiGateway', metricName: 'Count', dimensions: dims, start, end });
      route.total += r.total;
      route.days.push(...r.days);
    }
  }

  const conclusion = route ? (route.total > 0 ? 'route-traffic-observed' : 'no-route-traffic') : 'route-metrics-unavailable';
  return {
    apiId,
    stage: stageName,
    routeKey,
    periodDays: days,
    detailedMetricsEnabled: detailedMetrics,
    route,
    apiTotal,
    functionInvocations,
    conclusion,
    note: conclusion === 'route-metrics-unavailable'
      ? 'Detailed (per-route) metrics are not enabled on this stage, so route traffic cannot be separated from the API total. Enabling them changes the S4R API and is not done by this tooling.'
      : null,
  };
}
