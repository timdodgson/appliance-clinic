#!/usr/bin/env node
/**
 * READ-ONLY: is an HTTP API route actually used? Reads API Gateway stage settings and CloudWatch
 * metrics through the read-only guard. Changes nothing.
 *
 *   node bin/traffic.mjs [--api 65vnizdmk4] [--route "POST /ai/chat"] [--stage '$default']
 *                        [--function spares4repairs-part-finder] [--days 30] [--expect-account <id>] [--out <file>]
 */
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { guardReadOnly } from '../src/aws/readonly-client.js';
import { loadResourceConfig } from '../src/config.js';
import { routeTraffic } from '../src/inventory/traffic.js';
import { parseArgs } from '../src/util/args.js';
import { writeJson } from '../src/util/files.js';

const { flags } = parseArgs(process.argv.slice(2));
const { region } = loadResourceConfig();
const account = (await guardReadOnly(new STSClient({ region })).send(new GetCallerIdentityCommand({}))).Account;
if (flags['expect-account'] && String(flags['expect-account']) !== account) {
  console.error(`Refusing to run: credentials are for account ${account}, expected ${flags['expect-account']}.`);
  process.exit(2);
}
const result = await routeTraffic({
  cloudwatch: guardReadOnly(new CloudWatchClient({ region })),
  apigatewayv2: guardReadOnly(new ApiGatewayV2Client({ region })),
  apiId: String(flags.api || '65vnizdmk4'),
  stageName: String(flags.stage || '$default'),
  routeKey: String(flags.route || 'POST /ai/chat'),
  functionName: String(flags.function || 'spares4repairs-part-finder'),
  days: Number(flags.days || 30),
});
if (flags.out) writeJson(String(flags.out), { capturedAt: new Date().toISOString(), accountId: account, ...result });
console.log(JSON.stringify(result, null, 2));
